#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallSwizzles(void);

// Shared with the other swizzle files.
BOOL SimCamOutputAttachedToFakeSession(AVCaptureOutput *output);
AVCaptureSession *SimCamFakeSessionForOutput(AVCaptureOutput *output);
NSArray<AVCaptureConnection *> *SimCamConnectionsForOutput(AVCaptureOutput *output);
BOOL SimCamConnectionCarries(AVCaptureConnection *connection, AVMediaType mediaType);
// Hidden from the dylib's exports, as the one helper without the SimCam
// prefix.
__attribute__((visibility("hidden"))) BOOL SwizzleInstanceMethod(Class cls, SEL orig, SEL swiz);
