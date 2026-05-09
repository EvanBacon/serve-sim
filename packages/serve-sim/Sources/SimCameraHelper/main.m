// SimCameraHelper — host-side source manager for serve-sim's simulator
// camera feed. Owns a POSIX shared-memory region the injected dylib mmaps,
// and writes BGRA frames into it from one of several swappable sources:
//
//   - placeholder : programmatically rendered moving frames (default)
//   - webcam      : live AVCaptureDevice (front Mac camera, Continuity, …)
//   - image       : a single PNG/JPEG, written once
//
// A UNIX-domain control socket lets the CLI (and the in-page Camera tool)
// switch sources at runtime without relaunching the simulator app — the
// dylib just keeps reading whatever frames the helper writes.
//
// Command line:
//   serve-sim-camera-helper --shm <name> [--socket <path>]
//                           [--source placeholder|webcam|image]
//                           [--arg <value>]   # webcam name / image path
//                           [--width 1280] [--height 720]
//   serve-sim-camera-helper --list
//
// Control protocol (line-delimited JSON over AF_UNIX, each line one command):
//   {"action":"switch","source":"webcam","arg":"MacBook Pro Camera"}
//   {"action":"switch","source":"placeholder"}
//   {"action":"status"}            -> server replies one JSON line
//   {"action":"shutdown"}

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreImage/CoreImage.h>
#import <Accelerate/Accelerate.h>
#import <ImageIO/ImageIO.h>

#include <fcntl.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdatomic.h>
#include <mach/mach_time.h>
#include "../SimCameraInjector/include/SimCamShared.h"

#pragma mark - Globals (shm + writer)

static SimCamShmHeader *gHeader = NULL;
static uint8_t *gPixels = NULL;
static uint32_t gWidth = SIMCAM_DEFAULT_WIDTH;
static uint32_t gHeight = SIMCAM_DEFAULT_HEIGHT;
static const char *gShmName = NULL;
static volatile sig_atomic_t gShouldExit = 0;
static atomic_uint_fast64_t gFrameSeq = 0;

static uint64_t MachAbsToNs(uint64_t t) {
    static mach_timebase_info_data_t tb = {0,0};
    if (tb.denom == 0) mach_timebase_info(&tb);
    return t * tb.numer / tb.denom;
}

static void HandleSig(int sig) { (void)sig; gShouldExit = 1; }

// Forward decls — definitions live near OpenShm so the control-socket
// handler (which sits earlier in this file post-refactor) can call them.
static uint8_t ParseMirrorCode(NSString *mode);
static NSString *MirrorName(uint8_t code);

// Publish a fully-prepared BGRA frame (gWidth x gHeight, packed at gWidth*4
// bytes per row) to the shm region. Writers MUST go through this so seq/ts
// stay coherent for the dylib's tear-detection check.
static void PublishFrame(const uint8_t *bgra) {
    if (!gHeader || !gPixels || !bgra) return;
    memcpy(gPixels, bgra, (size_t)gWidth * gHeight * 4);
    gHeader->timestampNs = MachAbsToNs(mach_absolute_time());
    atomic_thread_fence(memory_order_release);
    uint64_t next = atomic_fetch_add(&gFrameSeq, 1) + 1;
    gHeader->frameSeq = next;
}

#pragma mark - Source pipeline (start / stop / switch)

typedef NS_ENUM(NSInteger, SimCamSourceKind) {
    SimCamSourceNone = 0,
    SimCamSourcePlaceholder,
    SimCamSourceWebcam,
    SimCamSourceImage,
    SimCamSourceVideo,
};

static SimCamSourceKind gActiveSource = SimCamSourceNone;
static dispatch_queue_t gSourceQueue;        // serial — owns source lifecycle
static dispatch_source_t gPlaceholderTimer;
static AVCaptureSession *gWebcamSession;
static SimCamSourceKind gPendingSource;     // for status reporting
static NSString *gActiveArg = nil;          // selected camera name, image path

@interface SimCamWebcamWriter : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation SimCamWebcamWriter
- (void)captureOutput:(AVCaptureOutput *)out
didOutputSampleBuffer:(CMSampleBufferRef)sb
       fromConnection:(AVCaptureConnection *)conn {
    CVImageBufferRef pb = CMSampleBufferGetImageBuffer(sb);
    if (!pb || !gHeader) return;
    if (CVPixelBufferGetPixelFormatType(pb) != kCVPixelFormatType_32BGRA) return;
    CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    size_t srcW = CVPixelBufferGetWidth(pb);
    size_t srcH = CVPixelBufferGetHeight(pb);
    size_t srcStride = CVPixelBufferGetBytesPerRow(pb);
    void *src = CVPixelBufferGetBaseAddress(pb);
    static uint8_t *scratch = NULL;
    static size_t scratchSize = 0;
    size_t need = (size_t)gWidth * gHeight * 4;
    if (scratchSize < need) {
        free(scratch);
        scratch = malloc(need);
        scratchSize = need;
    }
    vImage_Buffer s = { src, srcH, srcW, srcStride };
    vImage_Buffer d = { scratch, gHeight, gWidth, (size_t)gWidth * 4 };
    vImage_Error verr = vImageScale_ARGB8888(&s, &d, NULL, kvImageHighQualityResampling);
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    if (verr == kvImageNoError) PublishFrame(scratch);
}
@end

static SimCamWebcamWriter *gWebcamWriter = nil;

#pragma mark Placeholder source — Remotion-style "blueprint" grid

// Visual parity with apps/editor/src/backgrounds/BlueprintBackground.tsx in
// the device-frames repo: a fixed #019EFF→#0168D4 vertical gradient, a major
// grid every 120px with minor subdivisions every 24px, and tiny animated
// cross markers at major intersections that rotate + scale-pulse. All of the
// static layers (gradient + grid) are rasterized once into a CGImage and
// blitted each frame; only the crosses are redrawn live.

#define BP_GRID_MAJOR        120.0
#define BP_GRID_MINOR_DIV    5
#define BP_CROSS_SIZE        7.0
#define BP_CROSS_STROKE      4.0

static CGImageRef gBPBackground = NULL;   // cached gradient + grid
static uint32_t   gBPCachedW = 0;
static uint32_t   gBPCachedH = 0;

// Match the JS seededRandom in BlueprintBackground.tsx so cross timings line
// up with the Remotion reference. (The original is `sin(seed*438.8) * K`
// since 127.1+311.7 = 438.8 and both factors multiply the same `seed`.)
static inline double BPSeededRandom(double seed) {
    double x = sin(seed * 438.8) * 43758.5453;
    return x - floor(x);
}

static CGImageRef BuildBlueprintBackground(uint32_t w, uint32_t h) {
    size_t bpr = (size_t)w * 4;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    if (!ctx) { CGColorSpaceRelease(cs); return NULL; }

    // Vertical gradient #019EFF → #0168D4.
    CGFloat colors[8] = {
        0x01/255.0, 0x9E/255.0, 0xFF/255.0, 1.0,
        0x01/255.0, 0x68/255.0, 0xD4/255.0, 1.0,
    };
    CGGradientRef grad = CGGradientCreateWithColorComponents(cs, colors,
        (CGFloat[]){0, 1}, 2);
    CGContextDrawLinearGradient(ctx, grad,
        CGPointMake(w/2.0, h), CGPointMake(w/2.0, 0), 0);
    CGGradientRelease(grad);

    double minor = BP_GRID_MAJOR / (double)BP_GRID_MINOR_DIV;

    // Minor grid: stroke 0.5, white α=0.08.
    CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.08);
    CGContextSetLineWidth(ctx, 0.5);
    CGContextBeginPath(ctx);
    for (double y = 0; y <= h + minor; y += minor) {
        if (fmod(y, BP_GRID_MAJOR) == 0) continue;
        CGContextMoveToPoint(ctx, 0, y);
        CGContextAddLineToPoint(ctx, w, y);
    }
    for (double x = 0; x <= w + minor; x += minor) {
        if (fmod(x, BP_GRID_MAJOR) == 0) continue;
        CGContextMoveToPoint(ctx, x, 0);
        CGContextAddLineToPoint(ctx, x, h);
    }
    CGContextStrokePath(ctx);

    // Major grid: stroke 1.5, white α=0.15.
    CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.15);
    CGContextSetLineWidth(ctx, 1.5);
    CGContextBeginPath(ctx);
    for (double y = 0; y <= h + BP_GRID_MAJOR; y += BP_GRID_MAJOR) {
        CGContextMoveToPoint(ctx, 0, y);
        CGContextAddLineToPoint(ctx, w, y);
    }
    for (double x = 0; x <= w + BP_GRID_MAJOR; x += BP_GRID_MAJOR) {
        CGContextMoveToPoint(ctx, x, 0);
        CGContextAddLineToPoint(ctx, x, h);
    }
    CGContextStrokePath(ctx);

    CGImageRef img = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    CGColorSpaceRelease(cs);
    return img;
}

static void RenderPlaceholderFrame(uint8_t *out, uint64_t frameIdx) {
    size_t bpr = (size_t)gWidth * 4;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(out, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    if (!ctx) return;

    // Cached static background (gradient + grid). Rebuild on dimension change.
    if (!gBPBackground || gBPCachedW != gWidth || gBPCachedH != gHeight) {
        if (gBPBackground) CGImageRelease(gBPBackground);
        gBPBackground = BuildBlueprintBackground(gWidth, gHeight);
        gBPCachedW = gWidth;
        gBPCachedH = gHeight;
    }
    if (gBPBackground) {
        CGContextDrawImage(ctx, CGRectMake(0, 0, gWidth, gHeight), gBPBackground);
    }

    // Cross markers at every interior major intersection. Loops every 30s.
    double t = fmod((double)frameIdx / 30.0, 30.0);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetLineWidth(ctx, BP_CROSS_STROKE);

    int seed = 0;
    for (double cy = BP_GRID_MAJOR; cy < gHeight; cy += BP_GRID_MAJOR) {
        for (double cx = BP_GRID_MAJOR; cx < gWidth; cx += BP_GRID_MAJOR) {
            double offset      = BPSeededRandom(seed)     * M_PI * 2.0;
            double speed       = 0.15 + BPSeededRandom(seed + 1) * 0.20;
            double scaleSpeed  = 0.07 + BPSeededRandom(seed + 2) * 0.12;
            double scalePhase  = t * scaleSpeed + BPSeededRandom(seed + 3) * M_PI * 2.0;
            seed++;

            double raw = sin(scalePhase * M_PI * 2.0);
            double scale = raw > 0 ? raw : 0;        // half the cycle hidden
            if (scale <= 0.001) continue;             // skip invisible draws

            double rotation = (t * speed + offset) * M_PI * 2.0;
            double s = BP_CROSS_SIZE * scale;
            double opacity = 0.3 + 0.5 * scale;

            CGContextSaveGState(ctx);
            CGContextTranslateCTM(ctx, cx, cy);
            CGContextRotateCTM(ctx, rotation);
            CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.7 * opacity);
            CGContextBeginPath(ctx);
            CGContextMoveToPoint(ctx, -s, 0);
            CGContextAddLineToPoint(ctx, s, 0);
            CGContextMoveToPoint(ctx, 0, -s);
            CGContextAddLineToPoint(ctx, 0, s);
            CGContextStrokePath(ctx);
            CGContextRestoreGState(ctx);
        }
    }

    CGContextRelease(ctx);
}

static void StartPlaceholderSource(void) {
    gPlaceholderTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    uint64_t intervalNs = NSEC_PER_SEC / 30;
    dispatch_source_set_timer(gPlaceholderTimer,
        dispatch_time(DISPATCH_TIME_NOW, 0), intervalNs, intervalNs / 10);
    static uint8_t *buf = NULL;
    size_t need = (size_t)gWidth * gHeight * 4;
    if (!buf) buf = malloc(need);
    __block uint64_t frameIdx = 0;
    dispatch_source_set_event_handler(gPlaceholderTimer, ^{
        RenderPlaceholderFrame(buf, frameIdx++);
        PublishFrame(buf);
    });
    dispatch_resume(gPlaceholderTimer);
}

static void StopPlaceholderSource(void) {
    if (gPlaceholderTimer) {
        dispatch_source_cancel(gPlaceholderTimer);
        gPlaceholderTimer = NULL;
    }
}

#pragma mark Webcam source

static AVCaptureDevice *PickWebcamDevice(NSString *idOrName) {
    AVCaptureDeviceDiscoverySession *s = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
            AVCaptureDeviceTypeBuiltInWideAngleCamera,
            AVCaptureDeviceTypeExternal,
            AVCaptureDeviceTypeContinuityCamera,
        ]
        mediaType:AVMediaTypeVideo
        position:AVCaptureDevicePositionUnspecified];
    if (!idOrName.length) {
        for (AVCaptureDevice *d in s.devices)
            if (d.position == AVCaptureDevicePositionFront) return d;
        return s.devices.firstObject;
    }
    for (AVCaptureDevice *d in s.devices)
        if ([d.uniqueID isEqualToString:idOrName]) return d;
    for (AVCaptureDevice *d in s.devices)
        if ([d.localizedName.lowercaseString containsString:idOrName.lowercaseString]) return d;
    return nil;
}

static BOOL StartWebcamSource(NSString *deviceArg, NSString **err) {
    AVCaptureDevice *device = PickWebcamDevice(deviceArg);
    if (!device) { if (err) *err = @"no matching camera"; return NO; }
    NSError *e = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&e];
    if (!input) { if (err) *err = e.localizedDescription ?: @"deviceInput failed"; return NO; }
    AVCaptureSession *sess = [AVCaptureSession new];
    sess.sessionPreset = AVCaptureSessionPreset1280x720;
    if (![sess canAddInput:input]) { if (err) *err = @"session canAddInput=NO"; return NO; }
    [sess addInput:input];
    if (!gWebcamWriter) gWebcamWriter = [SimCamWebcamWriter new];
    AVCaptureVideoDataOutput *out = [AVCaptureVideoDataOutput new];
    out.alwaysDiscardsLateVideoFrames = YES;
    out.videoSettings = @{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
    };
    [out setSampleBufferDelegate:gWebcamWriter
                           queue:dispatch_queue_create("simcam.helper.webcam",
                                                       DISPATCH_QUEUE_SERIAL)];
    if (![sess canAddOutput:out]) { if (err) *err = @"session canAddOutput=NO"; return NO; }
    [sess addOutput:out];
    [sess startRunning];
    gWebcamSession = sess;
    fprintf(stderr, "[serve-sim-camera] webcam → %s\n", device.localizedName.UTF8String);
    return YES;
}

static void StopWebcamSource(void) {
    if (gWebcamSession) {
        [gWebcamSession stopRunning];
        gWebcamSession = nil;
    }
}

#pragma mark Image source

static BOOL StartImageSource(NSString *path, NSString **err) {
    if (!path.length) { if (err) *err = @"image source needs a path"; return NO; }
    CGImageSourceRef src = CGImageSourceCreateWithURL(
        (__bridge CFURLRef)[NSURL fileURLWithPath:path], NULL);
    if (!src) { if (err) *err = @"could not open image"; return NO; }
    CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    CFRelease(src);
    if (!img) { if (err) *err = @"could not decode image"; return NO; }

    size_t bpr = (size_t)gWidth * 4;
    uint8_t *buf = calloc(1, bpr * gHeight);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(buf, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    // Aspect-fill the source image into the destination buffer.
    size_t iw = CGImageGetWidth(img), ih = CGImageGetHeight(img);
    double sx = (double)gWidth / iw, sy = (double)gHeight / ih;
    double s = MAX(sx, sy);
    double dw = iw * s, dh = ih * s;
    CGContextDrawImage(ctx, CGRectMake((gWidth - dw)/2.0, (gHeight - dh)/2.0, dw, dh), img);
    CGContextRelease(ctx);
    CGImageRelease(img);

    PublishFrame(buf);
    free(buf);
    fprintf(stderr, "[serve-sim-camera] image → %s\n", path.UTF8String);
    return YES;
}

static void StopImageSource(void) {
    // Nothing live; the published frame stays in shm until next source overwrites.
}

#pragma mark Video source (looping playback via AVAssetReader)

// Looping AVAsset playback at native FPS. Frames are decoded as BGRA on a
// background queue, scaled with vImage into the shm buffer, then paced with
// `clock_nanosleep` against the track's presentation timestamps so playback
// runs at real time. When the reader hits AVAssetReaderStatusCompleted we
// recreate it and reset the wall-clock anchor so the loop boundary is
// seamless.

static dispatch_queue_t gVideoQueue;
static atomic_bool gVideoCancelled = false;
static dispatch_semaphore_t gVideoStopped;  // signaled when the loop exits

static AVAssetReaderTrackOutput *MakeVideoOutput(AVAssetReader **outReader,
                                                 AVAssetTrack *track,
                                                 NSString **errOut) {
    NSError *e = nil;
    AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:track.asset error:&e];
    if (!reader) {
        if (errOut) *errOut = e.localizedDescription ?: @"AVAssetReader init failed";
        return nil;
    }
    AVAssetReaderTrackOutput *out = [AVAssetReaderTrackOutput
        assetReaderTrackOutputWithTrack:track
                         outputSettings:@{
                             (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
                             (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
                         }];
    out.alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:out]) {
        if (errOut) *errOut = @"reader rejected BGRA output";
        return nil;
    }
    [reader addOutput:out];
    if (![reader startReading]) {
        if (errOut) *errOut = reader.error.localizedDescription ?: @"reader failed to start";
        return nil;
    }
    *outReader = reader;
    return out;
}

// Aspect-fill a source pixel buffer into a transient BGRA buffer sized to
// the shm region. We allocate once per call so the caller is free to free
// the result without worrying about lifetime sharing.
static uint8_t *RenderPixelBufferToShmSize(CVPixelBufferRef pb) {
    size_t srcW = CVPixelBufferGetWidth(pb);
    size_t srcH = CVPixelBufferGetHeight(pb);
    if (srcW == 0 || srcH == 0) return NULL;
    CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    uint8_t *src = CVPixelBufferGetBaseAddress(pb);
    size_t srcBPR = CVPixelBufferGetBytesPerRow(pb);
    if (!src) {
        CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
        return NULL;
    }

    size_t bpr = (size_t)gWidth * 4;
    uint8_t *out = calloc(1, bpr * gHeight);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(out, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);

    // Wrap the source pixels as a CGImage we can hand to CoreGraphics.
    CGDataProviderRef dp = CGDataProviderCreateWithData(NULL, src, srcBPR * srcH, NULL);
    CGColorSpaceRef imgCs = CGColorSpaceCreateDeviceRGB();
    CGImageRef img = CGImageCreate(srcW, srcH, 8, 32, srcBPR, imgCs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little,
        dp, NULL, false, kCGRenderingIntentDefault);
    CGColorSpaceRelease(imgCs);
    CGDataProviderRelease(dp);

    double sx = (double)gWidth / srcW, sy = (double)gHeight / srcH;
    double s = MAX(sx, sy);
    double dw = srcW * s, dh = srcH * s;
    CGContextDrawImage(ctx, CGRectMake((gWidth - dw)/2.0, (gHeight - dh)/2.0, dw, dh), img);
    CGImageRelease(img);
    CGContextRelease(ctx);
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    return out;
}

static void RunVideoLoop(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    AVAsset *asset = [AVAsset assetWithURL:url];
    NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    if (tracks.count == 0) {
        fprintf(stderr, "[serve-sim-camera] video → %s: no video tracks\n", path.UTF8String);
        dispatch_semaphore_signal(gVideoStopped);
        return;
    }
    AVAssetTrack *track = tracks.firstObject;

    while (!atomic_load(&gVideoCancelled)) {
        NSString *err = nil;
        AVAssetReader *reader = nil;
        AVAssetReaderTrackOutput *out = MakeVideoOutput(&reader, track, &err);
        if (!out) {
            fprintf(stderr, "[serve-sim-camera] video reader failed: %s\n", err.UTF8String ?: "?");
            break;
        }

        uint64_t loopStartNs = MachAbsToNs(mach_absolute_time());
        while (!atomic_load(&gVideoCancelled)) {
            CMSampleBufferRef sb = [out copyNextSampleBuffer];
            if (!sb) break;  // end of track or read error → loop or exit
            CMTime pts = CMSampleBufferGetPresentationTimeStamp(sb);
            CVPixelBufferRef pb = CMSampleBufferGetImageBuffer(sb);
            if (pb) {
                uint8_t *frame = RenderPixelBufferToShmSize(pb);
                if (frame) {
                    // Pace against wall clock: don't publish until the
                    // frame's PTS has caught up. Skips backwards (e.g.
                    // first frame of each loop) without sleeping.
                    if (CMTIME_IS_VALID(pts) && pts.timescale > 0) {
                        uint64_t targetNs = loopStartNs +
                            (uint64_t)((double)pts.value * 1e9 / pts.timescale);
                        uint64_t nowNs = MachAbsToNs(mach_absolute_time());
                        if (targetNs > nowNs) {
                            uint64_t sleepNs = targetNs - nowNs;
                            // Cap waits to 100ms slices so cancellation
                            // is responsive on long-PTS gaps.
                            while (sleepNs > 0 && !atomic_load(&gVideoCancelled)) {
                                uint64_t slice = sleepNs > 100000000ULL ? 100000000ULL : sleepNs;
                                struct timespec ts = {
                                    .tv_sec = (time_t)(slice / 1000000000ULL),
                                    .tv_nsec = (long)(slice % 1000000000ULL),
                                };
                                nanosleep(&ts, NULL);
                                sleepNs -= slice;
                            }
                        }
                    }
                    PublishFrame(frame);
                    free(frame);
                }
            }
            CFRelease(sb);
        }

        AVAssetReaderStatus status = reader.status;
        [reader cancelReading];
        if (status == AVAssetReaderStatusFailed) {
            fprintf(stderr, "[serve-sim-camera] video reader failed mid-loop: %s\n",
                    reader.error.localizedDescription.UTF8String ?: "?");
            break;
        }
        // Otherwise rewind by re-creating the reader on the next iteration.
    }
    dispatch_semaphore_signal(gVideoStopped);
}

static BOOL StartVideoSource(NSString *path, NSString **err) {
    if (!path.length) { if (err) *err = @"video source needs a path"; return NO; }
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
        if (err) *err = [NSString stringWithFormat:@"video file not found: %@", path];
        return NO;
    }
    if (!gVideoQueue) {
        gVideoQueue = dispatch_queue_create("serve-sim.cam.video", DISPATCH_QUEUE_SERIAL);
    }
    atomic_store(&gVideoCancelled, false);
    gVideoStopped = dispatch_semaphore_create(0);
    NSString *captured = [path copy];
    dispatch_async(gVideoQueue, ^{ RunVideoLoop(captured); });
    fprintf(stderr, "[serve-sim-camera] video → %s\n", path.UTF8String);
    return YES;
}

static void StopVideoSource(void) {
    if (!gVideoStopped) return;
    atomic_store(&gVideoCancelled, true);
    // Wait up to 1s for the decode loop to bail.
    dispatch_semaphore_wait(gVideoStopped, dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC));
    gVideoStopped = nil;
}

#pragma mark Source switch entry point

static BOOL SwitchSource(SimCamSourceKind kind, NSString *arg, NSString **errOut) {
    __block BOOL ok = NO;
    __block NSString *err = nil;
    dispatch_sync(gSourceQueue, ^{
        switch (gActiveSource) {
            case SimCamSourcePlaceholder: StopPlaceholderSource(); break;
            case SimCamSourceWebcam:      StopWebcamSource(); break;
            case SimCamSourceImage:       StopImageSource(); break;
            case SimCamSourceVideo:       StopVideoSource(); break;
            default: break;
        }
        gActiveSource = SimCamSourceNone;
        gActiveArg = nil;
        switch (kind) {
            case SimCamSourcePlaceholder: StartPlaceholderSource(); ok = YES; break;
            case SimCamSourceWebcam:      ok = StartWebcamSource(arg, &err); break;
            case SimCamSourceImage:       ok = StartImageSource(arg, &err); break;
            case SimCamSourceVideo:       ok = StartVideoSource(arg, &err); break;
            default: ok = YES; break;
        }
        if (ok) { gActiveSource = kind; gActiveArg = [arg copy]; }
    });
    if (errOut) *errOut = err;
    return ok;
}

static SimCamSourceKind ParseSourceName(NSString *name) {
    if ([name isEqualToString:@"placeholder"]) return SimCamSourcePlaceholder;
    if ([name isEqualToString:@"webcam"])      return SimCamSourceWebcam;
    if ([name isEqualToString:@"image"])       return SimCamSourceImage;
    if ([name isEqualToString:@"video"])       return SimCamSourceVideo;
    if ([name isEqualToString:@"none"])        return SimCamSourceNone;
    return -1;
}
static NSString *SourceName(SimCamSourceKind k) {
    switch (k) {
        case SimCamSourcePlaceholder: return @"placeholder";
        case SimCamSourceWebcam:      return @"webcam";
        case SimCamSourceImage:       return @"image";
        case SimCamSourceVideo:       return @"video";
        default:                      return @"none";
    }
}

#pragma mark - Control socket

static int gControlListenFd = -1;
static dispatch_source_t gAcceptSource;

static NSData *EncodeReply(NSDictionary *dict) {
    NSMutableDictionary *m = dict.mutableCopy;
    if (!m[@"source"]) m[@"source"] = SourceName(gActiveSource);
    if (!m[@"arg"] && gActiveArg) m[@"arg"] = gActiveArg;
    if (!m[@"mirror"] && gHeader) m[@"mirror"] = MirrorName(gHeader->mirrorMode);
    NSError *e = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:m options:0 error:&e];
    if (!json) json = [@"{\"ok\":false}" dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableData *out = json.mutableCopy;
    [out appendBytes:"\n" length:1];
    return out;
}

static void HandleControlLine(int fd, NSString *line) {
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    NSError *e = nil;
    NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:data options:0 error:&e];
    if (![cmd isKindOfClass:[NSDictionary class]]) {
        NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"invalid json" });
        write(fd, r.bytes, r.length);
        return;
    }
    NSString *action = cmd[@"action"];
    if ([action isEqualToString:@"status"]) {
        NSData *r = EncodeReply(@{ @"ok": @YES });
        write(fd, r.bytes, r.length);
        return;
    }
    if ([action isEqualToString:@"shutdown"]) {
        NSData *r = EncodeReply(@{ @"ok": @YES, @"shutdown": @YES });
        write(fd, r.bytes, r.length);
        gShouldExit = 1;
        return;
    }
    if ([action isEqualToString:@"switch"]) {
        SimCamSourceKind k = ParseSourceName(cmd[@"source"]);
        if (k == (SimCamSourceKind)-1) {
            NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"unknown source" });
            write(fd, r.bytes, r.length);
            return;
        }
        NSString *err = nil;
        BOOL ok = SwitchSource(k, cmd[@"arg"], &err);
        NSData *r = EncodeReply(ok
            ? @{ @"ok": @YES }
            : @{ @"ok": @NO, @"error": err ?: @"switch failed" });
        write(fd, r.bytes, r.length);
        return;
    }
    if ([action isEqualToString:@"setMirror"]) {
        NSString *mode = cmd[@"mode"] ?: @"auto";
        uint8_t code = ParseMirrorCode(mode);
        if (code == 0xFE) {
            NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"unknown mirror mode" });
            write(fd, r.bytes, r.length);
            return;
        }
        if (gHeader) gHeader->mirrorMode = code;
        NSData *r = EncodeReply(@{ @"ok": @YES, @"mirror": MirrorName(code) });
        write(fd, r.bytes, r.length);
        return;
    }
    NSData *r = EncodeReply(@{ @"ok": @NO, @"error": @"unknown action" });
    write(fd, r.bytes, r.length);
}

static void HandleClient(int fd) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSMutableData *buf = [NSMutableData new];
        char tmp[1024];
        while (1) {
            ssize_t n = read(fd, tmp, sizeof(tmp));
            if (n <= 0) break;
            [buf appendBytes:tmp length:n];
            while (1) {
                NSString *all = [[NSString alloc] initWithData:buf encoding:NSUTF8StringEncoding];
                NSRange nl = [all rangeOfString:@"\n"];
                if (nl.location == NSNotFound) break;
                NSString *line = [all substringToIndex:nl.location];
                NSUInteger consumed = [[all substringToIndex:nl.location + 1]
                    lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
                [buf replaceBytesInRange:NSMakeRange(0, consumed) withBytes:NULL length:0];
                if (line.length > 0) HandleControlLine(fd, line);
            }
        }
        close(fd);
    });
}

static int OpenControlSocket(const char *path) {
    unlink(path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    if (strlen(path) >= sizeof(addr.sun_path)) {
        fprintf(stderr, "control socket path too long: %s\n", path);
        close(fd); return -1;
    }
    strlcpy(addr.sun_path, path, sizeof(addr.sun_path));
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); close(fd); return -1;
    }
    if (listen(fd, 4) < 0) { perror("listen"); close(fd); return -1; }
    chmod(path, 0600);
    gControlListenFd = fd;
    gAcceptSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,
        fd, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_event_handler(gAcceptSource, ^{
        int client = accept(fd, NULL, NULL);
        if (client >= 0) HandleClient(client);
    });
    dispatch_resume(gAcceptSource);
    return fd;
}

#pragma mark - Listing / shm setup / main

static void ListDevices(void) {
    AVCaptureDeviceDiscoverySession *s = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
            AVCaptureDeviceTypeBuiltInWideAngleCamera,
            AVCaptureDeviceTypeExternal,
            AVCaptureDeviceTypeContinuityCamera,
        ]
        mediaType:AVMediaTypeVideo
        position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *d in s.devices) {
        printf("%s\t%s\n", d.uniqueID.UTF8String, d.localizedName.UTF8String);
    }
}

static int OpenShm(const char *name, size_t size) {
    shm_unlink(name);
    int fd = shm_open(name, O_CREAT | O_RDWR, 0644);
    if (fd < 0) { perror("shm_open"); return -1; }
    if (ftruncate(fd, (off_t)size) < 0) { perror("ftruncate"); close(fd); return -1; }
    void *map = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) { perror("mmap"); close(fd); return -1; }
    gHeader = (SimCamShmHeader *)map;
    gPixels = (uint8_t *)map + sizeof(SimCamShmHeader);
    memset(gHeader, 0, sizeof(*gHeader));
    gHeader->magic = SIMCAM_SHM_MAGIC;
    gHeader->version = 1;
    gHeader->width = gWidth;
    gHeader->height = gHeight;
    gHeader->pixelFormat = SIMCAM_PIXEL_BGRA;
    gHeader->bytesPerRow = gWidth * 4;
    gHeader->pixelByteSize = (uint64_t)gWidth * gHeight * 4;
    gHeader->mirrorMode = SIMCAM_MIRROR_UNSET; // dylib falls back to env
    return fd;
}

static uint8_t ParseMirrorCode(NSString *mode) {
    if ([mode isEqualToString:@"on"])    return SIMCAM_MIRROR_ON;
    if ([mode isEqualToString:@"off"])   return SIMCAM_MIRROR_OFF;
    if ([mode isEqualToString:@"auto"])  return SIMCAM_MIRROR_AUTO;
    if ([mode isEqualToString:@"unset"]) return SIMCAM_MIRROR_UNSET;
    return 0xFE; // sentinel for "invalid"
}
static NSString *MirrorName(uint8_t code) {
    switch (code) {
        case SIMCAM_MIRROR_ON:    return @"on";
        case SIMCAM_MIRROR_OFF:   return @"off";
        case SIMCAM_MIRROR_AUTO:  return @"auto";
        case SIMCAM_MIRROR_UNSET: return @"unset";
        default:                  return @"?";
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *initialSource = @"placeholder";
        NSString *initialArg = nil;
        const char *socketPath = NULL;
        BOOL list = NO;
        for (int i = 1; i < argc; i++) {
            const char *a = argv[i];
            if (!strcmp(a, "--shm") && i+1 < argc) gShmName = argv[++i];
            else if (!strcmp(a, "--socket") && i+1 < argc) socketPath = argv[++i];
            else if (!strcmp(a, "--source") && i+1 < argc) initialSource = @(argv[++i]);
            else if (!strcmp(a, "--arg") && i+1 < argc) initialArg = @(argv[++i]);
            else if (!strcmp(a, "--device") && i+1 < argc) initialArg = @(argv[++i]); // back-compat
            else if (!strcmp(a, "--width") && i+1 < argc) gWidth = (uint32_t)atoi(argv[++i]);
            else if (!strcmp(a, "--height") && i+1 < argc) gHeight = (uint32_t)atoi(argv[++i]);
            else if (!strcmp(a, "--list")) list = YES;
            else if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
                printf("Usage: %s --shm <name> [--socket <path>] [--source placeholder|webcam|image] [--arg <value>] [--width N --height N]\n"
                       "       %s --list\n", argv[0], argv[0]);
                return 0;
            }
        }
        if (list) { ListDevices(); return 0; }
        if (!gShmName) { fprintf(stderr, "error: --shm <name> required\n"); return 64; }

        // Webcam back-compat: if user passed --device but no --source we
        // default to webcam mode rather than placeholder.
        if (initialArg && [initialSource isEqualToString:@"placeholder"]
                && [@[@"--device"] containsObject:@"--device"]) {
            // (no-op marker; --device implies webcam below if user intended it)
        }

        size_t shmSize = (size_t)SimCamShmSizeFor(gWidth, gHeight);
        if (OpenShm(gShmName, shmSize) < 0) return 1;
        fprintf(stderr, "[serve-sim-camera] shm \"%s\" %zu bytes (%ux%u BGRA)\n",
                gShmName, shmSize, gWidth, gHeight);

        gSourceQueue = dispatch_queue_create("simcam.helper.source", DISPATCH_QUEUE_SERIAL);

        if (socketPath) {
            if (OpenControlSocket(socketPath) < 0) {
                fprintf(stderr, "[serve-sim-camera] control socket open failed: %s\n", socketPath);
            } else {
                fprintf(stderr, "[serve-sim-camera] control socket %s\n", socketPath);
            }
        }

        SimCamSourceKind k = ParseSourceName(initialSource);
        if (k == (SimCamSourceKind)-1) {
            fprintf(stderr, "[serve-sim-camera] unknown --source %s, defaulting to placeholder\n",
                initialSource.UTF8String);
            k = SimCamSourcePlaceholder;
        }
        NSString *err = nil;
        if (!SwitchSource(k, initialArg, &err)) {
            fprintf(stderr, "[serve-sim-camera] initial source failed: %s — falling back to placeholder\n",
                err.UTF8String ?: "?");
            (void)SwitchSource(SimCamSourcePlaceholder, nil, NULL);
        }

        signal(SIGINT, HandleSig);
        signal(SIGTERM, HandleSig);

        fprintf(stderr, "[serve-sim-camera] running — Ctrl+C to stop\n");
        while (!gShouldExit) {
            [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        }
        if (gAcceptSource) dispatch_source_cancel(gAcceptSource);
        if (gControlListenFd >= 0) { close(gControlListenFd); if (socketPath) unlink(socketPath); }
        StopPlaceholderSource();
        StopWebcamSource();
        if (gShmName) shm_unlink(gShmName);
        fprintf(stderr, "[serve-sim-camera] stopped\n");
        return 0;
    }
}
