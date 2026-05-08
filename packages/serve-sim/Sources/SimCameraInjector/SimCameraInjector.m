// SimCameraInjector — MVP camera frame injector for the iOS Simulator.
//
// Loaded via DYLD_INSERT_LIBRARIES into a simulator app process.
// Reads SIMCAM_IMAGE_PATH (PNG/JPEG); feeds it as the camera feed.
//
// Strategy:
//   1. Method-swizzle AVCaptureDevice discovery so apps see a fake device.
//   2. Allow AVCaptureDeviceInput to wrap the fake device.
//   3. Track AVCaptureVideoDataOutput delegates and pump CMSampleBuffers
//      from the loaded image at ~30fps when the session starts running.
//   4. Mirror the same image as `contents` on AVCaptureVideoPreviewLayer
//      so the visible preview path also shows the injected frames.

#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <stdatomic.h>
#include <errno.h>
#include "include/SimCamShared.h"

static UIImage *gSourceImage = nil;
static CGImageRef gSourceCGImage = NULL;
static size_t kFrameWidth = 1280;
static size_t kFrameHeight = 720;
static const double kFrameRate = 30.0;

// Shared-memory webcam source (optional).
static SimCamShmHeader *gShmHeader = NULL;
static const uint8_t *gShmPixels = NULL;
static size_t gShmTotalSize = 0;
static uint64_t gLastSeenSeq = 0;

#pragma mark - Logging

static void simcam_log(NSString *fmt, ...) {
    va_list args; va_start(args, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
    va_end(args);
    fprintf(stderr, "[SimCam] %s\n", msg.UTF8String);
}

#pragma mark - Fake device

// Position is stored as an associated object so we can use a single
// SimCamFakeDevice subclass for both front and back instances. Using
// class_createInstance bypasses normal -init, so we avoid synthesized ivars.
static char kFakePositionKey;

@interface SimCamFakeDevice : AVCaptureDevice
@end

@implementation SimCamFakeDevice
- (AVCaptureDevicePosition)position {
    NSNumber *n = objc_getAssociatedObject(self, &kFakePositionKey);
    return n ? (AVCaptureDevicePosition)n.intValue : AVCaptureDevicePositionFront;
}
- (NSString *)uniqueID {
    return self.position == AVCaptureDevicePositionBack
        ? @"sim-cam-fake-back-0" : @"sim-cam-fake-front-0";
}
- (NSString *)modelID { return @"SimCamFakeCamera"; }
- (NSString *)localizedName {
    return self.position == AVCaptureDevicePositionBack
        ? @"Simulated Camera Back (serve-sim)"
        : @"Simulated Camera Front (serve-sim)";
}
- (NSString *)manufacturer { return @"serve-sim"; }
- (BOOL)hasMediaType:(AVMediaType)mediaType { return [mediaType isEqualToString:AVMediaTypeVideo]; }
- (BOOL)supportsAVCaptureSessionPreset:(AVCaptureSessionPreset)preset { return YES; }
- (AVCaptureDeviceType)deviceType { return AVCaptureDeviceTypeBuiltInWideAngleCamera; }
- (NSArray<AVCaptureDeviceFormat *> *)formats { return @[]; }
- (BOOL)isConnected { return YES; }
- (BOOL)isSuspended { return NO; }
- (BOOL)lockForConfiguration:(NSError **)e { return YES; }
- (void)unlockForConfiguration { }
// Properties read by camera frameworks (RN-Vision-Camera, expo-camera).
// Override every accessor that Apple's implementation would otherwise reach
// into private ivars for — they're zero on our class_createInstance object.
- (AVCaptureDeviceFormat *)activeFormat { return nil; }
- (CMTime)activeVideoMinFrameDuration { return CMTimeMake(1, 30); }
- (CMTime)activeVideoMaxFrameDuration { return CMTimeMake(1, 30); }
- (CGFloat)videoZoomFactor { return 1.0; }
- (void)setVideoZoomFactor:(CGFloat)v { (void)v; }
- (void)rampToVideoZoomFactor:(CGFloat)f withRate:(float)r { (void)f; (void)r; }
- (void)cancelVideoZoomRamp { }
- (BOOL)isRampingVideoZoom { return NO; }
- (CGFloat)minAvailableVideoZoomFactor { return 1.0; }
- (CGFloat)maxAvailableVideoZoomFactor { return 16.0; }
- (CGFloat)dualCameraSwitchOverVideoZoomFactor { return 2.0; }
- (NSArray<NSNumber *> *)virtualDeviceSwitchOverVideoZoomFactors { return @[]; }
- (NSArray *)constituentDevices { return @[]; }
- (BOOL)isVirtualDevice { return NO; }
- (BOOL)hasTorch { return NO; }
- (BOOL)hasFlash { return NO; }
- (BOOL)isTorchAvailable { return NO; }
- (BOOL)isTorchActive { return NO; }
- (AVCaptureTorchMode)torchMode { return AVCaptureTorchModeOff; }
- (void)setTorchMode:(AVCaptureTorchMode)m { (void)m; }
- (BOOL)isTorchModeSupported:(AVCaptureTorchMode)m { (void)m; return NO; }
- (BOOL)setTorchModeOnWithLevel:(float)l error:(NSError **)e { (void)l; if (e) *e = nil; return YES; }
- (AVCaptureFocusMode)focusMode { return AVCaptureFocusModeContinuousAutoFocus; }
- (void)setFocusMode:(AVCaptureFocusMode)m { (void)m; }
- (BOOL)isFocusModeSupported:(AVCaptureFocusMode)m { (void)m; return YES; }
- (CGPoint)focusPointOfInterest { return CGPointMake(0.5, 0.5); }
- (void)setFocusPointOfInterest:(CGPoint)p { (void)p; }
- (BOOL)isFocusPointOfInterestSupported { return YES; }
- (BOOL)isAdjustingFocus { return NO; }
- (BOOL)isSmoothAutoFocusEnabled { return NO; }
- (void)setSmoothAutoFocusEnabled:(BOOL)b { (void)b; }
- (BOOL)isSmoothAutoFocusSupported { return NO; }
- (AVCaptureAutoFocusRangeRestriction)autoFocusRangeRestriction { return AVCaptureAutoFocusRangeRestrictionNone; }
- (void)setAutoFocusRangeRestriction:(AVCaptureAutoFocusRangeRestriction)r { (void)r; }
- (BOOL)isAutoFocusRangeRestrictionSupported { return NO; }
- (AVCaptureExposureMode)exposureMode { return AVCaptureExposureModeContinuousAutoExposure; }
- (void)setExposureMode:(AVCaptureExposureMode)m { (void)m; }
- (BOOL)isExposureModeSupported:(AVCaptureExposureMode)m { (void)m; return YES; }
- (CGPoint)exposurePointOfInterest { return CGPointMake(0.5, 0.5); }
- (void)setExposurePointOfInterest:(CGPoint)p { (void)p; }
- (BOOL)isExposurePointOfInterestSupported { return YES; }
- (BOOL)isAdjustingExposure { return NO; }
- (float)exposureTargetBias { return 0.0f; }
- (float)minExposureTargetBias { return -8.0f; }
- (float)maxExposureTargetBias { return 8.0f; }
- (CMTime)exposureDuration { return CMTimeMake(1, 30); }
- (float)ISO { return 100.0f; }
- (float)minISO { return 25.0f; }
- (float)maxISO { return 6400.0f; }
- (CMTime)activeMinExposureDuration { return CMTimeMake(1, 8000); }
- (CMTime)activeMaxExposureDuration { return CMTimeMake(1, 30); }
- (AVCaptureWhiteBalanceMode)whiteBalanceMode { return AVCaptureWhiteBalanceModeContinuousAutoWhiteBalance; }
- (void)setWhiteBalanceMode:(AVCaptureWhiteBalanceMode)m { (void)m; }
- (BOOL)isWhiteBalanceModeSupported:(AVCaptureWhiteBalanceMode)m { (void)m; return YES; }
- (BOOL)isAdjustingWhiteBalance { return NO; }
- (BOOL)isFlashAvailable { return NO; }
- (BOOL)videoHDREnabled { return NO; }
- (void)setVideoHDREnabled:(BOOL)b { (void)b; }
- (BOOL)automaticallyAdjustsVideoHDREnabled { return NO; }
- (void)setAutomaticallyAdjustsVideoHDREnabled:(BOOL)b { (void)b; }
- (BOOL)isLowLightBoostSupported { return NO; }
- (BOOL)isLowLightBoostEnabled { return NO; }
- (BOOL)automaticallyEnablesLowLightBoostWhenAvailable { return NO; }
- (void)setAutomaticallyEnablesLowLightBoostWhenAvailable:(BOOL)b { (void)b; }
- (NSArray *)linkedDevices { return @[]; }
@end

static AVCaptureDevice *SimCamFakeDeviceForPosition(AVCaptureDevicePosition p) {
    static AVCaptureDevice *front = nil;
    static AVCaptureDevice *back = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        front = (AVCaptureDevice *)class_createInstance([SimCamFakeDevice class], 0);
        objc_setAssociatedObject(front, &kFakePositionKey,
            @(AVCaptureDevicePositionFront), OBJC_ASSOCIATION_RETAIN);
        back = (AVCaptureDevice *)class_createInstance([SimCamFakeDevice class], 0);
        objc_setAssociatedObject(back, &kFakePositionKey,
            @(AVCaptureDevicePositionBack), OBJC_ASSOCIATION_RETAIN);
    });
    return p == AVCaptureDevicePositionBack ? back : front;
}

// Look up the position the app picked for any object we tagged in the chain.
static char kSimCamPositionKey;

static AVCaptureDevicePosition SimCamPositionOf(id obj) {
    if (!obj) return AVCaptureDevicePositionFront;
    NSNumber *n = objc_getAssociatedObject(obj, &kSimCamPositionKey);
    return n ? (AVCaptureDevicePosition)n.intValue : AVCaptureDevicePositionFront;
}
static void SimCamSetPosition(id obj, AVCaptureDevicePosition p) {
    objc_setAssociatedObject(obj, &kSimCamPositionKey, @(p), OBJC_ASSOCIATION_RETAIN);
}
static BOOL SimCamShouldMirror(AVCaptureDevicePosition p) {
    // Front camera: mirror, matching AVCaptureVideoPreviewLayer's default
    // automaticallyAdjustsVideoMirroring=YES behavior on real hardware.
    return p == AVCaptureDevicePositionFront;
}

#pragma mark - Output delegate registry

@interface SimCamRegistry : NSObject
+ (instancetype)shared;
- (void)addOutput:(AVCaptureVideoDataOutput *)out
         delegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)delegate
            queue:(dispatch_queue_t)queue;
- (void)removeOutput:(AVCaptureVideoDataOutput *)out;
- (void)addPreviewLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)startPumpingIfNeeded;
- (void)stopPumping;
@end

@implementation SimCamRegistry {
    NSMutableArray *_entries; // each: @{ @"out": out, @"del": del, @"queue": q }
    NSHashTable<AVCaptureVideoPreviewLayer *> *_layers;
    dispatch_source_t _timer;
    dispatch_queue_t _timerQueue;
    NSLock *_lock;
}

+ (instancetype)shared {
    static SimCamRegistry *s; static dispatch_once_t o;
    dispatch_once(&o, ^{ s = [SimCamRegistry new]; });
    return s;
}

- (instancetype)init {
    if ((self = [super init])) {
        _entries = [NSMutableArray new];
        _layers = [NSHashTable weakObjectsHashTable];
        _timerQueue = dispatch_queue_create("dev.servesim.simcam.pump", DISPATCH_QUEUE_SERIAL);
        _lock = [NSLock new];
    }
    return self;
}

- (void)addOutput:(AVCaptureVideoDataOutput *)out
         delegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)delegate
            queue:(dispatch_queue_t)queue {
    if (!out || !delegate) return;
    [_lock lock];
    // Strong-retain the output (we never let the native session retain it).
    // The delegate is held weakly via NSValue; AVFoundation contract is that
    // setSampleBufferDelegate: does not retain its delegate either.
    [_entries addObject:@{
        @"out": out,
        @"del": [NSValue valueWithNonretainedObject:delegate],
        @"queue": queue ?: dispatch_get_main_queue(),
    }];
    [_lock unlock];
    simcam_log(@"registered video data output delegate %@ (pos=%d)",
        delegate, (int)SimCamPositionOf(out));
}

- (void)removeOutput:(AVCaptureVideoDataOutput *)out {
    [_lock lock];
    NSMutableIndexSet *toRemove = [NSMutableIndexSet new];
    [_entries enumerateObjectsUsingBlock:^(NSDictionary *e, NSUInteger i, BOOL *stop) {
        if (e[@"out"] == out) [toRemove addIndex:i];
    }];
    [_entries removeObjectsAtIndexes:toRemove];
    [_lock unlock];
}

- (void)addPreviewLayer:(AVCaptureVideoPreviewLayer *)layer {
    if (!layer) return;
    [_lock lock];
    [_layers addObject:layer];
    [_lock unlock];
    BOOL mirror = SimCamShouldMirror(SimCamPositionOf(layer));
    dispatch_async(dispatch_get_main_queue(), ^{
        layer.contentsGravity = kCAGravityResizeAspectFill;
        // Match AVCaptureVideoPreviewLayer's default front-camera mirroring
        // by negating X scale on the layer transform. Cheaper than flipping
        // pixels every frame and keeps geometry consistent for both static
        // and live sources.
        if (mirror) layer.transform = CATransform3DMakeScale(-1.f, 1.f, 1.f);
        if (gSourceCGImage && !gShmHeader) {
            layer.contents = (__bridge id)gSourceCGImage;
        }
    });
    simcam_log(@"hooked preview layer %p (mirror=%d)", layer, (int)mirror);
}

- (void)pushFrameToLayers:(CVPixelBufferRef)pb {
    if (!pb) return;
    NSArray *layerSnapshot;
    [_lock lock]; layerSnapshot = _layers.allObjects; [_lock unlock];
    if (layerSnapshot.count == 0) return;

    CIImage *ci = [CIImage imageWithCVPixelBuffer:pb];
    static CIContext *ciCtx = nil; static dispatch_once_t once;
    dispatch_once(&once, ^{ ciCtx = [CIContext contextWithOptions:nil]; });
    CGImageRef cg = [ciCtx createCGImage:ci fromRect:ci.extent];
    if (!cg) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        for (AVCaptureVideoPreviewLayer *l in layerSnapshot) {
            l.contents = (__bridge id)cg;
        }
        CGImageRelease(cg);
    });
}

- (CVPixelBufferRef)newPixelBufferFromShm CF_RETURNS_RETAINED {
    if (!gShmHeader || !gShmPixels) return NULL;
    if (gShmHeader->magic != SIMCAM_SHM_MAGIC) return NULL;
    uint64_t seqA = gShmHeader->frameSeq;
    if (seqA == 0 || seqA == gLastSeenSeq) return NULL; // no new frame
    uint32_t w = gShmHeader->width;
    uint32_t h = gShmHeader->height;
    uint32_t bpr = gShmHeader->bytesPerRow;
    if (!w || !h || bpr < w * 4) return NULL;
    if (sizeof(SimCamShmHeader) + (size_t)bpr * h > gShmTotalSize) return NULL;

    CVPixelBufferRef pb = NULL;
    NSDictionary *attrs = @{ (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
    CVReturn r = CVPixelBufferCreate(kCFAllocatorDefault, w, h,
        kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attrs, &pb);
    if (r != kCVReturnSuccess || !pb) return NULL;
    CVPixelBufferLockBaseAddress(pb, 0);
    uint8_t *dst = (uint8_t *)CVPixelBufferGetBaseAddress(pb);
    size_t dstBpr = CVPixelBufferGetBytesPerRow(pb);
    size_t copyBpr = MIN((size_t)bpr, dstBpr);
    for (uint32_t y = 0; y < h; y++) {
        memcpy(dst + y * dstBpr, gShmPixels + y * bpr, copyBpr);
    }
    CVPixelBufferUnlockBaseAddress(pb, 0);

    atomic_thread_fence(memory_order_acquire);
    uint64_t seqB = gShmHeader->frameSeq;
    if (seqA != seqB) {
        // Tear: writer updated mid-copy. Drop this frame; we'll catch the next one.
        CVPixelBufferRelease(pb);
        return NULL;
    }
    gLastSeenSeq = seqA;
    return pb;
}

- (CVPixelBufferRef)newPixelBufferFromImage CF_RETURNS_RETAINED {
    if (!gSourceCGImage) return NULL;
    CVPixelBufferRef pb = NULL;
    NSDictionary *attrs = @{ (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
    CVReturn r = CVPixelBufferCreate(kCFAllocatorDefault, kFrameWidth, kFrameHeight,
        kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attrs, &pb);
    if (r != kCVReturnSuccess || !pb) return NULL;
    CVPixelBufferLockBaseAddress(pb, 0);
    void *base = CVPixelBufferGetBaseAddress(pb);
    size_t bpr = CVPixelBufferGetBytesPerRow(pb);
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(base, kFrameWidth, kFrameHeight, 8, bpr, cs,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little);
    CGContextSetFillColorWithColor(ctx, [UIColor blackColor].CGColor);
    CGContextFillRect(ctx, CGRectMake(0, 0, kFrameWidth, kFrameHeight));
    size_t iw = CGImageGetWidth(gSourceCGImage), ih = CGImageGetHeight(gSourceCGImage);
    double sx = (double)kFrameWidth / iw, sy = (double)kFrameHeight / ih;
    double s = MAX(sx, sy);
    double dw = iw * s, dh = ih * s;
    CGRect dst = CGRectMake((kFrameWidth - dw)/2.0, (kFrameHeight - dh)/2.0, dw, dh);
    CGContextDrawImage(ctx, dst, gSourceCGImage);
    CGContextRelease(ctx);
    CGColorSpaceRelease(cs);
    CVPixelBufferUnlockBaseAddress(pb, 0);
    return pb;
}

- (CMSampleBufferRef)newSampleBufferAtTime:(CMTime)pts CF_RETURNS_RETAINED {
    CVPixelBufferRef pb = [self newPixelBufferFromShm];
    if (!pb) pb = [self newPixelBufferFromImage];
    if (!pb) return NULL;

    CMVideoFormatDescriptionRef fd = NULL;
    CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pb, &fd);
    CMSampleTimingInfo timing = {
        .duration = CMTimeMake(1, (int32_t)kFrameRate),
        .presentationTimeStamp = pts,
        .decodeTimeStamp = kCMTimeInvalid,
    };
    CMSampleBufferRef sb = NULL;
    CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pb, true, NULL, NULL, fd, &timing, &sb);
    if (fd) CFRelease(fd);
    CVPixelBufferRelease(pb);
    return sb;
}

- (void)startPumpingIfNeeded {
    [_lock lock];
    if (_timer) { [_lock unlock]; return; }
    _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _timerQueue);
    uint64_t intervalNs = (uint64_t)(NSEC_PER_SEC / kFrameRate);
    dispatch_source_set_timer(_timer, dispatch_time(DISPATCH_TIME_NOW, 0), intervalNs, intervalNs / 10);
    __weak __typeof(self) weakSelf = self;
    __block int64_t frameIdx = 0;
    dispatch_source_set_event_handler(_timer, ^{
        __strong __typeof(weakSelf) self = weakSelf; if (!self) return;
        CMTime pts = CMTimeMake(frameIdx++, (int32_t)kFrameRate);
        CMSampleBufferRef sb = [self newSampleBufferAtTime:pts];
        if (!sb) return;
        CVImageBufferRef pb = CMSampleBufferGetImageBuffer(sb);
        if (gShmHeader) [self pushFrameToLayers:pb];
        NSArray *snapshot;
        [self->_lock lock]; snapshot = [self->_entries copy]; [self->_lock unlock];
        for (NSDictionary *e in snapshot) {
            AVCaptureVideoDataOutput *out = e[@"out"];
            id<AVCaptureVideoDataOutputSampleBufferDelegate> del =
                ((NSValue *)e[@"del"]).nonretainedObjectValue;
            dispatch_queue_t q = e[@"queue"];
            if (!out || !del) continue;
            CFRetain(sb);
            dispatch_async(q, ^{
                if ([del respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) {
                    AVCaptureConnection *connArg = (AVCaptureConnection *)(id)nil;
                    [del captureOutput:out didOutputSampleBuffer:sb fromConnection:connArg];
                }
                CFRelease(sb);
            });
        }
        CFRelease(sb);
    });
    dispatch_resume(_timer);
    [_lock unlock];
    simcam_log(@"started frame pump @ %.0f fps", kFrameRate);
}

- (void)stopPumping {
    [_lock lock];
    if (_timer) { dispatch_source_cancel(_timer); _timer = NULL; }
    [_lock unlock];
}
@end

#pragma mark - Swizzling helpers

static void SwizzleClassMethod(Class cls, SEL orig, SEL swiz) {
    Method o = class_getClassMethod(cls, orig);
    Method s = class_getClassMethod(cls, swiz);
    if (o && s) method_exchangeImplementations(o, s);
}
static void SwizzleInstanceMethod(Class cls, SEL orig, SEL swiz) {
    Method o = class_getInstanceMethod(cls, orig);
    Method s = class_getInstanceMethod(cls, swiz);
    if (o && s) method_exchangeImplementations(o, s);
}

#pragma mark - AVCaptureDevice swizzles

@interface AVCaptureDevice (SimCam)
@end
@implementation AVCaptureDevice (SimCam)
+ (AVCaptureDevice *)simcam_defaultDeviceWithDeviceType:(AVCaptureDeviceType)t
                                              mediaType:(AVMediaType)m
                                               position:(AVCaptureDevicePosition)p {
    if ([m isEqualToString:AVMediaTypeVideo] || m == nil) {
        AVCaptureDevicePosition resolved =
            (p == AVCaptureDevicePositionBack) ? AVCaptureDevicePositionBack
                                               : AVCaptureDevicePositionFront;
        simcam_log(@"defaultDeviceWithDeviceType: %@ position: %d → fake",
                   t, (int)resolved);
        return SimCamFakeDeviceForPosition(resolved);
    }
    return [self simcam_defaultDeviceWithDeviceType:t mediaType:m position:p];
}
+ (NSArray<AVCaptureDevice *> *)simcam_devicesWithMediaType:(AVMediaType)m {
    if ([m isEqualToString:AVMediaTypeVideo]) {
        return @[
            SimCamFakeDeviceForPosition(AVCaptureDevicePositionFront),
            SimCamFakeDeviceForPosition(AVCaptureDevicePositionBack),
        ];
    }
    return [self simcam_devicesWithMediaType:m];
}
+ (NSArray<AVCaptureDevice *> *)simcam_devices {
    NSArray *real = [self simcam_devices];
    NSArray *fakes = @[
        SimCamFakeDeviceForPosition(AVCaptureDevicePositionFront),
        SimCamFakeDeviceForPosition(AVCaptureDevicePositionBack),
    ];
    return [fakes arrayByAddingObjectsFromArray:real ?: @[]];
}
@end

#pragma mark - AVCaptureDeviceDiscoverySession swizzles

@interface SimCamFakeDiscoverySession : NSObject
@property (nonatomic, strong) NSArray<AVCaptureDevice *> *devices;
@end
@implementation SimCamFakeDiscoverySession
@end

@interface AVCaptureDeviceDiscoverySession (SimCam)
@end
@implementation AVCaptureDeviceDiscoverySession (SimCam)
+ (AVCaptureDeviceDiscoverySession *)simcam_discoverySessionWithDeviceTypes:(NSArray<AVCaptureDeviceType> *)types
                                                                  mediaType:(AVMediaType)m
                                                                   position:(AVCaptureDevicePosition)p {
    AVCaptureDeviceDiscoverySession *real =
        [self simcam_discoverySessionWithDeviceTypes:types mediaType:m position:p];
    if ([m isEqualToString:AVMediaTypeVideo] || m == nil) {
        NSMutableArray *list = [NSMutableArray new];
        if (p == AVCaptureDevicePositionUnspecified || p == AVCaptureDevicePositionFront)
            [list addObject:SimCamFakeDeviceForPosition(AVCaptureDevicePositionFront)];
        if (p == AVCaptureDevicePositionUnspecified || p == AVCaptureDevicePositionBack)
            [list addObject:SimCamFakeDeviceForPosition(AVCaptureDevicePositionBack)];
        @try {
            [real setValue:list forKey:@"devices"];
        } @catch (__unused id e) {
            simcam_log(@"could not override discovery session devices");
        }
    }
    return real;
}
@end

#pragma mark - AVCaptureDeviceInput swizzle

static char kSimCamFakeInputKey;
static char kSimCamFakeInputDeviceKey;

@interface AVCaptureDeviceInput (SimCam)
@end
@implementation AVCaptureDeviceInput (SimCam)
- (instancetype)simcam_initWithDevice:(AVCaptureDevice *)device error:(NSError **)err {
    if ([device isKindOfClass:[SimCamFakeDevice class]]) {
        if (err) *err = nil;
        // Bypass AVCaptureDeviceInput's hardware init via NSObject's init —
        // skips the hardware probe but leaves AVF's private ivars at zero.
        // Anything that later reads those ivars (e.g. the original -device
        // accessor) crashes, so we swizzle the relevant accessors below.
        struct objc_super sup = { self, [NSObject class] };
        id obj = ((id (*)(struct objc_super *, SEL))objc_msgSendSuper)(&sup, @selector(init));
        if (obj) {
            objc_setAssociatedObject(obj, &kSimCamFakeInputKey, @YES, OBJC_ASSOCIATION_RETAIN);
            objc_setAssociatedObject(obj, &kSimCamFakeInputDeviceKey, device, OBJC_ASSOCIATION_RETAIN);
            SimCamSetPosition(obj, device.position);
        }
        return obj;
    }
    return [self simcam_initWithDevice:device error:err];
}
- (AVCaptureDevice *)simcam_device {
    AVCaptureDevice *fake = objc_getAssociatedObject(self, &kSimCamFakeInputDeviceKey);
    if (fake) return fake;
    return [self simcam_device];
}
- (NSArray *)simcam_ports {
    if (objc_getAssociatedObject(self, &kSimCamFakeInputKey)) return @[];
    return [self simcam_ports];
}
@end

static BOOL SimCamIsFakeInput(id input) {
    if (!input) return NO;
    return [objc_getAssociatedObject(input, &kSimCamFakeInputKey) boolValue];
}

#pragma mark - AVCaptureSession swizzles

static char kSimCamSessionRunningKey;

@interface AVCaptureSession (SimCam)
@end
@implementation AVCaptureSession (SimCam)
- (void)simcam_addInput:(AVCaptureInput *)input {
    if (SimCamIsFakeInput(input)) {
        AVCaptureDevicePosition p = SimCamPositionOf(input);
        SimCamSetPosition(self, p);
        simcam_log(@"addInput: fake input (%@) — skipping native add",
            p == AVCaptureDevicePositionBack ? @"back" : @"front");
        return;
    }
    [self simcam_addInput:input];
}
- (BOOL)simcam_canAddInput:(AVCaptureInput *)input {
    if (SimCamIsFakeInput(input)) return YES;
    return [self simcam_canAddInput:input];
}
- (void)simcam_addOutput:(AVCaptureOutput *)output {
    // Always skip native add — without a real input the native session would
    // refuse outputs anyway; we drive frames from our pump.
    SimCamSetPosition(output, SimCamPositionOf(self));
    simcam_log(@"addOutput: %@ (intercepted, pos=%d)",
        NSStringFromClass([output class]), (int)SimCamPositionOf(self));
}
- (BOOL)simcam_canAddOutput:(AVCaptureOutput *)output { return YES; }
- (void)simcam_startRunning {
    objc_setAssociatedObject(self, &kSimCamSessionRunningKey, @YES, OBJC_ASSOCIATION_RETAIN);
    simcam_log(@"startRunning intercepted");
    [[SimCamRegistry shared] startPumpingIfNeeded];
    // Notify observers that session is running.
    [self willChangeValueForKey:@"running"];
    [self didChangeValueForKey:@"running"];
}
- (void)simcam_stopRunning {
    objc_setAssociatedObject(self, &kSimCamSessionRunningKey, @NO, OBJC_ASSOCIATION_RETAIN);
    simcam_log(@"stopRunning intercepted");
    // Don't stop the global pump — other sessions may be running.
}
- (BOOL)simcam_isRunning {
    NSNumber *v = objc_getAssociatedObject(self, &kSimCamSessionRunningKey);
    return v.boolValue;
}
@end

#pragma mark - AVCaptureVideoDataOutput swizzle

@interface AVCaptureVideoDataOutput (SimCam)
@end
@implementation AVCaptureVideoDataOutput (SimCam)
- (void)simcam_setSampleBufferDelegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)delegate
                                 queue:(dispatch_queue_t)queue {
    [self simcam_setSampleBufferDelegate:delegate queue:queue];
    [[SimCamRegistry shared] addOutput:self delegate:delegate queue:queue];
}
@end

#pragma mark - AVCaptureVideoPreviewLayer swizzle

@interface AVCaptureVideoPreviewLayer (SimCam)
@end
@implementation AVCaptureVideoPreviewLayer (SimCam)
- (void)simcam_setSession:(AVCaptureSession *)session {
    [self simcam_setSession:session];
    AVCaptureDevicePosition p = SimCamPositionOf(session);
    SimCamSetPosition(self, p);
    [[SimCamRegistry shared] addPreviewLayer:self];
}
@end

#pragma mark - Image loading

static void LoadSourceImage(void) {
    const char *envPath = getenv("SIMCAM_IMAGE_PATH");
    NSString *path = envPath ? [NSString stringWithUTF8String:envPath] : nil;
    if (!path.length) {
        simcam_log(@"SIMCAM_IMAGE_PATH not set — generating gradient placeholder");
        UIGraphicsImageRenderer *r = [[UIGraphicsImageRenderer alloc]
            initWithSize:CGSizeMake(kFrameWidth, kFrameHeight)];
        gSourceImage = [r imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
            CGContextRef c = ctx.CGContext;
            CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
            CGFloat colors[] = {0.10,0.45,0.95,1.0,  0.95,0.20,0.55,1.0};
            CGFloat locs[] = {0.0, 1.0};
            CGGradientRef g = CGGradientCreateWithColorComponents(cs, colors, locs, 2);
            CGContextDrawLinearGradient(c, g, CGPointZero,
                CGPointMake(kFrameWidth, kFrameHeight), 0);
            CGGradientRelease(g);
            CGColorSpaceRelease(cs);
            NSDictionary *attrs = @{
                NSFontAttributeName: [UIFont boldSystemFontOfSize:96],
                NSForegroundColorAttributeName: UIColor.whiteColor,
            };
            [@"serve-sim camera" drawAtPoint:CGPointMake(60, 60) withAttributes:attrs];
        }];
    } else {
        gSourceImage = [UIImage imageWithContentsOfFile:path];
        if (!gSourceImage) {
            simcam_log(@"failed to load image at %@", path);
            return;
        }
        simcam_log(@"loaded source image %@ (%.0fx%.0f)", path,
                   gSourceImage.size.width, gSourceImage.size.height);
    }
    if (gSourceImage.CGImage) {
        gSourceCGImage = CGImageRetain(gSourceImage.CGImage);
    }
}

#pragma mark - Install

static void InstallSwizzles(void) {
    Class dev = [AVCaptureDevice class];
    SwizzleClassMethod(dev,
        @selector(defaultDeviceWithDeviceType:mediaType:position:),
        @selector(simcam_defaultDeviceWithDeviceType:mediaType:position:));
    SwizzleClassMethod(dev,
        @selector(devicesWithMediaType:),
        @selector(simcam_devicesWithMediaType:));
    SwizzleClassMethod(dev, @selector(devices), @selector(simcam_devices));

    Class disc = [AVCaptureDeviceDiscoverySession class];
    SwizzleClassMethod(disc,
        @selector(discoverySessionWithDeviceTypes:mediaType:position:),
        @selector(simcam_discoverySessionWithDeviceTypes:mediaType:position:));

    Class input = [AVCaptureDeviceInput class];
    SwizzleInstanceMethod(input,
        @selector(initWithDevice:error:),
        @selector(simcam_initWithDevice:error:));
    SwizzleInstanceMethod(input, @selector(device), @selector(simcam_device));
    SwizzleInstanceMethod(input, @selector(ports), @selector(simcam_ports));

    Class sess = [AVCaptureSession class];
    SwizzleInstanceMethod(sess, @selector(addInput:), @selector(simcam_addInput:));
    SwizzleInstanceMethod(sess, @selector(canAddInput:), @selector(simcam_canAddInput:));
    SwizzleInstanceMethod(sess, @selector(addOutput:), @selector(simcam_addOutput:));
    SwizzleInstanceMethod(sess, @selector(canAddOutput:), @selector(simcam_canAddOutput:));
    SwizzleInstanceMethod(sess, @selector(startRunning), @selector(simcam_startRunning));
    SwizzleInstanceMethod(sess, @selector(stopRunning), @selector(simcam_stopRunning));
    SwizzleInstanceMethod(sess, @selector(isRunning), @selector(simcam_isRunning));

    Class out = [AVCaptureVideoDataOutput class];
    SwizzleInstanceMethod(out,
        @selector(setSampleBufferDelegate:queue:),
        @selector(simcam_setSampleBufferDelegate:queue:));

    Class pl = [AVCaptureVideoPreviewLayer class];
    SwizzleInstanceMethod(pl, @selector(setSession:), @selector(simcam_setSession:));
}

static void OpenShmIfRequested(void) {
    const char *shmName = getenv("SIMCAM_SHM_NAME");
    if (!shmName || !*shmName) return;
    int fd = shm_open(shmName, O_RDONLY, 0);
    if (fd < 0) {
        simcam_log(@"shm_open(%s) failed: %s", shmName, strerror(errno));
        return;
    }
    struct stat st;
    if (fstat(fd, &st) < 0 || st.st_size < (off_t)sizeof(SimCamShmHeader)) {
        simcam_log(@"shm fstat failed or too small");
        close(fd);
        return;
    }
    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);
    if (map == MAP_FAILED) {
        simcam_log(@"shm mmap failed: %s", strerror(errno));
        return;
    }
    SimCamShmHeader *hdr = (SimCamShmHeader *)map;
    if (hdr->magic != SIMCAM_SHM_MAGIC) {
        simcam_log(@"shm magic mismatch: 0x%x", hdr->magic);
        munmap(map, (size_t)st.st_size);
        return;
    }
    gShmHeader = hdr;
    gShmPixels = (const uint8_t *)map + sizeof(SimCamShmHeader);
    gShmTotalSize = (size_t)st.st_size;
    kFrameWidth = hdr->width;
    kFrameHeight = hdr->height;
    simcam_log(@"shm \"%s\" attached (%ux%u, %llu bytes)",
               shmName, hdr->width, hdr->height, (unsigned long long)st.st_size);
}

__attribute__((constructor))
static void SimCamInit(void) {
    @autoreleasepool {
        simcam_log(@"loaded into pid %d", getpid());
        OpenShmIfRequested();
        if (!gShmHeader) LoadSourceImage();
        InstallSwizzles();
        simcam_log(@"swizzles installed");
    }
}
