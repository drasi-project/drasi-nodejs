---
title: "Getting Started"
linkTitle: "Getting Started"
weight: 10
description: >
  Install @drasi/lib and run your first continuous query in Node.js.
---

This guide gets you from an empty folder to a running **continuous query** in a
couple of minutes. You'll push some changes from your own code and watch the query
result update live — no database, no server, no Kubernetes.

## Prerequisites

- **Node.js 18 or newer.**
- A supported platform for the prebuilt binary: **Windows (x64)**, **Linux
  (x64/arm64)**, or **Apple-silicon macOS (arm64)**. Intel macOS (x64) has no
  prebuilt binary yet and must be [built from source](#building-from-source).

No Rust toolchain is required — `@drasi/lib` ships prebuilt native binaries and
npm resolves the correct one for your platform automatically.

## Install

```bash
npm install @drasi/lib
```

npm pulls in a per-platform optional dependency (`@drasi/lib-<platform>`) that
contains the native addon for your OS and architecture.

## Your first continuous query

Create `first-query.mjs`. This example defines a **source** in plain JavaScript,
runs a **continuous query** over it, and prints the result set as it changes — all
in-process.

```js
import { Drasi } from '@drasi/lib';

// 1. Create and start the embedded engine.
const drasi = await Drasi.create('getting-started');
await drasi.start();

// 2. Add a JavaScript-defined source you can push changes into.
await drasi.addJsSource('orders');

// 3. Add a continuous query. It stays up to date as 'orders' changes.
await drasi.addQuery(
  'open-orders',
  "MATCH (o:Order) WHERE o.status = 'open' RETURN o.id AS id, o.total AS total",
  ['orders'],
);

// 4. React to result changes with a plain JS callback.
await drasi.addJsReaction('print', ['open-orders'], (event) => {
  console.log('open-orders =>', event.results);
});

// 5. Push some changes from your application code.
await drasi.pushChange('orders', {
  op: 'insert', id: 'o1', labels: ['Order'],
  properties: { id: 'o1', status: 'open', total: 42 },
});
await drasi.pushChange('orders', {
  op: 'insert', id: 'o2', labels: ['Order'],
  properties: { id: 'o2', status: 'open', total: 17 },
});

// Close order o1 — it drops out of the query automatically.
await new Promise((r) => setTimeout(r, 200));
await drasi.pushChange('orders', {
  op: 'update', id: 'o1', labels: ['Order'],
  properties: { id: 'o1', status: 'closed', total: 42 },
});

await new Promise((r) => setTimeout(r, 200));
console.log('final:', await drasi.getQueryResults('open-orders'));
await drasi.close();
```

Run it:

```bash
node first-query.mjs
```

You'll see the reaction fire as orders are added, and again when `o1` is closed and
leaves the result set. The final snapshot contains only the still-open `o2`.

{{% alert title="What just happened?" color="info" %}}
You never asked Drasi "which orders are open *now*?" — you declared the query
**once**, and the engine keeps its result current and streams you the *added*,
*updated*, and *removed* rows as the underlying data changes. That's the
change-driven model. Read more in [Concepts](../concepts/).
{{% /alert %}}

## Loading native plugins

The example above defined its source in JavaScript. You can also load Drasi's
native **plugins** (the same `.so`/`.dylib`/`.dll` cdylibs that `drasi-server`
uses) to connect to real systems such as PostgreSQL:

```js
const drasi = await Drasi.create('with-plugins');

// Discover and register plugins from a directory...
await drasi.loadPlugins('./plugins');
await drasi.start();

// ...then use their `kind` like any other source.
await drasi.addSource('mock', 'counters', {
  dataType: { type: 'counter' },
  intervalMs: 300,
});
await drasi.addQuery(
  'big-counters',
  'MATCH (c:Counter) WHERE c.value > 3 RETURN c.value AS value',
  ['counters'],
);
```

You can also pull plugins straight from the `ghcr.io/drasi-project` OCI registry at
runtime — see [Working with plugins](../guides/plugins/).

## Building from source

Building from source is only needed to develop `@drasi/lib` or to run on a platform
without a prebuilt binary (for example Intel macOS). It requires a Rust toolchain
and builds a native addon whose Drasi dependencies come from crates.io:

```bash
git clone https://github.com/drasi-project/drasi-nodejs.git
cd drasi-nodejs
npm install
npm run build          # produces index.js, index.d.ts and the .node binary
npm test
```

## Next steps

- [Concepts](../concepts/) — the mental model: sources, continuous queries, and
  reactions.
- [API reference](../api/) — every method on the `Drasi` class.
- [Guides](../guides/) — JavaScript sources and reactions, plugins, error handling,
  and TypeScript types.
- [Trading demo](../examples/trading/) — a full end-to-end example that joins a
  live price feed against a PostgreSQL database.
