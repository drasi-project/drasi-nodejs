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

> Status: early. The core engine, dynamic plugin loading, JS sources/reactions,
> streaming, lifecycle management and a secret store are implemented and tested.
> OCI plugin fetch, persistence providers and cross-platform prebuilt binaries are
> on the roadmap (see below).

## Install / build

This package builds a native addon. Its Rust dependencies (the Drasi engine and
plugin host SDK) come from crates.io, so no sibling checkout is required (see
_Dependency strategy_). Then:

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

Companion helper types are available in `types.d.ts` for config and callback
shapes that the generated `index.d.ts` currently exposes as `any`.

```ts
import type { SourceChangeInput, QueryResultEvent } from '@drasi/lib/types.d.ts';
const change: SourceChangeInput = { op: 'insert', id: 'o1', labels: ['Order'] };
const onResult = (event: QueryResultEvent) => console.log(event.results.length);
```

They can also be referenced with a `/// <reference path="..." />` directive.

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
state store (redb), plugin hot-reload, and lifecycle/update APIs.

Still to come:

- Cosign signature/lockfile enforcement on OCI pulls (verification status is
  surfaced today; enforcement is opt-in/future).
- RocksDB index provider; durable (checkpointed) JS reactions.
- Identity providers; declarative config-schema validation.
- Cross-platform prebuilt binaries (win/mac/linux × x64/arm64) published to npm.
- Richer TypeScript types for configs/results (companion `types.d.ts` ships today);
  typed error codes.

## License

Apache-2.0
