#pragma once
#include <napi.h>

class MpvPlayer : public Napi::ObjectWrap<MpvPlayer> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    MpvPlayer(const Napi::CallbackInfo& info);
    ~MpvPlayer();
};
