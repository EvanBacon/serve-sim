#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallSwizzles(void);

// Shared by the swizzle files, and hidden so the injected dylib exports no
// more than it did.
__attribute__((visibility("hidden"))) BOOL SwizzleInstanceMethod(Class cls, SEL orig, SEL swiz);
__attribute__((visibility("hidden"))) BOOL SimCamOutputAttachedToFakeSession(AVCaptureOutput *output);
__attribute__((visibility("hidden"))) NSArray<AVCaptureConnection *> *SimCamConnectionsForOutput(AVCaptureOutput *output);
__attribute__((visibility("hidden"))) BOOL SimCamConnectionCarries(AVCaptureConnection *connection, AVMediaType mediaType);
