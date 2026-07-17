# @drasi/lib

Embed the [Drasi](https://drasi.io) continuous-query engine directly in your
Node.js application. `@drasi/lib` is a native ([napi-rs](https://napi.rs))
binding around Drasi's embeddable engine (`drasi-lib`) and its host SDK
(`drasi-host-sdk`), so you get:

- **In-process continuous queries** over a property graph, in Cypher or GQL.
- **Dynamic plugin loading** — discover and load Drasi source/reaction/bootstrap
  plugins (self-contained `cdylib` `.so`/`.dylib`/`.dll` files) at runtime, exactly
  like `drasi-server` does.
- **JavaScript-defined components** — define a **reaction** as a JS callback, or a
  **source** you push changes into from your own code. No Rust required.

> Status: pre-1.0 but functional and published to npm. The core engine, dynamic
> plugin loading with OCI plugin fetch (from `ghcr.io/drasi-project`), JS
> sources/reactions, streaming, lifecycle management, a secret store, a persistent
> state store (redb), concrete TypeScript types with typed error codes, and
> metrics are implemented and tested. Distributed with prebuilt binaries for
> Windows (x64), Linux (x64/arm64), and Apple-silicon macOS (arm64). The API is
> still evolving ahead of 1.0 — see the Roadmap below.

## Install

Once published, `@drasi/lib` ships **prebuilt binaries**, so consumers install with
no Rust toolchain:

```bash
npm install @drasi/lib
```

npm resolves the correct native binary from a per-platform optional dependency
(`@drasi/lib-<platform>`) for Windows (x64), Linux (x64/arm64), and Apple-silicon
macOS (arm64). Intel macOS (x64) has no prebuilt binary and must be built from
source. See [`docs/releasing.md`](./docs/releasing.md) for how the binaries are
built and distributed.

## Build from source

Building from source is only needed to develop `@drasi/lib` or to run on a platform
without a prebuilt binary. It builds a native addon whose Rust dependencies (the
Drasi engine and plugin host SDK) come from crates.io, so no sibling checkout is
required (see _Dependency strategy_):

```bash
npm install
npm run build          # produces index.js, index.d.ts and the .node binary
npm test
```

## Quickstart

```js
import { Drasi } from '@drasi/lib';

const drasi = await Drasi.create('my-app');

// Discover & load cdylib plugins from a directory.
await drasi.loadPlugins('./plugins');
await drasi.start();

// A source plugin produces graph changes...
await drasi.addSource('mock', 'counters', { dataType: { type: 'counter' }, intervalMs: 500 });

// ...a continuous query reacts to them...
await drasi.addQuery('big', 'MATCH (c:Counter) WHERE c.value > 3 RETURN c.value AS value', ['counters']);

// ...and you can read the live result set.
console.log(await drasi.getQueryResults('big'));
```

## Define a reaction in JavaScript

```js
await drasi.addJsReaction('on-change', ['big'], (result) => {
  // { query_id, sequence, results: [{ type: 'ADD'|'UPDATE'|'DELETE', data, before?, after? }] }
  for (const diff of result.results) {
    if (diff.type === 'ADD') console.log('added', diff.data);
  }
});
```

## Push changes from a JavaScript source

```js
await drasi.addJsSource('orders');
await drasi.addQuery('open', 'MATCH (o:Order) WHERE o.status = "open" RETURN o.id AS id', ['orders']);

await drasi.pushChange('orders', {
  op: 'insert',                 // insert | update | delete
  id: 'o1',
  labels: ['Order'],
  properties: { status: 'open', total: 42 },
});
```

See [`examples/`](./examples) for runnable scripts (`quickstart.mjs`,
`js-reaction.mjs`, `js-source.mjs`), and
[`examples/electron-explorer`](./examples/electron-explorer) for a full Electron +
React desktop app that browses/installs plugins and builds and observes a topology
on the embedded engine.

## API overview

`Drasi.create(id, options?)` → `Promise<Drasi>`. `options.secrets` seeds an
in-memory secret store (`{ secrets: { DB_PASSWORD: '…' } }`) that cdylib plugins
resolve `ConfigValue::Secret`/`EnvironmentVariable` references against;
`options.stateStore` (`{ kind: 'redb', path }`) enables a persistent plugin state store.
`Drasi.fromConfig(config)` builds **and starts** an engine from a declarative
object (see [`docs/api-reference.md`](./docs/api-reference.md) for the full,
method-by-method reference).

| Area | Methods |
| --- | --- |
| Plugins | `loadPlugins(dir, verify?)`, `watchPlugins(dir)`, `pluginKinds()`, `listPluginTags(repo)`, `pullPlugin(reference, destDir, filename)` |
| Sources | `addSource(kind, id, config, autoStart?, bootstrap?)`, `addJsSource(id, autoStart?)`, `pushChange(sourceId, change)`, `updateSource`, `startSource`, `stopSource`, `removeSource`, `listSources` |
| Queries | `addQuery(id, query, sources, language?, joins?)`, `updateQuery`, `startQuery`, `stopQuery`, `removeQuery`, `getQueryResults(id)`, `listQueries` |
| Reactions | `addReaction(kind, id, queryIds, config)`, `addJsReaction(id, queryIds, cb)`, `updateReaction`, `startReaction`, `stopReaction`, `removeReaction`, `listReactions` |
| Metrics | `getQueryMetrics(id)`, `getReactionMetrics(id)`, `getLifecycleMetrics()` |
| Streaming | `onAllEvents(cb)`, `onQueryEvents(id, cb)`, `onSourceEvents(id, cb)`, `onReactionEvents(id, cb)`, `onSourceLogs(id, cb)`, `onQueryLogs(id, cb)`, `onReactionLogs(id, cb)` |
| Lifecycle | `start()`, `stop()`, `close()` |

`language` is `"cypher"` (default) or `"gql"`. `pushChange` emits nodes, or
**relations** when `change` includes `startId`/`endId`. Generated TypeScript types
are in `index.d.ts`. Callbacks are unref'd, so they don't keep the Node process
alive on their own.

### Ordering tip

Call `start()` first, then add components. Components added to a running engine
auto-start individually. (Adding everything and then calling `start()` also works.)

## Types

The generated `index.d.ts` is self-contained: every config/result parameter and
return, plus the callback payloads, is exposed with a concrete TypeScript type
(no bare `any`). Import them directly from the package.

```ts
import type { SourceChangeInput, QueryResultEvent } from '@drasi/lib';
const change: SourceChangeInput = { op: 'insert', id: 'o1', labels: ['Order'] };
const onResult = (event: QueryResultEvent) => console.log(event.results.length);
```

## Error handling

Argument/validation failures throw a stable, machine-readable **code** so callers
can branch on it instead of matching human-readable messages. `DrasiErrorCode` is
exported as a regular (non-`const`) `enum` with string values — it is safe under
`isolatedModules` / esbuild / swc / Vite and has a real runtime value, so both the
type and value are usable:

```ts
import { DrasiErrorCode } from '@drasi/lib';

try {
  await drasi.addSource('unknown', 's', {});
} catch (err) {
  if ((err as { code?: string }).code === DrasiErrorCode.UnknownSourceKind) {
    // handle the unregistered-kind case
  }
}
```

Because napi-rs can only attach a custom `code` on a **synchronous** throw (async
promise rejections are forced to `code === 'GenericFailure'`), the two error
classes behave as follows — the human-readable message is the same in both cases:

- **Synchronous throws (`err.code` is the stable code).** Argument validation runs
  synchronously, before the method returns its `Promise`. This covers, on their
  normal paths: `UNKNOWN_SOURCE_KIND`, `UNKNOWN_REACTION_KIND`,
  `UNKNOWN_BOOTSTRAP_KIND`, `BOOTSTRAP_KIND_REQUIRED`, `MISSING_CONFIG_FIELD`,
  `NO_JS_SOURCE`, `JS_SOURCE_CLOSED`, `CHANGE_NOT_OBJECT`, `CHANGE_OP_REQUIRED`,
  `CHANGE_ID_REQUIRED`, `RELATION_REQUIRES_BOTH_ENDS`, `UNKNOWN_CHANGE_OP`,
  `STATE_STORE_PATH_REQUIRED`, and `UNKNOWN_STATE_STORE_KIND`. Note this means
  validation errors surface as a **synchronous throw** rather than a rejected
  promise — transparent to `await`/`try` callers, but a bare
  `p = fn(); p.catch(...)` (no `await`) will not catch them.
- **Async fallbacks (message-only; `err.code === 'GenericFailure'`).** A few paths
  can only fail after the async work has begun: component creation inside
  `fromConfig` (plugin kinds resolve after the async plugin load) and the rare
  race where a JS source closes mid-`pushChange`. There the stable code is embedded
  in the message as a trailing `[CODE]` token (e.g.
  `unknown source kind 'x' [UNKNOWN_SOURCE_KIND]`) so a single check still works:

```ts
function drasiCode(err: unknown): string | undefined {
  const e = err as { code?: string; message?: string };
  if (e.code && e.code !== 'GenericFailure') return e.code;        // sync throw
  return e.message?.match(/\[([A-Z_]+)\]\s*$/)?.[1];               // async fallback
}
```

## How it works

A `.node` addon is itself a `cdylib`, so it can host `drasi-lib` and `dlopen`
plugin cdylibs through `drasi-host-sdk` — the same mechanism `drasi-server` uses.
Plugins are fully self-contained, each with their own async runtime, and talk to
the host across a stable `#[repr(C)]` FFI with load-time version negotiation. JS
callbacks are bridged with napi `ThreadsafeFunction`s; async methods return
Promises driven by a Tokio runtime.

## Dependency strategy

The Drasi engine and host SDK are consumed from crates.io. The workspace versions
its crates on independent lines — only `drasi-host-sdk` and `drasi-plugin-sdk`
track the shared workspace version — so the pinned numbers differ by design
(`drasi-host-sdk`/`drasi-plugin-sdk` 0.10, `drasi-lib` 0.8, `drasi-core` 0.5), yet
their published dependency requirements resolve to a single coherent graph. Exact
versions are locked in `Cargo.lock`.

The FFI ABI is negotiated between `drasi-host-sdk` (host) and `drasi-plugin-sdk`
(plugins), which always share the workspace version, so any plugin built against a
matching `drasi-plugin-sdk` `major.minor` loads cleanly. The example plugins used
by the test suite are fetched from crates.io and built with `--features
dynamic-plugin` by `scripts/build-plugins.mjs` (the npm `pretest` step); bump their
pinned versions alongside `drasi-plugin-sdk` when upgrading the SDK.

## Roadmap

Implemented: dynamic plugin loading (+ optional SHA-256 verification), OCI plugin
fetch from `ghcr.io/drasi-project` (`pullPlugin`/`listPluginTags`), JS sources
(nodes + relations + bootstrap replay) and reactions, event & log streaming,
secret/env config resolution for plugins, bootstrap-provider wiring, persistent
state store (redb), plugin hot-reload, lifecycle/update APIs, concrete public
TypeScript types with typed error codes (`DrasiErrorCode`), and metrics accessors.
Published to npm with cross-platform prebuilt binaries and build provenance (see
[`docs/releasing.md`](./docs/releasing.md)).

Still to come:

- Cosign signature/lockfile enforcement on OCI pulls (verification status is
  surfaced today; enforcement is opt-in/future).
- RocksDB index provider; durable (checkpointed) JS reactions.
- Identity providers; declarative config-schema validation.
- Prebuilt binaries for Intel macOS (`x86_64-apple-darwin`); Intel-mac users
  currently build from source.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](./LICENSE).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development workflow and the DCO sign-off requirement, and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). To report a security issue, see
[SECURITY.md](./SECURITY.md).
