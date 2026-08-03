// Downloads Drasi plugins from the OCI registry (ghcr.io/drasi-project) at
// startup — they are never baked into the app. Uses the engine's platform-aware
// installPlugin (same resolver as drasi-server auto-install). Verified compatible
// with this engine build: source/postgres + bootstrap/postgres.

import type { Engine } from './engine-host.js';

/** Plugins this demo needs: the Postgres CDC source + its bootstrap provider. */
const REQUIRED = ['source/postgres', 'bootstrap/postgres'] as const;

/**
 * Ensure all required plugins are present (installing any that are missing) and
 * register them with the engine. Cached under `dir` across launches — install is
 * skipped when the kind is already loadable from a previous download.
 */
export async function ensurePlugins(engine: Engine, dir: string): Promise<void> {
  // Pick up anything already cached from a previous run.
  await engine.loadPlugins(dir);
  const kinds = engine.pluginKinds() as {
    sources: string[];
    reactions: string[];
    bootstrap: string[];
  };

  const hasKind = (ref: string): boolean => {
    const [type, kind] = ref.split('/');
    if (type === 'source') return kinds.sources.includes(kind);
    if (type === 'bootstrap') return kinds.bootstrap.includes(kind);
    if (type === 'reaction') return kinds.reactions.includes(kind);
    return false;
  };

  let installed = false;
  for (const ref of REQUIRED) {
    if (hasKind(ref)) continue;
    console.log(`[plugins] installing ${ref}`);
    await engine.installPlugin(ref, dir);
    installed = true;
  }

  // Re-scan if anything new landed so kinds are registered before start.
  if (installed) await engine.loadPlugins(dir);
}
