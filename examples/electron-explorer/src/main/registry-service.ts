// Registry service: live plugin discovery + install against ghcr.io/drasi-project,
// using the engine's OCI methods (listPluginTags / pullPlugin / loadPlugins).

import { getEngine, getPluginsDir } from './engine-host.js';
import type {
  DirectoryEntry,
  InstallResult,
  PluginKinds,
  PluginType,
  PluginVersion,
} from '../shared/types.js';

const REGISTRY = 'ghcr.io/drasi-project';
const DIRECTORY_REPO = 'drasi-plugin-directory';

/** Plugin types the explorer can create components from. */
const SUPPORTED_TYPES: PluginType[] = ['source', 'reaction', 'bootstrap'];

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

/** Native cdylib filename/extension for the current platform. */
function nativeName(type: PluginType, kind: string): string {
  const k = kind.replace(/-/g, '_');
  const base = `drasi_${type}_${k}`;
  if (process.platform === 'win32') return `${base}.dll`;
  if (process.platform === 'darwin') return `lib${base}.dylib`;
  return `lib${base}.so`;
}

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

function compareSemver(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** List installable versions of a plugin matched to the current platform. */
export async function listVersions(repository: string): Promise<PluginVersion[]> {
  const engine = getEngine();
  const tags = (await engine.listPluginTags(repository)) as string[];
  const { primary, fallbacks } = platformSuffixes();

  const collect = (suffix: string): PluginVersion[] =>
    tags
      .filter((t) => t.endsWith(`-${suffix}`))
      .map((tag) => ({
        version: tag.slice(0, tag.length - suffix.length - 1),
        tag,
        reference: `${REGISTRY}/${repository}:${tag}`,
      }));

  let versions = collect(primary);
  for (const fb of fallbacks) {
    if (versions.length === 0) versions = collect(fb);
  }
  versions.sort((a, b) => compareSemver(b.version, a.version));
  return versions;
}

/** Download a plugin to the plugins dir and register it. */
export async function installPlugin(
  reference: string,
  type: PluginType,
  kind: string,
): Promise<InstallResult> {
  const engine = getEngine();
  const dir = getPluginsDir();
  const filename = nativeName(type, kind);
  const result = (await engine.pullPlugin(reference, dir, filename)) as {
    path: string;
    verification: string;
  };
  await engine.loadPlugins(dir);
  const kinds = (await engine.pluginKinds()) as PluginKinds;
  return { path: result.path, verification: result.verification, kinds };
}

/** Register plugins already present in a local folder (copy not performed). */
export async function importLocalPlugins(dir: string): Promise<PluginKinds> {
  const engine = getEngine();
  await engine.loadPlugins(dir);
  return (await engine.pluginKinds()) as PluginKinds;
}
