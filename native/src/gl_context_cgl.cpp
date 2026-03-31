// native/src/gl_context_cgl.cpp — macOS CGL offscreen GL context
#include "gl_context.h"
#include <OpenGL/OpenGL.h>
#include <dlfcn.h>

class CglContext : public GlContext {
public:
    bool init() override {
        CGLPixelFormatAttribute attrs[] = {
            kCGLPFAOpenGLProfile,
            static_cast<CGLPixelFormatAttribute>(kCGLOGLPVersion_3_2_Core),
            kCGLPFAAccelerated,
            static_cast<CGLPixelFormatAttribute>(0)
        };

        GLint numPixelFormats = 0;
        CGLError err = CGLChoosePixelFormat(attrs, &pixelFormat_, &numPixelFormats);
        if (err != kCGLNoError || numPixelFormats == 0) return false;

        err = CGLCreateContext(pixelFormat_, nullptr, &context_);
        if (err != kCGLNoError) return false;

        makeCurrent();
        return true;
    }

    void makeCurrent() override {
        CGLSetCurrentContext(context_);
    }

    void doneCurrent() override {
        CGLSetCurrentContext(nullptr);
    }

    void* getProcAddress(const char* name) override {
        // CGL does not have its own getProcAddress; use dlsym on the default handle
        return dlsym(RTLD_DEFAULT, name);
    }

    void destroy() override {
        if (context_) {
            CGLSetCurrentContext(nullptr);
            CGLDestroyContext(context_);
            context_ = nullptr;
        }
        if (pixelFormat_) {
            CGLDestroyPixelFormat(pixelFormat_);
            pixelFormat_ = nullptr;
        }
    }

    ~CglContext() override { destroy(); }

private:
    CGLContextObj context_ = nullptr;
    CGLPixelFormatObj pixelFormat_ = nullptr;
};

GlContext* createGlContext() {
    return new CglContext();
}
