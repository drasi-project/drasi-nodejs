# Changelog

All notable changes to `@drasi/lib` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [`docs/releasing.md`](./docs/releasing.md) for the versioning policy and the
release process.

## [Unreleased]

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

[Unreleased]: https://github.com/drasi-project/drasi-nodejs/compare/v0.1.0...main
[0.1.0]: https://github.com/drasi-project/drasi-nodejs/releases/tag/v0.1.0
