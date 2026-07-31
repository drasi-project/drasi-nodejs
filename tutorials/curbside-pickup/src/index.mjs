// Curbside Pickup — entrypoint.
//
// A single Node process that:
//   1. embeds the Drasi engine (@drasi/lib) over TWO databases (PostgreSQL
//      orders + MySQL vehicles), six continuous queries, and the SSE reaction;
//   2. serves one integrated web UI, an initial-state snapshot, and a single
//      same-origin "/events" stream that multiplexes the SSE reaction's routes;
//      and
//   3. exposes control endpoints the UI uses to toggle orders and vehicles
//      (writing to the two databases, so Drasi reacts through CDC).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

import { createEngine } from './engine.mjs';
import { ensurePlugins } from './plugins.mjs';
import { STREAMS, SSE_PORT, reshapeRow } from './streams.mjs';
import { toggleOrder, toggleVehicle, resetAll, getLog, closeDb } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.WEB_PORT || 3000);
// Omit the host when unset so Node binds dual-stack (IPv4 + IPv6); port
// forwarders (VS Code dev containers / Codespaces) may connect over IPv6.
const HOST = process.env.WEB_HOST || undefined;

async function main() {
  console.log('Starting Curbside Pickup…');
  console.log('  • creating engine, downloading plugins, connecting to PostgreSQL + MySQL, wiring the SSE reaction…');
  console.log('    (first run may take ~30s; MySQL can be slow to become ready)');
  const engine = await createEngine(ensurePlugins);

  const app = express();
  app.use(express.json());

  // --- Initial state -------------------------------------------------------
  // The SSE reaction only streams changes from connect time, so the browser
  // seeds itself from this snapshot (shaped to the same contract) plus the log.
  app.get('/api/state', async (_req, res) => {
    try {
      const streams = {};
      for (const s of STREAMS) {
        const rows = await engine.getQueryResults(s.query);
        streams[s.path] = rows.map((r) => reshapeRow(s.fields, r));
      }
      res.json({ streams, log: getLog() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/log', (_req, res) => res.json({ log: getLog() }));

  // --- SSE fan-in: one client stream multiplexes every reaction route ------
  // The SSE reaction serves each query on its own route. If the browser opened
  // one EventSource per route, the six long-lived connections would hit the
  // browser's ~6-connections-per-host HTTP/1.1 limit and starve the control
  // fetch()es (they would queue forever). Instead the app opens all upstream
  // routes itself — Node has no such per-host limit — and merges them into a
  // SINGLE same-origin "/events" stream, tagging each event with its path. This
  // also means only one port needs forwarding in Codespaces / dev containers.
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

  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

  // --- Control API: the UI writes to the two databases via these ----------
  app.post('/api/orders/:id/toggle', async (req, res) => {
    try {
      const order = await toggleOrder(req.params.id);
      res.json({ order, log: getLog() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/vehicles/:plate/toggle', async (req, res) => {
    try {
      const vehicle = await toggleVehicle(req.params.plate);
      res.json({ vehicle, log: getLog() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reset', async (_req, res) => {
    try {
      await resetAll();
      res.json({ ok: true, log: getLog() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(express.static(PUBLIC_DIR));

  const onReady = () =>
    console.log(`\n✅ Curbside Pickup is ready — open http://localhost:${PORT}\n`);
  const server = HOST ? app.listen(PORT, HOST, onReady) : app.listen(PORT, onReady);

  // --- Graceful shutdown ---------------------------------------------------
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — shutting down…`);
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
  console.error('\nFailed to start Curbside Pickup:\n', err);
  process.exit(1);
});
