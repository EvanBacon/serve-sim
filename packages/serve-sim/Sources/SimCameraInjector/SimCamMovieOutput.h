#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallMovieOutputSwizzles(void);

// End the output's fake recording, if it has one. AVFoundation's error when
// the session's media sources or destinations change
// (AVErrorSessionConfigurationChanged, in Apple's documentation: "Recording
// stopped because the configuration of media sources and destinations
// changed") is for the output leaving its fake session: removed, or the
// session's last fake camera removed, after which stopRecording no longer
// reaches the fake. A session stopped mid-recording has no error code of its
// own (AVErrorSessionNotRunning is for a recording that cannot start), so its
// recordings end as a stop.
void SimCamFakeMovieOutputLeftSession(AVCaptureOutput *output);
void SimCamFakeMovieOutputSessionStopped(AVCaptureOutput *output);
