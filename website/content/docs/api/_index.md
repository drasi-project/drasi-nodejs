---
title: "API Reference"
linkTitle: "API Reference"
weight: 40
description: >
  Every method on the Drasi class, grouped by area, with parameters and return types.
---

The public API is the `Drasi` class exported from `@drasi/lib`. There are **42
methods across 8 areas**. Every method except `pluginKinds()`, `sourceConfigSchema()`,
`reactionConfigSchema()`, and `bootstrapConfigSchema()` is `async` (returns a
`Promise`).

Method names are shown in JavaScript (camelCase) form. Concrete TypeScript types for
every parameter, return value, and callback payload are emitted into the generated
`index.d.ts` — see [TypeScript types](../guides/typescript-types/).

```js
import { Drasi } from '@drasi/lib';
```

## Surface at a glance

| Area | Methods |
| --- | --- |
| Construction | `create`¹, `fromConfig`¹ |
| Plugins | `loadPlugins`, `watchPlugins`, `listPluginTags`, `pullPlugin`, `sourceConfigSchema`², `reactionConfigSchema`², `bootstrapConfigSchema`², `pluginKinds`² |
| Sources | `addSource`, `addJsSource`, `pushChange`, `updateSource`, `startSource`, `stopSource`, `removeSource`, `listSources` |
| Queries | `addQuery`, `updateQuery`, `startQuery`, `stopQuery`, `getQueryResults`, `removeQuery`, `listQueries` |
| Reactions | `addReaction`, `addJsReaction`, `addDurableJsReaction`, `updateReaction`, `startReaction`, `stopReaction`, `removeReaction`, `listReactions` |
| Metrics | `getQueryMetrics`, `getReactionMetrics`, `getLifecycleMetrics` |
| Streaming | `onAllEvents`, `onQueryEvents`, `onSourceEvents`, `onReactionEvents`, `onSourceLogs`, `onQueryLogs`, `onReactionLogs` |
| Lifecycle | `start`, `stop`, `close` |

¹ **static factory** &nbsp; ² **synchronous** (does not return a `Promise`)

## Construction

### Drasi.create(id, options?) → Promise&lt;Drasi&gt; {#drasicreateid-options-static}

*Static.* Create a new, **not-yet-started** engine instance.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Instance id; used in log/callback contexts. |
| `options` | `CreateOptions` | no | See below. |

`options`:

- `secrets?: Record<string, string>` — seeds an in-memory secret store that cdylib
  plugins resolve `ConfigValue::Secret` references against. Non-string values are
  ignored.
- `stateStore?: { kind: 'redb', path: string }` — enables a persistent plugin state
  store (also required by durable reactions).
- `indexStore?: { kind: 'rocksdb', path: string, enableArchive?: boolean, directIo?: boolean }`
  — enables a **persistent query-index backend** so continuous-query indexes and the
  reaction outbox survive restarts. RocksDB holds a process-exclusive lock on `path`,
  so a given path may be used by only one engine at a time.
- `identity?: { kind: 'password' | 'token', username?, password?, token? }` — wires a
  built-in identity provider that injects credentials into sources/reactions.

**Returns** a `Drasi` instance.

### Drasi.fromConfig(config) → Promise&lt;Drasi&gt; {#drasifromconfigconfig-static}

*Static.* Build an engine from a declarative config object **and start it**.
Equivalent to `create` + optional `loadPlugins` + `start` + adding each declared
source, query, and reaction (which auto-start on the running engine).

`config` (`DrasiConfig`):

- `id?: string` (default `"drasi"`)
- `secrets?`, `stateStore?`, `indexStore?`, `identity?` — forwarded to `create`.
- `pluginsDir?: string` — if present, `loadPlugins(pluginsDir)` runs before start.
- `sources?: Array<{ kind, id, config?, autoStart?, bootstrap? }>`
- `queries?: Array<{ id, query, sources, language?, joins? }>`
- `reactions?: Array<{ kind, id, queries, config? }>`

```js
const drasi = await Drasi.fromConfig({
  id: 'app',
  pluginsDir: './plugins',
  sources: [{ kind: 'mock', id: 'counters', config: { dataType: { type: 'counter' }, intervalMs: 300 } }],
  queries: [{ id: 'big', query: 'MATCH (c:Counter) WHERE c.value > 3 RETURN c.value AS value', sources: ['counters'] }],
});
```

## Plugins

Plugins are self-contained cdylib files (`.so`/`.dylib`/`.dll`) loaded through
`drasi-host-sdk`, exactly like `drasi-server`. See [Working with plugins](../guides/plugins/).

### loadPlugins(dir, verify?) → Promise&lt;{ plugins, sources, reactions, bootstrap }&gt; {#loadpluginsdir-verify}

Discover and load all matching cdylib plugins from `dir`, registering their
descriptors so their `kind`s become usable by `addSource`/`addReaction`.

- `dir: string` — directory to scan.
- `verify?: Record<string, string>` — a `{ filename: sha256hex }` integrity
  allowlist. When provided, **only** files whose contents hash to the expected value
  are loaded; mismatches are skipped with a warning.

**Returns** counts `{ plugins, sources, reactions, bootstrap }` (all `number`).

### watchPlugins(dir) → Promise&lt;void&gt; {#watchpluginsdir}

Watch `dir` and hot-(re)load plugins as files are added or changed (1s debounce).
Removed files deregister their kinds. Reload failures are logged, not thrown.

### listPluginTags(repository) → Promise&lt;string[]&gt; {#listplugintagsrepository}

List available tags for a plugin repo in the configured OCI registry (default
`ghcr.io/drasi-project`), e.g. `listPluginTags("source/postgres")`.

### pullPlugin(reference, destDir, filename, options?) → Promise&lt;{ path, verification }&gt; {#pullpluginreference-destdir-filename-options}

Download a plugin artifact from an OCI registry to `destDir/filename`.

- `reference: string` — full OCI reference, e.g.
  `ghcr.io/drasi-project/source/postgres:0.1.13-windows-msvc-amd64`.
- `options?: PullPluginOptions` — opt-in cosign enforcement:
  - `verify?: boolean` — run signature verification; a `tampered` or valid-but-untrusted
    artifact is rejected.
  - `requireSigned?: boolean` — additionally reject `unsigned` artifacts. Implies `verify`.
  - `trustedIdentities?: { issuer, subjectPattern }[]` — signer allowlist (defaults to
    the drasi-project GitHub Actions identity).

**Returns** `{ path: string, verification }`, where `verification` is one of:

```ts
{ status: 'unsigned' }                    // no signature (or verify not requested)
{ status: 'verified', issuer, subject }   // valid signature chaining to Sigstore
{ status: 'tampered', reason }            // a signature exists but did not verify
```

After a successful pull, call `loadPlugins(destDir)` (or `watchPlugins`) to register it.

### sourceConfigSchema(kind) / reactionConfigSchema(kind) / bootstrapConfigSchema(kind) → { name, schema } {#config-schema-accessors}

*Synchronous.* Return the config schema a registered plugin `kind` declares, as
`{ name: string, schema: Record<string, unknown> }`. Use it to validate config with a
JSON-schema validator (such as ajv) **before** calling `addSource`/`addReaction`.
Because these are synchronous, an unregistered kind throws with a typed `err.code`
(`UNKNOWN_SOURCE_KIND` / `UNKNOWN_REACTION_KIND` / `UNKNOWN_BOOTSTRAP_KIND`).

### pluginKinds() → { sources, reactions, bootstrap } {#pluginkinds}

*Synchronous.* Return the currently registered kinds as
`{ sources: string[], reactions: string[], bootstrap: string[] }`.

## Sources

### addSource(kind, id, config, autoStart?, bootstrap?) → Promise&lt;void&gt; {#addsourcekind-id-config-autostart-bootstrap}

Add a source instance of a registered plugin `kind`.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `kind` | `string` | — | Must be a registered source kind. |
| `id` | `string` | — | Source instance id. |
| `config` | `object` | — | Plugin-specific JSON config. |
| `autoStart` | `boolean?` | `true` | |
| `bootstrap` | `{ kind, config? }?` | — | Attaches a bootstrap provider so subscribing queries get an initial snapshot. |

### addJsSource(id, autoStart?) → Promise&lt;void&gt; {#addjssourceid-autostart}

Register a programmatic source that JavaScript pushes changes into. Default
`autoStart = true`. Maintains a current-state snapshot so late-subscribing queries
receive a bootstrap replay of live elements. See [JavaScript sources](../guides/js-sources/).

### pushChange(sourceId, change) → Promise&lt;void&gt; {#pushchangesourceid-change}

Push one change into a JS source. Uses a bounded channel (capacity 1024) — the
returned promise resolves once the change is buffered, applying **backpressure** when
the buffer is full.

`change` (`SourceChangeInput`):

- `op: 'insert' | 'update' | 'delete'` (also accepts `add`/`remove`, case-insensitive)
  — **required**.
- `id: string` — **required**.
- `labels?: string[] | string`
- `properties?: Record<string, unknown>`
- `startId` / `endId` (aliases `inId` / `outId`) — presence of **both** makes the
  change a relation (edge); supplying only one errors.
- `effectiveFrom?: number` — epoch ms; defaults to now.

### updateSource(kind, id, config, autoStart?) → Promise&lt;void&gt; {#updatesource}

Replace a source's configuration in place (same id).

### startSource(id) / stopSource(id) → Promise&lt;void&gt; {#start-stop-source}

Start or stop a source by id.

### removeSource(id, cleanup?) → Promise&lt;void&gt; {#removesource}

Remove a source; also drops any JS-source sender. `cleanup = true` tears down external
state (default `false`).

### listSources() → Promise&lt;Array&lt;{ id, status }&gt;&gt; {#listsources}

List sources. `status` is a `ComponentStatus` string such as `"Running"` or `"Stopped"`.

## Queries

### addQuery(id, query, sources, language?, joins?) → Promise&lt;void&gt; {#addqueryid-query-sources-language-joins}

Add a continuous query.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `string` | — | Query id. |
| `query` | `string` | — | Cypher or GQL text. |
| `sources` | `string[]` | — | Source ids the query reads from. |
| `language` | `string?` | `"cypher"` | `"gql"` selects GQL. Any other value is rejected synchronously with `UNKNOWN_QUERY_LANGUAGE`. |
| `joins` | `QueryJoin[]?` | — | `[{ id, keys: [{ label, property }] }]` synthetic joins relating elements across sources with no explicit relationship. |

### updateQuery(id, query, sources, language?, joins?) → Promise&lt;void&gt; {#updatequery}

Replace a query definition in place. Same parameters as `addQuery`.

### startQuery(id) / stopQuery(id) → Promise&lt;void&gt; {#start-stop-query}

Start or stop a query by id.

### getQueryResults(id) → Promise&lt;unknown[]&gt; {#getqueryresultsid}

Return the current result set as an array of row objects.

### removeQuery(id) → Promise&lt;void&gt; {#removequery}

Remove a query by id.

### listQueries() → Promise&lt;Array&lt;{ id, status }&gt;&gt; {#listqueries}

List queries with their status strings.

## Reactions

### addReaction(kind, id, queryIds, config) → Promise&lt;void&gt; {#addreactionkind-id-queryids-config}

Add a reaction of a registered plugin `kind`, subscribing to `queryIds`.

### addJsReaction(id, queryIds, callback) → Promise&lt;void&gt; {#addjsreactionid-queryids-callback}

Add a JavaScript-defined reaction whose logic is a callback.

- `callback` is a **value-only** function `(result: QueryResultEvent) => void`. It is
  invoked once per non-empty result batch; **empty batches are skipped**. The callback
  is registered as an **unref'd** (weak) threadsafe function, so it does not keep the
  Node event loop alive on its own.

See [JavaScript reactions](../guides/js-reactions/).

### addDurableJsReaction(id, queryIds, callback, options?) → Promise&lt;void&gt; {#adddurablejsreactionid-queryids-callback-options}

Add a **durable, checkpointed** JavaScript reaction.

- `callback` is an **async** function `(result: QueryResultEvent) => Promise<void>`. The
  reaction **awaits** its promise and then persists a per-query checkpoint, so a restart
  resumes **after the last checkpointed sequence**.
- `options?: { recoveryPolicy?: 'skipGap' | 'strict' }` — on a detected gap, `skipGap`
  (default) resumes from the latest available sequence; `strict` fails if the
  checkpointed position is unavailable.

**Requires a durable state store** (`{ stateStore: { kind: 'redb', path } }`), otherwise
throws `DURABLE_REQUIRES_STATE_STORE` synchronously. Checkpoint progress is observable
via `getReactionMetrics(id)`.

{{% alert title="Durability semantics" color="warning" %}}
This is **crash recovery of not-yet-checkpointed results**, *not* per-event
at-least-once delivery. If the callback's promise rejects, the failure is logged, the
checkpoint is not advanced, and processing continues with the **next** result — the
callback is not retried in-process.
{{% /alert %}}

### updateReaction(kind, id, queryIds, config) → Promise&lt;void&gt; {#updatereaction}

Replace a reaction's configuration in place.

### startReaction(id) / stopReaction(id) → Promise&lt;void&gt; {#start-stop-reaction}

Start or stop a reaction by id.

### removeReaction(id, cleanup?) → Promise&lt;void&gt; {#removereaction}

Remove a reaction; `cleanup` default `false`.

### listReactions() → Promise&lt;Array&lt;{ id, status }&gt;&gt; {#listreactions}

List reactions with their status strings.

## Metrics

### getQueryMetrics(id) → Promise&lt;QueryMetrics&gt; {#getquerymetrics}

```ts
{
  outboxSize, outboxEarliestSeq, outboxLatestSeq, resultSeqAdvances,
  liveResultsCount, outerTransactionDurationNsLast,
  outerTransactionDurationNsMax, snapshotFetchCount,   // all number
}
```

### getReactionMetrics(id) → Promise&lt;Record&lt;string, ReactionQueryMetrics&gt;&gt; {#getreactionmetrics}

Keyed by query id:

```ts
{
  checkpointSequence, checkpointLag, dedupSkipCount, gapDetectionCount,
  recoveryStrictCount, recoveryAutoResetCount, recoveryAutoSkipGapCount,
  fetchSnapshotCount, fetchOutboxCount,   // all number
}
```

### getLifecycleMetrics() → Promise&lt;LifecycleMetrics&gt; {#getlifecyclemetrics}

```ts
{
  startupRejectionDurableNoStore, startupRejectionDurableOnVolatile,
  startupRejectionSnapshotSkipGap, startupRejectionNoSnapshotAutoReset,
  autoResetCompletions, hashMismatchCount,   // all number
}
```

## Streaming (events & logs)

All streaming methods take a callback and return `Promise<void>`. Callbacks are
**unref'd** (weak) and invoked in non-blocking mode.

### Component events {#component-events}

`onAllEvents(cb)`, `onQueryEvents(id, cb)`, `onSourceEvents(id, cb)`,
`onReactionEvents(id, cb)` — forward `ComponentEvent` objects.

### Logs {#logs}

`onSourceLogs(id, cb)`, `onQueryLogs(id, cb)`, `onReactionLogs(id, cb)` — first
**replay the buffered log history**, then stream live `LogMessage`s:

```ts
{ timestamp, level, message, instance_id, component_id, component_type }   // all string
```

## Lifecycle

### start() → Promise&lt;void&gt; {#start}

Start the engine; auto-start components begin running. Components added to an
already-running engine auto-start individually, so either ordering works.

### stop() → Promise&lt;void&gt; {#stop}

Stop the engine. **No-op if not running.**

### close() → Promise&lt;void&gt; {#close}

Stop (if running) and release host resources: plugin watchers, JS-source channels, and
the config-resolver thread. The instance must not be used after `close()`.

## Data shapes

### QueryResultEvent {#queryresultevent}

Delivered to JavaScript reactions:

```ts
{ query_id: string, sequence: number, timestamp: string,
  results: ResultDiff[], metadata: Record<string, unknown> }
```

`ResultDiff` is a tagged union on `type`: `ADD` / `DELETE` (`{ data }`), `UPDATE`
(`{ before, after }`), `aggregation` (`{ before?, after }`), `noop`.

### Component status {#component-status}

`listSources` / `listQueries` / `listReactions` return `{ id, status }` where `status`
is a string such as `"Running"` or `"Stopped"`.

## Errors

Argument-validation errors throw **synchronously** with a stable, machine-readable
`err.code` from the exported `DrasiErrorCode` enum. See [Error handling](../guides/error-handling/)
for the full list and the sync-vs-async distinction.
