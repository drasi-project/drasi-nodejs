#!/bin/bash
# Post-create script for the Drasi Node.js Curbside Pickup tutorial.

set -e

echo "🔧 Initializing Drasi Node.js Curbside Pickup tutorial environment..."

# Resolve the tutorial directory from this script's location so it works
# regardless of the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TUTORIAL_DIR="$REPO_ROOT/tutorials/curbside-pickup"

# Install the tutorial's Node dependencies (pulls the prebuilt @drasi/lib addon
# for this platform — no Rust toolchain required).
echo "📦 Installing Node dependencies..."
cd "$TUTORIAL_DIR"
npm install

echo ""
echo "✅ Curbside Pickup tutorial environment is ready!"
echo "   Next: run 'npm run demo' (you are already in tutorials/curbside-pickup),"
echo "   then open http://localhost:3000 when it prints 'ready'."
