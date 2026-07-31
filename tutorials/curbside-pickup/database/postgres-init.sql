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

-- Curbside Pickup Tutorial - Retail Operations (PostgreSQL)
--
-- Holds the customer orders. The retail team marks an order 'ready' when it is
-- prepared. The `orders` table is lower-case and unquoted so the node label
-- Drasi sees matches the Cypher continuous queries, which use (o:orders) and
-- o.status, o.plate, o.driver_name, o.customer_name without any change.

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
GRANT CREATE ON DATABASE "RetailOperations" TO drasi_user;
GRANT ALL PRIVILEGES ON DATABASE "RetailOperations" TO drasi_user;

-- Drop existing table if it exists.
DROP TABLE IF EXISTS orders CASCADE;

-- orders table: one row per customer order awaiting curbside pickup.
CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    customer_name VARCHAR(255) NOT NULL,
    driver_name   VARCHAR(255) NOT NULL,
    plate         VARCHAR(50)  NOT NULL,
    status        VARCHAR(50)  NOT NULL DEFAULT 'preparing'
);

-- Enforce the order status enum.
ALTER TABLE orders ADD CONSTRAINT chk_status CHECK (status IN ('preparing', 'ready'));

-- Set REPLICA IDENTITY to FULL so change events include every column.
ALTER TABLE orders REPLICA IDENTITY FULL;

-- Ensure drasi_user owns the table.
ALTER TABLE orders OWNER TO drasi_user;

-- Grant permissions to drasi_user.
GRANT USAGE ON SCHEMA public TO drasi_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO drasi_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO drasi_user;

-- Create the publication for logical replication. The replication slot itself is
-- NOT created here: the Drasi PostgreSQL source creates it on startup and takes a
-- consistent snapshot, so the rows seeded below are loaded once via bootstrap and
-- are not also replayed as change events (which would double-count them).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'drasi_curbside_pub') THEN
        CREATE PUBLICATION drasi_curbside_pub FOR TABLE orders;
    END IF;
END
$$;

-- Seed three orders, all 'preparing'. The plates match the seeded vehicles in the
-- MySQL database so the PICKUP_BY join lines up.
INSERT INTO orders (customer_name, driver_name, plate, status)
SELECT * FROM (VALUES
    ('Sophia Carter', 'Elijah Brooks',  'A1234', 'preparing'),
    ('Mason Rivera',  'Isabella Reed',  'B5678', 'preparing'),
    ('Ava Mitchell',  'Liam Bennett',   'C9876', 'preparing')
) AS d(customer_name, driver_name, plate, status)
WHERE NOT EXISTS (SELECT 1 FROM orders);

-- Summary.
SET client_min_messages = NOTICE;
DO $$
BEGIN
    RAISE NOTICE 'Retail Operations database initialized successfully!';
    RAISE NOTICE 'Table: orders';
    RAISE NOTICE 'Publication: drasi_curbside_pub';
END
$$;
