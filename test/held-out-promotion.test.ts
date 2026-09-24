import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGenericJsonPlanSafety, compileGenericJsonPlan, isStableGenericJsonPlan,
  recordGenericJsonShadow, type GenericJsonPlan, type GenericNetworkDemonstration, type NetworkInput,
} from "../src/generic-network.js";

function demonstration(input: NetworkInput): GenericNetworkDemonstration {
  const url = new URL("https://fixture.invalid/api/search");
  for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
  return { input, exchange: {
    method: "GET", url: url.href, resourceType: "fetch", requestHeaders: { accept: "application/json" },
    requestBody: "", responseStatus: 200, responseBody: JSON.stringify({ result: input.query ?? "ready" }),
  } };
}

function plan(multiple = false): GenericJsonPlan {
  const inputs: NetworkInput[] = multiple
    ? [{ query: "sofa", limit: 3 }, { limit: 5, query: "chair" }]
    : [{ query: "sofa" }, { query: "chair" }];
  return compileGenericJsonPlan("search_items", inputs.map(demonstration));
}

test("training successes and repeated held-out inputs never substitute for two distinct held-out inputs", () => {
  const original = plan();
  let updated = recordGenericJsonShadow(original, { query: "sofa" }, true);
  updated = recordGenericJsonShadow(updated, { query: "chair" }, true);
  assert.equal(updated.status, "provisional");
  assert.equal(isStableGenericJsonPlan(updated), false);
  assert.deepEqual(updated.evidence.successfulShadowInputHashes, updated.evidence.demonstrationInputHashes);
  updated = recordGenericJsonShadow(updated, { query: "lamp" }, true);
  updated = recordGenericJsonShadow(updated, { query: "lamp" }, true);
  assert.equal(updated.status, "provisional");
  updated = recordGenericJsonShadow(updated, { query: "desk" }, true);
  assert.equal(updated.status, "stable");
  assert.equal(isStableGenericJsonPlan(updated), true);
  assert.equal(updated.evidence.successfulShadowCount, 5);
  assert.equal(updated.evidence.successfulShadowInputHashes.length, 4);
  assert.equal(original.evidence.successfulShadowCount, 0, "Recording evidence must not mutate the input plan");
  const restarted = JSON.parse(JSON.stringify(updated)) as GenericJsonPlan;
  assert.doesNotThrow(() => assertGenericJsonPlanSafety(restarted));
  assert.equal(isStableGenericJsonPlan(restarted), true);
});

test("input key order cannot turn training values into held-out evidence or one held-out value into two", () => {
  let updated = plan(true);
  assert.equal(updated.evidence.inputHashVersion, "sorted-flat-v1");
  updated = recordGenericJsonShadow(updated, { limit: 3, query: "sofa" }, true);
  updated = recordGenericJsonShadow(updated, { query: "chair", limit: 5 }, true);
  assert.deepEqual(updated.evidence.successfulShadowInputHashes, updated.evidence.demonstrationInputHashes);
  assert.equal(updated.status, "provisional");
  updated = recordGenericJsonShadow(updated, { query: "lamp", limit: 7 }, true);
  updated = recordGenericJsonShadow(updated, { limit: 7, query: "lamp" }, true);
  assert.equal(updated.evidence.successfulShadowInputHashes.length, 3);
  assert.equal(updated.status, "provisional");
  updated = recordGenericJsonShadow(updated, { limit: 9, query: "desk" }, true);
  assert.equal(isStableGenericJsonPlan(updated), true);
});

test("old unversioned hashes remain readable and retain history but cannot promote without relearning", () => {
  let legacy = recordGenericJsonShadow(recordGenericJsonShadow(plan(), { query: "lamp" }, true), { query: "desk" }, true);
  delete legacy.evidence.inputHashVersion;
  legacy = JSON.parse(JSON.stringify(legacy)) as GenericJsonPlan;
  assert.doesNotThrow(() => assertGenericJsonPlanSafety(legacy));
  assert.equal(legacy.status, "stable", "Safety validation must not rewrite a saved plan");
  assert.equal(isStableGenericJsonPlan(legacy), false);
  const previous = structuredClone(legacy.evidence);
  legacy = recordGenericJsonShadow(legacy, { query: "table" }, true);
  legacy = recordGenericJsonShadow(legacy, { query: "bench" }, true);
  assert.equal(legacy.status, "provisional");
  assert.equal(isStableGenericJsonPlan(legacy), false);
  assert.deepEqual(legacy.evidence.demonstrationInputHashes, previous.demonstrationInputHashes);
  assert.deepEqual(legacy.evidence.successfulShadowInputHashes.slice(0, 2), previous.successfulShadowInputHashes);
  assert.equal(legacy.evidence.successfulShadowCount, previous.successfulShadowCount! + 2);
  assert.equal(legacy.evidence.inputHashVersion, undefined, "Opaque history cannot be silently rebranded as canonical");
});

test("a persisted stable label cannot make training-only, duplicate, or missing evidence qualify", () => {
  const trained = recordGenericJsonShadow(recordGenericJsonShadow(plan(), { query: "sofa" }, true), { query: "chair" }, true);
  trained.status = "stable";
  assert.equal(isStableGenericJsonPlan(trained), false);
  assert.equal(recordGenericJsonShadow(trained, { query: "sofa" }, true).status, "provisional");
  const duplicate = recordGenericJsonShadow(plan(), { query: "lamp" }, true);
  duplicate.status = "stable";
  duplicate.evidence.successfulShadowInputHashes.push(duplicate.evidence.successfulShadowInputHashes[0]!);
  duplicate.evidence.successfulShadowCount = 2;
  assert.equal(isStableGenericJsonPlan(duplicate), false);
  const missing = plan(); missing.status = "stable";
  assert.equal(isStableGenericJsonPlan(missing), false);
});

test("a failed shadow preserves history but cannot be revived by stale successful evidence", () => {
  let updated = recordGenericJsonShadow(recordGenericJsonShadow(plan(), { query: "lamp" }, true), { query: "desk" }, true);
  const successes = structuredClone(updated.evidence.successfulShadowInputHashes);
  updated = recordGenericJsonShadow(updated, { query: "table" }, false);
  assert.equal(updated.status, "degraded");
  assert.equal(updated.evidence.failedShadowCount, 1);
  assert.deepEqual(updated.evidence.successfulShadowInputHashes, successes);
  updated = recordGenericJsonShadow(updated, { query: "bench" }, true);
  assert.equal(updated.status, "degraded");
  assert.equal(isStableGenericJsonPlan(updated), false);
  updated.status = "stable";
  assert.equal(isStableGenericJsonPlan(updated), false, "A forged status must not erase a recorded validation failure");
});

test("zero-argument workflows cannot claim two distinct held-out inputs through repeated execution", () => {
  let updated = compileGenericJsonPlan("check_status", [demonstration({}), demonstration({})]);
  updated = recordGenericJsonShadow(updated, {}, true);
  updated = recordGenericJsonShadow(updated, {}, true);
  assert.equal(updated.evidence.successfulShadowCount, 2);
  assert.equal(updated.evidence.successfulShadowInputHashes.length, 1);
  assert.equal(updated.status, "provisional");
  assert.equal(isStableGenericJsonPlan(updated), false);
});

test("malformed evidence fails safety checks and never qualifies through the stability predicate", () => {
  for (const patch of [
    { inputHashVersion: "future-unknown" }, { demonstrationInputHashes: ["not-a-hash"] },
    { successfulShadowInputHashes: null }, { successfulShadowCount: -1 },
    { failedShadowCount: Number.NaN }, { lastValidatedAt: "private malformed value" },
  ]) {
    const damaged = plan(); Object.assign(damaged.evidence, patch); damaged.status = "stable";
    assert.throws(() => assertGenericJsonPlanSafety(damaged), /^Error: Invalid compiled network promotion evidence\.$/);
    assert.equal(isStableGenericJsonPlan(damaged), false);
  }
});

test("shadow recording refuses invalid input keys or nonscalar/nonfinite input values", () => {
  for (const input of [{}, { query: "lamp", extra: true }, { query: Number.NaN }, { query: {} }]) {
    assert.throws(() => recordGenericJsonShadow(plan(), input as NetworkInput, true), /Shadow input does not match/);
  }
});
