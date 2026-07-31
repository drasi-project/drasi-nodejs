// Query + synthetic-join definitions for the Curbside Pickup tutorial, ported
// verbatim from the drasi-server tutorial's `server-config.yaml`.
//
// Two sources feed six queries:
//   retail-ops   : PostgreSQL `orders`   (o:orders)
//   physical-ops : MySQL `vehicles`      (v:vehicles)
//
// Four queries are simple filtered lists that split orders/vehicles by state.
// Two join across the sources by license plate and add real-time logic:
//   delivery : order is 'ready' AND its driver's vehicle is at 'Curbside'
//   delay    : driver has waited at 'Curbside' > 10s while the order is not ready
//              (temporal drasi.trueFor)

export const SOURCE_ORDERS = 'retail-ops';
export const SOURCE_VEHICLES = 'physical-ops';

// Synthetic join across the two sources: a vehicle's plate == an order's plate.
const PICKUP_BY = {
  id: 'PICKUP_BY',
  keys: [
    { label: 'vehicles', property: 'plate' },
    { label: 'orders', property: 'plate' },
  ],
};

// NOTE: the two-source queries below list `retail-ops` (PostgreSQL / orders)
// FIRST. Cross-source query bootstrap is currently order-dependent — a source
// listed second bootstraps 0 rows, so it would be missing from the join until a
// later CDC change. Ordering the source whose rows stay put (the orders) first
// makes both sources bootstrap. See drasi-project/drasi-core#682.

export const QUERIES = [
  // orders-preparing: orders still being prepared (status != 'ready').
  {
    id: 'orders-preparing',
    sources: [SOURCE_ORDERS],
    joins: [],
    query: `
      MATCH (o:orders)
      WHERE o.status <> 'ready'
      RETURN
        o.id AS id,
        o.id AS orderId,
        o.customer_name AS customerName,
        o.driver_name AS driverName,
        o.plate AS plate,
        o.status AS status
    `,
  },

  // orders-ready: orders that are ready for pickup (status = 'ready').
  {
    id: 'orders-ready',
    sources: [SOURCE_ORDERS],
    joins: [],
    query: `
      MATCH (o:orders)
      WHERE o.status = 'ready'
      RETURN
        o.id AS id,
        o.id AS orderId,
        o.customer_name AS customerName,
        o.driver_name AS driverName,
        o.plate AS plate,
        o.status AS status
    `,
  },

  // vehicles-parking: vehicles still in the parking lot (location = 'Parking').
  {
    id: 'vehicles-parking',
    sources: [SOURCE_VEHICLES],
    joins: [],
    query: `
      MATCH (v:vehicles)
      WHERE v.location = 'Parking'
      RETURN
        v.plate AS id,
        v.plate AS plate,
        v.make AS make,
        v.model AS model,
        v.color AS color,
        v.location AS location
    `,
  },

  // vehicles-curbside: vehicles waiting at the curb (location = 'Curbside').
  {
    id: 'vehicles-curbside',
    sources: [SOURCE_VEHICLES],
    joins: [],
    query: `
      MATCH (v:vehicles)
      WHERE v.location = 'Curbside'
      RETURN
        v.plate AS id,
        v.plate AS plate,
        v.make AS make,
        v.model AS model,
        v.color AS color,
        v.location AS location
    `,
  },

  // delivery: orders that are READY whose driver has ARRIVED at the curbside.
  {
    id: 'delivery',
    sources: [SOURCE_ORDERS, SOURCE_VEHICLES],
    joins: [PICKUP_BY],
    query: `
      MATCH (o:orders)-[:PICKUP_BY]->(v:vehicles)
      WHERE o.status = 'ready'
      AND v.location = 'Curbside'
      RETURN
        o.id AS id,
        o.id AS orderId,
        o.status AS orderStatus,
        o.driver_name AS driverName,
        o.plate AS vehicleId,
        v.make AS vehicleMake,
        v.model AS vehicleModel,
        v.color AS vehicleColor,
        v.location AS vehicleLocation,
        drasi.listMax([drasi.changeDateTime(o), drasi.changeDateTime(v)]) AS readyTimestamp
    `,
  },

  // delay: a driver is at the curbside but the order is NOT yet ready, and they
  // have been waiting more than 10 seconds. drasi.trueFor schedules a future
  // re-evaluation so the row appears the instant the threshold is crossed.
  {
    id: 'delay',
    sources: [SOURCE_ORDERS, SOURCE_VEHICLES],
    joins: [PICKUP_BY],
    query: `
      MATCH (o:orders)-[:PICKUP_BY]->(v:vehicles)
      WHERE o.status <> 'ready'
      AND drasi.trueFor(v.location = 'Curbside', duration({ seconds: 10 }))
      RETURN
        o.id AS orderId,
        o.customer_name AS customerName,
        drasi.changeDateTime(v) AS waitingSinceTimestamp
    `,
  },
];

export const QUERY_IDS = QUERIES.map((q) => q.id);
