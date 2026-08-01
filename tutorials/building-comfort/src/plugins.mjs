// Downloads the Drasi plugins this tutorial needs from the OCI registry
// (ghcr.io/drasi-project) and registers them. `installPlugin` resolves each
// reference to the build that matches this @drasi/lib addon and the current
// platform — no version tags, architecture suffixes, or filenames to work out.

// The Postgres CDC source + its bootstrap provider, and the SSE reaction that
// streams query-result changes to the browser (shaped by Handlebars templates).
const REQUIRED = [
  'source/postgres',
  'bootstrap/postgres',
  'reaction/sse',
];

/** Download all required plugins into `dir` and register them with the engine. */
export async function ensurePlugins(engine, dir) {
  for (const reference of REQUIRED) {
    console.log(`[plugins] installing ${reference}`);
    await engine.installPlugin(reference, dir);
  }
  await engine.loadPlugins(dir);
}
