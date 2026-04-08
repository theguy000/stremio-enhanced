import { ipcRenderer } from 'electron';
import { STORAGE_KEYS, PLAYER_PATH_STORAGE_KEY, IPC_CHANNELS } from '../../constants';
import { externalPlayerAPI } from '../api/externalPlayer';
import { type ExternalPlayer } from '../../interfaces/ExternalPlayerTypes';
import PlaybackState from '../../utils/PlaybackState';
import Helpers from '../../utils/Helpers';
import { getLogger } from '../../utils/logger';

const logger = getLogger("ExternalPlayerInterceptor");

let isLaunching = false;

export function checkExternalPlayer(): void {
    if (isLaunching) return;
    const externalPlayer = localStorage.getItem(STORAGE_KEYS.EXTERNAL_PLAYER);
    if (!externalPlayer || externalPlayer === 'disabled') return;
    if (!location.href.includes('#/player')) return;

    if (externalPlayer === 'embedded-mpv') {
        launchEmbeddedMpv();
    } else {
        launchExternal(externalPlayer as ExternalPlayer);
    }
}

async function launchEmbeddedMpv(): Promise<void> {
    isLaunching = true;
    try {
        logger.info("Embedded MPV player interceptor triggered");

        const playerState = await PlaybackState.getPlayerState();
        if (!playerState?.stream?.content?.url) {
            logger.error("Could not retrieve stream URL for embedded MPV.");
            Helpers.createToast("mpvError", "MPV Player", "Could not get stream URL.", "fail");
            return;
        }

        const streamUrl = playerState.stream.content.url;
        logger.info(`Launching embedded MPV with stream URL: ${streamUrl}`);

        const result = await ipcRenderer.invoke(IPC_CHANNELS.MPV_LOAD_FILE, {
            url: streamUrl,
            subtitles: playerState.subtitlesTracks || [],
            preferredLang: 'en',
            metadata: {
                title: playerState.metaDetails?.name,
            },
        });

        if (!result.success) {
            Helpers.createToast("mpvError", "MPV Player", result.error ?? "Failed to start playback.", "fail");
        }
    } finally {
        isLaunching = false;
    }
}

async function launchExternal(player: ExternalPlayer): Promise<void> {
    isLaunching = true;
    try {
        logger.info(`External player interceptor triggered for ${player}`);

        const playerState = await PlaybackState.getPlayerState();
        if (!playerState?.stream?.content?.url) {
            logger.error("Could not retrieve stream URL for external player.");
            Helpers.createToast("extPlayerError", "External Player", "Could not get stream URL.", "fail");
            return;
        }

        const streamUrl = playerState.stream.content.url;
        logger.info(`Launching ${player} with stream URL: ${streamUrl}`);

        // Navigate back before launching to prevent the built-in player from loading
        history.back();

        const customPath = localStorage.getItem(PLAYER_PATH_STORAGE_KEY[player]);

        const result = await externalPlayerAPI.launchExternalPlayer(player, streamUrl, customPath || undefined);
        if (result.success) {
            Helpers.createToast("extPlayerLaunch", "External Player", `Opening stream in ${player.toUpperCase()}...`, "success");
        } else {
            Helpers.createToast("extPlayerError", "External Player", result.error ?? "Failed to launch player.", "fail");
        }
    } finally {
        isLaunching = false;
    }
}
