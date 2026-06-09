import { useEffect, useState } from 'react';
import { QUERIES } from '@shared/queries';
import { trading } from './api';
import { QueryPanel } from './panels/QueryPanel';

export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => trading.onError(setError), []);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Drasi Trading Demo</h1>
          <p className="subtitle">
            Embedded Drasi engine · PostgreSQL CDC + in-process price feed · synthetic joins ·
            live application reaction
          </p>
        </div>
      </header>

      {error && (
        <div className="banner error">
          <strong>Startup error:</strong> {error}
        </div>
      )}

      <main className="grid">
        {QUERIES.map((spec) => (
          <QueryPanel key={spec.id} spec={spec} />
        ))}
      </main>
    </div>
  );
}
