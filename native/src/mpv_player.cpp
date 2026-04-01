// native/src/mpv_player.cpp — Core MpvPlayer: libmpv init, GL render, PBO readback
#include "mpv_player.h"
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

// ---------------------------------------------------------------------------
// OpenGL constants (numeric, no dependency on GL headers beyond gl.h basics)
// ---------------------------------------------------------------------------
#define SE_GL_FRAMEBUFFER           0x8D40
#define SE_GL_COLOR_ATTACHMENT0     0x8CE0
#define SE_GL_FRAMEBUFFER_COMPLETE  0x8CD5
#define SE_GL_TEXTURE_2D            0x0DE1
#define SE_GL_RGBA                  0x1908
#define SE_GL_RGBA8                 0x8058
#define SE_GL_UNSIGNED_BYTE         0x1401
#define SE_GL_PIXEL_PACK_BUFFER     0x88EB
#define SE_GL_STREAM_READ           0x88E1
#define SE_GL_READ_ONLY             0x88B8
#define SE_GL_TEXTURE_MIN_FILTER    0x2801
#define SE_GL_TEXTURE_MAG_FILTER    0x2800
#define SE_GL_LINEAR                0x2601
#define SE_GL_NO_ERROR              0

// ---------------------------------------------------------------------------
// GL function pointer types
// ---------------------------------------------------------------------------
typedef void     (*PFNGLGENFRAMEBUFFERSPROC)(int n, unsigned int* ids);
typedef void     (*PFNGLBINDFRAMEBUFFERPROC)(unsigned int target, unsigned int fb);
typedef void     (*PFNGLFRAMEBUFFERTEXTURE2DPROC)(unsigned int target, unsigned int attachment,
                                                   unsigned int textarget, unsigned int texture, int level);
typedef unsigned int (*PFNGLCHECKFRAMEBUFFERSTATUSPROC)(unsigned int target);
typedef void     (*PFNGLDELETEFRAMEBUFFERSPROC)(int n, const unsigned int* ids);
typedef void     (*PFNGLGENTEXTURESPROC)(int n, unsigned int* textures);
typedef void     (*PFNGLBINDTEXTUREPROC)(unsigned int target, unsigned int texture);
typedef void     (*PFNGLTEXIMAGE2DPROC)(unsigned int target, int level, int internalformat,
                                        int width, int height, int border,
                                        unsigned int format, unsigned int type, const void* data);
typedef void     (*PFNGLTEXPARAMETERIPROC)(unsigned int target, unsigned int pname, int param);
typedef void     (*PFNGLDELETETEXTURESPROC)(int n, const unsigned int* textures);
typedef void     (*PFNGLGENBUFFERSPROC)(int n, unsigned int* buffers);
typedef void     (*PFNGLBINDBUFFERPROC)(unsigned int target, unsigned int buffer);
typedef void     (*PFNGLBUFFERDATAPROC)(unsigned int target, ptrdiff_t size, const void* data, unsigned int usage);
typedef void     (*PFNGLDELETEBUFFERSPROC)(int n, const unsigned int* buffers);
typedef void     (*PFNGLREADPIXELSPROC)(int x, int y, int width, int height,
                                        unsigned int format, unsigned int type, void* data);
typedef void*    (*PFNGLMAPBUFFERPROC)(unsigned int target, unsigned int access);
typedef unsigned char (*PFNGLUNMAPBUFFERPROC)(unsigned int target);
typedef void     (*PFNGLVIEWPORTPROC)(int x, int y, int width, int height);
typedef unsigned int (*PFNGLGETERRORPROC)();

// GL function pointers (resolved at runtime via GlContext::getProcAddress)
static PFNGLGENFRAMEBUFFERSPROC       glGenFramebuffers_  = nullptr;
static PFNGLBINDFRAMEBUFFERPROC       glBindFramebuffer_  = nullptr;
static PFNGLFRAMEBUFFERTEXTURE2DPROC  glFramebufferTexture2D_ = nullptr;
static PFNGLCHECKFRAMEBUFFERSTATUSPROC glCheckFramebufferStatus_ = nullptr;
static PFNGLDELETEFRAMEBUFFERSPROC    glDeleteFramebuffers_ = nullptr;
static PFNGLGENTEXTURESPROC           glGenTextures_      = nullptr;
static PFNGLBINDTEXTUREPROC           glBindTexture_      = nullptr;
static PFNGLTEXIMAGE2DPROC            glTexImage2D_       = nullptr;
static PFNGLTEXPARAMETERIPROC         glTexParameteri_    = nullptr;
static PFNGLDELETETEXTURESPROC        glDeleteTextures_   = nullptr;
static PFNGLGENBUFFERSPROC            glGenBuffers_       = nullptr;
static PFNGLBINDBUFFERPROC            glBindBuffer_       = nullptr;
static PFNGLBUFFERDATAPROC            glBufferData_       = nullptr;
static PFNGLDELETEBUFFERSPROC         glDeleteBuffers_    = nullptr;
static PFNGLREADPIXELSPROC            glReadPixels_       = nullptr;
static PFNGLMAPBUFFERPROC             glMapBuffer_        = nullptr;
static PFNGLUNMAPBUFFERPROC           glUnmapBuffer_      = nullptr;
static PFNGLVIEWPORTPROC              glViewport_         = nullptr;
static PFNGLGETERRORPROC              glGetError_         = nullptr;

static bool glFunctionsLoaded = false;

static bool loadGlFunctions(GlContext* gl) {
    if (glFunctionsLoaded) return true;
    #define LOAD_GL(name) name##_ = (decltype(name##_))gl->getProcAddress(#name); \
        if (!name##_) return false;

    LOAD_GL(glGenFramebuffers)
    LOAD_GL(glBindFramebuffer)
    LOAD_GL(glFramebufferTexture2D)
    LOAD_GL(glCheckFramebufferStatus)
    LOAD_GL(glDeleteFramebuffers)
    LOAD_GL(glGenTextures)
    LOAD_GL(glBindTexture)
    LOAD_GL(glTexImage2D)
    LOAD_GL(glTexParameteri)
    LOAD_GL(glDeleteTextures)
    LOAD_GL(glGenBuffers)
    LOAD_GL(glBindBuffer)
    LOAD_GL(glBufferData)
    LOAD_GL(glDeleteBuffers)
    LOAD_GL(glReadPixels)
    LOAD_GL(glMapBuffer)
    LOAD_GL(glUnmapBuffer)
    LOAD_GL(glViewport)
    LOAD_GL(glGetError)

    #undef LOAD_GL
    glFunctionsLoaded = true;
    return true;
}

// ---------------------------------------------------------------------------
// Runtime libmpv loader — function pointer typedefs
// ---------------------------------------------------------------------------
typedef mpv_handle* (*fn_mpv_create)();
typedef int (*fn_mpv_initialize)(mpv_handle*);
typedef int (*fn_mpv_set_option_string)(mpv_handle*, const char*, const char*);
typedef int (*fn_mpv_command_async)(mpv_handle*, uint64_t, const char**);
typedef int (*fn_mpv_set_property_string)(mpv_handle*, const char*, const char*);
typedef char* (*fn_mpv_get_property_string)(mpv_handle*, const char*);
typedef void (*fn_mpv_free)(void*);
typedef int (*fn_mpv_observe_property)(mpv_handle*, uint64_t, const char*, mpv_format);
typedef mpv_event* (*fn_mpv_wait_event)(mpv_handle*, double);
typedef void (*fn_mpv_set_wakeup_callback)(mpv_handle*, void(*)(void*), void*);
typedef int (*fn_mpv_render_context_create)(mpv_render_context**, mpv_handle*, mpv_render_param*);
typedef int (*fn_mpv_render_context_render)(mpv_render_context*, mpv_render_param*);
typedef void (*fn_mpv_render_context_set_update_callback)(mpv_render_context*, mpv_render_update_fn, void*);
typedef int (*fn_mpv_render_context_report_swap)(mpv_render_context*);
typedef void (*fn_mpv_render_context_free)(mpv_render_context*);
typedef uint64_t (*fn_mpv_render_context_update)(mpv_render_context*);
typedef void (*fn_mpv_terminate_destroy)(mpv_handle*);

struct MpvLib {
    void* handle = nullptr;

    fn_mpv_create                             create = nullptr;
    fn_mpv_initialize                         initialize = nullptr;
    fn_mpv_set_option_string                  set_option_string = nullptr;
    fn_mpv_command_async                      command_async = nullptr;
    fn_mpv_set_property_string                set_property_string = nullptr;
    fn_mpv_get_property_string                get_property_string = nullptr;
    fn_mpv_free                               free = nullptr;
    fn_mpv_observe_property                   observe_property = nullptr;
    fn_mpv_wait_event                         wait_event = nullptr;
    fn_mpv_set_wakeup_callback                set_wakeup_callback = nullptr;
    fn_mpv_render_context_create              render_context_create = nullptr;
    fn_mpv_render_context_render              render_context_render = nullptr;
    fn_mpv_render_context_set_update_callback render_context_set_update_callback = nullptr;
    fn_mpv_render_context_report_swap         render_context_report_swap = nullptr;
    fn_mpv_render_context_update              render_context_update = nullptr;
    fn_mpv_render_context_free                render_context_free = nullptr;
    fn_mpv_terminate_destroy                  terminate_destroy = nullptr;

    bool loaded() const { return handle != nullptr; }

    bool load(const std::string& path) {
#ifdef _WIN32
        // Proper UTF-8 to UTF-16 conversion for non-ASCII paths
        int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
        if (wlen <= 0) return false;
        std::wstring wpath(wlen - 1, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &wpath[0], wlen);

        auto lastSlash = wpath.find_last_of(L"\\/");
        if (lastSlash != std::wstring::npos) {
            std::wstring dir = wpath.substr(0, lastSlash);
            SetDllDirectoryW(dir.c_str());
        }
        handle = (void*)LoadLibraryW(wpath.c_str());
        if (lastSlash != std::wstring::npos) {
            SetDllDirectoryW(nullptr); // reset
        }
#else
        handle = dlopen(path.c_str(), RTLD_NOW);
#endif
        if (!handle) return false;

        #define LOAD_MPV(field, sym) \
            field = (decltype(field))resolveSymbol(#sym); \
            if (!field) return false;

        LOAD_MPV(create,                             mpv_create)
        LOAD_MPV(initialize,                         mpv_initialize)
        LOAD_MPV(set_option_string,                  mpv_set_option_string)
        LOAD_MPV(command_async,                      mpv_command_async)
        LOAD_MPV(set_property_string,                mpv_set_property_string)
        LOAD_MPV(get_property_string,                mpv_get_property_string)
        LOAD_MPV(free,                               mpv_free)
        LOAD_MPV(observe_property,                   mpv_observe_property)
        LOAD_MPV(wait_event,                         mpv_wait_event)
        LOAD_MPV(set_wakeup_callback,                mpv_set_wakeup_callback)
        LOAD_MPV(render_context_create,              mpv_render_context_create)
        LOAD_MPV(render_context_render,              mpv_render_context_render)
        LOAD_MPV(render_context_set_update_callback, mpv_render_context_set_update_callback)
        LOAD_MPV(render_context_report_swap,         mpv_render_context_report_swap)
        LOAD_MPV(render_context_update,              mpv_render_context_update)
        LOAD_MPV(render_context_free,                mpv_render_context_free)
        LOAD_MPV(terminate_destroy,                  mpv_terminate_destroy)

        #undef LOAD_MPV
        return true;
    }

private:
    void* resolveSymbol(const char* name) {
#ifdef _WIN32
        return (void*)GetProcAddress((HMODULE)handle, name);
#else
        return dlsym(handle, name);
#endif
    }
};

// Single global instance — only one libmpv can be loaded per process
static MpvLib mpvLib_;

// Multi-instance guard
std::atomic<int> MpvPlayer::instanceCount_{0};

// ---------------------------------------------------------------------------
// Callback trampolines bridging mpv threads to libuv main thread
// ---------------------------------------------------------------------------

// get_proc_address callback for mpv_render_context_create
static void* mpvGlGetProcAddress(void* ctx, const char* name) {
    GlContext* gl = static_cast<GlContext*>(ctx);
    return gl->getProcAddress(name);
}

void MpvPlayer::onMpvRenderUpdate(void* ctx) {
    // Called from mpv render thread — must not call mpv or GL APIs.
    // Signal main thread via uv_async.
    MpvPlayer* self = static_cast<MpvPlayer*>(ctx);
    if (!self->destroyed_.load(std::memory_order_acquire)) {
        uv_async_send(&self->asyncRender_);
    }
}

void MpvPlayer::onMpvWakeup(void* ctx) {
    // Called from mpv core thread when new events are available.
    MpvPlayer* self = static_cast<MpvPlayer*>(ctx);
    if (!self->destroyed_.load(std::memory_order_acquire)) {
        uv_async_send(&self->asyncEvent_);
    }
}

void MpvPlayer::onAsyncRender(uv_async_t* handle) {
    MpvPlayer* self = static_cast<MpvPlayer*>(handle->data);
    if (self && !self->destroyed_.load()) {
        self->renderFrame();
    }
}

void MpvPlayer::onAsyncEvent(uv_async_t* handle) {
    MpvPlayer* self = static_cast<MpvPlayer*>(handle->data);
    if (self && !self->destroyed_.load()) {
        self->processEvents();
    }
}

// ---------------------------------------------------------------------------
// N-API class registration
// ---------------------------------------------------------------------------

Napi::Object MpvPlayer::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MpvPlayer", {
        InstanceMethod("loadFile", &MpvPlayer::LoadFile),
        InstanceMethod("command", &MpvPlayer::Command),
        InstanceMethod("setProperty", &MpvPlayer::SetProperty),
        InstanceMethod("getProperty", &MpvPlayer::GetProperty),
        InstanceMethod("observeProperty", &MpvPlayer::ObserveProperty),
        InstanceMethod("getFrameBuffer", &MpvPlayer::GetFrameBuffer),
        InstanceMethod("reportSwap", &MpvPlayer::ReportSwap),
        InstanceMethod("stop", &MpvPlayer::Stop),
        InstanceMethod("destroy", &MpvPlayer::Destroy),
        InstanceAccessor("onFrame", nullptr, &MpvPlayer::SetOnFrame),
        InstanceAccessor("onPropertyChange", nullptr, &MpvPlayer::SetOnPropertyChange),
        InstanceAccessor("onEvent", nullptr, &MpvPlayer::SetOnEvent),
    });
    exports.Set("MpvPlayer", func);
    return exports;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

MpvPlayer::MpvPlayer(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<MpvPlayer>(info) {
    Napi::Env env = info.Env();

    // Multi-instance guard — only one MpvPlayer may exist at a time
    if (instanceCount_.load() > 0) {
        Napi::Error::New(env, "Only one MpvPlayer instance is allowed at a time")
            .ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Options object required: { libmpvPath: string }")
            .ThrowAsJavaScriptException();
        return;
    }

    Napi::Object opts = info[0].As<Napi::Object>();
    if (!opts.Has("libmpvPath") || !opts.Get("libmpvPath").IsString()) {
        Napi::TypeError::New(env, "libmpvPath (string) is required")
            .ThrowAsJavaScriptException();
        return;
    }

    std::string libmpvPath = opts.Get("libmpvPath").As<Napi::String>().Utf8Value();

    // 1. Runtime-load libmpv
    if (!mpvLib_.loaded()) {
        if (!mpvLib_.load(libmpvPath)) {
            Napi::Error::New(env, "Failed to load libmpv from: " + libmpvPath)
                .ThrowAsJavaScriptException();
            return;
        }
    }

    // 2. Create mpv handle
    mpv_ = mpvLib_.create();
    if (!mpv_) {
        Napi::Error::New(env, "mpv_create() failed").ThrowAsJavaScriptException();
        return;
    }

    // 3. Set options before initialization
    mpvLib_.set_option_string(mpv_, "vo", "libmpv");
    mpvLib_.set_option_string(mpv_, "hwdec", "auto");
    mpvLib_.set_option_string(mpv_, "terminal", "no");
    mpvLib_.set_option_string(mpv_, "msg-level", "all=no");
    // Disable video timing — we drive the render loop ourselves
    mpvLib_.set_option_string(mpv_, "video-timing-offset", "0");

    // 4. Initialize
    int err = mpvLib_.initialize(mpv_);
    if (err < 0) {
        mpvLib_.terminate_destroy(mpv_);
        mpv_ = nullptr;
        Napi::Error::New(env, "mpv_initialize() failed with error " + std::to_string(err))
            .ThrowAsJavaScriptException();
        return;
    }

    // 5. Create GL context
    gl_ = createGlContext();
    if (!gl_ || !gl_->init()) {
        mpvLib_.terminate_destroy(mpv_);
        mpv_ = nullptr;
        Napi::Error::New(env, "Failed to create offscreen GL context")
            .ThrowAsJavaScriptException();
        return;
    }

    // Load GL function pointers
    if (!loadGlFunctions(gl_)) {
        gl_->destroy();
        delete gl_;
        gl_ = nullptr;
        mpvLib_.terminate_destroy(mpv_);
        mpv_ = nullptr;
        Napi::Error::New(env, "Failed to load required GL functions")
            .ThrowAsJavaScriptException();
        return;
    }

    // 6. Create mpv render context with OpenGL params
    mpv_opengl_init_params glInitParams = {};
    glInitParams.get_proc_address = mpvGlGetProcAddress;
    glInitParams.get_proc_address_ctx = gl_;

    int advancedControl = 1;

    mpv_render_param renderParams[] = {
        { MPV_RENDER_PARAM_API_TYPE, (void*)MPV_RENDER_API_TYPE_OPENGL },
        { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &glInitParams },
        { MPV_RENDER_PARAM_ADVANCED_CONTROL, &advancedControl },
        { MPV_RENDER_PARAM_INVALID, nullptr }
    };

    err = mpvLib_.render_context_create(&mpvRender_, mpv_, renderParams);
    if (err < 0) {
        gl_->destroy();
        delete gl_;
        gl_ = nullptr;
        mpvLib_.terminate_destroy(mpv_);
        mpv_ = nullptr;
        Napi::Error::New(env, "mpv_render_context_create() failed: " + std::to_string(err))
            .ThrowAsJavaScriptException();
        return;
    }

    // 7. Set render update callback (called from mpv thread)
    mpvLib_.render_context_set_update_callback(mpvRender_, onMpvRenderUpdate, this);

    // 8. Init uv_async handles
    uv_loop_t* loop = uv_default_loop();

    uv_async_init(loop, &asyncRender_, onAsyncRender);
    asyncRender_.data = this;
    asyncRenderInit_ = true;

    uv_async_init(loop, &asyncEvent_, onAsyncEvent);
    asyncEvent_.data = this;
    asyncEventInit_ = true;

    // 9. Set wakeup callback for event processing
    mpvLib_.set_wakeup_callback(mpv_, onMpvWakeup, this);

    // 10. Prevent GC from collecting this object while mpv callbacks hold raw `this`
    instanceCount_.fetch_add(1);
    this->Ref();
}

// ---------------------------------------------------------------------------
// Destructor
// ---------------------------------------------------------------------------

MpvPlayer::~MpvPlayer() {
    destroyImpl();
}

// ---------------------------------------------------------------------------
// GL resource management
// ---------------------------------------------------------------------------

void MpvPlayer::setupFbo(int width, int height) {
    // Clean up existing resources if resizing
    cleanupGlResources();

    videoWidth_ = width;
    videoHeight_ = height;

    // Create texture for FBO
    glGenTextures_(1, &fboTexture_);
    glBindTexture_(SE_GL_TEXTURE_2D, fboTexture_);
    glTexImage2D_(SE_GL_TEXTURE_2D, 0, SE_GL_RGBA8, width, height, 0,
                  SE_GL_RGBA, SE_GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri_(SE_GL_TEXTURE_2D, SE_GL_TEXTURE_MIN_FILTER, SE_GL_LINEAR);
    glTexParameteri_(SE_GL_TEXTURE_2D, SE_GL_TEXTURE_MAG_FILTER, SE_GL_LINEAR);
    glBindTexture_(SE_GL_TEXTURE_2D, 0);

    // Create FBO
    glGenFramebuffers_(1, &fbo_);
    glBindFramebuffer_(SE_GL_FRAMEBUFFER, fbo_);
    glFramebufferTexture2D_(SE_GL_FRAMEBUFFER, SE_GL_COLOR_ATTACHMENT0,
                            SE_GL_TEXTURE_2D, fboTexture_, 0);

    unsigned int status = glCheckFramebufferStatus_(SE_GL_FRAMEBUFFER);
    glBindFramebuffer_(SE_GL_FRAMEBUFFER, 0);

    if (status != SE_GL_FRAMEBUFFER_COMPLETE) {
        // FBO incomplete — clean up and bail
        cleanupGlResources();
        return;
    }

    // Create PBOs for async pixel readback (double-buffered)
    size_t pboSize = (size_t)width * height * 4;
    glGenBuffers_(2, pbos_);
    for (int i = 0; i < 2; i++) {
        glBindBuffer_(SE_GL_PIXEL_PACK_BUFFER, pbos_[i]);
        glBufferData_(SE_GL_PIXEL_PACK_BUFFER, pboSize, nullptr, SE_GL_STREAM_READ);
    }
    glBindBuffer_(SE_GL_PIXEL_PACK_BUFFER, 0);

    currentPbo_ = 0;
}

void MpvPlayer::cleanupGlResources() {
    if (pbos_[0] || pbos_[1]) {
        glDeleteBuffers_(2, pbos_);
        pbos_[0] = pbos_[1] = 0;
    }
    if (fbo_) {
        glDeleteFramebuffers_(1, &fbo_);
        fbo_ = 0;
    }
    if (fboTexture_) {
        glDeleteTextures_(1, &fboTexture_);
        fboTexture_ = 0;
    }
}

// ---------------------------------------------------------------------------
// Render frame: FBO render + PBO async readback into SAB triple buffer
// ---------------------------------------------------------------------------

void MpvPlayer::renderFrame() {
    if (destroyed_.load() || !mpvRender_ || !gl_) return;

    gl_->makeCurrent();

    // Check if mpv actually has a new frame to render
    uint64_t flags = mpvLib_.render_context_update(mpvRender_);
    if (!(flags & 1)) { // MPV_RENDER_UPDATE_FRAME = 1
        gl_->doneCurrent();
        return;
    }

    // Need valid FBO to proceed (dimensions set by VIDEO_RECONFIG handler)
    if (!fbo_ || videoWidth_ <= 0 || videoHeight_ <= 0) {
        gl_->doneCurrent();
        return;
    }

    // Render mpv into FBO
    mpv_opengl_fbo fboParam = {};
    fboParam.fbo = static_cast<int>(fbo_);
    fboParam.w = videoWidth_;
    fboParam.h = videoHeight_;
    fboParam.internal_format = SE_GL_RGBA8;

    int flipY = 0;
    int blockTarget = 0; // don't block — we drive timing

    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_OPENGL_FBO, &fboParam },
        { MPV_RENDER_PARAM_FLIP_Y, &flipY },
        { MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockTarget },
        { MPV_RENDER_PARAM_INVALID, nullptr }
    };

    mpvLib_.render_context_render(mpvRender_, params);

    // PBO async readback if buffer is set up
    if (sabData_ && sabSize_ > 0) {
        size_t frameBytes = (size_t)videoWidth_ * videoHeight_ * 4;
        int totalSlots = 3;

        // Initiate async read from FBO into current PBO
        glBindFramebuffer_(SE_GL_FRAMEBUFFER, fbo_);
        glBindBuffer_(SE_GL_PIXEL_PACK_BUFFER, pbos_[currentPbo_]);
        glReadPixels_(0, 0, videoWidth_, videoHeight_, SE_GL_RGBA, SE_GL_UNSIGNED_BYTE, nullptr);

        // Map the *previous* PBO (which was filled last frame) and copy to buffer
        int prevPbo = 1 - currentPbo_;
        glBindBuffer_(SE_GL_PIXEL_PACK_BUFFER, pbos_[prevPbo]);
        void* mapped = glMapBuffer_(SE_GL_PIXEL_PACK_BUFFER, SE_GL_READ_ONLY);
        if (mapped) {
            // Determine which triple-buffer slot to write to
            int currentIdx = frameIndex_ ? frameIndex_->load(std::memory_order_acquire) : 0;
            int writeSlot = (currentIdx + 1) % totalSlots;
            size_t offset = HEADER_SIZE + writeSlot * frameBytes;

            if (offset + frameBytes <= sabSize_) {
                memcpy(sabData_ + offset, mapped, frameBytes);

                // Atomically publish the new frame slot index
                if (frameIndex_) {
                    frameIndex_->store(writeSlot, std::memory_order_release);
                }

                // Store width and height in the buffer header (int32 slots 1 and 2)
                int32_t* header = reinterpret_cast<int32_t*>(sabData_);
                // header[0] = frameIndex (handled by atomic above)
                header[1] = videoWidth_;
                header[2] = videoHeight_;
            }

            glUnmapBuffer_(SE_GL_PIXEL_PACK_BUFFER);
        }

        glBindBuffer_(SE_GL_PIXEL_PACK_BUFFER, 0);
        glBindFramebuffer_(SE_GL_FRAMEBUFFER, 0);

        // Swap PBO index
        currentPbo_ = prevPbo;
    }

    // Notify JS of new frame (outside buffer check so first callback can set up the buffer)
    if (hasTsfnFrame_) {
        int w = videoWidth_;
        int h = videoHeight_;
        tsfnFrame_.NonBlockingCall([w, h](Napi::Env env, Napi::Function callback) {
            callback.Call({
                Napi::Number::New(env, w),
                Napi::Number::New(env, h)
            });
        });
    }

    gl_->doneCurrent();
}

// ---------------------------------------------------------------------------
// Event processing — called on main thread from onAsyncEvent
// ---------------------------------------------------------------------------

void MpvPlayer::processEvents() {
    if (destroyed_.load() || !mpv_) return;

    while (true) {
        mpv_event* event = mpvLib_.wait_event(mpv_, 0);
        if (!event || event->event_id == MPV_EVENT_NONE) break;

        switch (event->event_id) {
            case MPV_EVENT_PROPERTY_CHANGE: {
                mpv_event_property* prop = static_cast<mpv_event_property*>(event->data);
                if (prop && hasTsfnPropertyChange_) {
                    std::string name = prop->name ? prop->name : "";
                    std::string value;
                    if (prop->format == MPV_FORMAT_STRING && prop->data) {
                        value = *static_cast<char**>(prop->data);
                    }
                    tsfnPropertyChange_.NonBlockingCall(
                        [name, value](Napi::Env env, Napi::Function callback) {
                            Napi::Object obj = Napi::Object::New(env);
                            obj.Set("name", Napi::String::New(env, name));
                            obj.Set("value", Napi::String::New(env, value));
                            callback.Call({ obj });
                        });
                }
                break;
            }

            case MPV_EVENT_VIDEO_RECONFIG: {
                // Query and cache video dimensions on reconfig instead of per-frame
                char* wStr = mpvLib_.get_property_string(mpv_, "width");
                char* hStr = mpvLib_.get_property_string(mpv_, "height");
                int newW = wStr ? atoi(wStr) : 0;
                int newH = hStr ? atoi(hStr) : 0;
                if (wStr) mpvLib_.free(wStr);
                if (hStr) mpvLib_.free(hStr);
                if (newW > 3840) newW = 3840;
                if (newH > 2160) newH = 2160;
                if (newW > 0 && newH > 0 && (newW != videoWidth_ || newH != videoHeight_)) {
                    gl_->makeCurrent();
                    setupFbo(newW, newH);
                    gl_->doneCurrent();
                }
                break;
            }

            case MPV_EVENT_END_FILE: {
                if (hasTsfnEvent_) {
                    tsfnEvent_.NonBlockingCall(
                        [](Napi::Env env, Napi::Function callback) {
                            callback.Call({ Napi::String::New(env, "end-file") });
                        });
                }
                break;
            }

            case MPV_EVENT_FILE_LOADED: {
                if (hasTsfnEvent_) {
                    tsfnEvent_.NonBlockingCall(
                        [](Napi::Env env, Napi::Function callback) {
                            callback.Call({ Napi::String::New(env, "file-loaded") });
                        });
                }
                break;
            }

            case MPV_EVENT_SHUTDOWN: {
                if (hasTsfnEvent_) {
                    tsfnEvent_.NonBlockingCall(
                        [](Napi::Env env, Napi::Function callback) {
                            callback.Call({ Napi::String::New(env, "shutdown") });
                        });
                }
                break;
            }

            default:
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// JS methods
// ---------------------------------------------------------------------------

Napi::Value MpvPlayer::LoadFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (destroyed_.load() || !mpv_) {
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "loadFile requires a URL string")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string url = info[0].As<Napi::String>().Utf8Value();
    const char* cmd[] = { "loadfile", url.c_str(), nullptr };
    int err = mpvLib_.command_async(mpv_, 0, cmd);
    return Napi::Number::New(env, err);
}

Napi::Value MpvPlayer::Command(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (destroyed_.load() || !mpv_) return env.Undefined();

    std::vector<std::string> argStrings;
    std::vector<const char*> args;

    for (size_t i = 0; i < info.Length(); i++) {
        if (info[i].IsString()) {
            argStrings.push_back(info[i].As<Napi::String>().Utf8Value());
        }
    }
    for (auto& s : argStrings) {
        args.push_back(s.c_str());
    }
    args.push_back(nullptr);

    int err = mpvLib_.command_async(mpv_, 0, args.data());
    return Napi::Number::New(env, err);
}

Napi::Value MpvPlayer::SetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (destroyed_.load() || !mpv_) return env.Undefined();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "setProperty(name, value) requires two strings")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    std::string value = info[1].As<Napi::String>().Utf8Value();
    int err = mpvLib_.set_property_string(mpv_, name.c_str(), value.c_str());
    return Napi::Number::New(env, err);
}

Napi::Value MpvPlayer::GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (destroyed_.load() || !mpv_) return env.Null();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "getProperty(name) requires a string")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    char* result = mpvLib_.get_property_string(mpv_, name.c_str());
    if (!result) return env.Null();

    Napi::String val = Napi::String::New(env, result);
    mpvLib_.free(result);
    return val;
}

Napi::Value MpvPlayer::ObserveProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (destroyed_.load() || !mpv_) return env.Undefined();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "observeProperty(name) requires a string")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    uint64_t id = ++observePropertyId_;
    int err = mpvLib_.observe_property(mpv_, id, name.c_str(), MPV_FORMAT_STRING);
    return Napi::Number::New(env, err);
}

Napi::Value MpvPlayer::GetFrameBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "getFrameBuffer(width, height) requires two numbers")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int width = info[0].As<Napi::Number>().Int32Value();
    int height = info[1].As<Napi::Number>().Int32Value();

    // Clamp to max 3840x2160
    if (width <= 0 || height <= 0) {
        Napi::Error::New(env, "width and height must be positive")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (width > 3840) width = 3840;
    if (height > 2160) height = 2160;

    // Calculate size: HEADER_SIZE + 3 slots * width * height * 4 (RGBA)
    size_t frameBytes = (size_t)width * height * 4;
    size_t totalSize = HEADER_SIZE + 3 * frameBytes;

    // Create SharedArrayBuffer
    Napi::ArrayBuffer sab = Napi::ArrayBuffer::New(env, totalSize);

    // Store reference
    sabRef_ = Napi::Persistent(sab);
    sabData_ = static_cast<uint8_t*>(sab.Data());
    sabSize_ = totalSize;

    // Initialize header to zero
    memset(sabData_, 0, HEADER_SIZE);

    // Set up frameIndex_ atomic at byte 0 of SAB header, initialize to -1
    frameIndex_ = new (sabData_) std::atomic<int>(-1);

    return sab;
}

Napi::Value MpvPlayer::ReportSwap(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!destroyed_.load() && mpvRender_) {
        mpvLib_.render_context_report_swap(mpvRender_);
    }
    return env.Undefined();
}

void MpvPlayer::Stop(const Napi::CallbackInfo& info) {
    if (destroyed_.load() || !mpv_) return;
    const char* cmd[] = { "stop", nullptr };
    mpvLib_.command_async(mpv_, 0, cmd);
}

void MpvPlayer::Destroy(const Napi::CallbackInfo& info) {
    destroyImpl();
}

void MpvPlayer::destroyImpl() {
    if (destroyed_.load()) return;
    destroyed_.store(true, std::memory_order_release);

    // Disconnect callbacks first
    if (mpvRender_) {
        mpvLib_.render_context_set_update_callback(mpvRender_, nullptr, nullptr);
    }
    if (mpv_) {
        mpvLib_.set_wakeup_callback(mpv_, nullptr, nullptr);
    }

    // Free render context (must happen before GL cleanup)
    if (mpvRender_) {
        gl_->makeCurrent();
        mpvLib_.render_context_free(mpvRender_);
        mpvRender_ = nullptr;
        gl_->doneCurrent();
    }

    // GL cleanup
    if (gl_) {
        gl_->makeCurrent();
        cleanupGlResources();
        gl_->doneCurrent();
        gl_->destroy();
        delete gl_;
        gl_ = nullptr;
    }

    // Terminate mpv
    if (mpv_) {
        mpvLib_.terminate_destroy(mpv_);
        mpv_ = nullptr;
    }

    // Close async handles
    if (asyncRenderInit_) {
        uv_close(reinterpret_cast<uv_handle_t*>(&asyncRender_), nullptr);
        asyncRenderInit_ = false;
    }
    if (asyncEventInit_) {
        uv_close(reinterpret_cast<uv_handle_t*>(&asyncEvent_), nullptr);
        asyncEventInit_ = false;
    }

    // Release ThreadSafeFunctions
    if (hasTsfnFrame_) {
        tsfnFrame_.Release();
        hasTsfnFrame_ = false;
    }
    if (hasTsfnPropertyChange_) {
        tsfnPropertyChange_.Release();
        hasTsfnPropertyChange_ = false;
    }
    if (hasTsfnEvent_) {
        tsfnEvent_.Release();
        hasTsfnEvent_ = false;
    }

    // Release SAB reference
    sabRef_.Reset();
    sabData_ = nullptr;
    sabSize_ = 0;
    frameIndex_ = nullptr;

    // Decrement instance count and release GC prevent ref
    instanceCount_.fetch_sub(1);
    glFunctionsLoaded = false;
    this->Unref();
}

// ---------------------------------------------------------------------------
// JS callback setters via ThreadSafeFunction
// ---------------------------------------------------------------------------

void MpvPlayer::SetOnFrame(const Napi::CallbackInfo& info, const Napi::Value& value) {
    Napi::Env env = info.Env();
    if (hasTsfnFrame_) {
        tsfnFrame_.Release();
        hasTsfnFrame_ = false;
    }
    if (value.IsFunction()) {
        tsfnFrame_ = Napi::ThreadSafeFunction::New(
            env,
            value.As<Napi::Function>(),
            "onFrame",
            0,  // unlimited queue
            1   // initial thread count
        );
        hasTsfnFrame_ = true;
    }
}

void MpvPlayer::SetOnPropertyChange(const Napi::CallbackInfo& info, const Napi::Value& value) {
    Napi::Env env = info.Env();
    if (hasTsfnPropertyChange_) {
        tsfnPropertyChange_.Release();
        hasTsfnPropertyChange_ = false;
    }
    if (value.IsFunction()) {
        tsfnPropertyChange_ = Napi::ThreadSafeFunction::New(
            env,
            value.As<Napi::Function>(),
            "onPropertyChange",
            0,
            1
        );
        hasTsfnPropertyChange_ = true;
    }
}

void MpvPlayer::SetOnEvent(const Napi::CallbackInfo& info, const Napi::Value& value) {
    Napi::Env env = info.Env();
    if (hasTsfnEvent_) {
        tsfnEvent_.Release();
        hasTsfnEvent_ = false;
    }
    if (value.IsFunction()) {
        tsfnEvent_ = Napi::ThreadSafeFunction::New(
            env,
            value.As<Napi::Function>(),
            "onEvent",
            0,
            1
        );
        hasTsfnEvent_ = true;
    }
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    MpvPlayer::Init(env, exports);
    exports.Set("version", Napi::String::New(env, "0.1.0"));
    return exports;
}

NODE_API_MODULE(node_libmpv, Init)
