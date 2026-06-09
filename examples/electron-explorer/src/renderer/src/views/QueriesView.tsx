import { useEffect, useMemo, useState } from 'react';
import type { QueryResultEvent, ResultDiff } from '@shared/types';
import { drasi, useComponentList, useStream } from '../api';
import { useEngine } from '../App';
import { Empty, Field, StatusBadge } from '../components/ui';

function rowKey(d: Extract<ResultDiff, { type: 'ADD' | 'UPDATE' | 'DELETE' }>): string {
  if (d.row_signature !== undefined) return String(d.row_signature);
  const payload = d.type === 'UPDATE' ? d.after : d.data;
  return JSON.stringify(payload);
}

export function QueriesView(): JSX.Element {
  const { reportError } = useEngine();
  const { items } = useComponentList(drasi.listQueries);
  const { items: sources } = useComponentList(drasi.listSources);

  const [id, setId] = useState('');
  const [language, setLanguage] = useState<'cypher' | 'gql'>('cypher');
  const [text, setText] = useState('MATCH (n) RETURN n');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);

  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<Map<string, unknown>>(new Map());

  // Reset the live table when the inspected query changes.
  useEffect(() => setRows(new Map()), [selected]);

  useStream((env) => {
    if (env.kind !== 'result' || env.id !== selected) return;
    const result = env.payload as QueryResultEvent;
    setRows((prev) => {
      const next = new Map(prev);
      for (const d of result.results) {
        if (d.type === 'ADD' || d.type === 'UPDATE') next.set(rowKey(d), d.type === 'UPDATE' ? d.after : d.data);
        else if (d.type === 'DELETE') next.delete(rowKey(d));
      }
      return next;
    });
  });

  async function addQuery(): Promise<void> {
    if (!id || !text) return reportError('id and query text are required');
    if (selectedSources.length === 0) return reportError('select at least one source');
    try {
      await drasi.addQuery({ id, query: text, sources: selectedSources, language });
      setId('');
    } catch (e) {
      reportError(e);
    }
  }

  async function loadSnapshot(): Promise<void> {
    if (!selected) return;
    try {
      const snap = await drasi.getQueryResults(selected);
      const m = new Map<string, unknown>();
      snap.forEach((r, i) => m.set(`snapshot-${i}`, r));
      setRows(m);
    } catch (e) {
      reportError(e);
    }
  }

  const toggleSource = (sid: string): void =>
    setSelectedSources((cur) => (cur.includes(sid) ? cur.filter((s) => s !== sid) : [...cur, sid]));

  const columns = useMemo(() => {
    const cols = new Set<string>();
    for (const v of rows.values()) {
      if (v && typeof v === 'object') Object.keys(v as object).forEach((k) => cols.add(k));
    }
    return [...cols];
  }, [rows]);

  return (
    <div className="view">
      <div className="view-header">
        <h2>Queries</h2>
      </div>

      <section className="group">
        <div className="card">
          <h3>Add continuous query</h3>
          <div className="row">
            <Field label="Id">
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-query" />
            </Field>
            <Field label="Language">
              <select value={language} onChange={(e) => setLanguage(e.target.value as 'cypher' | 'gql')}>
                <option value="cypher">cypher</option>
                <option value="gql">gql</option>
              </select>
            </Field>
          </div>
          <Field label="Query">
            <textarea
              className="code"
              rows={4}
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Field label="Sources">
            <div className="checks">
              {sources.length === 0 && <span className="hint">no sources yet</span>}
              {sources.map((s) => (
                <label key={s.id} className="check">
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(s.id)}
                    onChange={() => toggleSource(s.id)}
                  />
                  {s.id}
                </label>
              ))}
            </div>
          </Field>
          <button className="primary" onClick={addQuery}>
            Add query
          </button>
        </div>
      </section>

      <section className="group">
        <h3 className="group-title">Queries</h3>
        {items.length === 0 ? (
          <Empty>No queries yet.</Empty>
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
              {items.map((q) => (
                <tr key={q.id} className={q.id === selected ? 'selected-row' : ''}>
                  <td className="mono">{q.id}</td>
                  <td>
                    <StatusBadge status={q.status} />
                  </td>
                  <td className="actions">
                    <button onClick={() => setSelected(q.id)}>Inspect</button>
                    <button onClick={() => drasi.startQuery(q.id).catch(reportError)}>Start</button>
                    <button onClick={() => drasi.stopQuery(q.id).catch(reportError)}>Stop</button>
                    <button className="danger" onClick={() => drasi.removeQuery(q.id).catch(reportError)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && (
        <section className="group">
          <div className="view-header">
            <h3 className="group-title">
              Live results — <span className="mono">{selected}</span>
            </h3>
            <button onClick={loadSnapshot}>Load snapshot</button>
          </div>
          {rows.size === 0 ? (
            <Empty>Waiting for results… (changes stream in live)</Empty>
          ) : (
            <table className="grid">
              <thead>
                <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {[...rows.entries()].map(([k, v]) => (
                  <tr key={k}>
                    {columns.map((c) => (
                      <td key={c} className="mono">
                        {formatCell((v as Record<string, unknown>)?.[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
