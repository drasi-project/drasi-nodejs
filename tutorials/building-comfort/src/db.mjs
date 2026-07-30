// PostgreSQL control layer. The UI (and the helper scripts) change room readings
// by writing straight to the database — exactly what an existing building-
// management app would do. There is no call into Drasi: the engine observes each
// row change through logical replication (CDC) and re-evaluates the queries on
// its own. This module owns a small `pg` pool and the write operations.

import pg from 'pg';
import { PG_CONFIG } from './engine.mjs';

// Comfortable defaults (comfort level = floor(50 + (70-72) + (40-42)) = 46).
export const COMFORTABLE = { temperature: 70, humidity: 40, co2: 10 };
// "Broken" preset: too hot, too dry, high CO2 (comfort level well above 50).
export const BROKEN = { temperature: 40, humidity: 20, co2: 700 };

const pool = new pg.Pool({
  host: PG_CONFIG.host,
  port: PG_CONFIG.port,
  database: PG_CONFIG.database,
  user: PG_CONFIG.user,
  password: PG_CONFIG.password,
  max: 4,
});

const ROOM_ID_RE = /^[A-Za-z0-9_]+$/;

function assertRoomId(id) {
  if (typeof id !== 'string' || !ROOM_ID_RE.test(id)) {
    throw new Error(`invalid room id '${id}' (expected letters, digits, underscores)`);
  }
}

function assertInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer (got '${value}')`);
  return n;
}

/** All rooms with their current readings, ordered by id. */
export async function listRooms() {
  const { rows } = await pool.query(
    'SELECT id, name, temperature, humidity, co2, floor_id FROM "Room" ORDER BY id',
  );
  return rows;
}

/** Set one room's temperature / humidity / co2. Returns the updated row. */
export async function setRoom(id, { temperature, humidity, co2 }) {
  assertRoomId(id);
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

/** Reset one room to comfortable defaults. */
export async function resetRoom(id) {
  return setRoom(id, COMFORTABLE);
}

/** Reset every room to comfortable defaults. Returns the number of rooms. */
export async function resetAll() {
  const { rowCount } = await pool.query(
    'UPDATE "Room" SET temperature = $1, humidity = $2, co2 = $3',
    [COMFORTABLE.temperature, COMFORTABLE.humidity, COMFORTABLE.co2],
  );
  return rowCount;
}

/** List just the room ids (used by the simulator). */
export async function listRoomIds() {
  const { rows } = await pool.query('SELECT id FROM "Room" ORDER BY id');
  return rows.map((r) => r.id);
}

export async function closeDb() {
  await pool.end();
}
