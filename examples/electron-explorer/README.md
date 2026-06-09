# Drasi Plugin Explorer (Electron example)

A desktop app that drives the embedded **`@drasi/lib`**: browse and install
Drasi plugins from the live OCI registry, create sources / queries / reactions,
and watch their status, logs, results and metrics update live.

It's a GUI counterpart to the `examples/*.mjs` scripts — a small, local stand-in
for what `drasi-server` does, built entirely on the Node bindings.

![tabs: Plugins · Sources · Queries · Reactions · Observability]

## Why this works (architecture)

```
┌─────────────────────────── Electron main process (Node) ───────────────────────────┐
│  engine-host.ts   → one Drasi engine (redb state store, userData/plugins, secrets)   │
│  registry-service.ts → listPluginTags / pullPlugin against ghcr.io/drasi-project     │
│  ipc.ts           → ipcMain.handle(...) command handlers + topology persistence      │
│                     wires onAllEvents / on*Logs / a hidden addJsReaction per query   │
└───────────────▲───────────────────────────────────────────────┬─────────────────────┘
                │ ipcRenderer.invoke (commands)                  │ webContents.send (streams)
┌───────────────┴───────────────────────────────────────────────▼─────────────────────┐
│  preload (contextBridge)  →  window.drasi : DrasiApi                                   │
│  renderer (React + TS)    →  Plugins / Sources / Queries / Reactions / Observability   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- The engine runs **only in the main process**. The renderer is sandboxed
  (`contextIsolation`, `sandbox`, no `nodeIntegration`, CSP) and reaches the engine
  exclusively through a typed `window.drasi` bridge over IPC.
- The native addon is **N-API v9 (ABI-stable)**, so the prebuilt `.node` loads in
  Electron's bundled Node with **no `electron-rebuild`** and no per-Electron recompile.
- Live data: the main process subscribes to `onAllEvents` (status), `on*Logs` (logs),
  and registers a hidden `addJsReaction` per query (results), forwarding each item to
  the renderer on a single `drasi:stream` channel.

## Prerequisites

1. **Build the engine first** (this example depends on it via `file:../..`):
   ```bash
   cd ../..            # repo root: drasi-nodejs
   npm install
   npm run build       # produces index.js, index.d.ts and the .node binary
   ```
2. Node 18+ and the platform toolchain Electron needs.

## Run (development)

```bash
cd examples/electron-explorer
npm install
npm run dev
```

`npm run dev` starts electron-vite (renderer HMR + main/preload watch) and launches
the app.

## Build / package

```bash
npm run build      # type-check-free production bundle into out/
npm run package    # build + electron-builder (unpacked app in dist/)
```

`electron-builder.yml` uses `asarUnpack` for `**/*.node` and `node_modules/@drasi/lib/**`
so the native addon is loadable at runtime. `npm run typecheck` runs `tsc` over the
main/preload and renderer projects.

## Using the app

1. **Plugins** — browse the live directory (`ghcr.io/drasi-project`), pick a version
   matched to your platform, and **Install**. Installed binaries land in
   `<userData>/plugins` and are hot-loaded (and reloaded on restart). You can also
   *Import from folder…* to register locally-built plugins.
2. **Sources** — add a source from an installed kind (JSON config, optional bootstrap
   provider), or add a **JS source** and push graph changes (`insert`/`update`/`delete`,
   nodes or relations) by hand.
3. **Queries** — write a Cypher/GQL continuous query over one or more sources, then
   **Inspect** it to watch results stream in live (or *Load snapshot*).
4. **Reactions** — attach an installed reaction plugin to one or more queries.
5. **Observability** — status dashboard, live per-component logs (including plugin
   logs), and query/reaction/lifecycle metrics.

State persists under Electron's `userData` dir: installed plugins, the redb state
store (`state.redb`), and the created topology (`topology.json`, restored on launch).

## Notes & limitations

- **Config forms are raw JSON editors.** The engine exposes plugin *kinds* but not
  per-kind config schemas, so configs are entered as JSON (validated for syntax).
- **Secrets** are seeded once at engine creation. Drop a `secrets.json`
  (`{ "NAME": "value" }`) into the app's `userData` dir before launch to make them
  available to plugin `ConfigValue::Secret` references.
- **Platform tags**: installs pick the tag matching your OS/arch (e.g.
  `windows-msvc-amd64`, falling back to `windows-amd64`); some plugins may not publish
  a build for every platform.
- CSP allows `unsafe-eval`/`unsafe-inline` to accommodate the Vite dev server; tighten
  it for a production build if you harden this beyond an example.
