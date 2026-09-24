import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { TaskError } from './task-error.js';
import { responseSchemaSchema, valueProjectionSchema } from './response-contract.js';
import { assertGenericJsonPlanSafety, type GenericJsonPlan } from './generic-network.js';
import { regularFileContents, acquireWorkflowFileLock } from './workflow-file-lock.js';
import { pageReplaySchema } from './page-replay.js';
import { javascriptTaskSchema } from './javascript-task.js';
import { assertCompiledProgramBinding } from './compiled-program.js';
import { authorizedNetworkOrigins, assertTaskResourceScope } from './task-network-scope.js';

export const taskDefinitionSchema = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  startUrl: z.string().url().refine(value => { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }),
  goal: z.string().min(1).max(8000),
  inputSchema: responseSchemaSchema.refine(schema => schema.type === 'object' &&
    !Object.keys(schema.properties ?? {}).some(key => /password|secret|token|cookie|session|authorization|api.?key/i.test(key)), 'Use an object input schema without credential fields.'),
  outputSchema: responseSchemaSchema,
  effect: z.literal('read'),
  allowedNetworkOrigins:z.array(z.string()).max(8).optional(),
}).strict().refine(value=>{try{authorizedNetworkOrigins(value);return true;}catch{return false;}},'Invalid API origin authorization.');
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
const networkSchema = z.custom<GenericJsonPlan>(value => { try { assertGenericJsonPlanSafety(value as GenericJsonPlan); return true; } catch { return false; } });
export const savedTaskSchema = z.object({
  formatVersion: z.literal('clapping-hands/task-v2'),
  definition: taskDefinitionSchema,
  accelerator: z.object({ plan: networkSchema, projection: valueProjectionSchema }).strict().nullable(),
  executionPolicy:z.enum(['return-control','delegate']).optional(),
  callerEvidenceIds:z.array(z.string().regex(/^[0-9]+-[a-f0-9-]{36}$/)).max(2).optional(),
  pageAccelerator: pageReplaySchema.optional(),
  javascriptAccelerator: javascriptTaskSchema.optional(),
  pendingJavascriptAccelerator: javascriptTaskSchema.optional(),
  compilationEvidenceId:z.string().regex(/^[0-9]+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).optional(),
}).strict().superRefine((value, ctx) => {
  for(const accelerator of [value.javascriptAccelerator,value.pendingJavascriptAccelerator])if(accelerator){
    try{
      assertCompiledProgramBinding(accelerator.program,value.definition,accelerator.resources);
      for(const resource of accelerator.resources)assertTaskResourceScope(value.definition,resource.plan);
    }catch{ctx.addIssue({code:'custom',message:'Mismatched generated accelerator.'});}
  }
  if(value.pendingJavascriptAccelerator && value.pendingJavascriptAccelerator.program.status!=='candidate')ctx.addIssue({code:'custom',message:'Pending program must be an unpromoted candidate.'});
  const plan = value.accelerator?.plan;
  if (value.pageAccelerator && (value.pageAccelerator.origin !== new URL(value.definition.startUrl).origin
    || value.definition.outputSchema.type !== 'string' || !value.definition.inputSchema.properties?.[value.pageAccelerator.inputName])) {
    ctx.addIssue({ code: 'custom', message: 'Mismatched page accelerator.' });
  }
  if (plan && (plan.action !== value.definition.action || plan.origin !== new URL(value.definition.startUrl).origin ||
    (plan.request.endpointOrigin && plan.request.endpointOrigin !== plan.origin) || plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length)) {
    ctx.addIssue({ code: 'custom', message: 'Unsupported or mismatched accelerator.' });
  }
});
export type SavedTask = z.infer<typeof savedTaskSchema>;

export class TaskStore {
  constructor(readonly directory: string) {}
  private path(action: string) {
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(action)) throw new TaskError('invalid-action');
    return resolve(this.directory, action+'.json');
  }
  async load(action: string): Promise<SavedTask | null> {
    const raw = await regularFileContents(this.path(action), 2_000_000);
    if (raw === null) return null;
    const task = savedTaskSchema.parse(JSON.parse(raw));
    if (task.definition.action !== action) throw new Error('Stored task identity mismatch.');
    return task;
  }
  async save(task: SavedTask, expected?:SavedTask|null) {
    const checked = savedTaskSchema.parse(task);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(checked.definition.action);
    const temp = destination+'.'+randomUUID()+'.tmp';
    const lease = await acquireWorkflowFileLock(destination+'.lock');
    try {
      // Never follow or silently overwrite a non-regular destination.
      const current=await regularFileContents(destination, 2_000_000);
      if((expected===null && current!==null) || (expected && (current===null || !isDeepStrictEqual(savedTaskSchema.parse(JSON.parse(current)),expected)))){
        throw new Error('Task changed while compiling; existing task was preserved.');
      }
      await writeFile(temp, JSON.stringify(checked), { mode: 0o600, flag: 'wx' });
      await lease.assertOwned();
      await rename(temp, destination);
    } finally { await lease.release(); }
  }
  async list(): Promise<SavedTask[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tasks: SavedTask[] = [];
    for (const file of await readdir(this.directory)) {
      if (/^[a-z][a-z0-9_]{1,62}\.json$/.test(file)) {
        const task = await this.load(file.slice(0, -5));
        if (task) tasks.push(task);
      }
    }
    return tasks;
  }
}
