---
title: "JavaScript Sources"
linkTitle: "JavaScript Sources"
weight: 10
description: >
  Push graph changes into the engine from your own Node.js code.
---

A **JavaScript source** lets you feed the engine directly from your application —
an event stream, a webhook handler, database CDC, or anything else your code already
sees. You register the source with
[`addJsSource`](../../api/#addjssourceid-autostart) and push changes into it with
[`pushChange`](../../api/#pushchangesourceid-change). No Rust and no plugins required.

## Register a source

```js
import { Drasi } from '@drasi/lib';

const drasi = await Drasi.create('orders-app');
await drasi.start();

await drasi.addJsSource('orders');
```

A JS source maintains a **current-state snapshot** of the elements you've pushed, so
a query that subscribes *after* you've already pushed changes still receives a
bootstrap replay of the live elements.

## Push a node change

Nodes are graph elements with labels and properties. The `op` is one of `insert`,
`update`, or `delete` (`add`/`remove` are accepted aliases, case-insensitive):

```js
await drasi.pushChange('orders', {
  op: 'insert',
  id: 'o1',
  labels: ['Order'],
  properties: { id: 'o1', status: 'open', total: 42 },
});

// Later, update it — the change flows through every subscribed query.
await drasi.pushChange('orders', {
  op: 'update',
  id: 'o1',
  labels: ['Order'],
  properties: { id: 'o1', status: 'closed', total: 42 },
});

// Or delete it.
await drasi.pushChange('orders', { op: 'delete', id: 'o1', labels: ['Order'] });
```

## Push a relation (edge)

To emit a **relation** instead of a node, include **both** `startId` and `endId`
(aliases `inId` / `outId`). Supplying only one is an error:

```js
await drasi.pushChange('orders', {
  op: 'insert',
  id: 'o1-c1',
  labels: ['PLACED_BY'],
  startId: 'o1',    // the Order node
  endId: 'c1',      // the Customer node
});
```

## Backpressure

`pushChange` writes into a bounded channel (capacity 1024). The returned promise
resolves once the change is **buffered**, and applies backpressure when the buffer is
full — so `await`-ing each `pushChange` naturally paces a fast producer:

```js
for (const event of hugeStream) {
  await drasi.pushChange('orders', toChange(event)); // waits if the buffer is full
}
```

## Fields reference

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `op` | `'insert' \| 'update' \| 'delete'` | yes | `add`/`remove` accepted as aliases. |
| `id` | `string` | yes | Element id. |
| `labels` | `string[] \| string` | no | Node labels or relation type. |
| `properties` | `Record<string, unknown>` | no | Arbitrary element properties. |
| `startId` / `endId` | `string` | both-or-neither | Present ⇒ the change is a relation. |
| `effectiveFrom` | `number` | no | Epoch ms; defaults to now. |

## Error cases

`pushChange` validates its input **synchronously** and throws a typed
[`DrasiErrorCode`](../error-handling/):

- `NO_JS_SOURCE` — no JS source with that id.
- `CHANGE_NOT_OBJECT`, `CHANGE_OP_REQUIRED`, `CHANGE_ID_REQUIRED`, `UNKNOWN_CHANGE_OP`.
- `RELATION_REQUIRES_BOTH_ENDS` — only one of `startId`/`endId` was supplied.
- `JS_SOURCE_CLOSED` — the source was removed mid-push (this one can surface as an
  async rejection; see [Error handling](../error-handling/)).

## Next

- [JavaScript reactions](../js-reactions/) — consume the query results your source drives.
- [Trading demo](../../examples/trading/) — a JS source (a live price feed) joined
  against a real PostgreSQL database.
