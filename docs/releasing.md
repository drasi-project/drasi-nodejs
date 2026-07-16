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
