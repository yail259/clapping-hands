import assert from "node:assert/strict";
import test from "node:test";
import { capturedRequestContractDiagnostic, requestContractError } from "../src/request-contract-diagnostic.js";

test("request contract mismatch reports template paths but never values or newly observed keys", () => {
  const error = requestContractError({ query: {}, body: { variables: { stable: "before-secret" }, "private@example.com": 1 } },
    { query: {}, body: { variables: { stable: "after-secret", "remote-secret-key": "secret-value" }, "private@example.com": 2 } });
  const result = capturedRequestContractDiagnostic(error)!;
  assert.deepEqual(result.differences, [
    { source: "body", path: ["variables"], kind: "shape" },
    { source: "body", path: ["variables", "stable"], kind: "constant" },
    { source: "body", path: ["[redacted-key]"], kind: "constant" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|example/);
  assert.equal(JSON.stringify(error), "{}");
  result.differences.length = 0;
  assert.equal(capturedRequestContractDiagnostic(error)!.differences.length, 3);
  assert.equal(capturedRequestContractDiagnostic(new Error("secret")), undefined);
  assert.equal(capturedRequestContractDiagnostic(new Proxy({}, { getPrototypeOf() { throw new Error("secret"); } })), undefined);
});

test("request contract diagnostic is bounded and reports truncation", () => {
  const before = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ["field" + index, index]));
  const after = Object.fromEntries(Object.keys(before).map((key) => [key, -1]));
  const result = capturedRequestContractDiagnostic(requestContractError({ query: {}, body: before }, { query: {}, body: after }))!;
  assert.equal(result.differences.length, 20);
  assert.equal(result.truncated, true);
});

test("request contract diagnostic bounds deep trees without recursive subtree equality", () => {
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  let left = before, right = after;
  for (let depth = 0; depth < 5000; depth++) {
    const nextLeft = {}, nextRight = {};
    left.next = nextLeft; right.next = nextRight;
    left = nextLeft; right = nextRight;
  }
  left.value = "before-private-secret"; right.value = "after-private-secret";
  const error = requestContractError({ query: {}, body: before }, { query: {}, body: after });
  const diagnostic = capturedRequestContractDiagnostic(error)!;
  assert.equal(diagnostic.truncated, true);
  assert.ok(diagnostic.differences.every((difference) => difference.path.length <= 12));
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret/);
  assert.equal(JSON.stringify(error), "{}");
});

test("request contract diagnostic shares its node budget with broad key inspection and never visits unexpected remote values", () => {
  let reads = 0;
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  for (let index = 0; index < 10_000; index++) {
    Object.defineProperty(before, "field" + index, { enumerable: true, get() { reads++; return index; } });
    Object.defineProperty(after, "unexpected-remote-secret-" + index, { enumerable: true, get() { throw new Error("remote-secret-value must not be read"); } });
  }
  const diagnostic = capturedRequestContractDiagnostic(requestContractError({ query: {}, body: before }, { query: {}, body: after }))!;
  assert.equal(diagnostic.truncated, true);
  assert.ok(diagnostic.differences.length <= 20);
  assert.equal(reads, 0, "Budget exhaustion during key inspection must stop before reading child values");
  assert.doesNotMatch(JSON.stringify(diagnostic), /unexpected|remote|secret/);
  const remoteWide = capturedRequestContractDiagnostic(requestContractError({ query: {}, body: { known: 1 } }, { query: {}, body: after }))!;
  assert.equal(remoteWide.truncated, true);
  assert.doesNotMatch(JSON.stringify(remoteWide), /unexpected|remote|secret/);
});

test("request contract diagnostic does not eagerly read queued values after exhausting the difference cap", () => {
  let reads = 0;
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  for (let index = 0; index < 100; index++) {
    Object.defineProperty(before, "field" + index, { enumerable: true, get() { reads++; return index; } });
    after["field" + index] = -1;
  }
  const diagnostic = capturedRequestContractDiagnostic(requestContractError({ query: {}, body: before }, { query: {}, body: after }))!;
  assert.equal(diagnostic.differences.length, 20); assert.equal(diagnostic.truncated, true);
  assert.equal(reads, 20, "Unvisited descendant getters must not execute after the difference limit");
});

test("request contract diagnostic preserves shallow array paths and stops before reading beyond maximum depth", () => {
  let reads = 0;
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  let left = before, right = after;
  for (let depth = 0; depth < 12; depth++) {
    const nextLeft = {}, nextRight = {};
    left.next = nextLeft; right.next = nextRight;
    left = nextLeft; right = nextRight;
  }
  Object.defineProperty(left, "beyond", { enumerable: true, get() { reads++; throw new Error("private-too-deep"); } });
  Object.defineProperty(right, "beyond", { enumerable: true, get() { reads++; throw new Error("private-too-deep"); } });
  const diagnostic = capturedRequestContractDiagnostic(requestContractError({ query: { q: ["before"] }, body: before },
    { query: { q: ["after"] }, body: after }))!;
  assert.deepEqual(diagnostic.differences, [{ source: "query", path: ["q", 0], kind: "constant" }]);
  assert.equal(diagnostic.truncated, true); assert.equal(reads, 0);
});
