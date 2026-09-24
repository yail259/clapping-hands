import { rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Only the explicitly configured generated output is disposable. A clean emit
// prevents removed legacy modules surviving in the published package.
const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('tsconfig.json', root), 'utf8'));
if (config.compilerOptions.outDir !== 'dist-alpha') throw new Error('Review clean-build output directory.');
await rm(new URL('dist-alpha/', root), { recursive: true, force: true });
const result = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '-p', 'tsconfig.json'],
  { cwd: fileURLToPath(root), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
