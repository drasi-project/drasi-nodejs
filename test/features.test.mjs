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

// Network tests against the public ghcr.io/drasi-project registry. Skipped by
// default so offline `npm test` passes; run with DRASI_OCI_TESTS=1.
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
  const result = await d.pullPlugin(
    `ghcr.io/drasi-project/source/postgres:${match}`,
    dest,
    filename,
  );
  assert.ok(existsSync(result.path), `downloaded plugin exists at ${result.path}`);
  await d.close();
});
