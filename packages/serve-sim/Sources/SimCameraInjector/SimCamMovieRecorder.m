#import "SimCamMovieRecorder.h"
#import "SimCamFrameSource.h"
#import "SimCamLog.h"

#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#include <stdatomic.h>

static const int32_t kSimCamMovieFrameRate = 30;
static const int32_t kSimCamMovieTimescale = 600;

// AVFoundation reports a failed recording with
// AVErrorRecordingSuccessfullyFinishedKey set to NO, which apps read to tell
// a usable file from a broken one.
static NSError *SimCamRecordingFailure(NSError *cause) {
    NSMutableDictionary *userInfo = [cause.userInfo mutableCopy] ?: [NSMutableDictionary new];
    userInfo[AVErrorRecordingSuccessfullyFinishedKey] = @NO;
    return [NSError errorWithDomain:cause.domain ?: AVFoundationErrorDomain
                               code:cause ? cause.code : AVErrorUnknown
                           userInfo:userInfo];
}

@implementation SimCamMovieRecorder {
    // Held until the delegate hears the recording finished, as AVFoundation
    // always tells it, even when the app lets the output go first.
    AVCaptureFileOutput *_output;
    id<AVCaptureFileOutputRecordingDelegate> _delegate;
    NSArray<AVCaptureConnection *> *_connections;
    NSDictionary<NSString *, id> *_videoSettings;
    CMTime _maxDuration;
    // Bytes; 0 is no limit.
    int64_t _maxFileSize;
    dispatch_queue_t _queue;
    dispatch_source_t _timer;
    AVAssetWriter *_writer;
    AVAssetWriterInput *_input;
    AVAssetWriterInputPixelBufferAdaptor *_adaptor;
    CFTimeInterval _startedAt;
    CFTimeInterval _pausedAt;
    CFTimeInterval _pausedSeconds;
    CMTime _lastFrameTime;
    BOOL _finishing;
    // Read from any thread through the public getters.
    _Atomic(BOOL) _recording;
    _Atomic(BOOL) _paused;
    _Atomic(int64_t) _recordedValue;
}

- (instancetype)initWithOutput:(AVCaptureFileOutput *)output
                           URL:(NSURL *)url
                      delegate:(id<AVCaptureFileOutputRecordingDelegate>)delegate
                   connections:(NSArray<AVCaptureConnection *> *)connections
                 videoSettings:(NSDictionary<NSString *, id> *)videoSettings
                   maxDuration:(CMTime)maxDuration
                   maxFileSize:(int64_t)maxFileSize {
    if ((self = [super init])) {
        _output = output;
        _URL = url;
        _delegate = delegate;
        _connections = [connections copy] ?: @[];
        _videoSettings = [videoSettings copy] ?: @{};
        _maxDuration = maxDuration;
        _maxFileSize = maxFileSize;
        _queue = dispatch_queue_create("dev.servesim.simcam.movie", DISPATCH_QUEUE_SERIAL);
        _lastFrameTime = kCMTimeInvalid;
    }
    return self;
}

- (BOOL)isRecording { return _recording; }
- (BOOL)isPaused { return _paused; }
- (CMTime)recordedDuration { return CMTimeMake(_recordedValue, kSimCamMovieTimescale); }
- (int64_t)recordedFileSize {
    NSDictionary *attributes = [[NSFileManager defaultManager]
        attributesOfItemAtPath:_URL.path error:nil];
    return (int64_t)attributes.fileSize;
}

- (void)start {
    _recording = YES;
    dispatch_async(_queue, ^{
        NSError *error = nil;
        if (![self openWriter:&error]) {
            [self finishWithError:SimCamRecordingFailure(error) endingAt:kCMTimeInvalid];
            return;
        }
        self->_startedAt = CACurrentMediaTime();
        [self appendFrameAt:kCMTimeZero];
        simcam_log(@"movie recording started → %@", self->_URL.lastPathComponent);
        [self callDelegate:@selector(captureOutput:didStartRecordingToOutputFileAtURL:fromConnections:)];
        self->_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self->_queue);
        uint64_t intervalNs = NSEC_PER_SEC / kSimCamMovieFrameRate;
        dispatch_source_set_timer(self->_timer,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)intervalNs), intervalNs, intervalNs / 10);
        __weak SimCamMovieRecorder *weakSelf = self;
        dispatch_source_set_event_handler(self->_timer, ^{ [weakSelf tick]; });
        dispatch_resume(self->_timer);
    });
}

- (void)stop {
    [self stopWithError:nil];
}

- (void)stopWithError:(NSError *)error {
    dispatch_async(_queue, ^{ [self finishWithError:error endingAt:kCMTimeInvalid]; });
}

- (void)pause {
    dispatch_async(_queue, ^{
        if (self->_paused || self->_finishing) return;
        self->_pausedAt = CACurrentMediaTime();
        self->_paused = YES;
        [self callDelegate:@selector(captureOutput:didPauseRecordingToOutputFileAtURL:fromConnections:)];
    });
}

- (void)resume {
    dispatch_async(_queue, ^{
        if (!self->_paused || self->_finishing) return;
        self->_pausedSeconds += CACurrentMediaTime() - self->_pausedAt;
        self->_paused = NO;
        [self callDelegate:@selector(captureOutput:didResumeRecordingToOutputFileAtURL:fromConnections:)];
    });
}

#pragma mark - Queue-confined

- (BOOL)openWriter:(NSError **)error {
    CVPixelBufferRef frame = [[SimCamRegistry shared] currentPixelBuffer];
    size_t width = frame ? CVPixelBufferGetWidth(frame) : 1280;
    size_t height = frame ? CVPixelBufferGetHeight(frame) : 720;
    if (frame) CVPixelBufferRelease(frame);

    if ([[NSFileManager defaultManager] fileExistsAtPath:_URL.path]) {
        if (error) *error = [NSError errorWithDomain:AVFoundationErrorDomain
                                                code:AVErrorFileAlreadyExists
                                            userInfo:@{
                                                NSURLErrorKey: _URL,
                                                NSLocalizedDescriptionKey: @"A file already exists at the recording URL",
                                            }];
        return NO;
    }
    // AVCaptureMovieFileOutput writes a QuickTime movie whatever the file's
    // extension says, so the fake does too.
    _writer = [AVAssetWriter assetWriterWithURL:_URL fileType:AVFileTypeQuickTimeMovie error:error];
    if (!_writer) return NO;

    NSMutableDictionary *settings = [NSMutableDictionary dictionaryWithDictionary:@{
        AVVideoCodecKey: _videoSettings[AVVideoCodecKey] ?: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
    }];
    if (_videoSettings[AVVideoCompressionPropertiesKey]) {
        settings[AVVideoCompressionPropertiesKey] = _videoSettings[AVVideoCompressionPropertiesKey];
    }
    _input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    _input.expectsMediaDataInRealTime = YES;
    _adaptor = [AVAssetWriterInputPixelBufferAdaptor
        assetWriterInputPixelBufferAdaptorWithAssetWriterInput:_input
                                   sourcePixelBufferAttributes:nil];
    if (![_writer canAddInput:_input]) {
        if (error) *error = [NSError errorWithDomain:AVFoundationErrorDomain
                                                code:AVErrorUnknown
                                            userInfo:@{ NSLocalizedDescriptionKey: @"serve-sim could not add a video track" }];
        return NO;
    }
    [_writer addInput:_input];
    if (![_writer startWriting]) {
        if (error) *error = _writer.error;
        return NO;
    }
    [_writer startSessionAtSourceTime:kCMTimeZero];
    return YES;
}

- (void)tick {
    if (_finishing) return;
    if (_writer.status == AVAssetWriterStatusFailed) {
        [self finishWithError:SimCamRecordingFailure(_writer.error) endingAt:kCMTimeInvalid];
        return;
    }
    // Checked while paused too, in case the writer flushes what it had
    // buffered then. The writer flushes in chunks and adds the movie header
    // as it finishes, so the finished file runs past the limit by what it
    // had buffered.
    if (_maxFileSize > 0 && self.recordedFileSize >= _maxFileSize) {
        [self finishWithError:[NSError errorWithDomain:AVFoundationErrorDomain
                                                  code:AVErrorMaximumFileSizeReached
                                              userInfo:@{ AVErrorRecordingSuccessfullyFinishedKey: @YES }]
                     endingAt:kCMTimeInvalid];
        return;
    }
    if (_paused) return;
    CFTimeInterval elapsed = CACurrentMediaTime() - _startedAt - _pausedSeconds;
    CMTime now = CMTimeMakeWithSeconds(elapsed, kSimCamMovieTimescale);
    if (CMTIME_IS_VALID(_maxDuration) && CMTimeCompare(now, _maxDuration) >= 0) {
        [self finishWithError:[NSError errorWithDomain:AVFoundationErrorDomain
                                                  code:AVErrorMaximumDurationReached
                                              userInfo:@{ AVErrorRecordingSuccessfullyFinishedKey: @YES }]
                     endingAt:_maxDuration];
        return;
    }
    [self appendFrameAt:now];
}

- (void)appendFrameAt:(CMTime)time {
    if (CMTIME_IS_VALID(_lastFrameTime) && CMTimeCompare(time, _lastFrameTime) <= 0) return;
    if (!_input.isReadyForMoreMediaData) return;
    CVPixelBufferRef frame = [[SimCamRegistry shared] currentPixelBuffer];
    if (!frame) return;
    if ([_adaptor appendPixelBuffer:frame withPresentationTime:time]) {
        _lastFrameTime = time;
        _recordedValue = CMTimeConvertScale(time, kSimCamMovieTimescale, kCMTimeRoundingMethod_Default).value;
    }
    CVPixelBufferRelease(frame);
}

// `end` is where the movie stops; invalid means one frame past the last.
- (void)finishWithError:(NSError *)error endingAt:(CMTime)end {
    if (_finishing) return;
    _finishing = YES;
    if (_timer) {
        dispatch_source_cancel(_timer);
        _timer = nil;
    }
    void (^deliver)(NSError *) = ^(NSError *result) {
        self->_recording = NO;
        self->_paused = NO;
        simcam_log(@"movie recording finished → %@ (%.2f s, error=%@)",
            self->_URL.lastPathComponent, CMTimeGetSeconds(self.recordedDuration),
            result.localizedDescription ?: @"none");
        AVCaptureFileOutput *output = self->_output;
        [self->_delegate captureOutput:output
           didFinishRecordingToOutputFileAtURL:self->_URL
                               fromConnections:self->_connections
                                         error:result];
        self->_delegate = nil;
        self->_output = nil;
    };
    if (_writer.status != AVAssetWriterStatusWriting) {
        deliver(SimCamRecordingFailure(error ?: _writer.error));
        return;
    }
    [_input markAsFinished];
    if (!CMTIME_IS_VALID(end) && CMTIME_IS_VALID(_lastFrameTime)) {
        end = CMTimeAdd(_lastFrameTime, CMTimeMake(1, kSimCamMovieFrameRate));
    }
    if (CMTIME_IS_VALID(end)) {
        [_writer endSessionAtSourceTime:end];
        _recordedValue = CMTimeConvertScale(end, kSimCamMovieTimescale, kCMTimeRoundingMethod_Default).value;
    }
    [_writer finishWritingWithCompletionHandler:^{
        dispatch_async(self->_queue, ^{
            BOOL completed = self->_writer.status == AVAssetWriterStatusCompleted;
            deliver(completed ? error : SimCamRecordingFailure(self->_writer.error));
        });
    }];
}

- (void)callDelegate:(SEL)selector {
    if (![_delegate respondsToSelector:selector]) return;
    AVCaptureFileOutput *output = _output;
    ((void (*)(id, SEL, AVCaptureFileOutput *, NSURL *, NSArray *))objc_msgSend)(
        _delegate, selector, output, _URL, _connections);
}

@end
