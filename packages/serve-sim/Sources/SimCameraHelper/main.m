// SimCameraHelper — host-side webcam capture daemon for serve-sim.
//
// Captures frames from a macOS AVCaptureDevice, scales/packs to BGRA, and
// publishes them through a POSIX shared-memory region that SimCameraInjector
// maps inside the simulator app process.
//
// Usage:
//   serve-sim-camera-helper --shm <name> [--device <unique-id|name>]
//                           [--width 1280] [--height 720]
//   serve-sim-camera-helper --list
//
// Lifetime: runs in the foreground until SIGINT/SIGTERM. The CLI verb
// detaches it via posix_spawn / nohup-style redirection.

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Accelerate/Accelerate.h>

#include <fcntl.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdatomic.h>
#include <mach/mach_time.h>
#include "../SimCameraInjector/include/SimCamShared.h"

static SimCamShmHeader *gHeader = NULL;
static uint8_t *gPixels = NULL;
static uint32_t gWidth = SIMCAM_DEFAULT_WIDTH;
static uint32_t gHeight = SIMCAM_DEFAULT_HEIGHT;
static const char *gShmName = NULL;
static volatile sig_atomic_t gShouldExit = 0;

static uint64_t MachAbsToNs(uint64_t t) {
    static mach_timebase_info_data_t tb = {0,0};
    if (tb.denom == 0) mach_timebase_info(&tb);
    return t * tb.numer / tb.denom;
}

static void HandleSig(int sig) { (void)sig; gShouldExit = 1; }

static int OpenShm(const char *name, size_t size) {
    shm_unlink(name); // start fresh; ignore error if not present
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

@interface SimCamWriter : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property (atomic) uint64_t frameCount;
@end

@implementation SimCamWriter
- (void)captureOutput:(AVCaptureOutput *)out
didOutputSampleBuffer:(CMSampleBufferRef)sb
       fromConnection:(AVCaptureConnection *)conn {
    CVImageBufferRef pb = CMSampleBufferGetImageBuffer(sb);
    if (!pb || !gHeader) return;

    CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    size_t srcW = CVPixelBufferGetWidth(pb);
    size_t srcH = CVPixelBufferGetHeight(pb);
    size_t srcStride = CVPixelBufferGetBytesPerRow(pb);
    void *src = CVPixelBufferGetBaseAddress(pb);
    OSType srcFmt = CVPixelBufferGetPixelFormatType(pb);

    if (srcFmt != kCVPixelFormatType_32BGRA) {
        CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
        return; // configured AVCaptureVideoDataOutput requests BGRA already
    }

    vImage_Buffer srcBuf = {
        .data = src, .width = srcW, .height = srcH, .rowBytes = srcStride
    };
    vImage_Buffer dstBuf = {
        .data = gPixels, .width = gWidth, .height = gHeight,
        .rowBytes = gHeader->bytesPerRow,
    };
    vImage_Error verr = vImageScale_ARGB8888(&srcBuf, &dstBuf, NULL, kvImageHighQualityResampling);
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    if (verr != kvImageNoError) return;

    // Mirror horizontally so a front-facing camera matches what the user expects
    // when the simulator is rendering the feed (mirror is conventional for FaceTime
    // on macOS — toggle behind a flag if needed).
    // Skip for v0: keeps code simple. Add --mirror later.

    gHeader->timestampNs = MachAbsToNs(mach_absolute_time());
    atomic_thread_fence(memory_order_release);
    gHeader->frameSeq = ++self.frameCount;
}
@end

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

static AVCaptureDevice *PickDevice(NSString *idOrName) {
    AVCaptureDeviceDiscoverySession *s = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:@[
            AVCaptureDeviceTypeBuiltInWideAngleCamera,
            AVCaptureDeviceTypeExternal,
            AVCaptureDeviceTypeContinuityCamera,
        ]
        mediaType:AVMediaTypeVideo
        position:AVCaptureDevicePositionUnspecified];
    if (!idOrName.length) {
        // Default: a built-in front camera if present, else first available.
        for (AVCaptureDevice *d in s.devices) {
            if (d.position == AVCaptureDevicePositionFront) return d;
        }
        return s.devices.firstObject;
    }
    for (AVCaptureDevice *d in s.devices) {
        if ([d.uniqueID isEqualToString:idOrName]) return d;
    }
    for (AVCaptureDevice *d in s.devices) {
        if ([d.localizedName.lowercaseString containsString:idOrName.lowercaseString]) return d;
    }
    return nil;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *deviceArg = nil;
        BOOL list = NO;
        for (int i = 1; i < argc; i++) {
            const char *a = argv[i];
            if (!strcmp(a, "--shm") && i+1 < argc) gShmName = argv[++i];
            else if (!strcmp(a, "--device") && i+1 < argc) deviceArg = @(argv[++i]);
            else if (!strcmp(a, "--width") && i+1 < argc) gWidth = (uint32_t)atoi(argv[++i]);
            else if (!strcmp(a, "--height") && i+1 < argc) gHeight = (uint32_t)atoi(argv[++i]);
            else if (!strcmp(a, "--list")) list = YES;
            else if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
                printf("Usage: %s --shm <name> [--device <id|name>] [--width N --height N]\n"
                       "       %s --list\n", argv[0], argv[0]);
                return 0;
            }
        }
        if (list) { ListDevices(); return 0; }
        if (!gShmName) {
            fprintf(stderr, "error: --shm <name> required\n");
            return 64;
        }

        AVCaptureDevice *device = PickDevice(deviceArg);
        if (!device) {
            fprintf(stderr, "error: no matching camera device (try --list)\n");
            return 1;
        }
        fprintf(stderr, "[serve-sim-camera] using device %s (%s)\n",
                device.localizedName.UTF8String, device.uniqueID.UTF8String);

        size_t shmSize = (size_t)SimCamShmSizeFor(gWidth, gHeight);
        if (OpenShm(gShmName, shmSize) < 0) return 1;
        fprintf(stderr, "[serve-sim-camera] shm \"%s\" %zu bytes (%ux%u BGRA)\n",
                gShmName, shmSize, gWidth, gHeight);

        signal(SIGINT, HandleSig);
        signal(SIGTERM, HandleSig);

        NSError *err = nil;
        AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&err];
        if (!input) {
            fprintf(stderr, "error: %s\n", err.localizedDescription.UTF8String);
            return 1;
        }
        AVCaptureSession *session = [AVCaptureSession new];
        session.sessionPreset = AVCaptureSessionPreset1280x720;
        if (![session canAddInput:input]) {
            fprintf(stderr, "error: cannot add device input to session\n");
            return 1;
        }
        [session addInput:input];

        SimCamWriter *writer = [SimCamWriter new];
        AVCaptureVideoDataOutput *out = [AVCaptureVideoDataOutput new];
        out.alwaysDiscardsLateVideoFrames = YES;
        out.videoSettings = @{
            (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        };
        dispatch_queue_t q = dispatch_queue_create("serve-sim.camera.helper", DISPATCH_QUEUE_SERIAL);
        [out setSampleBufferDelegate:writer queue:q];
        if (![session canAddOutput:out]) {
            fprintf(stderr, "error: cannot add data output\n");
            return 1;
        }
        [session addOutput:out];
        [session startRunning];
        fprintf(stderr, "[serve-sim-camera] capturing — Ctrl+C to stop\n");

        while (!gShouldExit) {
            [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
        }
        [session stopRunning];
        if (gShmName) shm_unlink(gShmName);
        fprintf(stderr, "[serve-sim-camera] stopped (frames=%llu)\n", writer.frameCount);
        return 0;
    }
}
