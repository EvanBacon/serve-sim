#import <AVFoundation/AVFoundation.h>

// One AVCaptureMovieFileOutput recording from the injected frames. A session
// with a fake camera never runs natively, so the movie output's own recorder
// has no media; this writes the current frame at the frame rate to the URL
// with AVAssetWriter and calls the recording delegate as AVFoundation does.
@interface SimCamMovieRecorder : NSObject
- (instancetype)initWithOutput:(AVCaptureFileOutput *)output
                           URL:(NSURL *)url
                      delegate:(id<AVCaptureFileOutputRecordingDelegate>)delegate
                   connections:(NSArray<AVCaptureConnection *> *)connections
                 videoSettings:(NSDictionary<NSString *, id> *)videoSettings
                   maxDuration:(CMTime)maxDuration;
- (void)start;
- (void)stop;
// Ends the recording as `stop` does, with `error` for the delegate once the
// file is finished. Before `start`, the recording fails with `error` and
// writes nothing.
- (void)stopWithError:(NSError *)error;
- (void)pause;
- (void)resume;
@property (nonatomic, readonly) NSURL *URL;
@property (nonatomic, readonly, getter=isRecording) BOOL recording;
@property (nonatomic, readonly, getter=isPaused) BOOL paused;
@property (nonatomic, readonly) CMTime recordedDuration;
@property (nonatomic, readonly) int64_t recordedFileSize;
@end
