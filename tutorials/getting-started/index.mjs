// Getting Started — a Drasi console app in one file.
//
// This single file embeds the Drasi engine (@drasi/lib), connects it to a live
// PostgreSQL "Message" feed and an HTTP source, runs five continuous queries,
// and prints every change to the console with a JavaScript reaction — the
// embedded-library equivalent of Drasi's Log Reaction.
//
// You drive changes from another terminal: `psql` for messages (a plain SQL
// INSERT/UPDATE/DELETE) and `curl` for location updates (a small JSON POST to
// the HTTP source). Drasi observes each change through CDC / the webhook and the
// reaction prints the resulting additions, updates, and deletions here.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';

const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib');

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// PostgreSQL connection — matches database/docker-compose.yml + database/init.sql.
const PG = {
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

const HTTP_SOURCE_PORT = Number(env.HTTP_SOURCE_PORT || 9000);
const LOCATIONS_FILE = join(__dirname, 'locations.jsonl');
// The database container name (database/docker-compose.yml) — used only to print
// an example command in the startup hint.
const PG_CONTAINER = env.POSTGRES_CONTAINER || 'getting-started-nodejs-postgres';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve when a TCP port accepts a connection, or throw after `attempts`. */
async function waitForPort(host, port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const socket = createConnection({ host, port });
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => (socket.destroy(), resolve(false)));
    });
    if (ok) return;
    await sleep(1000);
  }
  throw new Error(`PostgreSQL is not reachable at ${host}:${port}. Start it with 'npm run db:up'.`);
}

/** Print one query-result change, mirroring Drasi's Log Reaction output. */
function printChange(event) {
  const diffs = (event.results || []).filter((d) => d.type !== 'noop');
  if (diffs.length === 0) return;
  const j = (v) => JSON.stringify(v);
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

  const engine = await Drasi.create('getting-started', {});

  // 1. Download the plugins this tutorial needs and register them. installPlugin
  //    resolves each reference to the build that is compatible with this addon
  //    and made for the current platform — no version tags, architecture
  //    suffixes, or filenames to work out. They're placed in a temp directory.
  const pluginsDir = mkdtempSync(join(tmpdir(), 'drasi-plugins-'));
  await engine.installPlugin('source/postgres', pluginsDir);
  await engine.installPlugin('bootstrap/postgres', pluginsDir);
  await engine.installPlugin('source/http', pluginsDir);
  await engine.installPlugin('bootstrap/scriptfile', pluginsDir);
  await engine.loadPlugins(pluginsDir);

  await engine.start();

  // 2a. PostgreSQL source: streams `Message` changes via logical replication.
  await waitForPort(PG.host, PG.port);
  await engine.addSource('postgres', 'messages', PG, true, { kind: 'postgres', config: PG });

  // 2b. HTTP source: receives `UserLocation` updates and bootstraps from a file.
  //     A custom webhook route accepts a flat { name, location, status } POST at
  //     /locations and shapes it into a UserLocation node with a Handlebars
  //     template — so callers send friendly JSON instead of the raw event format.
  await engine.addSource('http', 'location-tracker', {
    host: '0.0.0.0',
    port: HTTP_SOURCE_PORT,
    webhooks: {
      routes: [
        {
          path: '/locations',
          methods: ['POST'],
          mappings: [
            {
              operation: 'update',
              elementType: 'node',
              template: {
                id: '{{payload.name}}',
                labels: ['UserLocation'],
                properties: {
                  name: '{{payload.name}}',
                  location: '{{payload.location}}',
                  status: '{{payload.status}}',
                },
              },
            },
          ],
        },
      ],
    },
  }, true, { kind: 'scriptfile', config: { filePaths: [LOCATIONS_FILE] } });

  // 3. The five continuous queries, each declared explicitly.

  // Change detection: every message, passed through unchanged.
  await engine.addQuery('all-messages', `
    MATCH (m:Message)
    RETURN m.MessageId AS MessageId, m.From AS From, m.Message AS Message
  `, ['messages'], 'cypher');

  // Filter: only messages whose text is exactly 'Hello World'.
  await engine.addQuery('hello-world-senders', `
    MATCH (m:Message)
    WHERE m.Message = 'Hello World'
    RETURN m.MessageId AS Id, m.From AS Sender
  `, ['messages'], 'cypher');

  // Aggregation: how many times each unique message text has been sent.
  await engine.addQuery('message-counts', `
    MATCH (m:Message)
    RETURN m.Message AS MessageText, count(m) AS Count
  `, ['messages'], 'cypher');

  // Time / absence of change: senders idle > 20s. drasi.trueLater schedules a
  // future re-evaluation so idle senders appear even when no new data arrives.
  await engine.addQuery('inactive-senders', `
    MATCH (m:Message)
    WITH m.From AS MessageFrom, max(drasi.changeDateTime(m)) AS LastMessageTimestamp
    WHERE LastMessageTimestamp <= datetime.realtime() - duration({ seconds: 20 })
       OR drasi.trueLater(
            LastMessageTimestamp <= datetime.realtime() - duration({ seconds: 20 }),
            LastMessageTimestamp + duration({ seconds: 20 }))
    RETURN MessageFrom, LastMessageTimestamp
  `, ['messages'], 'cypher');

  // Cross-source join: messages joined with their sender's live location. The
  // PostgreSQL source is listed first (see drasi-project/drasi-core#682), and the
  // virtual FROM_USER relationship connects Message.From to UserLocation.name.
  await engine.addQuery('messages-with-location', `
    MATCH (m:Message)-[:FROM_USER]->(u:UserLocation)
    RETURN m.MessageId AS Id, m.Message AS Message,
           m.From AS Sender, u.location AS Location, u.status AS Status
  `, ['messages', 'location-tracker'], 'cypher', [
    {
      id: 'FROM_USER',
      keys: [
        { label: 'Message', property: 'From' },
        { label: 'UserLocation', property: 'name' },
      ],
    },
  ]);

  // 4. One JavaScript reaction, subscribed to every query, that prints changes.
  await engine.addJsReaction('console', [
    'all-messages',
    'hello-world-senders',
    'message-counts',
    'inactive-senders',
    'messages-with-location',
  ], printChange);

  console.log('\n✅ Getting Started is ready — Drasi is watching for changes.\n');
  console.log('   Drive changes from a second terminal and watch them print here. For example,');
  console.log('   insert a message (the tutorial walks through the rest):');
  console.log(`     docker exec ${PG_CONTAINER} psql -U ${PG.user} -d ${PG.database} \\`);
  console.log(`       -c "INSERT INTO \\"Message\\" (\\"From\\", \\"Message\\") VALUES ('You', 'Hello');"`);
  console.log('\n   Press Ctrl+C to stop.\n');

  // Keep the process alive so the engine keeps streaming until Ctrl+C. The engine
  // runs on its own native threads, which don't by themselves keep Node's event
  // loop alive, so we hold it open with a timer.
  setInterval(() => {}, 1 << 30);

  async function shutdown(signal) {
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
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
}

main().catch((err) => {
  console.error('\nFailed to start Getting Started:\n', err);
  process.exit(1);
});
