// Single source of truth for what the SSE reaction streams to the browser.
//
// We stream the two clean, per-entity queries — one row per room, one row per
// alerting room. Both are keyed by a primary key, so a snapshot from
// `getQueryResults` and the live change stream agree exactly.
//
// The rollups the UI also shows (each floor's comfort, the building's overall
// comfort, and which floors are alerting) are DERIVED in the browser from the
// room feed. Those correspond to Drasi's aggregate queries
// (`floor-comfort-level-calc`, `building-comfort-level-calc`, `floor-alert`),
// which stay defined in queries.mjs to demonstrate aggregation — but an
// aggregating query's `getQueryResults` returns the intermediate values it
// passed through, so it isn't a clean seed for the initial snapshot. Deriving
// the rollups from the room feed is simpler and always correct.
//
// From each stream's `fields` we derive BOTH the SSE reaction's Handlebars
// templates (server-side payload shaping) and a matching reshaper for the
// initial-state snapshot, so the browser sees an identical shape either way.

export const SSE_PORT = Number(process.env.SSE_PORT || 8081);

export const STREAMS = [
  {
    query: 'building-comfort-ui',
    path: 'rooms',
    key: 'id',
    fields: {
      id: 'RoomId',
      name: 'RoomName',
      floorId: 'FloorId',
      floor: 'FloorName',
      buildingName: 'BuildingName',
      comfort: 'ComfortLevel',
      temperature: 'Temperature',
      humidity: 'Humidity',
      co2: 'CO2',
    },
  },
  {
    query: 'room-alert',
    path: 'room-alerts',
    key: 'id',
    fields: { id: 'RoomId', name: 'RoomName', comfort: 'ComfortLevel' },
  },
];

/**
 * Build the JSON-object body of a Handlebars template for one stream, reading
 * from `source` (`after` for adds/updates, `before` for deletes). Every value
 * goes through the reaction's `json` helper so the output is always valid JSON.
 */
function objectTemplate(fields, source) {
  const parts = Object.entries(fields).map(
    ([out, col]) => `"${out}":{{json ${source}.${col}}}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * The `routes` config for the SSE reaction: for every stream, an added / updated
 * / deleted Handlebars template that shapes the changed row into our contract
 * and tags it with an `op`. All change types of a query share one path.
 */
export function buildSseRoutes() {
  const routes = {};
  for (const { query, path, fields } of STREAMS) {
    const add = `{"op":"add","row":${objectTemplate(fields, 'after')}}`;
    const upd = `{"op":"update","row":${objectTemplate(fields, 'after')}}`;
    const del = `{"op":"delete","row":${objectTemplate(fields, 'before')}}`;
    routes[query] = {
      added: { path: `/${path}`, template: add },
      updated: { path: `/${path}`, template: upd },
      deleted: { path: `/${path}`, template: del },
    };
  }
  return routes;
}

/** Reshape one raw query-result row into the stream's output contract. */
export function reshapeRow(fields, row) {
  const out = {};
  for (const [outName, col] of Object.entries(fields)) out[outName] = row[col];
  return out;
}
