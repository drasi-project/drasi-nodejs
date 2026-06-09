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

This package builds a native addon and depends (for now) on a local checkout of
[`drasi-core`](https://github.com/drasi-project/drasi-core) as a sibling directory
(see _Dependency strategy_). Then:

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

| Area | Methods |
| --- | --- |
| Plugins | `loadPlugins(dir, verify?)`, `watchPlugins(dir)`, `pluginKinds()`, `listPluginTags(repo)`, `pullPlugin(reference, destDir, filename)` |
| Sources | `addSource(kind, id, config, autoStart?, bootstrap?)`, `addJsSource(id, autoStart?)`, `pushChange(sourceId, change)`, `updateSource`, `startSource`, `stopSource`, `removeSource`, `listSources` |
| Queries | `addQuery(id, query, sources, language?, joins?)`, `updateQuery`, `startQuery`, `stopQuery`, `removeQuery`, `getQueryResults(id)`, `listQueries` |
| Reactions | `addReaction(kind, id, queryIds, config)`, `addJsReaction(id, queryIds, cb)`, `updateReaction`, `startReaction`, `stopReaction`, `removeReaction`, `listReactions` |
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

The published Drasi crates are currently version-skewed (`drasi-host-sdk` 0.8.4 vs
`drasi-lib`/`drasi-plugin-sdk` 0.8.5, which are ABI-incompatible). Until a
consistent set is published, `Cargo.toml` uses **path dependencies** to a local
`../drasi-core` checkout so the host and any plugins built from the same source
share an identical plugin SDK / FFI ABI. Plugins must be built with
`--features dynamic-plugin` and must match the host's plugin-SDK `major.minor`.

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
- Resolve the published-crate skew (needs `drasi-host-sdk` 0.8.5) to drop the path deps.

## License

Apache-2.0
