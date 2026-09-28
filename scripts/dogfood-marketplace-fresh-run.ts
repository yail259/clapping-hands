import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TaskRuntime } from '../src/task-runtime.js';

const query = process.argv.slice(2).join(' ').trim();
if (!query) throw new Error('Supply a Marketplace search term.');
const runtime = new TaskRuntime();
try {
  const result = await runtime.run('marketplace_fresh_search_cards_v1', { query });
  if (result.outcome.status !== 'completed') throw new Error(`Search ended: ${result.outcome.status}`);
  const cards = result.outcome.data as Array<{title:string;priceAud:number;previousPriceAud:number|null;location:string;url:string}>;
  const folder = resolve('.data/deal-searches/fresh');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = resolve(folder, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  await writeFile(file, JSON.stringify({ query, observedAt: new Date().toISOString(), result, cards }, null, 2), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ query, count: cards.length, engine: result.engine, durationMs: result.durationMs,
    wallDurationMs: result.wallDurationMs, modelCalls: result.modelCalls, fallback: result.fallback,
    sample: cards.slice(0, 5), saved: file }) + '\n');
} finally {
  await runtime.close();
}
