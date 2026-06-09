// Define a reaction in JavaScript: react to query result changes in-process,
// with no Rust plugin required.
//
//   npm run build && node examples/js-reaction.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Drasi } = require(join(root, 'index.js'));

const drasi = await Drasi.create('js-reaction-demo');
await drasi.loadPlugins(join(root, 'plugins'));
await drasi.start();

await drasi.addSource('mock', 'sensors', {
  dataType: { type: 'sensorReading', sensorCount: 3 },
  intervalMs: 400,
});

await drasi.addQuery(
  'hot-sensors',
  'MATCH (s:SensorReading) WHERE s.temperature > 25 RETURN s.sensor_id AS sensor, s.temperature AS temp',
  ['sensors'],
);

// The reaction is a plain JS callback. `json` is a serialized query result
// containing the added/updated/deleted rows for the query.
await drasi.addJsReaction('on-hot', ['hot-sensors'], (result) => {
  for (const diff of result.results) {
    if (diff.type === 'ADD') console.log('HOT:', diff.data);
    else if (diff.type === 'UPDATE') console.log('CHANGED:', diff.after);
    else if (diff.type === 'DELETE') console.log('COOLED:', diff.data);
  }
});

await new Promise((r) => setTimeout(r, 4000));
await drasi.stop();

