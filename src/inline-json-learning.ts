import type { CapturedExchange } from './captured-exchange.js';
import type { BrowserTaskOutcome } from './browser-task.js';
import type { JsonValue } from './response-contract.js';
import type { TaskDefinition } from './task-store.js';
import { compileInlineJsonProjection, type InlineJsonPlan, type InlineJsonExample } from './inline-json-projection.js';

type Demonstration = { input: JsonValue; outcome: BrowserTaskOutcome; exchanges: CapturedExchange[] };

/** Compile only from live in-memory document responses. Sanitized saved JSON
 * captures intentionally cannot recreate browser HTML provenance. */
export function compileInlineJsonFromDemonstrations(definition: TaskDefinition,
  demonstrations: [Demonstration, Demonstration]): InlineJsonPlan | null {
  const input = definition.inputSchema, output = definition.outputSchema;
  const inputNames = Object.keys(input.properties ?? {}), outputNames = Object.keys(output.properties ?? {});
  if (input.type !== 'object' || inputNames.length !== 1 || input.required?.length !== 1 ||
    input.required[0] !== inputNames[0] || input.properties?.[inputNames[0]!]?.type !== 'string' ||
    output.type !== 'object' || output.additionalProperties !== false || outputNames.length === 0 ||
    output.required?.length !== outputNames.length ||
    outputNames.some(name => !output.required?.includes(name) || output.properties?.[name]?.type !== 'string')) return null;
  const inputName = inputNames[0]!, origin = new URL(definition.startUrl).origin;
  const examples: InlineJsonExample[] = [];
  for (const demonstration of demonstrations) {
    const value = demonstration.input && typeof demonstration.input === 'object' && !Array.isArray(demonstration.input)
      ? demonstration.input[inputName] : undefined;
    const data = demonstration.outcome.status === 'completed' ? demonstration.outcome.data : undefined;
    if (typeof value !== 'string' || !value || !data || typeof data !== 'object' || Array.isArray(data) ||
      outputNames.some(name => typeof data[name] !== 'string' || !data[name])) return null;
    const documents = demonstration.exchanges.filter(exchange => {
      if (exchange.resourceType !== 'document' || exchange.method !== 'GET' || exchange.responseStatus !== 200 ||
        !exchange.responseBody.includes('application/json')) return false;
      try {
        const url = new URL(exchange.url);
        return url.origin === origin && (url.pathname.split('/').some(segment => decodeURIComponent(segment) === value) ||
          [...url.searchParams.values()].includes(value));
      } catch { return false; }
    });
    if (documents.length !== 1) return null;
    examples.push({ url: documents[0]!.url, html: documents[0]!.responseBody, inputName, input: value,
      output: Object.fromEntries(outputNames.map(name => [name, data[name] as string])) });
  }
  try { return compileInlineJsonProjection(examples[0]!, examples[1]!); }
  catch { return null; }
}
