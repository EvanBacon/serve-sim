#import "SimCamMovieOutput.h"
#import "SimCamFakes.h"
#import "SimCamFrameSource.h"
#import "SimCamMovieRecorder.h"
#import "SimCamSwizzles.h"

#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>

static char kSimCamMovieRecorderKey;
static char kSimCamMovieSettingsKey;

static SimCamMovieRecorder *SimCamMovieRecorderFor(AVCaptureOutput *output) {
    return objc_getAssociatedObject(output, &kSimCamMovieRecorderKey);
}
static NSDictionary *SimCamMovieSettings(AVCaptureOutput *output) {
    return objc_getAssociatedObject(output, &kSimCamMovieSettingsKey) ?: @{ AVVideoCodecKey: AVVideoCodecTypeH264 };
}

// AVFoundation answers these from the native connection graph, which a
// session with a fake camera never builds, and throws for a connection it
// does not own. The settings are kept per output for the fake recorder,
// which records in place of the native one. The recording methods are
// swizzled on AVCaptureMovieFileOutput, which overrides some of them, so
// AVCaptureFileOutput and its other subclasses are untouched.
@interface AVCaptureMovieFileOutput (SimCam)
@end
@implementation AVCaptureMovieFileOutput (SimCam)
- (NSArray<AVVideoCodecType> *)simcam_availableVideoCodecTypes {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_availableVideoCodecTypes];
    return @[ AVVideoCodecTypeH264, AVVideoCodecTypeHEVC ];
}
- (NSArray<NSString *> *)simcam_supportedOutputSettingsKeysForConnection:(AVCaptureConnection *)connection {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_supportedOutputSettingsKeysForConnection:connection];
    return @[ AVVideoCodecKey, AVVideoCompressionPropertiesKey ];
}
- (NSDictionary<NSString *, id> *)simcam_outputSettingsForConnection:(AVCaptureConnection *)connection {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_outputSettingsForConnection:connection];
    return SimCamMovieSettings(self);
}
- (void)simcam_setOutputSettings:(NSDictionary<NSString *, id> *)settings
                   forConnection:(AVCaptureConnection *)connection {
    if (!SimCamOutputAttachedToFakeSession(self)) {
        [self simcam_setOutputSettings:settings forConnection:connection];
        return;
    }
    objc_setAssociatedObject(self, &kSimCamMovieSettingsKey, [settings copy], OBJC_ASSOCIATION_RETAIN);
}
- (void)simcam_startRecordingToOutputFileURL:(NSURL *)url
                           recordingDelegate:(id<AVCaptureFileOutputRecordingDelegate>)delegate {
    if (!SimCamOutputAttachedToFakeSession(self)) {
        [self simcam_startRecordingToOutputFileURL:url recordingDelegate:delegate];
        return;
    }
    // AVFoundation closes the file in progress before it opens the next.
    [SimCamMovieRecorderFor(self) stop];
    SimCamMovieRecorder *recorder = [[SimCamMovieRecorder alloc]
        initWithOutput:self
                   URL:url
              delegate:delegate
           connections:SimCamConnectionsForOutput(self)
         videoSettings:SimCamMovieSettings(self)
           maxDuration:self.maxRecordedDuration];
    objc_setAssociatedObject(self, &kSimCamMovieRecorderKey, recorder, OBJC_ASSOCIATION_RETAIN);
    SimCamMarkCameraInUse();
    [[SimCamRegistry shared] startPumpingIfNeeded];
    [recorder start];
}
- (void)simcam_stopRecording {
    if (!SimCamOutputAttachedToFakeSession(self)) {
        [self simcam_stopRecording];
        return;
    }
    [SimCamMovieRecorderFor(self) stop];
}
- (void)simcam_pauseRecording {
    if (!SimCamOutputAttachedToFakeSession(self)) {
        [self simcam_pauseRecording];
        return;
    }
    [SimCamMovieRecorderFor(self) pause];
}
- (void)simcam_resumeRecording {
    if (!SimCamOutputAttachedToFakeSession(self)) {
        [self simcam_resumeRecording];
        return;
    }
    [SimCamMovieRecorderFor(self) resume];
}
- (BOOL)simcam_isRecording {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_isRecording];
    return SimCamMovieRecorderFor(self).isRecording;
}
- (BOOL)simcam_isRecordingPaused {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_isRecordingPaused];
    return SimCamMovieRecorderFor(self).isPaused;
}
- (NSURL *)simcam_outputFileURL {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_outputFileURL];
    SimCamMovieRecorder *recorder = SimCamMovieRecorderFor(self);
    return recorder.isRecording ? recorder.URL : nil;
}
- (CMTime)simcam_recordedDuration {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_recordedDuration];
    SimCamMovieRecorder *recorder = SimCamMovieRecorderFor(self);
    return recorder ? recorder.recordedDuration : kCMTimeZero;
}
- (int64_t)simcam_recordedFileSize {
    if (!SimCamOutputAttachedToFakeSession(self)) return [self simcam_recordedFileSize];
    return SimCamMovieRecorderFor(self).recordedFileSize;
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
