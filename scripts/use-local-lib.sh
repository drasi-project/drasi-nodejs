#!/bin/bash
# use-local-lib.sh — build @drasi/lib from this repo and point every tutorial at
# that local build, so the tutorials can be run and tested WITHOUT publishing to
# npm.
#
# After `npm run build`, the repo root is a complete @drasi/lib package for the
# current platform (index.js loads the local drasi.<triple>.node it just built).
# For each tutorial this script:
#   1. builds the native addon once, at the repo root;
#   2. installs the tutorial's OTHER dependencies (express / pg / mysql2). The
#      tutorials pin an unpublished @drasi/lib version, so it is temporarily
#      removed from package.json during the install, then restored;
#   3. replaces node_modules/@drasi/lib with a symlink to the repo root.
#
# Re-run this after `npm run build`, or after any real `npm install` inside a
# tutorial (a normal install replaces the symlink with the published package).
#
# In a dev container / Codespace, run this INSIDE the container so the Linux
# .node is built; the macOS binary will not load on Linux.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TUTORIALS=(getting-started building-comfort curbside-pickup)

echo "🔨 Building @drasi/lib native addon (this can take a minute)…"
if ! ( cd "$ROOT" && npm run build ); then
  echo "❌ Failed to build @drasi/lib. Fix the build and re-run." >&2
  exit 1
fi

for t in "${TUTORIALS[@]}"; do
  dir="$ROOT/tutorials/$t"
  if [ ! -d "$dir" ]; then
    echo "⚠️  skipping $t (not found)"
    continue
  fi
  echo ""
  echo "🔗 $t"
  cd "$dir"

  # Install the tutorial's other dependencies. The @drasi/lib pin is an
  # unpublished version, so temporarily drop it from package.json (restoring it
  # afterwards no matter what) and install the rest without writing a lockfile.
  others=$(node -p "Object.keys(require('./package.json').dependencies||{}).filter((d)=>d!=='@drasi/lib').length")
  if [ "$others" != "0" ]; then
    cp package.json .pkg.bak
    node -e "const fs=require('fs');const p=require('./package.json');delete p.dependencies['@drasi/lib'];fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
    if npm install --no-save --no-audit --no-fund --no-package-lock; then
      echo "   installed other dependencies"
    else
      echo "   ⚠️  could not install other dependencies — continuing to link @drasi/lib"
    fi
    mv -f .pkg.bak package.json
  fi

  # Point @drasi/lib at the local repo build.
  rm -rf node_modules/@drasi/lib
  mkdir -p node_modules/@drasi
  ln -sfn "$ROOT" node_modules/@drasi/lib
  node -e "const v=require('@drasi/lib/package.json').version;console.log('   linked @drasi/lib v'+v+' -> '+require('fs').realpathSync('node_modules/@drasi/lib'))"
done

echo ""
echo "✅ All tutorials linked to the local @drasi/lib build."
echo "   Run one with:  cd tutorials/<name> && npm run demo   (or npm start)"
