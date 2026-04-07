export const VALID_EXTERNAL_PLAYERS = ["disabled", "vlc", "mpv"] as const;
export type ExternalPlayer = typeof VALID_EXTERNAL_PLAYERS[number];

// Re-export the full playback mode set so callers can migrate gradually.
export { VALID_PLAYBACK_MODES, type PlaybackMode } from './EmbeddedPlayerTypes';
