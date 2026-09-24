import { assertResponseValue, responseSchemaSchema, type JsonValue, type ResponseSchema } from './response-contract.js';

/** Whole-task contract. No provider actions or replay recipes cross this boundary. */
export type BrowserTask = {
  startUrl: string;
  goal: string;
  input: JsonValue;
  inputSchema: ResponseSchema;
  outputSchema: ResponseSchema;
  effect: 'read';
};
export type BrowserTaskFailure = 'authentication-required' | 'access-restricted' | 'timeout' | 'failed';
export type BrowserTaskOutcome =
  | { status: 'completed'; data: JsonValue }
  | { status: BrowserTaskFailure };

export function validateBrowserTask(task: BrowserTask): void {
  const url = new URL(task.startUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || task.effect !== 'read' || !task.goal.trim()) {
    throw new Error('Invalid read-only browser task.');
  }
  responseSchemaSchema.parse(task.inputSchema);
  responseSchemaSchema.parse(task.outputSchema);
  assertResponseValue(task.inputSchema, task.input);
}

/** Structured status is mandatory; an SDK "done" flag is insufficient. */
export function parseBrowserTaskOutcome(value: unknown, schema: ResponseSchema): BrowserTaskOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser task outcome.');
  const result = value as Record<string, unknown>;
  if (result.status === 'completed') {
    if (Object.keys(result).some(key => !['status', 'data'].includes(key))) throw new Error('Invalid browser task outcome.');
    return { status: 'completed', data: assertResponseValue(schema, result.data) };
  }
  if (['authentication-required', 'access-restricted', 'timeout', 'failed'].includes(String(result.status)) && Object.keys(result).length === 1) {
    return { status: result.status as BrowserTaskFailure };
  }
  throw new Error('Invalid browser task outcome.');
}

/** Compiled operations are admitted/validated elsewhere. No repair loop here. */
export async function executeReadTask(
  task: BrowserTask,
  baseline: () => Promise<BrowserTaskOutcome>,
  compiled?: () => Promise<unknown>,
): Promise<{ outcome: BrowserTaskOutcome; engine: 'compiled' | 'browser-use'; fallback: boolean }> {
  validateBrowserTask(task);
  if (compiled) {
    try {
      const data = assertResponseValue(task.outputSchema, await compiled());
      return { outcome: { status: 'completed', data }, engine: 'compiled', fallback: false };
    } catch { /* A read may fall back once; no recursive retry or implicit repair. */ }
  }
  const outcome = parseBrowserTaskOutcome(await baseline(), task.outputSchema);
  return { outcome, engine: 'browser-use', fallback: !!compiled };
}
