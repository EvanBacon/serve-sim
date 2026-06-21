// Objective-C++ N-API entrypoint for serve-sim-native.node.
//
// This is the in-process replacement boundary for the spawned serve-sim-bin
// helper. For the MVP it exposes two trivial functions that call into Swift
// (sim-native.swift) to prove the JS↔C++↔Swift toolchain and the build/deploy
// pipeline. The real streaming/HID/AX surface gets added here incrementally.

#include <node_api.h>
#include <cstdlib>
#include <cstring>

// Swift @_cdecl exports (see sim-native.swift).
extern "C" {
char *sim_native_version(void);
int sim_native_add(int a, int b);
}

#define NAPI_CALL(env, call)                                              \
  do {                                                                    \
    napi_status _status = (call);                                         \
    if (_status != napi_ok) {                                             \
      napi_throw_error((env), nullptr, #call " failed");                  \
      return nullptr;                                                     \
    }                                                                     \
  } while (0)

// version(): string — returns a build/version banner produced by Swift.
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

// add(a, b): number — round-trips two int32 args through Swift.
static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));

  int32_t a = 0, b = 0;
  NAPI_CALL(env, napi_get_value_int32(env, argv[0], &a));
  NAPI_CALL(env, napi_get_value_int32(env, argv[1], &b));

  napi_value result;
  NAPI_CALL(env, napi_create_int32(env, sim_native_add(a, b), &result));
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"add", nullptr, Add, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
