import { ipcRenderer } from 'electron';
import { MPV_IPC } from '../../constants';
import { MpvPlaybackTiming, MpvPropertyChange } from '../../interfaces/MpvTypes';
import { getLogger } from '../../utils/logger';

const logger = getLogger('MpvBridge');

class MpvBridge {
    private active = false;
    private timing: MpvPlaybackTiming = { currentTime: 0, duration: 0, paused: true };
    private mpvVolume = 100;
    private mpvMuted = false;
    private capturedSrc = '';
    private fileLoaded = false;
    private eofReached = false;
    private vidWidth = 0;
    private vidHeight = 0;
    private videoRef: HTMLVideoElement | null = null;
    private cleanupFns: (() => void)[] = [];
    private seekBarInterval: ReturnType<typeof setInterval> | null = null;
    private lastStashedSrc = '';
    private pendingSeek: number | null = null;

    private resetPlaybackState() {
        this.timing = { currentTime: 0, duration: 0, paused: true };
        this.fileLoaded = false;
        this.eofReached = false;
        this.vidWidth = 0;
        this.vidHeight = 0;
        this.capturedSrc = '';
        this.pendingSeek = null;
    }

    // ── Lifecycle ────────────────────────────────────────────────

    activate(video: HTMLVideoElement) {
        if (this.active) this.deactivate();

        this.resetPlaybackState();

        this.active = true;
        this.videoRef = video;

        this.setupIpcListeners();
        this.startSeekBarSync();
        this.pushFullState();

        logger.info('MpvBridge activated');
    }

    deactivate() {
        for (const fn of this.cleanupFns) fn();
        this.cleanupFns = [];

        if (this.seekBarInterval) {
            clearInterval(this.seekBarInterval);
            this.seekBarInterval = null;
        }

        this.active = false;
        this.videoRef = null;
        this.resetPlaybackState();
        this.lastStashedSrc = '';
        this.pushState({ active: false, fileLoaded: false, readyState: 0, networkState: 0 });
        logger.info('MpvBridge deactivated');
    }

    // ── Queries ──────────────────────────────────────────────────

    isActive(): boolean { return this.active; }
    isFileLoaded(): boolean { return this.fileLoaded; }
    getLastStashedSrc(): string { return this.lastStashedSrc; }

    getMpvPlaybackState(): MpvPlaybackTiming | null {
        if (!this.active) return null;
        return { ...this.timing };
    }

    setCapturedSrc(url: string) {
        this.capturedSrc = url;
        this.pushState({ capturedSrc: url });
    }

    updateVideoRef(video: HTMLVideoElement) {
        this.videoRef = video;
    }

    /** Push available flag to page context */
    notifyAvailable(available: boolean) {
        this.pushState({ available });
    }

    /** Re-dispatch readiness events on the current videoRef (for React re-renders) */
    redispatchReadiness() {
        if (!this.fileLoaded) return;
        this.pushFullState();
        this.emit('loadstart');
        this.emit('durationchange');
        this.emit('loadedmetadata');
        this.emit('loadeddata');
        this.emit('canplay');
        this.emit('canplaythrough');
        if (!this.timing.paused) {
            this.emit('play');
            this.emit('playing');
        }
    }

    // ── Page command handler ─────────────────────────────────────

    handlePageCommand(action: string, value: any) {
        if (!this.active && action !== 'stash-src') return;

        switch (action) {
            case 'play':
                this.timing.paused = false;
                this.pushState({ paused: false });
                this.emit('play');
                this.emit('playing');
                ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'pause', 'no');
                break;

            case 'pause':
                this.timing.paused = true;
                this.pushState({ paused: true });
                this.emit('pause');
                ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'pause', 'yes');
                break;

            case 'seek':
                this.timing.currentTime = value;
                this.pushState({ currentTime: value });
                this.emit('seeking');
                if (this.fileLoaded) {
                    ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'time-pos', value);
                } else {
                    // File not loaded yet — queue seek for after file-loaded
                    this.pendingSeek = value;
                    logger.info(`[Seek] Queued pending seek to ${value} (file not loaded yet)`);
                }
                setTimeout(() => this.emit('seeked'), 150);
                break;

            case 'set-volume':
                this.mpvVolume = Math.round(value * 100);
                this.pushState({ volume: value });
                this.emit('volumechange');
                ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'volume', this.mpvVolume);
                break;

            case 'set-muted':
                this.mpvMuted = !!value;
                this.pushState({ muted: this.mpvMuted });
                this.emit('volumechange');
                ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'mute', value ? 'yes' : 'no');
                break;

            case 'set-src':
                if (value && value !== this.capturedSrc) {
                    this.capturedSrc = value;
                    this.resetForNewFile();
                    ipcRenderer.send(MPV_IPC.LOAD_FILE, value);
                    this.pushState({ capturedSrc: value, fileLoaded: false, readyState: 1, networkState: 2 });
                }
                break;

            case 'stash-src':
                this.lastStashedSrc = value;
                break;
        }
    }

    // ── Canvas integration ───────────────────────────────────────

    /** Update video dimensions from frame callback — dispatches readiness on first frame */
    setVideoDimensions(w: number, h: number) {
        if (!this.active) {
            logger.info(`[setVideoDimensions] Ignoring frame (${w}x${h}) — bridge not active`);
            return;
        }

        const firstFrame = this.vidWidth === 0 && this.vidHeight === 0 && w > 0 && h > 0;
        this.vidWidth = w;
        this.vidHeight = h;

        if (firstFrame && !this.fileLoaded) {
            this.fileLoaded = true;
            this.eofReached = false;
            this.timing.paused = false;
            // Push full state BEFORE events so page reads correct values
            this.pushState({
                videoWidth: w,
                videoHeight: h,
                fileLoaded: true,
                readyState: 4,
                networkState: 1,
                ended: false,
                paused: false,
                currentTime: this.timing.currentTime,
                duration: this.timing.duration,
            });
            this.emit('loadstart');
            this.emit('durationchange');
            this.emit('loadedmetadata');
            this.emit('loadeddata');
            this.emit('canplay');
            this.emit('canplaythrough');
            this.emit('play');
            this.emit('playing');
            // Ensure MPV is actually playing — it may start paused by default
            ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'pause', 'no');
            logger.info(`First frame received (${w}x${h}) — dispatched readiness events, sent pause=no`);
        } else {
            this.pushState({ videoWidth: w, videoHeight: h });
        }
    }

    // ── Cross-context state push (script injection) ──────────────
    //
    // With contextIsolation: true, CustomEvent.detail does NOT cross
    // from the preload's isolated world to the page's main world.
    // We inject a <script> that creates the CustomEvent inside the
    // page context, so e.detail is accessible to page listeners.

    pushState(updates: Record<string, any>) {
        try {
            const json = JSON.stringify(updates);
            const s = document.createElement('script');
            s.textContent = `window.dispatchEvent(new CustomEvent('__mpv_state',{detail:${json}}))`;
            document.documentElement.appendChild(s);
            s.remove();
        } catch (_) { /* ignore */ }
    }

    private pushFullState() {
        this.pushState({
            active: this.active,
            capturedSrc: this.capturedSrc,
            currentTime: this.timing.currentTime,
            duration: this.timing.duration,
            paused: this.timing.paused,
            volume: this.mpvVolume / 100,
            muted: this.mpvMuted,
            readyState: this.fileLoaded ? 4 : 1,
            networkState: this.fileLoaded ? 1 : 2,
            ended: this.eofReached,
            videoWidth: this.vidWidth,
            videoHeight: this.vidHeight,
            fileLoaded: this.fileLoaded,
        });
    }

    // ── Internal ─────────────────────────────────────────────────

    private emit(type: string) {
        this.videoRef?.dispatchEvent(new Event(type, { bubbles: false, cancelable: false }));
    }

    private resetForNewFile() {
        this.fileLoaded = false;
        this.eofReached = false;
        this.vidWidth = 0;
        this.vidHeight = 0;
        this.timing.currentTime = 0;
        this.timing.duration = 0;
        this.timing.paused = true;
        this.emit('emptied');
    }

    private startSeekBarSync() {
        this.seekBarInterval = setInterval(() => {
            if (!this.active || !this.videoRef || this.timing.paused) return;

            ipcRenderer.invoke(MPV_IPC.GET_PROPERTY, 'time-pos').then((val: any) => {
                const polled = Number(val) || 0;
                if (polled > 0) this.timing.currentTime = polled;

                this.pushState({ currentTime: this.timing.currentTime });
                this.emit('timeupdate');
            }).catch(() => {});
        }, 250);
    }

    private setupIpcListeners() {
        const onPropertyChange = (_: any, data: MpvPropertyChange) => {
            switch (data.name) {
                case 'time-pos':
                    // Fallback: observer-based update (polling in seekbar sync is primary)
                    this.timing.currentTime = Number(data.value) || 0;
                    break;
                case 'duration': {
                    const old = this.timing.duration;
                    this.timing.duration = Number(data.value) || 0;
                    if (old !== this.timing.duration) {
                        logger.info(`[IPC] duration changed: ${old} → ${this.timing.duration}`);
                        this.pushState({ duration: this.timing.duration });
                        this.emit('durationchange');
                    }
                    break;
                }
                case 'pause': {
                    const wasPaused = this.timing.paused;
                    this.timing.paused = data.value === 'yes' || data.value === true;
                    logger.info(`[IPC] pause changed: ${wasPaused} → ${this.timing.paused}`);
                    this.pushState({ paused: this.timing.paused });
                    if (wasPaused && !this.timing.paused) {
                        this.emit('play');
                        this.emit('playing');
                    } else if (!wasPaused && this.timing.paused) {
                        this.emit('pause');
                    }
                    break;
                }
                case 'volume':
                    this.mpvVolume = Number(data.value) || 0;
                    this.pushState({ volume: this.mpvVolume / 100 });
                    this.emit('volumechange');
                    break;
                case 'eof-reached':
                    if (data.value === 'yes' || data.value === true) {
                        this.eofReached = true;
                        this.pushState({ ended: true });
                        this.emit('ended');
                    }
                    break;
            }
        };

        const onEvent = (_: any, eventName: string) => {
            if (eventName === 'file-loaded') {
                this.eofReached = false;

                // Proactively fetch duration — may not arrive via property change
                // before the first frame triggers readiness events
                ipcRenderer.invoke(MPV_IPC.GET_PROPERTY, 'duration').then((dur: any) => {
                    const d = Number(dur) || 0;
                    if (d > 0 && this.timing.duration === 0) {
                        this.timing.duration = d;
                        this.pushState({ duration: d });
                        this.emit('durationchange');
                    }
                }).catch(() => {});

                // Apply pending seek (e.g. resume position set before file was ready)
                if (this.pendingSeek !== null) {
                    const seekTo = this.pendingSeek;
                    this.pendingSeek = null;
                    logger.info(`[Seek] Applying pending seek to ${seekTo} after file-loaded`);
                    ipcRenderer.send(MPV_IPC.SET_PROPERTY, 'time-pos', seekTo);
                    this.timing.currentTime = seekTo;
                    this.pushState({ currentTime: seekTo });
                }

                logger.info('MPV file-loaded event received');
            }
        };

        ipcRenderer.on(MPV_IPC.PROPERTY_CHANGE, onPropertyChange);
        ipcRenderer.on(MPV_IPC.EVENT, onEvent);
        this.cleanupFns.push(() => {
            ipcRenderer.removeListener(MPV_IPC.PROPERTY_CHANGE, onPropertyChange);
            ipcRenderer.removeListener(MPV_IPC.EVENT, onEvent);
        });
    }
}

export const mpvBridge = new MpvBridge();
