#pragma once

#import <AVFoundation/AVFoundation.h>

@interface SimCamRegistry : NSObject
+ (instancetype)shared;

- (void)addOutput:(AVCaptureVideoDataOutput *)out
         delegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)delegate
            queue:(dispatch_queue_t)queue;
- (void)removeOutput:(AVCaptureVideoDataOutput *)out;
- (void)addPreviewLayer:(AVCaptureVideoPreviewLayer *)layer;
- (void)reapplyMirrorToLayers;

- (CVPixelBufferRef)currentPixelBuffer CF_RETURNS_RETAINED;

- (NSData *)currentSnapshotJPEGAtQuality:(CGFloat)q;

- (void)startPumpingIfNeeded;
- (void)stopPumping;
@end

void SimCamFrameSourceLoadImage(void);
void SimCamFrameSourceOpenShmIfRequested(void);

BOOL SimCamFrameSourceIsShmAttached(void);
