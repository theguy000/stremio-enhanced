import { readFileSync } from 'fs';
import { join } from 'path';
import TemplateCache from '../../utils/templateCache';
import { embeddedPlayerAPI } from '../api/embeddedPlayer';
import { registerEmbeddedMountCallback, unregisterEmbeddedMountCallback } from './externalPlayerInterceptor';
import { getLogger } from '../../utils/logger';
import type { HelperPlaybackState, HelperStatus, TrackInfo } from '../../interfaces/EmbeddedPlayerTypes';

const logger = getLogger("EmbeddedPlayerShell");

const COMPONENT_DIR = join(__dirname, '..', '..', 'components', 'embedded-player');
const IMMERSE_TIMEOUT_MS = 3000;

/** Format seconds → "h:mm:ss" or "m:ss". */
function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ss = s.toString().padStart(2, '0');
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ─── Per-mount state ──────────────────────────────────────────
let containerEl: HTMLDivElement | null = null;
let styleEl: HTMLStyleElement | null = null;

let immerseTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupState: (() => void) | null = null;
let cleanupStatus: (() => void) | null = null;
let cleanupEvent: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let boundsRafId: number | null = null;

// ─── DOM references (populated on mount) ──────────────────────
let $videoSurface: HTMLElement | null = null;
let $backgroundLayer: HTMLElement | null = null;
let $bufferingLayer: HTMLElement | null = null;
let $errorLayer: HTMLElement | null = null;
let $errorMessage: HTMLElement | null = null;
let $navTitle: HTMLElement | null = null;
let $playIcon: HTMLElement | null = null;
let $pauseIcon: HTMLElement | null = null;
let $seekProgress: HTMLElement | null = null;
let $seekInput: HTMLInputElement | null = null;
let $timeCurrent: HTMLElement | null = null;
let $timeDuration: HTMLElement | null = null;
let $volumeIcon: HTMLElement | null = null;
let $mutedIcon: HTMLElement | null = null;
let $volumeSlider: HTMLInputElement | null = null;

// Track / speed menu refs
let $audioMenu: HTMLElement | null = null;
let $subtitleMenu: HTMLElement | null = null;
let $speedMenu: HTMLElement | null = null;
let $audioMenuItems: HTMLElement | null = null;
let $subtitleMenuItems: HTMLElement | null = null;
let $speedLabel: HTMLElement | null = null;
let $seekThumb: HTMLElement | null = null;

// Volume indicator refs
let $volumeIndicator: HTMLElement | null = null;
let $volIndFill: HTMLElement | null = null;
let volumeIndTimer: ReturnType<typeof setTimeout> | null = null;

// Next-video popup refs
let $nextVideoPopup: HTMLElement | null = null;
let nextVideoDismissed = false;
let nextVideoShown = false;

// Playback lifecycle
let playbackStarted = false;

// Menu state
let activeMenu: 'audio' | 'subtitle' | 'speed' | null = null;
let lastTracksJson = '';

// Keyboard handler ref for cleanup
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

// ─── Mount ────────────────────────────────────────────────────
function mount(streamUrl: string, _playerState: unknown): void {
    if (containerEl) {
        logger.warn("Shell already mounted — destroying previous instance.");
        destroy();
    }

    logger.info("Mounting embedded player shell");

    // Inject CSS
    const cssText = readFileSync(join(COMPONENT_DIR, 'embedded-player.css'), 'utf8');
    styleEl = document.createElement('style');
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);

    // Inject HTML
    const html = TemplateCache.load(COMPONENT_DIR, 'embedded-player');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    containerEl = wrapper.firstElementChild as HTMLDivElement;
    document.body.appendChild(containerEl);

    // Resolve DOM refs
    resolveElements();

    // Wire user interaction
    wireControls(streamUrl);

    // Wire data subscriptions
    cleanupState = embeddedPlayerAPI.onState(onPlaybackState);
    cleanupStatus = embeddedPlayerAPI.onStatus(onHelperStatus);
    cleanupEvent = embeddedPlayerAPI.onEvent(onHelperEvent);

    // Bounds sync
    startBoundsSync();

    // Start immerse timer
    resetImmerseTimer();

    // Start the helper process, obtain the native window handle, then load the stream.
    (async () => {
        try {
            const initResult = await embeddedPlayerAPI.sendCommand({ type: 'initialize' });
            if (!initResult.success) {
                logger.error("Failed to initialize helper: " + (initResult.error ?? 'unknown'));
                showError("Failed to start playback engine.");
                return;
            }

            const hwnd = await embeddedPlayerAPI.getNativeHandle();
            if (hwnd) {
                await embeddedPlayerAPI.sendCommand({
                    type: 'attach-surface',
                    payload: { hwnd: Buffer.from(hwnd).toString('hex') },
                });
            }

            await embeddedPlayerAPI.sendCommand({ type: 'load', payload: { url: streamUrl } });
        } catch (err) {
            logger.error("Failed during player startup: " + String(err));
            showError("Failed to start playback.");
        }
    })();
}

// ─── Destroy ──────────────────────────────────────────────────
function destroy(): void {
    logger.info("Destroying embedded player shell");

    embeddedPlayerAPI.sendCommand({ type: 'stop' }).catch(() => { /* best-effort */ });

    cleanupState?.();
    cleanupStatus?.();
    cleanupEvent?.();
    cleanupState = null;
    cleanupStatus = null;
    cleanupEvent = null;

    resizeObserver?.disconnect();
    resizeObserver = null;
    if (boundsRafId !== null) {
        cancelAnimationFrame(boundsRafId);
        boundsRafId = null;
    }

    if (immerseTimer !== null) {
        clearTimeout(immerseTimer);
        immerseTimer = null;
    }

    containerEl?.remove();
    containerEl = null;
    styleEl?.remove();
    styleEl = null;

    if (keydownHandler) {
        document.removeEventListener('keydown', keydownHandler);
        keydownHandler = null;
    }

    // Clear DOM refs
    $videoSurface = $backgroundLayer = $bufferingLayer = $errorLayer = $errorMessage = null;
    $navTitle = $playIcon = $pauseIcon = null;
    $seekProgress = $seekInput = null;
    $timeCurrent = $timeDuration = null;
    $volumeIcon = $mutedIcon = $volumeSlider = null;
    $audioMenu = $subtitleMenu = $speedMenu = null;
    $audioMenuItems = $subtitleMenuItems = $speedLabel = null;
    $seekThumb = null;
    $volumeIndicator = $volIndFill = null;
    $nextVideoPopup = null;
    nextVideoDismissed = false;
    nextVideoShown = false;
    playbackStarted = false;
    if (volumeIndTimer !== null) { clearTimeout(volumeIndTimer); volumeIndTimer = null; }
    activeMenu = null;
    lastTracksJson = '';
}

// ─── Element resolution ───────────────────────────────────────
function resolveElements(): void {
    if (!containerEl) return;
    $videoSurface = containerEl.querySelector('#embedded-video-surface');
    $backgroundLayer = containerEl.querySelector('#embedded-background-layer');
    $bufferingLayer = containerEl.querySelector('#embedded-buffering-layer');
    $errorLayer = containerEl.querySelector('#embedded-error-layer');
    $errorMessage = containerEl.querySelector('#embedded-error-message');
    $navTitle = containerEl.querySelector('#embedded-title');
    $playIcon = containerEl.querySelector('#embedded-play-icon');
    $pauseIcon = containerEl.querySelector('#embedded-pause-icon');
    $seekProgress = containerEl.querySelector('#embedded-seek-progress');
    $seekInput = containerEl.querySelector('#embedded-seek-input');
    $timeCurrent = containerEl.querySelector('#embedded-time-current');
    $timeDuration = containerEl.querySelector('#embedded-time-duration');
    $volumeIcon = containerEl.querySelector('#embedded-volume-icon');
    $mutedIcon = containerEl.querySelector('#embedded-muted-icon');
    $volumeSlider = containerEl.querySelector('#embedded-volume-slider');

    // Menu refs
    $audioMenu = containerEl.querySelector('#embedded-audio-menu');
    $subtitleMenu = containerEl.querySelector('#embedded-subtitle-menu');
    $speedMenu = containerEl.querySelector('#embedded-speed-menu');
    $audioMenuItems = containerEl.querySelector('#embedded-audio-menu-items');
    $subtitleMenuItems = containerEl.querySelector('#embedded-subtitle-menu-items');
    $speedLabel = containerEl.querySelector('#embedded-speed-label');
    $seekThumb = containerEl.querySelector('#embedded-seek-thumb');

    // Volume indicator refs
    $volumeIndicator = containerEl.querySelector('#embedded-volume-indicator');
    $volIndFill = containerEl.querySelector('#vol-ind-fill');

    // Next-video popup refs
    $nextVideoPopup = containerEl.querySelector('#embedded-next-video-popup');
}

// ─── Controls wiring ──────────────────────────────────────────
function wireControls(streamUrl: string): void {
    if (!containerEl) return;

    // Back button
    containerEl.querySelector('#embedded-back-btn')?.addEventListener('click', () => {
        destroy();
        history.back();
    });

    // Error dismiss
    containerEl.querySelector('#embedded-error-dismiss')?.addEventListener('click', () => {
        destroy();
        history.back();
    });

    // Fullscreen
    containerEl.querySelector('#embedded-fullscreen-btn')?.addEventListener('click', () => {
        embeddedPlayerAPI.sendCommand({ type: 'set-fullscreen', payload: { toggle: true } }).catch(() => {});
    });

    // Play / Pause
    containerEl.querySelector('#embedded-play-pause-btn')?.addEventListener('click', () => {
        const isPaused = $pauseIcon?.style.display === 'none';
        embeddedPlayerAPI.sendCommand({ type: isPaused ? 'play' : 'pause' }).catch(() => {});
    });

    // Seek
    $seekInput?.addEventListener('input', () => {
        const pct = parseFloat($seekInput!.value);
        if ($seekProgress) $seekProgress.style.width = `${pct}%`;
        if ($seekThumb) $seekThumb.style.left = `${pct}%`;
    });
    $seekInput?.addEventListener('change', () => {
        const pct = parseFloat($seekInput!.value);
        // Duration is read from the last state update; the command payload carries seconds.
        const dur = parseDuration();
        embeddedPlayerAPI.sendCommand({ type: 'seek', payload: { position: (pct / 100) * dur } }).catch(() => {});
    });

    // Slider-active guard — prevent immerse while dragging seek bar
    $seekInput?.addEventListener('mousedown', () => containerEl?.classList.add('slider-active'));
    $seekInput?.addEventListener('mouseup', () => containerEl?.classList.remove('slider-active'));
    $seekInput?.addEventListener('touchstart', () => containerEl?.classList.add('slider-active'), { passive: true });
    $seekInput?.addEventListener('touchend', () => containerEl?.classList.remove('slider-active'));

    // Volume
    $volumeSlider?.addEventListener('input', () => {
        const vol = parseInt($volumeSlider!.value, 10);
        embeddedPlayerAPI.sendCommand({ type: 'set-volume', payload: { volume: vol } }).catch(() => {});
    });

    // Mute
    containerEl.querySelector('#embedded-mute-btn')?.addEventListener('click', () => {
        const isMuted = $mutedIcon?.style.display !== 'none';
        embeddedPlayerAPI.sendCommand({ type: 'set-mute', payload: { mute: !isMuted } }).catch(() => {});
    });

    // Immerse management — mouse movement resets the timer
    containerEl.addEventListener('mousemove', () => resetImmerseTimer());
    containerEl.addEventListener('mouseleave', () => setImmersed(true));

    // Click-to-play/pause on video surface
    $videoSurface?.addEventListener('click', () => {
        const isPaused = $pauseIcon?.style.display === 'none';
        embeddedPlayerAPI.sendCommand({ type: isPaused ? 'play' : 'pause' }).catch(() => {});
    });

    // Double-click fullscreen on video surface
    $videoSurface?.addEventListener('dblclick', () => {
        embeddedPlayerAPI.sendCommand({ type: 'set-fullscreen', payload: { toggle: true } }).catch(() => {});
    });

    // Track & speed menu toggle buttons
    containerEl.querySelector('#embedded-audio-btn')?.addEventListener('click', () => toggleMenu('audio'));
    containerEl.querySelector('#embedded-subtitle-btn')?.addEventListener('click', () => toggleMenu('subtitle'));
    containerEl.querySelector('#embedded-speed-btn')?.addEventListener('click', () => toggleMenu('speed'));

    // Speed presets
    containerEl.querySelectorAll('.speed-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
            const speed = parseFloat((btn as HTMLElement).dataset.speed ?? '1');
            embeddedPlayerAPI.sendCommand({ type: 'set-speed', payload: { speed } }).catch(() => {});
            closeMenus();
        });
    });

    // Close menus when clicking outside
    containerEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (activeMenu && !target.closest('.menu-layer') && !target.closest('.audio-btn') && !target.closest('.subtitle-btn') && !target.closest('.speed-btn')) {
            closeMenus();
        }
    });

    // Next-video popup buttons
    containerEl.querySelector('#nvp-dismiss')?.addEventListener('click', () => {
        nextVideoDismissed = true;
        if ($nextVideoPopup) $nextVideoPopup.style.display = 'none';
    });
    containerEl.querySelector('#nvp-watch')?.addEventListener('click', () => {
        // Signal main process to play the next video (handled via 'ended' event flow)
        embeddedPlayerAPI.sendCommand({ type: 'stop' }).catch(() => {});
        nextVideoDismissed = true;
        if ($nextVideoPopup) $nextVideoPopup.style.display = 'none';
    });

    // Keyboard shortcuts
    keydownHandler = (e: KeyboardEvent) => {
        if (!containerEl) return;

        switch (e.key) {
            case ' ':
            case 'k': {
                e.preventDefault();
                const isPaused = $pauseIcon?.style.display === 'none';
                embeddedPlayerAPI.sendCommand({ type: isPaused ? 'play' : 'pause' }).catch(() => {});
                break;
            }
            case 'ArrowLeft':
                e.preventDefault();
                embeddedPlayerAPI.sendCommand({ type: 'seek', payload: { position: Math.max(0, (lastPosition ?? 0) - 10) } }).catch(() => {});
                break;
            case 'ArrowRight':
                e.preventDefault();
                embeddedPlayerAPI.sendCommand({ type: 'seek', payload: { position: (lastPosition ?? 0) + 10 } }).catch(() => {});
                break;
            case 'ArrowUp':
                e.preventDefault();
                embeddedPlayerAPI.sendCommand({ type: 'set-volume', payload: { volume: Math.min(100, (lastVolume ?? 100) + 5) } }).catch(() => {});
                showVolumeIndicator(Math.min(100, (lastVolume ?? 100) + 5));
                break;
            case 'ArrowDown':
                e.preventDefault();
                embeddedPlayerAPI.sendCommand({ type: 'set-volume', payload: { volume: Math.max(0, (lastVolume ?? 100) - 5) } }).catch(() => {});
                showVolumeIndicator(Math.max(0, (lastVolume ?? 100) - 5));
                break;
            case 'j':
                e.preventDefault();
                embeddedPlayerAPI.sendCommand({ type: 'seek', payload: { position: Math.max(0, (lastPosition ?? 0) - 10) } }).catch(() => {});
                break;
            case 'l':
                e.preventDefault();
                embeddedPlayerAPI.sendCommand({ type: 'seek', payload: { position: (lastPosition ?? 0) + 10 } }).catch(() => {});
                break;
            case 'm':
                embeddedPlayerAPI.sendCommand({ type: 'set-mute', payload: { mute: $mutedIcon?.style.display === 'none' } }).catch(() => {});
                break;
            case 'f':
                embeddedPlayerAPI.sendCommand({ type: 'set-fullscreen', payload: { toggle: true } }).catch(() => {});
                break;
            case 'Escape':
                if (activeMenu) {
                    closeMenus();
                } else {
                    destroy();
                    history.back();
                }
                break;
        }
    };
    document.addEventListener('keydown', keydownHandler);

    // Title — use stream URL basename as fallback
    if ($navTitle) {
        try {
            const urlPath = new URL(streamUrl).pathname;
            $navTitle.textContent = decodeURIComponent(urlPath.split('/').pop() ?? 'Playing');
        } catch {
            $navTitle.textContent = 'Playing';
        }
    }
}

// ─── Duration / position / volume helpers (cached from last state) ──
let lastDuration = 0;
let lastPosition: number | null = null;
let lastVolume: number | null = null;
function parseDuration(): number {
    return lastDuration > 0 ? lastDuration : 0;
}

const NEXT_VIDEO_THRESHOLD_S = 30; // show "next video" popup when ≤30s remain
const VOLUME_INDICATOR_MS = 1500;

function showVolumeIndicator(vol: number): void {
    if (!$volumeIndicator || !$volIndFill) return;
    $volIndFill.style.width = `${Math.round(vol)}%`;
    $volumeIndicator.style.display = '';
    if (volumeIndTimer !== null) clearTimeout(volumeIndTimer);
    volumeIndTimer = setTimeout(() => {
        if ($volumeIndicator) $volumeIndicator.style.display = 'none';
        volumeIndTimer = null;
    }, VOLUME_INDICATOR_MS);
}

// ─── Menu helpers ─────────────────────────────────────────────
function toggleMenu(menu: 'audio' | 'subtitle' | 'speed'): void {
    if (activeMenu === menu) {
        closeMenus();
        return;
    }
    closeMenus();
    activeMenu = menu;
    const menuEl = menu === 'audio' ? $audioMenu : menu === 'subtitle' ? $subtitleMenu : $speedMenu;
    if (menuEl) menuEl.style.display = '';
    resetImmerseTimer();
}

function closeMenus(): void {
    activeMenu = null;
    if ($audioMenu) $audioMenu.style.display = 'none';
    if ($subtitleMenu) $subtitleMenu.style.display = 'none';
    if ($speedMenu) $speedMenu.style.display = 'none';
}

function renderTrackMenu(container: HTMLElement, tracks: TrackInfo[], commandType: 'set-audio-track' | 'set-subtitle-track'): void {
    container.innerHTML = '';

    // "None" option for subtitles
    if (commandType === 'set-subtitle-track') {
        const noneSelected = !tracks.some((t) => t.selected);
        const btn = document.createElement('button');
        btn.className = 'menu-item' + (noneSelected ? ' selected' : '');
        btn.textContent = 'None';
        btn.addEventListener('click', () => {
            embeddedPlayerAPI.sendCommand({ type: commandType, payload: { id: 0 } }).catch(() => {});
            closeMenus();
        });
        container.appendChild(btn);
    }

    for (const track of tracks) {
        const btn = document.createElement('button');
        btn.className = 'menu-item' + (track.selected ? ' selected' : '');
        const label = track.title ?? track.lang ?? `Track ${track.id}`;
        const suffix = track.lang && track.title ? ` (${track.lang})` : '';
        btn.textContent = label + suffix;
        btn.addEventListener('click', () => {
            embeddedPlayerAPI.sendCommand({ type: commandType, payload: { id: track.id } }).catch(() => {});
            closeMenus();
        });
        container.appendChild(btn);
    }
}

function updateSpeedMenu(currentSpeed: number): void {
    if ($speedLabel) $speedLabel.textContent = `${currentSpeed}x`;
    if (!containerEl) return;

    containerEl.querySelectorAll('.speed-preset').forEach((btn) => {
        const speed = parseFloat((btn as HTMLElement).dataset.speed ?? '1');
        btn.classList.toggle('selected', Math.abs(speed - currentSpeed) < 0.01);
    });
}

// ─── State callbacks ──────────────────────────────────────────
function onPlaybackState(state: HelperPlaybackState): void {
    if (!containerEl) return;

    // Track when real playback begins (duration becomes known)
    if (!playbackStarted && state.duration > 0) {
        playbackStarted = true;
    }

    // Only react to ended once playback has actually started
    if (playbackStarted && state.ended) {
        destroy();
        history.back();
        return;
    }

    lastDuration = state.duration;
    lastPosition = state.position;
    lastVolume = state.volume;

    // Play / pause icons
    if ($playIcon && $pauseIcon) {
        $playIcon.style.display = state.paused ? '' : 'none';
        $pauseIcon.style.display = state.paused ? 'none' : '';
    }

    // Seek bar
    if (state.duration > 0 && $seekProgress && $seekInput) {
        const pct = (state.position / state.duration) * 100;
        $seekProgress.style.width = `${pct}%`;
        $seekInput.value = String(pct);
        if ($seekThumb) $seekThumb.style.left = `${pct}%`;
    }

    // Time labels
    if ($timeCurrent) $timeCurrent.textContent = formatTime(state.position);
    if ($timeDuration) $timeDuration.textContent = formatTime(state.duration);

    // Volume
    if ($volumeSlider) $volumeSlider.value = String(state.volume);
    if ($volumeIcon && $mutedIcon) {
        $volumeIcon.style.display = state.muted ? 'none' : '';
        $mutedIcon.style.display = state.muted ? '' : 'none';
    }

    // Buffering layer
    if ($bufferingLayer) {
        $bufferingLayer.style.display = state.buffering ? '' : 'none';
    }

    // Background layer — hide once video is playing
    if ($backgroundLayer && !state.paused && state.position > 0) {
        $backgroundLayer.style.display = 'none';
    }

    // Speed
    updateSpeedMenu(state.speed);

    // Track menus — re-render only when tracks change
    const tracksJson = JSON.stringify(state.tracks);
    if (tracksJson !== lastTracksJson) {
        lastTracksJson = tracksJson;
        const audioTracks = state.tracks.filter((t) => t.type === 'audio');
        const subtitleTracks = state.tracks.filter((t) => t.type === 'subtitle');
        if ($audioMenuItems) renderTrackMenu($audioMenuItems, audioTracks, 'set-audio-track');
        if ($subtitleMenuItems) renderTrackMenu($subtitleMenuItems, subtitleTracks, 'set-subtitle-track');
    }

    // Next-video popup — show near end of playback for series
    if (state.duration > 0 && !nextVideoDismissed && !nextVideoShown) {
        const remaining = state.duration - state.position;
        if (remaining <= NEXT_VIDEO_THRESHOLD_S && remaining > 0) {
            nextVideoShown = true;
            if ($nextVideoPopup) $nextVideoPopup.style.display = '';
        }
    }
}

function onHelperStatus(status: HelperStatus): void {
    logger.info(`Helper status: ${status}`);

    if (status === 'error' || status === 'crashed') {
        showError(`Playback ${status === 'crashed' ? 'crashed' : 'encountered an error'}.`);
    }

    if ($bufferingLayer) {
        $bufferingLayer.style.display = (status === 'starting') ? '' : 'none';
    }
}

function onHelperEvent(event: { type: string; payload?: Record<string, unknown> }): void {
    if (event.type === 'helper-error' || event.type === 'session-error') {
        const msg = typeof event.payload?.message === 'string' ? event.payload.message : 'Unknown error';
        showError(msg);
    }
    if (event.type === 'ended') {
        destroy();
        history.back();
    }
}

function showError(message: string): void {
    if ($errorLayer) $errorLayer.style.display = '';
    if ($errorMessage) $errorMessage.textContent = message;
}

// ─── Immerse (auto-hide overlay) ──────────────────────────────
function resetImmerseTimer(): void {
    setImmersed(false);
    if (immerseTimer !== null) clearTimeout(immerseTimer);
    immerseTimer = setTimeout(() => setImmersed(true), IMMERSE_TIMEOUT_MS);
}

function setImmersed(value: boolean): void {
    containerEl?.classList.toggle('immersed', value);
}

// ─── Bounds sync (throttled via rAF) ──────────────────────────
function startBoundsSync(): void {
    if (!$videoSurface) return;

    let pendingBounds = false;

    const sendBounds = (): void => {
        if (!$videoSurface) return;
        const rect = $videoSurface.getBoundingClientRect();
        embeddedPlayerAPI.sendCommand({
            type: 'set-bounds',
            payload: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                scaleFactor: window.devicePixelRatio ?? 1,
            },
        }).catch(() => {});
        pendingBounds = false;
    };

    const scheduleBounds = (): void => {
        if (pendingBounds) return;
        pendingBounds = true;
        boundsRafId = requestAnimationFrame(sendBounds);
    };

    resizeObserver = new ResizeObserver(scheduleBounds);
    resizeObserver.observe($videoSurface);

    // Also send initial bounds
    scheduleBounds();

    // Re-send on window resize
    window.addEventListener('resize', scheduleBounds);
}

// ─── Hashchange guard ─────────────────────────────────────────
function onHashChange(): void {
    if (containerEl && !location.href.includes('#/player')) {
        destroy();
    }
}

// ─── Lifecycle registration ───────────────────────────────────
export function initEmbeddedPlayerShell(): void {
    registerEmbeddedMountCallback(mount);
    window.addEventListener('hashchange', onHashChange);
    logger.info("Embedded player shell registered");
}

export function teardownEmbeddedPlayerShell(): void {
    unregisterEmbeddedMountCallback();
    window.removeEventListener('hashchange', onHashChange);
    if (containerEl) destroy();
}
