import { ipcRenderer } from 'electron';
import { MPV_IPC } from '../../constants';
import Helpers from '../../utils/Helpers';
import PlaybackState from '../../utils/PlaybackState';
import { mpvCanvas } from './mpvCanvas';
import { mpvBridge } from './mpvBridge';
import { getLogger } from '../../utils/logger';

const logger = getLogger('MpvInterceptor');

class MpvInterceptor {
    private mpvAvailable = false;
    private active = false;
    private observer: MutationObserver | null = null;

    init() {
        ipcRenderer.on(MPV_IPC.AVAILABLE, (_, available: boolean) => {
            this.mpvAvailable = available;
            logger.info('MPV available: ' + available);
        });

        mpvCanvas.init();

        window.addEventListener('hashchange', () => this.handleRouteChange());
    }

    private async handleRouteChange() {
        if (location.href.includes('#/player')) {
            if (this.mpvAvailable && !this.active) {
                await this.activateMpv();
            }
        } else if (this.active) {
            this.deactivateMpv();
        }
    }

    private async activateMpv() {
        try {
            await Helpers.waitForElm('video');
            const video = document.querySelector('video') as HTMLVideoElement;
            if (!video) return;

            const playerState = await PlaybackState.getPlayerState();
            if (!playerState?.stream?.content?.url) {
                logger.warn('No stream URL found, falling back to HTML5');
                return;
            }
            const streamUrl = playerState.stream.content.url;

            video.style.display = 'none';
            video.pause();

            const canvas = document.createElement('canvas');
            canvas.id = 'mpv-canvas';
            canvas.style.cssText = video.style.cssText;
            canvas.style.display = 'block';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.objectFit = 'contain';
            canvas.style.backgroundColor = '#000';

            video.parentElement?.appendChild(canvas);
            mpvCanvas.setCanvas(canvas);

            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node instanceof HTMLVideoElement) {
                            node.style.display = 'none';
                            node.pause();
                        }
                    }
                }
            });
            this.observer.observe(document.body, { childList: true, subtree: true });

            ipcRenderer.send(MPV_IPC.LOAD_FILE, streamUrl);
            this.active = true;
            mpvBridge.activate();
            logger.info('MPV activated for: ' + streamUrl);
        } catch (err) {
            logger.error('Failed to activate MPV: ' + err);
        }
    }

    private deactivateMpv() {
        ipcRenderer.send(MPV_IPC.STOP);

        const canvas = document.getElementById('mpv-canvas');
        if (canvas) canvas.remove();
        mpvCanvas.removeCanvas();

        const video = document.querySelector('video') as HTMLVideoElement;
        if (video) video.style.display = '';

        this.observer?.disconnect();
        this.observer = null;

        mpvBridge.deactivate();
        this.active = false;
        logger.info('MPV deactivated');
    }
}

export const mpvInterceptor = new MpvInterceptor();
