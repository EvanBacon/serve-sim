// Objective-C++ N-API entrypoint for serve-sim-native.node.
//
// This is the in-process replacement boundary for the spawned serve-sim-bin
// helper. It exposes the SimStreamHelper logic (reused verbatim, behind @_cdecl
// shims in sim-hid.swift / sim-capture.swift / sim-ax.swift) as JS functions:
// HID injection, frame capture + encoders, and accessibility dumps.

#include <node_api.h>
#include <cstdlib>
#include <cstring>
#include <string>

// ─── Swift @_cdecl exports ───────────────────────────────────────────────
extern "C" {
void *sim_hid_create(const char *udid, char **errOut);
void sim_hid_destroy(void *handle);
void sim_hid_touch(void *handle, const char *type, double x, double y,
                   int screenWidth, int screenHeight, unsigned edge);
void sim_hid_multi_touch(void *handle, const char *type, double x1, double y1,
                         double x2, double y2, int screenWidth, int screenHeight);
void sim_hid_button(void *handle, const char *button, const char *udid);
void sim_hid_button_hid(void *handle, unsigned page, unsigned usage, const char *phase);
void sim_hid_key(void *handle, const char *type, unsigned usage);
void sim_hid_scroll(void *handle, double dx, double dy, double anchorX, double anchorY,
                    int screenWidth, int screenHeight);
void sim_hid_digital_crown(void *handle, double delta);
bool sim_hid_orientation(void *handle, unsigned orientation);
void sim_hid_memory_warning(void *handle);
void sim_hid_software_keyboard(void *handle);
bool sim_hid_ca_debug(void *handle, const char *name, bool enabled);

// Frame callback invoked on a native encode thread (codec: 0=MJPEG, 1=AVCC).
typedef void (*sim_frame_cb)(void *ctx, int32_t codec, const uint8_t *data, size_t len,
                             int32_t width, int32_t height, int32_t flags);
void *sim_capture_create(const char *udid, sim_frame_cb cb, void *ctx);
bool sim_capture_start(void *handle, char **errOut);
void sim_capture_set_avcc_active(void *handle, bool active);
void sim_capture_request_keyframe(void *handle);
void sim_capture_screen_size(void *handle, int32_t *outW, int32_t *outH);
void sim_capture_stop(void *handle);
void sim_capture_destroy(void *handle);

char *sim_ax_describe(const char *udid, char **errOut);   // axe-shaped JSON, caller frees
char *sim_ax_frontmost(const char *udid, char **errOut);  // {bundleId, pid} JSON, caller frees
}

// ─── N-API helpers ───────────────────────────────────────────────────────
#define NAPI_CALL(env, call)                                              \
  do {                                                                    \
    napi_status _status = (call);                                         \
    if (_status != napi_ok) {                                             \
      napi_throw_error((env), nullptr, #call " failed");                  \
      return nullptr;                                                     \
    }                                                                     \
  } while (0)

static std::string GetString(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return {};
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, &s[0], len + 1, &len);
  return s;
}

static double GetDouble(napi_env env, napi_value v) {
  double d = 0;
  napi_get_value_double(env, v, &d);
  return d;
}

static int32_t GetInt32(napi_env env, napi_value v) {
  int32_t i = 0;
  napi_get_value_int32(env, v, &i);
  return i;
}

static uint32_t GetUint32(napi_env env, napi_value v) {
  uint32_t u = 0;
  napi_get_value_uint32(env, v, &u);
  return u;
}

static bool GetBool(napi_env env, napi_value v) {
  bool b = false;
  napi_get_value_bool(env, v, &b);
  return b;
}

// Reads the HID handle (external) from argv[0].
static void *GetHandle(napi_env env, napi_value v) {
  void *handle = nullptr;
  napi_get_value_external(env, v, &handle);
  return handle;
}

// argv buffer big enough for the widest HID call (8 args incl. handle).
#define READ_ARGS(env, info, n)                                           \
  size_t argc = (n);                                                      \
  napi_value argv[(n)];                                                   \
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr))

// ─── HID surface ─────────────────────────────────────────────────────────
static void HidFinalize(napi_env, void *handle, void *) {
  if (handle) sim_hid_destroy(handle);
}

// hidCreate(udid): External — throws on setup failure.
static napi_value HidCreate(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  std::string udid = GetString(env, argv[0]);
  char *err = nullptr;
  void *handle = sim_hid_create(udid.c_str(), &err);
  if (!handle) {
    napi_throw_error(env, nullptr, err ? err : "HID setup failed");
    free(err);
    return nullptr;
  }
  napi_value external;
  napi_status status = napi_create_external(env, handle, HidFinalize, nullptr, &external);
  if (status != napi_ok) {
    sim_hid_destroy(handle);
    napi_throw_error(env, nullptr, "create_external failed");
    return nullptr;
  }
  return external;
}

// hidTouch(h, type, x, y, w, hh, edge)
static napi_value HidTouch(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 7);
  sim_hid_touch(GetHandle(env, argv[0]), GetString(env, argv[1]).c_str(),
                GetDouble(env, argv[2]), GetDouble(env, argv[3]),
                GetInt32(env, argv[4]), GetInt32(env, argv[5]), GetUint32(env, argv[6]));
  return nullptr;
}

// hidMultiTouch(h, type, x1, y1, x2, y2, w, hh)
static napi_value HidMultiTouch(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 8);
  sim_hid_multi_touch(GetHandle(env, argv[0]), GetString(env, argv[1]).c_str(),
                      GetDouble(env, argv[2]), GetDouble(env, argv[3]),
                      GetDouble(env, argv[4]), GetDouble(env, argv[5]),
                      GetInt32(env, argv[6]), GetInt32(env, argv[7]));
  return nullptr;
}

// hidButton(h, button, udid)
static napi_value HidButton(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 3);
  sim_hid_button(GetHandle(env, argv[0]), GetString(env, argv[1]).c_str(),
                 GetString(env, argv[2]).c_str());
  return nullptr;
}

// hidButtonHid(h, page, usage, phase)
static napi_value HidButtonHid(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 4);
  sim_hid_button_hid(GetHandle(env, argv[0]), GetUint32(env, argv[1]),
                     GetUint32(env, argv[2]), GetString(env, argv[3]).c_str());
  return nullptr;
}

// hidKey(h, type, usage)
static napi_value HidKey(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 3);
  sim_hid_key(GetHandle(env, argv[0]), GetString(env, argv[1]).c_str(), GetUint32(env, argv[2]));
  return nullptr;
}

// hidScroll(h, dx, dy, anchorX, anchorY, w, hh) — NaN anchor = center
static napi_value HidScroll(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 7);
  sim_hid_scroll(GetHandle(env, argv[0]), GetDouble(env, argv[1]), GetDouble(env, argv[2]),
                 GetDouble(env, argv[3]), GetDouble(env, argv[4]),
                 GetInt32(env, argv[5]), GetInt32(env, argv[6]));
  return nullptr;
}

// hidDigitalCrown(h, delta)
static napi_value HidDigitalCrown(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 2);
  sim_hid_digital_crown(GetHandle(env, argv[0]), GetDouble(env, argv[1]));
  return nullptr;
}

// hidOrientation(h, orientation): boolean
static napi_value HidOrientation(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 2);
  bool ok = sim_hid_orientation(GetHandle(env, argv[0]), GetUint32(env, argv[1]));
  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, ok, &result));
  return result;
}

// hidMemoryWarning(h)
static napi_value HidMemoryWarning(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  sim_hid_memory_warning(GetHandle(env, argv[0]));
  return nullptr;
}

// hidSoftwareKeyboard(h)
static napi_value HidSoftwareKeyboard(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  sim_hid_software_keyboard(GetHandle(env, argv[0]));
  return nullptr;
}

// hidCaDebug(h, name, enabled): boolean
static napi_value HidCaDebug(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 3);
  bool ok = sim_hid_ca_debug(GetHandle(env, argv[0]), GetString(env, argv[1]).c_str(),
                             GetBool(env, argv[2]));
  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, ok, &result));
  return result;
}

// ─── Capture surface ─────────────────────────────────────────────────────
//
// Frames are encoded on a native GCD thread and marshalled to JS through a
// threadsafe function. Lifetime: the encode-thread trampoline copies the bytes
// into a FramePayload and enqueues it; FrameCallJs (JS thread) hands JS an
// external Buffer over those bytes and frees them on GC. Teardown
// (CaptureExternalFinalize) calls sim_capture_destroy FIRST — which drains the
// encode queues so no trampoline can fire afterwards — then releases the tsfn;
// the binding is freed in CaptureTsfnFinalize once the tsfn is fully torn down.

struct CaptureBinding {
  void *handle;
  napi_threadsafe_function tsfn;
};

struct FramePayload {
  int32_t codec;
  uint8_t *bytes;  // owned; freed after the Buffer is GC'd (or on drop)
  size_t len;
  int32_t width;
  int32_t height;
  int32_t flags;
};

// Runs on the encode thread. Copies the frame and queues it for JS.
static void FrameTrampoline(void *ctx, int32_t codec, const uint8_t *data, size_t len,
                            int32_t width, int32_t height, int32_t flags) {
  CaptureBinding *b = static_cast<CaptureBinding *>(ctx);
  FramePayload *p = static_cast<FramePayload *>(malloc(sizeof(FramePayload)));
  if (!p) return;
  p->bytes = static_cast<uint8_t *>(malloc(len ? len : 1));
  if (!p->bytes) { free(p); return; }
  memcpy(p->bytes, data, len);
  p->codec = codec; p->len = len; p->width = width; p->height = height; p->flags = flags;
  // MJPEG is stateless, so dropping under JS backpressure is harmless. AVCC is
  // inter-frame H.264: dropping a delta corrupts the decoder until the next IDR,
  // which shows up as screen tearing/ripping. Preserve AVCC ordering even if the
  // JS thread is briefly behind.
  napi_threadsafe_function_call_mode mode =
      codec == 1 ? napi_tsfn_blocking : napi_tsfn_nonblocking;
  if (napi_call_threadsafe_function(b->tsfn, p, mode) != napi_ok) {
    free(p->bytes);
    free(p);
  }
}

// Runs on the JS thread for each queued frame. env is null while the tsfn is
// being aborted — just free in that case.
//
// We copy the bytes into a managed Buffer (napi_create_buffer_copy) rather than
// wrapping them in an external Buffer: external buffers crash Bun's GC under
// high frame churn, and the production CLI is a bun-compiled binary. The copy
// is a single memcpy of the *encoded* frame (tens of KB) — negligible next to
// the JPEG/H.264 encode it follows.
static void FrameCallJs(napi_env env, napi_value js_cb, void *, void *data) {
  FramePayload *p = static_cast<FramePayload *>(data);
  if (env == nullptr || js_cb == nullptr) {
    free(p->bytes);
    free(p);
    return;
  }
  napi_value undefined, codec, buffer, w, h, flags;
  napi_get_undefined(env, &undefined);
  napi_create_int32(env, p->codec, &codec);
  napi_create_int32(env, p->width, &w);
  napi_create_int32(env, p->height, &h);
  napi_create_int32(env, p->flags, &flags);
  void *dst = nullptr;
  napi_create_buffer_copy(env, p->len, p->bytes, &dst, &buffer);
  free(p->bytes);
  free(p);
  napi_value argv[5] = {codec, buffer, w, h, flags};
  napi_call_function(env, undefined, js_cb, 5, argv, nullptr);
}

static void CaptureTsfnFinalize(napi_env, void *finalize_data, void *) {
  free(finalize_data);  // the CaptureBinding, once the tsfn is fully released
}

static void CaptureExternalFinalize(napi_env, void *data, void *) {
  CaptureBinding *b = static_cast<CaptureBinding *>(data);
  sim_capture_destroy(b->handle);  // drains encode queues → no more trampoline calls
  napi_release_threadsafe_function(b->tsfn, napi_tsfn_abort);  // → CaptureTsfnFinalize frees b
}

// captureCreate(udid, onFrame): External
static napi_value CaptureCreate(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 2);
  std::string udid = GetString(env, argv[0]);

  CaptureBinding *b = static_cast<CaptureBinding *>(calloc(1, sizeof(CaptureBinding)));
  if (!b) {
    napi_throw_error(env, nullptr, "alloc failed");
    return nullptr;
  }
  napi_value name;
  napi_create_string_utf8(env, "simCapture", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, name, /*max_queue*/ 16,
                                      /*initial_threads*/ 1, /*finalize_data*/ b,
                                      CaptureTsfnFinalize, /*context*/ nullptr, FrameCallJs,
                                      &b->tsfn) != napi_ok) {
    free(b);
    napi_throw_error(env, nullptr, "create_threadsafe_function failed");
    return nullptr;
  }
  // Don't let the frame pipeline by itself keep the event loop alive.
  napi_unref_threadsafe_function(env, b->tsfn);

  b->handle = sim_capture_create(udid.c_str(), FrameTrampoline, b);

  napi_value external;
  if (napi_create_external(env, b, CaptureExternalFinalize, nullptr, &external) != napi_ok) {
    sim_capture_destroy(b->handle);
    napi_release_threadsafe_function(b->tsfn, napi_tsfn_abort);
    napi_throw_error(env, nullptr, "create_external failed");
    return nullptr;
  }
  return external;
}

static void *GetCaptureHandle(napi_env env, napi_value v) {
  void *b = nullptr;
  napi_get_value_external(env, v, &b);
  return b ? static_cast<CaptureBinding *>(b)->handle : nullptr;
}

// captureStart(ext) — throws on failure (e.g. device not booted).
static napi_value CaptureStart(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  char *err = nullptr;
  if (!sim_capture_start(GetCaptureHandle(env, argv[0]), &err)) {
    napi_throw_error(env, nullptr, err ? err : "capture start failed");
    free(err);
  }
  return nullptr;
}

static napi_value CaptureSetAvccActive(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 2);
  sim_capture_set_avcc_active(GetCaptureHandle(env, argv[0]), GetBool(env, argv[1]));
  return nullptr;
}

static napi_value CaptureRequestKeyframe(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  sim_capture_request_keyframe(GetCaptureHandle(env, argv[0]));
  return nullptr;
}

// captureScreenSize(ext): { width, height }
static napi_value CaptureScreenSize(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  int32_t w = 0, h = 0;
  sim_capture_screen_size(GetCaptureHandle(env, argv[0]), &w, &h);
  napi_value obj, nw, nh;
  NAPI_CALL(env, napi_create_object(env, &obj));
  NAPI_CALL(env, napi_create_int32(env, w, &nw));
  NAPI_CALL(env, napi_create_int32(env, h, &nh));
  napi_set_named_property(env, obj, "width", nw);
  napi_set_named_property(env, obj, "height", nh);
  return obj;
}

// captureStop(ext) — halt frames without releasing the handle.
static napi_value CaptureStop(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 1);
  sim_capture_stop(GetCaptureHandle(env, argv[0]));
  return nullptr;
}

// ─── Accessibility surface ───────────────────────────────────────────────
struct AxAsyncRequest {
  napi_async_work work;
  napi_deferred deferred;
  std::string udid;
  char *json;
  char *err;
  char *(*fn)(const char *, char **);
};

static void AxAsyncExecute(napi_env, void *data) {
  AxAsyncRequest *req = static_cast<AxAsyncRequest *>(data);
  req->json = req->fn(req->udid.c_str(), &req->err);
}

static void AxAsyncComplete(napi_env env, napi_status status, void *data) {
  AxAsyncRequest *req = static_cast<AxAsyncRequest *>(data);
  if (status == napi_ok && req->json) {
    napi_value result;
    if (napi_create_string_utf8(env, req->json, NAPI_AUTO_LENGTH, &result) == napi_ok) {
      napi_resolve_deferred(env, req->deferred, result);
    } else {
      napi_value message, error;
      napi_create_string_utf8(env, "create_string failed", NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, nullptr, message, &error);
      napi_reject_deferred(env, req->deferred, error);
    }
  } else {
    napi_value message, error;
    const char *msg = req->err ? req->err : "accessibility query failed";
    napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, req->deferred, error);
  }
  free(req->json);
  free(req->err);
  napi_delete_async_work(env, req->work);
  delete req;
}

static napi_value AxDumpAsync(napi_env env, napi_callback_info info,
                              char *(*fn)(const char *, char **),
                              const char *name) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  napi_value promise;
  napi_deferred deferred;
  NAPI_CALL(env, napi_create_promise(env, &deferred, &promise));

  napi_value resource_name;
  NAPI_CALL(env, napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resource_name));

  AxAsyncRequest *req = new AxAsyncRequest{
      nullptr,
      deferred,
      GetString(env, argv[0]),
      nullptr,
      nullptr,
      fn,
  };

  napi_status status = napi_create_async_work(
      env, nullptr, resource_name, AxAsyncExecute, AxAsyncComplete, req, &req->work);
  if (status != napi_ok) {
    napi_value message, error;
    napi_create_string_utf8(env, "create_async_work failed", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, deferred, error);
    delete req;
  } else {
    status = napi_queue_async_work(env, req->work);
    if (status != napi_ok) {
      napi_value message, error;
      napi_create_string_utf8(env, "queue_async_work failed", NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, nullptr, message, &error);
      napi_reject_deferred(env, deferred, error);
      napi_delete_async_work(env, req->work);
      delete req;
    }
  }
  return promise;
}

// axDescribeAsync(udid): Promise<string> — async-work version of axDescribe.
static napi_value AxDescribeAsync(napi_env env, napi_callback_info info) {
  return AxDumpAsync(env, info, sim_ax_describe, "simAxDescribe");
}

// axFrontmostAsync(udid): Promise<string> — async-work version of axFrontmost.
static napi_value AxFrontmostAsync(napi_env env, napi_callback_info info) {
  return AxDumpAsync(env, info, sim_ax_frontmost, "simAxFrontmost");
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"hidCreate", nullptr, HidCreate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidTouch", nullptr, HidTouch, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidMultiTouch", nullptr, HidMultiTouch, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidButton", nullptr, HidButton, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidButtonHid", nullptr, HidButtonHid, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidKey", nullptr, HidKey, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidScroll", nullptr, HidScroll, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidDigitalCrown", nullptr, HidDigitalCrown, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidOrientation", nullptr, HidOrientation, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidMemoryWarning", nullptr, HidMemoryWarning, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidSoftwareKeyboard", nullptr, HidSoftwareKeyboard, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hidCaDebug", nullptr, HidCaDebug, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureCreate", nullptr, CaptureCreate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureStart", nullptr, CaptureStart, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureSetAvccActive", nullptr, CaptureSetAvccActive, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureRequestKeyframe", nullptr, CaptureRequestKeyframe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureScreenSize", nullptr, CaptureScreenSize, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"captureStop", nullptr, CaptureStop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"axDescribeAsync", nullptr, AxDescribeAsync, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"axFrontmostAsync", nullptr, AxFrontmostAsync, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
