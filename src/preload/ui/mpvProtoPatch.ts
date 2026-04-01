/**
 * Injects prototype-level HTMLMediaElement patches into the PAGE's main world.
 *
 * With contextIsolation: true, the preload and page have different JS contexts.
 * Prototype patches in the preload are invisible to Stremio's code. We inject a
 * <script> element whose code runs in the page's main world — same technique as
 * Helpers._eval(). Communication uses CustomEvent on window (works across worlds).
 *
 * Page → Preload: CustomEvent '__mpv_cmd' with { action, value }
 * Preload → Page: CustomEvent '__mpv_state' with state updates
 */
import { mpvBridge } from './mpvBridge';
import { getLogger } from '../../utils/logger';

const logger = getLogger('MpvProtoPatch');

// ── Page-context script (runs in main world) ────────────────────
const PAGE_SCRIPT = `(function() {
    'use strict';

    var __mpv = {
        active: false,
        available: false,
        capturedSrc: '',
        currentTime: 0,
        duration: 0,
        paused: true,
        volume: 1,
        muted: false,
        readyState: 0,
        networkState: 0,
        ended: false,
        videoWidth: 0,
        videoHeight: 0,
        fileLoaded: false
    };

    var stashedSrcs = new WeakMap();
    var _dbgCount = 0;

    window.addEventListener('__mpv_state', function(e) {
        var d = e.detail;
        if (d) {
            for (var k in d) if (d.hasOwnProperty(k)) __mpv[k] = d[k];
            // Debug: log significant state changes (not every timeupdate)
            if (d.paused !== undefined || d.duration !== undefined || d.fileLoaded !== undefined || d.active !== undefined) {
                console.log('[MpvPageState] update:', JSON.stringify(d));
            }
            if (d.currentTime !== undefined && _dbgCount++ % 20 === 0) {
                console.log('[MpvPageState] time=' + __mpv.currentTime.toFixed(1) + ' dur=' + __mpv.duration.toFixed(1) + ' paused=' + __mpv.paused + ' active=' + __mpv.active);
            }
        }
    });

    function cmd(action, value) {
        window.dispatchEvent(new CustomEvent('__mpv_cmd', {
            detail: { action: action, value: value }
        }));
    }

    function isActive(el) {
        return el instanceof HTMLVideoElement && __mpv.active;
    }

    function shouldBlock(el) {
        return el instanceof HTMLVideoElement
            && __mpv.available
            && location.href.indexOf('#/player') !== -1
            && !__mpv.active;
    }

    function ftr(ranges) {
        return {
            length: ranges.length,
            start: function(i) { return ranges[i][0]; },
            end: function(i) { return ranges[i][1]; }
        };
    }

    // Save originals
    var _play = HTMLMediaElement.prototype.play;
    var _pause = HTMLMediaElement.prototype.pause;
    var _load = HTMLMediaElement.prototype.load;
    var dSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    var dSrcObj = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    var dCurTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    var dDur = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
    var dPaused = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
    var dVol = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    var dMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    var dReady = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
    var dNet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'networkState');
    var dEnded = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'ended');
    var dBuf = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'buffered');
    var dSeek = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seekable');
    var dPlayed = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'played');
    var dErr = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'error');
    var dVW = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth');
    var dVH = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight');

    // ── Methods ──────────────────────────────────────────────────

    HTMLMediaElement.prototype.play = function() {
        if (isActive(this)) { cmd('play'); return Promise.resolve(); }
        if (shouldBlock(this)) return Promise.resolve();
        return _play.call(this);
    };

    HTMLMediaElement.prototype.pause = function() {
        if (isActive(this)) { cmd('pause'); return; }
        if (shouldBlock(this)) return;
        _pause.call(this);
    };

    HTMLMediaElement.prototype.load = function() {
        if (isActive(this) || shouldBlock(this)) return;
        _load.call(this);
    };

    // ── src (special: also blocks pre-activation) ────────────────

    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get: function() {
            if (isActive(this)) return __mpv.capturedSrc;
            if (shouldBlock(this)) return stashedSrcs.get(this) || '';
            return dSrc.get.call(this);
        },
        set: function(url) {
            if (isActive(this)) {
                // Only forward real HTTP(S) URLs to MPV, not blob: or mediastream: from HLS.js
                if (url && url !== __mpv.capturedSrc && typeof url === 'string' && url.indexOf('http') === 0) {
                    cmd('set-src', url);
                }
                return;
            }
            if (shouldBlock(this)) {
                stashedSrcs.set(this, url);
                cmd('stash-src', url);
                return;
            }
            dSrc.set.call(this, url);
        },
        configurable: true, enumerable: true
    });

    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        get: function() {
            if (isActive(this)) return null;
            return dSrcObj.get.call(this);
        },
        set: function(v) {
            if (isActive(this) || shouldBlock(this)) return;
            if (dSrcObj.set) dSrcObj.set.call(this, v);
        },
        configurable: true, enumerable: true
    });

    // ── Property patch helper ────────────────────────────────────

    function pm(prop, desc, get, set) {
        var d = {
            get: function() {
                if (isActive(this)) return get();
                return desc.get.call(this);
            },
            configurable: true,
            enumerable: true
        };
        if (set || desc.set) {
            d.set = function(v) {
                if (isActive(this)) { if (set) set(v); return; }
                if (desc.set) desc.set.call(this, v);
            };
        }
        Object.defineProperty(HTMLMediaElement.prototype, prop, d);
    }

    pm('currentTime', dCurTime,
        function() { return __mpv.currentTime; },
        function(v) { cmd('seek', v); });
    pm('duration', dDur, function() { return __mpv.duration; });
    pm('paused', dPaused, function() { return __mpv.paused; });
    pm('volume', dVol,
        function() { return __mpv.volume; },
        function(v) { cmd('set-volume', v); });
    pm('muted', dMuted,
        function() { return __mpv.muted; },
        function(v) { cmd('set-muted', v); });
    pm('readyState', dReady, function() { return __mpv.readyState; });
    pm('networkState', dNet, function() { return __mpv.networkState; });
    pm('ended', dEnded, function() { return __mpv.ended; });
    pm('buffered', dBuf, function() {
        return __mpv.duration > 0 ? ftr([[0, __mpv.duration]]) : ftr([]);
    });
    pm('seekable', dSeek, function() {
        return __mpv.duration > 0 ? ftr([[0, __mpv.duration]]) : ftr([]);
    });
    pm('played', dPlayed, function() {
        return __mpv.currentTime > 0 ? ftr([[0, __mpv.currentTime]]) : ftr([]);
    });
    pm('error', dErr, function() { return null; });

    // ── Video-specific ───────────────────────────────────────────

    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
        get: function() {
            if (isActive(this)) return __mpv.videoWidth;
            return dVW.get.call(this);
        },
        configurable: true, enumerable: true
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
        get: function() {
            if (isActive(this)) return __mpv.videoHeight;
            return dVH.get.call(this);
        },
        configurable: true, enumerable: true
    });

    // ── Error event suppression ────────────────────────────────
    // Stremio's HTMLVideo.js onerror reads video.error.code — our patch
    // returns null for error, causing null.code crash. Suppress error
    // events entirely when MPV is active or about to activate.
    document.addEventListener('error', function(e) {
        if (e.target instanceof HTMLVideoElement && (isActive(e.target) || shouldBlock(e.target))) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);

    // Debug: verify timeupdate events carry correct values to page context
    var _tuCount = 0;
    document.addEventListener('timeupdate', function(e) {
        if (e.target instanceof HTMLVideoElement && __mpv.active) {
            if (_tuCount++ % 20 === 0) {
                console.log('[MpvPagePatch] timeupdate: patched currentTime=' + e.target.currentTime +
                    ' original=' + dCurTime.get.call(e.target) +
                    ' __mpv.currentTime=' + __mpv.currentTime);
            }
        }
    }, true);

    console.log('[MpvPagePatch] Prototype patches installed in page context');
})();`;

// ── Injection ────────────────────────────────────────────────────

function injectPageScript() {
    const script = document.createElement('script');
    script.textContent = PAGE_SCRIPT;

    const target = document.head || document.documentElement;
    if (target) {
        target.prepend(script);
        script.remove(); // already executed synchronously
        logger.info('Page-context prototype patches injected');
        return;
    }

    // DOM not ready yet — wait
    const observer = new MutationObserver(() => {
        const t = document.head || document.documentElement;
        if (t) {
            observer.disconnect();
            t.prepend(script);
            script.remove();
            logger.info('Page-context prototype patches injected (deferred)');
        }
    });
    observer.observe(document, { childList: true, subtree: true });
}

// ── Preload-side command listener ────────────────────────────────

function setupCommandListener() {
    window.addEventListener('__mpv_cmd', ((e: CustomEvent) => {
        const { action, value } = e.detail || {};
        mpvBridge.handlePageCommand(action, value);
    }) as EventListener);
}

// ── Run at import time ───────────────────────────────────────────
injectPageScript();
setupCommandListener();
