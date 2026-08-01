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

-- Curbside Pickup Tutorial - Physical Operations (MySQL)
--
-- Tracks the pickup vehicles. A driver updates their `location` to 'Curbside'
-- when they arrive at the pickup zone. The Drasi MySQL source captures changes
-- by streaming the binary log (binlog), which the container enables with
-- ROW-based logging, full row images/metadata and GTID mode (see
-- docker-compose.yml). The `drasi_user` (created from MYSQL_USER) is granted
-- replication privileges below so it can read the binlog.
--
-- The table is `vehicles`; the Drasi source is configured with
-- `tables: [vehicles]`, which yields the node label `vehicles`, matching
-- (v:vehicles) in the Cypher continuous queries.

USE PhysicalOperations;

-- vehicles table: one row per pickup vehicle. `plate` is the natural key and the
-- join key to the orders table in PostgreSQL.
DROP TABLE IF EXISTS vehicles;

CREATE TABLE vehicles (
    plate         VARCHAR(10)  NOT NULL PRIMARY KEY,
    driver_name   VARCHAR(50)  NOT NULL,
    customer_name VARCHAR(50)  NOT NULL,
    make          VARCHAR(50)  NOT NULL,
    model         VARCHAR(50)  NOT NULL,
    color         VARCHAR(30)  NOT NULL,
    location      VARCHAR(20)  NOT NULL DEFAULT 'Parking'
);

-- Seed three vehicles, all parked. The plates match the seeded orders in the
-- PostgreSQL database so the PICKUP_BY join lines up.
INSERT INTO vehicles (plate, driver_name, customer_name, make, model, color, location) VALUES
    ('A1234', 'Elijah Brooks', 'Sophia Carter', 'Toyota', 'Camry', 'Blue',  'Parking'),
    ('B5678', 'Isabella Reed', 'Mason Rivera',  'Ford',   'F-150', 'Red',   'Parking'),
    ('C9876', 'Liam Bennett',  'Ava Mitchell',  'Honda',  'Civic', 'Black', 'Parking');

-- Grant the Drasi user the privileges it needs to stream the binlog. MYSQL_USER
-- (drasi_user) already exists with full access to the PhysicalOperations
-- database; it additionally needs the server-wide replication privileges to open
-- a binlog stream.
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'drasi_user'@'%';
FLUSH PRIVILEGES;
