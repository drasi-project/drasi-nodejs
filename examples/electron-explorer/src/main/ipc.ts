// IPC bridge: registers request/response handlers that proxy to the engine, wires
// per-component log/result streaming as components are created, and records the
// topology for restore-on-restart.

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  AddQueryRequest,
  AddReactionRequest,
  AddSourceRequest,
  ComponentStatusEntry,
  SourceChangeInput,
} from '../shared/types.js';
import {
  getEngine,
  isHiddenReaction,
  resultsReactionId,
  streamLogs,
  streamResults,
} from './engine-host.js';
import {
  browsePlugins,
  importLocalPlugins,
  installPlugin,
  listVersions,
} from './registry-service.js';
import {
  forgetQuery,
  forgetReaction,
  forgetSource,
  loadTopology,
  recordQuery,
  recordReaction,
  recordSource,
} from './persistence.js';

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_evt, ...args) => fn(...args));
}

// ---- internal operations (shared by IPC handlers and topology restore) ----

async function doAddSource(req: AddSourceRequest): Promise<void> {
  const e = getEngine();
  await e.addSource(req.kind, req.id, req.config, req.autoStart ?? true, req.bootstrap);
  await streamLogs('source', req.id);
}

async function doAddJsSource(id: string, autoStart: boolean): Promise<void> {
  const e = getEngine();
  await e.addJsSource(id, autoStart);
  await streamLogs('source', id);
}

async function doAddQuery(req: AddQueryRequest): Promise<void> {
  const e = getEngine();
  await e.addQuery(req.id, req.query, req.sources, req.language);
  await streamLogs('query', req.id);
  await streamResults(req.id);
}

async function doAddReaction(req: AddReactionRequest): Promise<void> {
  const e = getEngine();
  await e.addReaction(req.kind, req.id, req.queries, req.config);
  await streamLogs('reaction', req.id);
}

export function registerIpc(): void {
  // ---- discovery / install ----
  handle(IPC.browsePlugins, () => browsePlugins());
  handle(IPC.listVersions, (repository: string) => listVersions(repository));
  handle(IPC.installPlugin, (reference: string, type: any, kind: string) =>
    installPlugin(reference, type, kind),
  );
  handle(IPC.importLocalPlugins, (dir: string) => importLocalPlugins(dir));
  handle(IPC.pluginKinds, () => getEngine().pluginKinds());

  // ---- sources ----
  handle(IPC.addSource, async (req: AddSourceRequest) => {
    await doAddSource(req);
    recordSource({ ...req, js: false });
  });
  handle(IPC.addJsSource, async (id: string, autoStart?: boolean) => {
    const a = autoStart ?? true;
    await doAddJsSource(id, a);
    recordSource({ kind: '__js__', id, config: {}, autoStart: a, js: true });
  });
  handle(IPC.pushChange, (sourceId: string, change: SourceChangeInput) =>
    getEngine().pushChange(sourceId, change),
  );
  handle(IPC.startSource, (id: string) => getEngine().startSource(id));
  handle(IPC.stopSource, (id: string) => getEngine().stopSource(id));
  handle(IPC.removeSource, async (id: string, cleanup?: boolean) => {
    await getEngine().removeSource(id, cleanup ?? false);
    forgetSource(id);
  });
  handle(IPC.listSources, () => getEngine().listSources());

  // ---- queries (also stream live results via a hidden JS reaction) ----
  handle(IPC.addQuery, async (req: AddQueryRequest) => {
    await doAddQuery(req);
    recordQuery(req);
  });
  handle(IPC.startQuery, (id: string) => getEngine().startQuery(id));
  handle(IPC.stopQuery, (id: string) => getEngine().stopQuery(id));
  handle(IPC.removeQuery, async (id: string) => {
    const e = getEngine();
    try {
      await e.removeReaction(resultsReactionId(id), false);
    } catch {
      // may not exist
    }
    await e.removeQuery(id);
    forgetQuery(id);
  });
  handle(IPC.getQueryResults, (id: string) => getEngine().getQueryResults(id));
  handle(IPC.listQueries, () => getEngine().listQueries());

  // ---- reactions (hide internal results reactions from the UI) ----
  handle(IPC.addReaction, async (req: AddReactionRequest) => {
    await doAddReaction(req);
    recordReaction(req);
  });
  handle(IPC.startReaction, (id: string) => getEngine().startReaction(id));
  handle(IPC.stopReaction, (id: string) => getEngine().stopReaction(id));
  handle(IPC.removeReaction, async (id: string, cleanup?: boolean) => {
    await getEngine().removeReaction(id, cleanup ?? false);
    forgetReaction(id);
  });
  handle(IPC.listReactions, async () => {
    const list = (await getEngine().listReactions()) as ComponentStatusEntry[];
    return list.filter((r) => !isHiddenReaction(r.id));
  });

  // ---- metrics ----
  handle(IPC.getQueryMetrics, (id: string) => getEngine().getQueryMetrics(id));
  handle(IPC.getReactionMetrics, (id: string) => getEngine().getReactionMetrics(id));
  handle(IPC.getLifecycleMetrics, () => getEngine().getLifecycleMetrics());

  // ---- misc ----
  handle(IPC.pickFolder, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
}

/**
 * Re-create the previously-saved topology. Best-effort: a component whose plugin
 * kind is no longer installed is skipped (logged) rather than aborting restore.
 */
export async function restoreTopology(): Promise<void> {
  const topo = loadTopology();
  for (const s of topo.sources) {
    try {
      if (s.js) await doAddJsSource(s.id, s.autoStart ?? true);
      else await doAddSource(s);
    } catch (e) {
      console.warn(`restore: source '${s.id}' skipped:`, e);
    }
  }
  for (const q of topo.queries) {
    try {
      await doAddQuery(q);
    } catch (e) {
      console.warn(`restore: query '${q.id}' skipped:`, e);
    }
  }
  for (const r of topo.reactions) {
    try {
      await doAddReaction(r);
    } catch (e) {
      console.warn(`restore: reaction '${r.id}' skipped:`, e);
    }
  }
}
