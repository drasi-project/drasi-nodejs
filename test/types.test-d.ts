// Compile-time type test for the generated `index.d.ts`.
//
// Run via `npm run test:types` (tsc --noEmit --strict). It imports the concrete
// public types and uses them so any regression to `any`, a missing type, or a
// changed shape fails the type-check. Nothing here executes at runtime.

import {
  Drasi,
  DrasiErrorCode,
} from '../index.js'
import type {
  BootstrapConfig,
  ComponentStatusEntry,
  CreateOptions,
  DrasiConfig,
  LifecycleMetrics,
  LoadPluginsResult,
  LogMessage,
  PluginKinds,
  PullPluginResult,
  QueryJoin,
  QueryMetrics,
  QueryResultEvent,
  ReactionQueryMetrics,
  ResultDiff,
  SourceChangeInput,
  StateStoreOptions,
} from '../index.js'

async function construction(): Promise<void> {
  const opts: CreateOptions = {
    secrets: { API_KEY: 'shh' },
    stateStore: { kind: 'redb', path: '/tmp/state.redb' },
  }
  const d: Drasi = await Drasi.create('app', opts)

  const cfg: DrasiConfig = {
    id: 'app',
    secrets: { API_KEY: 'shh' },
    stateStore: { kind: 'redb', path: '/tmp/s.redb' },
    pluginsDir: './plugins',
    sources: [
      {
        kind: 'mock',
        id: 's',
        config: { intervalMs: 100 },
        autoStart: true,
        bootstrap: { kind: 'mock-bootstrap', config: {} },
      },
    ],
    queries: [{ id: 'q', query: 'MATCH (n) RETURN n', sources: ['s'], language: 'cypher' }],
    reactions: [{ kind: 'log', id: 'r', queries: ['q'], config: {} }],
  }
  const d2: Drasi = await Drasi.fromConfig(cfg)
  await d2.close()
  await d.close()
}

async function plugins(d: Drasi): Promise<void> {
  const loaded: LoadPluginsResult = await d.loadPlugins('./plugins', { 'libx.so': 'deadbeef' })
  const total: number = loaded.plugins + loaded.sources + loaded.reactions + loaded.bootstrap
  void total
  const kinds: PluginKinds = d.pluginKinds()
  const firstSource: string | undefined = kinds.sources[0]
  void firstSource
  const tags: string[] = await d.listPluginTags('source/postgres')
  void tags
  const pulled: PullPluginResult = await d.pullPlugin('ref:tag', './plugins', 'x.so')
  void pulled.path
  void pulled.verification
}

async function sources(d: Drasi): Promise<void> {
  await d.addSource('mock', 's', { intervalMs: 100 }, true, { kind: 'bs', config: {} } satisfies BootstrapConfig)
  await d.addJsSource('js', true)
  const change: SourceChangeInput = {
    op: 'insert',
    id: 'n1',
    labels: ['Thing'],
    properties: { x: 1 },
    effectiveFrom: Date.now(),
  }
  await d.pushChange('js', change)
  const rel: SourceChangeInput = { op: 'update', id: 'e1', startId: 'a', endId: 'b' }
  await d.pushChange('js', rel)
  await d.updateSource('mock', 's', {})
  const list: ComponentStatusEntry[] = await d.listSources()
  void list.map((e) => `${e.id}:${e.status}`)
}

async function queries(d: Drasi): Promise<void> {
  const join: QueryJoin = { id: 'REL', keys: [{ label: 'a', property: 'k' }] }
  await d.addQuery('q', 'MATCH (n) RETURN n', ['s'], 'gql', [join])
  await d.updateQuery('q', 'MATCH (n) RETURN n', ['s'])
  const rows: Array<Record<string, unknown>> = await d.getQueryResults('q')
  void rows
  const list: ComponentStatusEntry[] = await d.listQueries()
  void list
}

async function reactions(d: Drasi): Promise<void> {
  await d.addReaction('log', 'r', ['q'], {})
  await d.addJsReaction('js-r', ['q'], (result: QueryResultEvent) => {
    const id: string = result.query_id
    const seq: number = result.sequence
    result.results.forEach((diff: ResultDiff) => {
      if (diff.type === 'UPDATE') {
        const before: unknown = diff.before
        void before
      }
      const sig: number | undefined = diff.row_signature
      void sig
    })
    void id
    void seq
    void result.metadata
  })
  await d.updateReaction('log', 'r', ['q'], {})
  const list: ComponentStatusEntry[] = await d.listReactions()
  void list
}

async function metrics(d: Drasi): Promise<void> {
  const qm: QueryMetrics = await d.getQueryMetrics('q')
  void qm.outboxLatestSeq
  const rm: Record<string, ReactionQueryMetrics> = await d.getReactionMetrics('r')
  void Object.values(rm).map((m) => m.checkpointSequence)
  const lm: LifecycleMetrics = await d.getLifecycleMetrics()
  void lm.hashMismatchCount
}

async function streaming(d: Drasi): Promise<void> {
  await d.onAllEvents((event: Record<string, unknown>) => void event)
  await d.onQueryEvents('q', (event: Record<string, unknown>) => void event)
  await d.onSourceLogs('s', (log: LogMessage) => {
    const line: string = `${log.timestamp} ${log.level} ${log.component_id} ${log.message}`
    void line
  })
}

// Error codes: consumers branch on the typed `err.code` instead of matching messages.
function classify(err: unknown): string {
  const code = (err as { code?: string }).code
  if (code === DrasiErrorCode.UnknownSourceKind) return 'unknown-source'
  if (code === DrasiErrorCode.NoJsSource) return 'no-js-source'
  if (code === DrasiErrorCode.ChangeOpRequired) return 'bad-change'
  return 'other'
}

const stateStore: StateStoreOptions = { kind: 'redb', path: '/tmp/x' }

export {
  construction,
  plugins,
  sources,
  queries,
  reactions,
  metrics,
  streaming,
  classify,
  stateStore,
}
