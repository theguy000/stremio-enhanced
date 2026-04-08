#include "mpv_instance.h"
#include <memory>
#include <unordered_map>

static std::unordered_map<int, std::unique_ptr<MpvInstance>> instances;
static int nextHandle = 1;

// create(parentHwndBuffer) -> handle (number)
static Napi::Value Create(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected Buffer for parent window handle").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    void* parentHandle = nullptr;

    // Convert Buffer to native handle
    if (buf.Length() == sizeof(void*)) {
        parentHandle = *(void**)buf.Data();
    } else if (buf.Length() == 4) {
        // 32-bit handle (common on Windows for HWND as 32-bit value in 64-bit process)
        uint32_t val = *(uint32_t*)buf.Data();
        parentHandle = (void*)(uintptr_t)val;
    } else if (buf.Length() == 8) {
        uint64_t val = *(uint64_t*)buf.Data();
        parentHandle = (void*)(uintptr_t)val;
    }

    auto instance = std::make_unique<MpvInstance>();
    if (!instance->create(parentHandle)) {
        Napi::Error::New(env, "Failed to create mpv instance").ThrowAsJavaScriptException();
        return env.Null();
    }

    int handle = nextHandle++;
    instances[handle] = std::move(instance);
    return Napi::Number::New(env, handle);
}

// destroy(handle)
static Napi::Value Destroy(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    instances.erase(handle);
    return env.Undefined();
}

// command(handle, args[])
static Napi::Value Command(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return env.Undefined();

    auto arr = info[1].As<Napi::Array>();
    std::vector<std::string> args;
    for (uint32_t i = 0; i < arr.Length(); i++) {
        args.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
    }

    it->second->command(args);
    return env.Undefined();
}

// setProperty(handle, name, value)
static Napi::Value SetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return env.Undefined();

    std::string name = info[1].As<Napi::String>().Utf8Value();
    Napi::Value val = info[2];

    if (val.IsNumber()) {
        it->second->setPropertyDouble(name, val.As<Napi::Number>().DoubleValue());
    } else if (val.IsBoolean()) {
        it->second->setPropertyBool(name, val.As<Napi::Boolean>().Value());
    } else {
        it->second->setProperty(name, val.As<Napi::String>().Utf8Value());
    }

    return env.Undefined();
}

// getProperty(handle, name) -> string | number | boolean
static Napi::Value GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return env.Null();

    std::string name = info[1].As<Napi::String>().Utf8Value();

    // Default to string representation
    std::string val = it->second->getPropertyString(name);
    return Napi::String::New(env, val);
}

// observeProperty(handle, name, id, format)
// format: 1=string, 2=double, 3=flag
static Napi::Value ObserveProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return env.Undefined();

    std::string name = info[1].As<Napi::String>().Utf8Value();
    int id = info[2].As<Napi::Number>().Int32Value();
    int format = info[3].As<Napi::Number>().Int32Value();

    it->second->observeProperty(name, id, format);
    return env.Undefined();
}

// pollEvents(handle) -> Array<{ event, propertyName?, value? }>
static Napi::Value PollEvents(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return Napi::Array::New(env);

    auto events = it->second->pollEvents();
    auto arr = Napi::Array::New(env, events.size());

    for (size_t i = 0; i < events.size(); i++) {
        auto obj = Napi::Object::New(env);
        obj.Set("event", events[i].event);

        if (!events[i].propertyName.empty()) {
            obj.Set("name", events[i].propertyName);
        }

        switch (events[i].propertyFormat) {
            case 1: obj.Set("value", events[i].propertyValueStr); break;
            case 2: obj.Set("value", events[i].propertyValueNum); break;
            case 3: obj.Set("value", (bool)events[i].propertyValueFlag); break;
            default: break;
        }

        arr.Set(i, obj);
    }

    return arr;
}

// resize(handle, width, height)
static Napi::Value Resize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return env.Undefined();

    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    it->second->resize(w, h);
    return env.Undefined();
}

// setPosition(handle, x, y)
static Napi::Value SetPosition(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int handle = info[0].As<Napi::Number>().Int32Value();
    auto it = instances.find(handle);
    if (it == instances.end()) return env.Undefined();

    int x = info[1].As<Napi::Number>().Int32Value();
    int y = info[2].As<Napi::Number>().Int32Value();
    it->second->setPosition(x, y);
    return env.Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("create", Napi::Function::New(env, Create));
    exports.Set("destroy", Napi::Function::New(env, Destroy));
    exports.Set("command", Napi::Function::New(env, Command));
    exports.Set("setProperty", Napi::Function::New(env, SetProperty));
    exports.Set("getProperty", Napi::Function::New(env, GetProperty));
    exports.Set("observeProperty", Napi::Function::New(env, ObserveProperty));
    exports.Set("pollEvents", Napi::Function::New(env, PollEvents));
    exports.Set("resize", Napi::Function::New(env, Resize));
    exports.Set("setPosition", Napi::Function::New(env, SetPosition));
    return exports;
}

NODE_API_MODULE(mpv_native, Init)
