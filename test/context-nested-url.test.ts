import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import { captureGenericRequestContext, compileGenericJsonPlan, replayGenericJsonPlan, type GenericNetworkDemonstration } from "../src/generic-network.js";
import { RequestContextVault } from "../src/request-context.js";

test("runtime context accepts equivalent nested URL dictionaries without weakening value checks", () => {
  const demo = (query: string, nonce: string): GenericNetworkDemonstration => ({ input: { query }, exchange: {
    method: "POST", url: "https://fixture.invalid/read", resourceType: "fetch",
    requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
    requestBody: new URLSearchParams({ target: "/search?q=" + query + "&sort=new", csrf_token: nonce }).toString(),
    responseStatus: 200, responseBody: JSON.stringify({ title: query + " listing" }),
  } });
  const plan = compileGenericJsonPlan("nested_search", [demo("desk", "fixture-a"), demo("chair", "fixture-b")], { experimentalRuntimeContext: true });
  assert.deepEqual(plan.request.bodyUrlFields, [{ name: "target", index: 0 }]);
  assert.deepEqual(plan.request.runtimeFields, [{ source: "body", path: ["csrf_token", 0], type: "string" }]);
  assert.doesNotMatch(JSON.stringify(plan), /fixture-a|fixture-b|desk|chair/);
  const original = demo("desk", "fixture-fresh");
  for (const target of ["/search?q=wrong&sort=new", "/search?q=desk&sort=old", "/search?q=desk&sort=new&extra=1", "/search?q=desk&q=desk&sort=new"]) {
    const changed = { ...original.exchange, requestBody: new URLSearchParams({ target, csrf_token: "fixture-fresh" }).toString() };
    assert.throws(() => captureGenericRequestContext({} as BrowserContext, plan, changed, original.input, "epoch", new RequestContextVault()), /contract mismatch/);
  }
});

test("context replay preserves only validated same-origin browser session headers in memory", async () => {
  const demo = (query: string) => ({ input: { query }, exchange: {
    method: "GET", url: `https://fixture.invalid/search?q=${query}&csrf_token=fixture-secret`, resourceType: "fetch",
    requestHeaders: { origin: "https://fixture.invalid", referer: "https://fixture.invalid/page", "x-fingerprint": "do-not-copy" },
    requestBody: "", responseStatus: 200, responseBody: '{"ok":true}',
  } });
  const plan = compileGenericJsonPlan("search", [demo("desk"), demo("chair")], { experimentalRuntimeContext: true });
  assert.doesNotMatch(JSON.stringify(plan), /referer|fingerprint|fixture-secret/);
  let sent: unknown;
  const context = { request: { fetch: async (_url: string, options: unknown) => {
    sent = options;
    return { status: () => 200, ok: () => true, headers: () => ({ "content-type": "application/json" }), body: async () => Buffer.from('{"ok":true}') };
  } } } as unknown as BrowserContext;
  const source = demo("desk");
  const capture = () => captureGenericRequestContext(context, plan, source.exchange, source.input, "epoch", new RequestContextVault());
  await replayGenericJsonPlan(context, plan, { query: "lamp" }, capture());
  assert.deepEqual((sent as { headers: unknown }).headers, { origin: "https://fixture.invalid", referer: "https://fixture.invalid/page" });
  for (const referer of ["https://evil.invalid/", "https://user:secret@fixture.invalid/", "https://fixture.invalid/#secret"]) {
    const ticket = capture(); ticket.browserHeaders!.referer = referer;
    await assert.rejects(replayGenericJsonPlan(context, plan, { query: "lamp" }, ticket), /referrer/);
  }
});
