#import "SimCamLog.h"

void simcam_log(NSString *fmt, ...) {
    va_list args; va_start(args, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
    va_end(args);
    fprintf(stderr, "[SimCam] %s\n", msg.UTF8String);
    NSLog(@"[SimCam] %@", msg);
}
