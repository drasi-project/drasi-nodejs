// Downloads Drasi plugins from the OCI registry (ghcr.io/drasi-project) at
// startup — they are never baked into the app. Mirrors drasi-server's
// `autoInstallPlugins`. Verified compatible with this engine build:
// source/postgres + bootstrap/postgres load cleanly.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from './engine-host.js';

const REGISTRY = 'ghcr.io/drasi-project';

/** Plugins this demo needs: the Postgres CDC source + its bootstrap provider. */
const REQUIRED: Array<{ repo: string; type: string; kind: string }> = [
  { repo: 'source/postgres', type: 'source', kind: 'postgres' },
  { repo: 'bootstrap/postgres', type: 'bootstrap', kind: 'postgres' },
];

/** Primary + fallback OCI arch suffixes for the current platform. */
function platformSuffixes(): { primary: string; fallbacks: string[] } {
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
function nativeName(type: string, kind: string): string {
  const base = `drasi_${type}_${kind.replace(/-/g, '_')}`;
  if (process.platform === 'win32') return `${base}.dll`;
  if (process.platform === 'darwin') return `lib${base}.dylib`;
  return `lib${base}.so`;
}

/** Pick the newest tag for this platform from a repo's tag list. */
function newestTag(tags: string[]): string | null {
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
 * missing) and register them with the engine. Returns the registered kinds.
 */
export async function ensurePlugins(engine: Engine, dir: string): Promise<void> {
  for (const { repo, type, kind } of REQUIRED) {
    const filename = nativeName(type, kind);
    if (existsSync(join(dir, filename))) continue; // cached from a previous run

    const tags = (await engine.listPluginTags(repo)) as string[];
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
