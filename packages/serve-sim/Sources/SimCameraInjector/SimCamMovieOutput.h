#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallMovieOutputSwizzles(void);

// Ends the fake recording of an output leaving its fake session (removed,
// or the session's last fake camera removed), which stopRecording no
// longer reaches once the output is native again.
void SimCamMovieOutputLeftFakeSession(AVCaptureOutput *output);
