// Getting Started — a console app built on @drasi/lib.
//
// One Node process that:
//   1. embeds the Drasi engine and downloads the plugins it needs;
//   2. connects a PostgreSQL CDC source over the `Message` table, and an HTTP
//      source that receives `UserLocation` updates (bootstrapped from a file);
//   3. runs five continuous queries (change detection, a filter, an
//      aggregation, a time-based/absence-of-change query, and a cross-source
//      join); and
//   4. registers ONE JavaScript reaction that prints every query-result change
//      to the console — the embedded-library equivalent of Drasi's Log Reaction.
//
// You drive changes from another terminal: `psql` for messages (helper scripts
// in scripts/) and `curl` for location updates (POST to the HTTP source). Drasi
// observes each change through CDC / the HTTP endpoint and the reaction prints
// the resulting additions, updates, and deletions here in real time.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';

import { ensurePlugins } from './plugins.mjs';
import { QUERIES, QUERY_IDS, SOURCE_MESSAGES, SOURCE_LOCATIONS } from '../queries.mjs';

const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const env = process.env;

// PostgreSQL connection — matches database/docker-compose.yml + database/init.sql.
const PG_CONFIG = {
  host: env.POSTGRES_HOST || 'localhost',
  port: Number(env.POSTGRES_PORT || 5632),
  database: env.POSTGRES_DATABASE || 'getting_started',
  user: env.POSTGRES_USER || 'drasi_user',
  password: env.POSTGRES_PASSWORD || 'drasi_password',
  sslMode: 'prefer',
  tables: ['Message'],
  slotName: 'drasi_getting_started_slot',
  publicationName: 'drasi_getting_started_pub',
  tableKeys: [{ table: 'Message', keyColumns: ['MessageId'] }],
};

// The HTTP source listens here for UserLocation events (POST /sources/<id>/events).
const HTTP_SOURCE_PORT = Number(env.HTTP_SOURCE_PORT || 9000);
const LOCATIONS_FILE = join(ROOT, 'locations.jsonl');

// The database container name (from database/docker-compose.yml) — used only to
// print an example `docker exec` command in the startup hint.
const PG_CONTAINER = env.POSTGRES_CONTAINER || 'getting-started-nodejs-postgres';

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

// ---------- The console reaction ----------
const j = (v) => JSON.stringify(v);

/** Print one query-result change, mirroring Drasi's Log Reaction output. */
function printChange(event) {
  const diffs = (event.results || []).filter((d) => d.type !== 'noop');
  if (diffs.length === 0) return;
  console.log(`[drasi] Query '${event.query_id}' (${diffs.length} change${diffs.length === 1 ? '' : 's'}):`);
  for (const d of diffs) {
    switch (d.type) {
      case 'ADD':
        console.log(`  [ADD]    ${j(d.data)}`);
        break;
      case 'DELETE':
        console.log(`  [DELETE] ${j(d.data)}`);
        break;
      case 'UPDATE':
      case 'aggregation':
        console.log(`  [UPDATE] ${j(d.before)} -> ${j(d.after)}`);
        break;
      default:
        console.log(`  [${d.type}] ${j(d.data ?? d.after ?? d.before)}`);
    }
  }
}

async function main() {
  console.log('Starting Getting Started…');
  console.log('  • creating the engine, downloading plugins, connecting to PostgreSQL + the HTTP source…');
  console.log('    (first run may take ~30s while plugins download)');

  // Cache downloaded plugins in a platform-specific dir so a macOS .dylib and a
  // Linux .so never collide in the same folder (e.g. a repo mounted into a
  // container). The directory is gitignored.
  const pluginsDir = join(ROOT, '.drasi-plugins', `${process.platform}-${process.arch}`);
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });

  const engine = await Drasi.create('getting-started', {});
  await ensurePlugins(engine, pluginsDir);
  await engine.start();

  // 1. Sources. The PostgreSQL source streams Message changes via logical
  //    replication; the HTTP source receives UserLocation events and loads its
  //    initial data from locations.jsonl via the scriptfile bootstrap provider.
  await waitForPort(PG_CONFIG.host, PG_CONFIG.port);
  await engine.addSource('postgres', SOURCE_MESSAGES, PG_CONFIG, true, {
    kind: 'postgres',
    config: PG_CONFIG,
  });
  await engine.addSource(
    'http',
    SOURCE_LOCATIONS,
    { host: '0.0.0.0', port: HTTP_SOURCE_PORT },
    true,
    { kind: 'scriptfile', config: { filePaths: [LOCATIONS_FILE] } },
  );

  // 2. The five continuous queries.
  for (const q of QUERIES) {
    await engine.addQuery(q.id, q.query, q.sources, 'cypher', q.joins);
  }

  // 3. One JavaScript reaction, subscribed to every query, that prints changes.
  await engine.addJsReaction('console', QUERY_IDS, printChange);

  console.log('\n✅ Getting Started is ready — Drasi is watching for changes.\n');
  console.log('   Drive changes from a second terminal and watch them print here. For example,');
  console.log('   insert a message (the tutorial walks through the rest):');
  console.log(`     docker exec ${PG_CONTAINER} psql -U ${PG_CONFIG.user} -d ${PG_CONFIG.database} \\`);
  console.log(`       -c "INSERT INTO \\"Message\\" (\\"From\\", \\"Message\\") VALUES ('You', 'Hello');"`);
  console.log('\n   Press Ctrl+C to stop.\n');

  // --- Graceful shutdown ---
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — shutting down…`);
    try {
      await engine.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A dropped connection or transient hiccup must not crash the app.
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

  // Keep the process alive so the engine keeps streaming until Ctrl+C. The
  // engine runs on its own native threads, which don't by themselves keep
  // Node's event loop alive, so we hold it open with a timer. (A no-op keeps
  // the app running whether it's launched in a terminal, backgrounded, or in a
  // container without a TTY.)
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error('\nFailed to start Getting Started:\n', err);
  process.exit(1);
});
