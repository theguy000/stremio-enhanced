import { app, ipcMain, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { MPV_IPC } from '../constants';
import { getLogger } from '../utils/logger';

const logger = getLogger('MpvController');

class MpvController {
    private player: any = null;
    private sabInitialized = false;
    private ipcRegistered = false;
    public available = false;

    init(mainWindow: BrowserWindow) {
        try {
            const isDev = !app.isPackaged;
            const addonPath = isDev
                ? join(__dirname, '../../native/build/Release/node_libmpv.node')
                : join(process.resourcesPath, 'native', 'node_libmpv.node');

            if (!existsSync(addonPath)) {
                logger.warn('MPV addon not found at: ' + addonPath);
                return;
            }

            const libmpvDir = isDev
                ? join(__dirname, '../../native/deps', `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`)
                : join(process.resourcesPath, 'libmpv');

            const libmpvFile = process.platform === 'win32' ? 'libmpv-2.dll'
                : process.platform === 'darwin' ? 'libmpv.2.dylib'
                : 'libmpv.so.2';

            const libmpvPath = join(libmpvDir, libmpvFile);

            const addon = require(addonPath);
            this.player = new addon.MpvPlayer({ libmpvPath });
            this.available = true;
            logger.info('MPV addon loaded successfully');

            this.setupCallbacks(mainWindow);
            this.setupIPC();
            this.observeProperties();

            mainWindow.webContents.on('did-finish-load', () => {
                mainWindow.webContents.send(MPV_IPC.AVAILABLE, true);
            });
        } catch (err) {
            logger.error('Failed to load MPV addon: ' + err);
            this.available = false;
        }
    }

    private setupCallbacks(mainWindow: BrowserWindow) {
        this.player.onFrame = (width: number, height: number) => {
            if (!this.sabInitialized) {
                this.initSharedBuffer(mainWindow);
            }
            // Lightweight signal — pixels are already in the SAB (written by C++ PBO readback)
            mainWindow.webContents.send(MPV_IPC.FRAME_READY, { width, height });
        };

        this.player.onPropertyChange = (data: { name: string; value: any }) => {
            mainWindow.webContents.send(MPV_IPC.PROPERTY_CHANGE, data);
        };

        this.player.onEvent = (event: string) => {
            mainWindow.webContents.send(MPV_IPC.EVENT, event);
        };
    }

    private initSharedBuffer(mainWindow: BrowserWindow) {
        // Triple-buffer for up to 4K RGBA: header(16) + 3 * (3840*2160*4)
        const MAX_W = 3840;
        const MAX_H = 2160;
        const HEADER_SIZE = 16;
        const frameBytes = MAX_W * MAX_H * 4;
        const totalSize = HEADER_SIZE + 3 * frameBytes;

        const sab = new SharedArrayBuffer(totalSize);
        const view = new Uint8Array(sab);

        // Pass to C++ addon — it will write PBO readback directly here
        this.player.setFrameBuffer(view);

        // Send SAB to renderer once — structured clone transfers SAB by reference
        mainWindow.webContents.send(MPV_IPC.INIT_SAB, sab, MAX_W, MAX_H);

        this.sabInitialized = true;
        logger.info('SharedArrayBuffer initialized and sent to renderer');
    }

    private setupIPC() {
        if (this.ipcRegistered) return;
        this.ipcRegistered = true;

        ipcMain.on(MPV_IPC.LOAD_FILE, (_, url: string) => {
            this.player?.loadFile(url);
        });

        ipcMain.on(MPV_IPC.COMMAND, (_, ...args: string[]) => {
            this.player?.command(...args);
        });

        ipcMain.on(MPV_IPC.SET_PROPERTY, (_, name: string, value: any) => {
            this.player?.setProperty(name, String(value));
        });

        ipcMain.handle(MPV_IPC.GET_PROPERTY, (_, name: string) => {
            return this.player?.getProperty(name);
        });

        ipcMain.on(MPV_IPC.STOP, () => {
            this.player?.stop();
        });
    }

    private observeProperties() {
        const props = ['time-pos', 'duration', 'pause', 'volume',
                       'eof-reached', 'track-list', 'video-params'];
        for (const prop of props) {
            this.player.observeProperty(prop);
        }
    }

    destroy() {
        if (this.player) {
            this.player.stop();
            this.player.destroy();
            this.player = null;
        }
        this.sabInitialized = false;
    }
}

export default new MpvController();
