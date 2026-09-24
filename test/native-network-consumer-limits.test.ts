import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { chromium, type CDPSession, type JSHandle, type Page } from "playwright-core";
import { nativeFailureDiagnostic, nativeNetworkReceipt, NativeNetworkReceiptError } from "../src/native-network-receipt.js";

const LIMIT = 4096;
const TINY = Buffer.from('{"owned":true}');
const SECRET = "controlled-consumer-secret-must-not-leak";
type Mode = "slow-oversize" | "gzip-oversize" | "stalled" | "tiny";
type Slot = { mode: Mode; reads: number; activated: boolean; released: boolean; response?: ServerResponse;
  nativeBytes: number; secondChunkSent: boolean; tailSent: boolean; closedBeforeTail: boolean; closed: Promise<void>; finishClosed: () => void };

/** Finite owned fixtures only. Native stream activation releases the response;
 * genuine native data events release the second oversized chunk. Nothing
 * injects CDP events, changes cache/worker behavior, or refetches body bytes.
 * These assertions bound our retained/serialized data and observed aborts,
 * not total upstream Chromium allocation or instantaneous abort scheduling. */
async function fixture(modes: Mode[]) {
  const slots: Slot[] = modes.map((mode) => {
    let finishClosed!: () => void;
    const closed = new Promise<void>((done) => { finishClosed = done; });
    return { mode, reads: 0, activated: false, released: false, nativeBytes: 0,
      secondChunkSent: false, tailSent: false, closedBeforeTail: false, closed, finishClosed };
  });
  const compressed = gzipSync(Buffer.alloc(64 * 1024, 97));
  assert.ok(compressed.byteLength < LIMIT);
  const release = (slot: Slot) => {
    const response = slot.response;
    if (!slot.activated || slot.released || !response || response.destroyed) return;
    slot.released = true;
    response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store",
      ...(slot.mode === "gzip-oversize" ? { "content-encoding": "gzip", "content-length": compressed.byteLength }
        : slot.mode === "tiny" ? { "content-length": TINY.byteLength } : { "transfer-encoding": "chunked" }) });
    if (slot.mode === "tiny") { slot.tailSent = true; response.end(TINY); }
    else if (slot.mode === "gzip-oversize") { slot.tailSent = true; response.end(compressed); }
    else response.write(Buffer.alloc(slot.mode === "slow-oversize" ? LIMIT / 2 : 16, 97));
  };
  const server = createServer((request, response) => {
    const match = /^\/read\/(\d+)$/.exec(request.url ?? "");
    if (match) {
      const slot = slots[Number(match[1])]; request.resume();
      if (!slot || ++slot.reads > 1) { response.writeHead(409); response.end(); return; }
      slot.response = response;
      response.on("close", () => { slot.closedBeforeTail = !slot.tailSent; slot.finishClosed(); });
      release(slot); return;
    }
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Owned consumer-limit fixture</title>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let document: JSHandle<Document> | undefined;
  let detachments = 0;
  let forbiddenCalls = 0;
  let events = 0;
  let base64Results = 0;
  let oversizedErrorResults = 0;
  let oversizedRepliesOnlyError = true;
  const close = async () => {
    await document?.dispose().catch(() => {}); await browser?.close();
    for (const slot of slots) slot.response?.destroy();
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  };
  try {
    browser = await chromium.launch({ headless: true, timeout: 6000,
      executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    const context = await browser.newContext(); context.setDefaultTimeout(6000);
    const page = await context.newPage(); await page.goto(origin);
    document = await page.evaluateHandle(() => window.document);
    const createSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (...args) => {
      const session = await createSession(...args);
      const selected = new Map<string, Slot>();
      session.on("Network.requestWillBeSent", (event) => {
        const index = slots.findIndex((_, index) => event.request.url === `${origin}/read/${index}`);
        if (index >= 0) selected.set(event.requestId, slots[index]!);
      });
      session.on("Network.dataReceived", (event) => {
        const slot = selected.get(event.requestId); if (!slot) return;
        if (++events > 64) { slot.response?.destroy(); return; }
        slot.nativeBytes += event.dataLength;
        if (slot.mode === "slow-oversize" && slot.nativeBytes >= LIMIT / 2 && !slot.secondChunkSent) {
          slot.secondChunkSent = true; slot.response?.write(Buffer.alloc(LIMIT, 98));
          // The remaining finite logical tail stays unsent. Refusal must abort
          // the request while this HTTP body has not reached EOF.
        }
      });
      const send = session.send.bind(session);
      session.send = (async (method: string, parameters: unknown) => {
        if (["Network.getResponseBody", "Fetch.getResponseBody", "Fetch.takeResponseBodyAsStream", "Network.loadNetworkResource",
          "Network.setCacheDisabled", "Network.setBypassServiceWorker", "Fetch.enable", "IO.read"].includes(method)) {
          forbiddenCalls++; throw new Error(SECRET);
        }
        const result = await send(method as Parameters<CDPSession["send"]>[0], parameters as never);
        if (method === "Network.streamResourceContent") {
          const slot = selected.get((parameters as { requestId: string }).requestId); assert.ok(slot);
          setImmediate(() => { slot.activated = true; release(slot); });
        }
        return result;
      }) as CDPSession["send"];
      const detach = session.detach.bind(session);
      session.detach = async () => { await detach(); detachments++; };
      return session;
    };
    // Inspect only the owned page.evaluate result shape in memory. Never print
    // page text/base64 or alter the value returned to production validation.
    const evaluate = page.evaluate.bind(page) as (callback: any, argument?: any) => Promise<any>;
    page.evaluate = (async (callback: any, argument?: any) => {
      const value = await evaluate(callback, argument);
      if (value && typeof value === "object") {
        if (Object.hasOwn(value, "base64")) base64Results++;
        if (value.error === "response-too-large") {
          oversizedErrorResults++;
          oversizedRepliesOnlyError &&= Object.keys(value).length === 1;
        }
      }
      return value;
    }) as Page["evaluate"];
    const scope = { page, document, documentUrl: page.url() };
    return { page, slots, close,
      run: (index = 0, timeoutMs = 6000) => nativeNetworkReceipt(scope,
        { url: `${origin}/read/${index}`, method: "GET", headers: {} }, { deadlineAt: performance.now() + timeoutMs, maximumBytes: LIMIT }),
      summary: () => ({ detachments, forbiddenCalls, events, base64Results, oversizedErrorResults, oversizedRepliesOnlyError,
        reads: slots.map((slot) => slot.reads), nativeBytes: slots.map((slot) => slot.nativeBytes) }) };
  } catch (error) { await close(); throw error; }
}

async function refusal(operation: Promise<unknown>, code: NativeNetworkReceiptError["code"]) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  assert.ok(failure instanceof NativeNetworkReceiptError);
  assert.equal(failure.code, code);
  const diagnostic = nativeFailureDiagnostic(failure); assert.ok(diagnostic);
  assert.doesNotMatch(String(failure) + JSON.stringify(failure) + JSON.stringify(diagnostic),
    /controlled-consumer-secret|127\.0\.0\.1|https?:|responseHeaders|requestHeaders/);
  assert.ok(JSON.stringify(diagnostic).length < 768);
  return diagnostic;
}

async function closedWithin(slot: Slot) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([slot.closed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Controlled request did not close after refusal.")), 1500);
  })]); } finally { clearTimeout(timer); }
}

test("array-buffer native byte cap aborts a slow oversized response before its tail", { timeout: 20_000 }, async (t) => {
  const f = await fixture(["slow-oversize"]);
  try {
    const diagnostic = await refusal(f.run(), "response-too-large");
    await closedWithin(f.slots[0]!);
    assert.equal(f.slots[0]!.secondChunkSent, true); assert.equal(f.slots[0]!.tailSent, false);
    assert.equal(f.slots[0]!.closedBeforeTail, true);
    assert.ok(diagnostic.nativeObservedBytes > LIMIT); assert.ok(diagnostic.nativeRetainedBytes <= LIMIT);
    assert.equal(f.summary().base64Results, 0); assert.equal(f.summary().forbiddenCalls, 0);
    assert.deepEqual(f.summary().reads, [1]); assert.ok(f.summary().events <= 64);
    t.diagnostic(JSON.stringify({ ...f.summary(), diagnostic }));
  } finally { await f.close(); }
});

test("array-buffer receipt rejects gzip decoded bytes above the limit despite small wire bytes", { timeout: 20_000 }, async (t) => {
  const f = await fixture(["gzip-oversize"]);
  try {
    const diagnostic = await refusal(f.run(), "response-too-large");
    assert.ok(diagnostic.nativeObservedBytes > LIMIT); assert.ok(diagnostic.nativeRetainedBytes <= LIMIT);
    assert.equal(f.summary().base64Results, 0); assert.equal(f.summary().forbiddenCalls, 0);
    assert.deepEqual(f.summary().reads, [1]);
    t.diagnostic(JSON.stringify({ ...f.summary(), diagnostic }));
  } finally { await f.close(); }
});

test("oversized substituted page body is refused before base64 construction or Node delivery", { timeout: 20_000 }, async (t) => {
  const f = await fixture(["tiny"]);
  let counters: JSHandle<{ btoa: number; fromCharCode: number }> | undefined;
  try {
    counters = await f.page.evaluateHandle(({ size, secret }) => {
      const counts = { btoa: 0, fromCharCode: 0 };
      window.btoa = () => { counts.btoa++; throw new Error(secret); };
      const fromCharCode = String.fromCharCode;
      String.fromCharCode = (...codes) => { counts.fromCharCode++; return fromCharCode(...codes); };
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetch(...args); await response.arrayBuffer();
        const changed = new Response(new Uint8Array(size), { status: response.status, headers: response.headers });
        Object.defineProperty(changed, "url", { value: response.url }); return changed;
      };
      return counts;
    }, { size: 64 * 1024, secret: SECRET });
    const diagnostic = await refusal(f.run(), "response-too-large");
    assert.deepEqual(await counters.jsonValue(), { btoa: 0, fromCharCode: 0 });
    assert.equal(diagnostic.nativeObservedBytes, TINY.byteLength);
    assert.equal(f.summary().base64Results, 0); assert.equal(f.summary().oversizedErrorResults, 1);
    assert.equal(f.summary().oversizedRepliesOnlyError, true);
    assert.equal(f.summary().forbiddenCalls, 0); assert.deepEqual(f.summary().reads, [1]);
    t.diagnostic(JSON.stringify({ ...f.summary(), diagnostic }));
  } finally { await counters?.dispose(); await f.close(); }
});

test("stalled array-buffer body times out and immediately releases the same-page receipt lease", { timeout: 25_000 }, async (t) => {
  const f = await fixture(["stalled", "tiny"]);
  try {
    const diagnostic = await refusal(f.run(0, 4000), "timeout");
    assert.equal(diagnostic.category, "timeout"); assert.equal(diagnostic.pageReadCompleted, false);
    assert.equal(f.slots[0]!.activated, true); assert.equal(f.summary().detachments, 1);
    // Immediate fresh call, no retries/polling to hide a stale page lease.
    const recovered = await f.run(1);
    assert.equal(recovered.bytes.equals(TINY), true);
    assert.equal(f.summary().detachments, 2); assert.equal(f.summary().forbiddenCalls, 0);
    assert.deepEqual(f.summary().reads, [1, 1]);
    await closedWithin(f.slots[0]!); assert.equal(f.slots[0]!.closedBeforeTail, true);
    t.diagnostic(JSON.stringify({ ...f.summary(), diagnostic }));
  } finally { await f.close(); }
});

test("native arrayBuffer rejection reports a fixed safe body-read diagnostic without refetch", { timeout: 20_000 }, async (t) => {
  const f = await fixture(["tiny"]);
  try {
    await f.page.evaluate((secret) => {
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        Object.defineProperty(response, "arrayBuffer", { async value() { throw new Error(secret); } });
        return response;
      };
    }, SECRET);
    const diagnostic = await refusal(f.run(), "transport-failed");
    assert.equal(diagnostic.stage, "page-fetch"); assert.equal(diagnostic.category, "body-read-rejected");
    assert.equal(diagnostic.pageReadCompleted, false); assert.equal(diagnostic.pageMatches, 1);
    assert.equal(f.summary().base64Results, 0); assert.equal(f.summary().forbiddenCalls, 0);
    assert.deepEqual(f.summary().reads, [1]);
    t.diagnostic(JSON.stringify({ ...f.summary(), diagnostic }));
  } finally { await f.close(); }
});
