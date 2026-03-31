// native/src/gl_context_wgl.cpp — Windows WGL offscreen GL context
#include "gl_context.h"
#include <windows.h>
#include <GL/gl.h>

class WglContext : public GlContext {
public:
    bool init() override {
        // Create a hidden window using the built-in "STATIC" class
        hwnd_ = CreateWindowExW(0, L"STATIC", L"mpv-gl", 0,
                                0, 0, 1, 1, nullptr, nullptr,
                                GetModuleHandleW(nullptr), nullptr);
        if (!hwnd_) return false;

        hdc_ = GetDC(hwnd_);
        if (!hdc_) return false;

        // Minimal pixel format: 32-bit RGBA, no depth
        PIXELFORMATDESCRIPTOR pfd = {};
        pfd.nSize = sizeof(pfd);
        pfd.nVersion = 1;
        pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL;
        pfd.iPixelType = PFD_TYPE_RGBA;
        pfd.cColorBits = 32;
        pfd.iLayerType = PFD_MAIN_PLANE;

        int fmt = ChoosePixelFormat(hdc_, &pfd);
        if (!fmt || !SetPixelFormat(hdc_, fmt, &pfd)) return false;

        hglrc_ = wglCreateContext(hdc_);
        if (!hglrc_) return false;

        wglMakeCurrent(hdc_, hglrc_);
        opengl32_ = GetModuleHandleW(L"opengl32.dll");
        return true;
    }

    void makeCurrent() override {
        wglMakeCurrent(hdc_, hglrc_);
    }

    void doneCurrent() override {
        wglMakeCurrent(hdc_, nullptr);
    }

    void* getProcAddress(const char* name) override {
        void* addr = reinterpret_cast<void*>(wglGetProcAddress(name));
        // wglGetProcAddress returns NULL for OpenGL 1.1 core functions;
        // fall back to GetProcAddress on opengl32.dll
        if (!addr && opengl32_) {
            addr = reinterpret_cast<void*>(GetProcAddress(opengl32_, name));
        }
        return addr;
    }

    void destroy() override {
        if (hglrc_) {
            wglMakeCurrent(nullptr, nullptr);
            wglDeleteContext(hglrc_);
            hglrc_ = nullptr;
        }
        if (hdc_ && hwnd_) {
            ReleaseDC(hwnd_, hdc_);
            hdc_ = nullptr;
        }
        if (hwnd_) {
            DestroyWindow(hwnd_);
            hwnd_ = nullptr;
        }
    }

    ~WglContext() override { destroy(); }

private:
    HWND hwnd_ = nullptr;
    HDC hdc_ = nullptr;
    HGLRC hglrc_ = nullptr;
    HMODULE opengl32_ = nullptr;
};

GlContext* createGlContext() {
    return new WglContext();
}
