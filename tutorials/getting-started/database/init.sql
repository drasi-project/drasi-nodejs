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

-- Getting Started Tutorial Database Schema (@drasi/lib edition)
--
-- A single "Message" table — imagine a simple live message feed. Table and
-- column names are quoted and PascalCase ("Message", "MessageId", "From",
-- "Message") so the node label and properties Drasi sees match the Cypher
-- continuous queries (which use (m:Message) and m.MessageId / m.From /
-- m.Message) without any change to the query text. ("From" is also a SQL
-- reserved word, so it must be quoted everywhere.)

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

GRANT CREATE ON DATABASE getting_started TO drasi_user;
GRANT ALL PRIVILEGES ON DATABASE getting_started TO drasi_user;

-- The Message table.
DROP TABLE IF EXISTS "Message" CASCADE;
CREATE TABLE "Message" (
    "MessageId" SERIAL PRIMARY KEY,
    "From"      VARCHAR(50)  NOT NULL,
    "Message"   VARCHAR(200) NOT NULL,
    "CreatedAt" TIMESTAMP    NOT NULL DEFAULT now()
);

-- Include every column in change events (needed for reliable CDC of updates).
ALTER TABLE "Message" REPLICA IDENTITY FULL;

-- Seed the initial message feed.
INSERT INTO "Message" ("From", "Message") VALUES
    ('Buzz Lightyear',  'To infinity and beyond!'),
    ('Brian Kernighan', 'Hello World'),
    ('Antoninus',       'I am Spartacus'),
    ('David',           'I am Spartacus');

-- Grants for the Drasi CDC user.
GRANT USAGE ON SCHEMA public TO drasi_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO drasi_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO drasi_user;

-- Logical-replication publication for the Message table. The Drasi PostgreSQL
-- source creates its replication slot on first connect, so we don't create one
-- here.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_publication WHERE pubname = 'drasi_getting_started_pub') THEN
        CREATE PUBLICATION drasi_getting_started_pub FOR TABLE "Message";
    END IF;
END
$$;

\set QUIET off
DO $$ BEGIN RAISE NOTICE 'Getting Started database initialized successfully!'; END $$;
