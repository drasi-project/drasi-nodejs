import type { QuerySpec } from '@shared/queries';
import { formatCell, signClass, useQuery } from '../api';

/** A single query rendered as a live-updating table. */
export function QueryPanel({ spec }: { spec: QuerySpec }): JSX.Element {
  const rows = useQuery(spec);

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>{spec.title}</h2>
        <span className="panel-desc">{spec.description}</span>
        <span className="panel-count">{rows.length} rows</span>
      </header>
      <div className="panel-body">
        {rows.length === 0 ? (
          <p className="empty">Waiting for data…</p>
        ) : (
          <table>
            <thead>
              <tr>
                {spec.columns.map((c) => (
                  <th key={c.field} className={c.format && c.format !== 'currency' ? 'num' : c.format === 'currency' ? 'num' : ''}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={String(row[spec.key] ?? i)}>
                  {spec.columns.map((c) => {
                    const v = row[c.field];
                    const numeric = c.format !== undefined;
                    return (
                      <td key={c.field} className={`${numeric ? 'num' : ''} ${signClass(v, c)}`.trim()}>
                        {formatCell(v, c)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
