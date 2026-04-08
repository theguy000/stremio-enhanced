#ifdef _WIN32
#include "../mpv_instance.h"

static const wchar_t* WINDOW_CLASS = L"MpvNativeChild";
static bool classRegistered = false;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    return DefWindowProcW(hwnd, msg, wp, lp);
}

PlatformWindow createChildWindow(void* parentHandle, int width, int height) {
    HWND parent = (HWND)parentHandle;

    if (!classRegistered) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = WndProc;
        wc.hInstance = GetModuleHandle(nullptr);
        wc.lpszClassName = WINDOW_CLASS;
        wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        RegisterClassExW(&wc);
        classRegistered = true;
    }

    HWND child = CreateWindowExW(
        0,
        WINDOW_CLASS,
        L"mpv",
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        0, 0, width, height,
        parent,
        nullptr,
        GetModuleHandle(nullptr),
        nullptr
    );

    return child;
}

void destroyChildWindow(PlatformWindow window) {
    if (window) DestroyWindow(window);
}

void resizeChildWindow(PlatformWindow window, int width, int height) {
    if (window) SetWindowPos(window, nullptr, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER);
}

void setChildWindowPosition(PlatformWindow window, int x, int y) {
    if (window) SetWindowPos(window, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
}

#endif // _WIN32
