import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import {
  browserNetworkFetch, BrowserNetworkTransportError, captureBrowserNetworkDocument, disposeBrowserNetworkDocument,
  type BrowserNetworkRequest,
} from "../src/browser-network-transport.js";

async function fixture(options: { streamEligible?: boolean } = {}) {
  const observed = { reads: 0, redirected: 0, aborted: 0, cookies: false, sessionHeader: false, origin: false, referrer: false, cacheControl: false };
  let origin = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    if (url.pathname === "/read") {
      observed.reads++;
      observed.cookies = req.headers.cookie?.includes("fixture_session=synthetic-private-session") ?? false;
      observed.sessionHeader = req.headers["x-csrf-token"] === "synthetic-private-header";
      observed.origin = req.headers.origin === origin;
      observed.referrer = req.headers.referer === origin + "/";
      observed.cacheControl = req.headers["cache-control"] === "no-cache" || req.headers["pragma"] === "no-cache";
      res.writeHead(200, { "content-type": "application/json; private=synthetic-private-header", "x-total-pages": "1", "cache-control": "public, max-age=3600",
        "x-private-secret": "synthetic-private-header" });
      const body = JSON.stringify({ count: observed.reads });
      if (options.streamEligible) {
        // This separate native-receipt fixture explicitly keeps a stream in flight.
        // Default immediate responses above/below retain their original timings.
        res.flushHeaders();
        const timer = setTimeout(() => res.end(body), 150);
        res.on("close", () => clearTimeout(timer));
      } else res.end(body);
      return;
    }
    if (url.pathname === "/redirect") { res.writeHead(302, { location: "/destination" }); res.end(); return; }
    if (url.pathname === "/destination") { observed.redirected++; res.end("must not follow"); return; }
    if (url.pathname === "/slow") {
      res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders();
      const timer = setTimeout(() => res.end("{}"), 1000);
      res.on("close", () => { clearTimeout(timer); observed.aborted++; }); return;
    }
    if (url.pathname === "/large") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(256)); res.end("y".repeat(256)); return;
    }
    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" +
        (url.searchParams.has("intercept") ? "self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/read')e.respondWith(new Response('{\"count\":999}',{headers:{'content-type':'application/json'}}));});" : "")); return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Controlled transport fixture</title><button>Not clicked</button><script>globalThis.fixtureClicks=0;document.onclick=()=>globalThis.fixtureClicks++;</script>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext();
  const page = await context.newPage(); await page.goto(origin);
  let apiCalls = 0;
  context.request.fetch = async () => { apiCalls++; throw new Error("synthetic-private-node-fallback-error"); };
  return { context, page, origin, observed, apiCalls: () => apiCalls,
    close: async () => { await browser.close(); await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); } };
}

function safeFailure(code?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BrowserNetworkTransportError);
    if (code) assert.equal(error.code, code);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-private|127\.0\.0\.1|fetch failed|net::/);
    return true;
  };
}

test("browser-network uses exact selected browser session with no navigation, UI or Node request fallback", async () => {
  const f = await fixture();
  try {
    await f.context.addCookies([{ name: "fixture_session", value: "synthetic-private-session", url: f.origin, httpOnly: true }]);
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    assert.equal(JSON.stringify(lease), "{}");
    let navigations = 0; f.page.on("framenavigated", () => { navigations++; });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "POST",
        body: "query=fixture", headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": "synthetic-private-header" } });
      assert.deepEqual(JSON.parse(response.body), { count: attempt });
      assert.deepEqual(response.bytes, Buffer.from(response.body));
      assert.equal(response.status, 200); assert.equal(response.ok, true);
      assert.equal(response.contentType, "application/json"); assert.deepEqual(response.headers, { "x-total-pages": "1" });
    }
    assert.equal(f.observed.cookies, true); assert.equal(f.observed.sessionHeader, true);
    assert.equal(f.observed.origin, true); assert.equal(f.observed.referrer, true);
    for (const count of [3, 4]) {
      const response = await browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "GET", headers: {} });
      assert.deepEqual(JSON.parse(response.body), { count }, "A cacheable GET must retrieve a fresh response");
    }
    assert.equal(navigations, 0); assert.equal(f.apiCalls(), 0);
    assert.equal(await f.page.evaluate("globalThis.fixtureClicks"), 0);
    await disposeBrowserNetworkDocument(lease);
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "GET", headers: {} }), safeFailure("document-changed"));
  } finally { await f.close(); }
});

test("browser-network rejects cross-origin targets, spoofed browser headers, wrong page/context and unsafe options before dispatch", async () => {
  const f = await fixture();
  try {
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    const request = { url: f.origin + "/read", method: "GET" as const, headers: {} };
    const invalid: Array<Partial<BrowserNetworkRequest>> = [{ url: "https://outside.invalid/read" }, { url: f.origin + "/read#fragment" },
      { headers: { cookie: "synthetic-private-session" } }, { headers: { origin: f.origin } }, { headers: { referer: f.origin } },
      { headers: { "sec-ch-ua": "spoof" } }, { headers: { "user-agent": "spoof" } }, { headers: { authorization: "private" } },
      { headers: { "x-csrf-token": "header\ninjection" } }, { timeoutMs: 30_001 }, { maximumBytes: 8 * 1024 * 1024 + 1 }, { body: "GET-body" }];
    for (const changes of invalid) {
      await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { ...request, ...changes }), safeFailure("invalid-request"));
    }
    const otherPage = await f.context.newPage(); await otherPage.goto(f.origin);
    await assert.rejects(browserNetworkFetch(f.context, otherPage, lease, request), safeFailure("document-changed"));
    await assert.rejects(browserNetworkFetch({} as BrowserContext, f.page, lease, request), safeFailure("document-changed"));
    assert.equal(f.observed.reads, 0); assert.equal(f.apiCalls(), 0);
    await disposeBrowserNetworkDocument(lease);
  } finally { await f.close(); }
});

test("browser-network refuses redirects and bounds streamed response bytes and time without HTTP fallback", async () => {
  const f = await fixture();
  try {
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/redirect", method: "GET", headers: {} }), safeFailure());
    assert.equal(f.observed.redirected, 0);
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/large", method: "GET", headers: {}, maximumBytes: 300 }), safeFailure("response-too-large"));
    const started = performance.now();
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/slow", method: "GET", headers: {}, timeoutMs: 100 }), safeFailure("timeout"));
    assert.ok(performance.now() - started < 1000, "Transport timeout was not bounded");
    await f.page.waitForTimeout(100);
    assert.equal(f.observed.aborted, 1); assert.equal(f.apiCalls(), 0);
    await disposeBrowserNetworkDocument(lease);
  } finally { await f.close(); }
});

test("browser-network invalidates the document lease after URL changes or same-URL reload", async () => {
  const f = await fixture();
  try {
    const request = { url: f.origin + "/read", method: "GET" as const, headers: {} };
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    await f.page.evaluate(() => history.replaceState(null, "", "/changed"));
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, request), safeFailure("document-changed"));
    await disposeBrowserNetworkDocument(lease);
    const next = await captureBrowserNetworkDocument(f.context, f.page);
    await f.page.reload();
    await assert.rejects(browserNetworkFetch(f.context, f.page, next, request), safeFailure());
    assert.equal(f.observed.reads, 0); assert.equal(f.apiCalls(), 0);
    await disposeBrowserNetworkDocument(next);
  } finally { await f.close(); }
});

test("experimental browser-network accepts a stream-eligible response under a nonintercepting worker", async () => {
  const f = await fixture({ streamEligible: true });
  try {
    await f.page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
    await f.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "GET", headers: {} }), safeFailure("service-worker"));
    assert.equal(f.observed.reads, 0, "Default transport still refuses worker control before dispatch");
    const result = await browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "GET", headers: {}, nativeReceipt: true });
    assert.deepEqual(JSON.parse(result.body), { count: 1 });
    assert.equal(f.observed.reads, 1); assert.equal(f.apiCalls(), 0);
    await disposeBrowserNetworkDocument(lease);
  } finally { await f.close(); }
});

test("browser-network refuses worker fulfillment without Node fallback", async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js?intercept=1"); await navigator.serviceWorker.ready; });
    await f.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "GET", headers: {}, nativeReceipt: true }), safeFailure("service-worker"));
    assert.equal(f.observed.reads, 0); assert.equal(f.apiCalls(), 0);
    await disposeBrowserNetworkDocument(lease);
  } finally { await f.close(); }
});

test("experimental receipt failure never retries through the default transport", async () => {
  const f = await fixture();
  try {
    const original = f.context.newCDPSession.bind(f.context);
    f.context.newCDPSession = async (...args: Parameters<typeof original>) => {
      const session = await original(...args);
      const send = session.send.bind(session);
      session.send = (async (method: string, parameters?: unknown) => {
        if (method === "Network.streamResourceContent") throw new Error("synthetic-private-protocol-error");
        return send(method as Parameters<typeof send>[0], parameters as never);
      }) as typeof send;
      return session;
    };
    const lease = await captureBrowserNetworkDocument(f.context, f.page);
    await assert.rejects(browserNetworkFetch(f.context, f.page, lease, { url: f.origin + "/read", method: "GET", headers: {}, nativeReceipt: true }), safeFailure("stream-unavailable"));
    assert.equal(f.observed.reads, 1); assert.equal(f.apiCalls(), 0);
    await disposeBrowserNetworkDocument(lease);
  } finally { await f.close(); }
});
