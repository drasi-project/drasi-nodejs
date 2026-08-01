// Curbside Pickup — a Drasi app in one file.
//
// A single Node process that:
//   1. embeds the Drasi engine (@drasi/lib) over TWO databases — PostgreSQL
//      orders (Retail Ops) and MySQL vehicles (Physical Ops) — with six
//      continuous queries (two of them a cross-source join by license plate,
//      one temporal), and an SSE reaction whose Handlebars templates shape each
//      changed row; then
//   2. serves one integrated web UI (public/), an initial-state snapshot
//      (/api/state), and a single same-origin /events stream that fans in the
//      reaction's routes; and
//   3. exposes control endpoints the UI writes through — toggling an order or a
//      vehicle is just a SQL UPDATE against one database, so Drasi reacts through
//      CDC (PostgreSQL logical replication / MySQL binlog) with no call into it.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';
import express from 'express';
import pg from 'pg';
import mysql from 'mysql2/promise';

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

// PostgreSQL (Retail Operations / orders) — matches database/docker-compose.yml
// + database/postgres-init.sql. The replication slot is created on connect.
const PG = {
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
const MYSQL = {
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
    host: MYSQL.host, port: MYSQL.port, database: MYSQL.database,
    user: MYSQL.user, password: MYSQL.password,
    tables: ['vehicles'],
    tableKeys: [{ table: 'vehicles', keyColumns: ['plate'] }],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The row shape each query's changes are published in — the contract the browser
// renders. Each entry maps an output field to the query column it comes from. The
// same shapes drive both the SSE reaction's Handlebars templates and the initial
// /api/state snapshot, so the browser sees an identical shape either way. Orders
// and vehicles each share a shape across their two filtered streams.
const ORDER_SHAPE = {
  id: 'id', orderId: 'orderId', customerName: 'customerName',
  driverName: 'driverName', plate: 'plate', status: 'status',
};
const VEHICLE_SHAPE = {
  id: 'id', plate: 'plate', make: 'make', model: 'model', color: 'color', location: 'location',
};
const DELIVERY_SHAPE = {
  id: 'id', orderId: 'orderId', driverName: 'driverName',
  vehicleId: 'vehicleId', vehicleMake: 'vehicleMake', vehicleModel: 'vehicleModel',
  vehicleColor: 'vehicleColor', readyTimestamp: 'readyTimestamp',
};
// The delay query returns no `id` column, so the merge key maps from orderId.
const DELAY_SHAPE = {
  id: 'orderId', orderId: 'orderId', customerName: 'customerName', waitingSince: 'waitingSinceTimestamp',
};

// ---------------------------------------------------------------------------
// Control layer for the two databases
// ---------------------------------------------------------------------------
// The UI changes orders and vehicles by writing straight to PostgreSQL and MySQL
// — exactly what the two operational systems would do. There is no call into
// Drasi: the engine observes each row change through CDC and re-evaluates the
// queries itself. Every write is recorded in a rolling SQL log the UI shows.

const pgPool = new pg.Pool({
  host: PG.host, port: PG.port, database: PG.database,
  user: PG.user, password: PG.password, max: 4,
});
const mysqlPool = mysql.createPool({
  host: MYSQL.host, port: MYSQL.port, database: MYSQL.database,
  user: MYSQL.user, password: MYSQL.password, connectionLimit: 4,
});

const MAX_LOG = 25;
const sqlLog = [];
const getLog = () => sqlLog;
function pushLog(db, text) {
  sqlLog.push({ db, text, t: new Date().toISOString() });
  while (sqlLog.length > MAX_LOG) sqlLog.shift();
}
// Format a value for display inside a logged SQL statement.
const lit = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** Flip an order between 'preparing' and 'ready' (PostgreSQL). */
async function toggleOrder(id) {
  const { rows } = await pgPool.query('SELECT id, status FROM orders WHERE id = $1', [id]);
  if (rows.length === 0) throw new Error(`no order with id '${id}'`);
  const status = rows[0].status === 'ready' ? 'preparing' : 'ready';
  pushLog('PostgreSQL', `UPDATE orders SET status=${lit(status)} WHERE id=${Number(id)};`);
  await pgPool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
  return { id: Number(id), status };
}

/** Flip a vehicle between 'Parking' and 'Curbside' (MySQL). */
async function toggleVehicle(plate) {
  const [rows] = await mysqlPool.query('SELECT plate, location FROM vehicles WHERE plate = ?', [plate]);
  if (rows.length === 0) throw new Error(`no vehicle with plate '${plate}'`);
  const location = rows[0].location === 'Curbside' ? 'Parking' : 'Curbside';
  pushLog('MySQL', `UPDATE vehicles SET location=${lit(location)} WHERE plate=${lit(plate)};`);
  await mysqlPool.query('UPDATE vehicles SET location = ? WHERE plate = ?', [location, plate]);
  return { plate, location };
}

/** Reset everything: all orders 'preparing', all vehicles 'Parking'. */
async function resetAll() {
  pushLog('PostgreSQL', "UPDATE orders SET status='preparing';");
  await pgPool.query("UPDATE orders SET status = 'preparing'");
  pushLog('MySQL', "UPDATE vehicles SET location='Parking';");
  await mysqlPool.query("UPDATE vehicles SET location = 'Parking'");
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
async function waitForPort(host, port, label, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const socket = createConnection({ host, port });
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => (socket.destroy(), resolve(false)));
    });
    if (ok) return;
    await sleep(1000);
  }
  throw new Error(
    `${label} is not reachable at ${host}:${port}. Start the databases with 'npm run db:up' ` +
      '(requires Docker; MySQL can take ~30s to become ready).',
  );
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
  console.log('Starting Curbside Pickup…');
  console.log('  • creating engine, downloading plugins, connecting to PostgreSQL + MySQL, wiring the SSE reaction…');
  console.log('    (first run may take ~30s; MySQL can be slow to become ready)');

  const engine = await Drasi.create('curbside-pickup', {});

  // 1. Install the plugins this tutorial needs and register them. installPlugin
  //    resolves each reference to the build for this platform and library version.
  const pluginsDir = mkdtempSync(join(tmpdir(), 'drasi-plugins-'));
  await engine.installPlugin('source/postgres', pluginsDir);
  await engine.installPlugin('bootstrap/postgres', pluginsDir);
  await engine.installPlugin('source/mysql', pluginsDir);
  await engine.installPlugin('bootstrap/mysql', pluginsDir);
  await engine.installPlugin('reaction/sse', pluginsDir);
  await engine.loadPlugins(pluginsDir);

  await engine.start();

  // 2. Both CDC sources. The PostgreSQL source (orders) is added FIRST: cross-
  //    source query bootstrap is order-dependent — a source listed second in a
  //    join bootstraps 0 rows, so ordering the orders (whose rows stay put) first
  //    makes both sources bootstrap. See drasi-project/drasi-core#682.
  await waitForPort(PG.host, PG.port, 'PostgreSQL');
  await waitForPort(MYSQL.host, MYSQL.port, 'MySQL');
  await engine.addSource('postgres', 'retail-ops', PG, true, { kind: 'postgres', config: PG });
  await engine.addSource('mysql', 'physical-ops', MYSQL, true, MYSQL_BOOTSTRAP);

  // 3. The six continuous queries. Four are simple filtered lists that split
  //    orders / vehicles by state; two join across the databases by license
  //    plate. The join uses a synthetic PICKUP_BY relationship because Drasi
  //    doesn't read foreign keys — especially across two different databases.
  const PICKUP_BY = {
    id: 'PICKUP_BY',
    keys: [{ label: 'vehicles', property: 'plate' }, { label: 'orders', property: 'plate' }],
  };

  // Orders still being prepared (PostgreSQL).
  await engine.addQuery('orders-preparing', `
    MATCH (o:orders)
    WHERE o.status <> 'ready'
    RETURN o.id AS id, o.id AS orderId, o.customer_name AS customerName,
           o.driver_name AS driverName, o.plate AS plate, o.status AS status
  `, ['retail-ops'], 'cypher');

  // Orders ready for pickup (PostgreSQL).
  await engine.addQuery('orders-ready', `
    MATCH (o:orders)
    WHERE o.status = 'ready'
    RETURN o.id AS id, o.id AS orderId, o.customer_name AS customerName,
           o.driver_name AS driverName, o.plate AS plate, o.status AS status
  `, ['retail-ops'], 'cypher');

  // Vehicles still in the parking lot (MySQL).
  await engine.addQuery('vehicles-parking', `
    MATCH (v:vehicles)
    WHERE v.location = 'Parking'
    RETURN v.plate AS id, v.plate AS plate, v.make AS make,
           v.model AS model, v.color AS color, v.location AS location
  `, ['physical-ops'], 'cypher');

  // Vehicles waiting at the curb (MySQL).
  await engine.addQuery('vehicles-curbside', `
    MATCH (v:vehicles)
    WHERE v.location = 'Curbside'
    RETURN v.plate AS id, v.plate AS plate, v.make AS make,
           v.model AS model, v.color AS color, v.location AS location
  `, ['physical-ops'], 'cypher');

  // delivery — orders that are READY whose driver has ARRIVED at the curbside.
  // Joins PostgreSQL orders to MySQL vehicles by plate (retail-ops listed first).
  await engine.addQuery('delivery', `
    MATCH (o:orders)-[:PICKUP_BY]->(v:vehicles)
    WHERE o.status = 'ready' AND v.location = 'Curbside'
    RETURN o.id AS id, o.id AS orderId, o.status AS orderStatus,
           o.driver_name AS driverName, o.plate AS vehicleId,
           v.make AS vehicleMake, v.model AS vehicleModel, v.color AS vehicleColor,
           v.location AS vehicleLocation,
           drasi.listMax([drasi.changeDateTime(o), drasi.changeDateTime(v)]) AS readyTimestamp
  `, ['retail-ops', 'physical-ops'], 'cypher', [PICKUP_BY]);

  // delay — a driver is at the curbside but the order is NOT ready, and they have
  // been waiting more than 10 seconds. drasi.trueFor schedules a future
  // re-evaluation so the row appears the instant the threshold is crossed.
  await engine.addQuery('delay', `
    MATCH (o:orders)-[:PICKUP_BY]->(v:vehicles)
    WHERE o.status <> 'ready'
    AND drasi.trueFor(v.location = 'Curbside', duration({ seconds: 10 }))
    RETURN o.id AS orderId, o.customer_name AS customerName,
           drasi.changeDateTime(v) AS waitingSinceTimestamp
  `, ['retail-ops', 'physical-ops'], 'cypher', [PICKUP_BY]);

  // 4. The SSE reaction (kind: sse) streams each query's result changes to the
  //    browser. Its `routes` carry Handlebars templates that SHAPE each changed
  //    row into our contract before it is sent — no bespoke reaction code. It
  //    listens on its own port; the app fans it in same-origin at /events.
  const routes = {
    'orders-preparing': sseRoute('orders-preparing', ORDER_SHAPE),
    'orders-ready': sseRoute('orders-ready', ORDER_SHAPE),
    'vehicles-parking': sseRoute('vehicles-parking', VEHICLE_SHAPE),
    'vehicles-curbside': sseRoute('vehicles-curbside', VEHICLE_SHAPE),
    'delivery': sseRoute('delivery', DELIVERY_SHAPE),
    'delay': sseRoute('delay', DELAY_SHAPE),
  };
  await engine.addReaction('sse', 'curbside-sse', Object.keys(routes), {
    host: '0.0.0.0',
    port: SSE_PORT,
    ssePath: '/events',
    heartbeatIntervalMs: 15000,
    routes,
  });

  // -------------------------------------------------------------------------
  // Web app: the integrated UI, its initial-state snapshot, the /events stream,
  // and the control endpoints the UI writes through.
  // -------------------------------------------------------------------------
  const app = express();
  app.use(express.json());

  // Initial state — the SSE reaction only streams changes from the moment a
  // client connects, so the browser seeds from this snapshot (same shape as the
  // streamed changes) plus the current SQL log, then applies live deltas on top.
  app.get('/api/state', async (_req, res) => {
    try {
      res.json({
        streams: {
          'orders-preparing': (await engine.getQueryResults('orders-preparing')).map((r) => reshape(ORDER_SHAPE, r)),
          'orders-ready': (await engine.getQueryResults('orders-ready')).map((r) => reshape(ORDER_SHAPE, r)),
          'vehicles-parking': (await engine.getQueryResults('vehicles-parking')).map((r) => reshape(VEHICLE_SHAPE, r)),
          'vehicles-curbside': (await engine.getQueryResults('vehicles-curbside')).map((r) => reshape(VEHICLE_SHAPE, r)),
          delivery: (await engine.getQueryResults('delivery')).map((r) => reshape(DELIVERY_SHAPE, r)),
          delay: (await engine.getQueryResults('delay')).map((r) => reshape(DELAY_SHAPE, r)),
        },
        log: getLog(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/log', (_req, res) => res.json({ log: getLog() }));

  // One same-origin stream that multiplexes every reaction route. Opening one
  // EventSource per route would exhaust the browser's ~6-connections-per-host
  // limit (there are six streams); instead the app fans them in here and tags
  // each event with its path, so only one port needs forwarding in Codespaces.
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
      pipeUpstream('orders-preparing', res, controller.signal),
      pipeUpstream('orders-ready', res, controller.signal),
      pipeUpstream('vehicles-parking', res, controller.signal),
      pipeUpstream('vehicles-curbside', res, controller.signal),
      pipeUpstream('delivery', res, controller.signal),
      pipeUpstream('delay', res, controller.signal),
    ]);
    cleanup();
  });

  // A dropped SSE client (or a transient reaction hiccup) must never crash the
  // whole app. Log and keep serving.
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

  // Control API — the UI writes to the two databases through these; Drasi reacts
  // via CDC. Each response carries the updated SQL log for the UI to render.
  app.post('/api/orders/:id/toggle', async (req, res) => {
    try {
      res.json({ order: await toggleOrder(req.params.id), log: getLog() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/vehicles/:plate/toggle', async (req, res) => {
    try {
      res.json({ vehicle: await toggleVehicle(req.params.plate), log: getLog() });
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
    console.log(`\n✅ Curbside Pickup is ready — open http://localhost:${WEB_PORT}\n`);
  const server = WEB_HOST ? app.listen(WEB_PORT, WEB_HOST, onReady) : app.listen(WEB_PORT, onReady);

  // Graceful shutdown.
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
    await Promise.allSettled([pgPool.end(), mysqlPool.end()]);
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('\nFailed to start Curbside Pickup:\n', err);
  process.exit(1);
});
