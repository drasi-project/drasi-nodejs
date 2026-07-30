// Building Comfort — entrypoint.
//
// A single Node process that:
//   1. embeds the Drasi engine (@drasi/lib) and builds the Postgres CDC source,
//      the six continuous queries, and the SSE reaction;
//   2. serves a static web UI plus a Server-Sent Events stream of the shaped
//      query snapshot; and
//   3. exposes small control endpoints the UI uses to change room readings
//      (which it does by writing to PostgreSQL, so Drasi reacts through CDC).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

import { createEngine } from './engine.mjs';
import { ensurePlugins } from './plugins.mjs';
import { createSseHub } from './reaction.mjs';
import { createSimulator } from './simulate.mjs';
import {
  listRooms,
  setRoom,
  resetRoom,
  resetAll,
  closeDb,
  COMFORTABLE,
  BROKEN,
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.WEB_PORT || 3000);
const HOST = process.env.WEB_HOST || '0.0.0.0';

async function main() {
  console.log('Starting Building Comfort…');
  console.log('  • creating engine and downloading plugins (first run may take ~30s)…');
  const engine = await createEngine(ensurePlugins);

  console.log('  • wiring the SSE reaction (Handlebars → JSON)…');
  const hub = await createSseHub(engine);

  const simulator = createSimulator();
  const app = express();
  app.use(express.json());

  // --- SSE stream of the shaped snapshot -----------------------------------
  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    hub.addClient(res);
  });

  // --- Control API: the UI writes to Postgres via these -------------------
  app.get('/api/rooms', async (_req, res) => {
    try {
      res.json({ rooms: await listRooms(), presets: { COMFORTABLE, BROKEN } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rooms/:id', async (req, res) => {
    try {
      const room = await setRoom(req.params.id, req.body || {});
      hub.refresh();
      res.json({ room });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/rooms/:id/reset', async (req, res) => {
    try {
      const room = await resetRoom(req.params.id);
      hub.refresh();
      res.json({ room });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reset', async (_req, res) => {
    try {
      const count = await resetAll();
      hub.refresh();
      res.json({ reset: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Simulation toggle ---------------------------------------------------
  app.get('/api/simulate', (_req, res) => res.json({ running: simulator.isRunning() }));

  app.post('/api/simulate', async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      if (enabled) await simulator.start();
      else simulator.stop();
      res.json({ running: simulator.isRunning() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(express.static(PUBLIC_DIR));

  const server = app.listen(PORT, HOST, () => {
    console.log(`\n✅ Building Comfort is ready — open http://localhost:${PORT}\n`);
  });

  // --- Graceful shutdown ---------------------------------------------------
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — shutting down…`);
    simulator.stop();
    server.close();
    try {
      await engine.close();
    } catch {
      /* best-effort */
    }
    await closeDb().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('\nFailed to start Building Comfort:\n', err);
  process.exit(1);
});
