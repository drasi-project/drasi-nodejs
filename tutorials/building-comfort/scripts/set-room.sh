#!/bin/bash
# Copyright 2025 The Drasi Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Set Room Script
# Updates a room's temperature, humidity and co2 by writing straight to
# PostgreSQL. Drasi's Postgres source captures the change via CDC and the UI
# updates in real time. (The web UI does the same thing through the app; this
# script is a shell equivalent that talks only to the database.)

set -e

CONTAINER="${POSTGRES_CONTAINER:-building-comfort-nodejs-postgres}"
DB="${POSTGRES_DATABASE:-building_comfort}"
DB_USER="${POSTGRES_USER:-drasi_user}"

ROOM_ID="${1:-}"
TEMPERATURE="${2:-}"
HUMIDITY="${3:-}"
CO2="${4:-}"

if [ -z "$ROOM_ID" ] || [ -z "$TEMPERATURE" ] || [ -z "$HUMIDITY" ] || [ -z "$CO2" ]; then
    echo "Usage: $0 <room_id> <temperature> <humidity> <co2>"
    echo
    echo "Examples:"
    echo "  $0 room_01_01_01 72 42 10     # comfortable (comfort level ~50)"
    echo "  $0 room_01_02_03 80 40 10     # too hot     (comfort level > 50)"
    echo
    echo "Room ids: room_01_<floor>_<room>, floors 01-03, rooms 01-03"
    exit 1
fi

# Validate the room id so a malformed value can't be used to inject SQL.
if ! printf '%s' "$ROOM_ID" | grep -Eq '^[A-Za-z0-9_]+$'; then
    echo "Error: invalid room id '$ROOM_ID' (expected letters, digits, and underscores)."
    exit 1
fi

for value in "$TEMPERATURE" "$HUMIDITY" "$CO2"; do
    if ! printf '%s' "$value" | grep -Eq '^-?[0-9]+$'; then
        echo "Error: temperature, humidity and co2 must be integers (got '$value')."
        exit 1
    fi
done

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: the ${CONTAINER} container is not running. Run 'npm run db:up' first."
    exit 1
fi

echo "Setting $ROOM_ID -> temperature=$TEMPERATURE humidity=$HUMIDITY co2=$CO2"

docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -c \
    "UPDATE \"Room\" SET temperature=$TEMPERATURE, humidity=$HUMIDITY, co2=$CO2 WHERE id='$ROOM_ID' RETURNING id, name, temperature, humidity, co2;"

echo
echo "Done. Watch the UI at http://localhost:${WEB_PORT:-3000}"
