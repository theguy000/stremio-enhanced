#include "mpv_instance.h"

std::vector<MpvEventData> MpvInstance::pollEvents() {
    std::vector<MpvEventData> events;
    if (!mpv_) return events;

    while (true) {
        mpv_event* event = mpv_wait_event(mpv_, 0);
        if (!event || event->event_id == MPV_EVENT_NONE) break;

        MpvEventData data;
        data.propertyFormat = 0;
        data.propertyValueNum = 0;
        data.propertyValueFlag = 0;

        switch (event->event_id) {
            case MPV_EVENT_PROPERTY_CHANGE: {
                mpv_event_property* prop = (mpv_event_property*)event->data;
                data.event = "property-change";
                data.propertyName = prop->name ? prop->name : "";

                if (prop->format == MPV_FORMAT_STRING && prop->data) {
                    data.propertyFormat = 1;
                    data.propertyValueStr = *(char**)prop->data;
                } else if (prop->format == MPV_FORMAT_DOUBLE && prop->data) {
                    data.propertyFormat = 2;
                    data.propertyValueNum = *(double*)prop->data;
                } else if (prop->format == MPV_FORMAT_FLAG && prop->data) {
                    data.propertyFormat = 3;
                    data.propertyValueFlag = *(int*)prop->data;
                } else if (prop->format == MPV_FORMAT_NODE && prop->data) {
                    // For complex types like track-list, stringify via mpv
                    char* json = mpv_get_property_string(mpv_, prop->name);
                    if (json) {
                        data.propertyFormat = 1;
                        data.propertyValueStr = json;
                        mpv_free(json);
                    }
                }
                break;
            }
            case MPV_EVENT_FILE_LOADED:
                data.event = "file-loaded";
                break;
            case MPV_EVENT_END_FILE: {
                data.event = "end-file";
                mpv_event_end_file* ef = (mpv_event_end_file*)event->data;
                if (ef) {
                    switch (ef->reason) {
                        case MPV_END_FILE_REASON_EOF: data.propertyValueStr = "eof"; break;
                        case MPV_END_FILE_REASON_STOP: data.propertyValueStr = "stop"; break;
                        case MPV_END_FILE_REASON_ERROR: data.propertyValueStr = "error"; break;
                        default: data.propertyValueStr = "unknown"; break;
                    }
                    data.propertyFormat = 1;
                }
                break;
            }
            case MPV_EVENT_SEEK:
                data.event = "seek";
                break;
            case MPV_EVENT_PLAYBACK_RESTART:
                data.event = "playback-restart";
                break;
            default:
                continue; // Skip events we don't care about
        }

        events.push_back(data);
    }

    return events;
}
