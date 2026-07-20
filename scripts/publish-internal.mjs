#!/usr/bin/env node
// Reliable "internal" publish of @drasi/lib to an Azure Artifacts npm feed.
//
// Why this wrapper exists (and why a plain `npm publish --registry <url>` is not
// enough for THIS repo):
//
//   @drasi/lib is a napi-rs package that publishes the main package PLUS several
//   per-platform packages (@drasi/lib-<platform>). The per-platform packages are
//   published by the `prepublishOnly` hook (`napi prepublish -t npm`), which runs
//   a bare `npm publish` in each generated npm/<platform> directory. Those child
//   publishes inherit the *ambient* npm configuration (npm config files and the
//   process environment) — they do NOT see a `--registry` flag passed to the
//   outer `npm publish`. So targeting a registry only on the command line would
//   send the main package to one registry and the per-platform packages to
//   another (usually the public default). That split is exactly the kind of
//   registry misconfiguration we want to avoid.
//
//   To keep every package on the same feed we set `npm_config_registry` (and
//   `npm_config_always_auth`) in the environment, which both the outer publish
//   and the per-platform child publishes inherit. We also disable provenance,
//   because npm provenance is only supported when publishing to the public npm
//   registry via OIDC — Azure Artifacts feeds do not support it.
//
// Auth is NOT handled here: authenticate to the feed out of band (e.g. with
// `vsts-npm-auth`, `az` / azure-devops npm auth, or an `_authToken`/`_password`
// line in your USER-level ~/.npmrc). Never commit credentials to this repo.
//
// Usage:
//   AZURE_ARTIFACTS_REGISTRY_URL=https://pkgs.dev.azure.com/ORG/PROJECT/_packaging/FEED/npm/registry/ \
//     npm run publish:internal
//
//   # or pass the registry explicitly (equivalent):
//   npm run publish:internal -- --registry https://pkgs.dev.azure.com/.../registry/
//
//   # extra args are forwarded to `npm publish`, e.g. a dry run or a dist-tag:
//   npm run publish:internal -- --dry-run
//   npm run publish:internal -- --tag next

import { spawnSync } from 'node:child_process';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

function fail(message) {
  console.error(`\n[publish:internal] ${message}\n`);
  process.exit(1);
}

// Resolve the target registry from --registry <url>, --registry=<url>, or the
// AZURE_ARTIFACTS_REGISTRY_URL / npm_config_registry environment variables.
const forwarded = process.argv.slice(2);
let registry;
const passthrough = [];
for (let i = 0; i < forwarded.length; i++) {
  const arg = forwarded[i];
  if (arg === '--registry') {
    registry = forwarded[++i];
  } else if (arg.startsWith('--registry=')) {
    registry = arg.slice('--registry='.length);
  } else {
    passthrough.push(arg);
  }
}
registry =
  registry ||
  process.env.AZURE_ARTIFACTS_REGISTRY_URL ||
  process.env.npm_config_registry;

if (!registry) {
  fail(
    'No internal registry configured. Set AZURE_ARTIFACTS_REGISTRY_URL (or pass ' +
      '--registry <url>) so the main package AND the per-platform packages all ' +
      'publish to the same feed. Refusing to publish to avoid accidentally ' +
      'targeting the public npm registry.',
  );
}

// Guard against accidentally using this internal-only path to publish to public
// npm (that is what `npm run publish:public` is for, with provenance intact).
if (/registry\.npmjs\.org/i.test(registry)) {
  fail(
    `Refusing to run the internal publish against the public npm registry (${registry}). ` +
      'Use `npm run publish:public` for public releases.',
  );
}

const isDryRun = passthrough.includes('--dry-run');
console.log(
  `[publish:internal] ${isDryRun ? '(dry run) ' : ''}publishing @drasi/lib and ` +
    `per-platform packages to: ${registry}`,
);
console.log('[publish:internal] provenance is disabled for non-npmjs feeds.');

const childEnv = {
  ...process.env,
  // Inherited by both the outer `npm publish` and the `napi prepublish` child
  // publishes, so every package lands on the same feed.
  npm_config_registry: registry,
  npm_config_always_auth: 'true',
  // npm provenance is public-npm/OIDC only; force it off for internal feeds.
  npm_config_provenance: 'false',
};

const result = spawnSync('npm', ['publish', ...passthrough], {
  stdio: 'inherit',
  env: childEnv,
  shell: process.platform === 'win32',
});

if (result.error) {
  fail(`Failed to launch npm: ${result.error.message}`);
}
process.exit(result.status ?? 1);
