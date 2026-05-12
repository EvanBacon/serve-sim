#import <UIKit/UIKit.h>
#include <unistd.h>

#import "SimCamFakes.h"
#import "SimCamFrameSource.h"
#import "SimCamLog.h"
#import "SimCamSwizzles.h"

__attribute__((constructor))
static void SimCamInit(void) {
    @autoreleasepool {
        simcam_log(@"loaded into pid %d", getpid());
        SimCamReadMirrorModeFromEnv();
        SimCamFrameSourceOpenShmIfRequested();
        if (!SimCamFrameSourceIsShmAttached()) SimCamFrameSourceLoadImage();
        SimCamInstallSwizzles();
        simcam_log(@"swizzles installed");
    }
}
