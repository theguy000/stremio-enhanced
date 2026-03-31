// native/src/gl_context_egl.cpp — Linux EGL offscreen GL context
#include "gl_context.h"
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <dlfcn.h>

class EglContext : public GlContext {
public:
    bool init() override {
        // Try platform display extensions in order of preference
        auto eglGetPlatformDisplayEXT =
            reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(
                eglGetProcAddress("eglGetPlatformDisplayEXT"));

        if (eglGetPlatformDisplayEXT) {
            // 1. Try EGL_PLATFORM_DEVICE_EXT (works on NVIDIA proprietary)
            display_ = eglGetPlatformDisplayEXT(
                EGL_PLATFORM_DEVICE_EXT, EGL_DEFAULT_DISPLAY, nullptr);
            if (display_ != EGL_NO_DISPLAY && eglInitialize(display_, nullptr, nullptr)) {
                goto have_display;
            }

            // 2. Try EGL_MESA_platform_surfaceless
            constexpr EGLint MESA_SURFACELESS = 0x31DD;
            display_ = eglGetPlatformDisplayEXT(
                MESA_SURFACELESS, EGL_DEFAULT_DISPLAY, nullptr);
            if (display_ != EGL_NO_DISPLAY && eglInitialize(display_, nullptr, nullptr)) {
                goto have_display;
            }
        }

        // 3. Fall back to default display
        display_ = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (display_ == EGL_NO_DISPLAY) return false;
        if (!eglInitialize(display_, nullptr, nullptr)) { destroy(); return false; }

    have_display:
        // Choose config — prefer OpenGL ES 3.0, fall back to OpenGL
        static const EGLint configAttrsES[] = {
            EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
            EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,
            EGL_RED_SIZE,        8,
            EGL_GREEN_SIZE,      8,
            EGL_BLUE_SIZE,       8,
            EGL_ALPHA_SIZE,      8,
            EGL_NONE
        };
        static const EGLint configAttrsGL[] = {
            EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
            EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,
            EGL_RED_SIZE,        8,
            EGL_GREEN_SIZE,      8,
            EGL_BLUE_SIZE,       8,
            EGL_ALPHA_SIZE,      8,
            EGL_NONE
        };

        EGLConfig config;
        EGLint numConfigs = 0;
        bool useGL = false;

        if (eglChooseConfig(display_, configAttrsES, &config, 1, &numConfigs)
            && numConfigs > 0) {
            eglBindAPI(EGL_OPENGL_ES_API);
        } else if (eglChooseConfig(display_, configAttrsGL, &config, 1, &numConfigs)
                   && numConfigs > 0) {
            eglBindAPI(EGL_OPENGL_API);
            useGL = true;
        } else {
            destroy();
            return false;
        }

        // Create context
        if (useGL) {
            static const EGLint ctxAttrsGL[] = {
                EGL_CONTEXT_MAJOR_VERSION, 3,
                EGL_CONTEXT_MINOR_VERSION, 3,
                EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
                EGL_NONE
            };
            context_ = eglCreateContext(display_, config, EGL_NO_CONTEXT, ctxAttrsGL);
        } else {
            static const EGLint ctxAttrsES[] = {
                EGL_CONTEXT_MAJOR_VERSION, 3,
                EGL_CONTEXT_MINOR_VERSION, 0,
                EGL_NONE
            };
            context_ = eglCreateContext(display_, config, EGL_NO_CONTEXT, ctxAttrsES);
        }
        if (context_ == EGL_NO_CONTEXT) { destroy(); return false; }

        // Create a 1x1 pbuffer surface (some drivers need a surface to make current)
        static const EGLint pbufferAttrs[] = {
            EGL_WIDTH, 1,
            EGL_HEIGHT, 1,
            EGL_NONE
        };
        surface_ = eglCreatePbufferSurface(display_, config, pbufferAttrs);
        // surface_ may be EGL_NO_SURFACE on surfaceless platforms — that is OK

        makeCurrent();
        return true;
    }

    void makeCurrent() override {
        eglMakeCurrent(display_, surface_, surface_, context_);
    }

    void doneCurrent() override {
        eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }

    void* getProcAddress(const char* name) override {
        return reinterpret_cast<void*>(eglGetProcAddress(name));
    }

    void destroy() override {
        if (display_ != EGL_NO_DISPLAY) {
            eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (context_ != EGL_NO_CONTEXT) {
                eglDestroyContext(display_, context_);
                context_ = EGL_NO_CONTEXT;
            }
            if (surface_ != EGL_NO_SURFACE) {
                eglDestroySurface(display_, surface_);
                surface_ = EGL_NO_SURFACE;
            }
            eglTerminate(display_);
            display_ = EGL_NO_DISPLAY;
        }
    }

    ~EglContext() override { destroy(); }

private:
    EGLDisplay display_ = EGL_NO_DISPLAY;
    EGLContext context_ = EGL_NO_CONTEXT;
    EGLSurface surface_ = EGL_NO_SURFACE;
};

GlContext* createGlContext() {
    return new EglContext();
}
