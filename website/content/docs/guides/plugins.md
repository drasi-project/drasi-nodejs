---
title: "Working with Plugins"
linkTitle: "Working with Plugins"
weight: 30
description: >
  Load native Drasi source, reaction, and bootstrap plugins at runtime.
---

Beyond [JavaScript sources](../js-sources/) and [reactions](../js-reactions/),
`@drasi/lib` can host Drasi's native **plugins** — the same self-contained cdylib
files (`.so`/`.dylib`/`.dll`) that `drasi-server` loads. This lets you connect to
real systems (for example PostgreSQL) with the exact same connectors used in
production Drasi deployments.

## How plugin hosting works

A `.node` addon is itself a `cdylib`, so it can host the embeddable engine and
`dlopen` plugin cdylibs through `drasi-host-sdk` — the same mechanism `drasi-server`
uses. Each plugin is fully self-contained (its own async runtime) and talks to the
host across a stable `#[repr(C)]` FFI with load-time version negotiation.

## Load plugins from a directory

Point [`loadPlugins`](../../api/#loadpluginsdir-verify) at a directory of cdylib
files. It discovers matching files, registers their descriptors, and makes their
`kind`s available to `addSource` / `addReaction`:

```js
const drasi = await Drasi.create('with-plugins');

const counts = await drasi.loadPlugins('./plugins');
// { plugins, sources, reactions, bootstrap }
console.log('registered kinds:', drasi.pluginKinds());

await drasi.start();
await drasi.addSource('mock', 'counters', {
  dataType: { type: 'counter' }, intervalMs: 300,
});
```

Discovery matches fixed name patterns (`libdrasi_source_*`, `drasi_reaction_*`,
`*_bootstrap_*`, `*_secret_store_*`, `*_identity_*`, with or without the `lib`
prefix).

### Verify integrity

Pass a `{ filename: sha256hex }` allowlist as the second argument to load **only**
files whose contents hash to the expected value:

```js
await drasi.loadPlugins('./plugins', {
  'libdrasi_source_postgres.so': 'e3b0c442...',
});
```

### Hot-reload

[`watchPlugins(dir)`](../../api/#watchpluginsdir) watches a directory and
hot-(re)loads plugins as files are added or changed (1s debounce). Removed files
deregister their kinds.

## Pull plugins from an OCI registry

You don't have to ship plugin binaries yourself — pull them at runtime from the
public `ghcr.io/drasi-project` OCI registry.

```js
// Discover available versions...
const tags = await drasi.listPluginTags('source/postgres');

// ...then download one to a local directory.
const { path, verification } = await drasi.pullPlugin(
  'ghcr.io/drasi-project/source/postgres:0.1.13-linux-glibc-amd64',
  './plugins',
  'libdrasi_source_postgres.so',
);

// Register what you pulled.
await drasi.loadPlugins('./plugins');
```

### Signature verification

`pullPlugin` supports opt-in [cosign](https://docs.sigstore.dev/) signature
enforcement via its `options` argument:

```js
await drasi.pullPlugin(ref, './plugins', filename, {
  verify: true,          // reject tampered / untrusted artifacts
  requireSigned: true,   // additionally reject unsigned artifacts
  trustedIdentities: [{ issuer: 'https://token.actions.githubusercontent.com',
                        subjectPattern: 'https://github.com/drasi-project/*' }],
});
```

The returned `verification` is `{ status: 'unsigned' | 'verified' | 'tampered', ... }`.
When verification is enabled, a tampered — or valid-but-untrusted — artifact is
deleted and the promise rejects.

## Validate plugin config

Each plugin declares a config schema you can retrieve **synchronously** and validate
against before creating a component:

```js
const { name, schema } = drasi.sourceConfigSchema('postgres');
// Feed `schema` to a JSON-schema validator such as ajv, keyed on `name`.
```

`reactionConfigSchema(kind)` and `bootstrapConfigSchema(kind)` work the same way. An
unregistered kind throws a typed error (`UNKNOWN_SOURCE_KIND`, etc.).

## Bootstrap providers

Attach a **bootstrap** provider to a source so newly subscribed queries receive an
initial snapshot of existing data before live changes flow:

```js
await drasi.addSource('postgres', 'db', pgConfig, true, {
  kind: 'postgres',
  config: bootstrapConfig,
});
```

## Next

- [API reference → Plugins](../../api/#plugins) — full signatures for every plugin method.
- [Trading demo](../../examples/trading/) — pulls the PostgreSQL source and bootstrap
  plugins from `ghcr.io/drasi-project` at startup.
