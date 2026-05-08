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
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>

static UIImage *gSourceImage = nil;
static CGImageRef gSourceCGImage = NULL;
static const size_t kFrameWidth = 1280;
static const size_t kFrameHeight = 720;
static const double kFrameRate = 30.0;

#pragma mark - Logging

static void simcam_log(NSString *fmt, ...) {
    va_list args; va_start(args, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
    va_end(args);
    fprintf(stderr, "[SimCam] %s\n", msg.UTF8String);
}

#pragma mark - Fake device

@interface SimCamFakeDevice : AVCaptureDevice
@end

@implementation SimCamFakeDevice
- (NSString *)uniqueID { return @"sim-cam-fake-front-0"; }
- (NSString *)modelID { return @"SimCamFakeCamera"; }
- (NSString *)localizedName { return @"Simulated Camera (serve-sim)"; }
- (NSString *)manufacturer { return @"serve-sim"; }
- (BOOL)hasMediaType:(AVMediaType)mediaType { return [mediaType isEqualToString:AVMediaTypeVideo]; }
- (BOOL)supportsAVCaptureSessionPreset:(AVCaptureSessionPreset)preset { return YES; }
- (AVCaptureDevicePosition)position { return AVCaptureDevicePositionFront; }
- (AVCaptureDeviceType)deviceType { return AVCaptureDeviceTypeBuiltInWideAngleCamera; }
- (NSArray<AVCaptureDeviceFormat *> *)formats { return @[]; }
- (BOOL)isConnected { return YES; }
- (BOOL)isSuspended { return NO; }
- (BOOL)lockForConfiguration:(NSError **)e { return YES; }
- (void)unlockForConfiguration { }
@end

static AVCaptureDevice *SimCamSharedFakeDevice(void) {
    static AVCaptureDevice *device = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        device = (AVCaptureDevice *)class_createInstance([SimCamFakeDevice class], 0);
    });
    return device;
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
    simcam_log(@"registered video data output delegate %@", delegate);
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
    dispatch_async(dispatch_get_main_queue(), ^{
        if (gSourceCGImage) {
            layer.contents = (__bridge id)gSourceCGImage;
            layer.contentsGravity = kCAGravityResizeAspectFill;
        }
    });
    simcam_log(@"hooked preview layer %p", layer);
}

- (CMSampleBufferRef)newSampleBufferAtTime:(CMTime)pts CF_RETURNS_RETAINED {
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
    // aspect fill
    size_t iw = CGImageGetWidth(gSourceCGImage), ih = CGImageGetHeight(gSourceCGImage);
    double sx = (double)kFrameWidth / iw, sy = (double)kFrameHeight / ih;
    double s = MAX(sx, sy);
    double dw = iw * s, dh = ih * s;
    CGRect dst = CGRectMake((kFrameWidth - dw)/2.0, (kFrameHeight - dh)/2.0, dw, dh);
    CGContextDrawImage(ctx, dst, gSourceCGImage);
    CGContextRelease(ctx);
    CGColorSpaceRelease(cs);
    CVPixelBufferUnlockBaseAddress(pb, 0);

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
        simcam_log(@"defaultDeviceWithDeviceType: %@ → fake", t);
        return SimCamSharedFakeDevice();
    }
    return [self simcam_defaultDeviceWithDeviceType:t mediaType:m position:p];
}
+ (NSArray<AVCaptureDevice *> *)simcam_devicesWithMediaType:(AVMediaType)m {
    if ([m isEqualToString:AVMediaTypeVideo]) {
        return @[SimCamSharedFakeDevice()];
    }
    return [self simcam_devicesWithMediaType:m];
}
+ (NSArray<AVCaptureDevice *> *)simcam_devices {
    NSArray *real = [self simcam_devices];
    return [@[SimCamSharedFakeDevice()] arrayByAddingObjectsFromArray:real ?: @[]];
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
        // Replace devices via runtime — set ivar through KVC if possible.
        @try {
            [real setValue:@[SimCamSharedFakeDevice()] forKey:@"devices"];
        } @catch (__unused id e) {
            simcam_log(@"could not override discovery session devices");
        }
    }
    return real;
}
@end

#pragma mark - AVCaptureDeviceInput swizzle

static char kSimCamFakeInputKey;

@interface AVCaptureDeviceInput (SimCam)
@end
@implementation AVCaptureDeviceInput (SimCam)
- (instancetype)simcam_initWithDevice:(AVCaptureDevice *)device error:(NSError **)err {
    if ([device isKindOfClass:[SimCamFakeDevice class]]) {
        if (err) *err = nil;
        // Bypass AVCaptureDeviceInput's hardware init via NSObject's init.
        struct objc_super sup = { self, [NSObject class] };
        id obj = ((id (*)(struct objc_super *, SEL))objc_msgSendSuper)(&sup, @selector(init));
        if (obj) objc_setAssociatedObject(obj, &kSimCamFakeInputKey, @YES, OBJC_ASSOCIATION_RETAIN);
        return obj;
    }
    return [self simcam_initWithDevice:device error:err];
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
        simcam_log(@"addInput: fake input — skipping native add");
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
    simcam_log(@"addOutput: %@ (intercepted)", NSStringFromClass([output class]));
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

__attribute__((constructor))
static void SimCamInit(void) {
    @autoreleasepool {
        simcam_log(@"loaded into pid %d", getpid());
        LoadSourceImage();
        InstallSwizzles();
        simcam_log(@"swizzles installed");
    }
}
