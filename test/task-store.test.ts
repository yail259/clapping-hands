import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, taskDefinitionSchema, type SavedTask } from '../src/task-store.js';
const saved: SavedTask = { formatVersion: 'clapping-hands/task-v2', accelerator: null,
  definition: { action: 'read_title', startUrl: 'https://example.com/', goal: 'Read title', effect: 'read',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, outputSchema: { type: 'string' } } };
test('recipe-free task contract survives store restart without cached result data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-store-'));
  await new TaskStore(dir).save(saved);
  assert.deepEqual(await new TaskStore(dir).load('read_title'), saved);
  assert.deepEqual(await new TaskStore(dir).list(), [saved]);
  assert.equal((await readFile(join(dir,'read_title.json'),'utf8')).includes('data'), false);
});
test('corrupt plans and legacy format are not interpreted as runnable tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-corrupt-'));
  await writeFile(join(dir,'read_title.json'), '{broken');
  await assert.rejects(new TaskStore(dir).load('read_title'));
  await writeFile(join(dir,'read_title.json'), JSON.stringify({ ...saved, formatVersion: 'clapping-hands.dev/workflow-v1' }));
  await assert.rejects(new TaskStore(dir).load('read_title'));
});
test('task store refuses symlinks and traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-path-'));
  await writeFile(join(dir,'outside'), 'unchanged');
  await symlink(join(dir,'outside'), join(dir,'read_title.json'));
  await assert.rejects(new TaskStore(dir).save(saved));
  await assert.rejects(new TaskStore(dir).load('../outside'));
  assert.equal(await readFile(join(dir,'outside'),'utf8'), 'unchanged');
});
test('credentials and writes are not admitted to persisted task definitions', () => {
  assert.throws(() => taskDefinitionSchema.parse({ ...saved.definition, effect: 'write' }));
  assert.throws(() => taskDefinitionSchema.parse({ ...saved.definition, startUrl: 'https://example.com/?token=secret' }));
  assert.throws(() => taskDefinitionSchema.parse({ ...saved.definition, inputSchema: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'], additionalProperties: false } }));
});
test('conditional save preserves concurrent changes instead of reviving stale compiled state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'alpha-compare-save-'));
  const store=new TaskStore(dir);await store.save(saved);
  const old=await store.load('read_title');assert.ok(old);
  const changed={...saved,definition:{...saved.definition,goal:'Updated task meaning'}};
  await store.save(changed);
  await assert.rejects(store.save(saved,old),/Task changed/);
  assert.deepEqual(await store.load('read_title'),changed);
});
