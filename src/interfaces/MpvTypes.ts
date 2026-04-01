export interface MpvFrameReady {
    width: number;
    height: number;
    data: Buffer;
}

export interface MpvPropertyChange {
    name: string;
    value: string | number | boolean;
}

export interface MpvPlaybackTiming {
    currentTime: number;
    duration: number;
    paused: boolean;
}
