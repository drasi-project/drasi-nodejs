// EngineHost: owns the single embedded @drasi/lib instance in the Electron
// main process and wires up the whole trading topology:
//   real Postgres CDC source (+ bootstrap)  ->  synthetic joins  ->  queries
//   in-process price feed (JS source)        ->  application reaction  ->  UI
// The native addon is N-API v9 (ABI-stable), so it loads here with no rebuild.

import { app } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import type { QueryResultEvent, StreamEnvelope } from '../shared/types.js';
import { QUERIES, SOURCE_POSTGRES, SOURCE_PRICES } from '../shared/queries.js';
import { ensurePlugins } from './plugins.js';
import { PriceFeed } from './price-feed.js';

const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib') as typeof import('@drasi/lib');

export type Engine = InstanceType<typeof Drasi>;

// Connection details match database/docker-compose.yml + init.sql.
const PG_CONFIG = {
  host: 'localhost',
  port: 5632,
  database: 'trading_demo',
  user: 'drasi_user',
  password: 'drasi_password',
  tables: ['stocks', 'portfolio', 'watchlist'],
  slotName: 'drasi_trading_slot',
  publicationName: 'drasi_trading_pub',
  sslMode: 'prefer',
  tableKeys: [
    { table: 'stocks', keyColumns: ['id'] },
    { table: 'portfolio', keyColumns: ['id'] },
    { table: 'watchlist', keyColumns: ['id'] },
  ],
};

let engine: Engine | null = null;
let priceFeed: PriceFeed | null = null;
let forwarder: ((env: StreamEnvelope) => void) | null = null;

export function setForwarder(fn: (env: StreamEnvelope) => void): void {
  forwarder = fn;
}

export function getEngine(): Engine {
  if (!engine) throw new Error('engine not initialized');
  return engine;
}

/** Current snapshot of a query's result set. */
export async function getResults(queryId: string): Promise<Array<Record<string, unknown>>> {
  return (await getEngine().getQueryResults(queryId)) as Array<Record<string, unknown>>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolve when a TCP port accepts a connection, or throw after `attempts`. */
async function waitForPort(host: string, port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(1000);
  }
  throw new Error(
    `Postgres is not reachable at ${host}:${port}. Start it first with \`npm run db:up\` (requires Docker Desktop).`,
  );
}

/** Create the engine, download plugins, and build the full topology. */
export async function initEngine(): Promise<void> {
  if (engine) return;

  const pluginsDir = join(app.getPath('userData'), 'plugins');
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

  engine = await Drasi.create('trading', {});

  // Plugins are downloaded from the OCI registry at startup, never baked in.
  await ensurePlugins(engine, pluginsDir);
  await engine.start();

  // Real Postgres CDC source (+ postgres bootstrap for the initial snapshot).
  await waitForPort(PG_CONFIG.host, PG_CONFIG.port);
  await engine.addSource('postgres', SOURCE_POSTGRES, PG_CONFIG, true, {
    kind: 'postgres',
    config: PG_CONFIG,
  });

  // In-process price feed as a JavaScript-defined source.
  await engine.addJsSource(SOURCE_PRICES);

  // Queries with synthetic joins; one application reaction per query streams
  // live result diffs to the renderer.
  for (const q of QUERIES) {
    await engine.addQuery(q.id, q.query, q.sources, 'cypher', q.joins);
    await engine.addJsReaction(`__ui__${q.id}`, [q.id], (result: unknown) => {
      forwarder?.({ queryId: q.id, result: result as QueryResultEvent });
    });
  }

  const seedFile = join(app.getAppPath(), 'data', 'initial-prices.json');
  priceFeed = new PriceFeed(engine, seedFile);
  await priceFeed.start();
}

export async function shutdown(): Promise<void> {
  priceFeed?.stop();
  priceFeed = null;
  if (engine) {
    try {
      await engine.close();
    } catch {
      // best-effort
    }
    engine = null;
  }
}
