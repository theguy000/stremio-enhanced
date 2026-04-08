import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../constants';
import { settingsAPI } from './api/settings';
import { pluginLogger } from './api/pluginLogger';
import { alertAPI } from './api/alert';

// Expose mpv control API to the overlay renderer
const mpvAPI = {
    // Playback commands
    seek: (position: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SEEK, { position }),
    togglePause: () => ipcRenderer.send(IPC_CHANNELS.MPV_TOGGLE_PAUSE),
    setVolume: (volume: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SET_VOLUME, { volume }),
    setTrack: (type: 'audio' | 'sub', id: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SET_TRACK, { type, id }),
    setSpeed: (speed: number) => ipcRenderer.send(IPC_CHANNELS.MPV_SET_SPEED, { speed }),
    command: (args: string[]) => ipcRenderer.send(IPC_CHANNELS.MPV_COMMAND, { args }),
    destroy: () => ipcRenderer.send(IPC_CHANNELS.MPV_DESTROY),
    toggleFullscreen: () => ipcRenderer.send(IPC_CHANNELS.MPV_TOGGLE_FULLSCREEN),
    getProperty: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.MPV_GET_PROP, { name }),

    // Event listeners
    onPropertyChange: (callback: (data: { name: string; value: any }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_PROPERTY_CHANGE, (_, data) => callback(data));
    },
    onTracksChanged: (callback: (data: { tracks: any[] }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_TRACKS_CHANGED, (_, data) => callback(data));
    },
    onFileLoaded: (callback: (data: any) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_FILE_LOADED, (_, data) => callback(data));
    },
    onEndFile: (callback: (data: { reason: string }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_END_FILE, (_, data) => callback(data));
    },
    onPlaybackError: (callback: (data: { error: string }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_PLAYBACK_ERROR, (_, data) => callback(data));
    },
    onEvent: (callback: (data: { event: string; data?: any }) => void) => {
        ipcRenderer.on(IPC_CHANNELS.MPV_EVENT, (_, data) => callback(data));
    },
};

// Expose both mpv API and the standard StremioEnhancedAPI for plugins
contextBridge.exposeInMainWorld('mpvPlayer', mpvAPI);
contextBridge.exposeInMainWorld('StremioEnhancedAPI', {
    ...alertAPI,
    ...settingsAPI,
    ...pluginLogger,
});

// Initialize the overlay bridge after DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    import('./ui/mpvOverlayBridge').then(({ initOverlayBridge }) => {
        initOverlayBridge();
    });
});
