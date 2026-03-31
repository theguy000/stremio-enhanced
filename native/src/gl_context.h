#pragma once
#include <functional>

class GlContext {
public:
    virtual ~GlContext() = default;
    virtual bool init() = 0;
    virtual void makeCurrent() = 0;
    virtual void doneCurrent() = 0;
    virtual void* getProcAddress(const char* name) = 0;
    virtual void destroy() = 0;
};

// Factory function — returns platform-appropriate context
GlContext* createGlContext();
