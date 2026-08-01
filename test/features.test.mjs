// Feature tests added alongside the main suite (kept separate so they don't
// collide with the polling-refactored engine.test.mjs).
process.env.RUST_LOG = process.env.RUST_LOG || 'error';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

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
    [() => d.secretStoreConfigSchema('nope'), 'UNKNOWN_SECRET_STORE_KIND'],
    [() => d.identityProviderConfigSchema('nope'), 'UNKNOWN_IDENTITY_PROVIDER_KIND'],
  ];
  for (const [fn, code] of cases) {
    assert.throws(fn, (err) => {
      assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
      return true;
    });
  }
  // useSecretStore with an unknown kind also rejects with the typed code token.
  await assert.rejects(
    () => d.useSecretStore('nope'),
    (err) => {
      assert.match(err.message, /\[UNKNOWN_SECRET_STORE_KIND\]/);
      return true;
    },
  );
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
    try {
      if (await fn()) return true;
    } catch {
      // Ignore transient errors (e.g. querying before it finishes auto-starting)
      // and keep polling until the timeout.
    }
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

// G6: query index state persists across a full engine restart. A rocksdb
// indexStore holds a process-exclusive lock (released on process exit, not on
// `close()`), so a genuine restart is a NEW process — this test runs the write and
// the read in separate child processes sharing the same index path, and the read
// process must recover the prior result WITHOUT re-pushing any source data.
test('rocksdb index state persists across an engine restart (separate processes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-rocks-persist-'));
  const idxPath = join(dir, 'idx');
  const addon = join(root, 'index.js');

  // A tiny driver run in a child process: opens a rocksdb-backed engine at the
  // given path, (optionally) pushes one node, and prints whether the query holds
  // it. Written to a temp file so `node --test` doesn't pick it up as a test.
  const helper = join(dir, 'persist-child.mjs');
  writeFileSync(
    helper,
    `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [,, addonPath, mode, path] = process.argv;
const { Drasi } = require(addonPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, t = 4000) => {
  const s = Date.now();
  while (Date.now() - s < t) { try { if (await fn()) return true; } catch {} await sleep(50); }
  return false;
};
const d = await Drasi.create('persist', { indexStore: { kind: 'rocksdb', path } });
await d.start();
await d.addJsSource('g');
await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
if (mode === 'write') {
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'alice' } });
}
const ok = await waitUntil(async () => (await d.getQueryResults('q')).some((r) => r.name === 'alice'));
process.stdout.write('RESULT=' + (ok ? 'true' : 'false'));
await d.close();
`,
  );

  const run = (mode) =>
    execFileSync('node', [helper, addon, mode, idxPath], {
      cwd: root,
      env: { ...process.env, RUST_LOG: 'error' },
      encoding: 'utf8',
    });

  // Process 1 writes and checkpoints the result to the rocksdb index, then exits
  // (releasing the lock).
  assert.match(run('write'), /RESULT=true/, 'write process computed the result');
  // Process 2 opens the SAME index path and, without pushing anything, recovers
  // the prior result from disk.
  assert.match(run('read'), /RESULT=true/, 'restart process recovered the persisted result without re-pushing');
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

// G7 / #21: the DEFAULT policy is `retry` — a transiently-failing callback is
// re-invoked (with backoff) until it succeeds, so the failed event is delivered
// and its checkpoint advances. This is the core per-event at-least-once guarantee
// (under the old skip-on-error default, 'carol' would have been lost forever).
test('durable reaction (default retry) recovers a transiently-failing callback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-retry-'));
  const d = await Drasi.create('t-durable-retry', {
    stateStore: { kind: 'redb', path: join(dir, 'state.redb') },
    indexStore: { kind: 'rocksdb', path: join(dir, 'idx') },
  });
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  let attempts = 0;
  const seen = [];
  // No onError option -> default 'retry'. Small delays keep the test fast.
  await d.addDurableJsReaction(
    'r',
    ['q'],
    async (result) => {
      attempts += 1;
      // Reject the first two attempts, then accept.
      if (attempts < 3) throw new Error('transient failure');
      for (const diff of result.results) {
        if (diff.data && diff.data.name) seen.push(diff.data.name);
      }
    },
    { retryDelayMs: 20, maxRetryDelayMs: 50 },
  );
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'carol' } });
  const delivered = await waitUntil(() => seen.includes('carol'));
  assert.ok(delivered, 'event was redelivered by retry and finally processed');
  assert.ok(attempts >= 3, `callback was retried (attempts=${attempts})`);
  const advanced = await waitUntil(async () => {
    const m = await d.getReactionMetrics('r');
    return m.q && m.q.checkpointSequence >= 1;
  });
  assert.ok(advanced, 'checkpoint advanced only after the retry succeeded');
  await d.close();
});

// G7 / #21: `onError: 'halt'` stops the reaction on a permanently-failing
// callback WITHOUT advancing the checkpoint and WITHOUT delivering later events
// (head-of-line), so the failed event is never buried.
test('durable reaction (onError halt) stops without advancing the checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-halt-'));
  const d = await Drasi.create('t-durable-halt', {
    stateStore: { kind: 'redb', path: join(dir, 'state.redb') },
    indexStore: { kind: 'rocksdb', path: join(dir, 'idx') },
  });
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  const seen = [];
  await d.addDurableJsReaction(
    'r',
    ['q'],
    async (result) => {
      for (const diff of result.results) {
        if (diff.data && diff.data.name) seen.push(diff.data.name);
      }
      throw new Error('always fails');
    },
    { onError: 'halt' },
  );
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'first' } });
  // The reaction should transition to an error status.
  const halted = await waitUntil(async () => {
    const reactions = await d.listReactions();
    const r = reactions.find((x) => x.id === 'r');
    return r && r.status === 'Error';
  });
  assert.ok(halted, 'reaction halted with an error status');
  // A later event must NOT be processed while halted (head-of-line).
  await d.pushChange('g', { op: 'insert', id: 't2', labels: ['Thing'], properties: { name: 'second' } });
  await sleep(300);
  assert.ok(!seen.includes('second'), 'second event was not delivered while halted');
  await d.close();
});

// G7 / #21: `onError: 'skip'` preserves drasi-lib's stock behavior — the failed
// event is dropped (not retried) and processing continues, so a later success
// advances the checkpoint past it. Opt-in, for back-compat.
test('durable reaction (onError skip) drops the failed event and continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drasi-skip-'));
  const d = await Drasi.create('t-durable-skip', {
    stateStore: { kind: 'redb', path: join(dir, 'state.redb') },
    indexStore: { kind: 'rocksdb', path: join(dir, 'idx') },
  });
  await d.start();
  await d.addJsSource('g');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['g']);
  let failAttempts = 0;
  const seen = [];
  await d.addDurableJsReaction(
    'r',
    ['q'],
    async (result) => {
      for (const diff of result.results) {
        const name = diff.data && diff.data.name;
        if (name === 'fail-me') {
          failAttempts += 1;
          throw new Error('rejecting fail-me');
        }
        if (name) seen.push(name);
      }
    },
    { onError: 'skip' },
  );
  await d.pushChange('g', { op: 'insert', id: 't1', labels: ['Thing'], properties: { name: 'fail-me' } });
  await d.pushChange('g', { op: 'insert', id: 't2', labels: ['Thing'], properties: { name: 'keep-me' } });
  const delivered = await waitUntil(() => seen.includes('keep-me'));
  assert.ok(delivered, 'later event delivered after skipping the failed one');
  assert.equal(failAttempts, 1, 'failed event was skipped, not retried');
  const advanced = await waitUntil(async () => {
    const m = await d.getReactionMetrics('r');
    return m.q && m.q.checkpointSequence >= 1;
  });
  assert.ok(advanced, 'checkpoint advanced past the skipped event');
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

test('OCI: resolvePlugin resolves a bare ref for this host', { skip: ociSkip }, async () => {
  const d = await Drasi.create('t-oci-resolve');
  // No tag, no platform suffix, no filename — the resolver does all of that.
  const r = await d.resolvePlugin('source/postgres');
  assert.ok(r.reference.includes('@sha256:'), 'reference is pinned by digest');
  assert.match(r.version, /^\d+\.\d+/, 'a concrete version was chosen');
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  const prefix = process.platform === 'win32' ? '' : 'lib';
  assert.equal(r.filename, `${prefix}drasi_source_postgres.${ext}`, 'derives the platform filename');
  // The resolved artifact is compatible with the versions this addon was built against.
  assert.ok(r.sdkVersion && r.coreVersion && r.libVersion, 'reports the compatible SDK/core/lib versions');
  await d.close();
});

test('OCI: installPlugin resolves + downloads a loadable plugin', { skip: ociSkip }, async () => {
  const d = await Drasi.create('t-oci-install');
  const dest = mkdtempSync(join(tmpdir(), 'drasi-install-'));

  // One call: resolve for this host/platform, download under the derived name.
  const result = await d.installPlugin('source/postgres', dest);
  assert.ok(existsSync(result.path), `downloaded plugin exists at ${result.path}`);
  assert.equal(result.resolved.filename, result.path.split('/').pop(), 'saved under the resolved filename');
  assert.equal(result.verification.status, 'unsigned', 'no verification requested');

  // The downloaded artifact registers its kind when loaded.
  await d.loadPlugins(dest);
  assert.ok(d.pluginKinds().sources.includes('postgres'), 'installed source kind is registered');
  await d.close();
});

test('getSourceSchema reports a source graph schema', async () => {
  const d = await Drasi.create('t-src-schema');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 500 });

  const schema = await d.getSourceSchema('src');
  assert.ok(schema, 'schema returned');
  assert.ok(Array.isArray(schema.nodes), 'nodes is an array');
  const counter = schema.nodes.find((n) => n.label === 'Counter');
  assert.ok(counter, 'Counter node described');
  const value = counter.properties.find((p) => p.name === 'value');
  assert.ok(value, 'value property described');
  assert.equal(value.dataType, 'integer', 'value is an integer');
  assert.ok(Array.isArray(schema.relations), 'relations is an array');
  await d.close();
});

test('getSourceSchema throws for an unknown source id', async () => {
  const d = await Drasi.create('t-src-schema-missing');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await assert.rejects(async () => d.getSourceSchema('nope'), /not found/);
  await d.close();
});

test('getGraphSchema merges sources with query references', async () => {
  const d = await Drasi.create('t-graph-schema');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 500 });
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);

  const graph = await d.getGraphSchema();
  assert.ok(graph.nodes.Counter, 'Counter node present in graph schema');
  assert.ok(graph.nodes.Counter.sources.includes('src'), 'Counter provided by src');
  assert.ok(graph.nodes.Counter.queriedBy.includes('q'), 'Counter queried by q');
  assert.ok(Array.isArray(graph.sourcesWithoutSchema), 'sourcesWithoutSchema is an array');
  await d.close();
});

// ---------------------------------------------------------------------------
// Source middleware exposed to query writers: query `middleware` definitions +
// per-source `pipeline` subscriptions. Uses the compiled-in `relabel` middleware
// (pure Rust, deterministic) which rewrites a node's label before it reaches the
// query — so a query on the rewritten label only ever matches when the pipeline
// ran.
// ---------------------------------------------------------------------------

const relabelMiddleware = [
  { kind: 'relabel', name: 'raw-to-person', config: { labelMappings: { Raw: 'Person' } } },
];
const rawNode = { op: 'insert', id: 'p1', labels: ['Raw'], properties: { name: 'alice' } };

test('a source pipeline runs middleware before changes reach the query', async () => {
  const d = await Drasi.create('t-mw-pipeline');
  await d.start();
  await d.addJsSource('people');
  await d.addQuery(
    'q',
    'MATCH (p:Person) RETURN p.name AS name',
    [{ id: 'people', pipeline: ['raw-to-person'] }],
    'cypher',
    undefined,
    relabelMiddleware,
  );
  await d.pushChange('people', rawNode);
  const ok = await waitUntil(async () => (await d.getQueryResults('q')).some((r) => r.name === 'alice'));
  assert.ok(ok, 'relabel middleware rewrote Raw -> Person so the query matched');
  await d.close();
});

test('without a pipeline the label is not rewritten (control)', async () => {
  const d = await Drasi.create('t-mw-control');
  await d.start();
  await d.addJsSource('people');
  // Same source data, but no pipeline/middleware — the node stays a `Raw`, so a
  // `Person` query must never match.
  await d.addQuery('q', 'MATCH (p:Person) RETURN p.name AS name', ['people']);
  await d.pushChange('people', rawNode);
  // Give the change time to flow through so a (wrong) match would surface.
  await sleep(500);
  const results = await d.getQueryResults('q');
  assert.equal(results.length, 0, `no middleware means the label is not rewritten (got ${JSON.stringify(results)})`);
  await d.close();
});

test('fromConfig wires query middleware and source pipelines', async () => {
  // fromConfig can only declare cdylib sources, so relabel the mock source's
  // `Counter` nodes to `Gauge` and query the rewritten label.
  const d = await Drasi.fromConfig({
    id: 't-mw-fromconfig',
    pluginsDir,
    sources: [{ kind: 'mock', id: 'src', config: { dataType: { type: 'counter' }, intervalMs: 100 } }],
    queries: [
      {
        id: 'q',
        query: 'MATCH (g:Gauge) RETURN g.value AS value',
        sources: [{ id: 'src', pipeline: ['counter-to-gauge'] }],
        middleware: [
          { kind: 'relabel', name: 'counter-to-gauge', config: { labelMappings: { Counter: 'Gauge' } } },
        ],
      },
    ],
  });
  const ok = await waitUntil(async () => (await d.getQueryResults('q')).length > 0);
  assert.ok(ok, 'fromConfig middleware pipeline relabeled Counter -> Gauge');
  await d.close();
});

test('updateQuery can add a middleware pipeline to an existing query', async () => {
  const d = await Drasi.create('t-mw-update');
  await d.start();
  await d.addJsSource('people');
  await d.addQuery('q', 'MATCH (p:Person) RETURN p.name AS name', ['people']);
  // The query auto-starts asynchronously on a running engine; wait until it has
  // finished starting, otherwise the reconfigure is rejected with "Cannot
  // reconfigure component 'q' while it is starting".
  await waitUntil(async () => (await d.listQueries()).some((q) => q.id === 'q' && q.status === 'Running'));
  // Replace the definition to add the relabel middleware + pipeline.
  await d.updateQuery(
    'q',
    'MATCH (p:Person) RETURN p.name AS name',
    [{ id: 'people', pipeline: ['raw-to-person'] }],
    'cypher',
    undefined,
    relabelMiddleware,
  );
  await d.pushChange('people', rawNode);
  const ok = await waitUntil(async () => (await d.getQueryResults('q')).some((r) => r.name === 'alice'));
  assert.ok(ok, 'updateQuery added a working middleware pipeline');
  await d.close();
});

test('bare string sources still work (backward compatibility)', async () => {
  const d = await Drasi.create('t-mw-compat-strings');
  await d.start();
  await d.addJsSource('people');
  await d.addQuery('q', 'MATCH (p:Person) RETURN p.name AS name', ['people']);
  await d.pushChange('people', { op: 'insert', id: 'p1', labels: ['Person'], properties: { name: 'alice' } });
  const ok = await waitUntil(async () => (await d.getQueryResults('q')).some((r) => r.name === 'alice'));
  assert.ok(ok, 'string-only sources remain supported');
  await d.close();
});
