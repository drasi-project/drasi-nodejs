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

# Move Vehicle Script
# Sets a vehicle's location in MySQL (Physical Operations). This is the CLI
# equivalent of the UI's vehicle toggle: a plain SQL UPDATE that Drasi observes
# through CDC.
#
#   ./scripts/move-vehicle.sh <plate> <Parking|Curbside>

set -e

CONTAINER="${MYSQL_CONTAINER:-curbside-pickup-nodejs-mysql}"
DB="${MYSQL_DATABASE:-PhysicalOperations}"
DB_USER="${MYSQL_USER:-drasi_user}"
DB_PASSWORD="${MYSQL_PASSWORD:-drasi_password}"

PLATE="${1:-}"
LOCATION="${2:-}"

if [ -z "$PLATE" ] || [ -z "$LOCATION" ]; then
    echo "Usage: $0 <plate> <Parking|Curbside>"
    exit 1
fi

if ! printf '%s' "$PLATE" | grep -Eq '^[A-Za-z0-9]+$'; then
    echo "Error: invalid plate '$PLATE' (expected letters and digits)."
    exit 1
fi

if [ "$LOCATION" != "Parking" ] && [ "$LOCATION" != "Curbside" ]; then
    echo "Error: invalid location '$LOCATION' (expected 'Parking' or 'Curbside')."
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: the ${CONTAINER} container is not running. Run 'npm run db:up' first."
    exit 1
fi

echo "Moving vehicle $PLATE to '$LOCATION' (MySQL)..."
docker exec "$CONTAINER" mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB" \
    -e "UPDATE vehicles SET location='$LOCATION' WHERE plate='$PLATE';"

echo "Done."
