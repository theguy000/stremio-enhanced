#ifdef __APPLE__
#import <Cocoa/Cocoa.h>
#include "../mpv_instance.h"

PlatformWindow createChildWindow(void* parentHandle, int width, int height) {
    NSView* parentView = (__bridge NSView*)parentHandle;
    NSRect frame = NSMakeRect(0, 0, width, height);

    NSView* childView = [[NSView alloc] initWithFrame:frame];
    childView.wantsLayer = YES;
    childView.layer.backgroundColor = [NSColor blackColor].CGColor;
    childView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    [parentView addSubview:childView];

    return (__bridge_retained void*)childView;
}

void destroyChildWindow(PlatformWindow window) {
    if (window) {
        NSView* view = (__bridge_transfer NSView*)window;
        [view removeFromSuperview];
    }
}

void resizeChildWindow(PlatformWindow window, int width, int height) {
    if (window) {
        NSView* view = (__bridge NSView*)window;
        [view setFrameSize:NSMakeSize(width, height)];
    }
}

void setChildWindowPosition(PlatformWindow window, int x, int y) {
    if (window) {
        NSView* view = (__bridge NSView*)window;
        [view setFrameOrigin:NSMakePoint(x, y)];
    }
}

#endif // __APPLE__
