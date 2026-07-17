# Contributing to `@drasi/lib`

Drasi is a [CNCF Sandbox project](https://www.cncf.io/projects/drasi/), and we
welcome contributions from the community. This guide covers what's specific to
**`@drasi/lib`** — the Node.js bindings for the embeddable Drasi engine. For the
project-wide contribution guidelines, see the
[drasi-project CONTRIBUTING guide](https://github.com/drasi-project/.github/blob/main/CONTRIBUTING.md).

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

- Check the [open issues](https://github.com/drasi-project/drasi-nodejs/issues)
  or open one to discuss your change. For anything beyond a trivial fix, please
  align with the maintainers on the approach before writing code.
- New to the project? Look for
  [`good first issue`](https://github.com/drasi-project/drasi-nodejs/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  labels.

## Prerequisites

This package builds a native addon ([napi-rs](https://napi.rs)), so you need
both a Node.js and a Rust toolchain:

- **Node.js** >= 18 (CI builds on 20; the release/publish job uses 24).
- **Rust** (stable) with `cargo` and `clippy` — install via [rustup](https://rustup.rs).

The Drasi engine and plugin host SDK are consumed from crates.io, so no sibling
checkout is required.

## Development workflow

```bash
npm install          # install JS dev dependencies (@napi-rs/cli)
npm run build        # napi build -> index.js, index.d.ts, and the .node addon
npm test             # pretest builds example plugins from crates.io, then runs the suite
```

Useful checks (all are enforced in CI):

```bash
cargo clippy -- -D warnings    # Rust lint (must be clean)
npm run test:types             # type-check the generated index.d.ts (tsc --strict --isolatedModules)
cargo test --features test-dyn # Rust unit tests for the pure conversion/error logic
```

Notes:

- `index.js`, `index.d.ts`, `*.node`, and `/plugins` are **build artifacts** and
  are gitignored — never commit them.
- Some tests hit the public OCI registry and are opt-in: `DRASI_OCI_TESTS=1`.
  The heavier resource-leak/soak tests are opt-in via `DRASI_SOAK_TESTS=1`.
- See [`docs/api-reference.md`](./docs/api-reference.md) for the public API and
  [`docs/releasing.md`](./docs/releasing.md) for how releases are cut.

## Pull requests

1. Fork the repo and create a feature branch from `main`.
2. Make your change, keeping it focused; add or update tests.
3. Ensure the full check set above passes locally.
4. **Sign off every commit** (DCO — see below).
5. Open a PR, link the related issue, and describe your change. CI must be green
   (build/test on Windows, macOS, and Linux, plus the coverage gate and DCO check).

## Developer Certificate of Origin (DCO)

All commits **must** be signed off. The project follows the
[Developer Certificate of Origin](https://developercertificate.org/): a
lightweight way to certify that you wrote, or have the right to submit, the code
you're contributing. Add a `Signed-off-by` trailer to each commit:

```
Signed-off-by: Random J Developer <random@developer.example.org>
```

Git appends this automatically with the `-s` flag:

```bash
git commit -s -m "Your commit message"
```

The **DCO check is required** and will fail the PR if any commit is missing a
sign-off. VS Code's `git.alwaysSignOff` setting can add it automatically.

## Community

- [Discord](https://aka.ms/drasidiscord) — chat with maintainers and the community
- [Documentation](https://drasi.io)
