#import "SimCamMovieOutput.h"
#import "SimCamFakes.h"
#import "SimCamFrameSource.h"
#import "SimCamMovieRecorder.h"
#import "SimCamSwizzles.h"

#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>

// What a movie output on a fake session records with in place of its own
// recorder, which has no media there.
@interface SimCamFakeMovieOutput : NSObject
@property (atomic, copy) NSDictionary<NSString *, id> *videoSettings;
@property (atomic, strong) SimCamMovieRecorder *recorder;
@end
@implementation SimCamFakeMovieOutput
@end

static char kSimCamFakeMovieOutputKey;

// nil for an output AVFoundation records itself.
static SimCamFakeMovieOutput *SimCamFakeMovieOutputFor(AVCaptureMovieFileOutput *output) {
    if (!SimCamOutputAttachedToFakeSession(output)) return nil;
    @synchronized (output) {
        SimCamFakeMovieOutput *fake = objc_getAssociatedObject(output, &kSimCamFakeMovieOutputKey);
        if (!fake) {
            fake = [SimCamFakeMovieOutput new];
            fake.videoSettings = @{ AVVideoCodecKey: AVVideoCodecTypeH264 };
            objc_setAssociatedObject(output, &kSimCamFakeMovieOutputKey, fake, OBJC_ASSOCIATION_RETAIN);
        }
        return fake;
    }
}

void SimCamMovieOutputLeftFakeSession(AVCaptureOutput *output) {
    SimCamFakeMovieOutput *fake = objc_getAssociatedObject(output, &kSimCamFakeMovieOutputKey);
    [fake.recorder stop];
}

// AVFoundation answers these from the native connection graph, which a
// session with a fake camera never builds, and throws for a connection it
// does not own. The recording methods are swizzled on
// AVCaptureMovieFileOutput, which overrides some of them, so
// AVCaptureFileOutput and its other subclasses are untouched.
@interface AVCaptureMovieFileOutput (SimCam)
@end
@implementation AVCaptureMovieFileOutput (SimCam)
- (NSArray<AVVideoCodecType> *)simcam_availableVideoCodecTypes {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_availableVideoCodecTypes];
    return @[ AVVideoCodecTypeH264, AVVideoCodecTypeHEVC ];
}
- (NSArray<NSString *> *)simcam_supportedOutputSettingsKeysForConnection:(AVCaptureConnection *)connection {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_supportedOutputSettingsKeysForConnection:connection];
    return @[ AVVideoCodecKey, AVVideoCompressionPropertiesKey ];
}
- (NSDictionary<NSString *, id> *)simcam_outputSettingsForConnection:(AVCaptureConnection *)connection {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_outputSettingsForConnection:connection];
    return SimCamConnectionCarries(connection, AVMediaTypeVideo) ? fake.videoSettings : @{};
}
- (void)simcam_setOutputSettings:(NSDictionary<NSString *, id> *)settings
                   forConnection:(AVCaptureConnection *)connection {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_setOutputSettings:settings forConnection:connection];
    // The fake movie has no audio track, so only video settings are kept.
    if (!SimCamConnectionCarries(connection, AVMediaTypeVideo)) return;
    fake.videoSettings = settings ?: @{ AVVideoCodecKey: AVVideoCodecTypeH264 };
}
- (void)simcam_startRecordingToOutputFileURL:(NSURL *)url
                           recordingDelegate:(id<AVCaptureFileOutputRecordingDelegate>)delegate {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_startRecordingToOutputFileURL:url recordingDelegate:delegate];
    // AVFoundation closes the file in progress before it opens the next.
    [fake.recorder stop];
    fake.recorder = [[SimCamMovieRecorder alloc]
        initWithOutput:self
                   URL:url
              delegate:delegate
           connections:SimCamConnectionsForOutput(self)
         videoSettings:fake.videoSettings
           maxDuration:self.maxRecordedDuration];
    SimCamMarkCameraInUse();
    [[SimCamRegistry shared] startPumpingIfNeeded];
    [fake.recorder start];
}
- (void)simcam_stopRecording {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_stopRecording];
    [fake.recorder stop];
}
- (void)simcam_pauseRecording {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_pauseRecording];
    [fake.recorder pause];
}
- (void)simcam_resumeRecording {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_resumeRecording];
    [fake.recorder resume];
}
- (BOOL)simcam_isRecording {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_isRecording];
    return fake.recorder.isRecording;
}
- (BOOL)simcam_isRecordingPaused {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_isRecordingPaused];
    return fake.recorder.isPaused;
}
- (NSURL *)simcam_outputFileURL {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_outputFileURL];
    return fake.recorder.isRecording ? fake.recorder.URL : nil;
}
- (CMTime)simcam_recordedDuration {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_recordedDuration];
    return fake.recorder ? fake.recorder.recordedDuration : kCMTimeZero;
}
- (int64_t)simcam_recordedFileSize {
    SimCamFakeMovieOutput *fake = SimCamFakeMovieOutputFor(self);
    if (!fake) return [self simcam_recordedFileSize];
    return fake.recorder.recordedFileSize;
}
@end

void SimCamInstallMovieOutputSwizzles(void) {
    Class movieOut = [AVCaptureMovieFileOutput class];
    SwizzleInstanceMethod(movieOut,
        @selector(availableVideoCodecTypes),
        @selector(simcam_availableVideoCodecTypes));
    SwizzleInstanceMethod(movieOut,
        @selector(supportedOutputSettingsKeysForConnection:),
        @selector(simcam_supportedOutputSettingsKeysForConnection:));
    SwizzleInstanceMethod(movieOut,
        @selector(outputSettingsForConnection:),
        @selector(simcam_outputSettingsForConnection:));
    SwizzleInstanceMethod(movieOut,
        @selector(setOutputSettings:forConnection:),
        @selector(simcam_setOutputSettings:forConnection:));
    SwizzleInstanceMethod(movieOut,
        @selector(startRecordingToOutputFileURL:recordingDelegate:),
        @selector(simcam_startRecordingToOutputFileURL:recordingDelegate:));
    SwizzleInstanceMethod(movieOut, @selector(stopRecording), @selector(simcam_stopRecording));
    SwizzleInstanceMethod(movieOut, @selector(isRecording), @selector(simcam_isRecording));
    SwizzleInstanceMethod(movieOut, @selector(outputFileURL), @selector(simcam_outputFileURL));
    SwizzleInstanceMethod(movieOut, @selector(recordedDuration), @selector(simcam_recordedDuration));
    SwizzleInstanceMethod(movieOut, @selector(recordedFileSize), @selector(simcam_recordedFileSize));
    if (@available(iOS 18.0, *)) {
        SwizzleInstanceMethod(movieOut, @selector(pauseRecording), @selector(simcam_pauseRecording));
        SwizzleInstanceMethod(movieOut, @selector(resumeRecording), @selector(simcam_resumeRecording));
        SwizzleInstanceMethod(movieOut, @selector(isRecordingPaused), @selector(simcam_isRecordingPaused));
    }
}
