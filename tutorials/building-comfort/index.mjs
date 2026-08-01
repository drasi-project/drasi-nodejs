// Building Comfort — a Drasi app in one file.
//
// A single Node process that:
//   1. embeds the Drasi engine (@drasi/lib): a PostgreSQL CDC source, six
//      continuous queries (with synthetic Room -> Floor -> Building joins), and
//      an SSE reaction whose Handlebars templates shape each changed row; then
//   2. serves the web UI in public/, an initial-state snapshot (/api/state), and
//      a single same-origin /events stream that fans in the reaction's routes; and
//   3. exposes small control endpoints the UI uses to change room readings by
//      writing to PostgreSQL — so Drasi reacts through CDC, with no call into it.
//
// Change a room from the UI (or turn on Simulate) and every panel updates: the
// app never pushes UI state; Drasi observes the database change through logical
// replication and the SSE reaction re-shapes and streams it.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';
import express from 'express';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const env = process.env;

// Ports: the web UI, and the SSE reaction's own listener (fanned in at /events).
const WEB_PORT = Number(env.WEB_PORT || 3000);
const SSE_PORT = Number(env.SSE_PORT || 8081);
// When WEB_HOST is unset, Node binds dual-stack (IPv4 + IPv6) so port forwarders
// (dev containers, Codespaces) can reach it over either localhost.
const WEB_HOST = env.WEB_HOST || undefined;

// PostgreSQL connection — matches database/docker-compose.yml + database/init.sql.
const PG = {
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

// A room's comfort level: 40–50 is comfortable, below is too cold, above too hot.
// Reused verbatim by every query so they all compute it identically. The seed
// values (70 / 40 / 10) give floor(50 + (70-72) + (40-42) + 0) = 46.
const COMFORT =
  'floor( 50 + (r.temperature - 72) + (r.humidity - 42) + CASE WHEN r.co2 > 500 THEN (r.co2 - 500) / 25 ELSE 0 END )';

// The UI's Reset returns a room to these comfortable defaults; Break applies the
// "broken" preset (too cold / dry / high-CO2, comfort well outside the band).
const COMFORTABLE = { temperature: 70, humidity: 40, co2: 10 };
const BROKEN = { temperature: 40, humidity: 20, co2: 700 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The row shape each query's changes are published in — the contract the browser
// renders. Each entry maps an output field to the query column it comes from. The
// same shapes drive both the SSE reaction's Handlebars templates and the initial
// /api/state snapshot, so the browser sees an identical shape either way.
const ROOM_SHAPE = {
  id: 'RoomId', name: 'RoomName', floorId: 'FloorId', floor: 'FloorName',
  buildingName: 'BuildingName', comfort: 'ComfortLevel',
  temperature: 'Temperature', humidity: 'Humidity', co2: 'CO2',
};
const FLOOR_COMFORT_SHAPE = { id: 'FloorId', comfort: 'ComfortLevel' };
const BUILDING_SHAPE = { id: 'BuildingId', comfort: 'ComfortLevel' };
const ROOM_ALERT_SHAPE = { id: 'RoomId', name: 'RoomName', comfort: 'ComfortLevel' };
const FLOOR_ALERT_SHAPE = { id: 'FloorId', name: 'FloorName', comfort: 'ComfortLevel' };

// ---------------------------------------------------------------------------
// PostgreSQL control layer
// ---------------------------------------------------------------------------
// The UI changes room readings by writing straight to the database — exactly what
// an existing building-management app would do. There is no call into Drasi: the
// engine observes each row change through CDC and re-evaluates the queries itself.

const pool = new pg.Pool({
  host: PG.host, port: PG.port, database: PG.database,
  user: PG.user, password: PG.password, max: 4,
});

const ROOM_ID_RE = /^[A-Za-z0-9_]+$/;

function assertInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer (got '${value}')`);
  return n;
}

/** Set one room's temperature / humidity / co2. Returns the updated row. */
async function setRoom(id, { temperature, humidity, co2 }) {
  if (typeof id !== 'string' || !ROOM_ID_RE.test(id)) {
    throw new Error(`invalid room id '${id}' (expected letters, digits, underscores)`);
  }
  const t = assertInt('temperature', temperature);
  const h = assertInt('humidity', humidity);
  const c = assertInt('co2', co2);
  const { rows } = await pool.query(
    'UPDATE "Room" SET temperature = $1, humidity = $2, co2 = $3 WHERE id = $4 ' +
      'RETURNING id, name, temperature, humidity, co2',
    [t, h, c, id],
  );
  if (rows.length === 0) throw new Error(`no room with id '${id}'`);
  return rows[0];
}

/** All rooms with their current readings, ordered by id. */
async function listRooms() {
  const { rows } = await pool.query(
    'SELECT id, name, temperature, humidity, co2, floor_id FROM "Room" ORDER BY id',
  );
  return rows;
}

/** Reset every room to comfortable defaults. Returns the number of rooms. */
async function resetAll() {
  const { rowCount } = await pool.query(
    'UPDATE "Room" SET temperature = $1, humidity = $2, co2 = $3',
    [COMFORTABLE.temperature, COMFORTABLE.humidity, COMFORTABLE.co2],
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------
// When enabled it picks a random room every few seconds and assigns new random
// readings that straddle the comfortable band, so comfort levels rise and fall
// and alerts come and go on their own. Each tick is just another database write.
function createSimulator(intervalMs = 3000) {
  let timer = null;
  let roomIds = [];
  const randomReadings = () => ({
    temperature: 55 + Math.floor(Math.random() * 31), // 55–85
    humidity: 20 + Math.floor(Math.random() * 36), //    20–55
    co2: 5 + Math.floor(Math.random() * 900), //          5–904
  });
  return {
    isRunning: () => timer !== null,
    async start() {
      if (timer) return;
      const { rows } = await pool.query('SELECT id FROM "Room" ORDER BY id');
      roomIds = rows.map((r) => r.id);
      timer = setInterval(() => {
        const id = roomIds[Math.floor(Math.random() * roomIds.length)];
        setRoom(id, randomReadings()).catch((err) => console.error('[simulate]', err.message));
      }, intervalMs);
      console.log(`[simulate] started (${roomIds.length} rooms, every ${intervalMs}ms)`);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.log('[simulate] stopped');
    },
  };
}

// ---------------------------------------------------------------------------
// SSE reaction payload shaping
// ---------------------------------------------------------------------------

/**
 * Turn one row shape into the added / updated / deleted Handlebars templates the
 * SSE reaction serves on `path`. Adds and updates read the changed row's `after`
 * image, deletes read `before`; every value goes through the reaction's `json`
 * helper so the output is always valid JSON, tagged with an `op`.
 */
function sseRoute(path, shape) {
  const row = (src) =>
    '{' + Object.entries(shape).map(([out, col]) => `"${out}":{{json ${src}.${col}}}`).join(',') + '}';
  return {
    added: { path: `/${path}`, template: `{"op":"add","row":${row('after')}}` },
    updated: { path: `/${path}`, template: `{"op":"update","row":${row('after')}}` },
    deleted: { path: `/${path}`, template: `{"op":"delete","row":${row('before')}}` },
  };
}

/** Reshape one raw query-result row into an output shape (for /api/state). */
function reshape(shape, row) {
  const out = {};
  for (const [outName, col] of Object.entries(shape)) out[outName] = row[col];
  return out;
}

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

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

/**
 * Fan one SSE reaction route into the client's /events response, re-tagging each
 * event with its stream `path`. Node has no per-host connection limit, so the app
 * opens all upstream routes itself and merges them into one same-origin stream.
 */
async function pipeUpstream(path, res, signal) {
  try {
    const upstream = await fetch(`http://127.0.0.1:${SSE_PORT}/${path}`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done || res.writableEnded) break;
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Starting Building Comfort…');
  console.log('  • creating engine, downloading plugins, wiring the SSE reaction (first run ~30s)…');

  const engine = await Drasi.create('building-comfort', {});

  // 1. Install the plugins this tutorial needs and register them. installPlugin
  //    resolves each reference to the build for this platform and library version.
  const pluginsDir = mkdtempSync(join(tmpdir(), 'drasi-plugins-'));
  await engine.installPlugin('source/postgres', pluginsDir);
  await engine.installPlugin('bootstrap/postgres', pluginsDir);
  await engine.installPlugin('reaction/sse', pluginsDir);
  await engine.loadPlugins(pluginsDir);

  await engine.start();

  // 2. The real PostgreSQL CDC source (+ postgres bootstrap for the snapshot).
  await waitForPort(PG.host, PG.port);
  await engine.addSource('postgres', 'building-facilities', PG, true, { kind: 'postgres', config: PG });

  // 3. The six continuous queries. Drasi doesn't read foreign keys, so each query
  //    declares the synthetic joins it needs to walk Room -> Floor -> Building.
  const PART_OF_FLOOR = {
    id: 'PART_OF_FLOOR',
    keys: [{ label: 'Room', property: 'floor_id' }, { label: 'Floor', property: 'id' }],
  };
  const PART_OF_BUILDING = {
    id: 'PART_OF_BUILDING',
    keys: [{ label: 'Floor', property: 'building_id' }, { label: 'Building', property: 'id' }],
  };

  // Query 1 — per-room comfort level: the feed that drives the building view.
  await engine.addQuery('building-comfort-ui', `
    MATCH (r:Room)-[:PART_OF_FLOOR]->(f:Floor)-[:PART_OF_BUILDING]->(b:Building)
    WITH r, f, b, ${COMFORT} AS ComfortLevel
    RETURN
      r.id AS RoomId, r.name AS RoomName,
      f.id AS FloorId, f.name AS FloorName,
      b.id AS BuildingId, b.name AS BuildingName,
      r.temperature AS Temperature, r.humidity AS Humidity, r.co2 AS CO2,
      ComfortLevel
  `, ['building-facilities'], 'cypher', [PART_OF_FLOOR, PART_OF_BUILDING]);

  // Query 2 — per-floor comfort (average of the floor's rooms).
  await engine.addQuery('floor-comfort-level-calc', `
    MATCH (r:Room)-[:PART_OF_FLOOR]->(f:Floor)
    WITH f, ${COMFORT} AS RoomComfortLevel
    WITH f, avg(RoomComfortLevel) AS ComfortLevel
    RETURN f.id AS FloorId, ComfortLevel
  `, ['building-facilities'], 'cypher', [PART_OF_FLOOR]);

  // Query 3 — overall building comfort (average of floor averages).
  await engine.addQuery('building-comfort-level-calc', `
    MATCH (r:Room)-[:PART_OF_FLOOR]->(f:Floor)-[:PART_OF_BUILDING]->(b:Building)
    WITH b, ${COMFORT} AS RoomComfortLevel
    WITH b, avg(RoomComfortLevel) AS FloorComfortLevel
    WITH b, avg(FloorComfortLevel) AS ComfortLevel
    RETURN b.id AS BuildingId, ComfortLevel
  `, ['building-facilities'], 'cypher', [PART_OF_FLOOR, PART_OF_BUILDING]);

  // Query 4 — rooms outside the comfortable band (40–50).
  await engine.addQuery('room-alert', `
    MATCH (r:Room)
    WITH r.id AS RoomId, r.name AS RoomName, ${COMFORT} AS ComfortLevel
    WHERE ComfortLevel < 40 OR ComfortLevel > 50
    RETURN RoomId, RoomName, ComfortLevel
  `, ['building-facilities'], 'cypher');

  // Query 5 — floors whose average comfort is outside the band.
  await engine.addQuery('floor-alert', `
    MATCH (r:Room)-[:PART_OF_FLOOR]->(f:Floor)
    WITH f, ${COMFORT} AS RoomComfortLevel
    WITH f, avg(RoomComfortLevel) AS ComfortLevel
    WHERE ComfortLevel < 40 OR ComfortLevel > 50
    RETURN f.id AS FloorId, f.name AS FloorName, ComfortLevel
  `, ['building-facilities'], 'cypher', [PART_OF_FLOOR]);

  // Query 6 — the building when its overall comfort is outside the band. Declared
  // for completeness (the UI surfaces room and floor alerts); not streamed.
  await engine.addQuery('building-alert', `
    MATCH (r:Room)-[:PART_OF_FLOOR]->(f:Floor)-[:PART_OF_BUILDING]->(b:Building)
    WITH f, b, ${COMFORT} AS RoomComfortLevel
    WITH f, b, avg(RoomComfortLevel) AS FloorComfortLevel
    WITH b, avg(FloorComfortLevel) AS ComfortLevel
    WHERE ComfortLevel < 40 OR ComfortLevel > 50
    RETURN b.id AS BuildingId, b.name AS BuildingName, ComfortLevel
  `, ['building-facilities'], 'cypher', [PART_OF_FLOOR, PART_OF_BUILDING]);

  // 4. The SSE reaction (kind: sse) streams each query's result changes to the
  //    browser. Its `routes` carry Handlebars templates that SHAPE each changed
  //    row into our contract before it is sent — no bespoke reaction code. It
  //    listens on its own port; the app fans it in same-origin at /events.
  const routes = {
    'building-comfort-ui': sseRoute('rooms', ROOM_SHAPE),
    'floor-comfort-level-calc': sseRoute('floor-comfort', FLOOR_COMFORT_SHAPE),
    'building-comfort-level-calc': sseRoute('building', BUILDING_SHAPE),
    'room-alert': sseRoute('room-alerts', ROOM_ALERT_SHAPE),
    'floor-alert': sseRoute('floor-alerts', FLOOR_ALERT_SHAPE),
  };
  await engine.addReaction('sse', 'building-comfort-sse', Object.keys(routes), {
    host: '0.0.0.0',
    port: SSE_PORT,
    ssePath: '/events',
    heartbeatIntervalMs: 15000,
    routes,
  });

  // -------------------------------------------------------------------------
  // Web app: the UI, its initial-state snapshot, the /events stream, and the
  // control endpoints the UI writes through.
  // -------------------------------------------------------------------------
  const simulator = createSimulator();
  const app = express();
  app.use(express.json());

  // Initial state — the SSE reaction only streams changes from the moment a
  // client connects, so the browser seeds from this snapshot (same shape as the
  // streamed changes) and applies live deltas on top.
  app.get('/api/state', async (_req, res) => {
    try {
      res.json({
        rooms: (await engine.getQueryResults('building-comfort-ui')).map((r) => reshape(ROOM_SHAPE, r)),
        'floor-comfort': (await engine.getQueryResults('floor-comfort-level-calc')).map((r) => reshape(FLOOR_COMFORT_SHAPE, r)),
        building: (await engine.getQueryResults('building-comfort-level-calc')).map((r) => reshape(BUILDING_SHAPE, r)),
        'room-alerts': (await engine.getQueryResults('room-alert')).map((r) => reshape(ROOM_ALERT_SHAPE, r)),
        'floor-alerts': (await engine.getQueryResults('floor-alert')).map((r) => reshape(FLOOR_ALERT_SHAPE, r)),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // One same-origin stream that multiplexes every reaction route. Opening one
  // EventSource per route would eat into the browser's ~6-connections-per-host
  // limit; instead the app fans them in here and tags each event with its path,
  // so only one port needs forwarding in Codespaces / dev containers.
  app.get('/events', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const controller = new AbortController();
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

    // Fan in every reaction route; each forwards its events tagged with its path.
    await Promise.all([
      pipeUpstream('rooms', res, controller.signal),
      pipeUpstream('floor-comfort', res, controller.signal),
      pipeUpstream('building', res, controller.signal),
      pipeUpstream('room-alerts', res, controller.signal),
      pipeUpstream('floor-alerts', res, controller.signal),
    ]);
    cleanup();
  });

  // Control API — the UI writes to Postgres through these; Drasi reacts via CDC.
  app.get('/api/rooms', async (_req, res) => {
    try {
      res.json({ rooms: await listRooms(), presets: { COMFORTABLE, BROKEN } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/rooms/:id', async (req, res) => {
    try {
      res.json({ room: await setRoom(req.params.id, req.body || {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/rooms/:id/reset', async (req, res) => {
    try {
      res.json({ room: await setRoom(req.params.id, COMFORTABLE) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/reset', async (_req, res) => {
    try {
      res.json({ reset: await resetAll() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/simulate', (_req, res) => res.json({ running: simulator.isRunning() }));

  app.post('/api/simulate', async (req, res) => {
    try {
      if (req.body?.enabled) await simulator.start();
      else simulator.stop();
      res.json({ running: simulator.isRunning() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(express.static(PUBLIC_DIR));

  // A dropped SSE client (or a transient reaction hiccup) must never crash the
  // whole app. Log and keep serving.
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

  const onReady = () =>
    console.log(`\n✅ Building Comfort is ready — open http://localhost:${WEB_PORT}\n`);
  const server = WEB_HOST ? app.listen(WEB_PORT, WEB_HOST, onReady) : app.listen(WEB_PORT, onReady);

  // Graceful shutdown.
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
    await pool.end().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('\nFailed to start Building Comfort:\n', err);
  process.exit(1);
});
