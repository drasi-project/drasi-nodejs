// Integration tests for @drasi/lib, run against the built native addon.
//   npm run build && npm test
//
// Quiet the engine's tracing output unless the caller overrides RUST_LOG.
process.env.RUST_LOG = process.env.RUST_LOG || 'error';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Drasi } = require(join(root, 'index.js'));
const pluginsDir = join(root, 'plugins');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const error = new Error('timed out waiting for ' + message);
  if (lastError) error.cause = lastError;
  throw error;
}

async function waitForRows(d, queryId, predicate, opts) {
  return waitFor(async () => {
    const rows = await d.getQueryResults(queryId);
    return predicate(rows) ? rows : undefined;
  }, { message: `rows for query ${queryId}`, ...opts });
}

test('discovers and loads cdylib plugins', async () => {
  const d = await Drasi.create('t-load');
  const summary = await d.loadPlugins(pluginsDir);
  assert.ok(summary.plugins >= 2, `expected >=2 plugins, got ${summary.plugins}`);
  const kinds = d.pluginKinds();
  assert.ok(kinds.sources.includes('mock'), 'mock source registered');
  assert.ok(kinds.reactions.includes('log'), 'log reaction registered');
  await d.stop();
});

test('cdylib source feeds a continuous query', async () => {
  const d = await Drasi.create('t-cdylib');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  const results = await waitForRows(d, 'q', (rows) => rows.length > 0);
  assert.ok(Array.isArray(results), 'results is an array');
  assert.ok(results.length > 0, 'query produced results');
  await d.stop();
});

test('cdylib plugin resolves a Secret config value', async () => {
  const d = await Drasi.create('t-secret', { secrets: { INTERVAL: '120' } });
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', {
    dataType: { type: 'counter' },
    intervalMs: { kind: 'Secret', name: 'INTERVAL' },
  });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  const results = await waitForRows(d, 'q', (rows) => rows.length > 0);
  assert.ok(results.length > 0, 'secret-resolved interval produced results');
  await d.stop();
});

test('cdylib plugin resolves an EnvironmentVariable config value', async () => {
  process.env.MOCK_INTERVAL = '120';
  const d = await Drasi.create('t-env');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', {
    dataType: { type: 'counter' },
    intervalMs: { kind: 'EnvironmentVariable', name: 'MOCK_INTERVAL' },
  });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  const results = await waitForRows(d, 'q', (rows) => rows.length > 0);
  assert.ok(results.length > 0, 'env-resolved interval produced results');
  await d.stop();
});

test('JavaScript-defined reaction streams query results', async () => {
  const d = await Drasi.create('t-jsreaction');
  await d.loadPlugins(pluginsDir);
  await d.start();
  const received = [];
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  await d.addJsReaction('jsr', ['q'], (result) => {
    received.push(result);
  });
  await waitFor(() => received.length > 0, { message: 'reaction results' });
  await d.stop();
  assert.ok(received.length > 0, 'JS reaction received results');
  assert.equal(received[0].query_id, 'q');
});

test('GQL query over a cdylib source', async () => {
  const d = await Drasi.create('t-gql');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src'], 'gql');
  const results = await waitForRows(d, 'q', (rows) => rows.length > 0);
  assert.ok(results.length > 0, 'gql query produced results');
  await d.stop();
});

test('addSource with unknown bootstrap kind errors clearly', async () => {
  const d = await Drasi.create('t-bs');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await assert.rejects(
    () =>
      d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 }, true, {
        kind: 'nope',
      }),
    /unknown bootstrap kind 'nope'/,
  );
  await d.stop();
});

test('JavaScript programmatic source pushes graph changes', async () => {
  const d = await Drasi.create('t-jssource');
  await d.start();
  await d.addJsSource('jssrc');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['jssrc']);
  await d.pushChange('jssrc', {
    op: 'insert',
    id: 'n1',
    labels: ['Thing'],
    properties: { name: 'alpha' },
  });
  await d.pushChange('jssrc', {
    op: 'insert',
    id: 'n2',
    labels: ['Thing'],
    properties: { name: 'beta' },
  });
  const results = await waitForRows(d, 'q', (rows) => {
    const names = rows.map((r) => r.name).sort();
    return names.length === 2 && names[0] === 'alpha' && names[1] === 'beta';
  });
  const names = results.map((r) => r.name).sort();
  assert.deepEqual(names, ['alpha', 'beta']);
  await d.stop();
});

test('JavaScript source update and delete propagate', async () => {
  const d = await Drasi.create('t-jssource-mut');
  await d.start();
  await d.addJsSource('jssrc');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['jssrc']);
  await d.pushChange('jssrc', { op: 'insert', id: 'n1', labels: ['Thing'], properties: { name: 'one' } });
  await waitForRows(d, 'q', (rows) => rows.map((r) => r.name).join(',') === 'one');
  await d.pushChange('jssrc', { op: 'update', id: 'n1', labels: ['Thing'], properties: { name: 'updated' } });
  let results = await waitForRows(d, 'q', (rows) => rows.map((r) => r.name).join(',') === 'updated');
  assert.deepEqual(results.map((r) => r.name), ['updated']);

  await d.pushChange('jssrc', { op: 'delete', id: 'n1', labels: ['Thing'] });
  results = await waitForRows(d, 'q', (rows) => rows.length === 0);
  assert.equal(results.length, 0, 'row removed after delete');
  await d.stop();
});

test('lifecycle: list and remove components', async () => {
  const d = await Drasi.create('t-lifecycle');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 200 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);

  const sources = await d.listSources();
  assert.ok(sources.find((s) => s.id === 'src'), 'source listed');
  const queries = await d.listQueries();
  assert.ok(queries.find((q) => q.id === 'q'), 'query listed');

  await d.removeQuery('q');
  const after = await d.listQueries();
  assert.ok(!after.find((q) => q.id === 'q'), 'query removed');
  await d.stop();
});

test('event streaming delivers component lifecycle events', async () => {
  const d = await Drasi.create('t-events');
  const events = [];
  await d.onAllEvents((e) => events.push(e));
  await d.start();
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['s']);
  await waitFor(() => events.length > 0, { message: 'events' });
  assert.ok(events.length > 0, 'received component lifecycle events');
  await d.stop();
});

test('JavaScript source emits relations (edges)', async () => {
  const d = await Drasi.create('t-rel');
  await d.start();
  await d.addJsSource('g');
  await d.addQuery(
    'q',
    'MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a.name AS a, b.name AS b',
    ['g'],
  );
  await d.pushChange('g', { op: 'insert', id: 'p1', labels: ['Person'], properties: { name: 'alice' } });
  await d.pushChange('g', { op: 'insert', id: 'p2', labels: ['Person'], properties: { name: 'bob' } });
  await d.pushChange('g', { op: 'insert', id: 'r1', labels: ['KNOWS'], startId: 'p1', endId: 'p2' });
  const results = await waitForRows(
    d,
    'q',
    (rows) => rows.length === 1 && rows[0].a === 'alice' && rows[0].b === 'bob',
  );
  assert.deepEqual(results, [{ a: 'alice', b: 'bob' }]);
  await d.stop();
});

test('updateQuery changes the query definition in place', async () => {
  const d = await Drasi.create('t-update');
  await d.start();
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) WHERE t.n > 5 RETURN t.n AS n', ['s']);
  await d.pushChange('s', { op: 'insert', id: 'b', labels: ['Thing'], properties: { n: 9 } });
  let results = await waitForRows(d, 'q', (rows) => rows.map((r) => r.n).join(',') === '9');
  assert.deepEqual(results.map((r) => r.n), [9]);

  await d.updateQuery('q', 'MATCH (t:Thing) WHERE t.n > 2 RETURN t.n AS n', ['s']);
  await d.pushChange('s', { op: 'insert', id: 'c', labels: ['Thing'], properties: { n: 4 } });
  results = await waitForRows(d, 'q', (rows) => rows.map((r) => r.n).includes(4));
  const ns = results.map((r) => r.n);
  assert.ok(ns.includes(4), 'updated query (n>2) now includes 4');
  await d.stop();
});

test('synthetic joins relate elements across two sources', async () => {
  const d = await Drasi.create('t-joins');
  await d.start();
  await d.addJsSource('stocks-src');
  await d.addJsSource('prices-src');
  await d.addQuery(
    'q',
    'MATCH (s:stocks)-[:HAS_PRICE]->(sp:stock_prices) RETURN s.symbol AS symbol, sp.price AS price',
    ['stocks-src', 'prices-src'],
    'cypher',
    [
      {
        id: 'HAS_PRICE',
        keys: [
          { label: 'stocks', property: 'symbol' },
          { label: 'stock_prices', property: 'symbol' },
        ],
      },
    ],
  );
  await d.pushChange('stocks-src', {
    op: 'insert',
    id: 'stock_AAPL',
    labels: ['stocks'],
    properties: { symbol: 'AAPL', name: 'Apple' },
  });
  await d.pushChange('prices-src', {
    op: 'insert',
    id: 'price_AAPL',
    labels: ['stock_prices'],
    properties: { symbol: 'AAPL', price: 175 },
  });
  const results = await waitForRows(
    d,
    'q',
    (rows) => rows.length === 1 && rows[0].symbol === 'AAPL' && rows[0].price === 175,
  );
  assert.deepEqual(results, [{ symbol: 'AAPL', price: 175 }]);
  await d.stop();
});

test('log streaming delivers source/plugin logs', async () => {
  const d = await Drasi.create('t-logs');
  await d.loadPlugins(pluginsDir);
  await d.start();
  const logs = [];
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 200 });
  await d.onSourceLogs('src', (m) => logs.push(m));
  await waitFor(() => logs.length > 0, { message: 'source/plugin logs' });
  assert.ok(logs.length > 0, 'received source/plugin logs');
  assert.equal(typeof logs[0].message, 'string');
  await d.stop();
});

test('engine runs with a redb state store backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-redb-'));
  const d = await Drasi.create('t-redb', { stateStore: { kind: 'redb', path: join(dir, 'state.redb') } });
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  const results = await waitForRows(d, 'q', (rows) => rows.length > 0);
  assert.ok(results.length > 0, 'engine runs with redb backend');
  await d.close();
});

test('fromConfig builds a running topology declaratively', async () => {
  const d = await Drasi.fromConfig({
    id: 'cfg',
    pluginsDir,
    sources: [{ kind: 'mock', id: 'src', config: { dataType: { type: 'counter' }, intervalMs: 100 } }],
    queries: [{ id: 'q', query: 'MATCH (c:Counter) RETURN c.value AS value', sources: ['src'] }],
  });
  const results = await waitForRows(d, 'q', (rows) => rows.length > 0);
  assert.ok(results.length > 0, 'declarative topology produced results');
  await d.close();
});

test('unknown plugin kind reports a clear error', async () => {
  const d = await Drasi.create('t-error');
  await assert.rejects(
    () => d.addSource('does-not-exist', 'src', {}),
    /unknown source kind 'does-not-exist'/,
  );
  await d.stop();
});

test('watchPlugins hot-loads a newly added plugin', async () => {
  const d = await Drasi.create('t-watch');
  const watched = mkdtempSync(join(tmpdir(), 'drasi-plugins-'));
  await d.watchPlugins(watched);
  assert.equal(d.pluginKinds().sources.length, 0, 'starts with no plugins');

  const mock = readdirSync(pluginsDir).find((f) => f.includes('drasi_source_mock'));
  copyFileSync(join(pluginsDir, mock), join(watched, mock));

  const loaded = await waitFor(() => d.pluginKinds().sources.includes('mock'), {
    timeout: 5000,
    interval: 300,
    message: 'mock source hot-loaded via watcher',
  });
  assert.ok(loaded, 'mock source hot-loaded via watcher');
  await d.stop();
});

// Regression tests for per-instance resource cleanup: the config-resolver
// context/thread is created lazily (only when cdylib plugins are loaded) and
// its OS thread is reclaimed on close()/drop. These guard against the lazy-init
// and shutdown paths breaking secret resolution or close() idempotency.

test('close() is clean for a pure-JS instance (no resolver ever created)', async () => {
  const d = await Drasi.create('t-nojs-resolver');
  await d.start();
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['s']);
  await d.pushChange('s', { op: 'insert', id: 'n1', labels: ['Thing'], properties: { name: 'x' } });
  await waitForRows(d, 'q', (rows) => rows.length === 1);
  // Never loaded a cdylib plugin, so shutdown_config_resolver() must no-op.
  await d.close();
  // close() must be idempotent.
  await d.close();
  assert.ok(true, 'pure-JS instance closed cleanly and idempotently');
});

test('secret resolution works across many create/close cycles', async () => {
  // Each cycle lazily spins up (and, on close, reclaims) a fresh resolver
  // thread. Resolution must keep working every iteration.
  for (let i = 0; i < 12; i++) {
    const d = await Drasi.create(`t-cycle-${i}`, { secrets: { INTERVAL: '100' } });
    await d.loadPlugins(pluginsDir);
    await d.start();
    await d.addSource('mock', 'src', {
      dataType: { type: 'counter' },
      intervalMs: { kind: 'Secret', name: 'INTERVAL' },
    });
    await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
    const rows = await waitForRows(d, 'q', (r) => r.length > 0);
    assert.ok(rows.length > 0, `cycle ${i} resolved its secret and produced results`);
    await d.close();
  }
});
