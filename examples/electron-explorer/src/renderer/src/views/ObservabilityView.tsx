import { useState } from 'react';
import type { LogMessage } from '@shared/types';
import { drasi, useComponentList, useStream } from '../api';
import { useEngine } from '../App';
import { Empty, StatusBadge } from '../components/ui';

const MAX_LOGS = 500;

export function ObservabilityView(): JSX.Element {
  const { reportError } = useEngine();
  const sources = useComponentList(drasi.listSources);
  const queries = useComponentList(drasi.listQueries);
  const reactions = useComponentList(drasi.listReactions);

  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [filter, setFilter] = useState('');
  const [metrics, setMetrics] = useState<unknown>(null);
  const [metricTarget, setMetricTarget] = useState('lifecycle');

  useStream((env) => {
    if (env.kind !== 'log') return;
    const msg = env.payload as LogMessage;
    setLogs((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  });

  async function loadMetrics(): Promise<void> {
    try {
      if (metricTarget === 'lifecycle') setMetrics(await drasi.getLifecycleMetrics());
      else if (metricTarget.startsWith('q:')) setMetrics(await drasi.getQueryMetrics(metricTarget.slice(2)));
      else if (metricTarget.startsWith('r:')) setMetrics(await drasi.getReactionMetrics(metricTarget.slice(2)));
    } catch (e) {
      reportError(e);
    }
  }

  const shown = filter
    ? logs.filter((l) => l.component_id.includes(filter) || l.message.includes(filter))
    : logs;

  return (
    <div className="view">
      <div className="view-header">
        <h2>Observability</h2>
      </div>

      <section className="group three-col">
        <StatusCard title="Sources" items={sources.items} />
        <StatusCard title="Queries" items={queries.items} />
        <StatusCard title="Reactions" items={reactions.items} />
      </section>

      <section className="group">
        <div className="view-header">
          <h3 className="group-title">Metrics</h3>
          <div className="row">
            <select value={metricTarget} onChange={(e) => setMetricTarget(e.target.value)}>
              <option value="lifecycle">lifecycle (instance)</option>
              {queries.items.map((q) => (
                <option key={q.id} value={`q:${q.id}`}>
                  query: {q.id}
                </option>
              ))}
              {reactions.items.map((r) => (
                <option key={r.id} value={`r:${r.id}`}>
                  reaction: {r.id}
                </option>
              ))}
            </select>
            <button onClick={loadMetrics}>Load</button>
          </div>
        </div>
        {metrics ? (
          <pre className="code metrics">{JSON.stringify(metrics, null, 2)}</pre>
        ) : (
          <Empty>Pick a target and load metrics.</Empty>
        )}
      </section>

      <section className="group">
        <div className="view-header">
          <h3 className="group-title">Logs</h3>
          <div className="row">
            <input
              placeholder="filter by component or text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button onClick={() => setLogs([])}>Clear</button>
          </div>
        </div>
        <div className="logs">
          {shown.length === 0 ? (
            <Empty>No logs yet. Component/plugin logs stream here live.</Empty>
          ) : (
            shown.map((l, i) => (
              <div key={i} className={`log log-${l.level.toLowerCase()}`}>
                <span className="log-time">{new Date(l.timestamp).toLocaleTimeString()}</span>
                <span className="log-level">{l.level}</span>
                <span className="log-comp mono">{l.component_id}</span>
                <span className="log-msg">{l.message}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function StatusCard({
  title,
  items,
}: {
  title: string;
  items: { id: string; status: string }[];
}): JSX.Element {
  return (
    <div className="card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <Empty>none</Empty>
      ) : (
        <ul className="status-list">
          {items.map((it) => (
            <li key={it.id}>
              <span className="mono">{it.id}</span>
              <StatusBadge status={it.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
