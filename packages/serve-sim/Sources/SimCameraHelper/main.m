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

#pragma mark Placeholder source

static void HSVtoRGBA(double h, double s, double v, CGFloat *o) {
    double r=0,g=0,b=0;
    int i = (int)(h*6) % 6;
    double f = h*6 - (int)(h*6);
    double p = v*(1-s), q = v*(1-f*s), t2 = v*(1-(1-f)*s);
    switch (i) {
        case 0: r=v; g=t2; b=p; break;
        case 1: r=q; g=v;  b=p; break;
        case 2: r=p; g=v;  b=t2; break;
        case 3: r=p; g=q;  b=v; break;
        case 4: r=t2;g=p;  b=v; break;
        default:r=v; g=p;  b=q;
    }
    o[0]=r; o[1]=g; o[2]=b; o[3]=1;
}

static void RenderPlaceholderFrame(uint8_t *out, uint64_t frameIdx) {
    size_t bpr = (size_t)gWidth * 4;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(out, gWidth, gHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(cs);
    if (!ctx) return;

    // Time-varying gradient for motion. Hue rotates ~10s/cycle.
    double t = (double)frameIdx / 30.0;
    double phase = fmod(t * 0.1, 1.0);
    CGFloat colors[8];
    HSVtoRGBA(phase,                 0.55, 0.85, &colors[0]);
    HSVtoRGBA(fmod(phase + 0.5, 1.0), 0.55, 0.85, &colors[4]);
    CGGradientRef g = CGGradientCreateWithColorComponents(
        CGBitmapContextGetColorSpace(ctx), colors, (CGFloat[]){0,1}, 2);
    CGContextDrawLinearGradient(ctx, g, CGPointZero,
        CGPointMake(gWidth, gHeight), 0);
    CGGradientRelease(g);

    // Crosshairs
    CGContextSetRGBStrokeColor(ctx, 1, 1, 1, 0.18);
    CGContextSetLineWidth(ctx, 1);
    CGContextMoveToPoint(ctx, gWidth/2.0, 0);
    CGContextAddLineToPoint(ctx, gWidth/2.0, gHeight);
    CGContextMoveToPoint(ctx, 0, gHeight/2.0);
    CGContextAddLineToPoint(ctx, gWidth, gHeight/2.0);
    CGContextStrokePath(ctx);

    // Bouncing dot — a quick "is this live?" tell.
    double bx = (sin(t * 1.7) * 0.5 + 0.5) * (gWidth - 80) + 40;
    double by = (cos(t * 1.3) * 0.5 + 0.5) * (gHeight - 80) + 40;
    CGContextSetRGBFillColor(ctx, 1, 1, 1, 0.9);
    CGContextFillEllipseInRect(ctx, CGRectMake(bx-12, by-12, 24, 24));

    // Frame counter / clock.
    CFStringRef txt = CFStringCreateWithFormat(NULL, NULL,
        CFSTR("serve-sim placeholder · frame %llu · %.1fs"),
        (unsigned long long)frameIdx, t);
    CFRange r = { 0, CFStringGetLength(txt) };
    CFMutableAttributedStringRef attr = CFAttributedStringCreateMutable(NULL, 0);
    CFAttributedStringReplaceString(attr, CFRangeMake(0, 0), txt);
    CTFontRef font = CTFontCreateWithName(CFSTR("Menlo-Bold"), 28, NULL);
    CFAttributedStringSetAttribute(attr, r, kCTFontAttributeName, font);
    CGFloat white[] = {1, 1, 1, 0.9};
    CGColorRef c = CGColorCreate(CGBitmapContextGetColorSpace(ctx), white);
    CFAttributedStringSetAttribute(attr, r, kCTForegroundColorAttributeName, c);
    CGColorRelease(c);
    CTLineRef line = CTLineCreateWithAttributedString(attr);
    CGContextSetTextPosition(ctx, 32, 32);
    CTLineDraw(line, ctx);
    CFRelease(line);
    CFRelease(attr);
    CFRelease(font);
    CFRelease(txt);

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

#pragma mark Source switch entry point

static BOOL SwitchSource(SimCamSourceKind kind, NSString *arg, NSString **errOut) {
    __block BOOL ok = NO;
    __block NSString *err = nil;
    dispatch_sync(gSourceQueue, ^{
        switch (gActiveSource) {
            case SimCamSourcePlaceholder: StopPlaceholderSource(); break;
            case SimCamSourceWebcam:      StopWebcamSource(); break;
            case SimCamSourceImage:       StopImageSource(); break;
            default: break;
        }
        gActiveSource = SimCamSourceNone;
        gActiveArg = nil;
        switch (kind) {
            case SimCamSourcePlaceholder: StartPlaceholderSource(); ok = YES; break;
            case SimCamSourceWebcam:      ok = StartWebcamSource(arg, &err); break;
            case SimCamSourceImage:       ok = StartImageSource(arg, &err); break;
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
    if ([name isEqualToString:@"none"])        return SimCamSourceNone;
    return -1;
}
static NSString *SourceName(SimCamSourceKind k) {
    switch (k) {
        case SimCamSourcePlaceholder: return @"placeholder";
        case SimCamSourceWebcam:      return @"webcam";
        case SimCamSourceImage:       return @"image";
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
    return fd;
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
