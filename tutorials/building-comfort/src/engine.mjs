// EngineHost: owns the single embedded @drasi/lib instance and wires up the
// Building Comfort topology:
//   real Postgres CDC source (+ bootstrap)  ->  synthetic joins  ->  6 queries
//   ->  SSE reaction (shapes changes with Handlebars, streams them over SSE)

import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { QUERIES, SOURCE_ID } from '../queries.mjs';
import { buildSseRoutes, SSE_PORT } from './streams.mjs';

// Resolve @drasi/lib whether the tutorial runs against the published package
// (npm install) or the local repo checkout (npm link / workspace).
const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib');

// Connection details match database/docker-compose.yml + database/init.sql,
// with environment-variable overrides so the dev container can retarget them.
const env = process.env;
const PG_CONFIG = {
  host: env.POSTGRES_HOST || 'localhost',
  port: Number(env.POSTGRES_PORT || 5732),
  database: env.POSTGRES_DATABASE || 'building_comfort',
  user: env.POSTGRES_USER || 'drasi_user',
  password: env.POSTGRES_PASSWORD || 'drasi_password',
  sslMode: 'prefer',
  tables: ['Building', 'Floor', 'Room'],
  slotName: 'drasi_building_comfort_slot',
  publicationName: 'drasi_building_comfort_pub',
  tableKeys: [
    { table: 'Building', keyColumns: ['id'] },
    { table: 'Floor', keyColumns: ['id'] },
    { table: 'Room', keyColumns: ['id'] },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve when a TCP port accepts a connection, or throw after `attempts`. */
async function waitForPort(host, port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
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
    `PostgreSQL is not reachable at ${host}:${port}. Start it first with ` +
      '`npm run db:up` (requires Docker).',
  );
}

/**
 * Create the engine, download plugins, build the source + queries, and return
 * the running engine instance. Plugin registration is provided by the caller so
 * this module stays focused on topology.
 */
export async function createEngine(ensurePlugins) {
  // Download plugins into a fresh temp directory each run. installPlugin fetches
  // the build for this platform, so there's no arch handling or shared-folder
  // ambiguity to manage.
  const pluginsDir = mkdtempSync(join(tmpdir(), 'drasi-plugins-'));

  const engine = await Drasi.create('building-comfort', {});

  // Plugins are downloaded from the OCI registry at startup, never baked in.
  await ensurePlugins(engine, pluginsDir);
  await engine.start();

  // Real Postgres CDC source (+ postgres bootstrap for the initial snapshot).
  await waitForPort(PG_CONFIG.host, PG_CONFIG.port);
  await engine.addSource('postgres', SOURCE_ID, PG_CONFIG, true, {
    kind: 'postgres',
    config: PG_CONFIG,
  });

  // Register the six continuous queries with their synthetic joins.
  for (const q of QUERIES) {
    await engine.addQuery(q.id, q.query, q.sources, 'cypher', q.joins);
  }

  // The SSE reaction (kind: sse) streams each query's result changes to the
  // browser over Server-Sent Events. Its `routes` carry Handlebars templates
  // (built in ./streams.mjs) that SHAPE each changed row into our JSON contract
  // before it is sent — no bespoke reaction code required. The reaction listens
  // on its own port; the app proxies it same-origin (see src/index.mjs).
  const routes = buildSseRoutes();
  await engine.addReaction('sse', 'building-comfort-sse', Object.keys(routes), {
    host: '0.0.0.0',
    port: SSE_PORT,
    ssePath: '/events',
    heartbeatIntervalMs: 15000,
    routes,
  });

  return engine;
}

export { PG_CONFIG };
