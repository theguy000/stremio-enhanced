#if defined(__linux__)
#include "../mpv_instance.h"
#include <X11/Xlib.h>

PlatformWindow createChildWindow(void* parentHandle, int width, int height) {
    Window parent = (Window)(uintptr_t)parentHandle;
    Display* display = XOpenDisplay(nullptr);
    if (!display) return 0;

    Window child = XCreateSimpleWindow(
        display, parent,
        0, 0, width, height,
        0,
        BlackPixel(display, DefaultScreen(display)),
        BlackPixel(display, DefaultScreen(display))
    );

    XMapWindow(display, child);
    XFlush(display);

    // Store display handle — in production, manage this more carefully
    // For now, we leak the Display* (one per mpv instance lifetime)
    return child;
}

void destroyChildWindow(PlatformWindow window) {
    if (window) {
        Display* display = XOpenDisplay(nullptr);
        if (display) {
            XDestroyWindow(display, window);
            XCloseDisplay(display);
        }
    }
}

void resizeChildWindow(PlatformWindow window, int width, int height) {
    if (window) {
        Display* display = XOpenDisplay(nullptr);
        if (display) {
            XResizeWindow(display, window, width, height);
            XFlush(display);
            XCloseDisplay(display);
        }
    }
}

void setChildWindowPosition(PlatformWindow window, int x, int y) {
    if (window) {
        Display* display = XOpenDisplay(nullptr);
        if (display) {
            XMoveWindow(display, window, x, y);
            XFlush(display);
            XCloseDisplay(display);
        }
    }
}

#endif // __linux__
