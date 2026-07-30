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

# Start Demo Script
# Brings up PostgreSQL (seeded from init.sql), installs Node dependencies if
# needed, and runs the Building Comfort app in the foreground.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUTORIAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$TUTORIAL_DIR"

echo "🐘 Starting PostgreSQL..."
npm run db:up

if [ ! -d node_modules ]; then
    echo "📦 Installing Node dependencies..."
    npm install
fi

echo "🚀 Starting Building Comfort (Ctrl+C to stop)..."
echo "   Open http://localhost:${WEB_PORT:-3000} once it prints 'ready'."
exec npm start
