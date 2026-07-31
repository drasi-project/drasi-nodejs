// Single source of truth for what the SSE reaction streams to the browser.
//
// Each entry maps a continuous query to an SSE route `path`, a merge `key`, and
// a `{ outputName: QueryColumn }` field contract. From `fields` we derive BOTH
// the SSE reaction's Handlebars templates (server-side payload shaping) and a
// matching reshaper for the initial-state snapshot, so the browser sees an
// identical shape whether a row arrives via the snapshot or a live change.

export const SSE_PORT = Number(process.env.SSE_PORT || 8081);

export const STREAMS = [
  // Orders still being prepared (PostgreSQL).
  {
    query: 'orders-preparing',
    path: 'orders-preparing',
    key: 'id',
    fields: {
      id: 'id',
      orderId: 'orderId',
      customerName: 'customerName',
      driverName: 'driverName',
      plate: 'plate',
      status: 'status',
    },
  },
  // Orders ready for pickup (PostgreSQL).
  {
    query: 'orders-ready',
    path: 'orders-ready',
    key: 'id',
    fields: {
      id: 'id',
      orderId: 'orderId',
      customerName: 'customerName',
      driverName: 'driverName',
      plate: 'plate',
      status: 'status',
    },
  },
  // Vehicles in the parking lot (MySQL).
  {
    query: 'vehicles-parking',
    path: 'vehicles-parking',
    key: 'id',
    fields: { id: 'id', plate: 'plate', make: 'make', model: 'model', color: 'color', location: 'location' },
  },
  // Vehicles waiting at the curb (MySQL).
  {
    query: 'vehicles-curbside',
    path: 'vehicles-curbside',
    key: 'id',
    fields: { id: 'id', plate: 'plate', make: 'make', model: 'model', color: 'color', location: 'location' },
  },
  // Matched orders: ready AND at the curbside (cross-source join).
  {
    query: 'delivery',
    path: 'delivery',
    key: 'id',
    fields: {
      id: 'id',
      orderId: 'orderId',
      driverName: 'driverName',
      vehicleId: 'vehicleId',
      vehicleMake: 'vehicleMake',
      vehicleModel: 'vehicleModel',
      vehicleColor: 'vehicleColor',
      readyTimestamp: 'readyTimestamp',
    },
  },
  // Delayed orders: at the curbside > 10s while not ready (temporal drasi.trueFor).
  // The query returns orderId (no `id` column), so the merge key maps from it.
  {
    query: 'delay',
    path: 'delay',
    key: 'id',
    fields: {
      id: 'orderId',
      orderId: 'orderId',
      customerName: 'customerName',
      waitingSince: 'waitingSinceTimestamp',
    },
  },
];

/** Build the JSON-object body of a Handlebars template, reading from `source`. */
function objectTemplate(fields, source) {
  const parts = Object.entries(fields).map(
    ([out, col]) => `"${out}":{{json ${source}.${col}}}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * The `routes` config for the SSE reaction: an added / updated / deleted
 * Handlebars template per stream that shapes the changed row into our contract
 * and tags it with an `op`. All change types of a query share one path.
 */
export function buildSseRoutes() {
  const routes = {};
  for (const { query, path, fields } of STREAMS) {
    routes[query] = {
      added: { path: `/${path}`, template: `{"op":"add","row":${objectTemplate(fields, 'after')}}` },
      updated: { path: `/${path}`, template: `{"op":"update","row":${objectTemplate(fields, 'after')}}` },
      deleted: { path: `/${path}`, template: `{"op":"delete","row":${objectTemplate(fields, 'before')}}` },
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
