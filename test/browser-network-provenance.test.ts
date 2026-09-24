import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, type Page, type Request, type Response } from "playwright-core";

// Feasibility experiment ONLY: this collector is not used by production transport.
// All fixture bodies are deliberately small ASCII. CDP getResponseBody buffers
// before returning, and its text mode is not a byte-preservation proof for
// arbitrary encodings. This does not establish a production streaming bound.
const BODY = '{"result":"identical fixture bytes"}';
const MAX_BYTES = 1024;
const MAX_EVENTS = 128;
const MAX_REQUESTS = 16;
const DEADLINE_MS = 5000;
type WorkerMode = "none" | "nonintercepting" | "synthetic" | "cached" | "passthrough";
type Expected = { url: string; method: "GET" | "POST"; body: string | null };
type PageResult = { url: string; status: number; bytes: number[] };
type NativeRequest = {
  requestId: string; frameId?: string; loaderId: string;
  url: string; method: string; body: Buffer | null; bodyKnown: boolean; redirected: boolean;
};
type NativeResponse = {
  url: string; status: number; fromServiceWorker: boolean; fromDiskCache: boolean;
  fromPrefetchCache: boolean; hasExtraInfo: boolean; frameId?: string; loaderId: string;
};
type Receipt = {
  accepted: boolean; reason: string; pageMatches: number; cdpMatches: number;
  pageFromServiceWorker?: boolean; cdpFromServiceWorker?: boolean; browserCache?: boolean;
  bytesEqual?: boolean; networkStatus?: number; eventCount: number;
};

async function bounded<T>(operation: Promise<T>, timeoutMs = DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Controlled provenance deadline exceeded")), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(mode: WorkerMode = "none", revalidate = false) {
  const observed: Array<{ method: string; url: string; body: string }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    if (path === "/read") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > MAX_BYTES) req.destroy();
      });
      req.on("end", () => {
        observed.push({ method: req.method!, url: req.url!, body });
        if (revalidate && req.headers["if-none-match"] === '"controlled-receipt"') {
          res.writeHead(304, { etag: '"controlled-receipt"', "cache-control": "public, max-age=0, must-revalidate" });
          res.end(); return;
        }
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(BODY),
          etag: '"controlled-receipt"',
          "cache-control": revalidate ? "public, max-age=0, must-revalidate" : "public, max-age=3600" });
        res.end(BODY);
      });
      return;
    }
    if (path === "/sw.js") {
      res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      const setup = `const body=${JSON.stringify(BODY)};
        const response=()=>new Response(body,{headers:{'content-type':'application/json'}});
        self.addEventListener('install',event=>event.waitUntil((async()=>{
          ${mode === "cached" ? "await (await caches.open('controlled-receipt')).put('/read',response());" : ""}
          await self.skipWaiting();
        })()));
        self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));`;
      const handler = mode === "synthetic" ? "event.respondWith(response());"
        : mode === "cached" ? "event.respondWith(caches.match('/read'));"
          : mode === "passthrough" ? "event.respondWith(fetch(event.request));" : "";
      res.end(setup + (handler ? `self.addEventListener('fetch',event=>{
        if(new URL(event.request.url).pathname==='/read'){${handler}}
      });` : ""));
      return;
    }
    if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end("<!doctype html><title>Native receipt fixture</title><p>Local controlled read only</p>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext();
  context.setDefaultTimeout(DEADLINE_MS);
  const page = await context.newPage();
  await page.goto(origin);
  if (mode !== "none") {
    await bounded(page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    }));
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  }
  return { page, context, origin, observed,
    close: async () => {
      await browser.close();
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    } };
}

async function read(page: Page, expected: Expected, cache: RequestCache = "no-store"): Promise<PageResult> {
  return page.evaluate(async ({ request, cacheMode }) => {
    const response = await fetch(request.url, { method: request.method, body: request.body,
      cache: cacheMode, redirect: "error", signal: AbortSignal.timeout(2000) });
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    if (bytes.length > 1024) throw new Error("Controlled fixture body limit exceeded");
    return { url: response.url, status: response.status, bytes };
  }, { request: expected, cacheMode: cache });
}

// No marker header/query, interception, cache disabling, cookie manipulation or
// service-worker bypass. Correlation here uses native request identity plus one
// unique exact match in a fully owned, bounded dispatch window. It does not solve
// attribution against arbitrary page code that creates a delayed identical fetch.
async function receipt(page: Page, expected: Expected, dispatch: () => Promise<PageResult[]>): Promise<Receipt> {
  const deadline = performance.now() + DEADLINE_MS;
  const within = <T>(operation: Promise<T>) => bounded(operation, deadline - performance.now());
  const cdp = await within(page.context().newCDPSession(page));
  const mainFrame = page.mainFrame();
  const originalUrl = page.url();
  const identity = await within(page.evaluateHandle(() => ({ document, controller: navigator.serviceWorker.controller })));
  const requests: Request[] = [];
  const responses = new Map<Request, Response>();
  const nativeRequests = new Map<string, NativeRequest>();
  const nativeResponses = new Map<string, NativeResponse>();
  const cacheHits = new Set<string>();
  const extraStatuses = new Map<string, number>();
  const finished = new Set<string>();
  const failed = new Set<string>();
  let eventCount = 0;
  let exceeded = false;
  let changed = false;
  const tick = () => {
    if (++eventCount > MAX_EVENTS) { exceeded = true; return false; }
    return true;
  };
  const onRequest = (request: Request) => {
    if (!tick()) return;
    if (requests.length >= MAX_REQUESTS) { exceeded = true; return; }
    requests.push(request);
  };
  const onResponse = (response: Response) => {
    if (tick() && requests.includes(response.request())) responses.set(response.request(), response);
  };
  const onNavigation = () => { changed = true; };
  type Event = "Network.requestWillBeSent" | "Network.responseReceived" | "Network.requestServedFromCache"
    | "Network.responseReceivedExtraInfo" | "Network.loadingFinished" | "Network.loadingFailed";
  const listeners: Array<[Event, (...args: any[]) => void]> = [];
  let wake: (() => void) | undefined;
  const listen = (event: Event, callback: (...args: any[]) => void) => {
    const limited = (...args: any[]) => { if (tick()) callback(...args); wake?.(); wake = undefined; };
    listeners.push([event, limited]); cdp.on(event, limited);
  };
  const until = async (condition: () => boolean) => {
    while (!condition() && !exceeded) await within(new Promise<void>((done) => { wake = done; }));
  };
  let pageMatches = 0;
  let cdpMatches = 0;
  const result = (reason: string, extra: Partial<Receipt> = {}): Receipt => ({
    accepted: reason === "native-network", reason, pageMatches, cdpMatches, eventCount, ...extra,
  });
  try {
    await within(cdp.send("Page.enable"));
    await within(cdp.send("Network.enable", { maxTotalBufferSize: 64 * 1024,
      maxResourceBufferSize: MAX_BYTES, maxPostDataSize: MAX_BYTES }));
    const { frameTree } = await within(cdp.send("Page.getFrameTree"));
    const frameId = frameTree.frame.id;
    const loaderId = frameTree.frame.loaderId;
    page.on("request", onRequest); page.on("response", onResponse); page.on("framenavigated", onNavigation);
    listen("Network.requestWillBeSent", (event) => {
      if (!nativeRequests.has(event.requestId) && nativeRequests.size >= MAX_REQUESTS) { exceeded = true; return; }
      const prior = nativeRequests.get(event.requestId);
      const entries = event.request.postDataEntries;
      const completeBody = Array.isArray(entries) && entries.length <= MAX_REQUESTS
        && entries.every((entry) => typeof entry.bytes === "string" && entry.bytes.length <= MAX_BYTES * 2);
      const body = completeBody ? Buffer.concat(entries.map((entry) => Buffer.from(entry.bytes, "base64"))) : null;
      nativeRequests.set(event.requestId, { requestId: event.requestId, frameId: event.frameId, loaderId: event.loaderId,
        url: event.request.url, method: event.request.method, body,
        bodyKnown: !event.request.hasPostData || (completeBody && body!.byteLength <= MAX_BYTES),
        redirected: Boolean(prior || event.redirectResponse) });
    });
    listen("Network.responseReceived", (event) => {
      if (nativeResponses.size >= MAX_REQUESTS) { exceeded = true; return; }
      nativeResponses.set(event.requestId, { url: event.response.url, status: event.response.status,
        fromServiceWorker: event.response.fromServiceWorker === true, fromDiskCache: event.response.fromDiskCache === true,
        fromPrefetchCache: event.response.fromPrefetchCache === true, hasExtraInfo: event.hasExtraInfo === true,
        frameId: event.frameId, loaderId: event.loaderId });
    });
    listen("Network.requestServedFromCache", (event) => {
      if (cacheHits.size >= MAX_REQUESTS) { exceeded = true; return; }
      cacheHits.add(event.requestId);
    });
    listen("Network.responseReceivedExtraInfo", (event) => {
      if (extraStatuses.size >= MAX_REQUESTS) { exceeded = true; return; }
      extraStatuses.set(event.requestId, event.statusCode);
    });
    listen("Network.loadingFinished", (event) => {
      if (finished.size >= MAX_REQUESTS) { exceeded = true; return; }
      finished.add(event.requestId);
    });
    listen("Network.loadingFailed", (event) => {
      if (failed.size >= MAX_REQUESTS) { exceeded = true; return; }
      failed.add(event.requestId);
    });
    const values = await within(dispatch());
    // These protocol barriers follow completion of every owned dispatch body;
    // they are not a general network-quiescence proof for arbitrary page code.
    await within(cdp.send("Runtime.evaluate", { expression: "0", returnByValue: true }));
    await within(page.evaluate(() => 0));
    const bodyMatches = (body: Buffer | null) => expected.body === null ? body === null
      : body !== null && body.equals(Buffer.from(expected.body));
    const pageCandidates = requests.filter((request) => request.url() === expected.url
      && request.method() === expected.method && bodyMatches(request.postDataBuffer()));
    const cdpCandidates = [...nativeRequests.values()].filter((request) => request.url === expected.url
      && request.method === expected.method && request.bodyKnown && bodyMatches(request.body));
    pageMatches = pageCandidates.length; cdpMatches = cdpCandidates.length;
    if (exceeded) return result("evidence-limit");
    if (pageMatches !== 1 || cdpMatches !== 1 || values.length !== 1) return result("ambiguous-or-missing-request");
    const request = pageCandidates[0]!;
    const native = cdpCandidates[0]!;
    const response = responses.get(request);
    const nativeResponse = nativeResponses.get(native.requestId);
    if (!response || !nativeResponse) return result("missing-response");
    if (request.serviceWorker() || request.frame() !== mainFrame || native.frameId !== frameId || !loaderId
      || native.loaderId !== loaderId || nativeResponse.frameId !== frameId || nativeResponse.loaderId !== loaderId) {
      return result("wrong-frame-or-document");
    }
    if (request.redirectedFrom() || request.redirectedTo() || native.redirected) return result("redirect");
    await until(() => finished.has(native.requestId) || failed.has(native.requestId));
    if (failed.has(native.requestId) || await within(response.finished())) return result("failed-request");
    if (changed || page.url() !== originalUrl || !await within(page.evaluate((before) => document === before.document
      && navigator.serviceWorker.controller === before.controller, identity))) return result("document-changed");
    // A 304 can appear as responseReceived.status=200. ExtraInfo is the native
    // HTTP status, and may arrive before or after responseReceived.
    if (nativeResponse.hasExtraInfo) await until(() => extraStatuses.has(native.requestId));
    const extraStatus = extraStatuses.get(native.requestId);
    if (nativeResponse.hasExtraInfo && extraStatus === undefined) return result("missing-extra-info");
    const browserCache = cacheHits.has(native.requestId) || nativeResponse.fromDiskCache
      || nativeResponse.fromPrefetchCache || extraStatus === 304;
    const pageFromServiceWorker = response.fromServiceWorker();
    // Deliberately avoid Playwright Response.body(): its Chromium implementation
    // can fetch the resource a second time if the captured body is unavailable.
    const nativeBody = await within(cdp.send("Network.getResponseBody", { requestId: native.requestId }));
    if (!nativeBody.base64Encoded && /[^\x00-\x7f]/.test(nativeBody.body)) return result("unsupported-fixture-encoding");
    const nativeBytes = Buffer.from(nativeBody.body, nativeBody.base64Encoded ? "base64" : "utf8");
    if (nativeBytes.byteLength > MAX_BYTES || values[0]!.bytes.length > MAX_BYTES) return result("body-limit");
    const bytesEqual = nativeBytes.equals(Buffer.from(values[0]!.bytes));
    if (exceeded) return result("evidence-limit");
    const evidence = { pageFromServiceWorker, cdpFromServiceWorker: nativeResponse.fromServiceWorker, browserCache,
      bytesEqual, networkStatus: extraStatus };
    if (pageFromServiceWorker || nativeResponse.fromServiceWorker) return result("service-worker", evidence);
    if (browserCache) return result("browser-cache", evidence);
    if (response.status() !== values[0]!.status || nativeResponse.status !== response.status()
      || response.url() !== expected.url || nativeResponse.url !== expected.url || values[0]!.url !== expected.url || !bytesEqual) {
      return result("response-mismatch", evidence);
    }
    if (changed || page.url() !== originalUrl || !await within(page.evaluate((before) => document === before.document
      && navigator.serviceWorker.controller === before.controller, identity))) return result("document-changed", evidence);
    // Include any matching events arriving while the native body was retrieved,
    // not just the candidates present immediately after page dispatch completed.
    pageMatches = requests.filter((candidate) => candidate.url() === expected.url
      && candidate.method() === expected.method && bodyMatches(candidate.postDataBuffer())).length;
    cdpMatches = [...nativeRequests.values()].filter((candidate) => candidate.url === expected.url
      && candidate.method === expected.method && candidate.bodyKnown && bodyMatches(candidate.body)).length;
    if (exceeded) return result("evidence-limit");
    if (pageMatches !== 1 || cdpMatches !== 1) return result("ambiguous-or-missing-request", evidence);
    return result("native-network", evidence);
  } finally {
    wake = undefined;
    page.off("request", onRequest); page.off("response", onResponse); page.off("framenavigated", onNavigation);
    for (const [event, listener] of listeners) cdp.off(event, listener);
    await identity.dispose();
    await cdp.detach();
  }
}

for (const mode of ["none", "nonintercepting", "synthetic", "cached", "passthrough"] as const) {
  test(`controlled native provenance: ${mode} service worker`, { timeout: 20_000 }, async () => {
    const f = await fixture(mode);
    try {
      const request: Expected = { url: f.origin + "/read", method: mode === "cached" ? "GET" : "POST",
        body: mode === "cached" ? null : "query=owned-fixture" };
      const proof = await receipt(f.page, request, async () => [await read(f.page, request)]);
      const native = mode === "none" || mode === "nonintercepting";
      assert.equal(proof.accepted, native, JSON.stringify(proof));
      assert.equal(proof.reason, native ? "native-network" : "service-worker", JSON.stringify(proof));
      assert.equal(proof.pageFromServiceWorker, !native);
      assert.equal(proof.cdpFromServiceWorker, !native);
      assert.equal(proof.bytesEqual, true, "Identical bytes alone must not establish native delivery");
      assert.equal(proof.pageMatches, 1); assert.equal(proof.cdpMatches, 1);
      assert.equal(f.observed.length, native || mode === "passthrough" ? 1 : 0);
      for (const observed of f.observed) assert.deepEqual(observed, { method: request.method, url: "/read", body: request.body ?? "" });
    } finally { await f.close(); }
  });
}

test("controlled native provenance rejects a real browser HTTP-cache hit with identical bytes", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const request: Expected = { url: f.origin + "/read", method: "GET", body: null };
    await read(f.page, request, "default");
    assert.equal(f.observed.length, 1);
    const proof = await receipt(f.page, request, async () => [await read(f.page, request, "default")]);
    assert.equal(f.observed.length, 1, "The second read must actually avoid the origin server");
    assert.equal(proof.accepted, false); assert.equal(proof.reason, "browser-cache", JSON.stringify(proof));
    assert.equal(proof.browserCache, true); assert.equal(proof.pageFromServiceWorker, false);
    assert.equal(proof.bytesEqual, true);
  } finally { await f.close(); }
});

test("controlled native provenance rejects duplicate identical native requests", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=duplicate" };
    const proof = await receipt(f.page, request, async () => {
      const values = await Promise.all([read(f.page, request), read(f.page, request)]);
      return [values[0]!]; // Only one exposed value: native duplication must still refuse.
    });
    assert.equal(f.observed.length, 2); assert.equal(proof.pageMatches, 2); assert.equal(proof.cdpMatches, 2);
    assert.equal(proof.accepted, false); assert.equal(proof.reason, "ambiguous-or-missing-request");
  } finally { await f.close(); }
});

test("controlled native provenance rejects page bytes that differ from the exact native response", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=byte-mismatch" };
    const proof = await receipt(f.page, request, async () => {
      const value = await read(f.page, request);
      value.bytes[0] = 0; // Simulate a page wrapper exposing bytes other than its native response.
      return [value];
    });
    assert.equal(f.observed.length, 1); assert.equal(proof.pageMatches, 1); assert.equal(proof.cdpMatches, 1);
    assert.equal(proof.bytesEqual, false); assert.equal(proof.accepted, false);
    assert.equal(proof.reason, "response-mismatch");
  } finally { await f.close(); }
});

test("controlled native provenance rejects a revalidated cached body even when page status is 200", { timeout: 20_000 }, async () => {
  const f = await fixture("none", true);
  try {
    const request: Expected = { url: f.origin + "/read", method: "GET", body: null };
    await read(f.page, request, "default");
    const proof = await receipt(f.page, request, async () => {
      const value = await read(f.page, request, "default");
      assert.equal(value.status, 200, "Chromium exposes the combined cached response to the page");
      return [value];
    });
    assert.equal(f.observed.length, 2, "Revalidation itself did reach the origin");
    assert.equal(proof.networkStatus, 304, "ExtraInfo must expose the actual network status");
    assert.equal(proof.accepted, false); assert.equal(proof.reason, "browser-cache", JSON.stringify(proof));
    assert.equal(proof.bytesEqual, true);
  } finally { await f.close(); }
});

test("controlled native provenance rejects same-URL document replacement after a matching fetch", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=reload" };
    const proof = await receipt(f.page, request, async () => {
      const value = await read(f.page, request);
      await f.page.reload();
      return [value];
    });
    assert.equal(f.observed.length, 1); assert.equal(proof.pageMatches, 1); assert.equal(proof.cdpMatches, 1);
    assert.equal(proof.accepted, false); assert.equal(proof.reason, "document-changed");
  } finally { await f.close(); }
});

test("controlled native provenance refuses a bounded fixture burst beyond its evidence cap", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=bounded-burst" };
    const proof = await receipt(f.page, request, async () => {
      const values = await Promise.all(Array.from({ length: MAX_REQUESTS + 1 }, () => read(f.page, request)));
      return [values[0]!];
    });
    assert.equal(f.observed.length, MAX_REQUESTS + 1);
    assert.equal(proof.accepted, false); assert.equal(proof.reason, "evidence-limit");
  } finally { await f.close(); }
});

test("controlled native provenance requires exact method, URL and request body", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=exact" };
    for (const actual of [{ ...request, body: "query=other" }, { ...request, method: "GET" as const, body: null },
      { ...request, url: f.origin + "/different-read" }]) {
      const proof = await receipt(f.page, request, async () => [await read(f.page, actual)]);
      assert.equal(proof.accepted, false); assert.equal(proof.pageMatches, 0); assert.equal(proof.cdpMatches, 0);
    }
  } finally { await f.close(); }
});

test("controlled native provenance cannot borrow an identical same-origin other-page request", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const other = await f.context.newPage(); await other.goto(f.origin);
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=other-page" };
    const proof = await receipt(f.page, request, async () => [await read(other, request)]);
    assert.equal(f.observed.length, 1); assert.equal(proof.pageMatches, 0); assert.equal(proof.cdpMatches, 0);
    assert.equal(proof.accepted, false);
  } finally { await f.close(); }
});

test("controlled native provenance rejects an exact same-origin child-frame request", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(async () => {
      const frame = document.createElement("iframe"); frame.src = "/child";
      await new Promise<void>((done) => { frame.onload = () => done(); document.body.append(frame); });
    });
    const child = f.page.frames().find((frame) => frame !== f.page.mainFrame()); assert.ok(child);
    const request: Expected = { url: f.origin + "/read", method: "POST", body: "query=child-frame" };
    const proof = await receipt(f.page, request, async () => [await child.evaluate(async (value) => {
      const response = await fetch(value.url, { method: value.method, body: value.body, cache: "no-store", signal: AbortSignal.timeout(2000) });
      return { url: response.url, status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    }, request)]);
    assert.equal(f.observed.length, 1); assert.equal(proof.pageMatches, 1); assert.equal(proof.cdpMatches, 1);
    assert.equal(proof.accepted, false); assert.equal(proof.reason, "wrong-frame-or-document");
  } finally { await f.close(); }
});
