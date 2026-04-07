import { STORAGE_KEYS, PLAYER_PATH_STORAGE_KEY } from '../../constants';
import { externalPlayerAPI } from '../api/externalPlayer';
import { type ExternalPlayer } from '../../interfaces/ExternalPlayerTypes';
import { type PlaybackMode } from '../../interfaces/EmbeddedPlayerTypes';
import PlaybackState from '../../utils/PlaybackState';
import Helpers from '../../utils/Helpers';
import { getLogger } from '../../utils/logger';

const logger = getLogger("PlayerInterceptor");

let isLaunching = false;

/** Callback set by the embedded player shell to receive a stream URL. */
let embeddedPlayerMountFn: ((streamUrl: string, playerState: unknown) => void) | null = null;

export function registerEmbeddedMountCallback(cb: (streamUrl: string, playerState: unknown) => void): void {
    embeddedPlayerMountFn = cb;
}

export function unregisterEmbeddedMountCallback(): void {
    embeddedPlayerMountFn = null;
}

export function checkExternalPlayer(): void {
    if (isLaunching) return;

    const playbackMode = (localStorage.getItem(STORAGE_KEYS.PLAYBACK_MODE) ?? 'disabled') as PlaybackMode;
    if (playbackMode === 'disabled') return;
    if (!location.href.includes('#/player')) return;

    if (playbackMode === 'embedded-mpv') {
        launchEmbedded();
    } else {
        launchExternal(playbackMode as ExternalPlayer);
    }
}

async function launchEmbedded(): Promise<void> {
    isLaunching = true;
    try {
        logger.info("Embedded player interceptor triggered");

        const playerState = await PlaybackState.getPlayerState();
        if (!playerState?.stream?.content?.url) {
            logger.error("Could not retrieve stream URL for embedded player.");
            Helpers.createToast("embPlayerError", "Embedded Player", "Could not get stream URL.", "fail");
            return;
        }

        const streamUrl = playerState.stream.content.url;
        logger.info(`Mounting embedded player shell with URL: ${streamUrl}`);

        if (embeddedPlayerMountFn) {
            embeddedPlayerMountFn(streamUrl, playerState);
        } else {
            logger.error("Embedded player mount callback is not registered.");
            Helpers.createToast("embPlayerError", "Embedded Player", "Embedded player shell not available.", "fail");
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
