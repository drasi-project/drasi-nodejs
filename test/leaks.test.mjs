// Resource-leak / soak tests for @drasi/lib, run against the built native addon
// (npm run build && npm test).
//
// These build on the existing "many create/close cycles" and "pure-JS close is
// clean" regression tests. They exercise repeated component churn on a running
// engine, stream-subscription teardown, plugin-watcher setup + teardown, and an
// RSS-growth sanity check. Everything here is deterministic with generous bounds
// so it stays green on ubuntu/macos/windows; the heaviest soak is gated behind
// DRASI_SOAK_TESTS=1 (mirroring the DRASI_OCI_TESTS pattern) while the default
// `npm test` still runs a solid leak set.
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

// One create -> start -> push -> verify -> close cycle, used by the RSS checks.
async function runCycle(id) {
  const d = await Drasi.create(id);
  await d.start();
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['s']);
  await d.pushChange('s', { op: 'insert', id: 'n1', labels: ['Thing'], properties: { name: 'x' } });
  await waitForRows(d, 'q', (r) => r.length === 1);
  await d.close();
}

test('repeated add/remove of components on a running engine does not leak', async () => {
  const d = await Drasi.create('t-churn');
  await d.start();
  for (let i = 0; i < 15; i++) {
    await d.addJsSource(`s${i}`);
    await d.addQuery(`q${i}`, 'MATCH (t:Thing) RETURN t.name AS name', [`s${i}`]);
    await d.addJsReaction(`r${i}`, [`q${i}`], () => {});
    // Tear down in dependency order (reaction -> query -> source).
    await d.removeReaction(`r${i}`);
    await d.removeQuery(`q${i}`);
    await d.removeSource(`s${i}`);
  }
  assert.equal((await d.listSources()).filter((s) => /^s\d+$/.test(s.id)).length, 0, 'no churned sources left registered');
  assert.equal((await d.listQueries()).filter((q) => /^q\d+$/.test(q.id)).length, 0, 'no churned queries left registered');
  assert.equal((await d.listReactions()).filter((r) => /^r\d+$/.test(r.id)).length, 0, 'no churned reactions left registered');

  // The engine is still fully functional after all that churn.
  await d.addJsSource('final');
  await d.addQuery('finalq', 'MATCH (t:Thing) RETURN t.name AS name', ['final']);
  await d.pushChange('final', { op: 'insert', id: 'n1', labels: ['Thing'], properties: { name: 'ok' } });
  const rows = await waitForRows(d, 'finalq', (r) => r.length === 1);
  assert.equal(rows[0].name, 'ok', 'engine still processes changes after churn');
  await d.close();
});

test('subscribing to event and log streams then close() is clean', async () => {
  const d = await Drasi.create('t-streams-close');
  await d.loadPlugins(pluginsDir);
  const events = [];
  const logs = [];
  await d.onAllEvents((e) => events.push(e));
  await d.start();
  await d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 150 });
  await d.onSourceLogs('src', (m) => logs.push(m));
  await d.addQuery('q', 'MATCH (c:Counter) RETURN c.value AS value', ['src']);
  // Lifecycle events are guaranteed; logs are best-effort (don't hard-require).
  await waitFor(() => events.length > 0, { message: 'lifecycle events' });
  // close() must tear down the active event/log stream subscriptions cleanly...
  await d.close();
  // ...and be idempotent.
  await d.close();
  assert.ok(events.length > 0, 'received lifecycle events before a clean close');
});

test('watchPlugins sets up a watcher, hot-loads, and tears down cleanly on close', async () => {
  const d = await Drasi.create('t-watch-teardown');
  const watched = mkdtempSync(join(tmpdir(), 'drasi-watch-'));
  await d.watchPlugins(watched);
  assert.equal(d.pluginKinds().sources.length, 0, 'starts with no plugin kinds');

  const mock = readdirSync(pluginsDir).find((f) => f.includes('drasi_source_mock'));
  copyFileSync(join(pluginsDir, mock), join(watched, mock));
  await waitFor(() => d.pluginKinds().sources.includes('mock'), {
    timeout: 10000,
    interval: 300,
    message: 'mock source hot-loaded via watcher',
  });

  // close() clears the watcher; a second close() must remain a clean no-op.
  await d.close();
  await d.close();
  assert.ok(true, 'watcher torn down cleanly and idempotently');
});

test('RSS stays bounded across many create/close cycles', async () => {
  if (typeof global.gc === 'function') global.gc();
  const before = process.memoryUsage().rss;
  const cycles = 25;
  for (let i = 0; i < cycles; i++) {
    await runCycle(`t-rss-${i}`);
  }
  if (typeof global.gc === 'function') global.gc();
  const grewMb = (process.memoryUsage().rss - before) / 1024 / 1024;
  // Very generous bound: each cycle spins up and tears down a full engine +
  // resolver-less JS source. This guards against gross leaks, not micro-growth.
  assert.ok(
    grewMb < 250,
    `RSS grew ${grewMb.toFixed(1)}MB across ${cycles} create/close cycles (limit 250MB)`,
  );
});

// Heavier, longer soak. Skipped by default so offline `npm test` stays fast;
// run with DRASI_SOAK_TESTS=1.
const soakSkip = process.env.DRASI_SOAK_TESTS ? false : 'set DRASI_SOAK_TESTS=1 to run soak tests';

test('soak: RSS stays bounded across a long run of create/close cycles', { skip: soakSkip }, async () => {
  if (typeof global.gc === 'function') global.gc();
  const before = process.memoryUsage().rss;
  const cycles = 200;
  for (let i = 0; i < cycles; i++) {
    await runCycle(`t-soak-${i}`);
  }
  if (typeof global.gc === 'function') global.gc();
  const grewMb = (process.memoryUsage().rss - before) / 1024 / 1024;
  assert.ok(
    grewMb < 400,
    `RSS grew ${grewMb.toFixed(1)}MB across ${cycles} create/close cycles (limit 400MB)`,
  );
});
