// Drive a Drasi query from a JavaScript-defined source: push graph changes from
// your own application code (e.g. from an event stream, webhook, or DB CDC).
//
//   npm run build && node examples/js-source.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Drasi } = require(join(root, 'index.js'));

const drasi = await Drasi.create('js-source-demo');
await drasi.start();

await drasi.addJsSource('orders');
await drasi.addQuery(
  'open-orders',
  "MATCH (o:Order) WHERE o.status = 'open' RETURN o.id AS id, o.total AS total",
  ['orders'],
);

// React to the query in JS too, so we can watch it change live.
await drasi.addJsReaction('print', ['open-orders'], (result) => {
  console.log('open-orders =>', result.results);
});

// Push some changes from application code.
await drasi.pushChange('orders', { op: 'insert', id: 'o1', labels: ['Order'], properties: { id: 'o1', status: 'open', total: 42 } });
await drasi.pushChange('orders', { op: 'insert', id: 'o2', labels: ['Order'], properties: { id: 'o2', status: 'open', total: 17 } });
await new Promise((r) => setTimeout(r, 300));

// Close order o1 — it drops out of the query.
await drasi.pushChange('orders', { op: 'update', id: 'o1', labels: ['Order'], properties: { id: 'o1', status: 'closed', total: 42 } });
await new Promise((r) => setTimeout(r, 300));

console.log('final:', await drasi.getQueryResults('open-orders'));
await drasi.stop();

