import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import { captureGenericRequestContext, compileGenericJsonPlan, replayGenericJsonPlan, assertGenericJsonPlanSafety } from "../src/generic-network.js";
import { rememberSessionHeaders, capturedSessionHeaders } from "../src/ephemeral-request-headers.js";
import { RequestContextVault } from "../src/request-context.js";

test("session-header-only context compiles references and replays scoped single-use values without serialization", async () => {
  const demo = (query: string, token: string) => {
    const exchange = { method: "GET", url: `https://fixture.invalid/search?q=${query}`, resourceType: "fetch", requestHeaders: {}, requestBody: "",
      responseStatus: 200, responseBody: '{"items":[{"name":"Fixture"}]}' };
    rememberSessionHeaders(exchange, { "x-csrf-token": token, cookie: "do-not-copy", "x-fingerprint": "do-not-copy" });
    return { input: { query }, exchange };
  };
  const demos = [demo("desk", "private-first"), demo("chair", "private-second")];
  assert.throws(() => compileGenericJsonPlan("search", demos), /context/i);
  const plan = compileGenericJsonPlan("search", demos, { experimentalRuntimeContext: true });
  assert.deepEqual(plan.request.runtimeHeaders, ["x-csrf-token"]);
  assert.equal(plan.request.runtimeFields, undefined);
  assert.doesNotMatch(JSON.stringify({ plan, demos }), /private-|do-not-copy/);
  const source = demo("lamp", "private-fresh");
  let sends = 0;
  const context = { request: { fetch: async (_url: string, options: { headers: Record<string, string> }) => {
    sends++;
    assert.deepEqual(options.headers, { "x-csrf-token": "private-fresh" });
    return { status: () => 200, ok: () => true, headers: () => ({ "content-type": "application/json" }), body: async () => Buffer.from(source.exchange.responseBody) };
  } } } as unknown as BrowserContext;
  const vault = new RequestContextVault();
  const ticket = captureGenericRequestContext(context, plan, source.exchange, source.input, "epoch", vault);
  assert.doesNotMatch(JSON.stringify(ticket), /private-fresh/);
  await replayGenericJsonPlan(context, plan, { query: "shelf" }, ticket);
  await assert.rejects(replayGenericJsonPlan(context, plan, { query: "shelf" }, ticket), /stale|scope/);
  assert.equal(sends, 1);
  assert.deepEqual(capturedSessionHeaders(structuredClone(source.exchange)), {});
  assert.throws(() => captureGenericRequestContext(context, plan, structuredClone(source.exchange), source.input, "epoch", new RequestContextVault()), /header contract/);
  for (const runtimeHeaders of [["authorization"], ["cookie"], ["x-fingerprint"], ["x-csrf-token", "x-csrf-token"]]) {
    assert.throws(() => assertGenericJsonPlanSafety({ ...plan, request: { ...plan.request, runtimeHeaders } }), /header contract/);
  }
  assert.throws(() => assertGenericJsonPlanSafety({ ...plan, request: { ...plan.request, endpointOrigin: "https://other.invalid" } }), /same-origin/);
  assert.throws(() => assertGenericJsonPlanSafety({ ...plan, request: { ...plan.request, endpointPath: "/delete" } }), /Mutation-shaped/);
});

test("session header metadata fails closed on changing names and invalid captured values", () => {
  const exchange = { method: "GET", url: "https://fixture.invalid/", resourceType: "fetch", requestHeaders: {}, requestBody: "", responseStatus: 200, responseBody: "{}" };
  for (const token of ["", "line\nbreak", "x".repeat(8193)]) assert.throws(() => rememberSessionHeaders(exchange, { "x-csrf-token": token }), /context contract/);
});
