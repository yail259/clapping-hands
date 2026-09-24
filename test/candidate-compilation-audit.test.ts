import assert from "node:assert/strict";
import test from "node:test";
import { rememberSessionHeaders } from '../src/ephemeral-request-headers.js';
import { compileGenericJsonCandidatesFromTraces, compileGenericJsonPlan,
  type CandidateCompilationAudit, type GenericNetworkTrace } from "../src/generic-network.js";

// In-memory owned evidence only. Every exchange passes the input/output filters.
// A common stable request is valid; the other requests have deliberately
// incompatible nested marker shapes across demonstrations. No live calls,
// browser, models, provider credentials or private captured outputs are used.
function traces(choices: number, validFirst = false): GenericNetworkTrace[] {
  return ["private alpha", "private bravo", "private charlie", "private delta"].map((query, demo) => {
    const exchange = (option: number, valid: boolean) => ({
      method: "POST", url: "https://fixture.invalid/api/search", resourceType: "fetch",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({ query, marker: valid ? "stable" : { [`noise${demo}_${option}`]: "private marker" } }),
      responseStatus: 200, responseBody: JSON.stringify({ items: [{ title: `Owned result ${query}` }] }),
    });
    const noise = Array.from({ length: choices - 1 }, (_, option) => exchange(option, false));
    const valid = exchange(choices - 1, true);
    return { input: { query }, outputText: `Owned result ${query}`, exchanges: validFirst ? [valid, ...noise] : [...noise, valid] };
  });
}

function auditRun(evidence: GenericNetworkTrace[]) {
  let audit: CandidateCompilationAudit | undefined;
  let callbacks = 0;
  let candidates = 0;
  let failed = false;
  try {
    candidates = compileGenericJsonCandidatesFromTraces("search", evidence, { experimentalRuntimeContext: true,
      onAudit(value) { callbacks++; audit = value; } }).length;
  } catch { failed = true; }
  assert.equal(callbacks, 1); assert.ok(audit);
  const encoded = JSON.stringify(audit);
  assert.doesNotMatch(encoded, /private|fixture|https?:|noise|Owned|marker|stable|requestBody|responseBody/);
  assert.ok(encoded.length < 768);
  assert.deepEqual(Object.keys(audit).sort(), ["traceCount", "capturedCounts", "eligibleCounts", "sharedGroups",
    "preShortlistEligibleCounts", "shortlistDiscardedCounts", "attemptedCombinations", "truncatedGroups",
    "compiledPlans", "returnedCandidates", "rejections", "prefilterRejections"].sort());
  assert.ok(Object.keys(audit.rejections).every((key) => ["operation", "input-binding", "unbound-dynamic", "secret-constant",
    "mutation-shaped", "runtime-type", "runtime-context-required", "response-framing", "request-codec", "network-origin", "other"].includes(key)));
  const counts = [audit.traceCount, ...audit.capturedCounts, ...audit.eligibleCounts,
    ...audit.preShortlistEligibleCounts, ...audit.shortlistDiscardedCounts, audit.sharedGroups,
    audit.attemptedCombinations, audit.truncatedGroups, audit.compiledPlans, audit.returnedCandidates, ...Object.values(audit.rejections)];
  assert.ok(counts.every((value) => Number.isSafeInteger(value) && value >= 0));
  const { prefilterRejections, ...remainingAudit } = audit;
  assert.ok(prefilterRejections);
  assert.ok(Object.values(prefilterRejections).every(value => Number.isSafeInteger(value) && value >= 0));
  return { audit: remainingAudit, prefilterRejections, candidates, failed };
}

test("candidate audit exposes four-demo Cartesian truncation without claiming all valid tuples were examined", () => {
  const evidence = traces(3);
  // The valid tuple is [2,2,2,2], the 81st depth-first tuple. It is admissible
  // on its own but lies outside the current 64-tuple prefix.
  assert.doesNotThrow(() => compileGenericJsonPlan("search", evidence.map((trace) => ({
    input: trace.input, exchange: trace.exchanges[2]!,
  })), { experimentalRuntimeContext: true }));
  const { audit, candidates, failed } = auditRun(evidence);
  assert.equal(failed, true); assert.equal(candidates, 0);
  assert.deepEqual(audit, { traceCount: 4, capturedCounts: [3, 3, 3, 3], eligibleCounts: [3, 3, 3, 3],
    preShortlistEligibleCounts: [3, 3, 3, 3], shortlistDiscardedCounts: [0, 0, 0, 0],
    sharedGroups: 1, attemptedCombinations: 64, truncatedGroups: 1, compiledPlans: 0, returnedCandidates: 0,
    rejections: { "runtime-type": 64 } });
  // A reordering-only control proves the candidate exists; no cap/guard changes.
  const reordered = auditRun(traces(3, true));
  assert.equal(reordered.failed, false); assert.equal(reordered.candidates, 1);
  assert.equal(reordered.audit.attemptedCombinations, 64); assert.equal(reordered.audit.truncatedGroups, 1);
  assert.equal(reordered.audit.compiledPlans, 1);
});

test("candidate audit reports a complete four-by-two search and preserves ordinary selection", () => {
  const evidence = traces(2);
  const plain = compileGenericJsonCandidatesFromTraces("search", evidence, { experimentalRuntimeContext: true });
  const { audit, candidates, failed } = auditRun(evidence);
  assert.equal(failed, false); assert.equal(candidates, plain.length); assert.equal(candidates, 1);
  assert.deepEqual(audit, { traceCount: 4, capturedCounts: [2, 2, 2, 2], eligibleCounts: [2, 2, 2, 2],
    preShortlistEligibleCounts: [2, 2, 2, 2], shortlistDiscardedCounts: [0, 0, 0, 0],
    sharedGroups: 1, attemptedCombinations: 16, truncatedGroups: 0, compiledPlans: 1, returnedCandidates: 1,
    rejections: { "runtime-type": 15 } });
});

test("candidate audit distinguishes no eligible evidence from an exhausted Cartesian prefix", () => {
  const evidence = traces(3).map((trace) => ({ ...trace, exchanges: trace.exchanges.map((exchange) => ({
    ...exchange, responseBody: JSON.stringify({ configuration: "not rendered" }),
  })) }));
  const { audit, prefilterRejections, candidates, failed } = auditRun(evidence);
  assert.equal(prefilterRejections.responseEvidence, 12);
  assert.equal(failed, true); assert.equal(candidates, 0);
  assert.deepEqual(audit, { traceCount: 4, capturedCounts: [3, 3, 3, 3], eligibleCounts: [0, 0, 0, 0],
    preShortlistEligibleCounts: [0, 0, 0, 0], shortlistDiscardedCounts: [0, 0, 0, 0],
    sharedGroups: 0, attemptedCombinations: 0, truncatedGroups: 0, compiledPlans: 0, returnedCandidates: 0, rejections: {} });
});

test("candidate audit exposes discarded ninth choices separately from Cartesian truncation", () => {
  const evidence = traces(9).slice(0, 2);
  assert.doesNotThrow(() => compileGenericJsonPlan("search", evidence.map((trace) => ({
    input: trace.input, exchange: trace.exchanges[8]!,
  })), { experimentalRuntimeContext: true }));
  const { audit, candidates, failed } = auditRun(evidence);
  assert.equal(failed, true); assert.equal(candidates, 0);
  assert.deepEqual(audit, { traceCount: 2, capturedCounts: [9, 9], preShortlistEligibleCounts: [9, 9],
    shortlistDiscardedCounts: [1, 1], eligibleCounts: [8, 8], sharedGroups: 1,
    attemptedCombinations: 64, truncatedGroups: 0, compiledPlans: 0, returnedCandidates: 0,
    rejections: { "runtime-type": 64 } });
});

test('session-bound request refusal has a count-only category rather than other', () => {
  const evidence=traces(1).slice(0,2);
  for(const trace of evidence) rememberSessionHeaders(trace.exchanges[0]!, {'x-csrf-token':'fixture-private-header'});
  let audit:CandidateCompilationAudit|undefined;
  assert.throws(()=>compileGenericJsonCandidatesFromTraces('search',evidence,{onAudit:value=>{audit=value;}}));
  assert.deepEqual(audit?.rejections,{'runtime-context-required':1});
  assert.doesNotMatch(JSON.stringify(audit),/fixture-private-header|x-csrf-token/);
});
