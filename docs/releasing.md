# Releasing `@drasi/lib`

This document is the end-to-end guide for maintainers cutting a release of the
`@drasi/lib` native bindings. It covers how distribution works, the versioning
policy, the routine release steps, and the one-time human prerequisites that must
be completed before the **first** stable publish.

## How distribution works

`@drasi/lib` is a [napi-rs](https://napi.rs) native addon. Rather than compiling
Rust on every `npm install`, we ship **prebuilt binaries**:

- The main package (`@drasi/lib`) contains only the JavaScript loader
  (`index.js`), the generated type declarations (`index.d.ts`, `types.d.ts`) — no
  `.node` binary.
- Each supported platform gets its own tiny package that contains just the
  compiled `.node` file:

  | Target triple                 | npm package                    |
  | ----------------------------- | ------------------------------ |
  | `x86_64-pc-windows-msvc`      | `@drasi/lib-win32-x64-msvc`    |
  | `x86_64-unknown-linux-gnu`    | `@drasi/lib-linux-x64-gnu`     |
  | `aarch64-unknown-linux-gnu`   | `@drasi/lib-linux-arm64-gnu`   |
  | `aarch64-apple-darwin`        | `@drasi/lib-darwin-arm64`      |

  **Intel macOS (`x86_64-apple-darwin`) is intentionally not prebuilt** — the
  `macos-13` Intel runners GitHub is deprecating made release scheduling
  unreliable, and Apple silicon is the forward-looking target. Intel-mac users run
  by building from source (see _Build from source_ in the README).

- The platform packages are wired as **`optionalDependencies`** of the main
  package. npm installs only the one matching the consumer's `os`/`cpu`/`libc`,
  and the loader in `index.js` `require`s it at runtime (falling back to a local
  `./drasi.<triple>.node` for development builds).

The set of targets is declared once in [`package.json`](../package.json) under
`napi.targets`. The `optionalDependencies` block and the per-platform `npm/`
package directories are **generated at publish time** by `@napi-rs/cli` — they are
intentionally not committed (they are derived data, and committing them for
not-yet-published versions would churn the lockfile).

## Versioning policy (SemVer)

The package follows [Semantic Versioning 2.0.0](https://semver.org):

- **MAJOR** — incompatible changes to the public JavaScript/TypeScript API or a
  change to the plugin FFI ABI contract that breaks previously loadable plugins.
- **MINOR** — backwards-compatible new functionality (new methods/options, new
  supported platform targets, additive type changes).
- **PATCH** — backwards-compatible bug fixes and internal changes.

Additional rules:

- The main package and every `@drasi/lib-<platform>` package are always published
  at the **same version** (handled automatically by `napi prepublish`).
- Keep `version` in [`package.json`](../package.json) and `version` in
  [`Cargo.toml`](../Cargo.toml) in sync.
- Pre-1.0 (`0.x`) releases may make breaking changes in MINOR bumps.
- Pre-releases use SemVer pre-release tags (e.g. `1.0.0-rc.1`) and are published to
  npm under the `next` dist-tag rather than `latest`.
- Every user-facing change is recorded in [`CHANGELOG.md`](../CHANGELOG.md) under
  `[Unreleased]` and rolled into the version section at release time.

## The release pipeline

Releases are automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml):

- **Trigger:** pushing a `vX.Y.Z` git tag.
- **`build` matrix:** builds the addon for all four targets
  (`napi build --platform --release --target <triple>`) on matching **native
  runners** — Windows x64, macOS arm64 (`macos-14`), Linux x64 (`ubuntu-22.04`) and
  arm64 (`ubuntu-22.04-arm`). Native runners are used instead of cross-compilation
  because the dependency tree includes C/assembly crates (e.g. `aws-lc-sys`) whose
  cross builds are fragile. Intel macOS (`x86_64-apple-darwin`) is not built (see
  the note above). It uploads each `.node` plus the
  loader/types as workflow artifacts. The Linux jobs are pinned to **Ubuntu 22.04
  (glibc 2.35)**, so the prebuilt Linux binaries require **glibc >= 2.35**
  (Ubuntu 22.04 / Debian 12 / RHEL 9 and newer). If an even lower glibc floor is
  ever required, build the Linux targets in a manylinux container (or via
  `--use-napi-cross`/zig, mindful of the `aws-lc-sys` cross-build caveats above).
- **`publish` job** (tag pushes only): downloads all artifacts, runs
  `napi create-npm-dirs` + `napi artifacts` to assemble the per-platform packages,
  then `npm publish`. The `prepublishOnly` hook (`napi prepublish -t npm`)
  publishes every `@drasi/lib-<platform>` package and injects the matching
  `optionalDependencies` into the main package before it is published.

You can also run the workflow via **`workflow_dispatch`** (Actions → Release → Run
workflow) to validate the cross-platform build matrix **without** publishing — the
`publish` job is skipped for anything that isn't a `v*` tag push.

### Build provenance & authentication

The `publish` job requests `id-token: write` and runs `npm config set provenance
true`, so both the main and per-platform packages are published with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements)
attestations. Authentication is **OIDC-first with a token fallback**:

- If a repository secret named `NPM_TOKEN` exists, it is used to authenticate.
- Otherwise, npm uses the **OIDC Trusted Publisher** relationship configured on
  npmjs.com (no long-lived token needed). This is the preferred steady state.

## Routine release checklist

Once the one-time prerequisites below are done, cutting a release is:

1. Ensure `main` is green and contains everything you want to ship.
2. Choose the new version `X.Y.Z` per the SemVer policy above.
3. Bump the version in **`package.json`** and **`Cargo.toml`** (keep them equal).
4. In **`CHANGELOG.md`**, rename the `[Unreleased]` section to `## [X.Y.Z] - <date>`
   and add a fresh empty `[Unreleased]` section above it.
5. Commit (e.g. `chore(release): vX.Y.Z`) and open/merge the PR to `main`.
6. Tag and push:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

7. Watch the **Release** workflow. When it finishes, verify on npm:

   ```bash
   npm view @drasi/lib@X.Y.Z
   npm view @drasi/lib-darwin-arm64@X.Y.Z   # spot-check a platform package
   ```

8. (Optional) Install into a scratch project on each OS to confirm the prebuilt
   binary resolves with no Rust toolchain present.

## Dual publish: public npm + internal Azure Artifacts

`@drasi/lib` supports an **optional** second publish target — an internal
[Azure Artifacts](https://learn.microsoft.com/azure/devops/artifacts/) npm feed —
in addition to the public npm registry.

### Publishing model

- **Public npm is the source of truth** for all open-source consumers. Public
  releases are unchanged by the internal path.
- **Internal Azure Artifacts is optional and additive**, intended only for
  Microsoft-internal consumption. It is never required to cut an OSS release.
- The internal path exists because, on Microsoft-managed machines, a newly
  published *public* npm version can be unavailable for roughly **7 days**
  through the corp/quarantine path. Publishing the same version to an internal
  feed gives internal users a tighter loop without waiting on quarantine.
- **No credentials are ever committed.** Maintainers authenticate locally with
  their normal npm / Azure Artifacts auth, and CI uses repo/environment secrets.
- **Feed setup is managed separately** from this repo. Azure Artifacts guidance
  is to expose a **single feed URL** with upstream sources configured on the feed
  (so npmjs.org is reachable through the one feed) rather than scattering multiple
  registries in client config.
- **Consuming repos are out of scope.** Internal consumers point their install
  config at the internal feed; that is configured in those repos, not here.

### Why registry routing needs care here (napi multi-package)

This repo publishes the main `@drasi/lib` package **and** the per-platform
`@drasi/lib-<platform>` packages. The per-platform packages are published by the
`prepublishOnly` hook (`napi prepublish -t npm`), which runs a bare `npm publish`
in each generated `npm/<platform>` directory. Those child publishes only read
**ambient** npm configuration (npm config files and the process environment) —
they do **not** see a `--registry` flag passed to the outer `npm publish`.

Consequences, and how we handle them:

- **Route via ambient config, not a CLI flag.** To keep every package on the
  same feed, set the registry through `.npmrc` or the `npm_config_registry`
  environment variable. `npm run publish:internal` does this for you (it sets
  `npm_config_registry` in the environment so the main and per-platform publishes
  agree). A plain `npm publish --registry <url>` would split packages across
  registries and is intentionally **not** how the internal script works.
- **`publishConfig.registry` is deliberately unset.** Do **not** add a
  `registry` to `publishConfig` in `package.json`: it would be inherited by every
  per-platform package and hard-wire the publish target, breaking the flexible
  public/internal split and interfering with auth. The current config only sets
  `access` and `provenance`.
- **Provenance is public-npm only.** [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  is generated via OIDC when publishing to `registry.npmjs.org`; Azure Artifacts
  does not support it. The internal path disables provenance
  (`publish:internal` sets `npm_config_provenance=false`); the public path keeps
  it on.
- **Scoped-package caveat.** Every package here is under the `@drasi` scope, so a
  scope mapping like `@drasi:registry=<url>` in an `.npmrc` would override the
  default registry for **all** `@drasi/*` packages — including a later public
  release — and silently reroute it. Prefer the plain `registry=` key in the
  example `.npmrc` templates, and remove any stray `.npmrc` before a public
  release. A real `.npmrc` is gitignored so it is never committed.

### Scripts

[`package.json`](../package.json) exposes explicit, single-purpose publish
scripts:

| Script                   | What it does                                                        |
| ------------------------ | ------------------------------------------------------------------- |
| `npm run pack:verify`    | `npm pack --dry-run` — inspect the main package's tarball contents. |
| `npm run publish:public` | `npm publish --access public` — publish to public npm (default).    |
| `npm run publish:internal` | Publish to an internal feed via `scripts/publish-internal.mjs`.   |

`publish:internal` requires a feed URL (`AZURE_ARTIFACTS_REGISTRY_URL` or
`--registry <url>`), refuses to run against `registry.npmjs.org`, and forwards
extra args (e.g. `-- --dry-run`, `-- --tag next`). Auth is **not** handled by the
script — authenticate to the feed out of band first.

### Example `.npmrc` templates

Two committed templates document the two targets — copy one to a real `.npmrc`
(gitignored) if you want to pin the registry locally:

- [`.npmrc.publish-public.example`](../.npmrc.publish-public.example)
- [`.npmrc.publish-internal.example`](../.npmrc.publish-internal.example)

You usually do **not** need a local `.npmrc` for public publishing — npm defaults
to the public registry.

### Runbook: public npm publish

This is the normal OSS release and is fully automated (see _The release
pipeline_ above): bump the version, update the changelog, and push a `vX.Y.Z`
tag. The `publish` job runs `npm publish --access public` with provenance. To
verify a build locally without publishing, use `npm run pack:verify`.

### Runbook: internal Azure Artifacts publish (optional)

Prerequisites (one-time, managed outside this repo):

1. An Azure Artifacts npm feed exists, with upstream sources configured so it can
   also serve public packages.
2. You have publish rights and are authenticated. Locally, e.g.:

   ```bash
   npx vsts-npm-auth -config .npmrc          # writes creds to your USER ~/.npmrc
   # (or add an _authToken / _password line to your USER-level ~/.npmrc)
   ```

To publish the **main** package to the feed from a local checkout:

```bash
export AZURE_ARTIFACTS_REGISTRY_URL="https://pkgs.dev.azure.com/ORG/PROJECT/_packaging/FEED/npm/registry/"
npm run build                 # produce index.js / index.d.ts first
npm run publish:internal -- --dry-run   # rehearse
npm run publish:internal
```

> **Note on per-platform packages locally.** A local checkout only has the
> `.node` binary for *your* platform, so a local `publish:internal` publishes the
> main package (and at most your platform's package). To publish **all**
> per-platform packages to the feed, use the CI job below, which assembles every
> prebuilt binary first.

In CI, prefer the optional `publish-internal` job in
[`release.yml`](../.github/workflows/release.yml): it downloads all build
artifacts, assembles the per-platform packages, and publishes them together to
the feed. Enable it either by running the **Release** workflow via
`workflow_dispatch` with `publish_internal = true`, or, for tag pushes, by
setting the repo/environment variable `ENABLE_INTERNAL_PUBLISH=true`. It requires:

- secret `AZURE_ARTIFACTS_TOKEN` — a PAT with publish rights to the feed
- variable `AZURE_ARTIFACTS_REGISTRY_URL` — the feed's npm registry URL

The public `publish` job is completely independent of this job.

### Recommended dual-publish sequence

1. **Verify** the package contents: `npm run pack:verify`.
2. **Publish to public npm** (push the `vX.Y.Z` tag) — this is the source of
   truth. Confirm it succeeded: `npm view @drasi/lib@X.Y.Z`.
3. **Optionally publish the same version internally** — run the **Release**
   workflow via `workflow_dispatch` with `publish_internal = true` (same commit /
   tag), or run `npm run publish:internal` locally.
4. **Verify availability in both locations** — `npm view @drasi/lib@X.Y.Z`
   against public npm, and an authenticated `npm view @drasi/lib@X.Y.Z
   --registry <feed>` against the internal feed.

Constraints and failure handling:

- **Versions must match.** Publish the *same* `X.Y.Z` to both targets; never fork
  version numbers between public and internal.
- **Duplicate publishes are rejected.** Re-publishing an existing version fails
  with "You cannot publish over the previously published versions." `napi
  prepublish` treats that as already-published and skips it, so re-running after a
  partial failure is safe and idempotent for packages that already landed.
- **If public succeeds but internal fails**, the release is still valid — public
  npm is the source of truth. Fix the feed/auth issue and re-run only the internal
  publish (it will skip anything already published). **Never** bump the version or
  re-publish to public just to satisfy the internal feed.
- **If internal succeeds but public fails**, treat the public publish as the
  blocker: resolve it and complete the public release; the internal copy already
  matches the intended version.

## First stable publish (team#95) — remaining human steps

**These require credentials/org access and an explicit go-ahead, and have _not_
been performed by the automation.** Do NOT run `npm publish` locally; the pipeline
does the publish once a tag is pushed. Before the first release a maintainer must:

1. **npm scope access.** Obtain publish rights to the `@drasi` npm organization/
   scope (the packages `@drasi/lib` and `@drasi/lib-*` publish under it). If the
   scope does not exist yet, create it on npmjs.com.
2. **Configure publish authentication — pick one:**
   - **Trusted Publisher (preferred).** In the npm package settings (or org
     settings for a first publish), add a trusted publisher pointing at
     `drasi-project/drasi-nodejs` and the `Release` workflow
     (`.github/workflows/release.yml`). No secret is then required.
     Requires npm CLI >= 11.5.1, which the workflow installs.
   - **`NPM_TOKEN` secret (fallback).** Create an **Automation** access token on
     npmjs.com with publish rights to the `@drasi` scope and add it as a
     repository secret named `NPM_TOKEN`
     (Settings -> Secrets and variables -> Actions).
3. **Choose the first stable version.** Recommended: `1.0.0`. Set it in
   `package.json` and `Cargo.toml`.
4. **Confirm the changelog** `[Unreleased]` entries describe the release, then roll
   them into the version section (see the routine checklist above).
5. **Cut the release** by pushing the tag — this is the point that actually
   publishes:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

6. **Verify** the main package and all five `@drasi/lib-*` platform packages
   appear on npm at the new version with provenance, and that a fresh
   `npm install @drasi/lib` on Windows/macOS/Linux works without Rust installed.

Until steps 1-2 are completed by a human and step 5 is explicitly authorized, no
publish will (or should) happen.
