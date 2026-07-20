# Changelog

All notable changes to `@drasi/lib` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [`docs/releasing.md`](./docs/releasing.md) for the versioning policy and the
release process.

## [Unreleased]

## [0.2.0] - 2026-07-20

### Added

- **Schema discovery** — `getSourceSchema(id)` and `getGraphSchema()` expose the
  source & graph schema discovery API
  ([drasi-core#416](https://github.com/drasi-project/drasi-core/pull/416)): the
  graph shape (node/relation labels, properties, and type hints) that sources
  report, and a merged view across sources and queries. Distinct from the
  plugin-config schema accessors. Foundation for inspection, validation, and
  LLM/MCP tooling.
- **Plugin signature verification (G5)** — `pullPlugin(ref, options?)` now accepts
  opt-in cosign options (`verify`, `requireSigned`, `trustedIdentities`). When
  enabled, artifacts that are tampered, unsigned-when-required, or signed by an
  untrusted identity are deleted and rejected with `PLUGIN_SIGNATURE_INVALID`.
  The trusted-identity allowlist is enforced and defaults to the drasi-project
  GitHub identity.
- **Persistent index store (G6)** — the `indexStore: { kind: 'rocksdb', path, … }`
  create option backs query indexes and the reaction outbox with RocksDB instead
  of in-memory storage. Adds error codes `UNKNOWN_INDEX_STORE_KIND` and
  `INDEX_STORE_PATH_REQUIRED`.
- **Durable JavaScript reactions (G7)** — `addDurableJsReaction(...)` awaits an
  async callback and checkpoints the result per query, so results that were not
  yet checkpointed are recovered (and de-duplicated) after a crash or restart.
  Requires a durable state store; otherwise throws `DURABLE_REQUIRES_STATE_STORE`.
  (Per-event at-least-once delivery on handler failure is tracked in
  [#21](https://github.com/drasi-project/drasi-nodejs/issues/21).)
- **Built-in identity providers (G8)** — the `identity: { kind: 'password' |
  'token', … }` create option injects credentials via a built-in provider. Adds
  error codes `UNKNOWN_IDENTITY_KIND`, `IDENTITY_KIND_REQUIRED`, and
  `IDENTITY_CONFIG_INVALID`.
- **Config-schema accessors (G9)** — `sourceConfigSchema(kind)`,
  `reactionConfigSchema(kind)`, and `bootstrapConfigSchema(kind)` expose the
  JSON-schema a plugin declares for its configuration. Invalid input throws
  `CONFIG_INVALID`.
- **Query-language validation (G10)** — the query language is now validated;
  values other than `cypher`/`gql` throw `UNKNOWN_QUERY_LANGUAGE` across
  `addQuery`, `updateQuery`, and `fromConfig`.

### Changed

- **Breaking:** `pullPlugin(...).verification` is now a structured object
  (`{ status, issuer?, subject?, reason? }`) instead of a string, so callers can
  inspect the signature outcome programmatically.

## [0.1.1] - 2026-07-17

### Added

- Concrete public TypeScript types: the generated `index.d.ts` is now
  self-contained, with concrete config/result/callback shapes instead of `any`.
  The companion `types.d.ts` has been removed.
- Typed error codes via the `DrasiErrorCode` enum. Argument-validation errors
  throw synchronously with a stable, machine-readable `err.code`; async/engine
  errors carry the stable code as a `[CODE]` token in the message.
- `SourceChangeInput.op` type and the related validation messages now document
  the `add`/`remove` aliases the parser accepts.
- Rust unit tests for the pure conversion/error logic plus a `cargo-llvm-cov`
  coverage gate in CI, and expanded error/edge and leak/soak integration tests.

### Note

- These changes were intended for `0.1.0` but were omitted because the source
  PRs merged into their stacked parent branches rather than `main`. `0.1.1`
  delivers them.

## [0.1.0] - 2026-07-16

### Added

- Initial public release of `@drasi/lib` — embed the Drasi continuous-query
  engine in Node.js, with dynamic cdylib plugin loading and JavaScript-defined
  sources and reactions.
- Cross-platform prebuilt binaries. The native addon is built in CI for the four
  declared `napi.targets` (`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`,
  `aarch64-unknown-linux-gnu`, `aarch64-apple-darwin`) and distributed as
  per-platform optional-dependency packages (`@drasi/lib-<platform>`), so
  consumers install without a Rust toolchain. Intel macOS (`x86_64-apple-darwin`)
  is not prebuilt; those users build from source.
- Concrete public TypeScript types (self-contained `index.d.ts`) and stable
  machine-readable error codes (`DrasiErrorCode`).
- Tag-triggered npm release pipeline (`.github/workflows/release.yml`) that
  rebuilds every target and publishes the main package plus all per-platform
  packages with npm build provenance (OIDC-first, `NPM_TOKEN` fallback).
- Maintainer release guide (`docs/releasing.md`) and this changelog.

[Unreleased]: https://github.com/drasi-project/drasi-nodejs/compare/v0.2.0...main
[0.2.0]: https://github.com/drasi-project/drasi-nodejs/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/drasi-project/drasi-nodejs/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drasi-project/drasi-nodejs/releases/tag/v0.1.0
