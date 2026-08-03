import { useEffect, useState } from 'react';
import type { DirectoryEntry } from '@shared/types';
import { drasi } from '../api';
import { useEngine } from '../App';
import { Banner, Empty } from '../components/ui';

function formatVerification(v: { status: string }): string {
  return v.status;
}

export function PluginsView(): JSX.Element {
  const { kinds, refreshKinds, reportError } = useEngine();
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    drasi.browsePlugins().then(setEntries).catch(reportError);
  }, [reportError]);

  const installedKinds = (type: string): string[] =>
    type === 'source' ? kinds.sources : type === 'reaction' ? kinds.reactions : kinds.bootstrap;

  async function install(e: DirectoryEntry): Promise<void> {
    setBusy(e.repository);
    setInfo(null);
    try {
      // Bare repository ref — the engine picks the latest host-compatible build,
      // platform tag, and cdylib filename.
      const result = await drasi.installPlugin(e.repository);
      await refreshKinds();
      const ver = result.resolved?.version ? ` v${result.resolved.version}` : '';
      setInfo(
        `Installed ${e.repository}${ver} → ${result.path} (signature: ${formatVerification(result.verification)})`,
      );
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  }

  async function importLocal(): Promise<void> {
    const dir = await drasi.pickFolder();
    if (!dir) return;
    try {
      await drasi.importLocalPlugins(dir);
      await refreshKinds();
      setInfo(`Imported plugins from ${dir}`);
    } catch (err) {
      reportError(err);
    }
  }

  if (!entries) return <Empty>Loading plugin directory from ghcr.io/drasi-project…</Empty>;

  const groups: DirectoryEntry['type'][] = ['source', 'reaction', 'bootstrap'];

  return (
    <div className="view">
      <div className="view-header">
        <h2>Plugins</h2>
        <button onClick={importLocal}>Import from folder…</button>
      </div>
      {info && <Banner kind="info" message={info} onClose={() => setInfo(null)} />}

      {groups.map((type) => (
        <section key={type} className="group">
          <h3 className="group-title">{type}s</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries
                .filter((e) => e.type === type)
                .map((e) => {
                  const installed = installedKinds(e.type).includes(e.kind);
                  return (
                    <tr key={e.repository}>
                      <td className="mono">{e.kind}</td>
                      <td>
                        {installed ? (
                          <span className="badge badge-running">installed</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <button
                          disabled={busy === e.repository}
                          onClick={() => install(e)}
                          title="Install the latest build compatible with this engine"
                        >
                          {busy === e.repository ? 'Installing…' : installed ? 'Reinstall' : 'Install'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
