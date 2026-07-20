# Changelog

All notable changes to `@drasi/lib` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [`docs/releasing.md`](./docs/releasing.md) for the versioning policy and the
release process.

## [Unreleased]

### Added

- `addDurableJsReaction` now supports a per-event error policy for true per-event
  at-least-once delivery (issue #21). `options.onError` selects `'retry'` (the new
  default — re-invoke the callback with exponential backoff until it resolves so the
  checkpoint never advances past a failed event), `'halt'` (stop the reaction without
  advancing), or `'skip'` (the previous stock behavior: log and move on, at-most-once).
  Tunable via `maxRetries`, `retryDelayMs`, and `maxRetryDelayMs`.

### Changed

- The default behavior of `addDurableJsReaction` on a rejected callback changed from
  skip-and-continue to `retry`. This is a strictly stronger delivery guarantee; pass
  `{ onError: 'skip' }` to restore the previous behavior.

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

[Unreleased]: https://github.com/drasi-project/drasi-nodejs/compare/v0.1.1...main
[0.1.1]: https://github.com/drasi-project/drasi-nodejs/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drasi-project/drasi-nodejs/releases/tag/v0.1.0
