import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BrowserContext, Page } from 'playwright-core';
import { assertWorkflowAuth, trackWorkflowAuth } from './workflow-auth.js';

const safeName = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
const privateName = /token|secret|cookie|password|session|authorization|authentication|csrf|xsrf|api.?key|access.?key|^key$/i;
const part = z.union([z.string().max(200), z.object({ input: z.literal(true) }).strict()]);
const selector = z.string().max(500).regex(/^[a-z][a-z0-9]*(?:[.#][A-Za-z_][A-Za-z0-9_-]{0,79})*(?: [a-z][a-z0-9]*(?:[.#][A-Za-z_][A-Za-z0-9_-]{0,79})*)?$/);
export const pageReplaySchema = z.object({
  kind: z.literal('page-url-text-v1'), origin: z.string().url(), inputName: z.string().regex(safeName),
  path: z.array(part).min(2).max(20), query: z.array(z.object({ name: z.string().regex(safeName), value: part }).strict()).max(20),
  selector, index: z.number().int().min(0).max(99), status: z.enum(['provisional','stable','degraded']),
  training: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(2),
  heldout: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
}).strict().superRefine((p, ctx) => {
  const u = new URL(p.origin);
  if (!['https:','http:'].includes(u.protocol) || u.origin !== p.origin || privateName.test(p.inputName)
    || /token|secret|cookie|password|session|csrf|xsrf/i.test(p.selector)
    || p.path[0] !== '' || p.path.some(x => typeof x === 'string' && (x === '.' || x === '..' || /[/?#\\]/.test(x)))
    || p.query.some(x => privateName.test(x.name)) || new Set(p.query.map(x => x.name)).size !== p.query.length
    || ![...p.path, ...p.query.map(x => x.value)].some(x => typeof x !== 'string')
    || new Set(p.training).size !== 2 || new Set(p.heldout).size !== p.heldout.length || p.heldout.some(x => p.training.includes(x))) {
    ctx.addIssue({ code: 'custom', message: 'Unsafe or unsupported page replay.' });
  }
});
export type PageReplay = z.infer<typeof pageReplaySchema>;
export type PageEvidence = { url: string; selectors: Array<{ selector: string; index: number }> };
const hash = (value: string) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function capturePageEvidence(page: Page, output: unknown): Promise<PageEvidence | null> {
  if (typeof output !== 'string' || !output || output.length > 4000) return null;
  const selectors = await page.evaluate<Array<{ selector: string; index: number }>>(String.raw`((output) => {
    const safe = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
    const compound = (el) => el.tagName.toLowerCase() + (safe.test(el.id) ? '#'+el.id :
      [...el.classList].filter(x => safe.test(x)).slice(0, 3).map(x => '.'+x).join(''));
    const result = [];
    for (const el of [...document.querySelectorAll('h1,h2,h3,h4,a,span,p,div,li,td,dd,dt,output')].slice(0, 5000)) {
      if (!(el instanceof HTMLElement) || !el.textContent?.includes(output) || el.innerText.trim() !== output || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      for (const css of [el.parentElement ? compound(el.parentElement)+' '+compound(el) : '', compound(el)]) {
        if (!css || result.some(r => r.selector === css)) continue;
        const nodes = [...document.querySelectorAll(css)];
        const index = nodes.indexOf(el);
        if (index >= 0 && index < 100) result.push({ selector: css, index });
        if (result.length >= 16) return result;
      }
    }
    return result;
  })(${JSON.stringify(output)})`);
  return selectors.length ? { url: page.url(), selectors } : null;
}

export function compilePageReplay(origin: string, inputs: unknown[], evidence: PageEvidence[][]): PageReplay | null {
  try {
    if (inputs.length !== 2 || evidence.length !== 2) return null;
    const records = inputs as Record<string, unknown>[];
    const names = Object.keys(records[0]!);
    if (names.length !== 1 || Object.keys(records[1]!).length !== 1) return null;
    const name = names[0]!;
    const values = records.map(r => r[name]);
    if (!values.every(x => typeof x === 'string' && x.length > 0 && x.length < 200) || values[0] === values[1]) return null;
    for (const first of evidence[0]!) for (const second of evidence[1]!) {
      const urls = [new URL(first.url), new URL(second.url)];
      if (urls.some(u => u.origin !== origin || u.hash || u.username || u.password)) continue;
      const paths = urls.map(u => u.pathname.split('/').map(decodeURIComponent));
      if (paths[0]!.length !== paths[1]!.length) continue;
      const bind = (a: string, b: string) => a === values[0] && b === values[1] ? { input: true as const } : a === b ? a : null;
      const path = paths[0]!.map((p, i) => bind(p, paths[1]![i]!));
      const entries = urls.map(u => [...u.searchParams]);
      if (entries[0]!.length !== entries[1]!.length || entries[0]!.some(([k], i) => k !== entries[1]![i]![0])) continue;
      const query = entries[0]!.map(([name, value], i) => ({ name, value: bind(value, entries[1]![i]![1]) }));
      if (path.includes(null) || query.some(x => x.value === null)) continue;
      // Fixed URL material is bounded and public-looking, never opaque tokens.
      const constants = [...path, ...query.map(x => x.value)].filter((x): x is string => typeof x === 'string');
      if (constants.some(x => !/^[A-Za-z0-9_. -]{0,80}$/.test(x) || /[A-Za-z0-9_-]{32,}/.test(x))) continue;
      const match = first.selectors.find(a => second.selectors.some(b => a.selector === b.selector && a.index === b.index));
      if (!match) continue;
      return pageReplaySchema.parse({ kind: 'page-url-text-v1', origin, inputName: name, path, query,
        ...match, status: 'provisional', training: values.map(x => hash(x as string)), heldout: [] });
    }
  } catch { /* Unsupported evidence does not invalidate a successful task. */ }
  return null;
}

export function materializePageUrl(plan: PageReplay, input: unknown): string {
  const p = pageReplaySchema.parse(plan);
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 1) throw new Error('Page replay input mismatch.');
  const value = (input as Record<string, unknown>)[p.inputName];
  if (typeof value !== 'string' || !value || value.length >= 200 || value === '.' || value === '..') throw new Error('Page replay input mismatch.');
  const url = new URL(p.origin);
  url.pathname = p.path.map(x => encodeURIComponent(typeof x === 'string' ? x : value)).join('/');
  for (const q of p.query) url.searchParams.append(q.name, typeof q.value === 'string' ? q.value : value);
  if (url.origin !== p.origin) throw new Error('Page replay origin mismatch.');
  return url.href;
}
export function stablePageReplay(plan: PageReplay): boolean {
  const p = pageReplaySchema.parse(plan);
  return p.status === 'stable' && p.heldout.length === 2;
}
export function recordPageShadow(plan: PageReplay, input: unknown, matches: boolean): PageReplay {
  materializePageUrl(plan, input);
  const p = pageReplaySchema.parse(plan);
  if (!matches) p.status = 'degraded';
  else if (p.status !== 'degraded') {
    const key = hash((input as Record<string,string>)[p.inputName]!);
    if (!p.training.includes(key) && !p.heldout.includes(key) && p.heldout.length < 2) p.heldout.push(key);
    if (p.heldout.length === 2) p.status = 'stable';
  }
  return p;
}
export async function replayPage(context: BrowserContext, plan: PageReplay, input: unknown, signal?: AbortSignal) {
  const started = performance.now(), url = materializePageUrl(plan, input);
  const page = await context.newPage(), stop = trackWorkflowAuth(context);
  const abort = () => { void page.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Page replay aborted.');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response || response.status() !== 200 || new URL(page.url()).origin !== plan.origin) throw new Error('Page replay navigation refused.');
    await assertWorkflowAuth(page, plan.origin);
    const target = page.locator(plan.selector).nth(plan.index);
    await target.waitFor({ state: 'visible', timeout: 10_000 });
    const data = (await target.innerText({ timeout: 5000 })).trim();
    if (!data || data.length > 4000) throw new Error('Page replay output unavailable.');
    return { data, durationMs: performance.now()-started };
  } finally { signal?.removeEventListener('abort', abort); stop(); await page.close(); }
}
