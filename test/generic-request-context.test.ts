import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { request, type BrowserContext } from "playwright-core";
import { assertGenericJsonPlanSafety, captureGenericRequestContext, compileGenericJsonPlan, compileGenericJsonFromTraces, replayGenericJsonPlan, type GenericNetworkDemonstration } from "../src/generic-network.js";
import { RequestContextVault } from "../src/request-context.js";
import { WorkflowAccessError } from "../src/workflow-auth.js";

test("runtime-context compilation validates sources and performs a bounded secret-free replay", async () => {
  let requests = 0;
  const used = new Set<string>();
  const server = createServer(async (req, res) => {
    requests++;
    let body = ""; for await (const chunk of req) body += String(chunk);
    const values = new URLSearchParams(body);
    const token = values.get("csrf_token")!;
    res.setHeader("content-type", "application/json");
    if (used.has(token)) { res.statusCode = 403; res.end('{}'); return; }
    used.add(token);
    res.end(JSON.stringify({ items: [{ title: values.get("search") + " listing" }] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const demo = (search: string, sequence: string, token: string): GenericNetworkDemonstration => ({ input: { search }, exchange: {
    method: "POST", url: origin + "/read", resourceType: "fetch", requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
    requestBody: new URLSearchParams({ search, sequence, csrf_token: token, operation: "SearchItems", __dyn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" }).toString(),
    responseStatus: 200, responseBody: JSON.stringify({ items: [{ title: search + " listing" }] }),
  } });
  const api = await request.newContext();
  const context = { request: api } as unknown as BrowserContext;
  let now = 100;
  const vault = new RequestContextVault(() => now);
  try {
    const a = demo("sofa", "1", "fixture-secret-a"), b = demo("desk", "2", "fixture-secret-b");
    assert.throws(() => compileGenericJsonPlan("search", [a, b]), /Unbound dynamic/);
    const plan = compileGenericJsonPlan("search", [a, b], { experimentalRuntimeContext: true });
    const traced = compileGenericJsonFromTraces("search", [a, b].map((item) => ({ input: item.input, exchanges: [item.exchange], outputText: item.input.search + " listing" })), { experimentalRuntimeContext: true });
    assert.deepEqual(traced.plan.request, plan.request);
    assert.doesNotMatch(JSON.stringify(plan), /fixture-secret|sofa|desk|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
    assert.equal(plan.request.runtimeFields?.length, 3);
    await assert.rejects(replayGenericJsonPlan(context, plan, { search: "chair" }), /Fresh validated/);
    assert.equal(requests, 0);
    const capture = (source = b) => captureGenericRequestContext(context, plan, source.exchange, source.input, "epoch-1", vault);
    for (const change of [
      { url: origin + "/other" }, { url: "https://other.invalid/read" }, { method: "GET" }, { responseStatus: 403 },
      { requestBody: b.exchange.requestBody.replace("SearchItems", "OtherOperation") },
      { requestBody: b.exchange.requestBody + "&extra=1" },
      { requestBody: b.exchange.requestBody.replace("search=desk", "search=wrong") },
    ]) assert.throws(() => capture({ ...b, exchange: { ...b.exchange, ...change } }), /match/);
    const ticket = capture();
    assert.doesNotMatch(JSON.stringify(ticket), /fixture-secret/);
    const otherPlan = structuredClone(plan); otherPlan.request.endpointPath = "/other";
    await assert.rejects(replayGenericJsonPlan(context, otherPlan, { search: "chair" }, ticket), /out of scope/);
    await assert.rejects(replayGenericJsonPlan({ request: api } as unknown as BrowserContext, plan, { search: "chair" }, ticket), /out of scope/);
    assert.equal(requests, 0);
    const result = await replayGenericJsonPlan(context, plan, { search: "chair" }, ticket);
    assert.deepEqual(result.data, { items: [{ title: "chair listing" }] });
    assert.equal(result.navigations, 0); assert.equal(result.requests, 1);
    await assert.rejects(replayGenericJsonPlan(context, plan, { search: "lamp" }, ticket), /unavailable/);
    assert.equal(requests, 1);
    // Reacquiring an already consumed site token cannot make it reusable.
    await assert.rejects(replayGenericJsonPlan(context, plan, { search: "lamp" }, capture()), (error) => error instanceof WorkflowAccessError && error.reason === "http-403");
    const refreshed = capture(demo("desk", "3", "fixture-secret-fresh"));
    assert.deepEqual((await replayGenericJsonPlan(context, plan, { search: "lamp" }, refreshed)).data, { items: [{ title: "lamp listing" }] });
    const expired = capture(); now += 5000;
    await assert.rejects(replayGenericJsonPlan(context, plan, { search: "lamp" }, expired), /stale/);
    assert.equal(requests, 3);
    const tampered = structuredClone(plan);
    (tampered.request.bodyTemplate as Record<string, unknown>).csrf_token = ["fixture-secret-leak"];
    assert.throws(() => assertGenericJsonPlanSafety(tampered), /null placeholders/);
    const mutation = [a, b].map((item) => ({ ...item, exchange: { ...item.exchange, requestBody: item.exchange.requestBody.replace("SearchItems", "SearchHistoryMutation") } }));
    assert.throws(() => compileGenericJsonPlan("search", mutation, { experimentalRuntimeContext: true }), /Mutation-shaped/);
    const drift = { ...b, exchange: { ...b.exchange, requestBody: b.exchange.requestBody.replace("SearchItems", "OtherOperation") } };
    assert.throws(() => compileGenericJsonPlan("search", [a, drift], { experimentalRuntimeContext: true }), /Operation identity/);
  } finally {
    await api.dispose(); await new Promise<void>((done) => server.close(() => done()));
  }
});
