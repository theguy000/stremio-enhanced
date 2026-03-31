#pragma once
#include <napi.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include "gl_context.h"
#include <atomic>
#include <memory>
#include <string>

class MpvPlayer : public Napi::ObjectWrap<MpvPlayer> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    MpvPlayer(const Napi::CallbackInfo& info);
    ~MpvPlayer();

private:
    // JS methods
    Napi::Value LoadFile(const Napi::CallbackInfo& info);
    Napi::Value Command(const Napi::CallbackInfo& info);
    Napi::Value SetProperty(const Napi::CallbackInfo& info);
    Napi::Value GetProperty(const Napi::CallbackInfo& info);
    Napi::Value ObserveProperty(const Napi::CallbackInfo& info);
    Napi::Value GetFrameBuffer(const Napi::CallbackInfo& info);
    Napi::Value ReportSwap(const Napi::CallbackInfo& info);
    void Stop(const Napi::CallbackInfo& info);
    void Destroy(const Napi::CallbackInfo& info);

    // JS callback setters
    void SetOnFrame(const Napi::CallbackInfo& info, const Napi::Value& value);
    void SetOnPropertyChange(const Napi::CallbackInfo& info, const Napi::Value& value);
    void SetOnEvent(const Napi::CallbackInfo& info, const Napi::Value& value);

    // Internal
    void renderFrame();
    void processEvents();
    void setupFbo(int width, int height);
    void cleanupGlResources();
    static void onMpvRenderUpdate(void* ctx);
    static void onMpvWakeup(void* ctx);
    static void onAsyncRender(uv_async_t* handle);
    static void onAsyncEvent(uv_async_t* handle);

    mpv_handle* mpv_ = nullptr;
    mpv_render_context* mpvRender_ = nullptr;
    GlContext* gl_ = nullptr;

    // FBO
    unsigned int fbo_ = 0;
    unsigned int fboTexture_ = 0;
    int videoWidth_ = 0;
    int videoHeight_ = 0;

    // PBO double-buffer
    unsigned int pbos_[2] = {0, 0};
    int currentPbo_ = 0;

    // Triple-buffer SAB
    Napi::Reference<Napi::ArrayBuffer> sabRef_;
    uint8_t* sabData_ = nullptr;
    size_t sabSize_ = 0;
    static constexpr int HEADER_SIZE = 16; // 4 int32s for atomics
    std::atomic<int>* frameIndex_ = nullptr; // points into SAB header
    int sabWidth_ = 0;
    int sabHeight_ = 0;

    // Threadsafe callbacks
    Napi::ThreadSafeFunction tsfnFrame_;
    Napi::ThreadSafeFunction tsfnPropertyChange_;
    Napi::ThreadSafeFunction tsfnEvent_;

    // Async handles for libuv
    uv_async_t asyncRender_;
    uv_async_t asyncEvent_;
    bool asyncRenderInit_ = false;
    bool asyncEventInit_ = false;

    uint64_t observePropertyId_ = 0;
    std::atomic<bool> destroyed_{false};

    // Multi-instance guard
    static std::atomic<int> instanceCount_;

    // Shared cleanup called by Destroy() and ~MpvPlayer()
    void destroyImpl();
};
