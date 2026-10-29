#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#include <signal.h>
#include <sys/resource.h>

static NSString *const kResultFileName = @"simcam-connection-result.json";

static void WriteResult(BOOL passed, NSString *message) {
    // The writer-failure check caps file writes; the result must still land.
    struct rlimit unlimited = { RLIM_INFINITY, RLIM_INFINITY };
    setrlimit(RLIMIT_FSIZE, &unlimited);
    NSURL *documents = [[[NSFileManager defaultManager]
        URLsForDirectory:NSDocumentDirectory
               inDomains:NSUserDomainMask] firstObject];
    NSURL *resultURL = [documents URLByAppendingPathComponent:kResultFileName];
    NSDictionary *result = @{ @"passed": @(passed), @"message": message ?: @"" };
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    [data writeToURL:resultURL atomically:YES];
    exit(passed ? EXIT_SUCCESS : EXIT_FAILURE);
}

static AVCaptureDeviceInput *FakeCameraInput(AVCaptureDevicePosition position) {
    AVCaptureDevice *device = [AVCaptureDevice
        defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                          mediaType:AVMediaTypeVideo
                           position:position];
    return [AVCaptureDeviceInput deviceInputWithDevice:device error:nil];
}

// The simulator's microphone is the host's default input, so a Mac without
// one (a CI runner) has none and the microphone half of a check is skipped.
static AVCaptureDeviceInput *MicrophoneInput(void) {
    AVCaptureDevice *microphone = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
    if (!microphone) return nil;
    return [AVCaptureDeviceInput deviceInputWithDevice:microphone error:nil];
}

static NSURL *RecordingURL(NSString *name) {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:name];
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    return [NSURL fileURLWithPath:path];
}

static NSString *MicrophoneNote(AVCaptureDeviceInput *microphone) {
    return microphone ? @"with a microphone input" : @"(no microphone on this host)";
}

#pragma mark - Explicit connection graph

static void RunExplicitConnectionCheck(void) {
    AVCaptureDeviceInput *input = FakeCameraInput(AVCaptureDevicePositionBack);
    if (!input) {
        WriteResult(NO, @"Could not create fake input");
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

    AVCaptureDeviceInput *foreignInput = FakeCameraInput(AVCaptureDevicePositionFront);
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
}

#pragma mark - Teardown

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

static void RunTeardownCheck(id<AVCaptureVideoDataOutputSampleBufferDelegate,
                                AVCaptureMetadataOutputObjectsDelegate> delegate) {
    SimCameraTeardownProbe *probe = [SimCameraTeardownProbe new];
    NSString *message = nil;
    if (!ExerciseAutomaticOutputTeardown(delegate, probe, &message)) {
        WriteResult(NO, message);
        return;
    }
    WaitForTeardownAndReport(probe, [NSDate dateWithTimeIntervalSinceNow:5.0]);
}

#pragma mark - Movie recording

@interface SimCamRecordingProbe : NSObject <AVCaptureFileOutputRecordingDelegate>
@property(nonatomic, copy) void (^onStart)(void);
@property(nonatomic, copy) void (^onFinish)(NSURL *url, NSError *error);
@end

@implementation SimCamRecordingProbe
- (void)captureOutput:(AVCaptureFileOutput *)output
    didStartRecordingToOutputFileAtURL:(NSURL *)fileURL
                       fromConnections:(NSArray<AVCaptureConnection *> *)connections {
    (void)output; (void)fileURL; (void)connections;
    dispatch_async(dispatch_get_main_queue(), ^{ if (self.onStart) self.onStart(); });
}
- (void)captureOutput:(AVCaptureFileOutput *)output
    didFinishRecordingToOutputFileAtURL:(NSURL *)outputFileURL
                        fromConnections:(NSArray<AVCaptureConnection *> *)connections
                                  error:(NSError *)error {
    (void)output; (void)connections;
    dispatch_async(dispatch_get_main_queue(), ^{ if (self.onFinish) self.onFinish(outputFileURL, error); });
}
@end

static SimCamRecordingProbe *gProbe = nil;

// Seconds of video in the movie at `url`, or a negative number naming why
// there is none.
static void ReadVideoSeconds(NSURL *url, void (^done)(double seconds, NSString *problem)) {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
    [asset loadTracksWithMediaType:AVMediaTypeVideo
                 completionHandler:^(NSArray<AVAssetTrack *> *tracks, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (error || tracks.count == 0) {
                done(0, [NSString stringWithFormat:@"no video track in %@ (%@)",
                    url.lastPathComponent, error.localizedDescription ?: @"none"]);
                return;
            }
            double seconds = CMTimeGetSeconds(tracks.firstObject.timeRange.duration);
            done(seconds, nil);
        });
    }];
}

static void ExpectRecordedMovie(NSURL *url, NSError *error, BOOL expectMaxDuration,
                                double minSeconds, double maxSeconds, NSString *what) {
    if (expectMaxDuration) {
        BOOL finished = [error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] boolValue];
        if (error.code != AVErrorMaximumDurationReached || !finished) {
            WriteResult(NO, [NSString stringWithFormat:@"%@: expected a successful max-duration stop, got %@", what, error]);
            return;
        }
    } else if (error) {
        WriteResult(NO, [NSString stringWithFormat:@"%@: recording failed: %@", what, error]);
        return;
    }
    ReadVideoSeconds(url, ^(double seconds, NSString *problem) {
        if (problem) {
            WriteResult(NO, [NSString stringWithFormat:@"%@: %@", what, problem]);
            return;
        }
        if (seconds < minSeconds || seconds > maxSeconds) {
            WriteResult(NO, [NSString stringWithFormat:@"%@: movie holds %.2f s, expected %.2f-%.2f s", what, seconds, minSeconds, maxSeconds]);
            return;
        }
        WriteResult(YES, [NSString stringWithFormat:@"%@: recorded %.2f s of video", what, seconds]);
    });
}

// expo-camera's graph: automatic connections, a photo and a movie output,
// the microphone added with addInput: inside one configuration, and a
// preview layer it detaches when the camera view goes away.
static void RunAutomaticConnectionsRecording(void) {
    // expo-camera refuses to record on a simulator without a default camera.
    if (![AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo]) {
        WriteResult(NO, @"defaultDeviceWithMediaType: found no camera");
        return;
    }
    AVCaptureDeviceInput *camera = FakeCameraInput(AVCaptureDevicePositionFront);
    AVCaptureDeviceInput *microphone = MicrophoneInput();
    AVCaptureSession *session = [AVCaptureSession new];
    AVCapturePhotoOutput *photo = [AVCapturePhotoOutput new];
    AVCaptureMovieFileOutput *movie = [AVCaptureMovieFileOutput new];

    [session beginConfiguration];
    [session addInput:camera];
    [session addOutput:photo];
    if ([session canAddOutput:movie]) [session addOutput:movie];
    if (microphone && [session canAddInput:microphone]) [session addInput:microphone];
    [session commitConfiguration];

    if (microphone && ![session.inputs containsObject:microphone]) {
        WriteResult(NO, @"The session does not list the microphone it added");
        return;
    }
    AVCaptureConnection *video = [movie connectionWithMediaType:AVMediaTypeVideo];
    if (!video) {
        WriteResult(NO, @"The movie output has no video connection");
        return;
    }
    video.videoOrientation = AVCaptureVideoOrientationPortrait;
    AVCaptureVideoPreviewLayer *preview = [AVCaptureVideoPreviewLayer layerWithSession:session];
    [session startRunning];

    NSString *what = [NSString stringWithFormat:@"Automatic connections %@", MicrophoneNote(microphone)];
    gProbe = [SimCamRecordingProbe new];
    gProbe.onStart = ^{
        if (!movie.isRecording) {
            WriteResult(NO, @"isRecording is NO after the recording started");
            return;
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{ [movie stopRecording]; });
    };
    gProbe.onFinish = ^(NSURL *url, NSError *error) {
        [session stopRunning];
        preview.session = nil;
        ExpectRecordedMovie(url, error, NO, 0.8, 1.4, what);
    };
    [movie startRecordingToOutputFileURL:RecordingURL(@"automatic.mov") recordingDelegate:gProbe];
}

// VisionCamera 5's graph: inputs and outputs without connections, explicit
// video, preview and audio connections, then device and connection
// configuration before the session runs.
static void RunManualConnectionsRecording(void) {
    AVCaptureDeviceInput *camera = FakeCameraInput(AVCaptureDevicePositionBack);
    AVCaptureDeviceInput *microphone = MicrophoneInput();
    AVCaptureSession *session = [AVCaptureSession new];
    AVCaptureMovieFileOutput *movie = [AVCaptureMovieFileOutput new];
    AVCaptureVideoPreviewLayer *preview = [AVCaptureVideoPreviewLayer new];

    [session beginConfiguration];
    [session addInputWithNoConnections:camera];
    if (microphone) [session addInputWithNoConnections:microphone];
    [session addOutputWithNoConnections:movie];
    [preview setSessionWithNoConnection:session];

    NSMutableArray<AVCaptureInputPort *> *videoPorts = [NSMutableArray new];
    for (AVCaptureInputPort *port in camera.ports) {
        if ([port.mediaType isEqualToString:AVMediaTypeVideo]) [videoPorts addObject:port];
    }
    if (videoPorts.count == 0) {
        WriteResult(NO, @"The fake input has no video port");
        return;
    }
    AVCaptureConnection *video = [[AVCaptureConnection alloc] initWithInputPorts:videoPorts output:movie];
    if (![session canAddConnection:video]) {
        WriteResult(NO, @"canAddConnection refused the video connection");
        return;
    }
    [session addConnection:video];
    AVCaptureConnection *previewConnection = [[AVCaptureConnection alloc]
        initWithInputPort:videoPorts.firstObject
        videoPreviewLayer:preview];
    if (![session canAddConnection:previewConnection]) {
        WriteResult(NO, @"canAddConnection refused the preview connection");
        return;
    }
    [session addConnection:previewConnection];
    if (microphone) {
        AVCaptureInputPort *audioPort = nil;
        for (AVCaptureInputPort *port in microphone.ports) {
            if ([port.mediaType isEqualToString:AVMediaTypeAudio]) audioPort = port;
        }
        AVCaptureConnection *audio = audioPort
            ? [[AVCaptureConnection alloc] initWithInputPorts:@[audioPort] output:movie]
            : nil;
        if (!audio || ![session canAddConnection:audio]) {
            WriteResult(NO, @"canAddConnection refused the audio connection");
            return;
        }
        [session addConnection:audio];
        if ([movie connectionWithMediaType:AVMediaTypeAudio] != audio) {
            WriteResult(NO, @"connectionWithMediaType: did not return the audio connection");
            return;
        }
    }

    AVCaptureDevice *device = camera.device;
    NSError *lockError = nil;
    if (![device lockForConfiguration:&lockError]) {
        WriteResult(NO, [NSString stringWithFormat:@"lockForConfiguration failed: %@", lockError]);
        return;
    }
    device.activeFormat = device.formats.firstObject;
    device.activeVideoMaxFrameDuration = CMTimeMake(1, 30);
    device.activeVideoMinFrameDuration = CMTimeMake(1, 30);
    device.activeColorSpace = AVCaptureColorSpace_sRGB;
    if (device.activeFormat.isVideoHDRSupported) {
        device.automaticallyAdjustsVideoHDREnabled = NO;
        device.videoHDREnabled = NO;
    }
    [device unlockForConfiguration];

    for (AVCaptureConnection *connection in session.connections) {
        if (connection.videoPreviewLayer || !connection.isVideoStabilizationSupported) continue;
        connection.preferredVideoStabilizationMode = AVCaptureVideoStabilizationModeStandard;
    }
    if (video.isVideoOrientationSupported) video.videoOrientation = AVCaptureVideoOrientationPortrait;
    video.automaticallyAdjustsVideoMirroring = NO;
    if (video.isVideoMirroringSupported) video.videoMirrored = NO;

    if (![movie.availableVideoCodecTypes containsObject:AVVideoCodecTypeH264]) {
        WriteResult(NO, @"The movie output offers no H.264 codec");
        return;
    }
    if (![[movie supportedOutputSettingsKeysForConnection:video] containsObject:AVVideoCompressionPropertiesKey]) {
        WriteResult(NO, @"The movie output cannot take a bit rate");
        return;
    }
    NSDictionary *settings = @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoCompressionPropertiesKey: @{ AVVideoAverageBitRateKey: @2000000 },
    };
    [movie setOutputSettings:settings forConnection:video];
    if (![[movie outputSettingsForConnection:video][AVVideoCodecKey] isEqual:AVVideoCodecTypeH264]) {
        WriteResult(NO, @"The movie output did not keep its H.264 setting");
        return;
    }
    [session commitConfiguration];
    [session startRunning];

    NSString *what = [NSString stringWithFormat:@"Manual connections %@", MicrophoneNote(microphone)];
    gProbe = [SimCamRecordingProbe new];
    // Recording 0.5 s, paused 0.5 s (iOS 18 and later), recording 0.5 s:
    // the movie holds about 1 s, so the pause is left out of it.
    gProbe.onStart = ^{
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            if (movie.recordedDuration.value <= 0) {
                WriteResult(NO, @"recordedDuration did not advance");
                return;
            }
            if (@available(iOS 18.0, *)) {
                [movie pauseRecording];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                               dispatch_get_main_queue(), ^{
                    if (!movie.isRecordingPaused) {
                        WriteResult(NO, @"isRecordingPaused is NO after pauseRecording");
                        return;
                    }
                    [movie resumeRecording];
                });
            }
        });
        NSTimeInterval stopAfter = 1.0;
        if (@available(iOS 18.0, *)) stopAfter = 1.5;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(stopAfter * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{ [movie stopRecording]; });
    };
    gProbe.onFinish = ^(NSURL *url, NSError *error) {
        [session stopRunning];
        ExpectRecordedMovie(url, error, NO, 0.8, 1.3, what);
    };
    [movie startRecordingToOutputFileURL:RecordingURL(@"manual.mp4") recordingDelegate:gProbe];
}

static void RunMaxDurationRecording(void) {
    AVCaptureSession *session = [AVCaptureSession new];
    AVCaptureMovieFileOutput *movie = [AVCaptureMovieFileOutput new];
    [session addInput:FakeCameraInput(AVCaptureDevicePositionBack)];
    [session addOutput:movie];
    movie.maxRecordedDuration = CMTimeMakeWithSeconds(0.5, 600);
    [session startRunning];

    gProbe = [SimCamRecordingProbe new];
    gProbe.onFinish = ^(NSURL *url, NSError *error) {
        [session stopRunning];
        ExpectRecordedMovie(url, error, YES, 0.45, 0.51, @"Max duration");
    };
    [movie startRecordingToOutputFileURL:RecordingURL(@"max-duration.mov") recordingDelegate:gProbe];
}

// AVFoundation refuses to record over an existing file: the recording never
// starts, and the delegate hears AVErrorFileAlreadyExists.
static void RunExistingFileRecording(void) {
    AVCaptureSession *session = [AVCaptureSession new];
    AVCaptureMovieFileOutput *movie = [AVCaptureMovieFileOutput new];
    [session addInput:FakeCameraInput(AVCaptureDevicePositionBack)];
    [session addOutput:movie];
    [session startRunning];

    NSURL *url = RecordingURL(@"existing.mov");
    NSData *existing = [@"keep me" dataUsingEncoding:NSUTF8StringEncoding];
    [existing writeToURL:url atomically:YES];

    gProbe = [SimCamRecordingProbe new];
    gProbe.onStart = ^{
        WriteResult(NO, @"The recording started over an existing file");
    };
    gProbe.onFinish = ^(NSURL *finishedURL, NSError *error) {
        (void)finishedURL;
        [session stopRunning];
        BOOL failed = [error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] isEqual:@NO];
        if (error.code != AVErrorFileAlreadyExists || !failed) {
            WriteResult(NO, [NSString stringWithFormat:@"Expected AVErrorFileAlreadyExists, got %@", error]);
            return;
        }
        if (![[NSData dataWithContentsOfURL:url] isEqualToData:existing]) {
            WriteResult(NO, @"The existing file was replaced");
            return;
        }
        if (movie.isRecording) {
            WriteResult(NO, @"isRecording is YES after the recording failed");
            return;
        }
        WriteResult(YES, @"Recording over an existing file failed with AVErrorFileAlreadyExists and kept the file");
    };
    [movie startRecordingToOutputFileURL:url recordingDelegate:gProbe];
}

// A write that fails mid-recording (here, a file-size cap) ends the
// recording with the writer's error, unsuccessfully, without a stop call.
static void RunWriterFailureRecording(void) {
    AVCaptureSession *session = [AVCaptureSession new];
    AVCaptureMovieFileOutput *movie = [AVCaptureMovieFileOutput new];
    [session addInput:FakeCameraInput(AVCaptureDevicePositionBack)];
    [session addOutput:movie];
    [session startRunning];

    __block BOOL capped = NO;
    gProbe = [SimCamRecordingProbe new];
    gProbe.onStart = ^{
        signal(SIGXFSZ, SIG_IGN);
        struct rlimit limit = { 1, RLIM_INFINITY };
        if (setrlimit(RLIMIT_FSIZE, &limit) != 0) {
            WriteResult(NO, @"Could not cap file writes");
            return;
        }
        capped = YES;
        // AVAssetWriter writes real-time media in chunks well under a
        // second apart, so its first capped write fails long before this.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            WriteResult(NO, [NSString stringWithFormat:
                @"Still recording 5 s after writes began failing (isRecording=%d)", movie.isRecording]);
        });
    };
    gProbe.onFinish = ^(NSURL *url, NSError *error) {
        (void)url;
        [session stopRunning];
        if (!capped) {
            WriteResult(NO, [NSString stringWithFormat:@"The recording ended before writes were capped: %@", error]);
            return;
        }
        BOOL failed = [error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] isEqual:@NO];
        if (!error || !failed) {
            WriteResult(NO, [NSString stringWithFormat:@"Expected an unsuccessful finish, got %@", error]);
            return;
        }
        if (movie.isRecording) {
            WriteResult(NO, @"isRecording is YES after the writer failed");
            return;
        }
        WriteResult(YES, [NSString stringWithFormat:@"The writer's failure ended the recording: %@", error.localizedDescription]);
    };
    [movie startRecordingToOutputFileURL:RecordingURL(@"writer-failure.mov") recordingDelegate:gProbe];
}

#pragma mark - App

// iOS 27 stops an app that has not adopted the scene lifecycle, so the
// window comes from a scene delegate the Info.plist names.
@interface SimCameraConnectionSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SimCameraConnectionSceneDelegate
- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
    (void)session;
    (void)connectionOptions;
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    self.window.rootViewController = [UIViewController new];
    [self.window makeKeyAndVisible];
}
@end

@interface SimCameraConnectionTestDelegate : UIResponder <
    UIApplicationDelegate,
    AVCaptureVideoDataOutputSampleBufferDelegate,
    AVCaptureMetadataOutputObjectsDelegate>
@end

@implementation SimCameraConnectionTestDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    (void)application;
    (void)launchOptions;

    NSString *mode = NSProcessInfo.processInfo.environment[@"SIMCAM_CONNECTION_TEST_MODE"] ?: @"graph";
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            if ([mode isEqualToString:@"graph"]) RunExplicitConnectionCheck();
            else if ([mode isEqualToString:@"teardown"]) RunTeardownCheck(self);
            else if ([mode isEqualToString:@"automatic-recording"]) RunAutomaticConnectionsRecording();
            else if ([mode isEqualToString:@"manual-recording"]) RunManualConnectionsRecording();
            else if ([mode isEqualToString:@"max-duration-recording"]) RunMaxDurationRecording();
            else if ([mode isEqualToString:@"existing-file-recording"]) RunExistingFileRecording();
            else if ([mode isEqualToString:@"writer-failure-recording"]) RunWriterFailureRecording();
            else WriteResult(NO, [NSString stringWithFormat:@"Unknown mode %@", mode]);
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
