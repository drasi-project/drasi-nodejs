// Control layer for the two tutorial databases. The UI changes orders and
// vehicles by writing straight to PostgreSQL (Retail Operations) and MySQL
// (Physical Operations) — exactly what the two operational systems would do.
// There is no call into Drasi: the engine observes each row change through CDC
// (logical replication / binlog) and re-evaluates the queries on its own.
//
// Every write is recorded in a rolling SQL log tagged with the database it hit,
// which the UI shows — making the "two independent systems, one live view"
// story concrete.

import pg from 'pg';
import mysql from 'mysql2/promise';
import { PG_CONFIG, MYSQL_CONFIG } from './engine.mjs';

const ORDER_STATUSES = ['preparing', 'ready'];
const VEHICLE_LOCATIONS = ['Parking', 'Curbside'];

// --- Rolling SQL log -------------------------------------------------------
const MAX_LOG = 25;
const sqlLog = [];
function pushLog(db, text) {
  sqlLog.push({ db, text, t: new Date().toISOString() });
  while (sqlLog.length > MAX_LOG) sqlLog.shift();
}
export function getLog() {
  return sqlLog;
}

// Format a value for display inside a logged SQL statement.
function lit(value) {
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

const pgPool = new pg.Pool({
  host: PG_CONFIG.host,
  port: PG_CONFIG.port,
  database: PG_CONFIG.database,
  user: PG_CONFIG.user,
  password: PG_CONFIG.password,
  max: 4,
});

const mysqlPool = mysql.createPool({
  host: MYSQL_CONFIG.host,
  port: MYSQL_CONFIG.port,
  database: MYSQL_CONFIG.database,
  user: MYSQL_CONFIG.user,
  password: MYSQL_CONFIG.password,
  connectionLimit: 4,
});

const nextOrderStatus = (s) => (s === 'ready' ? 'preparing' : 'ready');
const nextVehicleLocation = (l) => (l === 'Curbside' ? 'Parking' : 'Curbside');

// --- Reads (for the initial control lists) ---------------------------------
export async function listOrders() {
  const { rows } = await pgPool.query(
    'SELECT id, customer_name, driver_name, plate, status FROM orders ORDER BY id',
  );
  return rows;
}

export async function listVehicles() {
  const [rows] = await mysqlPool.query(
    'SELECT plate, driver_name, customer_name, make, model, color, location FROM vehicles ORDER BY plate',
  );
  return rows;
}

// --- Writes ----------------------------------------------------------------

/** Flip an order between 'preparing' and 'ready' (PostgreSQL). */
export async function toggleOrder(id) {
  const { rows } = await pgPool.query('SELECT id, status FROM orders WHERE id = $1', [id]);
  if (rows.length === 0) throw new Error(`no order with id '${id}'`);
  const status = nextOrderStatus(rows[0].status);
  pushLog('PostgreSQL', `UPDATE orders SET status=${lit(status)} WHERE id=${Number(id)};`);
  await pgPool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
  return { id: Number(id), status };
}

/** Flip a vehicle between 'Parking' and 'Curbside' (MySQL). */
export async function toggleVehicle(plate) {
  const [rows] = await mysqlPool.query('SELECT plate, location FROM vehicles WHERE plate = ?', [plate]);
  if (rows.length === 0) throw new Error(`no vehicle with plate '${plate}'`);
  const location = nextVehicleLocation(rows[0].location);
  pushLog('MySQL', `UPDATE vehicles SET location=${lit(location)} WHERE plate=${lit(plate)};`);
  await mysqlPool.query('UPDATE vehicles SET location = ? WHERE plate = ?', [location, plate]);
  return { plate, location };
}

/** Reset everything: all orders 'preparing', all vehicles 'Parking'. */
export async function resetAll() {
  pushLog('PostgreSQL', "UPDATE orders SET status='preparing';");
  await pgPool.query("UPDATE orders SET status = 'preparing'");
  pushLog('MySQL', "UPDATE vehicles SET location='Parking';");
  await mysqlPool.query("UPDATE vehicles SET location = 'Parking'");
}

export async function closeDb() {
  await Promise.allSettled([pgPool.end(), mysqlPool.end()]);
}

export { ORDER_STATUSES, VEHICLE_LOCATIONS };
