import { ipcRenderer } from 'electron';
import { MPV_IPC } from '../../constants';
import { mpvBridge } from './mpvBridge';

class MpvCanvas {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private pendingFrame: { width: number; height: number; data: Uint8Array } | null = null;
    private drawing = false;

    init() {
        ipcRenderer.on(MPV_IPC.FRAME_READY, (_, frame: { width: number; height: number; data: Buffer }) => {
            mpvBridge.setVideoDimensions(frame.width, frame.height);
            this.pendingFrame = {
                width: frame.width,
                height: frame.height,
                data: frame.data as unknown as Uint8Array
            };
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
        this.pendingFrame = null;
    }

    private drawFrame() {
        this.drawing = false;
        if (!this.canvas || !this.ctx || !this.pendingFrame) return;

        const { width, height, data } = this.pendingFrame;
        this.pendingFrame = null;

        if (width === 0 || height === 0) return;

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        const pixels = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
        const imageData = new ImageData(pixels, width, height);
        this.ctx.putImageData(imageData, 0, 0);

        ipcRenderer.send(MPV_IPC.FRAME_DISPLAYED);
    }
}

export const mpvCanvas = new MpvCanvas();
