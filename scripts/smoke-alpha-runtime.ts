import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { TaskRuntime } from '../src/task-runtime.js';
import type { TaskDefinition } from '../src/task-store.js';

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://fixture');
  if (url.pathname === '/search') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ title: 'Result for '+url.searchParams.get('q') }));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><h1>Catalog</h1><label>Search <input id="q"></label><button onclick="fetch(\'/search?q=\'+encodeURIComponent(document.getElementById(\'q\').value)).then(r=>r.json()).then(r=>document.getElementById(\'result\').textContent=r.title)">Search</button><h2 id="result">No results yet</h2></body></html>');
  }
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('fixture address');
const directory = await mkdtemp(join(tmpdir(), 'clappinghands-alpha-runtime-'));
const definition: TaskDefinition = { action: 'fixture_search', startUrl: 'http://127.0.0.1:'+address.port+'/',
  goal: 'Search for query using the input and button; return the exact displayed result title.', effect: 'read',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, outputSchema: { type: 'string' } };
try {
  let runtime = new TaskRuntime(directory);
  const learned = await runtime.learn(definition, [{ query: 'alpha' }, { query: 'beta' }]);
  assert.equal(learned.registered, true);
  assert.ok(learned.task?.javascriptAccelerator);
  console.log(JSON.stringify({ phase: 'learn', passed: true, compilation: learned.task.javascriptAccelerator.program.status }));
  for (const query of ['gamma','delta']) {
    const result = await runtime.run(definition.action, { query });
    assert.deepEqual(result.outcome, { status: 'completed', data: 'Result for '+query });
    assert.equal(result.shadowMatch, true);
    console.log(JSON.stringify({ phase: 'held-out-shadow', query, passed: true }));
  }
  await runtime.close();runtime = new TaskRuntime(directory);
  const result = await runtime.run(definition.action, { query: 'epsilon' });
  assert.equal(result.engine, 'network');
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(result.outcome, { status: 'completed', data: 'Result for epsilon' });
  console.log(JSON.stringify({ phase: 'restart-network', passed: true, durationMs: result.durationMs }));
  await runtime.close();
} catch (error) {
  console.log(JSON.stringify({ passed: false, category: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
