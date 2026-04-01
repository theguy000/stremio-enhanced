import { app, ipcMain, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { MPV_IPC } from '../constants';
import { getLogger } from '../utils/logger';

const logger = getLogger('MpvController');

class MpvController {
    private player: any = null;
    private frameBuffer: ArrayBuffer | null = null;
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
            if (!this.frameBuffer) {
                // First frame callback — allocate the backing buffer for PBO readback.
                // No pixel data yet; the next renderFrame will fill it.
                this.frameBuffer = this.player.getFrameBuffer(3840, 2160);
                return;
            }

            // Read the current frame slot from the local buffer and send pixels via IPC
            const HEADER_SIZE = 16;
            const headerView = new Int32Array(this.frameBuffer!, 0, 4);
            const slotIndex = headerView[0];
            if (slotIndex < 0 || slotIndex > 2) return; // invalid slot

            const frameSize = width * height * 4;
            const slotOffset = HEADER_SIZE + slotIndex * frameSize;

            // Copy the pixels so IPC sends a snapshot (Buffer.from creates a view)
            const pixels = Buffer.allocUnsafe(frameSize);
            Buffer.from(this.frameBuffer!, slotOffset, frameSize).copy(pixels);

            mainWindow.webContents.send(MPV_IPC.FRAME_READY, { width, height, data: pixels });
        };

        this.player.onPropertyChange = (data: { name: string; value: any }) => {
            mainWindow.webContents.send(MPV_IPC.PROPERTY_CHANGE, data);
        };

        this.player.onEvent = (event: string) => {
            mainWindow.webContents.send(MPV_IPC.EVENT, event);
        };
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

        ipcMain.on(MPV_IPC.FRAME_DISPLAYED, () => {
            this.player?.reportSwap();
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
    }
}

export default new MpvController();
