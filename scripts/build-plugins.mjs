// Build the example Drasi plugins (mock source + log reaction) from the sibling
// `../drasi-core` checkout and stage them in `plugins/` for the test suite.
// Runs as the npm `pretest` step so the binaries are never committed.
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(root, '..', 'drasi-core');

const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
// cdylib filenames are unprefixed on Windows, `lib`-prefixed on Unix.
const prefix = process.platform === 'win32' ? '' : 'lib';

const plugins = [
  ['drasi-source-mock', 'drasi_source_mock'],
  ['drasi-reaction-log', 'drasi_reaction_log'],
];

mkdirSync(join(root, 'plugins'), { recursive: true });

for (const [pkg, file] of plugins) {
  console.log(`[build-plugins] building ${pkg}`);
  execSync(`cargo build -p ${pkg} --features dynamic-plugin`, { cwd: core, stdio: 'inherit' });
  const name = `${prefix}${file}.${ext}`;
  copyFileSync(join(core, 'target', 'debug', name), join(root, 'plugins', name));
  console.log(`[build-plugins] staged plugins/${name}`);
}
