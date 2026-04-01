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
            // Push to page context via script injection (CustomEvent.detail
            // doesn't cross context isolation from preload to page)
            mpvBridge.notifyAvailable(available);
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

    private hideVideo(video: HTMLVideoElement) {
        video.style.opacity = '0';
        video.style.pointerEvents = 'none';
        video.style.position = 'absolute';
        video.style.width = '0';
        video.style.height = '0';
    }

    private showVideo(video: HTMLVideoElement) {
        video.style.opacity = '';
        video.style.pointerEvents = '';
        video.style.position = '';
        video.style.width = '';
        video.style.height = '';
    }

    private async activateMpv() {
        try {
            await Helpers.waitForElm('video');
            const video = document.querySelector('video') as HTMLVideoElement;
            if (!video) return;

            // 1. Get stream URL — check stashed src (captured by page-context patches)
            let streamUrl = mpvBridge.getLastStashedSrc();
            if (!streamUrl) {
                const playerState = await PlaybackState.getPlayerState();
                if (playerState?.stream?.content?.url) {
                    streamUrl = playerState.stream.content.url;
                }
            }
            if (!streamUrl) {
                logger.warn('No stream URL found, falling back to HTML5');
                return;
            }

            // 2. Activate bridge (IPC listeners, seekbar, push state to page)
            mpvBridge.activate(video);
            mpvBridge.setCapturedSrc(streamUrl);

            // 3. Create canvas overlay
            const parent = video.parentElement;
            if (!parent) return;

            const parentPos = getComputedStyle(parent).position;
            if (parentPos === 'static') {
                parent.style.position = 'relative';
            }

            this.hideVideo(video);

            const canvas = document.createElement('canvas');
            canvas.id = 'mpv-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.backgroundColor = '#000';

            // Insert right after video — subtitles/controls that come later
            // in the DOM will naturally stack on top of the canvas
            video.after(canvas);
            mpvCanvas.setCanvas(canvas);

            // 4. Guard against React re-creating video elements
            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node instanceof HTMLVideoElement) {
                            this.hideVideo(node);
                            mpvBridge.updateVideoRef(node);
                            mpvBridge.redispatchReadiness();
                        }
                    }
                }
            });
            this.observer.observe(parent, { childList: true, subtree: true });

            // 5. Tell MPV to load the file
            ipcRenderer.send(MPV_IPC.LOAD_FILE, streamUrl);
            this.active = true;
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

        mpvBridge.deactivate();

        // Restore video element visibility
        const video = document.querySelector('video') as HTMLVideoElement;
        if (video) this.showVideo(video);

        this.observer?.disconnect();
        this.observer = null;

        this.active = false;
        logger.info('MPV deactivated');
    }
}

export const mpvInterceptor = new MpvInterceptor();
