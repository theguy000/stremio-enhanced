import { ipcMain, BrowserWindow } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';
import { existsSync, appendFileSync } from 'fs';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import Properties from '../core/Properties';
import type { HelperCommand, HelperPlaybackState, HelperEvent, HelperStatus } from '../interfaces/EmbeddedPlayerTypes';

const logger = getLogger("EmbeddedPlayerController");

let helperProcess: ChildProcess | null = null;
let helperStatus: HelperStatus = "idle";
let lastState: HelperPlaybackState | null = null;
let mainWindowRef: BrowserWindow | null = null;
let crashCount = 0;
let lastCrashTime = 0;
const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 30_000;

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
    const binaryName = process.platform === 'win32' ? 'mpv-helper.exe' : 'mpv-helper';
    const candidates: string[] = isDev
        ? [
            join(__dirname, '..', '..', 'static', 'mpv-helper', binaryName),
            join(__dirname, '..', 'static', 'mpv-helper', binaryName),
            join(Properties.enhancedPath, 'mpv-helper', binaryName),
        ]
        : [
            join(process.resourcesPath!, 'mpv-helper', binaryName),
            join(Properties.enhancedPath, 'mpv-helper', binaryName),
        ];
    for (const p of candidates) {
        if (existsSync(p)) {
            logger.info(`Helper binary resolved: ${p}`);
            return p;
        }
    }
    logger.warn(`Helper binary not found. Checked paths: ${candidates.join(', ')}`);
    return null;
}

/** Write a timestamped line to the helper-specific log file. */
function appendHelperLog(message: string): void {
    try {
        const logFile = join(Properties.helperLogsPath, 'helper.log');
        appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
        // Best-effort logging — do not crash the supervisor.
    }
}

function launchHelper(): boolean {
    const helperPath = resolveHelperPath();
    if (!helperPath) {
        const msg = "Helper binary not found — running in stub mode (state will be mocked for UI development).";
        logger.warn(msg);
        appendHelperLog(msg);
        forwardEvent({ type: "diagnostics", payload: { message: msg, stub: true } });
        setStatus("ready");
        return true;
    }

    setStatus("starting");
    appendHelperLog(`Launching helper: ${helperPath}`);

    try {
        helperProcess = spawn(helperPath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });
    } catch (err) {
        const msg = `Failed to spawn helper: ${err}`;
        logger.error(msg);
        appendHelperLog(msg);
        setStatus("error");
        forwardEvent({ type: "helper-error", payload: { message: msg } });
        return false;
    }

    helperProcess.on('error', (err) => {
        const msg = `Helper process error: ${err.message}`;
        logger.error(msg);
        appendHelperLog(msg);
        setStatus("error");
        forwardEvent({ type: "helper-error", payload: { message: msg } });
        helperProcess = null;
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
                appendHelperLog(`[stdout] ${line}`);
            }
        }
    });

    helperProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        logger.warn(`[helper stderr] ${text}`);
        appendHelperLog(`[stderr] ${text}`);
    });

    helperProcess.on('exit', (code, signal) => {
        const exitMsg = `Helper exited (code=${code}, signal=${signal})`;
        logger.info(exitMsg);
        appendHelperLog(exitMsg);
        helperProcess = null;

        if (helperStatus === "shutdown") return;

        // Crash-restart with rate limiting
        const now = Date.now();
        if (now - lastCrashTime > CRASH_WINDOW_MS) crashCount = 0;
        lastCrashTime = now;
        crashCount++;

        if (crashCount <= MAX_CRASH_RESTARTS) {
            const restartMsg = `Crash #${crashCount}/${MAX_CRASH_RESTARTS} — attempting automatic restart.`;
            logger.warn(restartMsg);
            appendHelperLog(restartMsg);
            forwardEvent({ type: "helper-error", payload: { message: `Helper crashed (code ${code}). Restarting…` } });
            setStatus("starting");
            setTimeout(() => launchHelper(), 500);
        } else {
            const giveUpMsg = `Crash limit reached (${MAX_CRASH_RESTARTS} in ${CRASH_WINDOW_MS / 1000}s). Not restarting.`;
            logger.error(giveUpMsg);
            appendHelperLog(giveUpMsg);
            setStatus("crashed");
            forwardEvent({ type: "helper-error", payload: { message: `Helper crashed repeatedly. Check logs at: ${Properties.helperLogsPath}` } });
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
        const msg = `Failed to send command "${cmd.type}" to helper: ${err}`;
        logger.error(msg);
        appendHelperLog(msg);
        return false;
    }
}

function shutdownHelper(): void {
    if (helperProcess) {
        setStatus("shutdown");
        appendHelperLog("Shutdown requested — sending shutdown command.");
        sendToHelper({ type: 'shutdown' });
        setTimeout(() => {
            if (helperProcess) {
                logger.warn("Helper did not exit within 3 s — killing.");
                appendHelperLog("Force-killing helper after timeout.");
                helperProcess.kill();
                helperProcess = null;
            }
        }, 3000);
    } else {
        setStatus("idle");
    }
    lastState = null;
    crashCount = 0;
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
                        : { success: false, error: 'Helper is not running or stdin is closed' };
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

    /** Diagnostic snapshot for troubleshooting. */
    getDiagnostics(): Record<string, unknown> {
        return {
            status: helperStatus,
            helperRunning: helperProcess !== null,
            crashCount,
            helperLogsPath: Properties.helperLogsPath,
            resolvedPath: resolveHelperPath(),
        };
    },
};
