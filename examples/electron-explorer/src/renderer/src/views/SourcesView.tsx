import { useState } from 'react';
import { drasi, useComponentList } from '../api';
import { useEngine } from '../App';
import { Empty, Field, JsonEditor, StatusBadge, isValidJson } from '../components/ui';

export function SourcesView(): JSX.Element {
  const { kinds, reportError } = useEngine();
  const { items } = useComponentList(drasi.listSources);

  const [kind, setKind] = useState('');
  const [id, setId] = useState('');
  const [config, setConfig] = useState('{}');
  const [autoStart, setAutoStart] = useState(true);
  const [useBootstrap, setUseBootstrap] = useState(false);
  const [bootstrapKind, setBootstrapKind] = useState('');
  const [bootstrapConfig, setBootstrapConfig] = useState('{}');

  // JS source + push form
  const [jsId, setJsId] = useState('');
  const [pushTarget, setPushTarget] = useState('');
  const [pushDoc, setPushDoc] = useState(
    '{\n  "op": "insert",\n  "id": "n1",\n  "labels": ["Thing"],\n  "properties": { "name": "alpha" }\n}',
  );

  async function addSource(): Promise<void> {
    if (!kind || !id) return reportError('kind and id are required');
    if (!isValidJson(config)) return reportError('config is not valid JSON');
    try {
      await drasi.addSource({
        kind,
        id,
        config: JSON.parse(config || '{}'),
        autoStart,
        bootstrap: useBootstrap
          ? { kind: bootstrapKind, config: JSON.parse(bootstrapConfig || '{}') }
          : undefined,
      });
      setId('');
    } catch (e) {
      reportError(e);
    }
  }

  async function addJsSource(): Promise<void> {
    if (!jsId) return reportError('id is required');
    try {
      await drasi.addJsSource(jsId, true);
      setPushTarget(jsId);
      setJsId('');
    } catch (e) {
      reportError(e);
    }
  }

  async function push(): Promise<void> {
    if (!pushTarget) return reportError('select a source to push into');
    if (!isValidJson(pushDoc)) return reportError('change is not valid JSON');
    try {
      await drasi.pushChange(pushTarget, JSON.parse(pushDoc));
    } catch (e) {
      reportError(e);
    }
  }

  return (
    <div className="view">
      <div className="view-header">
        <h2>Sources</h2>
      </div>

      <section className="group two-col">
        <div className="card">
          <h3>Add plugin source</h3>
          <Field label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">— select —</option>
              {kinds.sources.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Id">
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-source" />
          </Field>
          <Field label="Config (JSON)">
            <JsonEditor value={config} onChange={setConfig} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
            auto-start
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={useBootstrap}
              onChange={(e) => setUseBootstrap(e.target.checked)}
            />
            attach bootstrap provider
          </label>
          {useBootstrap && (
            <>
              <Field label="Bootstrap kind">
                <select value={bootstrapKind} onChange={(e) => setBootstrapKind(e.target.value)}>
                  <option value="">— select —</option>
                  {kinds.bootstrap.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Bootstrap config (JSON)">
                <JsonEditor value={bootstrapConfig} onChange={setBootstrapConfig} rows={4} />
              </Field>
            </>
          )}
          <button className="primary" onClick={addSource}>
            Add source
          </button>
        </div>

        <div className="card">
          <h3>JavaScript source</h3>
          <p className="hint">A programmatic source you push graph changes into from the UI.</p>
          <Field label="Id">
            <input value={jsId} onChange={(e) => setJsId(e.target.value)} placeholder="js-source" />
          </Field>
          <button onClick={addJsSource}>Add JS source</button>

          <h4>Push a change</h4>
          <Field label="Into source">
            <select value={pushTarget} onChange={(e) => setPushTarget(e.target.value)}>
              <option value="">— select —</option>
              {items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Change (JSON)">
            <JsonEditor value={pushDoc} onChange={setPushDoc} rows={7} />
          </Field>
          <button onClick={push}>Push change</button>
        </div>
      </section>

      <section className="group">
        <h3 className="group-title">Running sources</h3>
        {items.length === 0 ? (
          <Empty>No sources yet.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Id</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="actions">
                    <button onClick={() => drasi.startSource(s.id).catch(reportError)}>Start</button>
                    <button onClick={() => drasi.stopSource(s.id).catch(reportError)}>Stop</button>
                    <button
                      className="danger"
                      onClick={() => drasi.removeSource(s.id, false).catch(reportError)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
