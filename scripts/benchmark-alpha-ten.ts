import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { TaskRuntime } from '../src/task-runtime.js';
import type { TaskDefinition } from '../src/task-store.js';
import type { JsonValue } from '../src/response-contract.js';

type Case = { id: string; url: string; goal: string; queries: string[] };
const cases: Case[] = [
  { id: 'yahoo', url: 'https://finance.yahoo.com/', goal: 'Use quote search to open the ticker in query. Return the exact main company heading including ticker, not its price.', queries: ['AAPL','MSFT','AMZN','NVDA','GOOG'] },
  { id: 'openlibrary', url: 'https://openlibrary.org/', goal: 'Search the book catalog for query. Return the exact first book result title in default order. Do not open or borrow it.', queries: ['tolkien','jane austen','dune','moby dick','sherlock holmes'] },
  { id: 'govuk', url: 'https://www.gov.uk/search/all', goal: 'Search for query. Return the exact title of the first main result in default relevance order.', queries: ['tax','pension','passport','driving licence','benefits'] },
  { id: 'rba', url: 'https://www.rba.gov.au/calculator/', goal: 'Use the Calendar Year inflation calculator. Enter amount, start_year and end_year and Calculate. Return adjusted_amount as a number, preserving the displayed cents of the computed equivalent basket cost. Do not calculate independently or use Financial Year or Quarterly tabs.', queries: [] },
  { id: 'transport', url: 'https://transportnsw.info/trip', goal: 'Plan a public transport trip departing now from Central Station Sydney to the Sydney station in query. Choose matching station suggestions. Return the exact duration text of the first suggested journey.', queries: ['Town Hall Station','Redfern Station','Wynyard Station','Circular Quay Station','North Sydney Station'] },
  { id: 'ebay', url: 'https://www.ebay.com.au/', goal: 'Search for query and return the first non-sponsored product title. Do not bid, buy or save anything.', queries: ['sofa bed','office chair','cordless drill','guitar','coffee table'] },
  { id: 'ikea', url: 'https://www.ikea.com/au/en/', goal: 'Search for query and return the first product name exactly as displayed. Return only the literal name, without appending the product type or description, and do not paraphrase. Do not add to cart.', queries: ['sofa bed','desk','bookcase','chair','lamp'] },
  { id: 'bunnings', url: 'https://www.bunnings.com.au/', goal: 'Search for query and return the first product title. Do not add to cart.', queries: ['cordless drill','garden hose','hammer','paint brush','ladder'] },
  { id: 'bom', url: 'https://www.bom.gov.au/', goal: 'Find the weather forecast for query. Return today’s displayed maximum temperature together with its date.', queries: ['Sydney','Melbourne','Brisbane','Perth','Adelaide'] },
  { id: 'marketplace', url: 'https://www.facebook.com/marketplace/sydney/', goal: 'Search Sydney Marketplace for query. Return the first listing title. Do not message, save listings or contact sellers. Use existing authentication only.', queries: ['sofa bed','office chair','guitar','coffee table','desk'] },
];
const root = await mkdtemp(join(tmpdir(), 'clappinghands-alpha-ten-'));
const reportDirectory = resolve('bench/runs', new Date().toISOString().slice(0,10));
await mkdir(reportDirectory, { recursive: true });
const runId = Date.now();
const rows: any[] = [];
async function oracle(id: string, query: string, actual: unknown) {
  if (!['yahoo','openlibrary','govuk'].includes(id)) return { exact: null, reason: 'independent-oracle-not-implemented' };
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    const url = id === 'yahoo' ? 'https://finance.yahoo.com/quote/'+encodeURIComponent(query)+'/' : id === 'openlibrary' ? 'https://openlibrary.org/search?q='+encodeURIComponent(query) : 'https://www.gov.uk/search/all?keywords='+encodeURIComponent(query);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (response?.status() !== 200) return { exact: null, reason: 'oracle-access-failed' };
    const target = id === 'yahoo' ? page.locator('h1').filter({ hasText: '('+query+')' }) : id === 'openlibrary' ? page.locator('h3.booktitle a') : page.locator('main a');
    const expected = (await target.first().innerText({ timeout: 10_000 })).trim();
    return { exact: actual === expected, expected };
  } catch { return { exact: null, reason: 'oracle-unavailable' }; }
  finally { await browser.close(); }
}
async function run(site: Case) {
  const directory = join(root, site.id);
  let runtime = new TaskRuntime(directory);
  const definition: TaskDefinition = { action: site.id+'_read', startUrl: site.url, goal: site.goal, effect: 'read',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, outputSchema: { type: 'string' } };
  let inputs: JsonValue[] = site.queries.map(query => ({ query }));
  if (site.id === 'rba') {
    definition.inputSchema = { type: 'object', properties: { amount: { type: 'number' }, start_year: { type: 'integer' }, end_year: { type: 'integer' } }, required: ['amount','start_year','end_year'], additionalProperties: false };
    definition.outputSchema = { type: 'object', properties: { adjusted_amount: { type: 'number' } }, required: ['adjusted_amount'], additionalProperties: false };
    inputs = [{ amount:100,start_year:2000,end_year:2015 },{ amount:250.5,start_year:2001,end_year:2016 },{ amount:75.25,start_year:2000,end_year:2016 },{ amount:125.5,start_year:2001,end_year:2015 },{ amount:325,start_year:2000,end_year:2015 }];
  }
  const row: any = { site: site.id, definition, model: 'gpt-6-astra', learning: null, calls: [], phase: 'learning', benchmarkKind: 'rewritten-runtime', authProfile: site.id === 'marketplace' ? 'existing-user-authorized-profile' : 'new-isolated-profile' };
  const start = performance.now();
  try {
    const learned = await runtime.learn(definition, inputs.slice(0,2));
    row.learning = { registered: learned.registered, executions: learned.executions, compilation: learned.task?.accelerator?.plan.status ?? 'unavailable', pageCompilation: learned.task?.pageAccelerator?.status ?? 'unavailable', pageDiagnostics: learned.pageDiagnostics, diagnostics: learned.compilation, wallMs: performance.now()-start };
    console.log(JSON.stringify({ site: site.id, phase: 'learning', registered: learned.registered, statuses: learned.executions.map(x=>x.outcome.status), compilation: row.learning.compilation, pageCompilation: row.learning.pageCompilation, pageDiagnostics: learned.pageDiagnostics, diagnostics: learned.compilation }));
    if (learned.registered) {
      for (const index of [2,3]) {
        if (index === 3) { await runtime.close(); runtime = new TaskRuntime(directory); }
        row.phase = index === 3 ? 'restart-unseen' : 'unseen';
        const started = performance.now();
        const result = await runtime.run(definition.action, inputs[index]!);
        const wallMs = performance.now()-started;
        const check = result.outcome.status === 'completed' ? await oracle(site.id, site.queries[index] ?? '', result.outcome.data) : { exact: false, reason: 'task-incomplete' };
        row.calls.push({ input: inputs[index], restarted: index === 3, result, wallMs, oracle: check });
        console.log(JSON.stringify({ site: site.id, phase: row.phase, status: result.outcome.status, engine: result.engine, exact: check.exact }));
        if (result.outcome.status !== 'completed') break;
      }
      const saved = await runtime.store.load(definition.action);
      row.finalCompilation = saved?.accelerator?.plan.status ?? 'unavailable';
      row.finalPageCompilation = saved?.pageAccelerator?.status ?? 'unavailable';
      if (row.finalCompilation === 'stable' || row.finalPageCompilation === 'stable') {
        row.phase = 'warm-network';
        await runtime.close(); runtime = new TaskRuntime(directory);
        const started = performance.now();
        const result = await runtime.run(definition.action, inputs[4]!);
        const wallMs = performance.now()-started;
        row.calls.push({ input: inputs[4], restarted: true, result, wallMs, oracle: result.outcome.status === 'completed' ? await oracle(site.id, site.queries[4] ?? '', result.outcome.data) : { exact: false } });
      }
    }
    row.finished = true;
  } catch (error) { row.failure = { phase: row.phase, category: error instanceof Error ? error.name : 'unknown' }; }
  finally { await runtime.close(); }
  row.wallMs = performance.now()-start;
  rows.push(row);
  await writeFile(join(reportDirectory, `alpha-ten-${runId}-${site.id}.json`), JSON.stringify(row,null,2), { mode: 0o600, flag: 'wx' });
}
// Two independent sites at a time; never concurrent access to the same profile.
const requested = process.env.CLAPPING_HANDS_BENCH_SITES?.split(',');
if (requested?.some(id => !cases.some(site => site.id === id))) throw new Error('Unknown benchmark site.');
const pending = cases.filter(site => !requested || requested.includes(site.id));
const expectedCount = pending.length;
await Promise.all([0,1].map(async () => { for (;;) { const site = pending.shift(); if (!site) return; await run(site); } }));
const report = { kind: 'alpha-ten-site-runtime', complete: rows.length === expectedCount, selectedSites: requested ?? cases.map(s => s.id), version: '0.1.0-alpha.3', rows,
  limits: ['Read-only tasks only','Caller schemas validated; only three sites have independent result oracles','Browser model counts unavailable (null), not zero','No access bypass','Compilation optional; no fresh-token network compilation in this alpha'] };
await writeFile(join(reportDirectory, `alpha-ten-${runId}.json`), JSON.stringify(report,null,2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ report: join(reportDirectory, `alpha-ten-${runId}.json`), complete: report.complete }));
