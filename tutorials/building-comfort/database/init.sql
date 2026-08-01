-- Copyright 2025 The Drasi Authors.
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Building Comfort Tutorial Database Schema (@drasi/lib edition)
--
-- Models a smart building as Building -> Floor -> Room. Each Room carries
-- temperature, humidity and co2 sensor readings. Table names are quoted and
-- PascalCase ("Building", "Floor", "Room") so that the node labels Drasi sees
-- match the Cypher continuous queries (which use (r:Room), (f:Floor),
-- (b:Building)) without any change to the query text.

-- Suppress noisy output during setup.
\set QUIET on
SET client_min_messages = ERROR;

-- Create a user with replication privileges for CDC.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'drasi_user') THEN
        CREATE USER drasi_user WITH REPLICATION LOGIN PASSWORD 'drasi_password';
    END IF;
END
$$;

-- Grant permissions on the database.
GRANT CREATE ON DATABASE building_comfort TO drasi_user;
GRANT ALL PRIVILEGES ON DATABASE building_comfort TO drasi_user;

-- Drop existing tables if they exist.
DROP TABLE IF EXISTS "Room" CASCADE;
DROP TABLE IF EXISTS "Floor" CASCADE;
DROP TABLE IF EXISTS "Building" CASCADE;

-- Building table.
CREATE TABLE "Building" (
    id   VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

-- Floor table (each Floor belongs to a Building).
CREATE TABLE "Floor" (
    id          VARCHAR(50) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    building_id VARCHAR(50) NOT NULL,
    FOREIGN KEY (building_id) REFERENCES "Building"(id) ON DELETE CASCADE
);

-- Room table (each Room belongs to a Floor and holds sensor readings).
CREATE TABLE "Room" (
    id          VARCHAR(50) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    temperature INTEGER,
    humidity    INTEGER,
    co2         INTEGER,
    floor_id    VARCHAR(50) NOT NULL,
    FOREIGN KEY (floor_id) REFERENCES "Floor"(id) ON DELETE CASCADE
);

-- Set REPLICA IDENTITY to FULL so change events include every column.
ALTER TABLE "Building" REPLICA IDENTITY FULL;
ALTER TABLE "Floor" REPLICA IDENTITY FULL;
ALTER TABLE "Room" REPLICA IDENTITY FULL;

-- Ensure drasi_user owns the tables.
ALTER TABLE "Building" OWNER TO drasi_user;
ALTER TABLE "Floor" OWNER TO drasi_user;
ALTER TABLE "Room" OWNER TO drasi_user;

-- Grant permissions to drasi_user.
GRANT USAGE ON SCHEMA public TO drasi_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO drasi_user;

-- Logical-replication publication the Drasi postgres source subscribes to.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'drasi_building_comfort_pub') THEN
        CREATE PUBLICATION drasi_building_comfort_pub FOR TABLE "Building", "Floor", "Room";
    END IF;
END
$$;

-- Seed the building hierarchy: 1 building, 3 floors, 9 rooms.
-- Every room starts comfortable (temperature=70, humidity=40, co2=10),
-- which yields a comfort level of floor(50 + (70-72) + (40-42) + 0) = 46.
INSERT INTO "Building" (id, name)
SELECT * FROM (VALUES ('building_01', 'Building 01')) AS d(id, name)
WHERE NOT EXISTS (SELECT 1 FROM "Building");

INSERT INTO "Floor" (id, name, building_id)
SELECT * FROM (VALUES
    ('floor_01_01', 'Floor 01', 'building_01'),
    ('floor_01_02', 'Floor 02', 'building_01'),
    ('floor_01_03', 'Floor 03', 'building_01')
) AS d(id, name, building_id)
WHERE NOT EXISTS (SELECT 1 FROM "Floor");

INSERT INTO "Room" (id, name, temperature, humidity, co2, floor_id)
SELECT * FROM (VALUES
    ('room_01_01_01', 'Room 01', 70, 40, 10, 'floor_01_01'),
    ('room_01_01_02', 'Room 02', 70, 40, 10, 'floor_01_01'),
    ('room_01_01_03', 'Room 03', 70, 40, 10, 'floor_01_01'),
    ('room_01_02_01', 'Room 01', 70, 40, 10, 'floor_01_02'),
    ('room_01_02_02', 'Room 02', 70, 40, 10, 'floor_01_02'),
    ('room_01_02_03', 'Room 03', 70, 40, 10, 'floor_01_02'),
    ('room_01_03_01', 'Room 01', 70, 40, 10, 'floor_01_03'),
    ('room_01_03_02', 'Room 02', 70, 40, 10, 'floor_01_03'),
    ('room_01_03_03', 'Room 03', 70, 40, 10, 'floor_01_03')
) AS d(id, name, temperature, humidity, co2, floor_id)
WHERE NOT EXISTS (SELECT 1 FROM "Room");

-- The Drasi Postgres source creates and manages its own logical replication
-- slot on first connect, so we don't create one here.

-- Summary.
SET client_min_messages = NOTICE;
DO $$
BEGIN
    RAISE NOTICE 'Building Comfort database initialized successfully!';
    RAISE NOTICE 'Tables: Building, Floor, Room';
    RAISE NOTICE 'Publication: drasi_building_comfort_pub';
END
$$;
