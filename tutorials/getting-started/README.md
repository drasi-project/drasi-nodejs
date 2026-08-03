<!-- DO NOT EDIT. Generated from _index.md by scripts/render-tutorials.py. Edit _index.md and run `python3 scripts/render-tutorials.py`. -->

Imagine you want to react the instant data changes — a new row in a database, a value crossing a
threshold, or something that *should* have changed but didn't. Drasi lets you express these as
**continuous queries** that stay constantly up to date, with no polling.

This tutorial is the best place to start with **`@drasi/lib`**, the Node.js library that embeds the
Drasi continuous-query engine directly in your process. You'll build a small **console app** — no web
UI — that connects to a live PostgreSQL table of messages and, step by step, runs five continuous
queries that detect changes, filter them, aggregate them, detect the *absence* of change, and join
data across two sources. Every change prints to your terminal in real time.

Unlike the [Drasi Server tutorial](https://drasi.io/drasi-server/tutorials/getting-started/) this is
based on, there is no separate server to run, no REST API, and no config files. Instead your app
embeds the engine and wires everything up in a few lines of code: it adds the sources, registers the
queries, and attaches a **JavaScript reaction** — a callback that receives every query-result change
and prints it. That callback is the embedded-library equivalent of Drasi's built-in *Log Reaction*,
and it's where the library's power shows: you react to changes in **your own code**.

**What you'll build:** a running Node console app that embeds Drasi, connects to PostgreSQL (and a
second HTTP source), and reacts to changes in real time — assembled from Drasi's three core building
blocks:

**Sources** → **Continuous Queries** → **Reactions**

- **Sources** — Connect to your data sources
- **Continuous Queries** — Define what changes matter
- **Reactions** — Take action automatically

| Step | What You'll Do | Time |
| ---- | ------------- | ---- |
| **[Step 1: Set Up Your Environment](#step-1-of-7-set-up-your-environment)** | Open the dev container (or install Node + Docker locally) | 5 min |
| **[Step 2: Run the Demo](#step-2-of-7-run-the-demo)** | One command starts PostgreSQL and the console app | 3 min |
| **[Step 3: Watch Changes](#step-3-of-7-watch-changes)** | Insert, update, and delete messages; watch `all-messages` react | 4 min |
| **[Step 4: Filter](#step-4-of-7-filter)** | See how a `WHERE` clause turns a change feed into a focused signal | 3 min |
| **[Step 5: Aggregate](#step-5-of-7-aggregate)** | Count messages live as data changes | 3 min |
| **[Step 6: Detect Inactivity](#step-6-of-7-detect-inactivity)** | Detect the *absence* of change over time | 4 min |
| **[Step 7: Join Across Sources](#step-7-of-7-join-across-sources)** | Join messages with live location data from a second source | 5 min |
| **[How It Works](#how-it-works)** | Understand the sources, the five queries, and the JavaScript reaction | 6 min |
| **[Putting It All Together](#putting-it-all-together)** | Read the whole app — every source, query, and the reaction — in one file | 3 min |

> **Before you begin**
>
> - **Two terminals:** **Terminal 1** runs the console app (it stays in the foreground, printing
>   changes). Use **Terminal 2** to drive changes with `docker exec` (for messages) and `curl` (for
>   location updates).
> - **Working directory:** run every command from the tutorial directory
>   (`tutorials/getting-started/`). The dev container opens there automatically; if you're running
>   locally, `cd tutorials/getting-started` first.
> - **Ports:** PostgreSQL is published on `5632`, and the app's HTTP source (used in the last step)
>   listens on `9000`. There is no web UI.

## Step 1 of 7: Set Up Your Environment
This tutorial needs **Docker** (it runs PostgreSQL) and **Node.js 18+**. The easiest way to get
everything is the **dev container**, which installs it all for you. You can also run locally.

### Option A: Dev Container or GitHub Codespaces (recommended)

This repo has several tutorial dev containers. Codespaces does **not** ask which one to use
if you click **Create codespace** on the default **Code** menu — pick the configuration
explicitly (or use the link below).

1. **GitHub Codespaces:** Open
   [this Codespaces link](https://codespaces.new/drasi-project/drasi-nodejs?devcontainer_path=.devcontainer/getting-started/devcontainer.json)
   (it selects **Drasi Node.js — Getting Started Tutorial** for you).

   Or from the repo page: **Code** → **Codespaces** → **…** next to **Create codespace on
   main** → **New with options…**, set **Dev container configuration** to **Drasi Node.js —
   Getting Started Tutorial**, then create the codespace.

2. **VS Code (local):** Open the
   [`drasi-nodejs`](https://github.com/drasi-project/drasi-nodejs) repository and run
   **Dev Containers: Reopen in Container**. When prompted for a configuration, choose
   **Drasi Node.js — Getting Started Tutorial**.

3. Wait for the container to finish. Its setup script installs Node dependencies for the
   tutorial.

That's it — skip ahead to [Step 2](#step-2-of-7-run-the-demo).

### Option B: Run Locally

You'll need **Node.js 18+** and **Docker** (for PostgreSQL). You drive changes with `docker` and
`curl`, which work in any shell. From the repository root, move into the tutorial directory and
install its dependencies:

```bash
cd tutorials/getting-started
npm install
```

`@drasi/lib` ships **prebuilt binaries**, so there's no Rust toolchain to install — npm resolves the
correct native addon for your platform. (Intel macOS has no prebuilt binary and must build from
source; see the [library docs](https://drasi-project.github.io/drasi-nodejs/).)

## Step 2 of 7: Run the Demo
Everything runs from a single command. In **Terminal 1**, start the demo:

```bash
npm run demo
```

`npm run demo` starts PostgreSQL (seeded with a `Message` table of four messages) and then runs the
console app in the foreground.

On first start, the app downloads the Drasi plugins it needs — `source/postgres`,
`bootstrap/postgres`, `source/http`, and `bootstrap/scriptfile`. It uses `installPlugin`, which
resolves each one to the build that matches your platform **and** this library version (no tags,
architecture suffixes, or filenames to work out), then connects to the database, bootstraps the four
existing messages, and starts the five continuous queries. When you see this line, it's ready:

```text
✅ Getting Started is ready — Drasi is watching for changes.
```

The app prints query changes **as they happen** — it doesn't dump the current state on startup. In
fact, the first thing you'll see is a burst of output about **20 seconds in**: the `inactive-senders`
query firing because the four seed senders have gone quiet (more on that in [Step 6](#step-6-of-7-detect-inactivity)). Leave
the app running; you'll drive all the changes from **Terminal 2**.

> **Stopping and resetting**
>
> Press **Ctrl+C** in Terminal 1 to stop the app. To remove the database container when you're
> completely done, run `docker compose -f database/docker-compose.yml down` (add `--volumes` to also
> delete the data). The database keeps running between app restarts, so you can stop and start the app
> freely.

## Step 3 of 7: Watch Changes
The first query, `all-messages`, selects every message and keeps the result set continuously up to
date. Let's change the data and watch it react. In **Terminal 2**, send a new message:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "INSERT INTO \"Message\" (\"From\", \"Message\") VALUES ('You', 'My first message');"
```

That's a plain SQL `INSERT` against PostgreSQL, run with `psql` inside the database container. Watch
**Terminal 1** — an **ADD** notification appears instantly:

```text
[drasi] Query 'all-messages' (1 change):
  [ADD]    {"From":"You","Message":"My first message","MessageId":5}
```

Now **update** that message's text:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "UPDATE \"Message\" SET \"Message\" = 'My first UPDATED message' WHERE \"MessageId\" = 5;"
```

Drasi reports the transition — the row's *before* and *after* — because it maintains the query's
result set, not just the latest change:

```text
[drasi] Query 'all-messages' (1 change):
  [UPDATE] {"From":"You","Message":"My first message","MessageId":5} -> {"From":"You","Message":"My first UPDATED message","MessageId":5}
```

Finally, **delete** it:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "DELETE FROM \"Message\" WHERE \"MessageId\" = 5;"
```

```text
[drasi] Query 'all-messages' (1 change):
  [DELETE] {"From":"You","Message":"My first UPDATED message","MessageId":5}
```

With three SQL statements you've seen all three change notifications: an **ADD** when a row entered
the result set, an **UPDATE** showing the row's *before* and *after*, and a **DELETE** when it left —
each printed the instant the database changed, and you didn't write any code to detect, diff, or
deliver them. That's the continuous query and the reaction doing their job.

## Step 4 of 7: Filter
The `hello-world-senders` query is the same idea with a `WHERE` clause — it selects only messages
whose text is exactly `Hello World`, returning who sent them. This is the kind of filter that turns a
raw change feed into a **focused signal**.

The seed data already contains one match (Brian Kernighan's "Hello World"), but the reaction only
prints *changes*, so let's create one. Send a matching message:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "INSERT INTO \"Message\" (\"From\", \"Message\") VALUES ('Alice', 'Hello World');"
```

Two queries react — the message is part of both result sets:

```text
[drasi] Query 'all-messages' (1 change):
  [ADD]    {"From":"Alice","Message":"Hello World","MessageId":6}
[drasi] Query 'hello-world-senders' (1 change):
  [ADD]    {"Id":6,"Sender":"Alice"}
```

Now send a message that **doesn't** match:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "INSERT INTO \"Message\" (\"From\", \"Message\") VALUES ('Bob', 'Goodbye World');"
```

Only `all-messages` reacts — `hello-world-senders` stays silent, because Bob's message isn't part of
its result set:

```text
[drasi] Query 'all-messages' (1 change):
  [ADD]    {"From":"Bob","Message":"Goodbye World","MessageId":7}
```

`WHERE` clauses control exactly what a query's result set contains, and therefore what changes
generate notifications.

## Step 5 of 7: Aggregate
Drasi maintains state across all the data it processes, so a continuous query can compute
**aggregations** — counts, sums, averages — that update automatically as the underlying data changes.
The `message-counts` query counts how many times each unique message text has been sent.

Send another "Hello World":

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "INSERT INTO \"Message\" (\"From\", \"Message\") VALUES ('Eve', 'Hello World');"
```

Watch the `message-counts` change — the count for "Hello World" goes from `2` to `3`:

```text
[drasi] Query 'message-counts' (1 change):
  [UPDATE] {"Count":2,"MessageText":"Hello World"} -> {"Count":3,"MessageText":"Hello World"}
```

Drasi didn't re-scan the table — it incrementally updated the count from the single change it
processed. This is what lets a query stay current over a large dataset without the cost of repeatedly
re-reading it, and it's exactly what backs live dashboards and metrics.

## Step 6 of 7: Detect Inactivity
Drasi can query patterns over time, including the **absence of change** — "something that *should*
have happened but didn't". The `inactive-senders` query returns people who haven't sent a message in
the last **20 seconds**. It uses two [Drasi custom functions](https://drasi.io/reference/query-language/drasi-custom-functions):

- **`drasi.changeDateTime(m)`** — the timestamp when a node was last changed, without a
  user-managed timestamp column.
- **`drasi.trueLater(condition, futureTime)`** — schedules Drasi to re-evaluate the condition at a
  future time. Without it, the time-based `WHERE` clause would only be checked when data changes;
  with it, Drasi re-evaluates after the 20-second window expires, so idle senders appear **even when
  no new data arrives**.

Because everyone who sent a message earlier has now been idle for more than 20 seconds, the query's
result set is already populated with them. To watch a transition, send a message from **Alice**:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "INSERT INTO \"Message\" (\"From\", \"Message\") VALUES ('Alice', 'About to go quiet');"
```

Alice is active again, so she's immediately **removed** from `inactive-senders`:

```text
[drasi] Query 'inactive-senders' (1 change):
  [DELETE] {"LastMessageTimestamp":"...","MessageFrom":"Alice"}
```

Now **wait 20 seconds** without sending anything from Alice. With no new data, Drasi re-evaluates the
time condition on its own and Alice ages back into the set:

```text
[drasi] Query 'inactive-senders' (1 change):
  [ADD]    {"LastMessageTimestamp":"...","MessageFrom":"Alice"}
```

No database change triggered that second notification — you expressed the intent in the query, and
there's no polling loop or scheduler in your code.

## Step 7 of 7: Join Across Sources
In real systems, related data often lives in different places. Drasi can **join across sources**
using a *virtual relationship*, so a query traverses data from multiple sources as if it were a
single graph — and a change from *any* source flows through the join in real time.

Alongside the PostgreSQL source, the app runs a second **HTTP source** called `location-tracker`. It's
configured with a custom **webhook**: a `POST /locations` route that accepts a friendly, flat
`{ name, location, status }` payload and shapes it into a `UserLocation` node. It's also seeded from a
file (`locations.jsonl`). The `messages-with-location` query joins each message to its sender's live
location, matching `Message.From` to `UserLocation.name`.

First, simulate Brian moving to a new location by POSTing to the webhook:

```bash
curl -X POST http://localhost:9000/locations \
  -H "Content-Type: application/json" \
  -d '{"name": "Brian Kernighan", "location": "Conference Room B", "status": "away"}'
```

The change propagates through the join — Brian's message now shows the new location, with `before`
and `after`:

```text
[drasi] Query 'messages-with-location' (1 change):
  [UPDATE] {"Id":2,"Location":"Building A, Floor 3","Message":"Hello World","Sender":"Brian Kernighan","Status":"online"} -> {"Id":2,"Location":"Conference Room B","Message":"Hello World","Sender":"Brian Kernighan","Status":"away"}
```

Now test the other direction. Send a message from **Carol**, a sender who has no location yet:

```bash
docker exec getting-started-nodejs-postgres psql -U drasi_user -d getting_started \
  -c "INSERT INTO \"Message\" (\"From\", \"Message\") VALUES ('Carol', 'Good morning');"
```

`all-messages` reacts, but `messages-with-location` does **not** — there's no matching `UserLocation`
for Carol, so the join produces no row. Now give Carol a location — the same simple payload:

```bash
curl -X POST http://localhost:9000/locations \
  -H "Content-Type: application/json" \
  -d '{"name": "Carol", "location": "Home Office", "status": "online"}'
```

The join resolves the instant data from both sources is available, and Carol's joined row appears:

```text
[drasi] Query 'messages-with-location' (1 change):
  [ADD]    {"Id":10,"Location":"Home Office","Message":"Good morning","Sender":"Carol","Status":"online"}
```

No change to PostgreSQL triggered that — it came entirely from the HTTP source. The join is
symmetric: a change in either source can complete (or invalidate) a match.

## How It Works
Everything you just ran is a single Node console app under `tutorials/getting-started/` — and it's
one file. `index.mjs` downloads the plugins, adds the sources, registers the five queries, and
attaches the reaction. Here's what each part does.

### The Sources

The app connects two sources (`index.mjs`). PostgreSQL streams `Message` changes via **logical
replication (CDC)**:

```js
await engine.addSource('postgres', 'messages', {
  host: 'localhost',
  port: 5632,
  database: 'getting_started',
  user: 'drasi_user',
  password: 'drasi_password',
  tables: ['Message'],
  slotName: 'drasi_getting_started_slot',
  publicationName: 'drasi_getting_started_pub',
  tableKeys: [{ table: 'Message', keyColumns: ['MessageId'] }],
}, true, { kind: 'postgres', config: /* same */ });
```

The `Message` table and columns are quoted and PascalCase in the database (`"Message"`, `"MessageId"`,
`"From"`), so the node label and properties Drasi sees match the queries — `(m:Message)`,
`m.MessageId`, `m.From` — with no change to the query text.

The second source is an **HTTP source**. Rather than accept the raw event format, it defines a custom
**webhook** route that maps a friendly `{ name, location, status }` payload onto a `UserLocation` node
with Handlebars templates. It also bootstraps its initial data from a JSONL file via the **ScriptFile
bootstrap provider**:

```js
await engine.addSource('http', 'location-tracker', {
  host: '0.0.0.0',
  port: 9000,
  webhooks: {
    routes: [{
      path: '/locations',
      methods: ['POST'],
      mappings: [{
        operation: 'update',            // upsert the user's location node
        elementType: 'node',
        template: {
          id: '{{payload.name}}',
          labels: ['UserLocation'],
          properties: {
            name: '{{payload.name}}',
            location: '{{payload.location}}',
            status: '{{payload.status}}',
          },
        },
      }],
    }],
  },
}, true, { kind: 'scriptfile', config: { filePaths: [/* locations.jsonl */] } });
```

So a caller sends `curl -d '{"name":"...","location":"...","status":"..."}'` to `POST /locations` (as
you did in Step 7), and the source turns it into a graph change. `{{payload.*}}` reads fields from the
request body; using the sender's `name` as the node `id` means a later POST for the same person
updates the same `UserLocation`.

### The Continuous Queries

All five queries are declared explicitly in `index.mjs`, one `addQuery` call each — with the embedded
library you describe your topology in code, and every query runs from the moment the app starts. For
example, the change-detection query:

```js
await engine.addQuery('all-messages', `
  MATCH (m:Message)
  RETURN m.MessageId AS MessageId, m.From AS From, m.Message AS Message
`, ['messages'], 'cypher');
```

| Query | What it does |
| ----- | ------------ |
| `all-messages` | Every message — change detection |
| `hello-world-senders` | Only `Message = 'Hello World'` — a `WHERE` filter |
| `message-counts` | `count(m)` grouped by message text — an aggregation |
| `inactive-senders` | Senders idle > 20s — time-based, via `drasi.trueLater` |
| `messages-with-location` | Messages joined to live locations — a cross-source join |

The join query lists two sources and declares the virtual relationship that connects them, inline as
the fifth argument to `addQuery`:

```cypher
MATCH (m:Message)-[:FROM_USER]->(u:UserLocation)
RETURN m.MessageId AS Id, m.Message AS Message,
       m.From AS Sender, u.location AS Location, u.status AS Status
```

```js
await engine.addQuery('messages-with-location', joinCypher,
  ['messages', 'location-tracker'], 'cypher', [
    {
      id: 'FROM_USER',
      keys: [
        { label: 'Message', property: 'From' },
        { label: 'UserLocation', property: 'name' },
      ],
    },
  ]);
```

There's no foreign key between the two systems — Drasi materializes the relationship from these keys
and maintains the join state, propagating changes from either source into the result set.

### The JavaScript Reaction

This is where the embedded library differs most from Drasi Server. Instead of configuring a built-in
reaction, you attach a **callback** with `addJsReaction` and subscribe it to whichever queries you
care about. It receives every query-result change and does whatever you want — here, a `switch` on the
change type prints it:

```js
await engine.addJsReaction('console', [/* all five query ids */], (event) => {
  for (const d of event.results) {
    switch (d.type) {
      case 'ADD':
        console.log(`[ADD]    ${JSON.stringify(d.data)}`);
        break;
      case 'DELETE':
        console.log(`[DELETE] ${JSON.stringify(d.data)}`);
        break;
      case 'UPDATE':
      case 'aggregation':
        console.log(`[UPDATE] ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
        break;
    }
  }
});
```

Each change is a tagged union: `ADD` and `DELETE` carry `data`; `UPDATE` and `aggregation` carry
`before` and `after`. That's the whole reaction — no plugin to install, no template to write. From
here you could just as easily update another database, call an API, or push to a queue.

## Putting It All Together
That's the whole tutorial — and it fits in a single file. Here is `index.mjs` end to end (a few
startup `console.log` lines trimmed for brevity): two sources (one with the custom webhook), the five
continuous queries, and the one reaction that prints every change.

```js
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';

const require = createRequire(import.meta.url);
const { Drasi } = require('@drasi/lib');

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// PostgreSQL connection — matches database/docker-compose.yml + database/init.sql.
const PG = {
  host: env.POSTGRES_HOST || 'localhost',
  port: Number(env.POSTGRES_PORT || 5632),
  database: env.POSTGRES_DATABASE || 'getting_started',
  user: env.POSTGRES_USER || 'drasi_user',
  password: env.POSTGRES_PASSWORD || 'drasi_password',
  sslMode: 'prefer',
  tables: ['Message'],
  slotName: 'drasi_getting_started_slot',
  publicationName: 'drasi_getting_started_pub',
  tableKeys: [{ table: 'Message', keyColumns: ['MessageId'] }],
};

const HTTP_SOURCE_PORT = Number(env.HTTP_SOURCE_PORT || 9000);
const LOCATIONS_FILE = join(__dirname, 'locations.jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve when a TCP port accepts a connection, or throw after `attempts`. */
async function waitForPort(host, port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise((resolve) => {
      const socket = createConnection({ host, port });
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => (socket.destroy(), resolve(false)));
    });
    if (ok) return;
    await sleep(1000);
  }
  throw new Error(`PostgreSQL is not reachable at ${host}:${port}. Start it with 'npm run db:up'.`);
}

/** Print one query-result change, mirroring Drasi's Log Reaction output. */
function printChange(event) {
  const diffs = (event.results || []).filter((d) => d.type !== 'noop');
  if (diffs.length === 0) return;
  const j = (v) => JSON.stringify(v);
  console.log(`[drasi] Query '${event.query_id}' (${diffs.length} change${diffs.length === 1 ? '' : 's'}):`);
  for (const d of diffs) {
    switch (d.type) {
      case 'ADD':
        console.log(`  [ADD]    ${j(d.data)}`);
        break;
      case 'DELETE':
        console.log(`  [DELETE] ${j(d.data)}`);
        break;
      case 'UPDATE':
      case 'aggregation':
        console.log(`  [UPDATE] ${j(d.before)} -> ${j(d.after)}`);
        break;
    }
  }
}

async function main() {
  const engine = await Drasi.create('getting-started', {});

  // 1. Download the plugins and register them. installPlugin resolves each
  //    reference to the build that is compatible with this addon and made for the
  //    current platform — no version tags, arch suffixes, or filenames to work out.
  const pluginsDir = mkdtempSync(join(tmpdir(), 'drasi-plugins-'));
  await engine.installPlugin('source/postgres', pluginsDir);
  await engine.installPlugin('bootstrap/postgres', pluginsDir);
  await engine.installPlugin('source/http', pluginsDir);
  await engine.installPlugin('bootstrap/scriptfile', pluginsDir);
  await engine.loadPlugins(pluginsDir);

  await engine.start();

  // 2a. PostgreSQL source: streams `Message` changes via logical replication.
  await waitForPort(PG.host, PG.port);
  await engine.addSource('postgres', 'messages', PG, true, { kind: 'postgres', config: PG });

  // 2b. HTTP source with a custom webhook: a flat { name, location, status } POST
  //     at /locations is shaped into a UserLocation node. Bootstraps from a file.
  await engine.addSource('http', 'location-tracker', {
    host: '0.0.0.0',
    port: HTTP_SOURCE_PORT,
    webhooks: {
      routes: [{
        path: '/locations',
        methods: ['POST'],
        mappings: [{
          operation: 'update',
          elementType: 'node',
          template: {
            id: '{{payload.name}}',
            labels: ['UserLocation'],
            properties: {
              name: '{{payload.name}}',
              location: '{{payload.location}}',
              status: '{{payload.status}}',
            },
          },
        }],
      }],
    },
  }, true, { kind: 'scriptfile', config: { filePaths: [LOCATIONS_FILE] } });

  // 3. The five continuous queries, each declared explicitly.

  // Change detection: every message, passed through unchanged.
  await engine.addQuery('all-messages', `
    MATCH (m:Message)
    RETURN m.MessageId AS MessageId, m.From AS From, m.Message AS Message
  `, ['messages'], 'cypher');

  // Filter: only messages whose text is exactly 'Hello World'.
  await engine.addQuery('hello-world-senders', `
    MATCH (m:Message)
    WHERE m.Message = 'Hello World'
    RETURN m.MessageId AS Id, m.From AS Sender
  `, ['messages'], 'cypher');

  // Aggregation: how many times each unique message text has been sent.
  await engine.addQuery('message-counts', `
    MATCH (m:Message)
    RETURN m.Message AS MessageText, count(m) AS Count
  `, ['messages'], 'cypher');

  // Time / absence of change: senders idle > 20s, via drasi.trueLater.
  await engine.addQuery('inactive-senders', `
    MATCH (m:Message)
    WITH m.From AS MessageFrom, max(drasi.changeDateTime(m)) AS LastMessageTimestamp
    WHERE LastMessageTimestamp <= datetime.realtime() - duration({ seconds: 20 })
       OR drasi.trueLater(
            LastMessageTimestamp <= datetime.realtime() - duration({ seconds: 20 }),
            LastMessageTimestamp + duration({ seconds: 20 }))
    RETURN MessageFrom, LastMessageTimestamp
  `, ['messages'], 'cypher');

  // Cross-source join (PostgreSQL source first; see drasi-project/drasi-core#682).
  await engine.addQuery('messages-with-location', `
    MATCH (m:Message)-[:FROM_USER]->(u:UserLocation)
    RETURN m.MessageId AS Id, m.Message AS Message,
           m.From AS Sender, u.location AS Location, u.status AS Status
  `, ['messages', 'location-tracker'], 'cypher', [
    {
      id: 'FROM_USER',
      keys: [
        { label: 'Message', property: 'From' },
        { label: 'UserLocation', property: 'name' },
      ],
    },
  ]);

  // 4. One JavaScript reaction, subscribed to every query, that prints changes.
  await engine.addJsReaction('console', [
    'all-messages',
    'hello-world-senders',
    'message-counts',
    'inactive-senders',
    'messages-with-location',
  ], printChange);

  console.log('\n✅ Getting Started is ready — Drasi is watching for changes.\n');

  // Keep the process alive so the engine keeps streaming until Ctrl+C.
  setInterval(() => {}, 1 << 30);

  async function shutdown(signal) {
    try {
      await engine.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('\nFailed to start Getting Started:\n', err);
  process.exit(1);
});
```

**Lines of application logic beyond wiring: just the reaction's `switch`.** The sources, the five
queries, and the join are all declarative — Drasi does the rest.

## Clean Up
When you're finished, stop the app with **Ctrl+C** in Terminal 1, then remove the database container:

```bash
# Stop the container, keep the data
docker compose -f database/docker-compose.yml down

# Stop the container and delete the data volume
docker compose -f database/docker-compose.yml down --volumes
```

## What You Learned
- **Sources** connect Drasi to live data — here, PostgreSQL via Change Data Capture and an HTTP
  source, both embedded directly in a Node app with `@drasi/lib`.
- **Continuous Queries** detect changes, **filter** them, **aggregate** them, reason about **time**
  (the *absence* of change, via `drasi.trueLater`), and **join across sources** with virtual
  relationships — all kept current automatically, with no polling.
- **Reactions** turn query changes into action. A **JavaScript reaction** (`addJsReaction`) handed
  every change to your own callback — the embedded-library way to react to change in code.

From here, try the [Building Comfort](../building-comfort/) and [Curbside Pickup](../curbside-pickup/)
tutorials, which build full applications with an **SSE reaction** that shapes payloads with Handlebars
to drive a live web UI.
