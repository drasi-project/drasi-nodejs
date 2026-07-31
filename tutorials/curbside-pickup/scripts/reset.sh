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

# Reset Script
# Returns every order to 'preparing' (PostgreSQL) and every vehicle to 'Parking'
# (MySQL) — the same thing the UI's Reset button does, but from the CLI. Drasi
# observes both writes through CDC and clears the Matched / Delayed panels.

set -e

PG_CONTAINER="${POSTGRES_CONTAINER:-curbside-pickup-nodejs-postgres}"
PG_DB="${POSTGRES_DATABASE:-RetailOperations}"
PG_USER="${POSTGRES_USER:-drasi_user}"

MYSQL_CONTAINER="${MYSQL_CONTAINER:-curbside-pickup-nodejs-mysql}"
MYSQL_DB="${MYSQL_DATABASE:-PhysicalOperations}"
MYSQL_USER="${MYSQL_USER:-drasi_user}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-drasi_password}"

for c in "$PG_CONTAINER" "$MYSQL_CONTAINER"; do
    if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
        echo "Error: the ${c} container is not running. Run 'npm run db:up' first."
        exit 1
    fi
done

echo "Resetting all orders to 'preparing' (PostgreSQL)..."
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c \
    "UPDATE orders SET status='preparing';"

echo "Resetting all vehicles to 'Parking' (MySQL)..."
docker exec "$MYSQL_CONTAINER" mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DB" \
    -e "UPDATE vehicles SET location='Parking';"

echo "Done."
