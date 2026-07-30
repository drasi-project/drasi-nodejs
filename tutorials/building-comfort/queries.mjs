// Query + synthetic-join definitions for the Building Comfort tutorial, ported
// verbatim from the drasi-server tutorial's `server-config.yaml`. This is the
// single source of truth for the engine topology: the app registers each query
// with these exact Cypher strings and synthetic joins.
//
// Comfort formula (a value between 40 and 50 is comfortable):
//   floor( 50 + (temperature - 72) + (humidity - 42)
//          + CASE WHEN co2 > 500 THEN (co2 - 500) / 25 ELSE 0 END )
// The seed values (70 / 40 / 10) give 50 + (70-72) + (40-42) + 0 = 46.

export const SOURCE_ID = 'building-facilities';

// Reused comfort-level expression so every query computes it identically.
const COMFORT =
  'floor( 50 + (r.temperature - 72) + (r.humidity - 42) + CASE WHEN r.co2 > 500 THEN (r.co2 - 500) / 25 ELSE 0 END )';

// --- Synthetic joins: Drasi does not read foreign keys, so each query declares
// the relationships it needs. Room -> Floor -> Building. ---
const PART_OF_FLOOR = {
  id: 'PART_OF_FLOOR',
  keys: [
    { label: 'Room', property: 'floor_id' },
    { label: 'Floor', property: 'id' },
  ],
};

const PART_OF_BUILDING = {
  id: 'PART_OF_BUILDING',
  keys: [
    { label: 'Floor', property: 'building_id' },
    { label: 'Building', property: 'id' },
  ],
};

export const QUERIES = [
  // Query 1: per-room comfort level — the feed that drives the building view.
  {
    id: 'building-comfort-ui',
    sources: [SOURCE_ID],
    joins: [PART_OF_FLOOR, PART_OF_BUILDING],
    query: `
      MATCH
        (r:Room)-[:PART_OF_FLOOR]->(f:Floor)-[:PART_OF_BUILDING]->(b:Building)
      WITH
        r, f, b,
        ${COMFORT} AS ComfortLevel
      RETURN
        r.id AS RoomId,
        r.name AS RoomName,
        f.id AS FloorId,
        f.name AS FloorName,
        b.id AS BuildingId,
        b.name AS BuildingName,
        r.temperature AS Temperature,
        r.humidity AS Humidity,
        r.co2 AS CO2,
        ComfortLevel
    `,
  },

  // Query 2: overall building comfort (avg of floor averages).
  {
    id: 'building-comfort-level-calc',
    sources: [SOURCE_ID],
    joins: [PART_OF_FLOOR, PART_OF_BUILDING],
    query: `
      MATCH
        (r:Room)-[:PART_OF_FLOOR]->(f:Floor)-[:PART_OF_BUILDING]->(b:Building)
      WITH
        b,
        ${COMFORT} AS RoomComfortLevel
      WITH
        b,
        avg(RoomComfortLevel) AS FloorComfortLevel
      WITH
        b,
        avg(FloorComfortLevel) AS ComfortLevel
      RETURN
        b.id AS BuildingId,
        ComfortLevel
    `,
  },

  // Query 3: per-floor comfort (avg of the floor's rooms).
  {
    id: 'floor-comfort-level-calc',
    sources: [SOURCE_ID],
    joins: [PART_OF_FLOOR],
    query: `
      MATCH
        (r:Room)-[:PART_OF_FLOOR]->(f:Floor)
      WITH
        f,
        ${COMFORT} AS RoomComfortLevel
      WITH
        f,
        avg(RoomComfortLevel) AS ComfortLevel
      RETURN
        f.id AS FloorId,
        ComfortLevel
    `,
  },

  // Query 4: rooms outside the comfortable band (40-50).
  {
    id: 'room-alert',
    sources: [SOURCE_ID],
    joins: [],
    query: `
      MATCH
        (r:Room)
      WITH
        r.id AS RoomId,
        r.name AS RoomName,
        ${COMFORT} AS ComfortLevel
      WHERE ComfortLevel < 40 OR ComfortLevel > 50
      RETURN
        RoomId, RoomName, ComfortLevel
    `,
  },

  // Query 5: floors whose average comfort is outside 40-50.
  {
    id: 'floor-alert',
    sources: [SOURCE_ID],
    joins: [PART_OF_FLOOR],
    query: `
      MATCH
        (r:Room)-[:PART_OF_FLOOR]->(f:Floor)
      WITH
        f,
        ${COMFORT} AS RoomComfortLevel
      WITH
        f,
        avg(RoomComfortLevel) AS ComfortLevel
      WHERE
        ComfortLevel < 40 OR ComfortLevel > 50
      RETURN
        f.id AS FloorId,
        f.name AS FloorName,
        ComfortLevel
    `,
  },

  // Query 6: the building when its overall comfort is outside 40-50.
  {
    id: 'building-alert',
    sources: [SOURCE_ID],
    joins: [PART_OF_FLOOR, PART_OF_BUILDING],
    query: `
      MATCH
        (r:Room)-[:PART_OF_FLOOR]->(f:Floor)-[:PART_OF_BUILDING]->(b:Building)
      WITH
        f, b,
        ${COMFORT} AS RoomComfortLevel
      WITH
        f, b,
        avg(RoomComfortLevel) AS FloorComfortLevel
      WITH
        b,
        avg(FloorComfortLevel) AS ComfortLevel
      WHERE
        ComfortLevel < 40 OR ComfortLevel > 50
      RETURN
        b.id AS BuildingId,
        b.name AS BuildingName,
        ComfortLevel
    `,
  },
];

// Ids of every query, in the order the UI cares about.
export const QUERY_IDS = QUERIES.map((q) => q.id);
