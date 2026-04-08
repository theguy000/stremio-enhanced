export interface MpvTrack {
    id: number;
    type: 'audio' | 'sub' | 'video';
    codec: string;
    lang?: string;
    title?: string;
    external?: boolean;
    selected?: boolean;
    default?: boolean;
}

export interface MpvEvent {
    event: string;
    data?: any;
}

export interface MpvPropertyChange {
    name: string;
    value: any;
}

export interface MpvFileLoadOptions {
    url: string;
    subtitles?: MpvSubtitleTrack[];
    preferredLang?: string;
    metadata?: {
        title?: string;
        season?: number;
        episode?: number;
    };
}

export interface MpvSubtitleTrack {
    url: string;
    lang: string;
    origin: string;
}

export interface MpvState {
    playing: boolean;
    paused: boolean;
    position: number;
    duration: number;
    volume: number;
    muted: boolean;
    speed: number;
    tracks: MpvTrack[];
    buffering: boolean;
}
