import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assertResponseValue, type JsonValue, type ResponseSchema } from './response-contract.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from './generated-js.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bundleId = z.string().regex(/^[0-9]+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

/** Object insertion order is not a new input or a new contract. Array order is. */
export function programDigest(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export const compiledProgramSchema = z.object({
  formatVersion: z.literal('clapping-hands/javascript-v1'),
  source: z.string().min(1).max(64000),
  sourceHash: digest,
  contractHash: digest,
  resourcesHash: digest,
  status: z.enum(['candidate', 'stable', 'degraded']),
  trainingInputHashes: z.array(digest).min(1).max(16),
  matchedInputHashes: z.array(digest).max(32),
  evidenceIds: z.array(bundleId).min(1).max(128),
  failures: z.number().int().nonnegative(),
}).strict().superRefine((p, ctx) => {
  if (p.sourceHash !== programDigest(p.source)) ctx.addIssue({code:'custom',message:'Generated source integrity mismatch.'});
  if (p.status === 'stable' && (p.failures !== 0 || heldOutCount(p) < 2)) {
    ctx.addIssue({code:'custom',message:'Generated program lacks independent held-out evidence.'});
  }
  if (p.failures > 0 && p.status !== 'degraded') ctx.addIssue({code:'custom',message:'Failed program must remain degraded.'});
});
export type CompiledProgram = z.infer<typeof compiledProgramSchema>;

function heldOutCount(program: {trainingInputHashes: string[]; matchedInputHashes: string[]}) {
  const training = new Set(program.trainingInputHashes);
  return new Set(program.matchedInputHashes.filter(h => !training.has(h))).size;
}

export function createCompiledProgram(source: string, contract: unknown, resources: unknown, trainingInputs: JsonValue[], evidenceIds: string[]): CompiledProgram {
  return compiledProgramSchema.parse({formatVersion:'clapping-hands/javascript-v1',source,sourceHash:programDigest(source),
    contractHash:programDigest(contract),resourcesHash:programDigest(resources),status:'candidate',
    trainingInputHashes:[...new Set(trainingInputs.map(programDigest))],matchedInputHashes:[],evidenceIds,failures:0});
}

/** Integrity is accidental-corruption detection, not a signature against a local
 * attacker. Runtime authority must still be reconstructed by the trusted broker. */
export function assertCompiledProgramBinding(program: CompiledProgram, contract: unknown, resources: unknown) {
  compiledProgramSchema.parse(program);
  if (program.contractHash !== programDigest(contract) || program.resourcesHash !== programDigest(resources)) {
    throw new Error('Generated program contract or resource binding changed.');
  }
}

export function degradeCompiledProgram(program: CompiledProgram): CompiledProgram {
  return compiledProgramSchema.parse({...program,status:'degraded',failures:program.failures+1});
}

/** The host compares fresh results; the model cannot supply a "passed" flag.
 * A failed generation is never repaired by accumulating later matching inputs. */
export function recordCompiledComparison(program: CompiledProgram, input: JsonValue, actual: unknown, expected: unknown,
  outputSchema: ResponseSchema, evidenceId: string): CompiledProgram {
  compiledProgramSchema.parse(program);
  bundleId.parse(evidenceId);
  let match = false;
  try { assertResponseValue(outputSchema, actual); assertResponseValue(outputSchema, expected); match = isDeepStrictEqual(actual, expected); }
  catch { /* Shape failures are mismatches, not successful comparisons. */ }
  const evidenceIds = [...new Set([...program.evidenceIds,evidenceId])];
  if (program.status === 'degraded') return compiledProgramSchema.parse({...program,evidenceIds});
  if (!match) return compiledProgramSchema.parse({...degradeCompiledProgram(program),evidenceIds});
  const matchedInputHashes = [...new Set([...program.matchedInputHashes,programDigest(input)])];
  return compiledProgramSchema.parse({...program,matchedInputHashes,evidenceIds,
    status:heldOutCount({...program,matchedInputHashes}) >= 2 ? 'stable' : 'candidate'});
}

/** Candidates may execute only for host-side comparison; callers must not return
 * their output as the task result until the persisted promotion checks pass. */
export async function executeCompiledProgram(program: CompiledProgram, contract: unknown, resources: unknown,
  input: JsonValue, outputSchema: ResponseSchema, broker: GeneratedBroker, options: {signal?:AbortSignal;shadow?:boolean} = {}) {
  assertCompiledProgramBinding(program,contract,resources);
  if (program.status === 'degraded' || (program.status !== 'stable' && !options.shadow)) throw new Error('Generated program is not promoted.');
  const result = await executeGeneratedJavaScript(program.source,input,outputSchema,broker,{signal:options.signal});
  if (result.requests === 0) throw new Error('Generated program did not request fresh data.');
  return result;
}
