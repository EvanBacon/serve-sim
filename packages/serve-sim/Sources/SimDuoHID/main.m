// Guest HID transport for hinge angles, physical orientation, hardware buttons, and touch.
// Spawned inside iOS Simulator; one command/reply per line until EOF.
// `watch-angle` instead streams the hinge angle the guest reports (see watchAngle).
// `watch-notify <name>` streams a notify(3) state value (see watchNotify).
#import <Foundation/Foundation.h>
#import <notify.h>
#import <sys/sysctl.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <math.h>
#import <unistd.h>

// CoreMotion's private hinge-angle API, the source UIKit's UIHinge reads.
@interface CMAngle : NSObject
- (float)angleDegrees;
@end
@interface CMAngleManager : NSObject
+ (BOOL)isAvailable;
- (void)startAngleUpdatesToQueue:(NSOperationQueue *)queue handler:(void (^)(CMAngle *angle))handler;
- (void)stopAngleUpdates;
@end

// Prints `angle <degrees>` for the first sample and for every later change of at
// least 0.5°, until the parent closes stdin. Read-only: it never creates the HID
// services, so it can run next to the command transport. Reading in the guest
// keeps the hinge independent of CoreDevice: `devicectl device motion` exists in
// devicectl 651.13.4 (Xcode 27.1 beta, 27A9269) but not in 651.13.5 (Xcode 27.1
// 27A9275) or later (seen through 651.32, Xcode 27.2 27B52), and CoreDevice is
// shared by every installed Xcode.
static int watchAngle(void) {
    dlopen("/System/Library/Frameworks/CoreMotion.framework/CoreMotion", RTLD_NOW);
    Class managerClass = NSClassFromString(@"CMAngleManager");
    if (!managerClass || ![managerClass respondsToSelector:@selector(isAvailable)] || ![managerClass isAvailable]) {
        fprintf(stderr, "Hinge angle unavailable: CMAngleManager reports no hinge\n");
        return 2;
    }
    CMAngleManager *manager = [managerClass new];
    if (![manager respondsToSelector:@selector(startAngleUpdatesToQueue:handler:)]) {
        fprintf(stderr, "Hinge angle unavailable: CMAngleManager has no angle updates\n");
        return 2;
    }
    NSOperationQueue *queue = [NSOperationQueue new];
    queue.maxConcurrentOperationCount = 1;
    __block double last = NAN;
    [manager startAngleUpdatesToQueue:queue handler:^(CMAngle *sample) {
        double degrees = [sample angleDegrees];
        if (!isfinite(degrees) || degrees < 0 || degrees > 180) return;
        if (isfinite(last) && fabs(degrees - last) < 0.5) return;
        last = degrees;
        if (degrees == 0) degrees = 0; // never print -0.0
        printf("angle %.1f\n", degrees);
        fflush(stdout);
    }];
    // Updates arrive on `queue`, not the main run loop, so the main thread only
    // waits for the parent to close stdin.
    char buffer[64];
    while (read(STDIN_FILENO, buffer, sizeof buffer) > 0) {}
    [manager stopAngleUpdates];
    return 0;
}

// Prints `state <value>` for the first read and for every change of the
// notify(3) state `name`, until the parent closes stdin. Used for
// com.apple.coredevice.dtuhidd.active, the flag Device Hub's dtuhidd sets when
// it disconnects legacy Indigo input: a legacy touch sent while it is 1 aborts
// backboardd ("Unable to dispatch event through disconnected service"), so the
// server must see 0->1 before its next send. notify_get_state is an in-process
// read, so polling every 50 ms is cheap; setters don't always post, so a
// notify_register_dispatch alone would miss changes.
static int watchNotify(const char *name) {
    int token = 0;
    if (notify_register_check(name, &token) != NOTIFY_STATUS_OK) {
        fprintf(stderr, "notify_register_check failed for %s\n", name);
        return 2;
    }
    dispatch_queue_t queue = dispatch_queue_create("serve-sim.notify", DISPATCH_QUEUE_SERIAL);
    __block uint64_t last = UINT64_MAX;
    __block BOOL first = YES;
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 50 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(timer, ^{
        uint64_t value = 0;
        if (notify_get_state(token, &value) != NOTIFY_STATUS_OK) return;
        if (!first && value == last) return;
        first = NO;
        last = value;
        printf("state %llu\n", (unsigned long long)value);
        fflush(stdout);
    });
    dispatch_resume(timer);
    char buffer[64];
    while (read(STDIN_FILENO, buffer, sizeof buffer) > 0) {}
    dispatch_source_cancel(timer);
    notify_cancel(token);
    return 0;
}

@interface DuoServiceDelegate : NSObject
@property NSDictionary *properties;
@end
@implementation DuoServiceDelegate
- (id)propertyForKey:(NSString *)key forService:(id)service { return self.properties[key]; }
- (BOOL)setProperty:(id)value forKey:(NSString *)key forService:(id)service { return YES; }
- (id)copyEventMatching:(id)matching forService:(id)service { return nil; }
- (BOOL)setOutputEvent:(id)event forService:(id)service { return YES; }
- (void)notification:(uint32_t)type withProperty:(id)property forService:(id)service {}
@end

static void header(NSMutableData *data, uint32_t count, uint8_t type) {
    uint8_t bytes[] = {count & 255, (count >> 8) & 255, (count >> 16) & 255, type};
    [data appendBytes:bytes length:4];
}
static void string(NSMutableData *data, const char *text, BOOL key, BOOL last) {
    size_t length = strlen(text) + (key ? 1 : 0);
    header(data, (uint32_t)length, (key ? 8 : 9) | (last ? 0x80 : 0));
    [data appendBytes:text length:length];
    while (data.length % 4) { uint8_t zero = 0; [data appendBytes:&zero length:1]; }
}
static NSData *hingePayload(double degrees) {
    NSMutableData *data = [NSMutableData data];
    header(data, 0xd3, 0);
    header(data, 4, 0x81);
    string(data, "provider", YES, NO); string(data, "com.apple.Virtualization.VirtualMachines", NO, NO);
    string(data, "source", YES, NO); string(data, "hinge-slider-control", NO, NO);
    string(data, "type", YES, NO); string(data, "range", NO, NO);
    string(data, "value", YES, NO); header(data, 0x3f, 0x84);
    [data appendBytes:&degrees length:sizeof(degrees)];
    return data;
}
// Captured from Device Hub's 0xff61/0x5b vendor event. Duo's motion
// controller consumes this enum; the legacy PurpleWorkspace GSEvent is ignored.
static NSData *orientationPayload(unsigned orientation) {
    const char *value;
    switch (orientation) {
        case 1: value = "portrait"; break;
        case 2: value = "pud"; break;
        // Incoming values use the existing screen/UI orientation convention.
        // CoreDevice's physical-device landscape names are the opposite.
        case 3: value = "landscape-left"; break;
        case 4: value = "landscape-right"; break;
        default: return nil;
    }
    NSMutableData *data = [NSMutableData data];
    header(data, 0xd3, 0);
    header(data, 4, 0x81);
    string(data, "provider", YES, NO); string(data, "com.apple.Virtualization.VirtualMachines", NO, NO);
    string(data, "source", YES, NO); string(data, "orientation-picker-control", NO, NO);
    string(data, "type", YES, NO); string(data, "enum", NO, NO);
    string(data, "value", YES, NO); string(data, value, NO, YES);
    return data;
}
static id serviceWith(uint32_t page, uint32_t usage, BOOL builtIn, NSDictionary *extra) {
    Class cls = NSClassFromString(@"HIDVirtualEventService");
    if (!cls) return nil;
    id instance = [[cls alloc] init];
    DuoServiceDelegate *delegate = [DuoServiceDelegate new];
    NSMutableDictionary *properties = [@{
        @"PrimaryUsagePage": @(page), @"PrimaryUsage": @(usage),
        @"DeviceUsagePairs": @[@{@"DeviceUsagePage": @(page), @"DeviceUsage": @(usage)}],
        @"Transport": @"CoreDevice", @"Product": @"serve-sim Duo HID",
        @"Built-In": @(builtIn), @"VendorID": @0, @"ProductID": @0,
        @"VersionNumber": @0, @"ReportInterval": @8000,
    } mutableCopy];
    [properties addEntriesFromDictionary:extra ?: @{}];
    delegate.properties = properties;
    objc_setAssociatedObject(instance, @selector(properties), delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    ((void (*)(id, SEL, id))objc_msgSend)(instance, sel_registerName("setDelegate:"), delegate);
    dispatch_queue_t queue = dispatch_queue_create("serve-sim.duo", DISPATCH_QUEUE_SERIAL);
    ((void (*)(id, SEL, id))objc_msgSend)(instance, sel_registerName("setDispatchQueue:"), queue);
    ((void (*)(id, SEL))objc_msgSend)(instance, sel_registerName("activate"));
    return ((uint64_t (*)(id, SEL))objc_msgSend)(instance, sel_registerName("serviceID")) ? instance : nil;
}
static id service(uint32_t page, uint32_t usage, BOOL builtIn) { return serviceWith(page, usage, builtIn, nil); }

// Touch goes through guest digitizer services, one per integrated panel, bound
// to the panel by its CADisplay uniqueId (what Device Hub's dtuhidd does for its
// own touchscreens). Unlike the host's legacy Indigo/SimHIDVirtualService path,
// these keep working while Device Hub has disconnected legacy input
// (com.apple.coredevice.dtuhidd.active = 1). Display UUIDs change every boot;
// the helper is respawned per boot. Coordinates are normalized 0..1 in the
// panel's native portrait frame, the same space as the legacy path.
static NSString *displayUniqueId(NSString *deviceName) {
    dlopen("/System/Library/Frameworks/QuartzCore.framework/QuartzCore", RTLD_NOW);
    Class displayClass = NSClassFromString(@"CADisplay");
    if (!displayClass) return nil;
    NSArray *displays = ((id (*)(id, SEL))objc_msgSend)(displayClass, sel_registerName("displays"));
    for (id display in displays) {
        @try {
            if ([[display valueForKey:@"deviceName"] isEqual:deviceName]) return [display valueForKey:@"uniqueId"];
        } @catch (__unused id error) {}
    }
    return nil;
}
static id touchscreen(NSString *deviceName) {
    NSString *uid = displayUniqueId(deviceName);
    if (!uid.length) return nil;
    return serviceWith(0x0d, 0x04, YES, @{
        @"displayUUID": uid, @"UniversalControlVirtualService": @YES,
        @"Product": [NSString stringWithFormat:@"serve-sim touchscreen(%@)", uid],
    });
}
typedef CFTypeRef (*DigitizerFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double, Boolean, Boolean, uint32_t);
typedef CFTypeRef (*FingerFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double, Boolean, Boolean, uint32_t);
static DigitizerFn digitizerEvent;
static FingerFn fingerEvent;
static void (*appendEvent)(CFTypeRef, CFTypeRef, uint32_t);
static void (*setIntegerValue)(CFTypeRef, uint32_t, long);
enum { kRange = 0x1, kTouch = 0x2, kPosition = 0x4, kIdentity = 0x20, kHand = 3, kDisplayIntegratedField = (11 << 16) | 25 };
/// One hand event with `count` finger children. `type` is begin|move|end.
static CFTypeRef touchEvent(const char *type, const double *xs, const double *ys, int count) {
    if (!digitizerEvent || !fingerEvent || !appendEvent || !setIntegerValue) return NULL;
    BOOL down = strcmp(type, "end") != 0;
    uint32_t mask = strcmp(type, "move") == 0 ? kPosition : (kRange | kTouch | kIdentity);
    uint64_t now = mach_absolute_time();
    CFTypeRef hand = digitizerEvent(NULL, now, kHand, 0, 0, mask, 0, xs[0], ys[0], 0, 0, 0, down, down, 0);
    if (!hand) return NULL;
    setIntegerValue(hand, kDisplayIntegratedField, 1);
    for (int i = 0; i < count; i++) {
        CFTypeRef finger = fingerEvent(NULL, now, (uint32_t)i + 1, (uint32_t)i + 2, mask, xs[i], ys[i], 0, down ? 1 : 0, 0, down, down, 0);
        if (!finger) { CFRelease(hand); return NULL; }
        appendEvent(hand, finger, 0);
        CFRelease(finger);
    }
    return hand;
}
static BOOL validPhase(const char *type) { return !strcmp(type, "begin") || !strcmp(type, "move") || !strcmp(type, "end"); }
static BOOL unit(double v) { return isfinite(v) && v >= 0 && v <= 1; }

// This simulator's backboardd: the child of our own launchd_sim (simulator
// processes are host processes, so other simulators' backboardds are visible).
static pid_t parentOf(pid_t pid, char name[MAXCOMLEN + 1]) {
    struct kinfo_proc info; size_t size = sizeof info;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) return -1;
    if (name) strlcpy(name, info.kp_proc.p_comm, MAXCOMLEN + 1);
    return info.kp_eproc.e_ppid;
}
static pid_t simulatorLaunchd(void) {
    char name[MAXCOMLEN + 1];
    for (pid_t pid = getppid(); pid > 1;) {
        pid_t parent = parentOf(pid, name);
        if (strcmp(name, "launchd_sim") == 0) return pid;
        pid = parent;
    }
    return -1;
}
static pid_t backboarddPid(pid_t launchd) {
    if (launchd <= 1) return -1;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    size_t size = 0;
    if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size == 0) return -1;
    size += 64 * sizeof(struct kinfo_proc);
    struct kinfo_proc *procs = malloc(size);
    pid_t found = -1;
    if (procs && sysctl(mib, 3, procs, &size, NULL, 0) == 0) {
        for (size_t i = 0; i < size / sizeof(struct kinfo_proc); i++) {
            if (procs[i].kp_eproc.e_ppid == launchd && strcmp(procs[i].kp_proc.p_comm, "backboardd") == 0) { found = procs[i].kp_proc.p_pid; break; }
        }
    }
    free(procs);
    return found;
}
// HID virtual services die with the backboardd they registered with, and the
// replacement backboardd refuses this process's reconnect ("bundleID is
// missing"). Exit instead of acking events into dead services; the host
// respawns the helper on its next command.
static void exitWhenBackboarddIsReplaced(void) {
    pid_t launchd = simulatorLaunchd();
    pid_t original = backboarddPid(launchd);
    if (original <= 0) return;
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), 250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(timer, ^{
        if (backboarddPid(launchd) != original) {
            fprintf(stderr, "backboardd was replaced; exiting so serve-sim restarts the Duo guest helper\n");
            _exit(75);
        }
    });
    dispatch_resume(timer);
    (void)CFBridgingRetain(timer);
}

static BOOL sendEvent(id service, CFTypeRef event) {
    if (!event) return NO;
    BOOL ok = ((BOOL (*)(id, SEL, id))objc_msgSend)(service, sel_registerName("dispatchEvent:"), (__bridge id)event);
    CFRelease(event);
    return ok;
}
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "watch-angle") == 0) return watchAngle();
        if (argc == 3 && strcmp(argv[1], "watch-notify") == 0) return watchNotify(argv[2]);
        if (argc != 1) { fprintf(stderr, "usage: serve-sim-duo-hid [watch-angle | watch-notify <name>]\n"); return 64; }
        dlopen("/System/Library/PrivateFrameworks/HID.framework/HID", RTLD_NOW);
        void *io = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
        CFTypeRef (*vendor)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, const void *, CFIndex, uint32_t) = dlsym(io, "IOHIDEventCreateVendorDefinedEvent");
        CFTypeRef (*keyboard)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, Boolean, uint32_t) = dlsym(io, "IOHIDEventCreateKeyboardEvent");
        exitWhenBackboarddIsReplaced();
        id hinge = service(0xff61, 0x5b, NO), buttons = service(0x0b, 1, YES);
        if (!vendor || !keyboard || !hinge || !buttons) { fprintf(stderr, "Duo HID service unavailable\n"); return 1; }
        digitizerEvent = dlsym(io, "IOHIDEventCreateDigitizerEvent");
        fingerEvent = dlsym(io, "IOHIDEventCreateDigitizerFingerEvent");
        appendEvent = dlsym(io, "IOHIDEventAppendEvent");
        setIntegerValue = dlsym(io, "IOHIDEventSetIntegerValue");
        // Missing displays leave that touchscreen nil; its touch commands reply ERROR
        // and the host falls back to legacy input.
        NSMutableDictionary<NSString *, id> *touchscreens = [NSMutableDictionary dictionary];
        for (NSString *name in @[@"primary", @"primary-1"]) {
            id screen = touchscreen(name);
            if (screen) touchscreens[name] = screen;
            else fprintf(stderr, "Duo touchscreen unavailable for display %s\n", name.UTF8String);
        }
        usleep(300000); // Allow backboardd to enumerate the new services.
        char *line = NULL; size_t capacity = 0;
        while (getline(&line, &capacity, stdin) > 0) {
            @autoreleasepool {
                double angle, from, milliseconds; unsigned page, usage, down, orientation; char extra;
                double tx[2], ty[2]; char display[16], phase[8];
                BOOL ok = NO;
                if (strcmp(line, "ping\n") == 0) {
                    ok = YES;
                } else if (sscanf(line, "touch %15s %7s %lf %lf %c", display, phase, &tx[0], &ty[0], &extra) == 4 &&
                           validPhase(phase) && unit(tx[0]) && unit(ty[0])) {
                    id screen = touchscreens[@(display)];
                    if (screen) ok = sendEvent(screen, touchEvent(phase, tx, ty, 1));
                } else if (sscanf(line, "touch2 %15s %7s %lf %lf %lf %lf %c", display, phase, &tx[0], &ty[0], &tx[1], &ty[1], &extra) == 6 &&
                           validPhase(phase) && unit(tx[0]) && unit(ty[0]) && unit(tx[1]) && unit(ty[1])) {
                    id screen = touchscreens[@(display)];
                    if (screen) ok = sendEvent(screen, touchEvent(phase, tx, ty, 2));
                } else if (sscanf(line, "angle %lf %c", &angle, &extra) == 1 && isfinite(angle) && angle >= 0 && angle <= 180) {
                    NSData *payload = hingePayload(angle);
                    ok = sendEvent(hinge, vendor(NULL, mach_absolute_time(), 0xff61, 0x5b, 0, payload.bytes, payload.length, 0));
                } else if (sscanf(line, "sweep %lf %lf %lf %c", &from, &angle, &milliseconds, &extra) == 3 &&
                           isfinite(from) && from >= 0 && from <= 180 &&
                           isfinite(angle) && angle >= 0 && angle <= 180 &&
                           isfinite(milliseconds) && milliseconds >= 0 && milliseconds <= 1500) {
                    int frames = MAX(1, (int)ceil(milliseconds / 16.667));
                    ok = YES;
                    for (int i = 1; i <= frames; i++) {
                        double progress = (double)i / frames;
                        double eased = 1 - pow(1 - progress, 3);
                        NSData *payload = hingePayload(from + (angle - from) * eased);
                        if (!sendEvent(hinge, vendor(NULL, mach_absolute_time(), 0xff61, 0x5b, 0, payload.bytes, payload.length, 0))) {
                            ok = NO; break;
                        }
                        if (i < frames) usleep((useconds_t)(milliseconds * 1000 / frames));
                    }
                } else if (sscanf(line, "orientation %u %c", &orientation, &extra) == 1) {
                    NSData *payload = orientationPayload(orientation);
                    if (payload) ok = sendEvent(hinge, vendor(NULL, mach_absolute_time(), 0xff61, 0x5b, 0, payload.bytes, payload.length, 0));
                } else if (sscanf(line, "key %u %u %u %c", &page, &usage, &down, &extra) == 3 && page <= 65535 && usage <= 65535 && down <= 1) {
                    ok = sendEvent(buttons, keyboard(NULL, mach_absolute_time(), page, usage, down, 0));
                }
                puts(ok ? "OK" : "ERROR"); fflush(stdout);
            }
        }
        free(line);
        ((void (*)(id, SEL))objc_msgSend)(hinge, sel_registerName("cancel"));
        ((void (*)(id, SEL))objc_msgSend)(buttons, sel_registerName("cancel"));
        for (id screen in touchscreens.allValues) ((void (*)(id, SEL))objc_msgSend)(screen, sel_registerName("cancel"));
    }
    return 0;
}
