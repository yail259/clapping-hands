import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import type { BrowserContext } from 'playwright-core';
import { WorkflowAccessError, assertWorkflowAuth, trackWorkflowAuth } from './workflow-auth.js';

export class DocumentUnavailableError extends Error {
  constructor() { super('The requested document is unavailable.'); }
}

/** A provisional, site-neutral candidate. Values and credentials never enter it. */
export type InlineJsonStep = string | { find: { key: string; value: string } };
export type InlineJsonUrlPart = string | { input: true };
export type InlineJsonUrlTemplate = { origin: string; path: InlineJsonUrlPart[];
  query: Array<{ name: string; value: InlineJsonUrlPart }> };
export type InlineJsonPlan = { kind: 'inline-json-projection-v1'; anchorKey: string;
  inputName: string; url: InlineJsonUrlTemplate; fields: Record<string, InlineJsonStep[]>;
  status: 'candidate' | 'stable' | 'degraded'; training: [string, string]; heldout: string[] };
export type InlineJsonExample = { html: string; url: string; inputName: string;
  input: string; output: Record<string, string> };

type JsonRecord = Record<string, unknown>;
type Path = Array<string | number>;
const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
const safeKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) &&
  !['__proto__', 'constructor', 'prototype'].includes(key);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function compileUrl(first: InlineJsonExample, second: InlineJsonExample): InlineJsonUrlTemplate | null {
  try {
    const urls = [new URL(first.url), new URL(second.url)];
    if (urls.some(url => !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) ||
      urls[0]!.origin !== urls[1]!.origin) return null;
    const a = urls[0]!.pathname.split('/').map(decodeURIComponent), b = urls[1]!.pathname.split('/').map(decodeURIComponent);
    if (a.length !== b.length) return null;
    let bindings = 0;
    const bind = (x: string, y: string): InlineJsonUrlPart | null => {
      if (x === first.input && y === second.input) { bindings++; return { input: true }; }
      return x === y && x.length <= 100 && !/[\u0000-\u001f]/.test(x) ? x : null;
    };
    const path = a.map((value, index) => bind(value, b[index]!));
    const qa = [...urls[0]!.searchParams], qb = [...urls[1]!.searchParams];
    if (qa.length !== qb.length || qa.some(([name], index) => name !== qb[index]![0])) return null;
    const query = qa.map(([name, value], index) => ({ name, value: bind(value, qb[index]![1]) }));
    if (bindings !== 1 || path.some(part => part === null) || query.some(part => part.value === null)) return null;
    return { origin: urls[0]!.origin, path: path as InlineJsonUrlPart[],
      query: query as Array<{ name: string; value: InlineJsonUrlPart }> };
  } catch { return null; }
}

export function materializeInlineJsonUrl(plan: InlineJsonPlan, input: string): string {
  if (!input || input.length > 200 || /[\u0000-\u001f]/.test(input) || input === '.' || input === '..')
    throw new Error('Inline JSON input refused.');
  const base = new URL(plan.url.origin);
  const validPart = (part: unknown): part is InlineJsonUrlPart =>
    typeof part === 'string' ? part.length <= 100 && !/[\u0000-\u001f]/.test(part) :
      !!part && typeof part === 'object' && !Array.isArray(part) &&
      Object.keys(part).length === 1 && (part as { input?: unknown }).input === true;
  if (!['https:', 'http:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash ||
    base.username || base.password || plan.url.path.length > 30 || plan.url.query.length > 20 ||
    plan.url.path.some(part => !validPart(part)) ||
    plan.url.query.some(part => typeof part.name !== 'string' || !part.name || part.name.length > 80 ||
      /[\u0000-\u001f]/.test(part.name) || !validPart(part.value)) ||
    [...plan.url.path, ...plan.url.query.map(part => part.value)]
      .filter(part => typeof part !== 'string').length !== 1)
    throw new Error('Inline JSON URL plan refused.');
  base.pathname = plan.url.path.map(part => typeof part === 'string' ? encodeURIComponent(part) : encodeURIComponent(input)).join('/');
  for (const part of plan.url.query) base.searchParams.append(part.name,
    typeof part.value === 'string' ? part.value : input);
  if (base.origin !== plan.url.origin) throw new Error('Inline JSON URL origin changed.');
  return base.href;
}

function records(html: string, input: string): Array<{ key: string; value: JsonRecord }> {
  if (html.length > 5_000_000 || !input || input.length > 200 || /[\u0000-\u001f]/.test(input))
    throw new Error('Inline JSON input or document refused.');
  const $ = load(html), found: Array<{ key: string; value: JsonRecord }> = [];
  let nodes = 0;
  $('script[type="application/json"]').each((_index, element) => {
    const text = $(element).html() ?? '';
    if (!text.includes(input) || text.length > 1_000_000) return;
    let root: unknown;
    try { root = JSON.parse(text); } catch { return; }
    const walk = (value: unknown, depth: number): void => {
      if (++nodes > 100_000 || depth > 35 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
      const object = value as JsonRecord;
      for (const [key, child] of Object.entries(object)) {
        if (child === input && safeKey(key)) found.push({ key, value: object });
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };
    walk(root, 0);
  });
  if (nodes > 100_000) throw new Error('Inline JSON document traversal limit exceeded.');
  return found;
}

function matchingPaths(root: JsonRecord, expected: string): Path[] {
  const paths: Path[] = [];
  let visited = 0;
  const walk = (value: unknown, path: Path, depth: number): void => {
    if (++visited > 30_000 || depth > 12 || paths.length > 100) return;
    if (typeof value === 'string' && sameText(value, expected)) { paths.push(path); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) walk(child, [...path, Array.isArray(value) ? Number(key) : key], depth + 1);
  };
  walk(root, [], 0);
  if (visited > 30_000 || paths.length > 100) throw new Error('Inline JSON field search limit exceeded.');
  return paths;
}

function at(root: unknown, path: Path): unknown {
  let value = root;
  for (const step of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string | number, unknown>)[step];
  }
  return value;
}

function semanticPath(a: JsonRecord, b: JsonRecord, path: Path): InlineJsonStep[] | null {
  const steps: InlineJsonStep[] = [], prefix: Path = [];
  for (const step of path) {
    if (typeof step === 'string') { if (!safeKey(step)) return null; steps.push(step); prefix.push(step); continue; }
    const arrayA = at(a, prefix), arrayB = at(b, prefix);
    if (!Array.isArray(arrayA) || !Array.isArray(arrayB)) return null;
    const itemA = arrayA[step], itemB = arrayB[step];
    if (!itemA || !itemB || typeof itemA !== 'object' || typeof itemB !== 'object' ||
      Array.isArray(itemA) || Array.isArray(itemB)) return null;
    const selector = Object.entries(itemA as JsonRecord).filter(([key, value]) =>
      typeof value === 'string' && value.length > 0 && value.length <= 80 &&
      (itemB as JsonRecord)[key] === value && /(?:name|type|kind|key)$/i.test(key) &&
      arrayA.filter(row => row && typeof row === 'object' && (row as JsonRecord)[key] === value).length === 1 &&
      arrayB.filter(row => row && typeof row === 'object' && (row as JsonRecord)[key] === value).length === 1)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))[0];
    if (!selector) return null;
    steps.push({ find: { key: selector[0], value: selector[1] as string } });
    prefix.push(step);
  }
  return steps;
}

export function compileInlineJsonProjection(first: InlineJsonExample, second: InlineJsonExample): InlineJsonPlan | null {
  if (first.input === second.input || !first.input || !second.input ||
    !safeKey(first.inputName) || first.inputName !== second.inputName ||
    Object.keys(first.output).length === 0 || Object.keys(first.output).length > 20 ||
    Object.keys(first.output).some(key => !safeKey(key)) ||
    JSON.stringify(Object.keys(first.output).sort()) !== JSON.stringify(Object.keys(second.output).sort())) return null;
  const url = compileUrl(first, second);
  if (!url) return null;
  const candidates: InlineJsonPlan[] = [];
  for (const a of records(first.html, first.input)) for (const b of records(second.html, second.input)) {
    if (a.key !== b.key) continue;
    const fields: Record<string, InlineJsonStep[]> = {};
    for (const [field, expectedA] of Object.entries(first.output)) {
      const expectedB = second.output[field];
      if (typeof expectedA !== 'string' || typeof expectedB !== 'string' || !expectedA || !expectedB) break;
      const pathsB = new Set(matchingPaths(b.value, expectedB).map(path => JSON.stringify(path)));
      const shared = matchingPaths(a.value, expectedA).filter(path => pathsB.has(JSON.stringify(path)))
        .map(path => ({ path, steps: semanticPath(a.value, b.value, path) }))
        .filter((candidate): candidate is { path: Path; steps: InlineJsonStep[] } => !!candidate.steps)
        .sort((x, y) => {
          const xEnd = String(x.path.at(-1) ?? ''), yEnd = String(y.path.at(-1) ?? '');
          const xScore = Number(xEnd.includes(field)) * 100 - x.path.length * 10 - x.path.join('.').length;
          const yScore = Number(yEnd.includes(field)) * 100 - y.path.length * 10 - y.path.join('.').length;
          return yScore - xScore || JSON.stringify(x.path).localeCompare(JSON.stringify(y.path));
        });
      if (!shared.length) break;
      fields[field] = shared[0]!.steps;
    }
    if (Object.keys(fields).length === Object.keys(first.output).length)
      candidates.push({ kind: 'inline-json-projection-v1', anchorKey: a.key,
        inputName: first.inputName, url, fields, status: 'candidate',
        training: [hash(first.input), hash(second.input)], heldout: [] });
  }
  const unique = [...new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate])).values()];
  return unique.length === 1 ? unique[0]! : null;
}

export function replayInlineJsonProjection(html: string, input: string, plan: InlineJsonPlan): Record<string, string> {
  assertInlineJsonPlan(plan);
  if (plan.kind !== 'inline-json-projection-v1' || plan.status === 'degraded' ||
    !safeKey(plan.anchorKey) || !safeKey(plan.inputName)) throw new Error('Inline JSON plan refused.');
  if (Object.keys(plan.fields).length === 0 || Object.keys(plan.fields).length > 20 ||
    Object.keys(plan.fields).some(key => !safeKey(key)) ||
    Object.values(plan.fields).some(steps => !Array.isArray(steps) || !steps.length || steps.length > 12 ||
      steps.some(step => typeof step === 'string' ? !safeKey(step) :
        !step || typeof step !== 'object' || !step.find || !safeKey(step.find.key) ||
        typeof step.find.value !== 'string' || !step.find.value || step.find.value.length > 80)))
    throw new Error('Inline JSON fields refused.');
  const outputs: Record<string, string>[] = [];
  for (const candidate of records(html, input).filter(row => row.key === plan.anchorKey)) {
    const output: Record<string, string> = {};
    let complete = true;
    for (const [field, steps] of Object.entries(plan.fields)) {
      let value: unknown = candidate.value;
      for (const step of steps) {
        if (typeof step === 'string') value = value && typeof value === 'object' ? (value as JsonRecord)[step] : undefined;
        else {
          if (!Array.isArray(value)) { value = undefined; break; }
          const matches = value.filter(row => row && typeof row === 'object' &&
            (row as JsonRecord)[step.find.key] === step.find.value);
          value = matches.length === 1 ? matches[0] : undefined;
        }
      }
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) { complete = false; break; }
      output[field] = value.trim();
    }
    if (complete) outputs.push(output);
  }
  if (outputs.length !== 1) throw new Error(`Inline JSON result missing or ambiguous: ${outputs.length}.`);
  return outputs[0]!;
}

export function recordInlineJsonComparison(plan: InlineJsonPlan, input: string, matches: boolean): InlineJsonPlan {
  const next = structuredClone(plan);
  if (!matches) { next.status = 'degraded'; return next; }
  if (next.status === 'degraded') return next;
  const key = hash(input);
  if (next.training.includes(key) || next.heldout.includes(key)) return next;
  if (next.heldout.length < 2) next.heldout.push(key);
  if (next.heldout.length === 2) next.status = 'stable';
  return next;
}

export function assertInlineJsonPlan(value: unknown): asserts value is InlineJsonPlan {
  if (!value || typeof value !== 'object') throw new Error('Inline JSON plan refused.');
  const plan = value as InlineJsonPlan;
  if (plan.kind !== 'inline-json-projection-v1' || !safeKey(plan.anchorKey) || !safeKey(plan.inputName) ||
    !['candidate', 'stable', 'degraded'].includes(plan.status) ||
    !Array.isArray(plan.training) || plan.training.length !== 2 ||
    plan.training.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)) ||
    plan.training[0] === plan.training[1] || !Array.isArray(plan.heldout) || plan.heldout.length > 2 ||
    plan.heldout.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item) || plan.training.includes(item)) ||
    new Set(plan.heldout).size !== plan.heldout.length ||
    (plan.status === 'stable' && plan.heldout.length !== 2) ||
    !plan.url || typeof plan.url !== 'object' || !Array.isArray(plan.url.path) ||
    !Array.isArray(plan.url.query) || !plan.url.path.some(part => typeof part !== 'string'))
    throw new Error('Inline JSON plan refused.');
  materializeInlineJsonUrl(plan, 'clapping-hands-check');
  // Validate field steps even when no document is available.
  if (!plan.fields || typeof plan.fields !== 'object' || Object.keys(plan.fields).length === 0 ||
    Object.keys(plan.fields).length > 20 || Object.entries(plan.fields).some(([key, steps]) =>
      !safeKey(key) || !Array.isArray(steps) || steps.length === 0 || steps.length > 12 ||
      steps.some(step => typeof step === 'string' ? !safeKey(step) :
        !step || typeof step !== 'object' || !step.find || !safeKey(step.find.key) ||
        typeof step.find.value !== 'string' || !step.find.value || step.find.value.length > 80)))
    throw new Error('Inline JSON plan refused.');
}

/** Candidate execution still uses the owner's browser. It never constructs a
 * direct HTTP client or borrows authentication material from the page. */
export async function replayInlineJsonDocument(context: BrowserContext, plan: InlineJsonPlan,
  input: Record<string, unknown>, signal?: AbortSignal) {
  if (Object.keys(input).length !== 1 || typeof input[plan.inputName] !== 'string')
    throw new Error('Inline JSON input shape refused.');
  const url = materializeInlineJsonUrl(plan, input[plan.inputName] as string);
  const page = await context.newPage(), stop = trackWorkflowAuth(context), started = performance.now();
  const abort = () => { void page.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Inline JSON replay aborted.');
    const response = await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    if (!response) throw new Error('Inline JSON document navigation refused.');
    if (response.status() === 401 || response.status() === 403)
      throw new WorkflowAccessError(response.status() === 401 ? 'http-401' : 'http-403', plan.url.origin);
    await assertWorkflowAuth(page, plan.url.origin);
    if (response.status() === 404 || response.status() === 410) throw new DocumentUnavailableError();
    if (response.status() !== 200 || page.url() !== url)
      throw new Error('Inline JSON document navigation refused.');
    const html = await response.text();
    const data = replayInlineJsonProjection(html, input[plan.inputName] as string, plan);
    return { data, durationMs: performance.now() - started };
  } finally {
    signal?.removeEventListener('abort', abort);
    stop();
    await page.close();
  }
}
