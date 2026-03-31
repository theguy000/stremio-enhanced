import { ipcRenderer } from 'electron';
import { MPV_IPC } from '../../constants';
import { MpvFrameReady } from '../../interfaces/MpvTypes';

class MpvCanvas {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private sab: ArrayBuffer | null = null;
    private headerView: Int32Array | null = null;
    private lastFrameIndex = -1;
    private frameWidth = 0;
    private frameHeight = 0;
    private drawing = false;

    private static HEADER_SIZE = 16; // 4 int32s

    init() {
        ipcRenderer.on(MPV_IPC.INIT_SAB, (_, sab: ArrayBuffer) => {
            this.sab = sab;
            this.headerView = new Int32Array(sab, 0, 4);
        });

        ipcRenderer.on(MPV_IPC.FRAME_READY, (_, data: MpvFrameReady) => {
            this.frameWidth = data.width;
            this.frameHeight = data.height;
            if (!this.drawing) {
                this.drawing = true;
                requestAnimationFrame(() => this.drawFrame());
            }
        });
    }

    setCanvas(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    removeCanvas() {
        this.canvas = null;
        this.ctx = null;
    }

    private async drawFrame() {
        if (!this.canvas || !this.ctx || !this.sab || !this.headerView) {
            this.drawing = false;
            return;
        }
        if (this.frameWidth === 0 || this.frameHeight === 0) {
            this.drawing = false;
            return;
        }

        // Read which slot is ready (plain read — both write and read are on main thread)
        const slotIndex = this.headerView[0];
        if (slotIndex === this.lastFrameIndex) {
            this.drawing = false;
            return;
        }
        this.lastFrameIndex = slotIndex;

        // Resize canvas if needed
        if (this.canvas.width !== this.frameWidth || this.canvas.height !== this.frameHeight) {
            this.canvas.width = this.frameWidth;
            this.canvas.height = this.frameHeight;
        }

        const frameSize = this.frameWidth * this.frameHeight * 4;
        const slotOffset = MpvCanvas.HEADER_SIZE + slotIndex * frameSize;
        const pixelData = new Uint8ClampedArray(this.sab, slotOffset, frameSize);

        try {
            const imageData = new ImageData(pixelData, this.frameWidth, this.frameHeight);
            const bitmap = await createImageBitmap(imageData);
            this.ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
        } catch (e) {
            const imageData = new ImageData(pixelData, this.frameWidth, this.frameHeight);
            this.ctx.putImageData(imageData, 0, 0);
        }

        ipcRenderer.send(MPV_IPC.FRAME_DISPLAYED);
        this.drawing = false;
    }
}

export const mpvCanvas = new MpvCanvas();
