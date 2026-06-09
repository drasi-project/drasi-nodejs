import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';
import {
  STREAM_CHANNEL,
  type AddQueryRequest,
  type AddReactionRequest,
  type AddSourceRequest,
  type DrasiApi,
  type SourceChangeInput,
  type StreamEnvelope,
} from '../shared/types.js';

const api: DrasiApi = {
  browsePlugins: () => ipcRenderer.invoke(IPC.browsePlugins),
  listVersions: (repository) => ipcRenderer.invoke(IPC.listVersions, repository),
  installPlugin: (reference, type, kind) =>
    ipcRenderer.invoke(IPC.installPlugin, reference, type, kind),
  importLocalPlugins: (dir) => ipcRenderer.invoke(IPC.importLocalPlugins, dir),
  pluginKinds: () => ipcRenderer.invoke(IPC.pluginKinds),

  addSource: (req: AddSourceRequest) => ipcRenderer.invoke(IPC.addSource, req),
  addJsSource: (id, autoStart) => ipcRenderer.invoke(IPC.addJsSource, id, autoStart),
  pushChange: (sourceId, change: SourceChangeInput) =>
    ipcRenderer.invoke(IPC.pushChange, sourceId, change),
  startSource: (id) => ipcRenderer.invoke(IPC.startSource, id),
  stopSource: (id) => ipcRenderer.invoke(IPC.stopSource, id),
  removeSource: (id, cleanup) => ipcRenderer.invoke(IPC.removeSource, id, cleanup),
  listSources: () => ipcRenderer.invoke(IPC.listSources),

  addQuery: (req: AddQueryRequest) => ipcRenderer.invoke(IPC.addQuery, req),
  startQuery: (id) => ipcRenderer.invoke(IPC.startQuery, id),
  stopQuery: (id) => ipcRenderer.invoke(IPC.stopQuery, id),
  removeQuery: (id) => ipcRenderer.invoke(IPC.removeQuery, id),
  getQueryResults: (id) => ipcRenderer.invoke(IPC.getQueryResults, id),
  listQueries: () => ipcRenderer.invoke(IPC.listQueries),

  addReaction: (req: AddReactionRequest) => ipcRenderer.invoke(IPC.addReaction, req),
  startReaction: (id) => ipcRenderer.invoke(IPC.startReaction, id),
  stopReaction: (id) => ipcRenderer.invoke(IPC.stopReaction, id),
  removeReaction: (id, cleanup) => ipcRenderer.invoke(IPC.removeReaction, id, cleanup),
  listReactions: () => ipcRenderer.invoke(IPC.listReactions),

  getQueryMetrics: (id) => ipcRenderer.invoke(IPC.getQueryMetrics, id),
  getReactionMetrics: (id) => ipcRenderer.invoke(IPC.getReactionMetrics, id),
  getLifecycleMetrics: () => ipcRenderer.invoke(IPC.getLifecycleMetrics),

  onStream: (cb: (env: StreamEnvelope) => void) => {
    const listener = (_e: unknown, env: StreamEnvelope): void => cb(env);
    ipcRenderer.on(STREAM_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STREAM_CHANNEL, listener);
  },

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
};

contextBridge.exposeInMainWorld('drasi', api);
