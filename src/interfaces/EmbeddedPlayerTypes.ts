/** Playback modes — extends the existing external-player model with embedded-helper. */
export const VALID_PLAYBACK_MODES = ["disabled", "vlc", "mpv", "embedded-mpv"] as const;
export type PlaybackMode = typeof VALID_PLAYBACK_MODES[number];

/** Commands that the renderer/preload can send to the helper via main. */
export interface HelperCommand {
    type:
        | "initialize"
        | "create-session"
        | "attach-surface"
        | "set-bounds"
        | "load"
        | "play"
        | "pause"
        | "seek"
        | "set-volume"
        | "set-mute"
        | "set-speed"
        | "set-audio-track"
        | "set-subtitle-track"
        | "set-fullscreen"
        | "stop"
        | "shutdown";
    payload?: Record<string, unknown>;
}

/** Surface bounds sent from preload → main → helper. */
export interface SurfaceBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
}

/** Track descriptor pushed from the helper. */
export interface TrackInfo {
    id: number;
    type: "audio" | "video" | "subtitle";
    title?: string;
    lang?: string;
    codec?: string;
    selected: boolean;
}

/** Playback state pushed from the helper. */
export interface HelperPlaybackState {
    /** Seconds elapsed. */
    position: number;
    /** Total seconds. */
    duration: number;
    paused: boolean;
    buffering: boolean;
    volume: number;
    muted: boolean;
    speed: number;
    ended: boolean;
    /** Current tracks reported by mpv. */
    tracks: TrackInfo[];
}

/** Events the helper can emit back to the main process. */
export interface HelperEvent {
    type:
        | "state-updated"
        | "tracks-updated"
        | "loading"
        | "buffering"
        | "ended"
        | "helper-error"
        | "session-error"
        | "diagnostics";
    payload?: Record<string, unknown>;
}

/** Status of the helper process as tracked by the supervisor. */
export type HelperStatus = "idle" | "starting" | "ready" | "playing" | "error" | "crashed" | "shutdown";
