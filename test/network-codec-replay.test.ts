import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { request, type BrowserContext } from "playwright-core";
import { assertGenericJsonPlanSafety, compileGenericJsonPlan, replayGenericJsonPlan, RequestContextRequiredError, type GenericNetworkDemonstration } from "../src/generic-network.js";

test("compiler learns nested URL inputs and strictly replays prefixed JSON frames", async () => {
  let received = "";
  let incomplete = false;
  const frames = (query: string) => 'for (;;);' + JSON.stringify({ items: [{ title: query + " item" }] }) +
    (incomplete ? "" : '\nfor (;;);{"complete":true}');
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const target = new URLSearchParams(body).get("target")!;
    received = new URL(target, "http://fixture.invalid").searchParams.get("q")!;
    res.setHeader("content-type", "application/x-ndjson"); res.end(frames(received));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const demonstration = (query: string): GenericNetworkDemonstration => ({ input: { query }, exchange: {
    method: "POST", url: origin + "/lookup", resourceType: "fetch", requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
    requestBody: new URLSearchParams({ target: "/search?q=" + encodeURIComponent(query) + "&sort=new" }).toString(),
    responseStatus: 200, responseBody: frames(query),
  } });
  const context = await request.newContext();
  try {
    const dynamic = [demonstration("sofa bed"), demonstration("coffee table")].map((demo, index) => {
      const body = new URLSearchParams(demo.exchange.requestBody);
      body.set("sequence", String(index)); body.set("csrf_token", "fixture-secret-do-not-persist");
      return { ...demo, exchange: { ...demo.exchange, requestBody: body.toString() } };
    });
    assert.throws(() => compileGenericJsonPlan("lookup", dynamic), (error) => {
      assert.ok(error instanceof RequestContextRequiredError);
      assert.deepEqual(error.dynamicFields, [{ source: "body", path: ["sequence", 0] }]);
      assert.deepEqual(error.sensitiveFields, [{ source: "body", path: ["csrf_token", 0] }]);
      assert.doesNotMatch(JSON.stringify(error), /fixture-secret-do-not-persist/);
      return true;
    });
    const plan = compileGenericJsonPlan("lookup", [demonstration("sofa bed"), demonstration("coffee table")]);
    assert.equal(plan.response.codec, "json-lines"); assert.equal(plan.response.records, 2);
    assert.deepEqual(plan.request.bodyUrlFields, [{ name: "target", index: 0 }]);
    assert.doesNotMatch(JSON.stringify(plan), /sofa bed|coffee table/);
    const query = "A&B + # /? = café";
    const stages: string[] = [];
    const result = await replayGenericJsonPlan({ request: context } as unknown as BrowserContext, plan, { query }, undefined, (stage) => stages.push(stage));
    assert.deepEqual(stages, ["plan-validation", "context-consumption", "request-materialization", "transport", "http-validation", "response-body", "response-decoding", "response-validation"]);
    assert.equal(received, query);
    assert.deepEqual(result.data, [{ items: [{ title: query + " item" }] }, { complete: true }]);
    incomplete = true;
    await assert.rejects(replayGenericJsonPlan({ request: context } as unknown as BrowserContext, plan, { query }), /declared codec|frame count/);
    const tampered = structuredClone(plan); tampered.response.records = 0;
    assert.throws(() => assertGenericJsonPlanSafety(tampered), /frame count/);
    const redirected = structuredClone(plan);
    (redirected.request.bodyTemplate as Record<string, Array<{ pathname: string }>>).target![0]!.pathname = "//evil.test";
    assert.throws(() => assertGenericJsonPlanSafety(redirected), /nested URL template/);
  } finally { await context.dispose(); await new Promise<void>((done) => server.close(() => done())); }
});
