// Registry service: live plugin discovery + install against ghcr.io/drasi-project,
// using the engine's platform-aware installPlugin (and listPluginTags for the
// directory catalog).

import { getEngine, getPluginsDir } from './engine-host.js';
import type { DirectoryEntry, InstallResult, PluginKinds, PluginType } from '../shared/types.js';

const DIRECTORY_REPO = 'drasi-plugin-directory';

/** Plugin types the explorer can create components from. */
const SUPPORTED_TYPES: PluginType[] = ['source', 'reaction', 'bootstrap'];

/** Enumerate the live plugin directory, grouped into supported types. */
export async function browsePlugins(): Promise<DirectoryEntry[]> {
  const engine = getEngine();
  const tags = (await engine.listPluginTags(DIRECTORY_REPO)) as string[];
  const entries: DirectoryEntry[] = [];
  for (const tag of tags) {
    const dot = tag.indexOf('.');
    if (dot < 0) continue;
    const type = tag.slice(0, dot) as PluginType;
    const kind = tag.slice(dot + 1);
    if (!SUPPORTED_TYPES.includes(type)) continue;
    entries.push({ type, kind, repository: `${type}/${kind}` });
  }
  entries.sort((a, b) => a.type.localeCompare(b.type) || a.kind.localeCompare(b.kind));
  return entries;
}

/**
 * Download the latest host-compatible build of `repository` (e.g. "source/postgres")
 * into the plugins dir and register it. Platform, filename, and version selection
 * are handled by the engine.
 */
export async function installPlugin(repository: string): Promise<InstallResult> {
  const engine = getEngine();
  const dir = getPluginsDir();
  const result = (await engine.installPlugin(repository, dir)) as {
    path: string;
    resolved: InstallResult['resolved'];
    verification: InstallResult['verification'];
  };
  await engine.loadPlugins(dir);
  const kinds = engine.pluginKinds() as PluginKinds;
  return {
    path: result.path,
    resolved: result.resolved,
    verification: result.verification,
    kinds,
  };
}

/** Register plugins already present in a local folder (copy not performed). */
export async function importLocalPlugins(dir: string): Promise<PluginKinds> {
  const engine = getEngine();
  await engine.loadPlugins(dir);
  return engine.pluginKinds() as PluginKinds;
}
