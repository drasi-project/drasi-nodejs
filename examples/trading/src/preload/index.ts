import { contextBridge, ipcRenderer } from 'electron';
import { STREAM_CHANNEL, type StreamEnvelope, type TradingApi } from '../shared/types.js';

const ERROR_CHANNEL = 'trading:error';

const api: TradingApi = {
  getResults: (queryId) => ipcRenderer.invoke('trading:getResults', queryId),

  onResults: (cb: (env: StreamEnvelope) => void) => {
    const listener = (_e: unknown, env: StreamEnvelope): void => cb(env);
    ipcRenderer.on(STREAM_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STREAM_CHANNEL, listener);
  },

  onError: (cb: (message: string) => void) => {
    const listener = (_e: unknown, message: string): void => cb(message);
    ipcRenderer.on(ERROR_CHANNEL, listener);
    return () => ipcRenderer.removeListener(ERROR_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('trading', api);
