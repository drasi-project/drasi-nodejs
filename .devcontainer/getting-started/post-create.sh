#!/bin/bash
# Post-create script for the Drasi Node.js Getting Started tutorial.

set -e

echo "🔧 Initializing Drasi Node.js Getting Started tutorial environment..."

# Resolve the tutorial directory from this script's location so it works
# regardless of the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TUTORIAL_DIR="$REPO_ROOT/tutorials/getting-started"

# Install the tutorial's Node dependencies (pulls the prebuilt @drasi/lib addon
# for this platform — no Rust toolchain required).
echo "📦 Installing Node dependencies..."
cd "$TUTORIAL_DIR"
npm install

echo ""
echo "✅ Getting Started tutorial environment is ready!"
echo "   Next: run 'npm run demo' (you are already in tutorials/getting-started),"
echo "   then drive changes from a second terminal with 'docker exec ... psql' and 'curl'."
