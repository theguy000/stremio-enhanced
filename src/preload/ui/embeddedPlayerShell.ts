import { readFileSync } from 'fs';
import { join } from 'path';
import TemplateCache from '../../utils/templateCache';
import { embeddedPlayerAPI } from '../api/embeddedPlayer';
import { registerEmbeddedMountCallback, unregisterEmbeddedMountCallback } from './externalPlayerInterceptor';
import { getLogger } from '../../utils/logger';
import type { HelperPlaybackState, HelperStatus } from '../../interfaces/EmbeddedPlayerTypes';

const logger = getLogger("EmbeddedPlayerShell");

const COMPONENT_DIR = join(__dirname, '..', 'components', 'embedded-player');
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

    // Ask main to launch & load
    embeddedPlayerAPI.sendCommand({ type: 'load', payload: { url: streamUrl } }).catch((err) => {
        logger.error("Failed to send load command: " + String(err));
    });
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

    // Clear DOM refs
    $videoSurface = $backgroundLayer = $bufferingLayer = $errorLayer = $errorMessage = null;
    $navTitle = $playIcon = $pauseIcon = null;
    $seekProgress = $seekInput = null;
    $timeCurrent = $timeDuration = null;
    $volumeIcon = $mutedIcon = $volumeSlider = null;
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
    });
    $seekInput?.addEventListener('change', () => {
        const pct = parseFloat($seekInput!.value);
        // Duration is read from the last state update; the command payload carries seconds.
        const dur = parseDuration();
        embeddedPlayerAPI.sendCommand({ type: 'seek', payload: { position: (pct / 100) * dur } }).catch(() => {});
    });

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

// ─── Duration helper (cached from last state) ─────────────────
let lastDuration = 0;
function parseDuration(): number {
    return lastDuration > 0 ? lastDuration : 0;
}

// ─── State callbacks ──────────────────────────────────────────
function onPlaybackState(state: HelperPlaybackState): void {
    if (!containerEl) return;

    lastDuration = state.duration;

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
