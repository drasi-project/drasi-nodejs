// Build the example Drasi plugins (mock source + log reaction) used by the test
// suite and stage them in `plugins/`. The plugin crates are fetched from
// crates.io at versions whose `drasi-plugin-sdk` matches the `drasi-host-sdk`
// this addon links against, so the host and plugins share a compatible plugin-SDK
// / FFI ABI without needing a local `drasi-core` checkout.
//
// Runs as the npm `pretest` step; the built binaries are gitignored.
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
// cdylib filenames are unprefixed on Windows, `lib`-prefixed on Unix.
const prefix = process.platform === 'win32' ? '' : 'lib';

// [crate name, published version, compiled cdylib basename]. The versions must
// depend on `drasi-plugin-sdk` ^0.10 to stay ABI-compatible with the host's
// `drasi-host-sdk` (see Cargo.toml). Bump these together when upgrading the SDK.
const plugins = [
  ['drasi-source-mock', '0.2.7', 'drasi_source_mock'],
  ['drasi-reaction-log', '0.2.5', 'drasi_reaction_log'],
];

const outDir = join(root, 'plugins');
mkdirSync(outDir, { recursive: true });

// Cache crate sources + build artifacts under `target/` (gitignored). A shared
// CARGO_TARGET_DIR lets the two plugins reuse compiled dependencies.
const workDir = join(root, 'target', 'plugin-src');
const sharedTarget = join(root, 'target', 'plugin-build');
mkdirSync(workDir, { recursive: true });

const buildEnv = { ...process.env, CARGO_TARGET_DIR: sharedTarget };

// crates.io's data-access policy requires a descriptive User-Agent on downloads.
const userAgent = 'drasi-nodejs-build-plugins (https://github.com/drasi-project/drasi-nodejs)';

for (const [pkg, version, file] of plugins) {
  const srcDir = join(workDir, `${pkg}-${version}`);
  if (!existsSync(join(srcDir, 'Cargo.toml'))) {
    console.log(`[build-plugins] fetching ${pkg} ${version} from crates.io`);
    const url = `https://static.crates.io/crates/${pkg}/${pkg}-${version}.crate`;
    const tarball = join(workDir, `${pkg}-${version}.crate`);
    execSync(`curl -sSL -A "${userAgent}" "${url}" -o "${tarball}"`, { stdio: 'inherit' });
    // The .crate tarball extracts to `${pkg}-${version}/`.
    execSync(`tar -xzf "${tarball}" -C "${workDir}"`, { stdio: 'inherit' });
  }

  console.log(`[build-plugins] building ${pkg} ${version}`);
  execSync('cargo build --features dynamic-plugin', { cwd: srcDir, stdio: 'inherit', env: buildEnv });

  const name = `${prefix}${file}.${ext}`;
  copyFileSync(join(sharedTarget, 'debug', name), join(outDir, name));
  console.log(`[build-plugins] staged plugins/${name}`);
}
