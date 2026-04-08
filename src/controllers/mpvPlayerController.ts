import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import { mainWindow } from '../main';
import Properties from '../core/Properties';
import type { MpvFileLoadOptions, MpvSubtitleTrack } from '../interfaces/MpvTypes';

const logger = getLogger("MpvPlayerController");

// Attempt to load the native addon
let addon: any = null;
let addonLoadError: string | null = null;

try {
    // Try prebuilt binary first
    const platform = process.platform;
    const arch = process.arch;
    const prebuildPath = join(__dirname, `../../native/mpv-native/prebuilds/${platform}-${arch}/mpv_native.node`);

    if (existsSync(prebuildPath)) {
        addon = require(prebuildPath);
    } else {
        // Fallback to build directory
        const buildPath = join(__dirname, '../../native/mpv-native/build/Release/mpv_native.node');
        addon = require(buildPath);
    }
    logger.info("mpv-native addon loaded successfully");
} catch (err: any) {
    addonLoadError = err.message;
    logger.warn(`mpv-native addon not available: ${err.message}`);
}

let mpvHandle: number | null = null;
let overlayWindow: BrowserWindow | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function createOverlay(): BrowserWindow | null {
    if (!mainWindow) return null;

    const bounds = mainWindow.getContentBounds();

    const overlay = new BrowserWindow({
        parent: mainWindow,
        frame: false,
        transparent: true,
        resizable: false,
        skipTaskbar: true,
        focusable: true,
        fullscreenable: false,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        webPreferences: {
            preload: join(__dirname, '../preload/mpvOverlayPreload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    overlay.setAlwaysOnTop(true, 'pop-up-menu');

    // Load the embedded player HTML
    const htmlPath = join(__dirname, '../../dist/components/embedded-player/embedded-player.html');
    overlay.loadFile(htmlPath);

    // Inject active theme CSS after page loads
    overlay.webContents.on('did-finish-load', () => {
        injectTheme(overlay);
        injectPlugins(overlay);
    });

    return overlay;
}

function injectTheme(overlay: BrowserWindow): void {
    try {
        const themesDir = Properties.themesPath;
        if (!existsSync(themesDir)) return;

        const files = readdirSync(themesDir).filter(f => f.endsWith('.theme.css'));
        for (const file of files) {
            const content = readFileSync(join(themesDir, file), 'utf-8');
            overlay.webContents.insertCSS(content).catch(() => {});
        }
    } catch (err) {
        logger.warn(`Failed to inject theme into overlay: ${err}`);
    }
}

function injectPlugins(overlay: BrowserWindow): void {
    try {
        const pluginsDir = Properties.pluginsPath;
        if (!existsSync(pluginsDir)) return;

        const files = readdirSync(pluginsDir).filter(f => f.endsWith('.plugin.js'));
        for (const file of files) {
            const content = readFileSync(join(pluginsDir, file), 'utf-8');
            const pluginBaseName = file.split('.plugin.js')[0];

            const scopedScript = `
                (function() {
                    const StremioEnhancedAPI = {
                        logger: {
                            info: (message) => window.StremioEnhancedAPI.info('${pluginBaseName}', message),
                            warn: (message) => window.StremioEnhancedAPI.warn('${pluginBaseName}', message),
                            error: (message) => window.StremioEnhancedAPI.error('${pluginBaseName}', message)
                        },
                        getSetting: (key) => window.StremioEnhancedAPI.getSetting('${pluginBaseName}', key),
                        saveSetting: (key, value) => window.StremioEnhancedAPI.saveSetting('${pluginBaseName}', key, value),
                        registerSettings: (schema) => window.StremioEnhancedAPI.registerSettings('${pluginBaseName}', schema),
                        onSettingsSaved: (callback) => window.StremioEnhancedAPI.onSettingsSaved('${pluginBaseName}', callback),
                        showAlert: window.StremioEnhancedAPI?.showAlert,
                        showPrompt: (title, message, defaultValue) =>
                            window.StremioEnhancedAPI?.showPrompt('${pluginBaseName}', title, message, defaultValue)
                    };
                    try {
                        ${content}
                    } catch (err) {
                        console.error('[MpvOverlay] Plugin crashed: ${file}', err);
                    }
                })();
            `;

            overlay.webContents.executeJavaScript(scopedScript).catch(() => {});
        }
    } catch (err) {
        logger.warn(`Failed to inject plugins into overlay: ${err}`);
    }
}

function startPolling(): void {
    if (pollInterval) return;

    pollInterval = setInterval(() => {
        if (!addon || mpvHandle === null || !overlayWindow) return;

        try {
            const events = addon.pollEvents(mpvHandle);
            for (const evt of events) {
                switch (evt.event) {
                    case 'property-change':
                        overlayWindow.webContents.send(IPC_CHANNELS.MPV_PROPERTY_CHANGE, {
                            name: evt.name,
                            value: evt.value,
                        });
                        break;
                    case 'file-loaded':
                        overlayWindow.webContents.send(IPC_CHANNELS.MPV_FILE_LOADED, {});
                        break;
                    case 'end-file':
                        overlayWindow.webContents.send(IPC_CHANNELS.MPV_END_FILE, {
                            reason: evt.value,
                        });
                        break;
                    case 'seek':
                    case 'playback-restart':
                        overlayWindow.webContents.send(IPC_CHANNELS.MPV_EVENT, {
                            event: evt.event,
                        });
                        break;
                }
            }
        } catch (err) {
            logger.error(`Poll error: ${err}`);
        }
    }, 16);
}

function stopPolling(): void {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

function observeProperties(): void {
    if (!addon || mpvHandle === null) return;

    // format: 1=string, 2=double, 3=flag
    const properties: [string, number, number][] = [
        ['time-pos', 1, 2],
        ['duration', 2, 2],
        ['pause', 3, 3],
        ['volume', 4, 2],
        ['mute', 5, 3],
        ['speed', 6, 2],
        ['track-list', 7, 1], // Will use NODE format, falls back to string
        ['demuxer-cache-time', 8, 2],
        ['core-idle', 9, 3],
        ['eof-reached', 10, 3],
    ];

    for (const [name, id, format] of properties) {
        addon.observeProperty(mpvHandle, name, id, format);
    }
}

function setupWindowSync(): void {
    if (!mainWindow || !overlayWindow) return;

    const syncBounds = () => {
        if (!mainWindow || !overlayWindow) return;
        const bounds = mainWindow.getContentBounds();
        if (addon && mpvHandle !== null) {
            addon.resize(mpvHandle, bounds.width, bounds.height);
            addon.setPosition(mpvHandle, 0, 0);
        }
        overlayWindow.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        });
    };

    mainWindow.on('resize', syncBounds);
    mainWindow.on('move', syncBounds);

    mainWindow.on('enter-full-screen', () => {
        if (overlayWindow) {
            overlayWindow.setFullScreen(true);
            overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        }
    });

    mainWindow.on('leave-full-screen', () => {
        if (overlayWindow) {
            overlayWindow.setFullScreen(false);
            overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
        }
    });
}

function destroyMpv(): void {
    stopPolling();

    if (overlayWindow) {
        overlayWindow.close();
        overlayWindow = null;
    }

    if (addon && mpvHandle !== null) {
        addon.destroy(mpvHandle);
        mpvHandle = null;
    }

    // Navigate main window back from #/player route
    if (mainWindow) {
        mainWindow.webContents.executeJavaScript('history.back()').catch(() => {});
    }
}

async function loadFile(options: MpvFileLoadOptions): Promise<void> {
    if (!addon || !mainWindow) {
        throw new Error('mpv addon not available');
    }

    // Destroy existing instance if any
    destroyMpv();

    // Create mpv instance
    const parentHandle = mainWindow.getNativeWindowHandle();
    mpvHandle = addon.create(parentHandle);

    // Resize to fill content area
    const bounds = mainWindow.getContentBounds();
    addon.resize(mpvHandle, bounds.width, bounds.height);

    // Create overlay
    overlayWindow = createOverlay();
    if (!overlayWindow) {
        destroyMpv();
        throw new Error('Failed to create overlay window');
    }

    // Setup window sync
    setupWindowSync();

    // Observe properties
    observeProperties();

    // Start event polling
    startPolling();

    // Load the file
    addon.command(mpvHandle, ['loadfile', options.url]);

    // After file loads, add third-party subtitles
    if (options.subtitles && options.subtitles.length > 0) {
        const waitForFileLoad = setInterval(() => {
            if (!addon || mpvHandle === null) {
                clearInterval(waitForFileLoad);
                return;
            }
            try {
                const dur = addon.getProperty(mpvHandle, 'duration');
                if (dur && parseFloat(dur) > 0) {
                    clearInterval(waitForFileLoad);
                    addSubtitles(options.subtitles!, options.preferredLang);
                }
            } catch { /* not loaded yet */ }
        }, 100);

        // Timeout after 30 seconds
        setTimeout(() => clearInterval(waitForFileLoad), 30000);
    }
}

function addSubtitles(subtitles: MpvSubtitleTrack[], preferredLang?: string): void {
    if (!addon || mpvHandle === null) return;

    for (const sub of subtitles) {
        const title = `${sub.origin} ${sub.lang}`;
        addon.command(mpvHandle, ['sub-add', sub.url, 'auto', title, sub.lang]);
    }

    // Auto-select preferred language subtitle after a short delay
    if (preferredLang) {
        setTimeout(() => {
            if (!addon || mpvHandle === null) return;
            const trackList = addon.getProperty(mpvHandle, 'track-list');
            try {
                const tracks = JSON.parse(trackList);
                // Find first subtitle matching preferred language, prefer embedded
                const embeddedMatch = tracks.find(
                    (t: any) => t.type === 'sub' && t.lang === preferredLang && !t.external
                );
                const externalMatch = tracks.find(
                    (t: any) => t.type === 'sub' && t.lang === preferredLang && t.external
                );
                const match = embeddedMatch || externalMatch;
                if (match) {
                    addon.setProperty(mpvHandle, 'sid', String(match.id));
                }
            } catch { /* ignore parse errors */ }
        }, 500);
    }
}

export const mpvPlayerController = {
    isAvailable: (): boolean => addon !== null,
    getLoadError: (): string | null => addonLoadError,

    initIPC: (): void => {
        ipcMain.handle(IPC_CHANNELS.MPV_LOAD_FILE, (_, options: MpvFileLoadOptions) => {
            return loadFile(options).then(() => ({ success: true })).catch((err) => ({
                success: false,
                error: err.message,
            }));
        });

        ipcMain.on(IPC_CHANNELS.MPV_COMMAND, (_, payload: { args: string[] }) => {
            if (addon && mpvHandle !== null) {
                addon.command(mpvHandle, payload.args);
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_SET_PROP, (_, payload: { name: string; value: any }) => {
            if (addon && mpvHandle !== null) {
                addon.setProperty(mpvHandle, payload.name, payload.value);
            }
        });

        ipcMain.handle(IPC_CHANNELS.MPV_GET_PROP, (_, payload: { name: string }) => {
            if (addon && mpvHandle !== null) {
                return addon.getProperty(mpvHandle, payload.name);
            }
            return null;
        });

        ipcMain.on(IPC_CHANNELS.MPV_SEEK, (_, payload: { position: number }) => {
            if (addon && mpvHandle !== null) {
                addon.command(mpvHandle, ['seek', String(payload.position), 'absolute']);
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_TOGGLE_PAUSE, () => {
            if (addon && mpvHandle !== null) {
                addon.command(mpvHandle, ['cycle', 'pause']);
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_SET_VOLUME, (_, payload: { volume: number }) => {
            if (addon && mpvHandle !== null) {
                addon.setProperty(mpvHandle, 'volume', payload.volume);
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_SET_TRACK, (_, payload: { type: 'audio' | 'sub'; id: number }) => {
            if (addon && mpvHandle !== null) {
                const prop = payload.type === 'audio' ? 'aid' : 'sid';
                const val = payload.id === 0 ? 'no' : String(payload.id);
                addon.setProperty(mpvHandle, prop, val);
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_SET_SPEED, (_, payload: { speed: number }) => {
            if (addon && mpvHandle !== null) {
                addon.setProperty(mpvHandle, 'speed', payload.speed);
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_TOGGLE_FULLSCREEN, () => {
            if (mainWindow) {
                mainWindow.setFullScreen(!mainWindow.isFullScreen());
            }
        });

        ipcMain.on(IPC_CHANNELS.MPV_DESTROY, () => {
            destroyMpv();
        });

        ipcMain.handle(IPC_CHANNELS.MPV_IS_AVAILABLE, () => {
            return { available: addon !== null, error: addonLoadError };
        });

        logger.info("mpv IPC handlers registered");
    },
};
