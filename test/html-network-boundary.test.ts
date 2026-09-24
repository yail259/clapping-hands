import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { NetworkRecorder } from "../src/network-recorder.js";
import { browserDecodedResponseText, rememberBrowserDecodedResponse } from "../src/captured-response.js";
import type { CapturedExchange } from "../src/captured-exchange.js";
import type { OutputRecipe } from "../src/learned-output.js";
import { compileGenericJsonCandidatesFromTraces, assertGenericJsonPlanSafety, replayGenericJsonPlan } from "../src/generic-network.js";
import { decodeGenericCapturedResponse } from "../src/network-response.js";
import { projectContractValue } from "../src/response-contract.js";
import type { ResponseSchema, ValueProjection } from "../src/response-contract.js";
import { WorkflowAccessError } from "../src/workflow-auth.js";
import { HtmlResponseError } from "../src/html-response.js";

const origin = "https://fixture.invalid";
const recipe: OutputRecipe = { region: "#result", item: "input", fields: [{ name: "amount", selector: "", source: "value", line: null }] };
const html = (value: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body><main>
  <section id="result"><label for="calculated">Equivalent cost</label><input id="calculated" readonly value="${value}"></section>
  </main></body></html>`;

function exchange(input: number, value: string, body = html(value)): CapturedExchange {
  const result: CapturedExchange = { url: origin + "/calculate", method: "POST", resourceType: "document",
    requestHeaders: { "content-type": "application/x-www-form-urlencoded" }, requestBody: `amount=${input}`,
    responseStatus: 200, responseHeaders: { "content-type": "text/html; charset=utf-8" }, responseBody: body };
  rememberBrowserDecodedResponse(result, body);
  return result;
}
function candidates() {
  return compileGenericJsonCandidatesFromTraces("html_calculation", [1, 2].map((input) => ({ input: { amount: input },
    exchanges: [exchange(input, String(input * 10))], outputText: "Equivalent cost", outputRows: [{ amount: String(input * 10) }] })),
  { workflowOrigin: origin, htmlOutputRecipe: recipe });
}

test("document capture is scoped at request start, main-frame only, and keeps browser-decoded text privately", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { url: () => origin, mainFrame: () => frame });
  const recorder = new NetworkRecorder(); recorder.setAllowedOrigins([origin]); recorder.attach(page as unknown as Page);
  const request = (overrides = {}) => ({ method: () => "POST", resourceType: () => "document", frame: () => frame,
    isNavigationRequest: () => true, redirectedFrom: () => null, url: () => origin + "/calculate", postData: () => "amount=1",
    allHeaders: async () => ({ "content-type": "application/x-www-form-urlencoded", cookie: "private-cookie" }), ...overrides });
  // Chromium decodes the document itself; the client protocol returns that text
  // re-encoded as UTF-8 even when the transport declared a legacy charset.
  const respond = (req: ReturnType<typeof request>) => page.emit("response", { request: () => req,
    status: () => 200, headers: () => ({ "content-type": "text/html; charset=iso-8859-1", "set-cookie": "private-cookie" }),
    body: async () => Buffer.from("<!doctype html><input readonly value='\u20ac 10'>", "utf8") });
  const outside = request(); page.emit("request", outside); respond(outside);
  let accepted!: ReturnType<typeof request>;
  const mark = recorder.mark();
  await recorder.withDocumentResponses(async () => {
    accepted = request(); page.emit("request", accepted);
    for (const rejected of [request({ frame: () => ({}) }), request({ redirectedFrom: () => outside }), request({ isNavigationRequest: () => false })]) {
      page.emit("request", rejected); respond(rejected);
    }
  });
  respond(accepted); // Scope ended, but request-start admission remains valid.
  await recorder.flush();
  const captured = recorder.latest(); assert.equal(captured.length, 1);
  assert.equal(recorder.sourceSince(captured[0]!, mark)?.page, page);
  assert.equal(captured[0]!.responseHeaders?.["content-type"], "text/html; charset=iso-8859-1");
  assert.ok(captured[0]!.responseBody.includes("€ 10"), "the browser's decoded text is retained verbatim");
  assert.doesNotMatch(captured[0]!.responseBody, /â/, "a transport charset must not decode browser text a second time");
  assert.equal(browserDecodedResponseText(captured[0]!), captured[0]!.responseBody);
  assert.equal(browserDecodedResponseText(structuredClone(captured[0]!)), undefined);
  assert.doesNotMatch(JSON.stringify(captured), /private-cookie|"bytes"|"type":"Buffer"/);
  await assert.rejects(recorder.withDocumentResponses(async () => { throw new Error("fixture"); }));
  const later = request(); page.emit("request", later); respond(later); await recorder.flush();
  assert.equal(recorder.latest().length, 1, "throwing a learning attempt does not leave document capture enabled");
});

test("HTML candidates bind typed inputs and exactly matching browser source rows, not static UI labels", async () => {
  const [candidate] = candidates(); assert.ok(candidate);
  assert.equal(candidate.plan.response.codec, "html-input-values");
  assert.equal(candidate.plan.response.htmlRecipe?.kind, "server-html-input-values-v1");
  assert.equal(candidate.plan.request.bodyCodec, "form");
  assert.equal(candidate.plan.request.pagination, undefined);
  assert.deepEqual(decodeGenericCapturedResponse(candidate.plan.response, candidate.demonstrations[0]!.exchange), { rows: [{ amount: "10" }] });
  assert.doesNotMatch(JSON.stringify(candidate.plan), /value=.10|Equivalent cost|<!doctype/);
  const schema: ResponseSchema = { type: "object", properties: { cost: { type: "number", description: "Equivalent cost in dollars" } },
    required: ["cost"], additionalProperties: false };
  const projection: ValueProjection = { kind: "object", fields: { cost: { kind: "value", path: ["rows", 0, "amount"],
    transform: { kind: "number", decimalSeparator: ".", groupSeparator: null, prefix: "", suffix: "", scale: 1 } } } };
  // Legacy stored projections still decode correctly; new learning uses JS.
  assert.deepEqual(projectContractValue(decodeGenericCapturedResponse(candidate.plan.response,candidate.demonstrations[0]!.exchange),projection,schema),{cost:10});
});

test("HTML candidates refuse absent, stale, changed-encoding and serialized-copy browser evidence", () => {
  for (const mode of ["no-rows", "stale-attribute", "copied-evidence", "encoding-drift", "dynamic-request"] as const) {
    const traces = [1, 2].map((input) => {
      let response = exchange(input, mode === "stale-attribute" ? "1" : String(input * 10));
      if (mode === "copied-evidence") response = structuredClone(response);
      if (mode === "encoding-drift" && input === 2) {
        response.responseHeaders!["content-type"] = "text/html; charset=windows-1252";
        response.responseBody = html("20").replace("utf-8", "windows-1252");
        rememberBrowserDecodedResponse(response, response.responseBody);
      }
      if (mode === "dynamic-request") response.requestBody += `&unbound=${input * 3}`;
      return { input: { amount: input }, exchanges: [response], outputText: "Equivalent cost",
        ...(mode !== "no-rows" ? { outputRows: [{ amount: String(input * 10) }] } : {}) };
    });
    assert.throws(() => compileGenericJsonCandidatesFromTraces("html_refusal", traces, { htmlOutputRecipe: recipe }), /No captured/);
  }
});

test("HTML persisted contracts reject mixed codecs, unsupported context, pagination and excessive bounds", () => {
  const plan = candidates()[0]!.plan;
  for (const mutate of [
    (p: typeof plan) => { p.response.codec = "json"; },
    (p: typeof plan) => { delete p.response.htmlRecipe; },
    (p: typeof plan) => { p.response.records = 2; },
    (p: typeof plan) => { p.response.maximumBytes = 1024 * 1024 + 1; },
    (p: typeof plan) => { p.request.transport = "browser-fetch"; },
    (p: typeof plan) => { p.request.endpointOrigin = "https://other.invalid"; },
    (p: typeof plan) => { p.response.htmlRecipe!.fields[0]!.selector = "input[value='private-token']"; },
  ]) { const broken = structuredClone(plan); mutate(broken); assert.throws(() => assertGenericJsonPlanSafety(broken)); }
});

test("network replay decodes fresh HTML without UI, refuses HTTP redirects/access and never leaks response content", async () => {
  const plan = candidates()[0]!.plan;
  let calls = 0, status = 200, body = html("30"), contentType = "text/html; charset=utf-8";
  const context = { request: { fetch: async (_url: string, options: { data: string; maxRedirects: number }) => {
    calls++; assert.equal(options.maxRedirects, 0); assert.equal(options.data, "amount=3");
    return { status: () => status, ok: () => status >= 200 && status < 300, headers: () => ({ "content-type": contentType }),
      body: async () => Buffer.from(body) };
  } } } as unknown as BrowserContext;
  assert.deepEqual((await replayGenericJsonPlan(context, plan, { amount: 3 })).data, { rows: [{ amount: "30" }] });
  body = html("31"); assert.deepEqual((await replayGenericJsonPlan(context, plan, { amount: 3 })).data, { rows: [{ amount: "31" }] });
  assert.equal(calls, 2, "responses are fresh, not a cache of the demonstrated answer");
  for (status of [301, 302, 303, 307, 308, 401, 403, 500]) {
    const before: number = calls;
    await assert.rejects(replayGenericJsonPlan(context, plan, { amount: 3 }), (error) => {
      assert.doesNotMatch(String(error), /<!doctype|value=/);
      if (status === 401 || status === 403) assert.ok(error instanceof WorkflowAccessError);
      return true;
    });
    assert.equal(calls, before + 1);
  }
  status = 200; body = html("private-sentinel").replace("readonly", "name='password' readonly");
  await assert.rejects(replayGenericJsonPlan(context, plan, { amount: 3 }), (error) => !String(error).includes("private-sentinel"));
  body = html("30"); contentType = "application/json";
  await assert.rejects(replayGenericJsonPlan(context, plan, { amount: 3 }));
  // A transport charset change is drift, not a new decoding assumption to adopt.
  contentType = "text/html; charset=iso-8859-1";
  await assert.rejects(replayGenericJsonPlan(context, plan, { amount: 3 }),
    (error) => error instanceof HtmlResponseError && error.reason === "encoding-conflict");
  contentType = "text/html";
  body = html("30").replace("utf-8", "windows-1252");
  await assert.rejects(replayGenericJsonPlan(context, plan, { amount: 3 }),
    (error) => error instanceof HtmlResponseError && error.reason === "encoding-conflict");
  contentType = "text/html; charset=utf-8"; body = html("32");
  assert.deepEqual((await replayGenericJsonPlan(context, plan, { amount: 3 })).data, { rows: [{ amount: "32" }] },
    "refusing drifted encodings does not degrade the unchanged contract");
});
