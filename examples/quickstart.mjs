// Quickstart: load a cdylib source plugin, run a continuous query, read results.
//
//   npm run build && node examples/quickstart.mjs
//
// In an installed package you would simply:  import { Drasi } from '@drasi/lib'
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Drasi } = require(join(root, 'index.js'));

const drasi = await Drasi.create('quickstart');
await drasi.loadPlugins(join(root, 'plugins'));
await drasi.start();

await drasi.addSource('mock', 'counters', {
  dataType: { type: 'counter' },
  intervalMs: 300,
});

await drasi.addQuery(
  'big-counters',
  'MATCH (c:Counter) WHERE c.value > 3 RETURN c.value AS value',
  ['counters'],
);

await new Promise((r) => setTimeout(r, 2500));
console.log('results:', await drasi.getQueryResults('big-counters'));

await drasi.stop();

