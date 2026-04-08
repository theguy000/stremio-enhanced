export const VALID_EXTERNAL_PLAYERS = ["disabled", "vlc", "mpv", "embedded-mpv"] as const;
export type ExternalPlayer = typeof VALID_EXTERNAL_PLAYERS[number];
