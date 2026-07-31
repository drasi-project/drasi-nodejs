// Downloads the Drasi plugins this tutorial needs from the OCI registry
// (ghcr.io/drasi-project) on first run and caches them in a platform-specific
// subdirectory — they are never baked in. Mirrors drasi-server's
// `autoInstallPlugins`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = 'ghcr.io/drasi-project';

// The PostgreSQL CDC source + its bootstrap provider (for the Message feed), and
// the HTTP source + the ScriptFile bootstrap provider (for the location-tracker
// used by the cross-source join in the last step).
const REQUIRED = [
  { repo: 'source/postgres', type: 'source', kind: 'postgres' },
  { repo: 'bootstrap/postgres', type: 'bootstrap', kind: 'postgres' },
  { repo: 'source/http', type: 'source', kind: 'http' },
  { repo: 'bootstrap/scriptfile', type: 'bootstrap', kind: 'scriptfile' },
];

/** Primary + fallback OCI arch suffixes for the current platform. */
function platformSuffixes() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  switch (process.platform) {
    case 'win32':
      return { primary: `windows-msvc-${arch}`, fallbacks: [`windows-${arch}`] };
    case 'darwin':
      return { primary: `darwin-${arch}`, fallbacks: [] };
    default:
      return { primary: `linux-${arch}`, fallbacks: [] };
  }
}

/** Native cdylib filename for the current platform. */
function nativeName(type, kind) {
  const base = `drasi_${type}_${kind.replace(/-/g, '_')}`;
  if (process.platform === 'win32') return `${base}.dll`;
  if (process.platform === 'darwin') return `lib${base}.dylib`;
  return `lib${base}.so`;
}

/** Pick the newest tag for this platform from a repo's tag list. */
function newestTag(tags) {
  const { primary, fallbacks } = platformSuffixes();
  for (const suffix of [primary, ...fallbacks]) {
    const matched = tags
      .filter((t) => t.endsWith(`-${suffix}`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (matched.length > 0) return matched[0];
  }
  return null;
}

/**
 * Ensure all required plugins are present in `dir` (downloading any that are
 * missing) and register them with the engine.
 */
export async function ensurePlugins(engine, dir) {
  for (const { repo, type, kind } of REQUIRED) {
    const filename = nativeName(type, kind);
    if (existsSync(join(dir, filename))) continue; // cached from a previous run

    const tags = await engine.listPluginTags(repo);
    const tag = newestTag(tags);
    if (!tag) {
      throw new Error(
        `No ${repo} plugin published for this platform (${process.platform}/${process.arch}). ` +
          `Available tags: ${tags.slice(0, 8).join(', ')}…`,
      );
    }
    const reference = `${REGISTRY}/${repo}:${tag}`;
    console.log(`[plugins] downloading ${reference}`);
    await engine.pullPlugin(reference, dir, filename);
  }
  await engine.loadPlugins(dir);
}
