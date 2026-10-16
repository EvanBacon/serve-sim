#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

static NSString *const kResultFileName = @"simcam-connection-result.json";

static void WriteResult(BOOL passed, NSString *message) {
    NSURL *documents = [[[NSFileManager defaultManager]
        URLsForDirectory:NSDocumentDirectory
               inDomains:NSUserDomainMask] firstObject];
    NSURL *resultURL = [documents URLByAppendingPathComponent:kResultFileName];
    NSDictionary *result = @{ @"passed": @(passed), @"message": message ?: @"" };
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    [data writeToURL:resultURL atomically:YES];
    exit(passed ? EXIT_SUCCESS : EXIT_FAILURE);
}

// Weak handles to the objects released by the teardown exercise. The test only
// proves the fake-connection dealloc path is safe once every one of these has
// actually deallocated, so the completion step polls them instead of assuming
// a fixed delay is long enough.
@interface SimCameraTeardownProbe : NSObject
@property(nonatomic, weak) AVCaptureMetadataOutput *metadataOutput;
@property(nonatomic, weak) AVCaptureVideoDataOutput *videoOutput;
@property(nonatomic, weak) AVCaptureDeviceInput *input;
@property(nonatomic, weak) AVCaptureSession *session;
@end

@implementation SimCameraTeardownProbe
- (NSArray<NSString *> *)liveObjectNames {
    NSMutableArray<NSString *> *live = [NSMutableArray new];
    if (self.metadataOutput) [live addObject:@"AVCaptureMetadataOutput"];
    if (self.videoOutput) [live addObject:@"AVCaptureVideoDataOutput"];
    if (self.input) [live addObject:@"AVCaptureDeviceInput"];
    if (self.session) [live addObject:@"AVCaptureSession"];
    return live;
}
@end

static BOOL ExerciseAutomaticOutputTeardown(
    id<AVCaptureVideoDataOutputSampleBufferDelegate,
       AVCaptureMetadataOutputObjectsDelegate> delegate,
    SimCameraTeardownProbe *probe,
    NSString **message) {
    @autoreleasepool {
        AVCaptureDevice *device = [AVCaptureDevice
            defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                              mediaType:AVMediaTypeVideo
                               position:AVCaptureDevicePositionBack];
        NSError *inputError = nil;
        AVCaptureDeviceInput *input = [AVCaptureDeviceInput
            deviceInputWithDevice:device
                            error:&inputError];
        if (!input || inputError) {
            *message = [NSString stringWithFormat:
                @"Could not create fake input for teardown: %@", inputError];
            return NO;
        }

        AVCaptureSession *session = [AVCaptureSession new];
        AVCaptureMetadataOutput *metadataOutput = [AVCaptureMetadataOutput new];
        AVCaptureVideoDataOutput *videoOutput = [AVCaptureVideoDataOutput new];
        probe.metadataOutput = metadataOutput;
        probe.videoOutput = videoOutput;
        probe.input = input;
        probe.session = session;
        [metadataOutput setMetadataObjectsDelegate:delegate queue:dispatch_get_main_queue()];
        [videoOutput setSampleBufferDelegate:delegate queue:dispatch_get_main_queue()];

        [session beginConfiguration];
        [session addInput:input];
        [session addOutput:metadataOutput];
        [session addOutput:videoOutput];
        [session commitConfiguration];

        if (metadataOutput.connections.count != 1 || videoOutput.connections.count != 1) {
            *message = @"Automatic outputs did not each expose one connection";
            return NO;
        }

        [session startRunning];
        [session stopRunning];

        [metadataOutput setMetadataObjectsDelegate:nil queue:dispatch_get_main_queue()];
        [videoOutput setSampleBufferDelegate:nil queue:dispatch_get_main_queue()];

        [session beginConfiguration];
        [session removeOutput:videoOutput];
        [session removeOutput:metadataOutput];
        [session removeInput:input];
        [session commitConfiguration];

        // Releasing each output releases the fake connection associated with
        // it; releasing the input likewise releases its fake port. Queued
        // frame work may still hold temporary retains, so the caller polls the
        // probe's weak references until every object has deallocated.
        metadataOutput = nil;
        videoOutput = nil;
        input = nil;
        session = nil;
    }
    return YES;
}

// Polls until every object tracked by the probe has deallocated, then reports
// the result. Fails if any of them is still alive at the deadline, so the test
// cannot pass without having exercised the dealloc path it guards.
static void WaitForTeardownAndReport(SimCameraTeardownProbe *probe, NSDate *deadline) {
    NSArray<NSString *> *live = [probe liveObjectNames];
    if (live.count == 0) {
        WriteResult(YES, @"Automatic metadata and video outputs deallocated safely");
        return;
    }
    if ([deadline timeIntervalSinceNow] <= 0) {
        WriteResult(NO, [NSString stringWithFormat:
            @"Objects still alive after teardown, dealloc path was not exercised: %@",
            [live componentsJoinedByString:@", "]]);
        return;
    }
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
            WaitForTeardownAndReport(probe, deadline);
        });
}

@interface SimCameraConnectionTestDelegate : UIResponder <
    UIApplicationDelegate,
    AVCaptureVideoDataOutputSampleBufferDelegate,
    AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SimCameraConnectionTestDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    (void)application;
    (void)launchOptions;
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [UIViewController new];
    [self.window makeKeyAndVisible];

    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *mode = NSProcessInfo.processInfo.environment[@"SIMCAM_CONNECTION_TEST_MODE"];
        if ([mode isEqualToString:@"teardown"]) {
            SimCameraTeardownProbe *probe = [SimCameraTeardownProbe new];
            NSString *message = nil;
            BOOL passed = NO;
            @try {
                passed = ExerciseAutomaticOutputTeardown(self, probe, &message);
            } @catch (NSException *exception) {
                message = [NSString stringWithFormat:@"Exception: %@", exception.reason];
            }
            if (!passed) {
                WriteResult(NO, message);
                return;
            }
            WaitForTeardownAndReport(probe, [NSDate dateWithTimeIntervalSinceNow:5.0]);
            return;
        }

        @try {
            AVCaptureDevice *device = [AVCaptureDevice
                defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                  mediaType:AVMediaTypeVideo
                                   position:AVCaptureDevicePositionBack];
            NSError *inputError = nil;
            AVCaptureDeviceInput *input = [AVCaptureDeviceInput
                deviceInputWithDevice:device
                                error:&inputError];
            if (!input || inputError) {
                WriteResult(NO, [NSString stringWithFormat:@"Could not create fake input: %@", inputError]);
                return;
            }

            AVCaptureSession *session = [AVCaptureSession new];
            AVCapturePhotoOutput *output = [AVCapturePhotoOutput new];
            [session addInputWithNoConnections:input];
            [session addOutputWithNoConnections:output];

            if (session.connections.count != 0 || output.connections.count != 0) {
                WriteResult(NO, @"addOutputWithNoConnections exposed a connection before addConnection");
                return;
            }

            AVCaptureConnection *connection = [[AVCaptureConnection alloc]
                initWithInputPorts:input.ports
                            output:output];
            if (!connection || ![session canAddConnection:connection]) {
                WriteResult(NO, @"Could not create or add an explicit fake-input connection");
                return;
            }

            AVCaptureDevice *foreignDevice = [AVCaptureDevice
                defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                  mediaType:AVMediaTypeVideo
                                   position:AVCaptureDevicePositionFront];
            AVCaptureDeviceInput *foreignInput = [AVCaptureDeviceInput
                deviceInputWithDevice:foreignDevice
                                error:nil];
            AVCaptureSession *foreignSession = [AVCaptureSession new];
            [foreignSession addInputWithNoConnections:foreignInput];
            if ([foreignSession canAddConnection:connection]) {
                WriteResult(NO, @"A foreign session accepted another session's connection endpoints");
                return;
            }
            [foreignSession addConnection:connection];
            if (foreignSession.connections.count != 0) {
                WriteResult(NO, @"A foreign session recorded another session's connection");
                return;
            }

            [session addConnection:connection];

            if (![session.connections containsObject:connection] ||
                ![output.connections containsObject:connection] ||
                [output connectionWithMediaType:AVMediaTypeVideo] != connection) {
                WriteResult(NO, @"The explicit connection was not exposed by the session and output");
                return;
            }

            [session removeConnection:connection];
            if (session.connections.count != 0 || output.connections.count != 0) {
                WriteResult(NO, @"removeConnection left the explicit connection exposed");
                return;
            }

            WriteResult(YES, @"No connection before addConnection; exact connection exposed after addConnection");
        } @catch (NSException *exception) {
            WriteResult(NO, [NSString stringWithFormat:@"Exception: %@", exception.reason]);
        }
    });
    return YES;
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(
            argc,
            argv,
            nil,
            NSStringFromClass([SimCameraConnectionTestDelegate class]));
    }
}
