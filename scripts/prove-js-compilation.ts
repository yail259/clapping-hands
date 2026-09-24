import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { proposeJavaScript } from '../src/javascript-compiler.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from '../src/generated-js.js';
import { saveEvidenceBundle, sanitizeEvidence, loadEvidenceBundle } from '../src/evidence-bundle.js';
import type { JsonValue, ResponseSchema } from '../src/response-contract.js';

// Experiment-only oracle. Its selectors are NEVER passed to the compiler or
// broker. The compiler receives HTML + example outputs and authors the parser.
const root = resolve(process.env.CLAPPING_HANDS_JS_EVIDENCE_DIR ?? '.data/js-compilation');
const report = JSON.parse(await readFile(resolve('bench/runs/2026-09-07/alpha-rich-1788758126922-openlibrary.json'), 'utf8'));
const definition = report.definition;
const resource = { id: 'search', method: 'GET', url: 'https://openlibrary.org/search', parameters: ['q'] };
const queries = ['tolkien', 'jane austen', 'dune', 'moby dick', 'sherlock holmes'];
function oracle(html: string) {
  const $ = load(html);
  return $('li.searchResultItem').filter((_i,el)=>!!$(el).find('h3.booktitle a[href]').length).slice(0,5).toArray().map(el => {
    const row = $(el), link = row.find('h3.booktitle a').first();
    return { title: link.text().trim(), authors: row.find('.bookauthor a').toArray().map(a=>$(a).text().trim()),
      year: row.find('.resultDetails').text().match(/First published in\s+(\d{4})/)?.[1] ?? '',
      url: new URL(link.attr('href')!, resource.url).href };
  });
}
async function capture(query: string, signal = AbortSignal.timeout(30_000)) {
  const url = new URL(resource.url); url.searchParams.set('q', query);
  const start = performance.now();
  let response: Response;
  try { response = await fetch(url, { redirect: 'error', signal }); }
  catch {
    await saveEvidenceBundle(root, { kind:'capture-failure', site:'openlibrary', input:{query}, url:url.href, category:'connection-failed', durationMs:performance.now()-start });
    throw new Error('Direct response connection failed; failure saved.');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 900_000) throw new Error('Response too large');
  const safe = sanitizeEvidence({ responseBody: raw });
  const body = (safe.data as any).responseBody;
  const snapshot = { url: url.href, status: response.status, body: body.format === 'html' ? body.data as string : '' };
  const bundle = await saveEvidenceBundle(root, { kind: 'direct-response-capture', site: 'openlibrary', input: {query}, resource,
    provenance: 'known-website-search-url; no Browser Use rerun', response: snapshot, omissions: safe.omissions, durationMs: performance.now()-start });
  if (response.status !== 200 || !snapshot.body) throw new Error('Capture unavailable: '+response.status);
  return { snapshot, evidenceId: bundle.id };
}
const restoredId = process.env.CLAPPING_HANDS_JS_PROPOSAL_ID;
let source: string, proposalId: string;
if (restoredId) {
  const saved = await loadEvidenceBundle(root, restoredId) as any;
  source = saved.proposal.source; proposalId = restoredId;
} else {
  const requestId = process.env.CLAPPING_HANDS_JS_REQUEST_ID;
  const examples = [];
  if (!requestId) for (const query of queries.slice(0,2)) {
    const observed = await capture(query);
    const expected = oracle(observed.snapshot.body);
    if (expected.length !== 5) throw new Error('Oracle incomplete');
    examples.push({ input: {query}, request: {resource:'search', parameters:{q:query}}, response: observed.snapshot, expected, evidenceId: observed.evidenceId });
  }
  const compilerEvidence = requestId ? JSON.parse((await loadEvidenceBundle(root, requestId) as any).prompt)
    : { goal: definition.goal, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, resources:[resource], examples };
  // Corrections to training oracles can be evaluated against the original saved
  // HTML. Held-out evidence is never included in the compiler's prompt.
  for (const example of compilerEvidence.examples) example.expected = oracle(example.response.body);
  const generated = await proposeJavaScript(compilerEvidence, root);
  console.log(JSON.stringify({ phase:'compiled', supported: generated.proposal.supported, proposalId: generated.responseId, durationMs: generated.durationMs }));
  if (!generated.proposal.supported) throw new Error('Model declined compilation');
  source = generated.proposal.source; proposalId = generated.responseId;
}
const results = [];
for (const query of queries.slice(2)) {
  let observed: Awaited<ReturnType<typeof capture>> | undefined;
  const broker: GeneratedBroker = async (request, signal) => {
    if (request.resource !== 'search' || Object.keys(request.parameters).join(',') !== 'q' || typeof request.parameters.q !== 'string' || request.parameters.q !== query) throw new Error('Request outside test contract');
    observed = await capture(request.parameters.q, signal);
    return observed.snapshot;
  };
  try {
    const result = await executeGeneratedJavaScript(source, {query}, definition.outputSchema as ResponseSchema, broker);
    const expected = oracle(observed!.snapshot.body);
    const exact = expected.length === 5 && isDeepStrictEqual(result.value, expected);
    const record = { kind:'held-out-validation', proposalId, input:{query}, restarted:!!restoredId, result, expected, exact,
      oracle:'independently authored parser of same fresh response; not independent browser navigation', evidenceId: observed!.evidenceId };
    await saveEvidenceBundle(root, record);
    results.push({query,exact,durationMs:result.durationMs,requests:result.requests});
  } catch (error) {
    const failure = {query,exact:false,error:error instanceof Error ? error.name : 'unknown'};
    results.push(failure); await saveEvidenceBundle(root,{kind:'held-out-failure',proposalId,...failure});
  }
  console.log(JSON.stringify({phase:'held-out',...results.at(-1)}));
}
await saveEvidenceBundle(root, {kind:'compilation-summary',site:'openlibrary',proposalId,restarted:!!restoredId,results});
console.log(JSON.stringify({phase:'finished',root,proposalId,results}));
