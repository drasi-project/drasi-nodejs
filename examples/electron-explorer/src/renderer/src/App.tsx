import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { PluginKinds } from '@shared/types';
import { drasi, errMessage } from './api';
import { Banner } from './components/ui';
import { PluginsView } from './views/PluginsView';
import { SourcesView } from './views/SourcesView';
import { QueriesView } from './views/QueriesView';
import { ReactionsView } from './views/ReactionsView';
import { ObservabilityView } from './views/ObservabilityView';

interface EngineCtx {
  kinds: PluginKinds;
  refreshKinds: () => Promise<void>;
  reportError: (e: unknown) => void;
}

const Ctx = createContext<EngineCtx | null>(null);

export function useEngine(): EngineCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useEngine outside provider');
  return c;
}

const TABS = ['Plugins', 'Sources', 'Queries', 'Reactions', 'Observability'] as const;
type Tab = (typeof TABS)[number];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('Plugins');
  const [kinds, setKinds] = useState<PluginKinds>({ sources: [], reactions: [], bootstrap: [] });
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((e: unknown) => setError(errMessage(e)), []);

  const refreshKinds = useCallback(async () => {
    try {
      setKinds(await drasi.pluginKinds());
    } catch (e) {
      reportError(e);
    }
  }, [reportError]);

  useEffect(() => {
    void refreshKinds();
  }, [refreshKinds]);

  const ctx = useMemo<EngineCtx>(
    () => ({ kinds, refreshKinds, reportError }),
    [kinds, refreshKinds, reportError],
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <div className="brand">⚡ Drasi Plugin Explorer</div>
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={t === tab ? 'tab tab-active' : 'tab'}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>
        </header>

        {error && <Banner kind="error" message={error} onClose={() => setError(null)} />}

        <main className="content">
          {tab === 'Plugins' && <PluginsView />}
          {tab === 'Sources' && <SourcesView />}
          {tab === 'Queries' && <QueriesView />}
          {tab === 'Reactions' && <ReactionsView />}
          {tab === 'Observability' && <ObservabilityView />}
        </main>
      </div>
    </Ctx.Provider>
  );
}
