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

# Set Order Status Script
# Sets an order's status in PostgreSQL (Retail Operations). This is the CLI
# equivalent of the UI's order toggle: a plain SQL UPDATE that Drasi observes
# through CDC.
#
#   ./scripts/set-order.sh <order_id> <preparing|ready>

set -e

CONTAINER="${POSTGRES_CONTAINER:-curbside-pickup-nodejs-postgres}"
DB="${POSTGRES_DATABASE:-RetailOperations}"
DB_USER="${POSTGRES_USER:-drasi_user}"

ORDER_ID="${1:-}"
STATUS="${2:-}"

if [ -z "$ORDER_ID" ] || [ -z "$STATUS" ]; then
    echo "Usage: $0 <order_id> <preparing|ready>"
    exit 1
fi

if ! printf '%s' "$ORDER_ID" | grep -Eq '^[0-9]+$'; then
    echo "Error: invalid order id '$ORDER_ID' (expected a number)."
    exit 1
fi

if [ "$STATUS" != "preparing" ] && [ "$STATUS" != "ready" ]; then
    echo "Error: invalid status '$STATUS' (expected 'preparing' or 'ready')."
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: the ${CONTAINER} container is not running. Run 'npm run db:up' first."
    exit 1
fi

echo "Setting order $ORDER_ID to '$STATUS' (PostgreSQL)..."
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -c \
    "UPDATE orders SET status='$STATUS' WHERE id=$ORDER_ID;"

echo "Done."
