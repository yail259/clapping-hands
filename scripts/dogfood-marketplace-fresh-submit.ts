import { readFile } from 'node:fs/promises';
import { TaskRuntime } from '../src/task-runtime.js';

const runtime = new TaskRuntime();
try {
  const action = 'marketplace_fresh_search_cards_v1';
  const task = await runtime.store.load(action);
  if (!task?.compilationEvidenceId) throw new Error('Marketplace compilation evidence is missing.');
  if (task.javascriptAccelerator?.program.status === 'stable' || task.pendingJavascriptAccelerator)
    throw new Error('A stable or staged program already exists; do not replace it from this one-off dogfood script.');
  const source = await readFile(new URL('./dogfood-marketplace-candidate.js', import.meta.url), 'utf8');
  const result = await runtime.submitCandidate(action, task.compilationEvidenceId, source);
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  await runtime.close();
}
