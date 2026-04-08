#ifndef MPV_INSTANCE_H
#define MPV_INSTANCE_H

#include <napi.h>
#include <mpv/client.h>
#include <cstdint>
#include <vector>
#include <string>

// Forward declarations for platform window handles
#if defined(_WIN32)
#include <windows.h>
typedef HWND PlatformWindow;
#elif defined(__APPLE__)
typedef void* PlatformWindow; // NSView*
#else
typedef unsigned long PlatformWindow; // X11 Window
#endif

// Platform-specific window creation (implemented in platform/*.cpp)
PlatformWindow createChildWindow(void* parentHandle, int width, int height);
void destroyChildWindow(PlatformWindow window);
void resizeChildWindow(PlatformWindow window, int width, int height);
void setChildWindowPosition(PlatformWindow window, int x, int y);

struct MpvEventData {
    std::string event;
    std::string propertyName;
    std::string propertyValueStr;
    double propertyValueNum;
    int propertyValueFlag;
    int propertyFormat; // 0=none, 1=string, 2=double, 3=flag
};

class MpvInstance {
public:
    MpvInstance();
    ~MpvInstance();

    bool create(void* parentWindowHandle);
    void destroy();

    void command(const std::vector<std::string>& args);
    void setProperty(const std::string& name, const std::string& value);
    void setPropertyDouble(const std::string& name, double value);
    void setPropertyBool(const std::string& name, bool value);
    std::string getPropertyString(const std::string& name);
    double getPropertyDouble(const std::string& name);
    bool getPropertyBool(const std::string& name);
    void observeProperty(const std::string& name, int id, int format);

    std::vector<MpvEventData> pollEvents();

    void resize(int width, int height);
    void setPosition(int x, int y);

    bool isValid() const { return mpv_ != nullptr; }

private:
    mpv_handle* mpv_;
    PlatformWindow childWindow_;
};

#endif // MPV_INSTANCE_H
