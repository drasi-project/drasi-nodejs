// Building Comfort — entrypoint.
//
// A single Node process that:
//   1. embeds the Drasi engine (@drasi/lib) and builds the Postgres CDC source,
//      the six continuous queries, and the SSE reaction (kind: sse);
//   2. serves a static web UI, an initial-state snapshot, and a same-origin
//      proxy in front of the SSE reaction's Server-Sent Events streams; and
//   3. exposes small control endpoints the UI uses to change room readings
//      (which it does by writing to PostgreSQL, so Drasi reacts through CDC).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

import { createEngine } from './engine.mjs';
import { ensurePlugins } from './plugins.mjs';
import { createSimulator } from './simulate.mjs';
import { STREAMS, SSE_PORT, reshapeRow } from './streams.mjs';
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

// SSE route paths the browser is allowed to subscribe to (from the contract).
const SSE_PATHS = new Set(STREAMS.map((s) => s.path));

async function main() {
  console.log('Starting Building Comfort…');
  console.log('  • creating engine, downloading plugins, wiring the SSE reaction (first run ~30s)…');
  const engine = await createEngine(ensurePlugins);

  const simulator = createSimulator();
  const app = express();
  app.use(express.json());

  // --- Initial state -------------------------------------------------------
  // The SSE reaction only streams changes from the moment a client connects, so
  // the browser seeds itself from this snapshot (shaped to the same contract as
  // the streamed changes) and then applies live deltas on top.
  app.get('/api/state', async (_req, res) => {
    try {
      const state = {};
      for (const s of STREAMS) {
        const rows = await engine.getQueryResults(s.query);
        state[s.path] = rows.map((r) => reshapeRow(s.fields, r));
      }
      res.json(state);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- SSE proxy -----------------------------------------------------------
  // The SSE reaction listens on its own port; we reverse-proxy each of its
  // routes under /sse/<path> so the browser talks to a single origin (and only
  // one port needs forwarding in Codespaces / dev containers). We use 127.0.0.1
  // (not "localhost") so the upstream fetch always hits the reaction's IPv4
  // listener, and we defend against the browser disconnecting mid-stream so a
  // dropped client can never take the server down.
  app.get('/sse/:path', async (req, res) => {
    const { path } = req.params;
    if (!SSE_PATHS.has(path)) return res.status(404).end();

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on('close', abort);
    res.on('error', abort);
    try {
      const upstream = await fetch(`http://127.0.0.1:${SSE_PORT}/${path}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      res.writeHead(upstream.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Flush headers immediately so the browser's EventSource opens right away
      // (and buffering proxies release the response) even before the first event.
      res.write(': connected\n\n');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || res.writableEnded || res.destroyed) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[sse-proxy]', err.message);
    } finally {
      abort();
      if (!res.writableEnded) res.end();
    }
  });

  // A dropped SSE client (or a transient reaction hiccup) must never crash the
  // whole app. Log and keep serving.
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

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
      res.json({ room });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/rooms/:id/reset', async (req, res) => {
    try {
      const room = await resetRoom(req.params.id);
      res.json({ room });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reset', async (_req, res) => {
    try {
      const count = await resetAll();
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
