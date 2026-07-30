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

# Reset Room Script
# Returns a room -- or, with no argument, every room -- to comfortable defaults
# (temperature=70, humidity=40, co2=10).

set -e

CONTAINER="${POSTGRES_CONTAINER:-building-comfort-nodejs-postgres}"
DB="${POSTGRES_DATABASE:-building_comfort}"
DB_USER="${POSTGRES_USER:-drasi_user}"
ROOM_ID="${1:-}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: the ${CONTAINER} container is not running. Run 'npm run db:up' first."
    exit 1
fi

if [ -n "$ROOM_ID" ]; then
    if ! printf '%s' "$ROOM_ID" | grep -Eq '^[A-Za-z0-9_]+$'; then
        echo "Error: invalid room id '$ROOM_ID' (expected letters, digits, and underscores)."
        exit 1
    fi
    echo "Resetting $ROOM_ID to comfortable defaults (70 / 40 / 10)..."
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -c \
        "UPDATE \"Room\" SET temperature=70, humidity=40, co2=10 WHERE id='$ROOM_ID';"
else
    echo "Resetting ALL rooms to comfortable defaults (70 / 40 / 10)..."
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -c \
        "UPDATE \"Room\" SET temperature=70, humidity=40, co2=10;"
fi

echo "Done."
