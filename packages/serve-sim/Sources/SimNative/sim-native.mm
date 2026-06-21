// Objective-C++ N-API entrypoint for serve-sim-native.node.
//
// This is the in-process replacement boundary for the spawned serve-sim-bin
// helper. It exposes the SimStreamHelper logic (reused verbatim, behind @_cdecl
// shims in sim-hid.swift / sim-native.swift) as JS functions. HID is the first
// real surface; frame capture + encoders follow.

#include <node_api.h>
#include <cstdlib>
#include <cstring>
#include <string>

// ─── Swift @_cdecl exports ───────────────────────────────────────────────
extern "C" {
char *sim_native_version(void);
int sim_native_add(int a, int b);

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

// ─── MVP self-test functions ─────────────────────────────────────────────
static napi_value Version(napi_env env, napi_callback_info info) {
  char *banner = sim_native_version();
  napi_value result;
  napi_status status =
      napi_create_string_utf8(env, banner ? banner : "", NAPI_AUTO_LENGTH, &result);
  free(banner);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "create_string failed");
    return nullptr;
  }
  return result;
}

static napi_value Add(napi_env env, napi_callback_info info) {
  READ_ARGS(env, info, 2);
  napi_value result;
  NAPI_CALL(env, napi_create_int32(env, sim_native_add(GetInt32(env, argv[0]),
                                                       GetInt32(env, argv[1])), &result));
  return result;
}

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

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"add", nullptr, Add, nullptr, nullptr, nullptr, napi_default, nullptr},
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
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
