import { useState } from 'react';
import { drasi, useComponentList } from '../api';
import { useEngine } from '../App';
import { Empty, Field, JsonEditor, StatusBadge, isValidJson } from '../components/ui';

export function ReactionsView(): JSX.Element {
  const { kinds, reportError } = useEngine();
  const { items } = useComponentList(drasi.listReactions);
  const { items: queries } = useComponentList(drasi.listQueries);

  const [kind, setKind] = useState('');
  const [id, setId] = useState('');
  const [config, setConfig] = useState('{}');
  const [selectedQueries, setSelectedQueries] = useState<string[]>([]);

  const toggleQuery = (qid: string): void =>
    setSelectedQueries((cur) => (cur.includes(qid) ? cur.filter((q) => q !== qid) : [...cur, qid]));

  async function addReaction(): Promise<void> {
    if (!kind || !id) return reportError('kind and id are required');
    if (selectedQueries.length === 0) return reportError('select at least one query');
    if (!isValidJson(config)) return reportError('config is not valid JSON');
    try {
      await drasi.addReaction({ kind, id, queries: selectedQueries, config: JSON.parse(config || '{}') });
      setId('');
    } catch (e) {
      reportError(e);
    }
  }

  return (
    <div className="view">
      <div className="view-header">
        <h2>Reactions</h2>
      </div>

      <section className="group">
        <div className="card">
          <h3>Add reaction</h3>
          <p className="hint">
            Tip: live query results are already streamed to the Queries tab via a built-in JS
            reaction — add a plugin reaction here to drive external systems.
          </p>
          <div className="row">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">— select —</option>
                {kinds.reactions.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Id">
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-reaction" />
            </Field>
          </div>
          <Field label="Queries">
            <div className="checks">
              {queries.length === 0 && <span className="hint">no queries yet</span>}
              {queries.map((q) => (
                <label key={q.id} className="check">
                  <input
                    type="checkbox"
                    checked={selectedQueries.includes(q.id)}
                    onChange={() => toggleQuery(q.id)}
                  />
                  {q.id}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Config (JSON)">
            <JsonEditor value={config} onChange={setConfig} />
          </Field>
          <button className="primary" onClick={addReaction}>
            Add reaction
          </button>
        </div>
      </section>

      <section className="group">
        <h3 className="group-title">Reactions</h3>
        {items.length === 0 ? (
          <Empty>No reactions yet.</Empty>
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
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="actions">
                    <button onClick={() => drasi.startReaction(r.id).catch(reportError)}>Start</button>
                    <button onClick={() => drasi.stopReaction(r.id).catch(reportError)}>Stop</button>
                    <button
                      className="danger"
                      onClick={() => drasi.removeReaction(r.id, false).catch(reportError)}
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
