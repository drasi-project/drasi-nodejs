// EngineHost: owns the single embedded @drasi/lib instance and wires up the
// Building Comfort topology:
//   real Postgres CDC source (+ bootstrap)  ->  synthetic joins  ->  6 queries
// Query result changes are shaped into SSE payloads by ./reaction.mjs.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { QUERIES, SOURCE_ID } from '../queries.mjs';

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
  // Cache plugins in a platform-specific subdirectory. The tutorial folder is
  // often mounted into a dev container, so a Linux (.so) and a macOS (.dylib)
  // build of the same plugin can otherwise land in one directory — which the
  // plugin loader rejects as ambiguous. Keying by platform+arch keeps each
  // host's binaries separate.
  const pluginsDir = join(process.cwd(), '.drasi-plugins', `${process.platform}-${process.arch}`);
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

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

  return engine;
}

export { PG_CONFIG };
