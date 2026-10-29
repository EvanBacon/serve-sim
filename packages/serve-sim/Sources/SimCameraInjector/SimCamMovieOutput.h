#pragma once

#import <AVFoundation/AVFoundation.h>

void SimCamInstallMovieOutputSwizzles(void);

// Ends the output's fake recording, if it has one: frames stop reaching it
// when its session stops running, and stopRecording stops reaching the fake
// once the output leaves its session.
void SimCamEndFakeMovieRecording(AVCaptureOutput *output);
