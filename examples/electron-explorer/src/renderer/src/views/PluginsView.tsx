import { useEffect, useState } from 'react';
import type { DirectoryEntry, PluginVersion } from '@shared/types';
import { drasi } from '../api';
import { useEngine } from '../App';
import { Banner, Empty } from '../components/ui';

export function PluginsView(): JSX.Element {
  const { kinds, refreshKinds, reportError } = useEngine();
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [versions, setVersions] = useState<Record<string, PluginVersion[]>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    drasi.browsePlugins().then(setEntries).catch(reportError);
  }, [reportError]);

  const installedKinds = (type: string): string[] =>
    type === 'source' ? kinds.sources : type === 'reaction' ? kinds.reactions : kinds.bootstrap;

  async function loadVersions(e: DirectoryEntry): Promise<void> {
    if (versions[e.repository]) return;
    try {
      const v = await drasi.listVersions(e.repository);
      setVersions((m) => ({ ...m, [e.repository]: v }));
      if (v[0]) setSelected((m) => ({ ...m, [e.repository]: v[0].reference }));
    } catch (err) {
      reportError(err);
    }
  }

  async function install(e: DirectoryEntry): Promise<void> {
    const reference = selected[e.repository] ?? versions[e.repository]?.[0]?.reference;
    if (!reference) {
      reportError(`No installable version for ${e.repository} on this platform`);
      return;
    }
    setBusy(e.repository);
    setInfo(null);
    try {
      const result = await drasi.installPlugin(reference, e.type, e.kind);
      await refreshKinds();
      setInfo(`Installed ${e.type}/${e.kind} → ${result.path} (signature: ${result.verification})`);
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
                <th>Version</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries
                .filter((e) => e.type === type)
                .map((e) => {
                  const installed = installedKinds(e.type).includes(e.kind);
                  const v = versions[e.repository];
                  return (
                    <tr key={e.repository}>
                      <td className="mono">{e.kind}</td>
                      <td>
                        {v ? (
                          v.length === 0 ? (
                            <span className="hint">no build for this platform</span>
                          ) : (
                            <select
                              value={selected[e.repository] ?? v[0].reference}
                              onChange={(ev) =>
                                setSelected((m) => ({ ...m, [e.repository]: ev.target.value }))
                              }
                            >
                              {v.map((pv) => (
                                <option key={pv.tag} value={pv.reference}>
                                  {pv.version}
                                </option>
                              ))}
                            </select>
                          )
                        ) : (
                          <button className="link" onClick={() => loadVersions(e)}>
                            show versions
                          </button>
                        )}
                      </td>
                      <td>{installed ? <span className="badge badge-running">installed</span> : '—'}</td>
                      <td>
                        <button
                          disabled={busy === e.repository || (v && v.length === 0)}
                          onClick={() => install(e)}
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
