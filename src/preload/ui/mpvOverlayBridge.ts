import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../constants';
import { getLogger } from '../../utils/logger';

const logger = getLogger("MpvOverlayBridge");

// Direct IPC helpers — preload runs in isolated world, not renderer.
// contextBridge-exposed APIs (window.mpvPlayer) are only available in the
// renderer world. The bridge must use ipcRenderer directly.
const mpv = {
    seek: (position: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SEEK, { position }),
    togglePause: () => ipcRenderer.send(IPC_CHANNELS.MPV_TOGGLE_PAUSE),
    setVolume: (volume: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SET_VOLUME, { volume }),
    setTrack: (type: 'audio' | 'sub', id: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SET_TRACK, { type, id }),
    setSpeed: (speed: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SET_SPEED, { speed }),
    command: (args: string[]) => ipcRenderer.send(IPC_CHANNELS.MPV_COMMAND, { args }),
    destroy: () => ipcRenderer.send(IPC_CHANNELS.MPV_DESTROY),
    toggleFullscreen: () => ipcRenderer.send(IPC_CHANNELS.MPV_TOGGLE_FULLSCREEN),
    getProperty: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.MPV_GET_PROP, { name }),
    onPropertyChange: (cb: (data: { name: string; value: any }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_PROPERTY_CHANGE, (_, data) => cb(data));
    },
    onFileLoaded: (cb: (data: any) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_FILE_LOADED, (_, data) => cb(data));
    },
    onEndFile: (cb: (data: { reason: string }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_END_FILE, (_, data) => cb(data));
    },
    onPlaybackError: (cb: (data: { error: string }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_PLAYBACK_ERROR, (_, data) => cb(data));
    },
    onEvent: (cb: (data: { event: string; data?: any }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_EVENT, (_, data) => cb(data));
    },
};

// State
let duration = 0;
let isSeeking = false;

function formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

export function initOverlayBridge(): void {
    logger.info("Initializing overlay bridge");

    setupControls();
    setupPropertyListeners();
    setupEventListeners();
    setupMouseBehavior();

    logger.info("Overlay bridge initialized");
}

function setupControls(): void {
    // Play/Pause
    $('embedded-play-pause-btn')?.addEventListener('click', () => {
        mpv.togglePause();
    });

    // Seek bar
    const seekInput = $('embedded-seek-input') as HTMLInputElement | null;
    if (seekInput) {
        seekInput.addEventListener('input', () => {
            isSeeking = true;
            const pos = (parseFloat(seekInput.value) / 100) * duration;
            const timeEl = $('embedded-time-current');
            if (timeEl) timeEl.textContent = formatTime(pos);

            const progress = $('embedded-seek-progress');
            if (progress) progress.style.width = `${seekInput.value}%`;
        });

        seekInput.addEventListener('change', () => {
            const pos = (parseFloat(seekInput.value) / 100) * duration;
            mpv.seek(pos);
            isSeeking = false;
        });
    }

    // Volume slider
    const volumeSlider = $('embedded-volume-slider') as HTMLInputElement | null;
    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            mpv.setVolume(parseInt(volumeSlider.value));
        });
    }

    // Mute button
    $('embedded-mute-btn')?.addEventListener('click', () => {
        mpv.command(['cycle', 'mute']);
    });

    // Back button / destroy
    $('embedded-back-btn')?.addEventListener('click', () => {
        mpv.destroy();
    });

    // Fullscreen toggle
    $('embedded-fullscreen-btn')?.addEventListener('click', () => {
        mpv.toggleFullscreen();
    });

    // Next button
    $('embedded-next-btn')?.addEventListener('click', () => {
        mpv.command(['playlist-next']);
    });

    // Speed menu items
    document.querySelectorAll('[data-speed]').forEach(el => {
        el.addEventListener('click', () => {
            const speed = parseFloat(el.getAttribute('data-speed') || '1');
            mpv.setSpeed(speed);
        });
    });

    // Subtitle menu button
    $('embedded-subtitle-btn')?.addEventListener('click', () => {
        const menu = $('embedded-subtitle-menu');
        if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });

    // Audio menu button
    $('embedded-audio-btn')?.addEventListener('click', () => {
        const menu = $('embedded-audio-menu');
        if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });

    // Speed menu button
    $('embedded-speed-btn')?.addEventListener('click', () => {
        const menu = $('embedded-speed-menu');
        if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });

    // Dismiss buttons on error/popup
    $('embedded-error-dismiss')?.addEventListener('click', () => {
        const layer = $('embedded-error-layer');
        if (layer) layer.style.display = 'none';
    });

    $('nvp-dismiss')?.addEventListener('click', () => {
        const popup = $('embedded-next-video-popup');
        if (popup) popup.style.display = 'none';
    });
}

function setupPropertyListeners(): void {
    mpv.onPropertyChange((data) => {
        switch (data.name) {
            case 'time-pos': {
                if (isSeeking) break;
                const seekInput = $('embedded-seek-input') as HTMLInputElement | null;
                const seekProgress = $('embedded-seek-progress');
                const timeEl = $('embedded-time-current');
                const pos = data.value as number;
                const pct = duration > 0 ? (pos / duration) * 100 : 0;
                if (seekInput) seekInput.value = String(pct);
                if (seekProgress) seekProgress.style.width = `${pct}%`;
                if (timeEl) timeEl.textContent = formatTime(pos);
                break;
            }
            case 'duration': {
                duration = data.value as number;
                const durationEl = $('embedded-time-duration');
                if (durationEl) durationEl.textContent = formatTime(duration);
                break;
            }
            case 'pause': {
                const playIcon = $('embedded-play-icon');
                const pauseIcon = $('embedded-pause-icon');
                const paused = data.value as boolean;
                if (playIcon) playIcon.style.display = paused ? '' : 'none';
                if (pauseIcon) pauseIcon.style.display = paused ? 'none' : '';
                break;
            }
            case 'volume': {
                const slider = $('embedded-volume-slider') as HTMLInputElement | null;
                if (slider) slider.value = String(Math.round(data.value as number));
                break;
            }
            case 'mute': {
                const volIcon = $('embedded-volume-icon');
                const mutedIcon = $('embedded-muted-icon');
                const muted = data.value as boolean;
                if (volIcon) volIcon.style.display = muted ? 'none' : '';
                if (mutedIcon) mutedIcon.style.display = muted ? '' : 'none';
                break;
            }
            case 'speed': {
                const label = $('embedded-speed-label');
                if (label) label.textContent = `${data.value}x`;
                break;
            }
            case 'track-list': {
                updateTrackMenus(data.value);
                break;
            }
            case 'demuxer-cache-time': {
                const buffered = $('embedded-seek-buffered');
                if (buffered && duration > 0) {
                    const pct = ((data.value as number) / duration) * 100;
                    buffered.style.width = `${Math.min(pct, 100)}%`;
                }
                break;
            }
            case 'core-idle': {
                const spinner = $('embedded-buffering-layer');
                if (spinner) spinner.style.display = data.value ? 'flex' : 'none';
                break;
            }
            case 'eof-reached': {
                if (data.value) {
                    const popup = $('embedded-next-video-popup');
                    if (popup) popup.style.display = 'flex';
                }
                break;
            }
        }
    });
}

function updateTrackMenus(trackListJson: any): void {
    let tracks: any[];
    try {
        tracks = typeof trackListJson === 'string' ? JSON.parse(trackListJson) : trackListJson;
    } catch {
        return;
    }

    const audioTracks = tracks.filter((t: any) => t.type === 'audio');
    const subTracks = tracks.filter((t: any) => t.type === 'sub');

    // Update audio menu
    const audioMenuItems = $('embedded-audio-menu-items');
    if (audioMenuItems) {
        audioMenuItems.innerHTML = '';
        for (const track of audioTracks) {
            const item = document.createElement('div');
            item.className = 'menu-item';
            item.textContent = track.title || track.lang || `Audio ${track.id}`;
            if (track.selected) item.classList.add('selected');
            item.addEventListener('click', () => {
                mpv.setTrack('audio', track.id);
                const menu = $('embedded-audio-menu');
                if (menu) menu.style.display = 'none';
            });
            audioMenuItems.appendChild(item);
        }
    }

    // Update subtitle menu
    const subMenuItems = $('embedded-subtitle-menu-items');
    if (subMenuItems) {
        subMenuItems.innerHTML = '';

        const embedded = subTracks.filter((t: any) => !t.external);
        const external = subTracks.filter((t: any) => t.external);

        for (const track of embedded) {
            const item = document.createElement('div');
            item.className = 'menu-item';
            const codec = track.codec?.toUpperCase() || '';
            item.innerHTML = `<span>${track.title || track.lang || `Sub ${track.id}`}</span>
                              <span class="badge embedded">${codec} · Embedded</span>`;
            if (track.selected) item.classList.add('selected');
            item.addEventListener('click', () => {
                mpv.setTrack('sub', track.id);
                const menu = $('embedded-subtitle-menu');
                if (menu) menu.style.display = 'none';
            });
            subMenuItems.appendChild(item);
        }

        if (embedded.length > 0 && external.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'menu-divider';
            subMenuItems.appendChild(divider);
        }

        for (const track of external) {
            const item = document.createElement('div');
            item.className = 'menu-item';
            const origin = track.title?.split(' ')[0] || 'External';
            item.innerHTML = `<span>${track.lang || `Sub ${track.id}`}</span>
                              <span class="badge external">${origin}</span>`;
            if (track.selected) item.classList.add('selected');
            item.addEventListener('click', () => {
                mpv.setTrack('sub', track.id);
                const menu = $('embedded-subtitle-menu');
                if (menu) menu.style.display = 'none';
            });
            subMenuItems.appendChild(item);
        }

        // "Off" option
        const offItem = document.createElement('div');
        offItem.className = 'menu-item';
        offItem.textContent = 'Off';
        offItem.addEventListener('click', () => {
            mpv.setTrack('sub', 0);
            const menu = $('embedded-subtitle-menu');
            if (menu) menu.style.display = 'none';
        });
        subMenuItems.appendChild(offItem);
    }
}

function setupEventListeners(): void {
    mpv.onEndFile((data) => {
        if (data.reason === 'eof') {
            const popup = $('embedded-next-video-popup');
            if (popup) popup.style.display = 'flex';
        }
        if (data.reason === 'error') {
            const errorLayer = $('embedded-error-layer');
            if (errorLayer) errorLayer.style.display = 'flex';
        }
    });

    mpv.onPlaybackError((data) => {
        const errorLayer = $('embedded-error-layer');
        const errorMsg = $('embedded-error-message');
        if (errorLayer) errorLayer.style.display = 'flex';
        if (errorMsg) errorMsg.textContent = data.error;
    });
}

function setupMouseBehavior(): void {
    let mouseTimer: ReturnType<typeof setTimeout> | null = null;

    const showControls = () => {
        const navBar = $('embedded-nav-bar');
        const controlBar = $('embedded-control-bar');
        if (navBar) navBar.style.opacity = '1';
        if (controlBar) controlBar.style.opacity = '1';
        document.body.style.cursor = 'default';
    };

    const hideControls = () => {
        const navBar = $('embedded-nav-bar');
        const controlBar = $('embedded-control-bar');
        if (navBar) navBar.style.opacity = '0';
        if (controlBar) controlBar.style.opacity = '0';
        document.body.style.cursor = 'none';
    };

    document.addEventListener('mousemove', () => {
        showControls();
        if (mouseTimer) clearTimeout(mouseTimer);
        mouseTimer = setTimeout(hideControls, 3000);
    });

    // Double-click to toggle fullscreen
    document.addEventListener('dblclick', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#embedded-control-bar') || target.closest('#embedded-nav-bar')) return;
        mpv.toggleFullscreen();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                mpv.togglePause();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                mpv.command(['seek', '-10', 'relative']);
                break;
            case 'ArrowRight':
                e.preventDefault();
                mpv.command(['seek', '10', 'relative']);
                break;
            case 'ArrowUp':
                e.preventDefault();
                mpv.command(['add', 'volume', '5']);
                break;
            case 'ArrowDown':
                e.preventDefault();
                mpv.command(['add', 'volume', '-5']);
                break;
            case 'f':
            case 'F11':
                e.preventDefault();
                mpv.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                mpv.command(['cycle', 'mute']);
                break;
            case 'Escape':
                e.preventDefault();
                mpv.destroy();
                break;
        }
    });
}
