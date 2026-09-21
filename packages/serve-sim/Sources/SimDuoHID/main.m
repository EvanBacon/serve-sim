// Guest HID transport for hinge angles and hardware buttons.
// Spawned inside iOS Simulator; one command/reply per line until EOF.
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <math.h>
#import <unistd.h>

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
static void string(NSMutableData *data, const char *text, BOOL key) {
    size_t length = strlen(text) + (key ? 1 : 0);
    header(data, (uint32_t)length, key ? 8 : 9);
    [data appendBytes:text length:length];
    while (data.length % 4) { uint8_t zero = 0; [data appendBytes:&zero length:1]; }
}
static NSData *hingePayload(double degrees) {
    NSMutableData *data = [NSMutableData data];
    header(data, 0xd3, 0);
    header(data, 4, 0x81);
    string(data, "provider", YES); string(data, "com.apple.Virtualization.VirtualMachines", NO);
    string(data, "source", YES); string(data, "hinge-slider-control", NO);
    string(data, "type", YES); string(data, "range", NO);
    string(data, "value", YES); header(data, 0x3f, 0x84);
    [data appendBytes:&degrees length:sizeof(degrees)];
    return data;
}
static id service(uint32_t page, uint32_t usage, BOOL builtIn) {
    Class cls = NSClassFromString(@"HIDVirtualEventService");
    if (!cls) return nil;
    id instance = [[cls alloc] init];
    DuoServiceDelegate *delegate = [DuoServiceDelegate new];
    delegate.properties = @{
        @"PrimaryUsagePage": @(page), @"PrimaryUsage": @(usage),
        @"DeviceUsagePairs": @[@{@"DeviceUsagePage": @(page), @"DeviceUsage": @(usage)}],
        @"Transport": @"CoreDevice", @"Product": @"serve-sim Duo HID",
        @"Built-In": @(builtIn), @"VendorID": @0, @"ProductID": @0,
        @"VersionNumber": @0, @"ReportInterval": @8000,
    };
    objc_setAssociatedObject(instance, @selector(properties), delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    ((void (*)(id, SEL, id))objc_msgSend)(instance, sel_registerName("setDelegate:"), delegate);
    dispatch_queue_t queue = dispatch_queue_create("serve-sim.duo", DISPATCH_QUEUE_SERIAL);
    ((void (*)(id, SEL, id))objc_msgSend)(instance, sel_registerName("setDispatchQueue:"), queue);
    ((void (*)(id, SEL))objc_msgSend)(instance, sel_registerName("activate"));
    return ((uint64_t (*)(id, SEL))objc_msgSend)(instance, sel_registerName("serviceID")) ? instance : nil;
}
static BOOL sendEvent(id service, CFTypeRef event) {
    if (!event) return NO;
    BOOL ok = ((BOOL (*)(id, SEL, id))objc_msgSend)(service, sel_registerName("dispatchEvent:"), (__bridge id)event);
    CFRelease(event);
    return ok;
}
int main(void) {
    @autoreleasepool {
        dlopen("/System/Library/PrivateFrameworks/HID.framework/HID", RTLD_NOW);
        void *io = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
        CFTypeRef (*vendor)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, const void *, CFIndex, uint32_t) = dlsym(io, "IOHIDEventCreateVendorDefinedEvent");
        CFTypeRef (*keyboard)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, Boolean, uint32_t) = dlsym(io, "IOHIDEventCreateKeyboardEvent");
        id hinge = service(0xff61, 0x5b, NO), buttons = service(0x0b, 1, YES);
        if (!vendor || !keyboard || !hinge || !buttons) { fprintf(stderr, "Duo HID service unavailable\n"); return 1; }
        usleep(300000); // Allow backboardd to enumerate the new services.
        char *line = NULL; size_t capacity = 0;
        while (getline(&line, &capacity, stdin) > 0) {
            @autoreleasepool {
                double angle, from, milliseconds; unsigned page, usage, down; char extra;
                BOOL ok = NO;
                if (sscanf(line, "angle %lf %c", &angle, &extra) == 1 && isfinite(angle) && angle >= 0 && angle <= 180) {
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
                } else if (sscanf(line, "key %u %u %u %c", &page, &usage, &down, &extra) == 3 && page <= 65535 && usage <= 65535 && down <= 1) {
                    ok = sendEvent(buttons, keyboard(NULL, mach_absolute_time(), page, usage, down, 0));
                }
                puts(ok ? "OK" : "ERROR"); fflush(stdout);
            }
        }
        free(line);
        ((void (*)(id, SEL))objc_msgSend)(hinge, sel_registerName("cancel"));
        ((void (*)(id, SEL))objc_msgSend)(buttons, sel_registerName("cancel"));
    }
    return 0;
}
