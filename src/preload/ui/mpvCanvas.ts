import { ipcRenderer } from 'electron';
import { MPV_IPC } from '../../constants';
import { mpvBridge } from './mpvBridge';

const HEADER_SIZE = 16; // 4 x int32: [slotIndex, width, height, reserved]

class MpvCanvas {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private drawing = false;

    // SAB state (received once from main process)
    private header: Int32Array | null = null;
    private sabView: Uint8Array | null = null;
    private maxFrameBytes = 0;

    // Latest signal from main process
    private signalWidth = 0;
    private signalHeight = 0;

    init() {
        // Receive SAB once — structured clone shares the backing memory
        ipcRenderer.on(MPV_IPC.INIT_SAB, (_, sab: SharedArrayBuffer, maxW: number, maxH: number) => {
            this.header = new Int32Array(sab, 0, 4);
            this.sabView = new Uint8Array(sab);
            this.maxFrameBytes = maxW * maxH * 4;
        });

        // Lightweight frame signal — no pixel data, just dimensions
        ipcRenderer.on(MPV_IPC.FRAME_READY, (_, frame: { width: number; height: number }) => {
            mpvBridge.setVideoDimensions(frame.width, frame.height);
            this.signalWidth = frame.width;
            this.signalHeight = frame.height;

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

    private drawFrame() {
        this.drawing = false;
        if (!this.canvas || !this.ctx || !this.header || !this.sabView) return;

        const width = this.signalWidth;
        const height = this.signalHeight;
        if (width === 0 || height === 0) return;

        // Read the current triple-buffer slot atomically
        const slotIndex = Atomics.load(this.header, 0);
        if (slotIndex < 0 || slotIndex > 2) return;

        const frameBytes = width * height * 4;
        const slotOffset = HEADER_SIZE + slotIndex * this.maxFrameBytes;

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        // Copy from SAB into a regular Uint8ClampedArray — required because
        // Chromium's ImageData constructor rejects SharedArrayBuffer-backed views
        const pixels = new Uint8ClampedArray(frameBytes);
        pixels.set(new Uint8Array(this.sabView.buffer, slotOffset, frameBytes));
        const imageData = new ImageData(pixels, width, height);
        this.ctx.putImageData(imageData, 0, 0);
    }
}

export const mpvCanvas = new MpvCanvas();
