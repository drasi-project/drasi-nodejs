// EngineHost: owns the single embedded @drasi/lib instance and wires up the
// Curbside Pickup topology across TWO databases:
//   PostgreSQL orders   (retail-ops)  ─┐
//   MySQL vehicles      (physical-ops) ─┤→ 6 queries (+ cross-source PICKUP_BY
//                                        │   join, + temporal drasi.trueFor)
//                                        └→ SSE reaction (Handlebars routes)

import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { QUERIES } from '../queries.mjs';
import { buildSseRoutes, SSE_PORT } from './streams.mjs';

const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib');

const env = process.env;

// PostgreSQL (Retail Operations / orders). Matches database/docker-compose.yml
// + database/postgres-init.sql. The slot is created by the source on connect.
const PG_CONFIG = {
  host: env.POSTGRES_HOST || 'localhost',
  port: Number(env.POSTGRES_PORT || 5742),
  database: env.POSTGRES_DATABASE || 'RetailOperations',
  user: env.POSTGRES_USER || 'drasi_user',
  password: env.POSTGRES_PASSWORD || 'drasi_password',
  sslMode: 'prefer',
  tables: ['orders'],
  slotName: 'drasi_curbside_slot',
  publicationName: 'drasi_curbside_pub',
  tableKeys: [{ table: 'orders', keyColumns: ['id'] }],
};

// MySQL (Physical Operations / vehicles). The tutorial container has no TLS, so
// the source connects with sslMode 'disabled'. The MySQL bootstrap provider
// takes its own connection block (and does not accept sslMode).
const MYSQL_CONFIG = {
  host: env.MYSQL_HOST || 'localhost',
  port: Number(env.MYSQL_PORT || 3309),
  database: env.MYSQL_DATABASE || 'PhysicalOperations',
  user: env.MYSQL_USER || 'drasi_user',
  password: env.MYSQL_PASSWORD || 'drasi_password',
  sslMode: 'disabled',
  tables: ['vehicles'],
  tableKeys: [{ table: 'vehicles', keyColumns: ['plate'] }],
};

const MYSQL_BOOTSTRAP = {
  kind: 'mysql',
  config: {
    host: MYSQL_CONFIG.host,
    port: MYSQL_CONFIG.port,
    database: MYSQL_CONFIG.database,
    user: MYSQL_CONFIG.user,
    password: MYSQL_CONFIG.password,
    tables: ['vehicles'],
    tableKeys: [{ table: 'vehicles', keyColumns: ['plate'] }],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve when a TCP port accepts a connection, or throw after `attempts`. */
async function waitForPort(host, port, label, attempts = 90) {
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
    `${label} is not reachable at ${host}:${port}. Start the databases first with ` +
      '`npm run db:up` (requires Docker; MySQL can take ~30s to become ready).',
  );
}

/**
 * Create the engine, download plugins, build both sources + the six queries +
 * the SSE reaction, and return the running engine.
 */
export async function createEngine(ensurePlugins) {
  const pluginsDir = join(process.cwd(), '.drasi-plugins', `${process.platform}-${process.arch}`);
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

  const engine = await Drasi.create('curbside-pickup', {});
  await ensurePlugins(engine, pluginsDir);
  await engine.start();

  // Wait for both databases, then add both CDC sources.
  await waitForPort(PG_CONFIG.host, PG_CONFIG.port, 'PostgreSQL');
  await waitForPort(MYSQL_CONFIG.host, MYSQL_CONFIG.port, 'MySQL');

  await engine.addSource('postgres', 'retail-ops', PG_CONFIG, true, {
    kind: 'postgres',
    config: PG_CONFIG,
  });
  await engine.addSource('mysql', 'physical-ops', MYSQL_CONFIG, true, MYSQL_BOOTSTRAP);

  // Register the six continuous queries (with the cross-source PICKUP_BY join
  // and the temporal drasi.trueFor delay query).
  for (const q of QUERIES) {
    await engine.addQuery(q.id, q.query, q.sources, 'cypher', q.joins);
  }

  // The SSE reaction streams each query's changes to the browser, shaped by the
  // Handlebars templates built in ./streams.mjs.
  const routes = buildSseRoutes();
  await engine.addReaction('sse', 'curbside-sse', Object.keys(routes), {
    host: '0.0.0.0',
    port: SSE_PORT,
    ssePath: '/events',
    heartbeatIntervalMs: 15000,
    routes,
  });

  return engine;
}

export { PG_CONFIG, MYSQL_CONFIG };
