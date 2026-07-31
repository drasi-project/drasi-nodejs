// Single source of truth for what the SSE reaction streams to the browser.
//
// Each entry maps a continuous query to:
//   - `path`   : the SSE route the reaction serves it on (the app fans these in
//                and multiplexes them into a single same-origin /events stream);
//   - `key`    : the field the browser merges rows by;
//   - `fields` : a { outputName: QueryColumn } contract.
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
    query: 'floor-comfort-level-calc',
    path: 'floor-comfort',
    key: 'id',
    fields: { id: 'FloorId', comfort: 'ComfortLevel' },
  },
  {
    query: 'building-comfort-level-calc',
    path: 'building',
    key: 'id',
    fields: { id: 'BuildingId', comfort: 'ComfortLevel' },
  },
  {
    query: 'room-alert',
    path: 'room-alerts',
    key: 'id',
    fields: { id: 'RoomId', name: 'RoomName', comfort: 'ComfortLevel' },
  },
  {
    query: 'floor-alert',
    path: 'floor-alerts',
    key: 'id',
    fields: { id: 'FloorId', name: 'FloorName', comfort: 'ComfortLevel' },
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
