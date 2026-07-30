---
title: "JavaScript Reactions"
linkTitle: "JavaScript Reactions"
weight: 20
description: >
  Handle continuous-query result changes with a plain JavaScript callback.
---

A **JavaScript reaction** is the simplest way to wire query results into your
application: register a callback with
[`addJsReaction`](../../api/#addjsreactionid-queryids-callback) and the engine invokes
it with the result diffs each time a subscribed query's result set changes.

## Add a reaction

```js
await drasi.addQuery(
  'hot-sensors',
  'MATCH (s:SensorReading) WHERE s.temperature > 25 RETURN s.sensor_id AS sensor, s.temperature AS temp',
  ['sensors'],
);

await drasi.addJsReaction('on-hot', ['hot-sensors'], (event) => {
  for (const diff of event.results) {
    if (diff.type === 'ADD') console.log('HOT:', diff.data);
    else if (diff.type === 'UPDATE') console.log('CHANGED:', diff.after);
    else if (diff.type === 'DELETE') console.log('COOLED:', diff.data);
  }
});
```

The callback receives a [`QueryResultEvent`](../../api/#queryresultevent). It is
invoked **once per non-empty batch** of changes — empty batches are skipped. A single
reaction can subscribe to multiple queries by listing several ids in the second
argument.

## Reading result diffs

Each entry in `event.results` is a `ResultDiff`, a tagged union on `type`:

| `type` | Payload | Meaning |
| --- | --- | --- |
| `ADD` | `{ data }` | A row entered the result set. |
| `UPDATE` | `{ before, after }` | A row's values changed. |
| `DELETE` | `{ data }` | A row left the result set. |
| `aggregation` | `{ before?, after }` | An aggregated value (`GROUP BY`, `count`, `sum`, …) changed. |
| `noop` | — | No effective change. |

A common pattern is to merge these diffs into a local table or push them to a UI:

```js
const rows = new Map();
await drasi.addJsReaction('sync-table', ['hot-sensors'], (event) => {
  for (const diff of event.results) {
    switch (diff.type) {
      case 'ADD':    rows.set(diff.data.sensor, diff.data); break;
      case 'UPDATE': rows.set(diff.after.sensor, diff.after); break;
      case 'DELETE': rows.delete(diff.data.sensor); break;
    }
  }
  render([...rows.values()]);
});
```

## Callbacks don't keep Node alive

JS reaction callbacks are registered as **unref'd** (weak) threadsafe functions.
That means a pending reaction will **not** by itself keep the Node.js event loop
alive — if your program has nothing else to do, it can still exit. Keep the process
running with your own work (a server, an interval, `process.stdin.resume()`, etc.)
while you want reactions to fire.

## Durable reactions

If dropping a change on a crash is unacceptable, use
[`addDurableJsReaction`](../../api/#adddurablejsreactionid-queryids-callback-options)
instead. The callback is **async**, and the engine checkpoints progress to a
persistent state store so a restart resumes after the last checkpoint:

```js
const drasi = await Drasi.create('app', {
  stateStore: { kind: 'redb', path: './state' },
  indexStore: { kind: 'rocksdb', path: './index' },
});
await drasi.start();

await drasi.addDurableJsReaction('notify', ['hot-sensors'], async (event) => {
  await sendAlert(event.results);          // awaited before the checkpoint advances
}, { recoveryPolicy: 'skipGap' });
```

A durable reaction **requires** a `stateStore` (otherwise it throws
`DURABLE_REQUIRES_STATE_STORE`). Note the durability model is **crash recovery of
not-yet-checkpointed results**, not per-event at-least-once delivery — see the note
in the [API reference](../../api/#adddurablejsreactionid-queryids-callback-options).

## Next

- [Concepts → Reactions](../../concepts/#reactions) — where reactions fit in the model.
- [Streaming & logs](../../api/#streaming-events--logs) — subscribe to component
  events and logs.
