import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { nativeNetworkReceipt, NativeNetworkReceiptError } from "../src/native-network-receipt.js";

// These tests only contact finite, owned localhost fixtures. Deliberate response
// delays allow streaming activation; a very fast response may legitimately be
// refused by the production API when Chromium no longer has an in-flight body.
const NORMAL_BODY = Buffer.from('{"result":"owned native receipt"}');
const SECRET = "fixture-secret-do-not-include-in-errors";
type WorkerMode = "none" | "nonintercepting" | "synthetic" | "cached" | "passthrough";
type FixtureOptions = { body?: Buffer; gzip?: boolean; worker?: WorkerMode; revalidate?: boolean; stall?: boolean };
type Mutation = "cache" | "duplicate" | "url" | "method" | "body" | "header" | "reload" | "response";

async function fixture(options: FixtureOptions = {}) {
  const body = options.body ?? NORMAL_BODY;
  const wire = options.gzip ? gzipSync(body) : body;
  const observed: Array<{ method: string; path: string; body: string; header?: string }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://controlled.invalid").pathname;
    if (path === "/read" || path === "/different") {
      let input = "";
      req.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");
        if (Buffer.byteLength(input) > 4096) req.destroy();
      });
      req.on("end", () => {
        observed.push({ method: req.method!, path, body: input,
          header: typeof req.headers["x-requested-with"] === "string" ? req.headers["x-requested-with"] : undefined });
        schedule(() => {
          if (res.destroyed) return;
          const revalidated = options.revalidate && req.headers["if-none-match"] === '"native-receipt"';
          res.writeHead(revalidated ? 304 : 200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": options.revalidate ? "public, max-age=0, must-revalidate" : "public, max-age=3600",
            etag: '"native-receipt"',
            ...(!revalidated ? { "content-length": wire.length } : {}),
            ...(options.gzip ? { "content-encoding": "gzip" } : {}),
          });
          res.flushHeaders();
          if (revalidated) { res.end(); return; }
          if (options.stall) return;
          // More than one chunk exercises binary collection across boundaries.
          const midpoint = Math.max(1, Math.floor(wire.length / 2));
          schedule(() => {
            if (res.destroyed) return;
            res.write(wire.subarray(0, midpoint));
            schedule(() => { if (!res.destroyed) res.end(wire.subarray(midpoint)); }, 60);
          }, 120);
        }, 80);
      });
      return;
    }
    if (path === "/sw.js") {
      res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      const mode = options.worker ?? "none";
      const response = `new Response(${JSON.stringify(NORMAL_BODY.toString())},{headers:{'content-type':'application/json'}})`;
      const intercept = mode === "synthetic" ? `event.respondWith(${response});`
        : mode === "cached" ? "event.respondWith(caches.match('/read'));"
          : mode === "passthrough" ? "event.respondWith(fetch(event.request));" : "";
      res.end(`self.addEventListener('install',event=>event.waitUntil((async()=>{
        ${mode === "cached" ? `await (await caches.open('native-receipt')).put('/read',${response});` : ""}
        await self.skipWaiting();
      })()));
      self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
      ${intercept ? `self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/read'){${intercept}}});` : ""}`);
      return;
    }
    if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end("<!doctype html><title>Controlled native receipt</title><p>Local fixture only.</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const page = await context.newPage(); await page.goto(origin);
  if (options.worker && options.worker !== "none") {
    await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  }
  const document = await page.evaluateHandle(() => window.document);
  const scope = { page, document, documentUrl: page.url() };
  return { page, context, origin, observed, scope,
    request: { url: origin + "/read", method: "POST" as "GET" | "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" }, body: "query=owned" },
    close: async () => {
      await document.dispose(); await browser.close();
      for (const timer of timers) clearTimeout(timer);
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    } };
}

function deadline(maximumBytes = 64 * 1024) {
  return { deadlineAt: performance.now() + 6000, maximumBytes };
}

async function rejectsCode(operation: Promise<unknown>, ...codes: NativeNetworkReceiptError["code"][]) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof NativeNetworkReceiptError, "Failures must use the fixed public error type");
    assert.ok(codes.includes(error.code), `Expected ${codes.join("/")}, received ${error.code}`);
    assert.equal(`${error.message}\n${error.stack}`.includes(SECRET), false, "Errors must not disclose request evidence");
    return true;
  });
}

async function mutateFetch(page: Page, mutation: Mutation) {
  await page.evaluate((mode) => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const next = { ...init };
      if (mode === "cache") next.cache = "default";
      if (mode === "url") url = new URL("/different", location.href).href;
      if (mode === "method") { next.method = "GET"; delete next.body; }
      if (mode === "body") next.body = "query=altered";
      if (mode === "header") {
        const headers = new Headers(next.headers); headers.set("x-requested-with", "Altered"); next.headers = headers;
      }
      if (mode === "duplicate") {
        const responses = await Promise.all([original(url, next), original(url, next)]);
        return responses[0]!;
      }
      if (mode === "reload") setTimeout(() => location.reload(), 40);
      const response = await original(url, next);
      if (mode === "response") {
        await response.arrayBuffer();
        const changed = new Response("changed bytes", { status: response.status, headers: response.headers });
        Object.defineProperty(changed, "url", { value: response.url });
        return changed;
      }
      return response;
    };
  }, mutation);
}

function inspectProtocol(context: BrowserContext, streamUnavailable = false, dataMode?: "drop" | "burst") {
  const original = context.newCDPSession.bind(context);
  const calls: string[] = [];
  let detached = 0;
  context.newCDPSession = async (...args: Parameters<BrowserContext["newCDPSession"]>) => {
    const session = await original(...args);
    const send = session.send.bind(session);
    session.send = (async (method: string, parameters?: unknown) => {
      calls.push(method);
      assert.equal(["Network.getResponseBody", "Network.loadNetworkResource", "Fetch.enable", "Network.setCacheDisabled",
        "Network.setBypassServiceWorker"].includes(method), false, "Receipt must not refetch, intercept or bypass cache/SW");
      if (streamUnavailable && method === "Network.streamResourceContent") throw new Error(SECRET);
      return send(method as Parameters<CDPSession["send"]>[0], parameters as never);
    }) as CDPSession["send"];
    const detach = session.detach.bind(session);
    session.detach = async () => { detached++; await detach(); };
    if (dataMode) {
      const on = session.on.bind(session) as (event: string, listener: (...args: any[]) => void) => CDPSession;
      const off = session.off.bind(session) as (event: string, listener: (...args: any[]) => void) => CDPSession;
      const replacements = new Map<(...args: any[]) => void, (...args: any[]) => void>();
      session.on = ((event: string, listener: (...args: any[]) => void) => {
        if (event !== "Network.dataReceived") return on(event, listener);
        const replacement = (value: { data?: string; dataLength: number; [key: string]: unknown }) => {
          if (dataMode === "burst") {
            // Synthetic protocol events only: no extra server requests.
            for (let index = 0; index < 2050; index++) listener({ ...value, data: undefined, dataLength: 0 });
          } else listener({ ...value, data: undefined });
        };
        replacements.set(listener, replacement); return on(event, replacement);
      }) as CDPSession["on"];
      session.off = ((event: string, listener: (...args: any[]) => void) => {
        const replacement = replacements.get(listener); replacements.delete(listener);
        return off(event, replacement ?? listener);
      }) as CDPSession["off"];
    }
    return session;
  };
  return { calls, detached: () => detached };
}

for (const [name, body, gzip] of [
  ["UTF-8", Buffer.from('{"city":"悉尼","music":"🎸"}'), false],
  ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), NORMAL_BODY]), false],
  ["invalid UTF-8 bytes", Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x41]), false],
  ["gzip content decoding", Buffer.from('{"city":"悉尼","music":"🎸"}'), true],
] as const) {
  test(`native receipt preserves ${name}`, { timeout: 20_000 }, async () => {
    const f = await fixture({ body, gzip });
    try {
      const protocol = inspectProtocol(f.context);
      if (name === "UTF-8") { f.request.method = "GET"; delete (f.request as { body?: string }).body; }
      const result = await nativeNetworkReceipt(f.scope, f.request, deadline());
      assert.deepEqual(result.bytes, body); assert.equal(result.status, 200); assert.equal(result.ok, true);
      assert.equal(result.url, f.request.url); assert.equal(result.contentType, "application/json");
      assert.deepEqual(result.provenance, { transport: "chromium-cdp", requestCount: 1,
        fromServiceWorker: false, fromBrowserCache: false });
      assert.equal(f.observed.length, 1); assert.equal(protocol.detached(), 1);
      assert.equal(protocol.calls.filter((method) => method === "Network.streamResourceContent").length, 1);
    } finally { await f.close(); }
  });
}

test("native receipt caps decoded gzip output rather than compressed wire length", { timeout: 20_000 }, async () => {
  const body = Buffer.alloc(32 * 1024, 65); assert.ok(gzipSync(body).length < 1024);
  const f = await fixture({ body, gzip: true });
  try { await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline(1024)), "response-too-large"); }
  finally { await f.close(); }
});

test("native receipt accepts its full 8 MiB byte limit without recursive base64 validation", { timeout: 25_000 }, async () => {
  const maximumBytes = 8 * 1024 * 1024;
  const body = Buffer.alloc(maximumBytes, 65); body[0] = 34; body[body.length - 1] = 34;
  const f = await fixture({ body });
  try {
    const result = await nativeNetworkReceipt(f.scope, f.request,
      { deadlineAt: performance.now() + 15_000, maximumBytes });
    assert.deepEqual(result.bytes, body); assert.equal(f.observed.length, 1);
  } finally { await f.close(); }
});

for (const worker of ["none", "nonintercepting", "synthetic", "cached", "passthrough"] as const) {
  test(`native receipt ${worker} service-worker controller`, { timeout: 20_000 }, async () => {
    const f = await fixture({ worker });
    try {
      if (worker === "cached") { f.request.method = "GET"; delete (f.request as { body?: string }).body; }
      if (worker === "none" || worker === "nonintercepting") {
        const result = await nativeNetworkReceipt(f.scope, f.request, deadline());
        assert.deepEqual(result.bytes, NORMAL_BODY); assert.equal(f.observed.length, 1);
      } else {
        await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "service-worker");
        assert.equal(f.observed.length, worker === "passthrough" ? 1 : 0);
      }
    } finally { await f.close(); }
  });
}

for (const revalidate of [false, true]) {
  test(`native receipt refuses ${revalidate ? "304 revalidation" : "browser HTTP-cache hit"}`, { timeout: 20_000 }, async () => {
    const f = await fixture({ revalidate });
    try {
      f.request.method = "GET"; delete (f.request as { body?: string }).body;
      await f.page.evaluate(async (url) => { await (await fetch(url, { cache: "default" })).arrayBuffer(); }, f.request.url);
      assert.equal(f.observed.length, 1);
      await mutateFetch(f.page, "cache");
      await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "browser-cache");
      assert.equal(f.observed.length, revalidate ? 2 : 1);
    } finally { await f.close(); }
  });
}

test("native receipt refuses duplicate identical page requests", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await mutateFetch(f.page, "duplicate");
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "ambiguous-request");
    // The second native request may be aborted before it reaches the server.
    assert.ok(f.observed.length <= 2);
  } finally { await f.close(); }
});

test("native receipt verifies native URL, method, body and explicit wire headers", { timeout: 45_000 }, async () => {
  for (const mutation of ["url", "method", "body", "header"] as const) {
    const f = await fixture();
    try {
      f.request.body = SECRET;
      await mutateFetch(f.page, mutation);
      await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "request-mismatch");
      assert.equal(f.observed.length, 1);
    } finally { await f.close(); }
  }
});

test("native receipt refuses differing page response bytes", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await mutateFetch(f.page, "response");
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "request-mismatch");
    assert.equal(f.observed.length, 1);
  } finally { await f.close(); }
});

test("native receipt refuses same-URL document replacement", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await mutateFetch(f.page, "reload");
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "document-changed");
    assert.ok(f.observed.length <= 1);
  } finally { await f.close(); }
});

test("native receipt deadline aborts a stalled response and cleans up", { timeout: 20_000 }, async () => {
  const f = await fixture({ stall: true });
  try {
    const protocol = inspectProtocol(f.context);
    f.request.body = SECRET;
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request,
      { deadlineAt: performance.now() + 1200, maximumBytes: 1024 }), "timeout");
    assert.equal(protocol.detached(), 1); assert.equal(f.observed.length, 1);
  } finally { await f.close(); }
});

test("native receipt refuses a Document handle belonging to another page before fetching", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const other = await f.context.newPage(); await other.goto(f.origin);
    await rejectsCode(nativeNetworkReceipt({ ...f.scope, page: other }, f.request, deadline()), "document-changed");
    assert.equal(f.observed.length, 0);
  } finally { await f.close(); }
});

test("native receipt never refetches when native streaming is unavailable and releases its lease", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const protocol = inspectProtocol(f.context, true);
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "stream-unavailable");
    assert.equal(protocol.detached(), 1);
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "stream-unavailable");
    assert.equal(protocol.detached(), 2); assert.ok(f.observed.length <= 2);
    assert.equal(protocol.calls.filter((method) => method === "Network.streamResourceContent").length, 2);
  } finally { await f.close(); }
});

test("native receipt permits only one active invocation per page", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = nativeNetworkReceipt(f.scope, f.request, deadline());
    // Attach settlement handling immediately so a test failure cannot leave an
    // unobserved rejection while cleanup closes the browser.
    const settled = first.then((result) => ({ result }), (error: unknown) => ({ error }));
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "busy");
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    assert.deepEqual(outcome.result.bytes, NORMAL_BODY); assert.equal(f.observed.length, 1);
  } finally { await f.close(); }
});

test("native receipt refuses incomplete native binary evidence without refetching", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const protocol = inspectProtocol(f.context, false, "drop");
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "stream-unavailable");
    assert.equal(f.observed.length, 1); assert.equal(protocol.detached(), 1);
    assert.equal(protocol.calls.filter((method) => method === "Network.streamResourceContent").length, 1);
  } finally { await f.close(); }
});

test("native receipt bounds native event evidence and detaches on overflow", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const protocol = inspectProtocol(f.context, false, "burst");
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "evidence-limit");
    assert.equal(f.observed.length, 1); assert.equal(protocol.detached(), 1);
  } finally { await f.close(); }
});

test("native receipt detaches a late session and releases the page after deadline cleanup", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let releaseDetach!: () => void;
  const allowDetach = new Promise<void>((resolve) => { releaseDetach = resolve; });
  try {
    const original = f.context.newCDPSession.bind(f.context);
    let first = true; let didDetach!: () => void; let beganDetach!: () => void;
    const detached = new Promise<void>((resolve) => { didDetach = resolve; });
    const detaching = new Promise<void>((resolve) => { beganDetach = resolve; });
    f.context.newCDPSession = async (...args: Parameters<BrowserContext["newCDPSession"]>) => {
      const delay = first; first = false;
      const session = await original(...args);
      if (delay) {
        const detach = session.detach.bind(session);
        session.detach = async () => { beganDetach(); await allowDetach; await detach(); didDetach(); };
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      }
      return session;
    };
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request,
      { deadlineAt: performance.now() + 200, maximumBytes: 1024 }), "timeout");
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "busy");
    assert.equal(f.observed.length, 0, "Acquisition timeout must not dispatch a fetch");
    const waitForCleanup = async (stage: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([stage, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Late native session cleanup did not advance")), 2000);
        })]);
      } finally { clearTimeout(timer); }
    };
    await waitForCleanup(detaching);
    await rejectsCode(nativeNetworkReceipt(f.scope, f.request, deadline()), "busy");
    assert.equal(f.observed.length, 0, "The lease must remain held while actual detach is pending");
    releaseDetach();
    await waitForCleanup(detached);
    // Let the owned acquisition/cleanup promise chain settle after the detach
    // observer fires; this is an event-loop barrier, not a timed sleep.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await nativeNetworkReceipt(f.scope, f.request, deadline());
    assert.deepEqual(result.bytes, NORMAL_BODY); assert.equal(f.observed.length, 1);
  } finally { releaseDetach(); await f.close(); }
});
