#pragma once

class GlContext {
public:
    virtual ~GlContext() = default;
    virtual bool init() = 0;
    virtual void makeCurrent() = 0;
    virtual void swapBuffers() = 0;
    virtual void* getProcAddress(const char* name) = 0;
};
