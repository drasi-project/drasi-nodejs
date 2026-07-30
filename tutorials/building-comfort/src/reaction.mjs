// The SSE "reaction": one JavaScript reaction subscribed to all six queries.
// When any query's result set changes, it re-reads the current snapshots, uses
// the Handlebars templates in ./templates.mjs to SHAPE them into a display-ready
// JSON payload, and pushes that payload to every connected browser over
// Server-Sent Events. The engine only emits *changes*, so the UI stays live
// without polling.

import { renderSnapshot } from './templates.mjs';
import { QUERY_IDS } from '../queries.mjs';

// Queries whose rows feed the snapshot template, in the order we fetch them.
const SNAPSHOT_QUERIES = [
  'building-comfort-ui',
  'floor-comfort-level-calc',
  'room-alert',
  'floor-alert',
];

// Stable ascending sort by a string field (does not mutate the input).
function sortBy(rows, field) {
  return [...(rows || [])].sort((a, b) =>
    String(a[field]).localeCompare(String(b[field]), undefined, { numeric: true }),
  );
}

/**
 * Wire the SSE reaction to the engine and return a hub that HTTP handlers use to
 * register browser connections.
 */
export async function createSseHub(engine) {
  /** @type {Set<import('http').ServerResponse>} */
  const clients = new Set();
  let latest = null;
  let scheduled = false;

  async function refresh() {
    scheduled = false;
    const [ui, floorComfort, roomAlerts, floorAlerts] = await Promise.all(
      SNAPSHOT_QUERIES.map((id) => engine.getQueryResults(id)),
    );
    // Continuous queries return rows in no particular order, so sort into a
    // stable display order before shaping (room ids encode floor + room, e.g.
    // room_01_02_03, so sorting by id also orders floors and rooms naturally).
    latest = renderSnapshot({
      ui: sortBy(ui, 'RoomId'),
      floorComfort: sortBy(floorComfort, 'FloorId'),
      roomAlerts: sortBy(roomAlerts, 'RoomId'),
      floorAlerts: sortBy(floorAlerts, 'FloorId'),
    });
    const frame = `event: snapshot\ndata: ${JSON.stringify(latest)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  // Coalesce bursts of change events into a single refresh.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      refresh().catch((err) => console.error('[sse] refresh failed:', err.message));
    }, 50);
  }

  // Subscribe to every query so the snapshot updates whenever anything changes
  // (including the aggregate building-level and building-alert queries).
  await engine.addJsReaction('sse-shaper', QUERY_IDS, () => schedule());

  // Seed the first snapshot so a browser that connects immediately sees data.
  await refresh();

  return {
    /** Attach a new SSE client (an Express response with headers already set). */
    addClient(res) {
      clients.add(res);
      if (latest) {
        res.write(`event: snapshot\ndata: ${JSON.stringify(latest)}\n\n`);
      }
      res.on('close', () => clients.delete(res));
    },
    /** Force a refresh (used right after a manual write, for snappy feedback). */
    refresh: schedule,
    clientCount: () => clients.size,
  };
}
