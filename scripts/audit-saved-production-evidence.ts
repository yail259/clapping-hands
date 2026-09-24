/** Offline inventory/admission diagnostic only. Never opens a browser, calls a
 * model, grants an API origin, promotes a plan or reconstructs HTML provenance. */
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadEvidenceBundle } from '../src/evidence-bundle.js';
import { compileGenericJsonCandidatesFromTraces, compileObservedJsonResources, type GenericNetworkTrace } from '../src/generic-network.js';
import type { CapturedExchange } from '../src/captured-exchange.js';

const sites = [
  ['openlibrary', 'https://openlibrary.org'], ['yahoo', 'https://finance.yahoo.com'],
  ['govuk', 'https://www.gov.uk'], ['rba', 'https://www.rba.gov.au'],
  ['bunnings', 'https://www.bunnings.com.au'], ['ikea', 'https://www.ikea.com'],
  ['transport', 'https://transportnsw.info'], ['marketplace', 'https://www.facebook.com'],
  ['ebay', 'https://www.ebay.com.au'], ['bom', 'https://www.bom.gov.au'],
] as const;
const rows = [];
for (const [site, origin] of sites) {
  const directory = resolve('.data/js-compilation', site === 'openlibrary' ? '' : site);
  const ids = (await readdir(directory)).filter(id => /^\d+-[a-f0-9-]+$/.test(id)).sort();
  const kinds: Record<string, number> = {};
  const traces: GenericNetworkTrace[] = [];
  let invalidBundles = 0, htmlSnapshotsWithoutRecorderIdentity = 0, jsonExchanges = 0;
  let unsupportedOrRedactedExchanges = 0, nonSuccessCaptures = 0, separateOriginJson = 0;
  let retainedJsonExchanges = 0, omittedGetRequestBodies = 0, redactedJsonResponses = 0;
  const captureIds: string[] = [];
  for (const id of ids) {
    let capture: any;
    try { capture = await loadEvidenceBundle(directory, id); } catch { invalidBundles++; continue; }
    const kind = typeof capture.kind === 'string' ? capture.kind : 'unlabelled';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (kind === 'direct-response-capture' && capture.response?.body) htmlSnapshotsWithoutRecorderIdentity++;
    if (kind !== 'known-page-network-capture') continue;
    captureIds.push(id);
    if (capture.httpStatus && capture.httpStatus !== 200) nonSuccessCaptures++;
    if (!capture.input || !Array.isArray(capture.exchanges)) continue;
    const exchanges: CapturedExchange[] = [];
    for (const exchange of capture.exchanges) {
      if (exchange.responseBody?.format === 'html') htmlSnapshotsWithoutRecorderIdentity++;
      if (exchange.responseBody?.format === 'json') retainedJsonExchanges++;
      if (exchange.method === 'GET' && exchange.requestBody === '[OMITTED]') omittedGetRequestBodies++;
      // JSON-only compatibility check; sanitized serialization is not proof of
      // exact wire bytes or successful fresh execution. Never restore secrets.
      if (exchange.responseBody?.format !== 'json' ||
        !(exchange.requestBody === '' || exchange.requestBody?.format === 'json')) {
        unsupportedOrRedactedExchanges++; continue;
      }
      const body = JSON.stringify(exchange.responseBody.data);
      const request = exchange.requestBody === '' ? '' : JSON.stringify(exchange.requestBody.data);
      if (body && /\[(?:OMITTED|REDACTED)\]/.test(body)) redactedJsonResponses++;
      if (!body || request === undefined || /\[(?:OMITTED|REDACTED)\]/.test(request)) {
        unsupportedOrRedactedExchanges++; continue;
      }
      try { if (new URL(exchange.url).origin !== origin) separateOriginJson++; } catch { continue; }
      jsonExchanges++;
      exchanges.push({ ...exchange, requestBody: request, responseBody: body });
    }
    traces.push({ input: capture.input, exchanges });
  }
  let pairsChecked = 0, pairsWithAdmittedResources = 0, maximumAdmittedResources = 0;
  for (let a = 0; a < traces.length; a++) for (let b = a + 1; b < traces.length; b++) {
    if (isDeepStrictEqual(traces[a]!.input, traces[b]!.input)) continue;
    pairsChecked++;
    const pair = [traces[a]!, traces[b]!];
    let count = 0;
    try { count += compileGenericJsonCandidatesFromTraces('audit_read', pair,
      { workflowOrigin: origin, allowPathInputs: true, allowedNetworkOrigins: [origin] }).length; } catch { /* No direct admission. */ }
    try { count += compileObservedJsonResources('audit_read', pair,
      { workflowOrigin: origin, allowedNetworkOrigins: [origin] }).length; } catch { /* No scalar-resource admission. */ }
    if (count) pairsWithAdmittedResources++;
    maximumAdmittedResources = Math.max(maximumAdmittedResources, count);
  }
  rows.push({site, bundles: ids.length, invalidBundles, kinds, captureIds,
    retainedJsonExchanges, omittedGetRequestBodies, redactedJsonResponses,
    htmlSnapshotsWithoutRecorderIdentity, jsonExchanges, separateOriginJson,
    unsupportedOrRedactedExchanges, nonSuccessCaptures, pairsChecked,
    pairsWithAdmittedResources, maximumAdmittedResources,
    modelCalls: 0, browserRuns: 0, networkRequests: 0, compilationProven: false});
}
const report = { scope: 'Offline saved-evidence compatibility audit, not live compilation or site correctness. Same-origin admission only; no permissions inferred from observed traffic.',
  limitations: ['Older direct-response snapshots lack recorder identity; no HTML provenance synthesized.',
    'JSON serialization restored from sanitized values only; no original wire-byte or response-prefix claim.',
    'Redacted JSON response fields remain redacted; requests with redacted bodies are not restored. Historical omitted GET bodies are not guessed empty.',
    'Counts can include overlapping resource candidates; no output-contract or model test performed.',
    'No production demonstrations repeated. These findings do not overwrite historical experimental results.'], rows };
const path = resolve('bench/runs/2026-09-08/saved-production-evidence-audit.json');
await mkdir(resolve('bench/runs/2026-09-08'), {recursive:true});
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({report:path,rows:rows.map(({site,bundles,invalidBundles,jsonExchanges,separateOriginJson,pairsChecked,pairsWithAdmittedResources,htmlSnapshotsWithoutRecorderIdentity,nonSuccessCaptures})=>
  ({site,bundles,invalidBundles,jsonExchanges,separateOriginJson,pairsChecked,pairsWithAdmittedResources,htmlSnapshotsWithoutRecorderIdentity,nonSuccessCaptures}))},null,2));
