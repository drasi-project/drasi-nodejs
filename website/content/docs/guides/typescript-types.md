---
title: "TypeScript Types"
linkTitle: "TypeScript Types"
weight: 50
description: >
  The generated index.d.ts is self-contained — import concrete types directly.
---

`@drasi/lib` ships first-class TypeScript support. The generated `index.d.ts` is
**self-contained**: every config parameter, result, return value, and callback
payload is exposed with a concrete type — no bare `any` — so you get full editor
completion and type-checking out of the box.

## Import types directly

```ts
import type { SourceChangeInput, QueryResultEvent } from '@drasi/lib';

const change: SourceChangeInput = { op: 'insert', id: 'o1', labels: ['Order'] };

const onResult = (event: QueryResultEvent) => console.log(event.results.length);
```

## Types you'll use most

| Type | Where it appears |
| --- | --- |
| `CreateOptions` | `Drasi.create(id, options)` |
| `DrasiConfig` | `Drasi.fromConfig(config)` |
| `SourceChangeInput` | `pushChange(sourceId, change)` |
| `QueryJoin` | the `joins` argument to `addQuery` / `updateQuery` |
| `QueryResultEvent`, `ResultDiff` | JS reaction callbacks |
| `LogMessage`, `ComponentEvent` | streaming callbacks |
| `QueryMetrics`, `ReactionQueryMetrics`, `LifecycleMetrics` | the metrics accessors |
| `ComponentStatusEntry` | `listSources` / `listQueries` / `listReactions` |
| `DrasiErrorCode` | typed error handling (a real runtime enum) |

## `DrasiErrorCode` is a real value, not just a type

Unlike the shape types above, `DrasiErrorCode` is exported as a regular
(non-`const`) `enum` with string values, so you can import it as a **value** and
compare against it at runtime — safe under `isolatedModules`, esbuild, swc, and Vite:

```ts
import { DrasiErrorCode } from '@drasi/lib';

if (code === DrasiErrorCode.UnknownSourceKind) { /* ... */ }
```

See [Error handling](../error-handling/) for the full pattern.

## Type-checking the definitions

The repository type-checks its own `.d.ts` in CI under `--strict`
`--isolatedModules`. If you're contributing, you can run the same check:

```bash
npm run test:types
```

## Next

- [API reference](../../api/) — the method surface these types describe.
- [Error handling](../error-handling/) — using the `DrasiErrorCode` enum.
