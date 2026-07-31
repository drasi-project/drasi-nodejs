// Building Comfort — entrypoint.
//
// A single Node process that:
//   1. embeds the Drasi engine (@drasi/lib) and builds the Postgres CDC source,
//      the six continuous queries, and the SSE reaction (kind: sse);
//   2. serves a static web UI, an initial-state snapshot, and a single
//      same-origin "/events" stream that multiplexes the SSE reaction's routes;
//      and
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
// When WEB_HOST is unset we let Node bind on `::` (all interfaces, dual-stack),
// so the app is reachable via both IPv4 and IPv6 localhost. Port forwarders
// (VS Code dev containers, Codespaces) sometimes connect over IPv6 `::1`, and an
// IPv4-only `0.0.0.0` bind would silently fail to forward.
const HOST = process.env.WEB_HOST || undefined;

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

  // --- SSE fan-in: one client stream multiplexes every reaction route ------
  // The SSE reaction serves each query on its own route. If the browser opened
  // one EventSource per route, those long-lived connections would eat into the
  // browser's ~6-connections-per-host HTTP/1.1 limit and could starve the
  // control fetch()es. Instead the app opens all upstream routes itself — Node
  // has no such per-host limit — and merges them into a SINGLE same-origin
  // "/events" stream, tagging each event with its path. This also means only
  // one port needs forwarding in Codespaces / dev containers.
  app.get('/events', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately so the browser's EventSource opens right away.
    res.write(': connected\n\n');

    const controller = new AbortController();
    // A comment "ping" keeps the connection warm through idle proxy timeouts.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);

    // Fan in every reaction route; forward each event tagged with its path.
    await Promise.all(
      STREAMS.map(async ({ path }) => {
        try {
          const upstream = await fetch(`http://127.0.0.1:${SSE_PORT}/${path}`, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done || res.writableEnded) break;
            buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
            // Re-frame each complete SSE event, re-tagged with its stream path.
            let sep;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const data = frame
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).replace(/^ /, ''))
                .join('\n');
              if (data && !res.writableEnded) {
                res.write(`data: {"path":${JSON.stringify(path)},"msg":${data}}\n\n`);
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') console.error('[sse-mux]', path, err.message);
        }
      }),
    );
    cleanup();
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

  const onReady = () =>
    console.log(`\n✅ Building Comfort is ready — open http://localhost:${PORT}\n`);
  // Omit the host entirely when unset so Node binds dual-stack (IPv4 + IPv6).
  const server = HOST ? app.listen(PORT, HOST, onReady) : app.listen(PORT, onReady);

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
