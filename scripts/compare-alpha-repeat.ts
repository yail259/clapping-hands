/** Benchmark-only same-input comparison; never imported by the runtime. */
import { TaskRuntime } from '../src/task-runtime.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const [directory, action, encodedInput] = process.argv.slice(2);
if (!directory || !action || !encodedInput) throw new Error('Supply task directory, action and public benchmark input JSON.');
const runtime = new TaskRuntime(directory);
try {
  const saved = await runtime.store.load(action);
  if (!saved) throw new Error('Unknown benchmark task.');
  const baselineAction = action+'_comparison';
  await runtime.store.save({ formatVersion: saved.formatVersion, definition: { ...saved.definition, action: baselineAction }, accelerator: null });
  const input = JSON.parse(encodedInput);
  const start = performance.now();
  const baseline = await runtime.run(baselineAction, input);
  const baselineWallMs = performance.now()-start;
  const next = performance.now();
  const accelerated = await runtime.run(action, input);
  const acceleratedWallMs = performance.now()-next;
  const exact = baseline.outcome.status === 'completed' && accelerated.outcome.status === 'completed'
    && isDeepStrictEqual(baseline.outcome.data, accelerated.outcome.data);
  const report = { action, input, baseline, baselineWallMs, accelerated, acceleratedWallMs, exact,
    speedup: exact && accelerated.engine !== 'browser-use' ? baselineWallMs / acceleratedWallMs : null };
  const folder = resolve('bench/runs', new Date().toISOString().slice(0,10));
  await mkdir(folder, { recursive: true });
  const path = resolve(folder, 'same-input-'+Date.now()+'-'+action+'.json');
  await writeFile(path, JSON.stringify(report,null,2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ path, exact, engine: accelerated.engine, baselineWallMs, acceleratedWallMs, speedup: report.speedup }));
} finally { await runtime.close(); }
