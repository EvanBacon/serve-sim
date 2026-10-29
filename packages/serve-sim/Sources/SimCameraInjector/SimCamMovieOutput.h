#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallMovieOutputSwizzles(void);

// Ends the output's fake recording, as AVFoundation ends a recording whose
// output leaves the session, or loses its camera.
void SimCamMovieOutputLeftFakeSession(AVCaptureOutput *output);
