import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../constants';
import type { HelperCommand, HelperPlaybackState, HelperStatus } from '../../interfaces/EmbeddedPlayerTypes';

type StateCallback = (state: HelperPlaybackState) => void;
type StatusCallback = (status: HelperStatus) => void;
type EventCallback = (event: { type: string; payload?: Record<string, unknown> }) => void;

const stateListeners = new Set<StateCallback>();
const statusListeners = new Set<StatusCallback>();
const eventListeners = new Set<EventCallback>();

// Wire up IPC listeners once the module is imported.
ipcRenderer.on(IPC_CHANNELS.EMBEDDED_PLAYER_STATE, (_e, state: HelperPlaybackState) => {
    for (const cb of stateListeners) cb(state);
});

ipcRenderer.on(IPC_CHANNELS.EMBEDDED_PLAYER_STATUS, (_e, status: HelperStatus) => {
    for (const cb of statusListeners) cb(status);
});

ipcRenderer.on(IPC_CHANNELS.EMBEDDED_PLAYER_EVENT, (_e, event: { type: string; payload?: Record<string, unknown> }) => {
    for (const cb of eventListeners) cb(event);
});

export const embeddedPlayerAPI = {
    /** Send a command to the helper process through main. */
    sendCommand(cmd: HelperCommand): Promise<{ success: boolean; error?: string }> {
        return ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_PLAYER_COMMAND, cmd);
    },

    /** Retrieve the native window handle buffer from main. */
    getNativeHandle(): Promise<Buffer | null> {
        return ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_PLAYER_GET_NATIVE_HANDLE);
    },

    /** Subscribe to playback-state updates from the helper. */
    onState(cb: StateCallback): () => void {
        stateListeners.add(cb);
        return () => { stateListeners.delete(cb); };
    },

    /** Subscribe to helper-status changes (idle, ready, error, …). */
    onStatus(cb: StatusCallback): () => void {
        statusListeners.add(cb);
        return () => { statusListeners.delete(cb); };
    },

    /** Subscribe to one-off helper events (errors, diagnostics, …). */
    onEvent(cb: EventCallback): () => void {
        eventListeners.add(cb);
        return () => { eventListeners.delete(cb); };
    },
};
