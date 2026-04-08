#include "mpv_instance.h"
#include <cstring>
#include <stdexcept>

MpvInstance::MpvInstance() : mpv_(nullptr), childWindow_(0) {}

MpvInstance::~MpvInstance() {
    destroy();
}

bool MpvInstance::create(void* parentWindowHandle) {
    mpv_ = mpv_create();
    if (!mpv_) return false;

    // Create a child window for mpv to render into
    childWindow_ = createChildWindow(parentWindowHandle, 800, 600);
    if (!childWindow_) {
        mpv_destroy(mpv_);
        mpv_ = nullptr;
        return false;
    }

    // Tell mpv to render into our child window
    int64_t wid = (int64_t)(intptr_t)childWindow_;
    mpv_set_option(mpv_, "wid", MPV_FORMAT_INT64, &wid);

    // Sensible defaults
    mpv_set_option_string(mpv_, "vo", "gpu");
    mpv_set_option_string(mpv_, "hwdec", "auto");
    mpv_set_option_string(mpv_, "keep-open", "yes");
    mpv_set_option_string(mpv_, "idle", "yes");
    mpv_set_option_string(mpv_, "input-default-bindings", "no");
    mpv_set_option_string(mpv_, "input-vo-keyboard", "no");
    mpv_set_option_string(mpv_, "osc", "no");
    mpv_set_option_string(mpv_, "osd-level", "0");

    int err = mpv_initialize(mpv_);
    if (err < 0) {
        destroyChildWindow(childWindow_);
        childWindow_ = 0;
        mpv_destroy(mpv_);
        mpv_ = nullptr;
        return false;
    }

    return true;
}

void MpvInstance::destroy() {
    if (mpv_) {
        mpv_terminate_destroy(mpv_);
        mpv_ = nullptr;
    }
    if (childWindow_) {
        destroyChildWindow(childWindow_);
        childWindow_ = 0;
    }
}

void MpvInstance::command(const std::vector<std::string>& args) {
    if (!mpv_) return;
    std::vector<const char*> cargs;
    for (const auto& a : args) cargs.push_back(a.c_str());
    cargs.push_back(nullptr);
    mpv_command(mpv_, cargs.data());
}

void MpvInstance::setProperty(const std::string& name, const std::string& value) {
    if (!mpv_) return;
    mpv_set_property_string(mpv_, name.c_str(), value.c_str());
}

void MpvInstance::setPropertyDouble(const std::string& name, double value) {
    if (!mpv_) return;
    mpv_set_property(mpv_, name.c_str(), MPV_FORMAT_DOUBLE, &value);
}

void MpvInstance::setPropertyBool(const std::string& name, bool value) {
    if (!mpv_) return;
    int flag = value ? 1 : 0;
    mpv_set_property(mpv_, name.c_str(), MPV_FORMAT_FLAG, &flag);
}

std::string MpvInstance::getPropertyString(const std::string& name) {
    if (!mpv_) return "";
    char* val = mpv_get_property_string(mpv_, name.c_str());
    if (!val) return "";
    std::string result(val);
    mpv_free(val);
    return result;
}

double MpvInstance::getPropertyDouble(const std::string& name) {
    if (!mpv_) return 0.0;
    double val = 0.0;
    mpv_get_property(mpv_, name.c_str(), MPV_FORMAT_DOUBLE, &val);
    return val;
}

bool MpvInstance::getPropertyBool(const std::string& name) {
    if (!mpv_) return false;
    int flag = 0;
    mpv_get_property(mpv_, name.c_str(), MPV_FORMAT_FLAG, &flag);
    return flag != 0;
}

void MpvInstance::observeProperty(const std::string& name, int id, int format) {
    if (!mpv_) return;
    mpv_format fmt = MPV_FORMAT_NONE;
    switch (format) {
        case 1: fmt = MPV_FORMAT_STRING; break;
        case 2: fmt = MPV_FORMAT_DOUBLE; break;
        case 3: fmt = MPV_FORMAT_FLAG; break;
        default: fmt = MPV_FORMAT_NONE; break;
    }
    mpv_observe_property(mpv_, id, name.c_str(), fmt);
}

void MpvInstance::resize(int width, int height) {
    if (childWindow_) resizeChildWindow(childWindow_, width, height);
}

void MpvInstance::setPosition(int x, int y) {
    if (childWindow_) setChildWindowPosition(childWindow_, x, y);
}
