# Drasi Trading Demo (Electron example)

A minimal, self-contained desktop app that embeds the Drasi continuous-query
engine (`@drasi/lib`) and renders **live** query results in its own window —
no browser, no HTTP/SSE, no REST, no Python.

It is a faithful port of drasi-server's
[`examples/trading`](https://github.com/drasi-project/drasi-server/tree/main/examples/trading)
demo, reduced to the smallest amount of code that still conveys the key ideas:

- **Real PostgreSQL CDC** — reference data (`stocks`, `portfolio`, `watchlist`)
  lives in a real Postgres database and is streamed into the engine via Drasi's
  Postgres source (logical replication) plus a Postgres bootstrap snapshot.
- **Synthetic joins** — `HAS_PRICE`, `OWNS_STOCK`, `ON_WATCHLIST` relate
  elements across sources (and across a database and a live feed) with no
  foreign keys, entirely inside the query.
- **In-process price feed** — a tiny Node random-walk generator pushes
  `stock_prices` into a JavaScript-defined source. (This replaces the upstream
  Python generator + HTTP source.)
- **Application reaction** — one `addJsReaction` per query streams result diffs
  straight to the renderer over a single IPC channel; the dashboard merges
  ADD/UPDATE/DELETE/aggregation diffs into live tables.
- **Plugins downloaded at runtime** — the Postgres source + bootstrap plugins
  are pulled from the public OCI registry (`ghcr.io/drasi-project`) on first
  launch and cached under the app's user-data directory. Nothing is baked in.

## Architecture

```
Postgres (Docker)                      Electron main (embeds @drasi/lib)
┌───────────────────┐  logical repl.   ┌───────────────────────────────────┐
│ stocks            │ ───────────────► │ postgres source  ┐                 │
│ portfolio         │   + bootstrap    │ (downloaded OCI) ├─► queries (5)    │
│ watchlist         │                  │ price-feed (JS) ─┘   + synthetic    │
└───────────────────┘                  │   ▲                    joins        │
                                        │   │ pushChange                     │
   in-process price generator ──────────┘   │              addJsReaction     │
   (random walk, setInterval)               │                   │            │
                                            └───────────────────┼────────────┘
                                                  IPC: trading:stream
                                                                 ▼
                                            Electron renderer (React dashboard)
```

The native addon is N-API v9 (ABI-stable), so it loads directly in Electron's
main process with no `electron-rebuild`. `electron-vite` keeps the `.node` out of
the bundle, and the sandboxed preload is emitted as CommonJS (`index.cjs`).

## Prerequisites

- **Docker Desktop** running (for the PostgreSQL database).
- **Network access on first launch** (to download the Postgres plugins from
  `ghcr.io/drasi-project`; cached afterwards).
- The root `@drasi/lib` package must be built first:

  ```bash
  # from the repository root
  npm install
  npm run build
  ```

## Run (development)

```bash
cd examples/trading
npm install
npm run db:up      # start PostgreSQL (waits until healthy)
npm run dev        # launch the Electron app
```

Stock prices start moving immediately; the panels update live as joins and
aggregations recompute. When you're done:

```bash
npm run db:down    # stop PostgreSQL and remove its volume
```

## Build / package

```bash
npm run build      # type-checked production build into out/
npm run package    # build + electron-builder (unpacked app in dist/)
```

## Queries on the dashboard

| Panel | Demonstrates |
| --- | --- |
| **Watchlist** | 3-way synthetic join across two sources (`watchlist → stocks → stock_prices`) + computed change % |
| **Portfolio P&L** | Multi-source join + computed fields (value, P&L, P&L %) recomputed on every tick |
| **Top Gainers** | `WHERE` filtering that re-evaluates as prices move |
| **Sector Performance** | Real-time `GROUP BY` aggregation (count / sum / min / max) |
| **Price Ticker** | Single-source, high-frequency feed (no joins) |

Query and join definitions live in [`src/shared/queries.ts`](src/shared/queries.ts)
and are ported verbatim from the upstream demo.

## How it maps to the upstream demo

| Upstream (drasi-server trading) | This example |
| --- | --- |
| PostgreSQL via docker-compose (`wal_level=logical`, init.sql) | Same (`database/docker-compose.yml` + trimmed `database/init.sql`) |
| `postgres-stocks` CDC source + `postgres` bootstrap | Same plugins, **downloaded from OCI at startup** |
| HTTP price feed + Python generator | In-process Node random-walk → JavaScript source `price-feed` |
| SSE reaction + browser `EventSource` | `addJsReaction` → single IPC channel → renderer |
| REST API to create queries/reactions | Direct engine calls in `main` at startup |

## Notes & limitations

- The demo seeds Postgres once at container init. The Drasi source creates its
  own logical replication slot on first connect (the slot is intentionally **not**
  pre-created in `init.sql`, which would otherwise make CDC replay the seed rows
  on top of the bootstrap snapshot and double-count them).
- Out of scope (kept in the upstream demo): limit orders / broker source,
  `drasi.trueFor` stale-order queries, packaging installers, cross-platform
  prebuilds, and running Postgres without Docker.
