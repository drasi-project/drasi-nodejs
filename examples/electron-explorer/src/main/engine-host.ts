// EngineHost: owns the single embedded @drasi/lib instance in the Electron
// main process. The native addon is N-API v9 (ABI-stable), so it loads here
// without `electron-rebuild`.

import { app } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StreamEnvelope } from '../shared/types.js';

// Load the native addon via CommonJS require (the package ships a CJS index.js).
// `typeof import(...)` gives us full typings while guaranteeing a runtime require.
const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib') as typeof import('@drasi/lib');

export type Engine = InstanceType<typeof Drasi>;

let engine: Engine | null = null;
let pluginsDir = '';
let forwarder: ((env: StreamEnvelope) => void) | null = null;

/** Set the function used to push live stream items to the renderer. */
export function setForwarder(fn: (env: StreamEnvelope) => void): void {
  forwarder = fn;
}

function forward(env: StreamEnvelope): void {
  forwarder?.(env);
}

/** Resolve per-user data locations for plugins and persistent state. */
export function paths() {
  const userData = app.getPath('userData');
  return {
    userData,
    pluginsDir: join(userData, 'plugins'),
    stateDb: join(userData, 'state.redb'),
    secretsFile: join(userData, 'secrets.json'),
    topologyFile: join(userData, 'topology.json'),
  };
}

/** Create and start the engine. Idempotent. */
export async function initEngine(): Promise<Engine> {
  if (engine) return engine;

  const p = paths();
  pluginsDir = p.pluginsDir;
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

  // Optional startup secrets (seeded at creation; the engine has no add-secret API).
  let secrets: Record<string, string> = {};
  if (existsSync(p.secretsFile)) {
    try {
      secrets = JSON.parse(readFileSync(p.secretsFile, 'utf8'));
    } catch {
      // ignore malformed secrets file
    }
  }

  engine = await Drasi.create('explorer', {
    secrets,
    stateStore: { kind: 'redb', path: p.stateDb },
  });

  // Pick up any previously-installed plugins, and hot-load future installs.
  await engine.loadPlugins(pluginsDir);
  await engine.watchPlugins(pluginsDir);
  await engine.start();

  // Forward all lifecycle/status events to the renderer.
  await engine.onAllEvents((event: unknown) => {
    forward({ kind: 'event', payload: event as StreamEnvelope['payload'] });
  });

  return engine;
}

export function getEngine(): Engine {
  if (!engine) throw new Error('engine not initialized');
  return engine;
}

export function getPluginsDir(): string {
  return pluginsDir;
}

/** Subscribe to a component's logs and forward them to the renderer. */
export async function streamLogs(
  kind: 'source' | 'query' | 'reaction',
  id: string,
): Promise<void> {
  const e = getEngine();
  const cb = (msg: unknown) => forward({ kind: 'log', id, payload: msg as StreamEnvelope['payload'] });
  if (kind === 'source') await e.onSourceLogs(id, cb);
  else if (kind === 'query') await e.onQueryLogs(id, cb);
  else await e.onReactionLogs(id, cb);
}

/**
 * Stream a query's live result diffs to the renderer via a hidden JS reaction.
 * Returns the hidden reaction id (so it can be removed with the query).
 */
export async function streamResults(queryId: string): Promise<string> {
  const e = getEngine();
  const reactionId = resultsReactionId(queryId);
  await e.addJsReaction(reactionId, [queryId], (result: unknown) => {
    forward({ kind: 'result', id: queryId, payload: result as StreamEnvelope['payload'] });
  });
  return reactionId;
}

/** The hidden results-reaction id for a query (filtered out of UI listings). */
export function resultsReactionId(queryId: string): string {
  return `__results__${queryId}`;
}

export function isHiddenReaction(id: string): boolean {
  return id.startsWith('__results__');
}

export async function shutdown(): Promise<void> {
  if (engine) {
    try {
      await engine.close();
    } catch {
      // best-effort
    }
    engine = null;
  }
}
