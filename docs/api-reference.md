# `@drasi/lib` — API reference & prototype audit

> Deliverable for [team#92](https://github.com/drasi-project/team/issues/92)
> ("Audit prototype Node.js bindings; document API surface and gaps"), a subtask
> of the [team#85](https://github.com/drasi-project/team/issues/85) epic.

This document is the authoritative inventory of the public API exposed by the
`@drasi/lib` native addon, plus an audit of the gaps that remain before a stable
`1.0` npm release. Every gap is mapped to a tracked follow-up issue in the
[Gap analysis](#gap-analysis--tracked-follow-ups) section.

> **Update:** this audit has been reconciled with the fixes that followed it —
> gaps **G1–G3, G5–G8, G10, G11, G12** and the **G13** pipeline are now resolved,
> with **G4** and **G9** partially resolved (see the ✅/⚠️ status markers in the
> [Gap analysis](#gap-analysis--tracked-follow-ups) table). The inline
> method/shape sections describe the audited surface with resolution notes inline.

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
| Reactions | `addReaction`, `addJsReaction`, `addDurableJsReaction`, `updateReaction`, `startReaction`, `stopReaction`, `removeReaction`, `listReactions` |
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
  state store (plugin runtime state; also required by durable reactions).
- `indexStore?: { kind: 'rocksdb', path: string, enableArchive?: boolean, directIo?: boolean }`
  — enables a **persistent query-index backend** (audit gap G6). Unlike
  `stateStore`, this persists the continuous-query indexes (element/result
  indexes, future queue) and the reaction outbox, so query state survives
  restarts. Made the default backend for every query. **Note:** RocksDB holds a
  process-exclusive lock on `path`, released when the process exits (not
  necessarily on `close()` — see
  [#22](https://github.com/drasi-project/drasi-nodejs/issues/22)), so a given path
  may be used by only one engine at a time and cross-restart recovery happens in a
  fresh process.
- `identity?: { kind: 'password' | 'token', username?, password?, token? }` —
  wires a built-in identity provider (audit gap G8) that injects credentials into
  sources/reactions connecting to external systems.

**Returns:** a `Drasi` instance.
**Errors:** `stateStore.path is required for redb` / `unknown stateStore kind '<x>'`;
`indexStore.path is required for rocksdb` (`INDEX_STORE_PATH_REQUIRED`) /
`unknown indexStore kind '<x>'` (`UNKNOWN_INDEX_STORE_KIND`); `identity.kind is
required` (`IDENTITY_KIND_REQUIRED`), `unknown identity kind '<x>'`
(`UNKNOWN_IDENTITY_KIND`), or a missing credential field (`IDENTITY_CONFIG_INVALID`);
engine build errors propagate as-is.

### `Drasi.fromConfig(config)` → `Promise<Drasi>` *(static)*

Build an engine from a declarative config object **and start it**. Equivalent to
`create` + optional `loadPlugins` + `start` + adding each declared source, query,
and reaction (which auto-start on the running engine).

`config` (`DrasiConfig`, passed as `any`):
- `id?: string` (default `"drasi"`)
- `secrets?`, `stateStore?`, `indexStore?`, `identity?` — forwarded to `create`.
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

### `pullPlugin(reference, destDir, filename, options?)` → `Promise<{ path, verification }>`

Download a plugin artifact from an OCI registry to `destDir/filename`.

- `reference: string` — full OCI reference, e.g.
  `ghcr.io/drasi-project/source/postgres:0.1.13-windows-msvc-amd64`.
- `options?: PullPluginOptions` — opt-in cosign enforcement (see below):
  - `verify?: boolean` — run cosign signature verification and record the status;
    a `tampered` — or valid-but-untrusted — artifact is rejected.
  - `requireSigned?: boolean` — additionally reject `unsigned` artifacts. Implies `verify`.
  - `trustedIdentities?: { issuer, subjectPattern }[]` — the signer allowlist
    (defaults to the drasi-project GitHub Actions identity when omitted).

**Returns:** `{ path: string, verification: PullPluginVerification }`. As of the
team#97 work `verification` is a **structured object** (previously a debug-formatted
string) that is now **enforced** when verification is enabled (audit gap G5):

```ts
{ status: 'unsigned' }                       // no signature (or verify not requested)
{ status: 'verified', issuer, subject }      // valid signature chaining to Sigstore
{ status: 'tampered', reason }               // a signature exists but did not verify
```

With no `options` (or `verify: false`) the artifact is downloaded as before and
`verification.status` is `"unsigned"`. When `verify` is set: a `tampered` artifact,
**or a `verified` one whose signer is not on the trusted-identity allowlist**, is
deleted and the promise **rejects** — because this is an async path, napi cannot
attach a typed `err.code`, so the rejection is a `GenericFailure` whose message
carries the stable `[PLUGIN_SIGNATURE_INVALID]` token (see
[Error behavior](#error-behavior)); with `requireSigned` an `unsigned` artifact is
likewise rejected. (The SDK's `verified` status only means the signature is
cryptographically valid and chains to Sigstore — it does not itself check the
signer against any allowlist — so the binding enforces `trustedIdentities` to
prevent accepting a valid signature from an untrusted party.) After a successful
pull, call `loadPlugins(destDir)` (or `watchPlugins`) to register it.

### `sourceConfigSchema(kind)` / `reactionConfigSchema(kind)` / `bootstrapConfigSchema(kind)` → `{ name, schema }` *(synchronous)*

Return the config schema a registered plugin `kind` declares, as
`{ name: string, schema: Record<string, unknown> }` (audit gap G9). `name` is the
root config DTO key within `schema`, an object of OpenAPI (utoipa) schema
definitions keyed by schema name (an empty object if a plugin's schema JSON is
unparseable — never expected from a well-formed plugin). Because these accessors
are **synchronous**, an unregistered kind throws with a real, typed `err.code`
(`UNKNOWN_SOURCE_KIND` / `UNKNOWN_REACTION_KIND` / `UNKNOWN_BOOTSTRAP_KIND`).

Config is still marshaled as opaque JSON at runtime, but this exposes each plugin's
declared shape so callers can validate config (e.g. with a JSON-schema validator
such as ajv) *before* calling `addSource`/`addReaction`. A malformed config is also
surfaced when the plugin rejects it: since `addSource`/`addReaction`/`update*` are
**async**, that rejection is a `GenericFailure` whose message carries the stable
`[CONFIG_INVALID]` token rather than a typed `err.code` (see
[Error behavior](#error-behavior)).

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
| `language` | `string?` | `"cypher"` | `"gql"` selects GQL; `"cypher"` (or omitted) selects Cypher. **Any other value (including typos) is now rejected synchronously with a typed `UNKNOWN_QUERY_LANGUAGE` error** (audit gap G10, resolved). |
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

> ✅ **Fixed in [PR #3](https://github.com/drasi-project/drasi-nodejs/pull/3)**
> (gap G3): the Rust doc-comment previously described `callback` as an
> *error-first* `(err, resultJson) => void`, which was incorrect. The callback is
> value-only (`CalleeHandled = false`), and the doc-comment now says so.

### `addDurableJsReaction(id, queryIds, callback, options?)` → `Promise<void>`

Add a **durable, checkpointed** JavaScript reaction (audit gap G7).

- `callback` is an **async** function `(result: QueryResultEvent) => Promise<void>`.
  The reaction **awaits** its promise and then persists a per-query checkpoint. Empty
  batches are skipped.
- `options?`:
  - `recoveryPolicy?: 'skipGap' | 'strict'` — how to recover on a detected gap:
    `skipGap` (default) resumes from the latest available sequence; `strict` fails if
    the checkpointed position is unavailable.
  - `onError?: 'retry' | 'halt' | 'skip'` — what to do when the callback's promise
    rejects (see below). Default `'retry'`.
  - `maxRetries?: number` — for `onError: 'retry'`, the retry budget before escalating
    to halt. Omit (or a negative value) for **unlimited**; `0` halts on the first
    failure.
  - `retryDelayMs?: number` — base exponential-backoff delay in ms (default `100`).
  - `maxRetryDelayMs?: number` — backoff cap in ms (default `30000`).

**Per-event at-least-once (`onError`, issue #21):** the policy is applied *inside* the
handler, on top of drasi-lib's stock checkpoint loop — the reaction never advances the
checkpoint past an event it hasn't successfully processed.

- **`'retry'` (default)** — re-invoke the callback with exponential backoff (`retryDelayMs`
  → `maxRetryDelayMs`, doubling) **until it resolves**. Because the reaction stays parked
  on the failed event until the handler succeeds, the checkpoint can never leapfrog it:
  **true per-event at-least-once** for a transiently-failing callback. A finite
  `maxRetries` escalates to `halt` once exhausted.
- **`'halt'`** — stop the reaction (status `error`) on the first failure, leaving the
  checkpoint at the last success. No later event is processed (head-of-line for the whole
  reaction). Use when out-of-order side effects are unacceptable.
- **`'skip'`** — log the failure and advance to the **next** result without checkpointing
  the failed one (drasi-lib's stock behavior). A later success for the same query then
  advances the checkpoint past the failed sequence, so this is effectively **at-most-once**
  for a transiently-failing callback. Opt-in, for fire-and-mostly-forget durable reactions.

Note that `retry`/`halt` are **head-of-line** at the reaction level: a single loop serves
all of a reaction's queries, so a stuck event pauses the others until it clears.

**Requires a durable state store** (`{ stateStore: { kind: 'redb', path } }`) —
otherwise throws `DURABLE_REQUIRES_STATE_STORE` synchronously. Pair with a
persistent `indexStore` (rocksdb, G6) so the reaction outbox is replayable across
process restarts. Checkpoint progress is observable via `getReactionMetrics(id)`
(`checkpointSequence`).


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

As of [PR #5](https://github.com/drasi-project/drasi-nodejs/pull/5) (team#98, gap
G2), the generated `index.d.ts` is **self-contained**: these shapes —
`SourceChangeInput`, `ResultDiff`, `QueryResultEvent`, `LogMessage`,
`ComponentEvent`, `CreateOptions`, `QueryJoin`, `DrasiConfig`,
`ComponentStatusEntry`, the metrics objects, and the `DrasiErrorCode` enum — are
now emitted directly as concrete types (no bare `any`). The original audit found
every config/result parameter typed as `any`, with the real shapes living only in
a hand-written companion `types.d.ts`; that companion file has since been removed.

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
part of a stable typed contract yet** — this is the remaining part of
[G4](#gap-analysis--tracked-follow-ups) (typed error codes landed in PR #5; typing
`ComponentStatus` itself is still open).

---

## Error behavior

As of [PR #5](https://github.com/drasi-project/drasi-nodejs/pull/5) (gap G4),
**argument-validation errors throw synchronously** with a stable, machine-readable
`err.code` from the exported `DrasiErrorCode` enum (e.g. `UNKNOWN_SOURCE_KIND`,
`NO_JS_SOURCE`, `RELATION_REQUIRES_BOTH_ENDS`). This is Node-idiomatic (like the
runtime's own argument validation) and transparent to `await`/`try` callers.

Engine/async failures still surface as **rejected** promises with napi's default
`code === 'GenericFailure'`; where a stable code applies on those paths it is also
embedded in the message as a trailing `[CODE]` token. Human-readable messages are
otherwise unchanged. See the README "Error handling" section for consumer guidance.

> The original audit found **no typed error codes** — every error was a
> `from_reason` string with `code === 'GenericFailure'`, forcing brittle
> message-matching. That is now resolved for the synchronous validation paths.

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
| `--verify-plugins` cosign signature enforcement | ✅ Opt-in enforcement on `pullPlugin` (`{ verify, requireSigned }`) — tampered/unsigned artifacts are rejected and deleted (G5, resolved). |
| Config-schema validation of source/reaction configs | ⚠️ Schema now exposed (`sourceConfigSchema`/`reactionConfigSchema`/`bootstrapConfigSchema`) + a `[CONFIG_INVALID]` message token on config rejection; full in-Rust JSON-schema enforcement deferred — G9 (partial). |
| Persistence backends | ✅ redb state store + RocksDB index provider (`indexStore: { kind: 'rocksdb' }`) — G6. |
| Identity providers | ✅ Built-in password/token providers via `identity: {…}` — G8. |

Capabilities the bindings add beyond the server's config surface: **JS-defined
sources** (`addJsSource`/`pushChange`) and **JS-defined reactions**
(`addJsReaction`), plus direct in-process `getQueryResults`.

---

## Gap analysis & tracked follow-ups

Each gap is mapped to an existing subtask of [team#85](https://github.com/drasi-project/team/issues/85).

| # | Gap | Severity | Tracked in |
| --- | --- | --- | --- |
| **G1** | ✅ **Resolved ([PR #3](https://github.com/drasi-project/drasi-nodejs/pull/3)).** `index.d.ts` failed to type-check — `JsResultFn` was referenced by 8 methods (`addJsReaction`, all `on*` streams) but never declared (`tsc --strict` → `TS2304`). Fixed with `ts_args_type` overrides that emit concrete callback signatures. | **Blocker** | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G2** | ✅ **Resolved ([PR #5](https://github.com/drasi-project/drasi-nodejs/pull/5)).** Config/result params were typed `any`; now emitted as concrete `#[napi(object)]` interfaces so the generated `index.d.ts` is self-contained and `any`-free. The hand-written `types.d.ts` was removed. | High | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G3** | ✅ **Resolved ([PR #3](https://github.com/drasi-project/drasi-nodejs/pull/3)).** The `addJsReaction` doc-comment wrongly described an error-first `(err, resultJson)` callback; corrected to the actual value-only `(result) => void`. | Medium | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G4** | ⚠️ **Largely resolved ([PR #5](https://github.com/drasi-project/drasi-nodejs/pull/5)).** Typed error codes added: validation errors throw synchronously with a stable `err.code` from the exported `DrasiErrorCode` enum (async/engine errors still reject with `GenericFailure` and carry a `[CODE]` token in the message). **Remaining:** `ComponentStatus` from `list*` is still a debug-formatted string, not a typed enum. | High | [team#98](https://github.com/drasi-project/team/issues/98) |
| **G5** | ✅ **Resolved ([team#97](https://github.com/drasi-project/team/issues/97)).** `pullPlugin` accepts `{ verify, requireSigned, trustedIdentities }` and **enforces** cosign verification via the host SDK's `CosignVerifier`: a `tampered`, untrusted-signer (or, with `requireSigned`, `unsigned`) artifact is deleted and the promise rejects with a `[PLUGIN_SIGNATURE_INVALID]` message token (async path; `err.code` stays `GenericFailure`). Trust is enforced in the binding via `matches_trusted_identity` (the SDK's `Verified` status alone does not check the signer). `verification` is now a structured object (`{ status, issuer?, subject?, reason? }`). | High | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G6** | ✅ **Resolved ([team#97](https://github.com/drasi-project/team/issues/97), #16).** A RocksDB persistent query-index backend is now wired via a new `indexStore: { kind: 'rocksdb', path, enableArchive?, directIo? }` option on `create`/`fromConfig` (`with_default_index_provider` + `drasi-index-rocksdb`), so element/result indexes and the reaction outbox persist across restarts. (Adds a bundled RocksDB C++ build — CI/release install libclang for bindgen.) | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G7** | ✅ **Resolved ([team#97](https://github.com/drasi-project/team/issues/97), #17, #21).** `addDurableJsReaction(id, queryIds, asyncCallback, options?)` opts a JS reaction into the engine's checkpoint machinery: it awaits the callback's promise and persists a per-query checkpoint after each success. Recovery policy (`skipGap`/`strict`) handles gaps. On a callback rejection the reaction applies `options.onError` (#21): **`retry`** (default) re-invokes with exponential backoff until it resolves — the loop stays parked on the failed event so its checkpoint can never be leapfrogged (**per-event at-least-once**), with an optional `maxRetries` budget (then escalates to `halt`), `retryDelayMs`, and `maxRetryDelayMs`; **`halt`** stops the reaction (status `error`) without advancing the checkpoint; **`skip`** logs and advances past the failed event (the historical stock behavior; at-most-once). Requires a durable state store (`DURABLE_REQUIRES_STATE_STORE` otherwise); pair with `indexStore` (G6) for cross-process outbox replay. | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G8** | ✅ **Resolved ([team#97](https://github.com/drasi-project/team/issues/97), #20).** A built-in identity provider is wired via an `identity: { kind: 'password' \| 'token', … }` option on `create`/`fromConfig` (`with_identity_provider`), injecting credentials into sources/reactions that need them. Config is validated synchronously (`IDENTITY_KIND_REQUIRED`/`UNKNOWN_IDENTITY_KIND`/`IDENTITY_CONFIG_INVALID`). | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G9** | ⚠️ **Partially resolved ([team#97](https://github.com/drasi-project/team/issues/97)).** Each plugin kind's declared config schema is now exposed via `sourceConfigSchema`/`reactionConfigSchema`/`bootstrapConfigSchema` (from the descriptors' `config_schema_json()`), and a plugin's config rejection carries a stable `[CONFIG_INVALID]` token in the message (async path; `err.code` stays `GenericFailure`) instead of an untokened error. **Remaining:** full in-Rust JSON-schema enforcement is deferred — the utoipa/OpenAPI dialect risks false-positive rejections of currently-valid configs; callers can validate against the exposed schema (e.g. ajv). | Medium | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G10** | ✅ **Resolved ([team#97](https://github.com/drasi-project/team/issues/97)).** `addQuery`/`updateQuery`/`fromConfig` now reject any `language` other than `"cypher"`/`"gql"` (or omitted) with a typed synchronous `UNKNOWN_QUERY_LANGUAGE` error instead of silently defaulting to Cypher. | Low | [team#97](https://github.com/drasi-project/team/issues/97) |
| **G11** | ✅ **Resolved.** `README.md`'s API overview now includes the metrics methods and `Drasi.fromConfig`, and links this reference. | Low | this PR |
| **G12** | ✅ **Resolved ([PR #6](https://github.com/drasi-project/drasi-nodejs/pull/6)).** Added Rust unit tests for the pure logic + a `cargo llvm-cov` line-coverage gate (scoped to `conversions.rs`/`error.rs`, floor 90%, measured ~95%), plus expanded error/edge and leak/soak integration tests (suite now 44 passing). | High | [team#99](https://github.com/drasi-project/team/issues/99) |
| **G13** | ✅ **#93/#94 resolved ([PR #4](https://github.com/drasi-project/drasi-nodejs/pull/4)).** Cross-platform prebuild matrix + tag-triggered npm publish pipeline (provenance; Linux glibc floor 2.35). **#95** (first publish) is prepared with a human checklist in `docs/releasing.md` and remains gated on npm scope access + credentials. | Blocker for release | [team#93](https://github.com/drasi-project/team/issues/93), [team#94](https://github.com/drasi-project/team/issues/94), [team#95](https://github.com/drasi-project/team/issues/95) |
| **G14** | Missing community/governance files (`LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, templates). | Medium | [team#100](https://github.com/drasi-project/team/issues/100) |

### Status & remaining work

Resolved since the original audit: **G1, G3** ([PR #3](https://github.com/drasi-project/drasi-nodejs/pull/3)),
**G2** ([PR #5](https://github.com/drasi-project/drasi-nodejs/pull/5)),
**G12** ([PR #6](https://github.com/drasi-project/drasi-nodejs/pull/6)), **G11**,
and **G5, G6, G7, G8, G10** plus a partial **G9** (team#97). **G4** is largely
resolved ([PR #5](https://github.com/drasi-project/drasi-nodejs/pull/5)) apart from
typing `ComponentStatus`, and **G13**'s pipeline is in place
([PR #4](https://github.com/drasi-project/drasi-nodejs/pull/4)) with the first
publish (**#95**) gated on human credentials.

Remaining:

1. **G9** full in-Rust JSON-schema enforcement (beyond the exposed schema + typed `CONFIG_INVALID`).
2. Community/governance files **G14** ([team#100](https://github.com/drasi-project/team/issues/100)).
3. First stable npm publish **#95** — human-gated; checklist in `docs/releasing.md`.
