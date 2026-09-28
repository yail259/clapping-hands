import type { CapturedExchange } from './captured-exchange.js';
import type { BrowserTaskOutcome } from './browser-task.js';
import type { JsonValue } from './response-contract.js';
import type { TaskDefinition } from './task-store.js';
import { compileGenericJsonPlan, assertGenericJsonPlanSafety, type GenericJsonPlan } from './generic-network.js';
import { guardedJsonAsInlineDocument } from './guarded-json-sequence.js';
import { assertInlineJsonPlan, compileInlineJsonProjection, type InlineJsonPlan } from './inline-json-projection.js';

export type RouteJsonAccelerator = { kind: 'guarded-route-projection-v1'; request: GenericJsonPlan;
  projection: InlineJsonPlan; status: 'candidate' | 'stable' | 'degraded' };
type Demonstration = { input: JsonValue; outcome: BrowserTaskOutcome; exchanges: CapturedExchange[] };

/** Admission is based on two complete caller outputs and two same-operation,
 * same-origin browser responses. All request session fields remain null in the
 * plan and must be supplied by a fresh in-process context ticket at replay. */
export function compileRouteJsonFromDemonstrations(definition: TaskDefinition,
  demonstrations: [Demonstration, Demonstration], onAudit?: (stage: string) => void): RouteJsonAccelerator | null {
  const inputNames = Object.keys(definition.inputSchema.properties ?? {});
  const outputNames = Object.keys(definition.outputSchema.properties ?? {});
  if (definition.inputSchema.type !== 'object' || inputNames.length !== 1 ||
    definition.inputSchema.required?.length !== 1 || definition.inputSchema.required[0] !== inputNames[0] ||
    definition.inputSchema.properties?.[inputNames[0]!]?.type !== 'string' ||
    definition.outputSchema.type !== 'object' || definition.outputSchema.additionalProperties !== false ||
    !outputNames.length || definition.outputSchema.required?.length !== outputNames.length ||
    outputNames.some(name => !definition.outputSchema.required?.includes(name) ||
      definition.outputSchema.properties?.[name]?.type !== 'string')) return null;
  const name = inputNames[0]!, origin = new URL(definition.startUrl).origin;
  const inputs = demonstrations.map(demo => demo.input && typeof demo.input === 'object' && !Array.isArray(demo.input)
    ? demo.input[name] : undefined);
  if (typeof inputs[0] !== 'string' || typeof inputs[1] !== 'string' || !inputs[0] || !inputs[1] || inputs[0] === inputs[1]) return null;
  const outputs = demonstrations.map(demo => {
    const data = demo.outcome.status === 'completed' ? demo.outcome.data : null;
    return data && typeof data === 'object' && !Array.isArray(data) &&
      outputNames.every(field => typeof data[field] === 'string' && data[field])
      ? Object.fromEntries(outputNames.map(field => [field, data[field] as string])) : null;
  });
  if (!outputs[0] || !outputs[1]) return null;
  const candidates: RouteJsonAccelerator[] = [];
  const exchanges = demonstrations.map((demo,index) => demo.exchanges.filter(exchange => {
    if (exchange.method !== 'POST' || exchange.responseStatus !== 200 ||
      new URL(exchange.url).origin !== origin || exchange.responseBody.length > 1_000_000) return false;
    try {
      guardedJsonAsInlineDocument(exchange.responseBody);
      return [...new URLSearchParams(exchange.requestBody).values()].some(value => {
        if (!value.startsWith('/') || value.startsWith('//')) return false;
        const parsed = new URL(value, origin);
        return parsed.origin === origin && parsed.pathname.split('/').includes(inputs[index] as string);
      });
    } catch { return false; }
  }).slice(0, 20));
  onAudit?.(`eligible-responses:${exchanges[0]!.length},${exchanges[1]!.length}`);
  for (const first of exchanges[0]!) for (const second of exchanges[1]!) {
   if (new URL(first.url).pathname !== new URL(second.url).pathname) continue;
   let stage='request-compilation';try {
    const request = compileGenericJsonPlan(definition.action,
      [{ input: { [name]: inputs[0]! }, exchange: first }, { input: { [name]: inputs[1]! }, exchange: second }],
      { workflowOrigin: origin, allowPathInputs: true, experimentalRuntimeContext: true });
    stage='request-shape';
    if (request.response.codec !== 'guarded-json-sequence' || !request.request.runtimeFields?.length ||
      request.request.bodyUrlPathBindings?.length !== 1 || request.request.bodyUrlPathBindings[0]!.input !== name) {onAudit?.(stage);continue;}
    request.request.transport = 'browser-fetch';
    assertGenericJsonPlanSafety(request);
    const binding = request.request.bodyUrlPathBindings[0]!;
    const url = (exchange: CapturedExchange, input: string) => {
      const raw = new URLSearchParams(exchange.requestBody).getAll(binding.name)[binding.index];
      if (!raw || !raw.startsWith('/') || raw.startsWith('//')) throw new Error('Route URL missing.');
      const parsed = new URL(raw, origin);
      if (parsed.origin !== origin || !parsed.pathname.split('/').includes(input)) throw new Error('Route input missing.');
      return origin + parsed.pathname;
    };
    stage='projection-compilation';
    const projection = compileInlineJsonProjection(
      { html: guardedJsonAsInlineDocument(first.responseBody), url: url(first, inputs[0]!), inputName: name,
        input: inputs[0]!, output: outputs[0]! },
      { html: guardedJsonAsInlineDocument(second.responseBody), url: url(second, inputs[1]!), inputName: name,
        input: inputs[1]!, output: outputs[1]! });
    if (projection) candidates.push({ kind: 'guarded-route-projection-v1', request, projection, status: 'candidate' });
    else onAudit?.('projection-unavailable');
  } catch (error) {
    const message=error instanceof Error?error.message:'';
    const reason=message==='Network demonstrations do not describe the same operation.'?'operation-mismatch'
      :message==='Nested URL codec drift across demonstrations.'?'nested-url-drift'
      :message.startsWith('Could not infer a request binding')?'input-unbound'
      :message==='Session header shape changed across demonstrations.'?'header-shape-drift'
      :message==='Response frame count drift across demonstrations.'?'response-frame-drift'
      :message==='Response codec drift across demonstrations.'?'response-codec-drift'
      :message==='Path bindings changed across demonstrations.'?'path-binding-drift'
      :message==='Request content type changed across demonstrations.'?'content-type-drift'
      :message==='Runtime context must have a stable scalar type.'?'runtime-type-drift'
      :message.startsWith('Refusing to persist sensitive request field')?'sensitive-field'
      :message.startsWith('Refusing to persist a high-entropy request constant')?'opaque-constant'
      :message==='Session request headers require runtime context.'?'runtime-headers-required'
      :message==='Network demonstrations crossed origins.'?'cross-origin'
      :message==='HTML attributes do not match the independent browser sources.'?'html-attributes-drift'
      :message==='JSON response does not match its declared codec.'?'response-decode'
      :message.startsWith('Input ') && message.endsWith('did not vary across demonstrations.')?'input-did-not-vary'
      :'other';
    const line=error instanceof Error ? /generic-network\.ts:(\d+)/.exec(error.stack??'')?.[1] : undefined;
    onAudit?.(`${stage}:${reason}${line?`:line-${line}`:''}`); /* The pair did not prove a bound, safe read operation. */
  }
  }
  onAudit?.(`candidates:${candidates.length}`);
  return candidates.length === 1 ? candidates[0]! : null;
}

export function assertRouteJsonAccelerator(value: unknown): asserts value is RouteJsonAccelerator {
  if (!value || typeof value !== 'object') throw new Error('Route accelerator refused.');
  const candidate = value as RouteJsonAccelerator;
  if (candidate.kind !== 'guarded-route-projection-v1' || !['candidate', 'stable', 'degraded'].includes(candidate.status))
    throw new Error('Route accelerator refused.');
  assertGenericJsonPlanSafety(candidate.request);
  assertInlineJsonPlan(candidate.projection);
  if (candidate.request.response.codec !== 'guarded-json-sequence' || candidate.request.request.transport !== 'browser-fetch' ||
    !candidate.request.request.runtimeFields?.length || candidate.request.request.bodyUrlPathBindings?.length !== 1 ||
    candidate.request.request.bodyUrlPathBindings[0]!.input !== candidate.projection.inputName ||
    candidate.request.origin !== candidate.projection.url.origin ||
    candidate.request.request.endpointOrigin && candidate.request.request.endpointOrigin !== candidate.request.origin ||
    candidate.status !== candidate.projection.status)
    throw new Error('Route accelerator binding refused.');
}
