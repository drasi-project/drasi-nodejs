// Error-path, edge-case and lifecycle-misuse tests for @drasi/lib, run against
// the built native addon (npm run build && npm test).
//
// These extend — and deliberately do NOT duplicate — the happy-path and typed-
// error assertions already in engine.test.mjs / features.test.mjs. engine.test
// already covers UNKNOWN_SOURCE_KIND, UNKNOWN_REACTION_KIND, UNKNOWN_BOOTSTRAP_KIND
// (addSource), UNKNOWN_STATE_STORE_KIND, STATE_STORE_PATH_REQUIRED, NO_JS_SOURCE
// (never-created id), the CHANGE_* family, RELATION_REQUIRES_BOTH_ENDS,
// UNKNOWN_CHANGE_OP and the fromConfig `[UNKNOWN_SOURCE_KIND]` token. This file
// fills the remaining gaps: BOOTSTRAP_KIND_REQUIRED, MISSING_CONFIG_FIELD, the
// sync JS_SOURCE_CLOSED path, the fromConfig bootstrap/reaction `[CODE]` tokens,
// lifecycle misuse, query-language/joins validation and relation edge cases.
process.env.RUST_LOG = process.env.RUST_LOG || 'error';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// Assert a call rejects with a specific typed `err.code` (synchronous validation).
async function rejectsWithCode(fn, code, messageRe) {
  await assert.rejects(async () => fn(), (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    if (messageRe) assert.match(err.message, messageRe);
    return true;
  });
}

// Assert a call rejects with the stable `[CODE]` token embedded in the message.
// Used for async-fallback paths where napi forces `err.code` to a Status string.
async function rejectsWithToken(fn, token, messageRe) {
  await assert.rejects(async () => fn(), (err) => {
    assert.match(err.message, new RegExp(`\\[${token}\\]`));
    if (messageRe) assert.match(err.message, messageRe);
    return true;
  });
}

// Poll until a call rejects with `code` (for a state that becomes true shortly
// after an async transition, e.g. a JS source's receiver closing after stop()).
async function waitForRejectCode(fn, code, { timeout = 4000, interval = 50 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      await fn();
    } catch (err) {
      if (err.code === code) return true;
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `did not reject with ${code} within ${timeout}ms` +
      (last ? ` (last: ${last.code} ${last.message})` : ' (never rejected)'),
  );
}

// ---------------------------------------------------------------------------
// Typed validation codes not already asserted elsewhere
// ---------------------------------------------------------------------------

test('addSource with a bootstrap missing its kind throws BOOTSTRAP_KIND_REQUIRED', async () => {
  const d = await Drasi.create('t-bs-req');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await rejectsWithCode(
    () => d.addSource('mock', 'src', { dataType: { type: 'counter' }, intervalMs: 100 }, true, {}),
    'BOOTSTRAP_KIND_REQUIRED',
    /bootstrap\.kind is required/,
  );
  await d.close();
});

test('fromConfig with a missing required field throws MISSING_CONFIG_FIELD', async () => {
  // Required-field validation runs synchronously, so it carries a real err.code.
  await rejectsWithCode(
    () => Drasi.fromConfig({ id: 'fc-nokind', sources: [{ id: 's' }] }),
    'MISSING_CONFIG_FIELD',
    /missing 'kind'/,
  );
  await rejectsWithCode(
    () => Drasi.fromConfig({ id: 'fc-noid', queries: [{ query: 'MATCH (n) RETURN n', sources: [] }] }),
    'MISSING_CONFIG_FIELD',
    /missing 'id'/,
  );
});

test('pushChange after stop rejects with JS_SOURCE_CLOSED', async () => {
  const d = await Drasi.create('t-js-closed');
  await d.start();
  await d.addJsSource('s');
  await d.stop(); // aborts the source task; its receiver is dropped shortly after.
  await waitForRejectCode(
    () => d.pushChange('s', { op: 'insert', id: 'n1', labels: ['Thing'] }),
    'JS_SOURCE_CLOSED',
  );
  await d.close();
});

test('pushChange to a cdylib (non-JS) source rejects with NO_JS_SOURCE', async () => {
  const d = await Drasi.create('t-nojs-cdylib');
  await d.loadPlugins(pluginsDir);
  await d.start();
  await d.addSource('mock', 'msrc', { dataType: { type: 'counter' }, intervalMs: 200 });
  // 'msrc' is a real, registered source — but not a JS source, so it has no
  // push channel. This differs from the "never-created id" case in engine.test.
  await rejectsWithCode(
    () => d.pushChange('msrc', { op: 'insert', id: 'n1' }),
    'NO_JS_SOURCE',
    /no JS source 'msrc'/,
  );
  await d.close();
});

// ---------------------------------------------------------------------------
// Async-fallback `[CODE]` tokens (napi can't attach a real .code here)
// ---------------------------------------------------------------------------

test('fromConfig embeds the [CODE] token for unknown bootstrap and reaction kinds', async () => {
  await rejectsWithToken(
    () =>
      Drasi.fromConfig({
        id: 'fc-bs',
        pluginsDir,
        sources: [
          {
            kind: 'mock',
            id: 's',
            config: { dataType: { type: 'counter' }, intervalMs: 200 },
            bootstrap: { kind: 'does-not-exist' },
          },
        ],
      }),
    'UNKNOWN_BOOTSTRAP_KIND',
    /unknown bootstrap kind 'does-not-exist'/,
  );

  await rejectsWithToken(
    () => Drasi.fromConfig({ id: 'fc-rx', reactions: [{ kind: 'does-not-exist', id: 'r', queries: [] }] }),
    'UNKNOWN_REACTION_KIND',
    /unknown reaction kind 'does-not-exist'/,
  );
});

// ---------------------------------------------------------------------------
// Lifecycle misuse
// ---------------------------------------------------------------------------

test('a second start() rejects, and the engine keeps running', async () => {
  const d = await Drasi.create('t-double-start');
  await d.start();
  await assert.rejects(
    async () => d.start(),
    (err) => {
      assert.match(err.message, /already running/i);
      return true;
    },
  );
  // The failed second start must not have torn anything down.
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['s']);
  await d.pushChange('s', { op: 'insert', id: 'n1', labels: ['Thing'], properties: { name: 'ok' } });
  const rows = await waitForRows(d, 'q', (r) => r.length === 1);
  assert.equal(rows[0].name, 'ok', 'engine still processes changes after a rejected 2nd start');
  await d.close();
});

test('stop() is idempotent (safe to call before start and twice)', async () => {
  const d = await Drasi.create('t-double-stop');
  await d.stop(); // never started — must be a no-op
  await d.start();
  await d.stop();
  await d.stop(); // second stop must also no-op
  assert.ok(true, 'repeated stop() calls resolved cleanly');
  await d.close();
});

test('components can be added before start(); state surfaces once started', async () => {
  const d = await Drasi.create('t-before-start');
  // All of these are accepted while the engine is not yet running.
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['s']);
  await d.pushChange('s', { op: 'insert', id: 'n1', labels: ['Thing'], properties: { name: 'early' } });
  await d.start();
  const rows = await waitForRows(d, 'q', (r) => r.length === 1);
  assert.deepEqual(rows.map((r) => r.name), ['early'], 'data pushed before start surfaces after start');
  await d.close();
});

test('operations on unknown component ids reject clearly', async () => {
  const d = await Drasi.create('t-unknown-ids');
  await d.start();
  const cases = [
    ['removeQuery', () => d.removeQuery('nope')],
    ['removeSource', () => d.removeSource('nope')],
    ['removeReaction', () => d.removeReaction('nope')],
    ['startSource', () => d.startSource('nope')],
    ['stopSource', () => d.stopSource('nope')],
    ['startQuery', () => d.startQuery('nope')],
    ['stopQuery', () => d.stopQuery('nope')],
    ['getQueryResults', () => d.getQueryResults('nope')],
    ['getQueryMetrics', () => d.getQueryMetrics('nope')],
    ['updateQuery', () => d.updateQuery('nope', 'MATCH (n) RETURN n', ['s'])],
  ];
  for (const [name, fn] of cases) {
    await assert.rejects(async () => fn(), (err) => {
      assert.match(err.message, /not found/i, `${name} should report "not found", got: ${err.message}`);
      return true;
    });
  }
  await d.close();
});

test('operations on a removed query reject', async () => {
  const d = await Drasi.create('t-removed-query');
  await d.start();
  await d.addJsSource('s');
  await d.addQuery('q', 'MATCH (t:Thing) RETURN t.name AS name', ['s']);
  assert.ok((await d.listQueries()).find((q) => q.id === 'q'), 'query present before removal');
  await d.removeQuery('q');
  assert.ok(!(await d.listQueries()).find((q) => q.id === 'q'), 'query gone after removal');
  await assert.rejects(async () => d.getQueryResults('q'), /not found/i);
  await assert.rejects(async () => d.removeQuery('q'), /not found/i);
  await d.close();
});

// ---------------------------------------------------------------------------
// Query-language and joins validation
// ---------------------------------------------------------------------------

test('invalid query text is rejected for both cypher and gql', async () => {
  const d = await Drasi.create('t-badquery');
  await d.start();
  await d.addJsSource('s');
  await assert.rejects(async () => d.addQuery('q1', 'this is not cypher', ['s']), /parser error/i);
  await assert.rejects(async () => d.addQuery('q2', 'this is not gql', ['s'], 'gql'), /parser error/i);
  await assert.rejects(async () => d.addQuery('q3', '', ['s']), /parser error/i);
  await d.close();
});

test('malformed joins are rejected', async () => {
  const d = await Drasi.create('t-badjoins');
  await d.start();
  await d.addJsSource('s');
  await assert.rejects(
    // Missing the required `keys` field.
    async () => d.addQuery('q', 'MATCH (a)-[:R]->(b) RETURN a', ['s'], 'cypher', [{ id: 'R' }]),
    /keys/i,
  );
  await d.close();
});

// ---------------------------------------------------------------------------
// Relation edge cases (aliases + delete)
// ---------------------------------------------------------------------------

test('relations accept inId/outId aliases and propagate deletes', async () => {
  const d = await Drasi.create('t-rel-aliases');
  await d.start();
  await d.addJsSource('g');
  await d.addQuery(
    'q',
    'MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a.name AS a, b.name AS b',
    ['g'],
  );
  await d.pushChange('g', { op: 'insert', id: 'p1', labels: ['Person'], properties: { name: 'alice' } });
  await d.pushChange('g', { op: 'insert', id: 'p2', labels: ['Person'], properties: { name: 'bob' } });
  // inId/outId are accepted as aliases for startId/endId.
  await d.pushChange('g', { op: 'insert', id: 'r1', labels: ['KNOWS'], inId: 'p1', outId: 'p2' });
  const matched = await waitForRows(
    d,
    'q',
    (rows) => rows.length === 1 && rows[0].a === 'alice' && rows[0].b === 'bob',
  );
  assert.deepEqual(matched, [{ a: 'alice', b: 'bob' }]);

  // Deleting the relation (by id) removes the match.
  await d.pushChange('g', { op: 'delete', id: 'r1', labels: ['KNOWS'] });
  const cleared = await waitForRows(d, 'q', (rows) => rows.length === 0);
  assert.equal(cleared.length, 0, 'relation delete propagated');
  await d.close();
});
