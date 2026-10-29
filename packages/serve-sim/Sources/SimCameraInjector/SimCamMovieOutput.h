#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallMovieOutputSwizzles(void);

// Ends the output's fake recording, if it has one: frames stop reaching it
// when its session stops running, and when it leaves its fake session
// (removed, or the session's last fake camera removed), where stopRecording
// no longer reaches the fake.
void SimCamEndFakeMovieRecording(AVCaptureOutput *output);
