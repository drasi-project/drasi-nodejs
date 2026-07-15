# `@drasi/lib` — API reference & prototype audit

> Deliverable for [team#92](https://github.com/drasi-project/team/issues/92)
> ("Audit prototype Node.js bindings; document API surface and gaps"), a subtask
> of the [team#85](https://github.com/drasi-project/team/issues/85) epic.

This document is the authoritative inventory of the public API exposed by the
`@drasi/lib` native addon, plus an audit of the gaps that remain before a stable
`1.0` npm release. Every gap is mapped to a tracked follow-up issue in the
[Gap analysis](#gap-analysis--tracked-follow-ups) section.

- **Package:** `@drasi/lib` (currently `0.1.0`, unpublished)
- **Native class:** `Drasi` (napi-rs), defined in `src/drasi.rs`
- **Generated types:** `index.d.ts` (produced by `napi build`)
- **Source of truth for this audit:** commit state of `src/*.rs` and the
  generated `index.d.ts` at the time of writing.

Method names are shown in their JavaScript (camelCase) form; the Rust source uses
snake_case and napi-rs converts it. All methods are instance methods on a `Drasi`
object unless marked **static**.

---

## Contents

- [Surface at a glance](#surface-at-a-glance)
- [Construction](#construction)
- [Plugin discovery & registry](#plugin-discovery--registry)
- [Sources](#sources)
- [Queries](#queries)
- [Reactions](#reactions)
- [Metrics](#metrics)
- [Streaming (events & logs)](#streaming-events--logs)
- [Lifecycle](#lifecycle)
- [Data shapes](#data-shapes)
- [Error behavior](#error-behavior)
- [Cross-check vs. `drasi-server`](#cross-check-vs-drasi-server)
- [Gap analysis & tracked follow-ups](#gap-analysis--tracked-follow-ups)

---

## Surface at a glance

42 public methods across 8 areas. Every method except `pluginKinds()` is `async`
(returns a `Promise`).

| Area | Methods |
| --- | --- |
| Construction | `create`¹, `fromConfig`¹ |
| Plugins | `loadPlugins`, `watchPlugins`, `listPluginTags`, `pullPlugin`, `pluginKinds`² |
| Sources | `addSource`, `addJsSource`, `pushChange`, `updateSource`, `startSource`, `stopSource`, `removeSource`, `listSources` |
| Queries | `addQuery`, `updateQuery`, `startQuery`, `stopQuery`, `getQueryResults`, `removeQuery`, `listQueries` |
| Reactions | `addReaction`, `addJsReaction`, `updateReaction`, `startReaction`, `stopReaction`, `removeReaction`, `listReactions` |
| Metrics | `getQueryMetrics`, `getReactionMetrics`, `getLifecycleMetrics` |
| Streaming | `onAllEvents`, `onQueryEvents`, `onSourceEvents`, `onReactionEvents`, `onSourceLogs`, `onQueryLogs`, `onReactionLogs` |
| Lifecycle | `start`, `stop`, `close` |

¹ **static factory** (`Drasi.create(...)`, `Drasi.fromConfig(...)`).
² **synchronous** — the only non-`Promise` method.

---

## Construction

### `Drasi.create(id, options?)` → `Promise<Drasi>` *(static)*

Create a new, **not-yet-started** engine instance.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Instance id; used in log/callback contexts. |
| `options` | `CreateOptions` (`any`) | no | See below. |

`options`:
- `secrets?: Record<string, string>` — seeds an in-memory secret store that
  cdylib plugins resolve `ConfigValue::Secret` references against. Non-string
  values are silently ignored.
- `stateStore?: { kind: 'redb', path: string }` — enables a persistent plugin
  state store.

**Returns:** a `Drasi` instance.
**Errors:** `stateStore.path is required for redb` when `kind: 'redb'` and no
`path`; `unknown stateStore kind '<x>'` for any other kind; engine build errors
propagate as-is.

### `Drasi.fromConfig(config)` → `Promise<Drasi>` *(static)*

Build an engine from a declarative config object **and start it**. Equivalent to
`create` + optional `loadPlugins` + `start` + adding each declared source, query,
and reaction (which auto-start on the running engine).

`config` (`DrasiConfig`, passed as `any`):
- `id?: string` (default `"drasi"`)
- `secrets?`, `stateStore?` — forwarded to `create`.
- `pluginsDir?: string` — if present, `loadPlugins(pluginsDir)` runs before start.
- `sources?: Array<{ kind, id, config?, autoStart?, bootstrap? }>`
- `queries?: Array<{ id, query, sources, language?, joins? }>`
- `reactions?: Array<{ kind, id, queries, config? }>`

**Errors:** `config entry is missing '<key>'` when a required field (`kind`/`id`
for sources/reactions, `id`/`query` for queries) is absent, plus any error from
the underlying `add*`/`loadPlugins`/`start` calls.

---

## Plugin discovery & registry

Plugins are self-contained cdylib files (`.so`/`.dylib`/`.dll`) loaded through
`drasi-host-sdk`, exactly like `drasi-server`.

### `loadPlugins(dir, verify?)` → `Promise<{ plugins, sources, reactions, bootstrap }>`

Discover and load all matching cdylib plugins from `dir`, registering their
descriptors so their `kind`s become usable by `addSource`/`addReaction`.

- `dir: string` — directory to scan.
- `verify?: Record<string, string>` — a `{ filename: sha256hex }` integrity
  allowlist. When provided, **only** files whose contents hash to the expected
  value are loaded; mismatches and unhashable files are skipped with a warning.

**Returns:** counts `{ plugins: number, sources: number, reactions: number, bootstrap: number }`.
Discovery matches the fixed name patterns in `PLUGIN_FILE_PATTERNS`
(`libdrasi_source_*`, `drasi_reaction_*`, `…_bootstrap_*`, `…_secret_store_*`,
`…_identity_*`, both `lib`-prefixed and bare).

### `watchPlugins(dir)` → `Promise<void>`

Watch `dir` and hot-(re)load plugins as files are added/changed (1s debounce).
Removed files deregister their kinds (the already-mapped cdylib stays resident for
the process lifetime). Reload failures are logged, not thrown.

### `listPluginTags(repository)` → `Promise<string[]>`

List available tags for a plugin repo in the configured OCI registry (default
`ghcr.io/drasi-project`), e.g. `listPluginTags("source/postgres")`.

### `pullPlugin(reference, destDir, filename)` → `Promise<{ path, verification }>`

Download a plugin artifact from an OCI registry to `destDir/filename`.

- `reference: string` — full OCI reference, e.g.
  `ghcr.io/drasi-project/source/postgres:0.1.13-windows-msvc-amd64`.

**Returns:** `{ path: string, verification: string }`. ⚠️ `verification` is a
**debug-formatted string** of the SDK's verification result — status is surfaced
but **not enforced** (see [G5](#gap-analysis--tracked-follow-ups)). After pulling,
call `loadPlugins(destDir)` (or `watchPlugins`) to register it.

### `pluginKinds()` → `{ sources, reactions, bootstrap }` *(synchronous)*

Return the currently registered kinds as `{ sources: string[], reactions:
string[], bootstrap: string[] }`. The only non-async method.

---

## Sources

### `addSource(kind, id, config, autoStart?, bootstrap?)` → `Promise<void>`

Add a source instance of a registered plugin `kind`.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `kind` | `string` | — | Must be a registered source kind. |
| `id` | `string` | — | Source instance id. |
| `config` | `any` | — | Plugin-specific JSON config. |
| `autoStart` | `boolean?` | `true` | |
| `bootstrap` | `{ kind, config? }?` | — | Attaches a bootstrap provider so subscribing queries get an initial snapshot. |

**Errors:** `unknown source kind '<kind>'`, `bootstrap.kind is required`,
`unknown bootstrap kind '<kind>'`, plus plugin `create_source` errors.

### `addJsSource(id, autoStart?)` → `Promise<void>`

Register a programmatic source that JavaScript pushes changes into. Default
`autoStart = true`. Maintains a current-state snapshot so late-subscribing queries
receive a bootstrap replay of live elements.

### `pushChange(sourceId, change)` → `Promise<void>`

Push one change into a JS source. Uses a bounded channel (capacity 1024) — the
returned promise resolves once the change is buffered, applying **backpressure**
when the buffer is full.

`change` (`SourceChangeInput`):
- `op: 'insert' | 'update' | 'delete'` (also accepts `add`/`remove`; matching is
  case-insensitive) — **required**.
- `id: string` — **required**.
- `labels?: string[] | string`
- `properties?: Record<string, unknown>`
- `startId`/`endId` (aliases `inId`/`outId`) — presence of **both** makes the
  change a relation (edge); supplying only one errors.
- `effectiveFrom?: number` — epoch ms; defaults to now.

**Errors:** `no JS source '<id>'`; `change must be an object`; `change.op is
required`; `change.id is required`; `a relation change requires both startId and
endId`; `unknown change.op '<x>'`; `JS source '<id>' is not accepting changes`
(channel closed).

### `updateSource(kind, id, config, autoStart?)` → `Promise<void>`

Replace a source's configuration in place (same id). `unknown source kind` on bad
kind.

### `startSource(id)` / `stopSource(id)` → `Promise<void>`

Start/stop a source by id.

### `removeSource(id, cleanup?)` → `Promise<void>`

Remove a source; also drops any JS-source sender. `cleanup = true` tears down
external state (default `false`).

### `listSources()` → `Promise<Array<{ id, status }>>`

List sources. `status` is a debug-formatted `ComponentStatus` string (see
[Component status](#component-status)).

---

## Queries

### `addQuery(id, query, sources, language?, joins?)` → `Promise<void>`

Add a continuous query.

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `string` | — | Query id. |
| `query` | `string` | — | Cypher or GQL text. |
| `sources` | `string[]` | — | Source ids the query reads from. |
| `language` | `string?` | `"cypher"` | `"gql"` selects GQL; **any other value (including typos) silently falls back to Cypher** (see [G10](#gap-analysis--tracked-follow-ups)). |
| `joins` | `QueryJoin[]?` | — | `[{ id, keys: [{ label, property }] }]` synthetic joins relating elements across sources with no explicit relationship. |

**Errors:** invalid `joins` JSON fails to deserialize; engine `add_query` errors
propagate.

### `updateQuery(id, query, sources, language?, joins?)` → `Promise<void>`

Replace a query definition in place. Same parameters/semantics as `addQuery`.

### `startQuery(id)` / `stopQuery(id)` → `Promise<void>`

Start/stop a query by id.

### `getQueryResults(id)` → `Promise<unknown[]>`

Return the current result set as an array of row objects.

### `removeQuery(id)` → `Promise<void>`

Remove a query by id.

### `listQueries()` → `Promise<Array<{ id, status }>>`

List queries with debug-formatted status strings.

---

## Reactions

### `addReaction(kind, id, queryIds, config)` → `Promise<void>`

Add a reaction of a registered plugin `kind`, subscribing to `queryIds`.
**Errors:** `unknown reaction kind '<kind>'`, plus plugin `create_reaction` errors.

### `addJsReaction(id, queryIds, callback)` → `Promise<void>`

Add a JavaScript-defined reaction whose logic is a callback.

- `callback` is a **value-only** function `(result: QueryResultEvent) => void`.
  It is invoked once per non-empty result batch; **empty batches are skipped**.
  The callback is registered as an **unref'd** (weak) threadsafe function, so it
  does not keep the Node event loop alive on its own.

> ⚠️ **Doc bug:** the Rust doc-comment (and therefore the generated JSDoc in
> `index.d.ts`) describes `callback` as an *error-first* `(err, resultJson) =>
> void`. That is incorrect — the underlying `ThreadsafeFunction` is configured
> `CalleeHandled = false` (value-only). Tracked as [G3](#gap-analysis--tracked-follow-ups).

### `updateReaction(kind, id, queryIds, config)` → `Promise<void>`

Replace a reaction's configuration in place. `unknown reaction kind` on bad kind.

### `startReaction(id)` / `stopReaction(id)` → `Promise<void>`

Start/stop a reaction by id.

### `removeReaction(id, cleanup?)` → `Promise<void>`

Remove a reaction; `cleanup` default `false`.

### `listReactions()` → `Promise<Array<{ id, status }>>`

List reactions with debug-formatted status strings.

---

## Metrics

> Not currently documented in `README.md` (see [G11](#gap-analysis--tracked-follow-ups)).

### `getQueryMetrics(id)` → `Promise<QueryMetrics>`

```ts
{
  outboxSize: number,
  outboxEarliestSeq: number,
  outboxLatestSeq: number,
  resultSeqAdvances: number,
  liveResultsCount: number,
  outerTransactionDurationNsLast: number,
  outerTransactionDurationNsMax: number,
  snapshotFetchCount: number,
}
```

### `getReactionMetrics(id)` → `Promise<Record<string, ReactionQueryMetrics>>`

Keyed by query id:

```ts
{
  checkpointSequence, checkpointLag, dedupSkipCount, gapDetectionCount,
  recoveryStrictCount, recoveryAutoResetCount, recoveryAutoSkipGapCount,
  fetchSnapshotCount, fetchOutboxCount,   // all number
}
```

### `getLifecycleMetrics()` → `Promise<LifecycleMetrics>`

```ts
{
  startupRejectionDurableNoStore, startupRejectionDurableOnVolatile,
  startupRejectionSnapshotSkipGap, startupRejectionNoSnapshotAutoReset,
  autoResetCompletions, hashMismatchCount,   // all number
}
```

---

## Streaming (events & logs)

All streaming methods take a callback and return `Promise<void>`. Callbacks are
**unref'd** (weak) and invoked in `NonBlocking` mode.

### Component events

`onAllEvents(cb)`, `onQueryEvents(id, cb)`, `onSourceEvents(id, cb)`,
`onReactionEvents(id, cb)` — forward `ComponentEvent` objects (serde-serialized
`drasi_lib::ComponentEvent`; shape currently opaque, `Record<string, unknown>`).

### Logs

`onSourceLogs(id, cb)`, `onQueryLogs(id, cb)`, `onReactionLogs(id, cb)` — first
**replay the buffered log history**, then stream live `LogMessage`s. Lagged
messages (slow consumer) are dropped rather than erroring; the stream ends when
the broadcast channel closes.

`LogMessage`:
```ts
{ timestamp: string, level: string, message: string,
  instance_id: string, component_id: string, component_type: string }
```

---

## Lifecycle

### `start()` → `Promise<void>`

Start the engine; auto-start components begin running. Components added to an
already-running engine auto-start individually, so either ordering works
(add-then-`start`, or `start`-then-add).

### `stop()` → `Promise<void>`

Stop the engine. **No-op if not running.**

### `close()` → `Promise<void>`

Stop (if running) and release host resources: plugin watchers, JS-source
channels, and the config-resolver OS thread (deterministic reclaim; `Drop`
repeats this idempotently for the GC path). The instance must not be used after
`close()`.

---

## Data shapes

Companion TypeScript helpers for the shapes below ship in
[`types.d.ts`](../types.d.ts): `SourceChangeInput`, `ResultDiff`,
`QueryResultEvent`, `LogMessage`, `ComponentEvent`, `CreateOptions`, `QueryJoin`,
`DrasiConfig`, `ComponentStatusEntry`. The **generated** `index.d.ts` currently
types every config/result parameter as `any` (see
[G2](#gap-analysis--tracked-follow-ups)).

### `QueryResultEvent` (delivered to JS reactions)

```ts
{ query_id: string, sequence: number, timestamp: string,
  results: ResultDiff[], metadata: Record<string, unknown> }
```

`ResultDiff` is a tagged union on `type`: `ADD` / `DELETE` (`{ data }`),
`UPDATE` (`{ before, after }`), `aggregation` (`{ before?, after }`), `noop`.

### Component status

`listSources` / `listQueries` / `listReactions` return `{ id, status }` where
`status` is `format!("{:?}")` of `drasi_lib::ComponentStatus` — a string such as
`"Running"` or `"Stopped"`. The exact variant set is engine-defined and **not
part of a stable typed contract yet** (see [G4](#gap-analysis--tracked-follow-ups)).

---

## Error behavior

Every failure surfaces as a napi `Error` built with
`napi::Error::from_reason(<message>)` (`src/error.rs`). In JavaScript this is a
thrown `Error` whose `message` is the reason string and whose `code` is napi's
default `"GenericFailure"`.

**There are no typed/structured error codes.** Callers must string-match messages
to distinguish failure classes, which is brittle. Tracked as
[G4](#gap-analysis--tracked-follow-ups).

---

## Cross-check vs. `drasi-server`

Both `@drasi/lib` and `drasi-server` embed the same engine (`drasi-lib`) and use
the identical `drasi-host-sdk` dynamic-plugin mechanism, so the **source / query /
reaction / bootstrap** model and the OCI plugin registry are equivalent. The
bindings are the *programmatic* equivalent of the server's YAML config + REST API.

Capabilities present in `drasi-server` but **missing or partial** in the bindings:

| `drasi-server` capability | Bindings status |
| --- | --- |
| Web UI + REST API | N/A by design — the JS API *is* the control surface (out of scope). |
| Isolated "instances" | Each `Drasi.create()` is effectively one instance; no multi-instance manager. |
| `--verify-plugins` cosign signature enforcement | ⚠️ Verification status surfaced (`pullPlugin.verification`) but **not enforced** — G5. |
| Config-schema validation of source/reaction configs | ❌ Not validated; configs pass through as opaque JSON — G9. |
| Persistence backends | Only `redb`; RocksDB index provider not wired — G6. |
| Identity providers | ❌ Not exposed — G8. |

Capabilities the bindings add beyond the server's config surface: **JS-defined
sources** (`addJsSource`/`pushChange`) and **JS-defined reactions**
(`addJsReaction`), plus direct in-process `getQueryResults`.

---

## Gap analysis & tracked follow-ups

Each gap is mapped to an existing subtask of [team#85](https://github.com/drasi-project/team/issues/85).

| # | Gap | Severity | Tracked in |
| --- | --- | --- | --- |
| **G1** | **`index.d.ts` does not type-check**: `JsResultFn` is referenced by 8 methods (`addJsReaction`, all `on*` streams) but never declared, so `tsc --strict` fails with `TS2304: Cannot find name 'JsResultFn'`. Ships a broken `.d.ts` to every TS consumer. | **Blocker** | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G2** | Every config/result parameter is typed `any` in the generated `index.d.ts`; real shapes live only in the hand-written `types.d.ts`. | High | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G3** | `addJsReaction` doc-comment claims an error-first `(err, resultJson)` callback; it is actually value-only `(result) => void`. Misleading generated JSDoc. | Medium | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G4** | No typed error codes — all errors are `from_reason` strings; `ComponentStatus` is a debug string, not a stable enum. | High | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G5** | OCI `pullPlugin` surfaces a debug-formatted `verification` string but does not enforce cosign signatures / lockfiles. | High | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G6** | Only the `redb` state store is wired; no RocksDB index provider. | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G7** | JS reactions are not durable/checkpointed. | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G8** | No identity-provider surface. | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G9** | No declarative config-schema validation; source/reaction configs pass through as opaque JSON. | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G10** | `addQuery`/`updateQuery` `language` is not validated — any value other than `"gql"` silently becomes Cypher. | Low | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G11** | `README.md`'s API overview omits the metrics methods (`getQueryMetrics`/`getReactionMetrics`/`getLifecycleMetrics`) and `Drasi.fromConfig`. | Low | this PR links the reference; content in [team#98](https://github.com/drasi-project/team/issues/98) |
| **G12** | Public API test coverage is happy-path-heavy (~27 tests); thin on error paths, edge cases, and leak/soak. | High | [team#99](https://github.com/drasi-project/team/issues/99) |
| **G13** | No cross-platform prebuilt binaries / npm release pipeline; package unpublished. | Blocker for release | [team#93](https://github.com/drasi-project/team/issues/93), [team#94](https://github.com/drasi-project/team/issues/94), [team#95](https://github.com/drasi-project/team/issues/95) |
| **G14** | Missing community/governance files (`LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, templates). | Medium | [team#100](https://github.com/drasi-project/team/issues/100) |

### Recommended next actions

1. **G1** is a quick, high-value fix (declare/emit `JsResultFn`) and should land
   before the first publish — it currently breaks TypeScript consumers outright.
2. Prioritize the release-blocking chain (G13) and the type-correctness gaps
   (G1–G4) for the `1.0` milestone; treat G5–G10 as engine-feature completion.
