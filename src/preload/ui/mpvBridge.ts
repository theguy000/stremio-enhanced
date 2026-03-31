import { ipcRenderer } from 'electron';
import { MPV_IPC } from '../../constants';
import { MpvPlaybackTiming, MpvPropertyChange } from '../../interfaces/MpvTypes';
import { getLogger } from '../../utils/logger';

const logger = getLogger('MpvBridge');

class MpvBridge {
    private active = false;
    private timing: MpvPlaybackTiming = { currentTime: 0, duration: 0, paused: true };
    private cleanupFns: (() => void)[] = [];

    activate() {
        if (this.active) return;
        this.active = true;

        const onPropertyChange = (_: any, data: MpvPropertyChange) => {
            switch (data.name) {
                case 'time-pos':
                    this.timing.currentTime = Number(data.value) || 0;
                    break;
                case 'duration':
                    this.timing.duration = Number(data.value) || 0;
                    break;
                case 'pause':
                    this.timing.paused = data.value === 'yes' || data.value === true;
                    break;
                case 'eof-reached':
                    if (data.value === 'yes' || data.value === true) {
                        this.triggerNextEpisode();
                    }
                    break;
            }
        };

        ipcRenderer.on(MPV_IPC.PROPERTY_CHANGE, onPropertyChange);
        this.cleanupFns.push(() => ipcRenderer.removeListener(MPV_IPC.PROPERTY_CHANGE, onPropertyChange));

        this.hookStremioControls();
        this.startSeekBarSync();

        logger.info('MpvBridge activated');
    }

    deactivate() {
        for (const fn of this.cleanupFns) fn();
        this.cleanupFns = [];
        this.active = false;
        this.timing = { currentTime: 0, duration: 0, paused: true };
        logger.info('MpvBridge deactivated');
    }

    getMpvPlaybackState(): MpvPlaybackTiming | null {
        if (!this.active) return null;
        return { ...this.timing };
    }

    isActive(): boolean {
        return this.active;
    }

    hookStremioControls() {
        const video = document.querySelector('video') as HTMLVideoElement;
        if (!video) return;

        const self = this;
        Object.defineProperty(video, 'currentTime', {
            get() { return self.timing.currentTime; },
            set(val: number) { self.seek(val); },
            configurable: true
        });

        Object.defineProperty(video, 'duration', {
            get() { return self.timing.duration; },
            configurable: true
        });

        Object.defineProperty(video, 'paused', {
            get() { return self.timing.paused; },
            configurable: true
        });

        const origPlay = video.play.bind(video);
        const origPause = video.pause.bind(video);
        video.play = () => { self.setPause(false); return Promise.resolve(); };
        video.pause = () => { self.setPause(true); };

        Object.defineProperty(video, 'volume', {
            get() { return 1; },
            set(val: number) { self.setVolume(val * 100); },
            configurable: true
        });

        this.cleanupFns.push(() => {
            delete (video as any).currentTime;
            delete (video as any).duration;
            delete (video as any).paused;
            delete (video as any).volume;
            video.play = origPlay;
            video.pause = origPause;
        });
    }

    seek(timePos: number) {
        ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'time-pos', timePos);
    }

    setVolume(volume: number) {
        ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'volume', volume);
    }

    setPause(paused: boolean) {
        ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'pause', paused ? 'yes' : 'no');
    }

    private seekBarInterval: ReturnType<typeof setInterval> | null = null;

    private startSeekBarSync() {
        this.seekBarInterval = setInterval(() => {
            const video = document.querySelector('video') as HTMLVideoElement;
            if (video) {
                video.dispatchEvent(new Event('timeupdate'));
            }
        }, 250);
        this.cleanupFns.push(() => {
            if (this.seekBarInterval) clearInterval(this.seekBarInterval);
        });
    }

    private triggerNextEpisode() {
        try {
            const video = document.querySelector('video');
            if (video) {
                video.dispatchEvent(new Event('ended'));
            }
        } catch (err) {
            logger.error('Failed to trigger next episode: ' + err);
        }
    }
}

export const mpvBridge = new MpvBridge();
