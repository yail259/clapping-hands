import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Page, Response } from "playwright-core";
import { NetworkRecorder } from "../src/network-recorder.js";
import { capturedSessionHeaders } from "../src/ephemeral-request-headers.js";

function fixture() {
  const page = Object.assign(new EventEmitter(), { url: () => "https://fixture.invalid/" });
  const recorder = new NetworkRecorder();
  recorder.attach(page as unknown as Page);
  async function emit(count: number, contentType = "application/json") {
    for (let id = 0; id < count; id += 1) {
      const request = {
        method: () => "GET", resourceType: () => "fetch",
        url: () => `https://fixture.invalid/search?item=${id}`,
        postData: () => null, allHeaders: async () => ({}),
      };
      page.emit("response", {
        request: () => request, headers: () => ({ "content-type": contentType }),
        status: () => 200, body: async () => Buffer.from(JSON.stringify({ id })),
      } as unknown as Response);
    }
    await recorder.flush();
  }
  return { recorder, emit, page };
}

test('passive all-origin evidence does not widen the execution recorder allowlist', async () => {
  const {recorder:execution,page}=fixture();execution.setAllowedOrigins(['https://fixture.invalid']);
  const passive=new NetworkRecorder({passiveCrossOriginEvidence:true});passive.attach(page as unknown as Page);
  const request={method:()=> 'GET',resourceType:()=> 'fetch',url:()=> 'https://search-service.invalid/read',postData:()=>null,allHeaders:async()=>({})};
  page.emit('response',{request:()=>request,headers:()=>({'content-type':'application/json'}),status:()=>200,body:async()=>Buffer.from('{"items":[]}')});
  await Promise.all([execution.flush(),passive.flush()]);
  assert.equal(execution.latest().length,0);assert.equal(passive.latest().length,1);
});

test("recorder separates session headers from serializable captures and excludes cookies", async () => {
  const { recorder, page } = fixture();
  page.emit("response", {
    request: () => ({ method: () => "GET", resourceType: () => "fetch", url: () => "https://fixture.invalid/search", postData: () => null,
      allHeaders: async () => ({ "x-csrf-token": "private-csrf", cookie: "private-cookie", authorization: "private-bearer" }) }),
    headers: () => ({ "content-type": "application/json" }), status: () => 200,
    body: async () => Buffer.from('{"items":[]}'),
  });
  await recorder.flush();
  const exchange = recorder.latest()[0]!;
  assert.deepEqual(exchange.requestHeaders, {});
  assert.deepEqual(capturedSessionHeaders(exchange), { "x-csrf-token": "private-csrf" });
  assert.doesNotMatch(JSON.stringify(recorder.latest()), /private-/);
  assert.deepEqual(capturedSessionHeaders(structuredClone(exchange)), {});
});

test("compiled browser-network traffic never becomes later demonstration evidence", async () => {
  const { recorder, page } = fixture();
  const request = { method: () => "GET", resourceType: () => "fetch", url: () => "https://fixture.invalid/search", postData: () => null, allHeaders: async () => ({}) };
  await recorder.withoutReplayEvidence(async () => { page.emit("request", request); });
  // A delayed response remains excluded after the suppression window ends.
  page.emit("response", { request: () => request, headers: () => ({ "content-type": "application/json" }), status: () => 200, body: async () => Buffer.from('{"items":[]}') });
  await recorder.flush();
  assert.deepEqual(recorder.latest(), []);
  await assert.rejects(recorder.withoutReplayEvidence(async () => { throw new Error("fixture"); }));
  const ordinary = { ...request };
  page.emit("request", ordinary);
  page.emit("response", { request: () => ordinary, headers: () => ({ "content-type": "application/json" }), status: () => 200, body: async () => Buffer.from('{"items":[]}') });
  await recorder.flush();
  assert.equal(recorder.latest().length, 1);
});

test("fresh-source provenance binds exact page and request start, not late response completion", async () => {
  const { recorder, page } = fixture();
  const frame = {};
  Object.assign(page, { mainFrame: () => frame });
  const makeRequest = (target = frame) => ({ method: () => "GET", resourceType: () => "fetch", frame: () => target,
    url: () => "https://fixture.invalid/search", postData: () => null, allHeaders: async () => ({}) });
  const respond = (request: ReturnType<typeof makeRequest>) => page.emit("response", { request: () => request,
    headers: () => ({ "content-type": "application/json" }), status: () => 200, body: async () => Buffer.from('{"items":[]}') });
  const oldRequest = makeRequest();
  page.emit("request", oldRequest);
  const mark = recorder.mark();
  respond(oldRequest);
  const beforeStart = performance.now();
  const freshRequest = makeRequest();
  page.emit("request", freshRequest);
  const afterStart = performance.now();
  respond(freshRequest);
  const childRequest = makeRequest({});
  page.emit("request", childRequest); respond(childRequest);
  await recorder.flush();
  const captured = recorder.peekSince(mark);
  assert.equal(captured.length, 3);
  assert.equal(recorder.sourceSince(captured[0]!, mark), undefined);
  const provenance = recorder.sourceSince(captured[1]!, mark)!;
  assert.equal(provenance.page, page);
  assert.ok(provenance.startedAt >= beforeStart && provenance.startedAt <= afterStart);
  assert.equal(recorder.sourceSince(captured[2]!, mark), undefined);
  assert.equal(recorder.sourceSince(structuredClone(captured[1]!), mark), undefined);
  assert.doesNotMatch(JSON.stringify(captured), /startedAt|sequence|mainFrame|provenance/);
});

test("capture markers survive rolling-buffer eviction before their window", async () => {
  const { recorder, emit } = fixture();
  await emit(200);
  const mark = recorder.mark();
  await emit(25);
  const captured = await recorder.since(mark);
  assert.equal(captured.length, 25);
  assert.equal(JSON.parse(captured[0]!.responseBody).id, 0);
  assert.equal(JSON.parse(captured[24]!.responseBody).id, 24);
  assert.equal((await recorder.diagnosticsSince(mark)).capturedResponses, 25);
  assert.equal(recorder.latest().length, 200);
});

test("unfinished response bodies produce bounded failures instead of hanging or partial success", async () => {
  const { recorder, page } = fixture();
  let finish!: (body: Buffer) => void;
  page.emit("response", {
    request: () => ({ method: () => "GET", resourceType: () => "fetch", url: () => "https://fixture.invalid/search", postData: () => null, allHeaders: async () => ({}) }),
    headers: () => ({ "content-type": "application/json" }), status: () => 200,
    body: () => new Promise<Buffer>((done) => { finish = done; }),
  });
  await assert.rejects(recorder.flush(20), /incomplete evidence was refused/);
  assert.equal(recorder.latest().length, 0);
  finish(Buffer.from('{"complete":true}'));
  await recorder.flush();
  assert.equal(recorder.latest().length, 1);
  await assert.rejects(recorder.flush(0), /Invalid capture deadline/);
});

test("an overwritten capture window fails instead of returning a misleading partial trace", async () => {
  const { recorder, emit } = fixture();
  const expired = recorder.mark();
  await emit(201);
  assert.throws(() => recorder.peekSince(expired), /capture window expired/);
  await assert.rejects(recorder.since(expired), /capture window expired/);
  const fresh = recorder.mark();
  await emit(2);
  assert.equal((await recorder.since(fresh)).length, 2);
});

test("diagnostic markers survive eviction and reject incomplete evidence", async () => {
  const { recorder, emit } = fixture();
  const expired = recorder.mark();
  await emit(800, "image/png");
  const fresh = recorder.mark();
  await emit(3, "image/png");
  assert.equal((await recorder.diagnosticsSince(fresh)).outcomes["unsupported-content-type"], 3);
  await assert.rejects(recorder.diagnosticsSince(expired), /diagnostic window expired/);
});
