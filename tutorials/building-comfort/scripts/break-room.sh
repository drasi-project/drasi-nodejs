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

# Break Room Script
# Pushes a single room out of the comfortable band (temperature=40, humidity=20,
# co2=700). Delegates to set-room.sh.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOM_ID="${1:-}"

if [ -z "$ROOM_ID" ]; then
    echo "Usage: $0 <room_id>"
    echo "Example: $0 room_01_01_01"
    exit 1
fi

exec bash "$SCRIPT_DIR/set-room.sh" "$ROOM_ID" 40 20 700
