// Feature tests added alongside the main suite (kept separate so they don't
// collide with the polling-refactored engine.test.mjs).
process.env.RUST_LOG = process.env.RUST_LOG || 'error';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Drasi } = require(join(root, 'index.js'));
const pluginsDir = join(root, 'plugins');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockFile = readdirSync(pluginsDir).find((f) => f.includes('drasi_source_mock'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('plugin verification loads only hash-matching files', async () => {
  const d = await Drasi.create('t-verify');
  const hash = sha256(join(pluginsDir, mockFile));
  const summary = await d.loadPlugins(pluginsDir, { [mockFile]: hash });
  assert.equal(summary.plugins, 1, 'only the verified plugin loaded');
  assert.equal(summary.sources, 1, 'mock source loaded');
  assert.ok(!d.pluginKinds().reactions.includes('log'), 'unverified log reaction was skipped');
  await d.close();
});

test('plugin verification rejects a wrong hash', async () => {
  const d = await Drasi.create('t-verify2');
  const summary = await d.loadPlugins(pluginsDir, { [mockFile]: 'deadbeef' });
  assert.equal(summary.plugins, 0, 'hash mismatch -> nothing loaded');
  await d.close();
});

test('JS source bootstrap replays existing state to a late-subscribing query', async () => {
  const d = await Drasi.create('t-bootstrap');
  await d.start();
  await d.addJsSource('g');
  // Push BEFORE any query subscribes — only a bootstrap replay can surface it.
  await d.pushChange('g', { op: 'insert', id: 'x1', labels: ['Item'], properties: { name: 'first' } });
  await sleep(200);
  await d.addQuery('q', 'MATCH (i:Item) RETURN i.name AS name', ['g']);
  await sleep(400);
  const results = await d.getQueryResults('q');
  assert.deepEqual(results.map((r) => r.name), ['first'], 'late query bootstrapped existing state');
  await d.close();
});

test('metrics accessors return numeric snapshots', async () => {
  const d = await Drasi.create('t-metrics');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  await sleep(400);
  const qm = await d.getQueryMetrics('q');
  assert.equal(typeof qm.outboxLatestSeq, 'number', 'query metrics are numeric');
  const lm = await d.getLifecycleMetrics();
  assert.equal(typeof lm.hashMismatchCount, 'number', 'lifecycle metrics are numeric');
  await d.close();
});

// Config-schema exposure + typed config errors (gap G9).
test('config schema accessors expose a plugin kind\'s declared schema', async () => {
  const d = await Drasi.create('t-schema');
  await d.loadPlugins(pluginsDir);

  const src = d.sourceConfigSchema('mock');
  assert.equal(src.name, 'source.mock.MockSourceConfig', 'root config DTO name');
  assert.equal(typeof src.schema, 'object', 'schema is an object map');
  assert.ok(src.schema[src.name], 'schema map contains the root config DTO');

  const rxn = d.reactionConfigSchema('log');
  assert.equal(typeof rxn.name, 'string', 'reaction schema has a name');
  assert.ok(rxn.schema && rxn.schema[rxn.name], 'reaction schema map contains its root');

  await d.close();
});

test('config schema accessors throw a typed error for unknown kinds', async () => {
  const d = await Drasi.create('t-schema-unknown');
  await d.loadPlugins(pluginsDir);
  const cases = [
    [() => d.sourceConfigSchema('nope'), 'UNKNOWN_SOURCE_KIND'],
    [() => d.reactionConfigSchema('nope'), 'UNKNOWN_REACTION_KIND'],
    [() => d.bootstrapConfigSchema('nope'), 'UNKNOWN_BOOTSTRAP_KIND'],
  ];
  for (const [fn, code] of cases) {
    assert.throws(fn, (err) => {
      assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
      return true;
    });
  }
  await d.close();
});

test('an invalid source config is rejected with the [CONFIG_INVALID] token', async () => {
  const d = await Drasi.create('t-config-invalid');
  await d.loadPlugins(pluginsDir);
  await d.start();
  // The mock DTO uses deny_unknown_fields, so an unknown field fails to deserialize.
  await assert.rejects(
    async () => d.addSource('mock', 'src', { bogusField: true }),
    (err) => {
      assert.match(err.message, /\[CONFIG_INVALID\]/);
      return true;
    },
  );
  await d.close();
});

// ---------------------------------------------------------------------------
// Persistence, identity, and durable reactions (gaps G6, G8, G7)
// ---------------------------------------------------------------------------

const waitUntil = async (fn, { timeout = 5000, interval = 50 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
};

// G6: a RocksDB persistent index backend is wired and query results flow through it.
test('engine runs with a rocksdb index backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-rocks-'));
  const d = await Drasi.create('t-rocks', { indexStore: { kind: 'rocksdb', path: join(dir, 'idx') } });
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'alice' } });
  const ok = await waitUntil(async () => (await d.getQueryResults('q')).some((r) => r.name === 'alice'));
  assert.ok(ok, 'query backed by rocksdb produced results');
  await d.close();
});

// G8: a built-in password identity provider is accepted and the engine runs.
test('engine builds with a password identity provider', async () => {
  const d = await Drasi.create('t-identity', { identity: { kind: 'password', username: 'u', password: 'p' } });
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'bob' } });
  const ok = await waitUntil(async () => (await d.getQueryResults('q')).some((r) => r.name === 'bob'));
  assert.ok(ok, 'engine with an identity provider runs queries');
  await d.close();
});

// G7: a durable reaction requires a durable state store (typed synchronous error).
test('addDurableJsReaction without a state store throws DURABLE_REQUIRES_STATE_STORE', async () => {
  const d = await Drasi.create('t-durable-nostore');
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  await assert.rejects(
    async () => d.addDurableJsReaction('r', ['q'], async () => {}),
    (err) => {
      assert.equal(err.code, 'DURABLE_REQUIRES_STATE_STORE', `got ${err.code}`);
      return true;
    },
  );
  await d.close();
});

// G7: a durable reaction delivers results (awaiting the async callback) and
// advances its persisted checkpoint.
test('durable JS reaction delivers results and advances its checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-durable-'));
  const d = await Drasi.create('t-durable', {
    stateStore: { kind: 'redb', path: join(dir, 'state.redb') },
    indexStore: { kind: 'rocksdb', path: join(dir, 'idx') },
  });
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  const seen = [];
  await d.addDurableJsReaction('r', ['q'], async (result) => {
    for (const diff of result.results) {
      if (diff.data && diff.data.name) seen.push(diff.data.name);
    }
  });
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'carol' } });
  const delivered = await waitUntil(() => seen.includes('carol'));
  assert.ok(delivered, 'durable reaction received the result via its async callback');
  // The checkpoint advanced for query q (proves durable checkpointing ran).
  const advanced = await waitUntil(async () => {
    const m = await d.getReactionMetrics('r');
    return m.q && m.q.checkpointSequence >= 1;
  });
  assert.ok(advanced, 'durable reaction advanced its persisted checkpoint');
  await d.close();
});
const ociSkip = process.env.DRASI_OCI_TESTS ? false : 'set DRASI_OCI_TESTS=1 to run OCI registry tests';

test('OCI: list plugin tags from the public registry', { skip: ociSkip }, async () => {
  const d = await Drasi.create('t-oci-tags');
  const tags = await d.listPluginTags('source/postgres');
  assert.ok(Array.isArray(tags) && tags.length > 0, 'received tags from ghcr.io');
  await d.close();
});

test('OCI: pull a plugin artifact to disk', { skip: ociSkip }, async () => {
  const d = await Drasi.create('t-oci-pull');
  const tags = await d.listPluginTags('source/postgres');
  // Pick the newest tag matching this platform's arch suffix.
  const suffix =
    process.platform === 'win32'
      ? '-windows-msvc-amd64'
      : process.platform === 'darwin'
        ? '-darwin-arm64'
        : '-linux-amd64';
  const match = tags
    .filter((t) => t.endsWith(suffix))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
  assert.ok(match, `expected a ${suffix} tag`);

  const dest = mkdtempSync(join(tmpdir(), 'drasi-oci-'));
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  const prefix = process.platform === 'win32' ? '' : 'lib';
  const filename = `${prefix}drasi_source_postgres.${ext}`;
  const reference = `ghcr.io/drasi-project/source/postgres:${match}`;

  // Default (no options): downloads and reports an unenforced verification status.
  const result = await d.pullPlugin(reference, dest, filename);
  assert.ok(existsSync(result.path), `downloaded plugin exists at ${result.path}`);
  assert.equal(result.verification.status, 'unsigned', 'no verification requested');

  // With verification enabled the status is a structured, known value (gap G5).
  const verified = await d.pullPlugin(reference, dest, filename, { verify: true });
  assert.ok(
    ['unsigned', 'verified', 'tampered'].includes(verified.verification.status),
    `structured verification status, got ${verified.verification.status}`,
  );
  // A legitimate drasi-project artifact must never verify as tampered.
  assert.notEqual(verified.verification.status, 'tampered', 'genuine artifact is not tampered');
  await d.close();
});
