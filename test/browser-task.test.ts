import test from 'node:test';
import assert from 'node:assert/strict';
import { executeReadTask, parseBrowserTaskOutcome, type BrowserTask } from '../src/browser-task.js';
import { runBrowserUseTask } from '../src/browser-use-task.js';
import { fileURLToPath } from 'node:url';

const task: BrowserTask = { startUrl: 'https://example.com/', goal: 'Read the title', effect: 'read', input: {},
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  outputSchema: { type: 'string' } };

test('baseline completion needs no compiled recipe', async () => {
  const result = await executeReadTask(task, async () => ({ status: 'completed', data: 'Title' }));
  assert.deepEqual(result, { outcome: { status: 'completed', data: 'Title' }, engine: 'browser-use', fallback: false });
});
test('warm compiled execution avoids the baseline', async () => {
  const result = await executeReadTask(task, async () => { throw new Error('must not run'); }, async () => 'Title');
  assert.equal(result.engine, 'compiled');
});
test('invalid compiled output falls back exactly once', async () => {
  let calls = 0;
  const result = await executeReadTask(task, async () => { calls++; return { status: 'access-restricted' }; }, async () => 42);
  assert.equal(calls, 1);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.outcome, { status: 'access-restricted' });
});
test('SDK completion flag is not a task result', () => {
  assert.throws(() => parseBrowserTaskOutcome({ success: true, value: 'Access denied' }, task.outputSchema));
  assert.throws(() => parseBrowserTaskOutcome({ status: 'completed', data: 42 }, task.outputSchema));
  assert.throws(() => parseBrowserTaskOutcome({ status: 'failed', data: 'secret error' }, task.outputSchema));
});
test('writes are rejected before either execution path', async () => {
  await assert.rejects(executeReadTask({ ...task, effect: 'write' as 'read' }, async () => { throw new Error('called'); }));
});
test('worker rejects remote CDP before spawning', async () => {
  await assert.rejects(runBrowserUseTask(task, { python: '/not-executed', cdpUrl: 'http://example.com:9222',
    allowedOrigins: ['https://example.com'], model: 'test', apiKey: 'test', baseURL: 'https://example.com/v1' }));
});
const workerOptions = { python: process.execPath, workerPath: fileURLToPath(new URL('./fixtures/browser-task-worker.mjs', import.meta.url)),
  cdpUrl: 'http://127.0.0.1:9222', allowedOrigins: ['https://example.com'], model: 'test', apiKey: 'test', baseURL: 'https://example.com/v1' };
test('worker protocol is isolated from library stdout', async () => {
  assert.deepEqual(await runBrowserUseTask(task, workerOptions), { status: 'completed', data: 'Title' });
});
test('hung worker is killed by host deadline', async () => {
  assert.deepEqual(await runBrowserUseTask({ ...task, goal: 'hang' }, { ...workerOptions, timeoutMs: 100 }), { status: 'timeout' });
});
test('malformed worker protocol fails safely', async () => {
  assert.deepEqual(await runBrowserUseTask({ ...task, goal: 'malformed' }, workerOptions), { status: 'failed' });
});
test('passive action evidence is separate from completion and tolerates observer errors', async () => {
  const events:unknown[]=[];
  const result=await runBrowserUseTask({...task,goal:'evidence'},{...workerOptions,onEvidence:event=>{events.push(event);throw new Error('observer failed');}});
  assert.equal(result.status,'completed');assert.equal(events.length,1);
  const malformed:unknown[]=[];
  assert.equal((await runBrowserUseTask({...task,goal:'bad evidence'},{...workerOptions,onEvidence:event=>malformed.push(event)})).status,'completed');
  assert.deepEqual(malformed,[{kind:'evidence-omitted',reason:'invalid-worker-event'}]);
});
