// Experimental view-hierarchy agent for serve-sim's 3D inspector
// (`serve-sim --experimental-hierarchy-3d`).
//
// Injected with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES by `serve-sim hierarchy
// <bundle-id>`. When SERVE_SIM_HIERARCHY_DIR is set it starts a loopback-only
// HTTP server on an ephemeral port and records {port, token, pid, bundleId}
// in an owner-only registry file in that directory so the host can find it.
//
//   GET /info                         app state (cheap; no main-thread walk
//                                     beyond reading applicationState)
//   GET /hierarchy?snapshots=1&scale=2
//                                     serialize every UIWindow's UIView tree on
//                                     the main thread; optionally render one
//                                     PNG per view with its subviews hidden
//   GET /snapshot/<capture>/<id>.png  a PNG from one of the last captures
//
// Every request must carry `X-Serve-Sim-Token: <token>`.

#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *gToken;
static NSString *gRegistryPath;
static NSObject *gCaptureLock;
// captureId -> { viewId -> NSData(PNG) }. Only the newest few are kept so
// clients still fetching textures for the previous capture don't 404.
static NSMutableDictionary<NSString *, NSDictionary<NSString *, NSData *> *> *gCaptures;
static NSMutableArray<NSString *> *gCaptureOrder;
static NSUInteger gCaptureSeq;

static const NSUInteger kMaxNodes = 4000;
static const NSUInteger kMaxDepth = 256;
static const NSUInteger kKeptCaptures = 2;
static const double kMaxPixelsPerView = 4.0e6;
static const double kMaxPixelsPerCapture = 48.0e6;

static void shlog(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
static void shlog(NSString *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
  va_end(args);
  NSLog(@"[serve-sim-hierarchy] %@", msg);
}

#pragma mark - Serialization helpers

static NSDictionary *RectDict(CGRect r) {
  if (CGRectIsNull(r) || CGRectIsInfinite(r)) r = CGRectZero;
  return @{ @"x": @(r.origin.x), @"y": @(r.origin.y), @"width": @(r.size.width), @"height": @(r.size.height) };
}

static id ColorValue(UIColor *color, UITraitCollection *traits) {
  if (!color) return [NSNull null];
  UIColor *resolved = traits ? [color resolvedColorWithTraitCollection:traits] : color;
  CGFloat r = 0, g = 0, b = 0, a = 0;
  if (![resolved getRed:&r green:&g blue:&b alpha:&a]) {
    CGFloat w = 0;
    if ([resolved getWhite:&w alpha:&a]) { r = g = b = w; }
    else return [NSNull null]; // pattern colors etc.
  }
  return @[ @(r), @(g), @(b), @(a) ];
}

static NSString *Truncated(NSString *s, NSUInteger max) {
  if (![s isKindOfClass:[NSString class]]) return nil;
  if (s.length <= max) return s;
  return [[s substringToIndex:max] stringByAppendingString:@"…"];
}

static NSArray<NSString *> *SuperclassChain(Class cls) {
  NSMutableArray *chain = [NSMutableArray array];
  Class c = class_getSuperclass(cls);
  while (c && chain.count < 8) {
    [chain addObject:NSStringFromClass(c)];
    if (c == [UIView class] || c == [NSObject class]) break;
    c = class_getSuperclass(c);
  }
  return chain;
}

static NSString *ViewId(id obj) { return [NSString stringWithFormat:@"%p", obj]; }

static NSString *ContentModeName(UIViewContentMode mode) {
  switch (mode) {
    case UIViewContentModeScaleToFill: return @"scaleToFill";
    case UIViewContentModeScaleAspectFit: return @"scaleAspectFit";
    case UIViewContentModeScaleAspectFill: return @"scaleAspectFill";
    case UIViewContentModeRedraw: return @"redraw";
    case UIViewContentModeCenter: return @"center";
    case UIViewContentModeTop: return @"top";
    case UIViewContentModeBottom: return @"bottom";
    case UIViewContentModeLeft: return @"left";
    case UIViewContentModeRight: return @"right";
    default: return @"other";
  }
}

/// Class-specific properties worth showing in the inspector.
static NSDictionary *ExtraProps(UIView *view) {
  NSMutableDictionary *p = [NSMutableDictionary dictionary];
  if ([view isKindOfClass:[UILabel class]]) {
    UILabel *l = (UILabel *)view;
    p[@"text"] = Truncated(l.text, 300) ?: @"";
    p[@"font"] = [NSString stringWithFormat:@"%@ %.1f", l.font.fontName, l.font.pointSize];
    p[@"numberOfLines"] = @(l.numberOfLines);
    id c = ColorValue(l.textColor, view.traitCollection);
    if (c != [NSNull null]) p[@"textColor"] = c;
  } else if ([view isKindOfClass:[UIButton class]]) {
    UIButton *b = (UIButton *)view;
    if (b.currentTitle) p[@"title"] = Truncated(b.currentTitle, 200);
    p[@"enabled"] = @(b.enabled);
    p[@"selected"] = @(b.selected);
  } else if ([view isKindOfClass:[UITextField class]]) {
    UITextField *t = (UITextField *)view;
    p[@"text"] = t.secureTextEntry ? @"•••" : (Truncated(t.text, 300) ?: @"");
    if (t.placeholder) p[@"placeholder"] = Truncated(t.placeholder, 200);
  } else if ([view isKindOfClass:[UITextView class]]) {
    UITextView *t = (UITextView *)view;
    p[@"text"] = Truncated(t.text, 300) ?: @"";
  } else if ([view isKindOfClass:[UIImageView class]]) {
    UIImage *img = ((UIImageView *)view).image;
    if (img) {
      p[@"imageSize"] = [NSString stringWithFormat:@"%.0f×%.0f @%.0fx", img.size.width, img.size.height, img.scale];
      if (img.isSymbolImage) p[@"symbolImage"] = @YES;
    }
  } else if ([view isKindOfClass:[UISwitch class]]) {
    p[@"on"] = @(((UISwitch *)view).on);
  } else if ([view isKindOfClass:[UISlider class]]) {
    p[@"value"] = @(((UISlider *)view).value);
  } else if ([view isKindOfClass:[UISegmentedControl class]]) {
    p[@"selectedSegmentIndex"] = @(((UISegmentedControl *)view).selectedSegmentIndex);
  }
  if ([view isKindOfClass:[UIScrollView class]]) {
    UIScrollView *s = (UIScrollView *)view;
    p[@"contentOffset"] = [NSString stringWithFormat:@"{%.1f, %.1f}", s.contentOffset.x, s.contentOffset.y];
    p[@"contentSize"] = [NSString stringWithFormat:@"{%.1f, %.1f}", s.contentSize.width, s.contentSize.height];
    UIEdgeInsets i = s.adjustedContentInset;
    p[@"adjustedContentInset"] = [NSString stringWithFormat:@"{%.1f, %.1f, %.1f, %.1f}", i.top, i.left, i.bottom, i.right];
  }
  if ([view isKindOfClass:[UIWindow class]]) {
    UIWindow *w = (UIWindow *)view;
    p[@"windowLevel"] = @(w.windowLevel);
    p[@"keyWindow"] = @(w.isKeyWindow);
    if (w.rootViewController) p[@"rootViewController"] = NSStringFromClass([w.rootViewController class]);
  }
  CALayer *layer = view.layer;
  if (layer.cornerRadius > 0) p[@"cornerRadius"] = @(layer.cornerRadius);
  if (layer.borderWidth > 0) {
    p[@"borderWidth"] = @(layer.borderWidth);
    UIColor *bc = layer.borderColor ? [UIColor colorWithCGColor:layer.borderColor] : nil;
    id c = ColorValue(bc, nil);
    if (c != [NSNull null]) p[@"borderColor"] = c;
  }
  if (layer.shadowOpacity > 0) p[@"shadowOpacity"] = @(layer.shadowOpacity);
  if (layer.mask) p[@"masked"] = @YES;
  if (!CATransform3DIsIdentity(layer.transform)) p[@"transformed"] = @YES;
  if (layer.sublayers.count > view.subviews.count) {
    p[@"extraSublayers"] = @(layer.sublayers.count - view.subviews.count);
  }
  return p;
}

#pragma mark - Snapshots

typedef struct {
  CGFloat scale;
  double pixelBudget;
  BOOL enabled;
} SnapshotConfig;

/// Render `view`'s own layer content (its subview layers hidden) and crop to
/// the drawn pixels. Returns nil for fully transparent views. `outRect` is the
/// cropped rect in the view's bounds coordinate space.
static NSData *SnapshotViewUnpooled(UIView *view, SnapshotConfig *cfg, CGRect *outRect);

/// Per-view pool: the full-size bitmap behind each cropped image would
/// otherwise stay alive until the whole walk finishes.
static NSData *SnapshotView(UIView *view, SnapshotConfig *cfg, CGRect *outRect) {
  @autoreleasepool {
    return SnapshotViewUnpooled(view, cfg, outRect);
  }
}

static NSData *SnapshotViewUnpooled(UIView *view, SnapshotConfig *cfg, CGRect *outRect) {
  if (!cfg->enabled || view.hidden || view.layer.hidden) return nil;
  CGRect bounds = view.layer.bounds;
  double w = bounds.size.width, h = bounds.size.height;
  if (!(w >= 1 && h >= 1) || !isfinite(w) || !isfinite(h)) return nil;

  double scale = cfg->scale;
  double area = w * h;
  if (area * scale * scale > kMaxPixelsPerView) scale = sqrt(kMaxPixelsPerView / area);
  if (area * scale * scale > cfg->pixelBudget) {
    scale = sqrt(cfg->pixelBudget / area);
    if (scale < 0.25) return nil;
  }
  size_t pw = (size_t)ceil(w * scale), ph = (size_t)ceil(h * scale);
  if (pw == 0 || ph == 0) return nil;

  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(NULL, pw, ph, 8, 0, cs,
                                           kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(cs);
  if (!ctx) return nil;
  cfg->pixelBudget -= (double)pw * (double)ph;

  CGContextTranslateCTM(ctx, 0, ph);
  CGContextScaleCTM(ctx, scale, -scale);
  CGContextTranslateCTM(ctx, -bounds.origin.x, -bounds.origin.y);

  // Hide child view layers so the snapshot is only this view's own drawing
  // (background, border, layer contents, non-view sublayers). Restored before
  // returning to the run loop, so the on-screen render server never sees it.
  NSMutableArray<CALayer *> *hidden = [NSMutableArray array];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (UIView *sub in view.subviews) {
    if (!sub.layer.hidden) {
      sub.layer.hidden = YES;
      [hidden addObject:sub.layer];
    }
  }
  float savedOpacity = view.layer.opacity;
  view.layer.opacity = 1;
  @try {
    [view.layer renderInContext:ctx];
  } @catch (NSException *e) {
    shlog(@"renderInContext failed for %@: %@", NSStringFromClass([view class]), e);
  }
  view.layer.opacity = savedOpacity;
  for (CALayer *l in hidden) l.hidden = NO;
  [CATransaction commit];

  // Bounding box of non-transparent pixels.
  const uint8_t *data = CGBitmapContextGetData(ctx);
  size_t stride = CGBitmapContextGetBytesPerRow(ctx);
  size_t minX = pw, minY = ph, maxX = 0, maxY = 0;
  BOOL any = NO;
  for (size_t y = 0; y < ph; y++) {
    const uint8_t *row = data + y * stride;
    for (size_t x = 0; x < pw; x++) {
      if (row[x * 4 + 3] != 0) {
        any = YES;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!any) {
    // Transparent containers are common (and often full-screen); don't let
    // them spend the budget the views with real content need.
    cfg->pixelBudget += (double)pw * (double)ph;
    CGContextRelease(ctx);
    return nil;
  }
  CGImageRef full = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  CGRect cropPx = CGRectMake(minX, minY, maxX - minX + 1, maxY - minY + 1);
  CGImageRef cropped = CGImageCreateWithImageInRect(full, cropPx);
  CGImageRelease(full);
  if (!cropped) return nil;
  NSData *png = UIImagePNGRepresentation([UIImage imageWithCGImage:cropped]);
  CGImageRelease(cropped);
  *outRect = CGRectMake(bounds.origin.x + cropPx.origin.x / scale,
                        bounds.origin.y + cropPx.origin.y / scale,
                        cropPx.size.width / scale,
                        cropPx.size.height / scale);
  return png;
}

#pragma mark - Tree walk

typedef struct {
  NSUInteger count;
  BOOL truncated;
} WalkState;

static UIViewController *OwningViewController(UIView *view) {
  UIResponder *next = view.nextResponder;
  if ([next isKindOfClass:[UIViewController class]] && ((UIViewController *)next).viewIfLoaded == view) {
    return (UIViewController *)next;
  }
  return nil;
}

static NSDictionary *SerializeView(UIView *view, NSUInteger depth, NSUInteger zIndex,
                                   id<UICoordinateSpace> space, SnapshotConfig *cfg,
                                   NSMutableDictionary<NSString *, NSData *> *pngs, WalkState *walk) {
  walk->count++;
  NSString *vid = ViewId(view);
  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  node[@"id"] = vid;
  node[@"class"] = NSStringFromClass([view class]);
  node[@"superclasses"] = SuperclassChain([view class]);
  node[@"layerClass"] = NSStringFromClass([view.layer class]);
  node[@"frame"] = RectDict([view convertRect:view.bounds toCoordinateSpace:space]);
  node[@"localFrame"] = RectDict(view.frame);
  node[@"bounds"] = RectDict(view.bounds);
  node[@"alpha"] = @(view.alpha);
  node[@"hidden"] = @(view.hidden);
  node[@"clipsToBounds"] = @(view.clipsToBounds || view.layer.masksToBounds);
  node[@"opaque"] = @(view.opaque);
  node[@"userInteractionEnabled"] = @(view.userInteractionEnabled);
  node[@"backgroundColor"] = ColorValue(view.backgroundColor, view.traitCollection);
  node[@"contentMode"] = ContentModeName(view.contentMode);
  node[@"tag"] = @(view.tag);
  node[@"zIndex"] = @(zIndex);
  if (view.accessibilityIdentifier.length) node[@"accessibilityIdentifier"] = Truncated(view.accessibilityIdentifier, 200);
  if (view.accessibilityLabel.length) node[@"accessibilityLabel"] = Truncated(view.accessibilityLabel, 200);
  UIViewController *vc = OwningViewController(view);
  if (vc) node[@"viewController"] = NSStringFromClass([vc class]);
  node[@"props"] = ExtraProps(view);

  CGRect snapRect = CGRectZero;
  NSData *png = SnapshotView(view, cfg, &snapRect);
  if (png) {
    pngs[vid] = png;
    node[@"snapshot"] = @{
      @"frame": RectDict([view convertRect:snapRect toCoordinateSpace:space]),
      @"bytes": @(png.length),
    };
  }

  NSMutableArray *children = [NSMutableArray array];
  if (depth < kMaxDepth) {
    NSUInteger i = 0;
    for (UIView *sub in view.subviews) {
      if (walk->count >= kMaxNodes) { walk->truncated = YES; break; }
      [children addObject:SerializeView(sub, depth + 1, i++, space, cfg, pngs, walk)];
    }
  } else if (view.subviews.count) {
    walk->truncated = YES;
  }
  node[@"children"] = children;
  return node;
}

static NSString *AppStateName(UIApplicationState s) {
  switch (s) {
    case UIApplicationStateActive: return @"active";
    case UIApplicationStateInactive: return @"inactive";
    case UIApplicationStateBackground: return @"background";
  }
  return @"unknown";
}

static NSArray<UIWindow *> *VisibleWindows(UIScreen **outScreen) {
  NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    if (scene.activationState == UISceneActivationStateBackground ||
        scene.activationState == UISceneActivationStateUnattached) continue;
    UIWindowScene *ws = (UIWindowScene *)scene;
    if (outScreen && !*outScreen) *outScreen = ws.screen;
    for (UIWindow *w in ws.windows) {
      if (!w.hidden && w.alpha > 0) [windows addObject:w];
    }
  }
  // Back-to-front, like the window server composites them. The sort is
  // stable, so equal levels keep their scene order.
  [windows sortWithOptions:NSSortStable usingComparator:^NSComparisonResult(UIWindow *a, UIWindow *b) {
    if (a.windowLevel < b.windowLevel) return NSOrderedAscending;
    if (a.windowLevel > b.windowLevel) return NSOrderedDescending;
    return NSOrderedSame;
  }];
  return windows;
}

/// Run `work` on the main thread, waiting at most `seconds`. On timeout the
/// block still runs later (callers must tolerate that) and NO is returned,
/// so a hung main thread can't park connection threads forever.
static BOOL RunOnMainBounded(dispatch_block_t work, double seconds) {
  if ([NSThread isMainThread]) {
    work();
    return YES;
  }
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_main_queue(), ^{
    work();
    dispatch_semaphore_signal(done);
  });
  return dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC))) == 0;
}

static NSDictionary *InfoDict(void) {
  __block NSString *state = @"unknown";
  RunOnMainBounded(^{ state = AppStateName(UIApplication.sharedApplication.applicationState); }, 2);
  return @{
    @"protocol": @1,
    @"pid": @(getpid()),
    @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
    @"appState": state,
  };
}

/// `onFinished` runs once the walk has actually finished on the main thread,
/// which after a timeout is later than this function returns.
static NSDictionary *CaptureHierarchy(BOOL snapshots, CGFloat requestedScale, dispatch_block_t onFinished) {
  __block NSDictionary *result = nil;
  dispatch_block_t work = ^{
    @autoreleasepool {
      CFTimeInterval t0 = CACurrentMediaTime();
      UIScreen *screen = nil;
      NSArray<UIWindow *> *windows = VisibleWindows(&screen);
      if (!screen) screen = windows.firstObject.screen;
      CGFloat screenScale = screen ? screen.scale : 2;
      SnapshotConfig cfg = {
        .scale = requestedScale > 0 ? MIN(requestedScale, screenScale) : MIN(screenScale, 2),
        .pixelBudget = kMaxPixelsPerCapture,
        .enabled = snapshots,
      };
      NSMutableDictionary<NSString *, NSData *> *pngs = [NSMutableDictionary dictionary];
      WalkState walk = {0, NO};
      NSMutableArray *roots = [NSMutableArray array];
      id<UICoordinateSpace> space = screen ? screen.coordinateSpace : windows.firstObject;
      NSUInteger i = 0;
      for (UIWindow *w in windows) {
        if (walk.count >= kMaxNodes) { walk.truncated = YES; break; }
        [roots addObject:SerializeView(w, 0, i++, space, &cfg, pngs, &walk)];
      }
      CGRect sb = screen ? screen.bounds : CGRectMake(0, 0, 1, 1);
      NSString *captureId;
      @synchronized (gCaptureLock) {
        captureId = [NSString stringWithFormat:@"c%lu", (unsigned long)++gCaptureSeq];
        gCaptures[captureId] = pngs;
        [gCaptureOrder addObject:captureId];
        while (gCaptureOrder.count > kKeptCaptures) {
          [gCaptures removeObjectForKey:gCaptureOrder.firstObject];
          [gCaptureOrder removeObjectAtIndex:0];
        }
      }
      result = @{
        @"protocol": @1,
        @"source": @"injected",
        @"captureId": captureId,
        @"pid": @(getpid()),
        @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
        @"appState": AppStateName(UIApplication.sharedApplication.applicationState),
        @"screen": @{ @"width": @(sb.size.width), @"height": @(sb.size.height), @"scale": @(screenScale) },
        @"snapshotScale": @(cfg.scale),
        @"nodeCount": @(walk.count),
        @"truncated": @(walk.truncated),
        @"snapshotCount": @(pngs.count),
        @"durationMs": @((CACurrentMediaTime() - t0) * 1000.0),
        @"windows": roots,
      };
    }
    onFinished();
  };
  // Don't block a connection thread forever on a busy/hung main thread. On
  // timeout the walk still runs later; its result is simply dropped.
  if (!RunOnMainBounded(work, 20)) return nil;
  return result;
}

#pragma mark - HTTP server

static void WriteAll(int fd, const void *buf, size_t len) {
  const uint8_t *p = buf;
  while (len > 0) {
    ssize_t n = write(fd, p, len);
    if (n <= 0) return;
    p += n;
    len -= (size_t)n;
  }
}

static void Respond(int fd, int status, NSString *contentType, NSData *body) {
  NSString *reason = status == 200 ? @"OK" : status == 401 ? @"Unauthorized" : status == 404 ? @"Not Found"
                   : status == 500 ? @"Internal Server Error"
                   : status == 503 ? @"Service Unavailable" : @"Bad Request";
  NSString *head = [NSString stringWithFormat:
                    @"HTTP/1.1 %d %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                    status, reason, contentType, (unsigned long)body.length];
  NSData *h = [head dataUsingEncoding:NSUTF8StringEncoding];
  WriteAll(fd, h.bytes, h.length);
  if (body.length) WriteAll(fd, body.bytes, body.length);
}

/// NSJSONSerialization throws on NaN/Inf (degenerate transforms can produce
/// them in frames); replace non-finite numbers so serializing can't crash the app.
static id SanitizeJSON(id obj) {
  if ([obj isKindOfClass:[NSDictionary class]]) {
    NSMutableDictionary *out = [NSMutableDictionary dictionaryWithCapacity:[obj count]];
    [(NSDictionary *)obj enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
      out[key] = SanitizeJSON(value);
    }];
    return out;
  }
  if ([obj isKindOfClass:[NSArray class]]) {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:[obj count]];
    for (id value in (NSArray *)obj) [out addObject:SanitizeJSON(value)];
    return out;
  }
  if ([obj isKindOfClass:[NSNumber class]] && !isfinite([obj doubleValue])) return @0;
  return obj;
}

static void RespondJSON(int fd, int status, id obj) {
  NSData *body = nil;
  @try {
    body = [NSJSONSerialization dataWithJSONObject:SanitizeJSON(obj) options:0 error:nil];
  } @catch (NSException *e) {
    shlog(@"JSON serialization failed: %@", e);
  }
  if (!body) {
    status = 500;
    body = [@"{\"error\":\"serialization_failed\"}" dataUsingEncoding:NSUTF8StringEncoding];
  }
  Respond(fd, status, @"application/json", body);
}

static NSDictionary<NSString *, NSString *> *ParseQuery(NSString *q) {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  for (NSString *pair in [q componentsSeparatedByString:@"&"]) {
    if (!pair.length) continue;
    NSRange eq = [pair rangeOfString:@"="];
    NSString *k = eq.location == NSNotFound ? pair : [pair substringToIndex:eq.location];
    NSString *v = eq.location == NSNotFound ? @"" : [pair substringFromIndex:eq.location + 1];
    out[k.stringByRemovingPercentEncoding ?: k] = v.stringByRemovingPercentEncoding ?: v;
  }
  return out;
}

static BOOL ConstantTimeEqual(NSString *a, NSString *b) {
  NSData *da = [a dataUsingEncoding:NSUTF8StringEncoding];
  NSData *db = [b dataUsingEncoding:NSUTF8StringEncoding];
  if (da.length != db.length) return NO;
  const uint8_t *pa = da.bytes, *pb = db.bytes;
  uint8_t diff = 0;
  for (NSUInteger i = 0; i < da.length; i++) diff |= pa[i] ^ pb[i];
  return diff == 0;
}

static void HandleConnection(int fd) {
  @autoreleasepool {
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);

    NSMutableData *buf = [NSMutableData data];
    uint8_t chunk[4096];
    NSRange end = NSMakeRange(NSNotFound, 0);
    NSData *terminator = [@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding];
    while (buf.length < 16384) {
      ssize_t n = read(fd, chunk, sizeof chunk);
      if (n <= 0) break;
      [buf appendBytes:chunk length:(NSUInteger)n];
      end = [buf rangeOfData:terminator options:0 range:NSMakeRange(0, buf.length)];
      if (end.location != NSNotFound) break;
    }
    if (end.location == NSNotFound) { close(fd); return; }
    NSString *head = [[NSString alloc] initWithData:[buf subdataWithRange:NSMakeRange(0, end.location)]
                                           encoding:NSUTF8StringEncoding];
    NSArray<NSString *> *lines = [head componentsSeparatedByString:@"\r\n"];
    NSArray<NSString *> *parts = [lines.firstObject componentsSeparatedByString:@" "];
    if (parts.count < 2 || ![parts[0] isEqualToString:@"GET"]) {
      RespondJSON(fd, 400, @{ @"error": @"bad_request" });
      close(fd);
      return;
    }
    NSString *token = nil;
    for (NSUInteger i = 1; i < lines.count; i++) {
      NSString *line = lines[i];
      NSRange colon = [line rangeOfString:@":"];
      if (colon.location == NSNotFound) continue;
      NSString *name = [[line substringToIndex:colon.location] lowercaseString];
      if ([name isEqualToString:@"x-serve-sim-token"]) {
        token = [[line substringFromIndex:colon.location + 1]
                 stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
      }
    }
    if (!token || !ConstantTimeEqual(token, gToken)) {
      RespondJSON(fd, 401, @{ @"error": @"unauthorized" });
      close(fd);
      return;
    }

    NSString *target = parts[1];
    NSRange qm = [target rangeOfString:@"?"];
    NSString *path = qm.location == NSNotFound ? target : [target substringToIndex:qm.location];
    NSDictionary *query = qm.location == NSNotFound ? @{} : ParseQuery([target substringFromIndex:qm.location + 1]);

    if ([path isEqualToString:@"/info"]) {
      RespondJSON(fd, 200, InfoDict());
    } else if ([path isEqualToString:@"/hierarchy"]) {
      BOOL snaps = ![query[@"snapshots"] isEqualToString:@"0"];
      CGFloat scale = [query[@"scale"] doubleValue];
      // One capture at a time: overlapping requests would queue several
      // full walks back-to-back on the app's main thread.
      static dispatch_semaphore_t captureGate;
      static dispatch_once_t once;
      dispatch_once(&once, ^{ captureGate = dispatch_semaphore_create(1); });
      if (dispatch_semaphore_wait(captureGate, DISPATCH_TIME_NOW) != 0) {
        RespondJSON(fd, 503, @{ @"error": @"capture_in_progress" });
      } else {
        // Released when the walk finishes, not when we stop waiting for it:
        // after a timeout the walk is still queued on the main thread, and
        // letting the next request queue another would pile them up.
        NSDictionary *capture = CaptureHierarchy(snaps, scale, ^{ dispatch_semaphore_signal(captureGate); });
        RespondJSON(fd, capture ? 200 : 503, capture ?: @{ @"error": @"main_thread_timeout" });
      }
    } else if ([path hasPrefix:@"/snapshot/"]) {
      NSArray<NSString *> *seg = [[path substringFromIndex:10] componentsSeparatedByString:@"/"];
      NSData *png = nil;
      if (seg.count == 2 && [seg[1] hasSuffix:@".png"]) {
        NSString *vid = [seg[1] substringToIndex:seg[1].length - 4];
        @synchronized (gCaptureLock) { png = gCaptures[seg[0]][vid]; }
      }
      if (png) Respond(fd, 200, @"image/png", png);
      else RespondJSON(fd, 404, @{ @"error": @"not_found" });
    } else {
      RespondJSON(fd, 404, @{ @"error": @"not_found" });
    }
    close(fd);
  }
}

static void *AcceptLoop(void *arg) {
  int listener = (int)(intptr_t)arg;
  pthread_setname_np("serve-sim-hierarchy");
  dispatch_queue_t q = dispatch_queue_create("serve-sim.hierarchy.conn", DISPATCH_QUEUE_CONCURRENT);
  for (;;) {
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) {
      if (errno == EINTR) continue;
      // ECONNABORTED / EMFILE etc. are transient; back off instead of
      // going deaf for the rest of the process's life.
      shlog(@"accept failed: %d", errno);
      usleep(100 * 1000);
      continue;
    }
    dispatch_async(q, ^{ HandleConnection(fd); });
  }
  return NULL;
}

static NSString *RandomToken(void) {
  uint8_t bytes[24];
  arc4random_buf(bytes, sizeof bytes);
  NSMutableString *s = [NSMutableString stringWithCapacity:48];
  for (size_t i = 0; i < sizeof bytes; i++) [s appendFormat:@"%02x", bytes[i]];
  return s;
}

static void RemoveRegistry(void) {
  if (gRegistryPath) unlink(gRegistryPath.fileSystemRepresentation);
}

static BOOL WriteRegistry(NSString *dir, uint16_t port) {
  mkdir(dir.fileSystemRepresentation, 0700);
  NSString *path = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%d.json", getpid()]];
  NSString *tmp = [path stringByAppendingString:@".tmp"];
  NSDictionary *rec = @{
    @"protocol": @1,
    @"pid": @(getpid()),
    @"port": @(port),
    @"token": gToken,
    @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
    @"udid": NSProcessInfo.processInfo.environment[@"SIMULATOR_UDID"] ?: @"",
    @"startedAt": @((long long)(NSDate.date.timeIntervalSince1970 * 1000)),
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:rec options:0 error:nil];
  int fd = open(tmp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return NO;
  WriteAll(fd, json.bytes, json.length);
  close(fd);
  if (rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation) != 0) return NO;
  gRegistryPath = path;
  atexit(RemoveRegistry);
  return YES;
}

__attribute__((constructor))
static void SimHierarchyInit(void) {
  @autoreleasepool {
    NSString *dir = NSProcessInfo.processInfo.environment[@"SERVE_SIM_HIERARCHY_DIR"];
    if (!dir.length) return;
    gCaptureLock = [NSObject new];
    gCaptures = [NSMutableDictionary dictionary];
    gCaptureOrder = [NSMutableArray array];
    gToken = RandomToken();

    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) { shlog(@"socket failed: %d", errno); return; }
    struct sockaddr_in addr = {0};
    addr.sin_len = sizeof addr;
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(listener, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(listener, 16) != 0) {
      shlog(@"bind/listen failed: %d", errno);
      close(listener);
      return;
    }
    socklen_t len = sizeof addr;
    getsockname(listener, (struct sockaddr *)&addr, &len);
    uint16_t port = ntohs(addr.sin_port);
    if (!WriteRegistry(dir, port)) {
      shlog(@"could not write registry in %@", dir);
      close(listener);
      return;
    }
    pthread_t thread;
    pthread_create(&thread, NULL, AcceptLoop, (void *)(intptr_t)listener);
    pthread_detach(thread);
    shlog(@"listening on 127.0.0.1:%u (pid %d)", port, getpid());
  }
}
