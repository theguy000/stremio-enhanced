import { ipcMain, BrowserWindow } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import Properties from '../core/Properties';
import type { HelperCommand, HelperPlaybackState, HelperEvent, HelperStatus } from '../interfaces/EmbeddedPlayerTypes';

const logger = getLogger("EmbeddedPlayerController");

let helperProcess: ChildProcess | null = null;
let helperStatus: HelperStatus = "idle";
let lastState: HelperPlaybackState | null = null;
let mainWindowRef: BrowserWindow | null = null;

function setStatus(status: HelperStatus): void {
    helperStatus = status;
    mainWindowRef?.webContents.send(IPC_CHANNELS.EMBEDDED_PLAYER_STATUS, status);
    logger.info(`Helper status → ${status}`);
}

function forwardState(state: HelperPlaybackState): void {
    lastState = state;
    mainWindowRef?.webContents.send(IPC_CHANNELS.EMBEDDED_PLAYER_STATE, state);
}

function forwardEvent(event: HelperEvent): void {
    mainWindowRef?.webContents.send(IPC_CHANNELS.EMBEDDED_PLAYER_EVENT, event);
}

/** Resolve the path to the helper binary.
 *  In development it lives at static/mpv-helper, in packaged builds at resources/mpv-helper.
 */
function resolveHelperPath(): string | null {
    const isDev = !require('electron').app.isPackaged;
    const candidates: string[] = isDev
        ? [
            join(__dirname, '..', 'static', 'mpv-helper', process.platform === 'win32' ? 'mpv-helper.exe' : 'mpv-helper'),
            join(Properties.enhancedPath, 'mpv-helper', process.platform === 'win32' ? 'mpv-helper.exe' : 'mpv-helper'),
        ]
        : [
            join(process.resourcesPath!, 'mpv-helper', process.platform === 'win32' ? 'mpv-helper.exe' : 'mpv-helper'),
            join(Properties.enhancedPath, 'mpv-helper', process.platform === 'win32' ? 'mpv-helper.exe' : 'mpv-helper'),
        ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

function launchHelper(): boolean {
    const helperPath = resolveHelperPath();
    if (!helperPath) {
        logger.warn("Helper binary not found — running in stub mode (state will be mocked for UI development).");
        setStatus("ready");
        return true;
    }

    setStatus("starting");
    helperProcess = spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    helperProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'state') {
                    forwardState(msg.payload as HelperPlaybackState);
                } else {
                    forwardEvent(msg as HelperEvent);
                }
            } catch {
                logger.info(`[helper stdout] ${line}`);
            }
        }
    });

    helperProcess.stderr?.on('data', (data: Buffer) => {
        logger.warn(`[helper stderr] ${data.toString().trim()}`);
    });

    helperProcess.on('exit', (code) => {
        logger.info(`Helper exited with code ${code}`);
        helperProcess = null;
        if (helperStatus !== "shutdown") {
            setStatus("crashed");
            forwardEvent({ type: "helper-error", payload: { message: `Helper exited unexpectedly (code ${code})` } });
        }
    });

    setStatus("ready");
    return true;
}

function sendToHelper(cmd: HelperCommand): boolean {
    if (!helperProcess?.stdin?.writable) {
        // Stub mode — acknowledge the command but do nothing.
        return true;
    }
    try {
        helperProcess.stdin.write(JSON.stringify(cmd) + '\n');
        return true;
    } catch (err) {
        logger.error(`Failed to send command to helper: ${err}`);
        return false;
    }
}

function shutdownHelper(): void {
    if (helperProcess) {
        setStatus("shutdown");
        sendToHelper({ type: 'shutdown' });
        setTimeout(() => {
            if (helperProcess) {
                helperProcess.kill();
                helperProcess = null;
            }
        }, 3000);
    } else {
        setStatus("idle");
    }
    lastState = null;
}

export const embeddedPlayerController = {
    initIPC(win: BrowserWindow): void {
        mainWindowRef = win;

        ipcMain.handle(IPC_CHANNELS.EMBEDDED_PLAYER_COMMAND, (_e, cmd: HelperCommand) => {
            switch (cmd.type) {
                case 'initialize': {
                    const ok = launchHelper();
                    return { success: ok };
                }
                case 'shutdown': {
                    shutdownHelper();
                    return { success: true };
                }
                default: {
                    const ok = sendToHelper(cmd);
                    return ok
                        ? { success: true }
                        : { success: false, error: 'Helper is not running' };
                }
            }
        });

        ipcMain.handle(IPC_CHANNELS.EMBEDDED_PLAYER_GET_NATIVE_HANDLE, () => {
            if (!mainWindowRef) return null;
            return mainWindowRef.getNativeWindowHandle();
        });
    },

    shutdown(): void {
        shutdownHelper();
    },

    getStatus(): HelperStatus {
        return helperStatus;
    },

    getLastState(): HelperPlaybackState | null {
        return lastState;
    },
};
