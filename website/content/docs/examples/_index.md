---
title: "Examples"
linkTitle: "Examples"
weight: 50
description: >
  Runnable examples, from a one-file quickstart to a full desktop app.
---

The repository ships several runnable examples. Each is self-contained and
demonstrates a different slice of `@drasi/lib`.

## Single-file scripts

These live in [`examples/`](https://github.com/drasi-project/drasi-nodejs/tree/main/examples)
and run with `node` after you build the addon (`npm run build`):

| Script | Shows |
| --- | --- |
| [`quickstart.mjs`](https://github.com/drasi-project/drasi-nodejs/blob/main/examples/quickstart.mjs) | Load a cdylib source plugin, run a continuous query, read results. |
| [`js-source.mjs`](https://github.com/drasi-project/drasi-nodejs/blob/main/examples/js-source.mjs) | Drive a query from a [JavaScript source](../guides/js-sources/) with `pushChange`. |
| [`js-reaction.mjs`](https://github.com/drasi-project/drasi-nodejs/blob/main/examples/js-reaction.mjs) | Handle result diffs with a [JavaScript reaction](../guides/js-reactions/). |

Run one like this:

```bash
git clone https://github.com/drasi-project/drasi-nodejs.git
cd drasi-nodejs
npm install
npm run build
node examples/js-source.mjs
```

## End-to-end apps

| Example | Shows |
| --- | --- |
| [Trading demo](trading/) | A full Electron + React desktop app: real PostgreSQL CDC, an in-process JS price feed, synthetic joins, live aggregations, and OCI plugins pulled at runtime. |
| [Electron explorer](https://github.com/drasi-project/drasi-nodejs/tree/main/examples/electron-explorer) | Browse and install plugins, then build and observe a topology on the embedded engine. |

Start with the [**Trading demo tutorial**](trading/) for a guided walkthrough of a
realistic change-driven application.
