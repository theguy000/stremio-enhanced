// native/src/mpv_player.cpp
#include <napi.h>

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("version", Napi::String::New(env, "0.1.0"));
    return exports;
}

NODE_API_MODULE(node_libmpv, Init)
