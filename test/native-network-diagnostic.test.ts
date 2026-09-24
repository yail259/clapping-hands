import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, type CDPSession } from "playwright-core";
import { nativeFailureDiagnostic, nativeNetworkReceipt, NativeNetworkReceiptError,
  type NativeFailureDiagnostic } from "../src/native-network-receipt.js";

const SECRET = "controlled-diagnostic-secret-do-not-disclose";
const PAYLOAD = '{"result":"controlled"}';

// This fixture explicitly waits for stream activation before sending its owned
// response, so it exercises diagnostic branches rather than CDP's timing race.
// It does NOT claim that immediate responses have binary receipts.
async function fixture() {
  let reads = 0;
  let activated = false;
  const pendingResponses = new Set<() => void>();
  const activate = () => { activated = true; for (const send of pendingResponses) send(); pendingResponses.clear(); };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/read")) {
      reads++;
      req.resume();
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(PAYLOAD);
      };
      if (activated) send(); else pendingResponses.add(send);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Controlled receipt diagnostics</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext(); context.setDefaultTimeout(5000);
  const nativeSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (...args) => {
    const session = await nativeSession(...args); const send = session.send.bind(session);
    session.send = (async (method: string, parameters: unknown) => {
      const result = await send(method as Parameters<CDPSession["send"]>[0], parameters as never);
      if (method === "Network.streamResourceContent") activate();
      return result;
    }) as CDPSession["send"];
    return session;
  };
  const page = await context.newPage(); await page.goto(origin);
  const document = await page.evaluateHandle(() => window.document);
  const scope = { page, document, documentUrl: page.url() };
  const request = { url: origin + "/read?fixture=" + SECRET, method: "POST" as const,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": SECRET }, body: SECRET };
  const run = (timeoutMs = 4000) => nativeNetworkReceipt(scope, request, { deadlineAt: performance.now() + timeoutMs, maximumBytes: 4096 });
  const instrument = (change: (session: CDPSession) => void) => {
    const original = context.newCDPSession.bind(context);
    context.newCDPSession = async (...args) => { const session = await original(...args); change(session); return session; };
  };
  return { page, context, run, instrument, reads: () => reads,
    close: async () => {
      await document.dispose(); await browser.close();
      pendingResponses.clear();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    } };
}

async function diagnostic(operation: Promise<unknown>): Promise<NativeFailureDiagnostic> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  assert.ok(failure instanceof NativeNetworkReceiptError, "The controlled operation must fail with the public fixed error type");
  const value = nativeFailureDiagnostic(failure); assert.ok(value, "A failure-stage snapshot must be available");
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized + String(failure) + JSON.stringify(failure), /controlled-diagnostic-secret|127\.0\.0\.1|fixture=|csrf|read\?/);
  assert.ok(serialized.length < 768, "Diagnostic evidence must stay small and fixed-schema");
  assert.deepEqual(Object.keys(value).sort(), ["category", "nativeFailed", "nativeFinished", "nativeRequest", "nativeResponse",
    "pageMatches", "stage", "stream", "pageReadCompleted", "nativeObservedBytes", "nativeRetainedBytes", "byteCountsCapped",
    ...(value.pageBodyPresent === undefined ? [] : ["pageBodyPresent"]), ...(value.pageBodyBytes === undefined ? [] : ["pageBodyBytes"]),
    ...(value.networkFailure ? ["networkFailure"] : [])].sort());
  for (const count of [value.nativeObservedBytes, value.nativeRetainedBytes, value.pageBodyBytes ?? 0]) {
    assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 8 * 1024 * 1024);
  }
  const original = value.category; value.category = "cleanup-failed";
  assert.equal(nativeFailureDiagnostic(failure)!.category, original, "Returned snapshots must not mutate private evidence");
  assert.equal(Object.hasOwn(failure, "diagnostic"), false);
  return nativeFailureDiagnostic(failure)!;
}

test("native diagnostic lookup does not inspect unknown thrown values or getters", () => {
  let touched = 0;
  const value = new Proxy({}, { get() { touched++; throw new Error(SECRET); }, getPrototypeOf() { touched++; throw new Error(SECRET); } });
  for (const unknown of [value, null, undefined, SECRET, new Error(SECRET), () => { throw new Error(SECRET); }]) {
    assert.equal(nativeFailureDiagnostic(unknown), undefined);
  }
  assert.equal(touched, 0);
});

test("native diagnostic distinguishes session creation from network setup failures without dispatch", { timeout: 20_000 }, async () => {
  for (const sessionFailure of [true, false]) {
    const f = await fixture();
    try {
      if (sessionFailure) f.context.newCDPSession = async () => { throw new Error(SECRET); };
      else f.instrument((session) => {
        const send = session.send.bind(session);
        session.send = (async (method: string, parameters: unknown) => {
          if (method === "Network.enable") throw new Error(SECRET);
          return send(method as Parameters<CDPSession["send"]>[0], parameters as never);
        }) as CDPSession["send"];
      });
      const value = await diagnostic(f.run());
      assert.equal(value.stage, sessionFailure ? "session" : "network-setup"); assert.equal(value.category, "cdp-command");
      assert.equal(value.nativeRequest, false); assert.equal(value.pageMatches, 0); assert.equal(value.stream, "not-started");
      assert.equal(f.reads(), 0);
    } finally { await f.close(); }
  }
});

test("native diagnostic identifies page fetch rejection and preserves it through cleanup failure", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.page.evaluate((secret) => { window.fetch = async () => { throw new Error(secret); }; }, SECRET);
    f.instrument((session) => { const detach = session.detach.bind(session); session.detach = async () => { await detach(); throw new Error(SECRET); }; });
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "page-fetch"); assert.equal(value.category, "fetch-rejected");
    assert.equal(value.pageReadCompleted, false); assert.equal(value.pageBodyBytes, undefined);
    assert.equal(value.nativeObservedBytes, 0); assert.equal(value.nativeRetainedBytes, 0);
    assert.equal(value.nativeRequest, false); assert.equal(value.nativeResponse, false); assert.equal(f.reads(), 0);
  } finally { await f.close(); }
});

test("native diagnostic identifies body-consumer rejection after native response headers", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.page.evaluate((secret) => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        Object.defineProperty(response, "arrayBuffer", { async value() { throw new Error(secret); } });
        return response;
      };
    }, SECRET);
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "page-fetch"); assert.equal(value.category, "body-read-rejected");
    assert.equal(value.nativeRequest, true); assert.equal(value.pageMatches, 1); assert.equal(f.reads(), 1);
  } finally { await f.close(); }
});

test("native diagnostic identifies serialization rejection after a completed native body", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.page.evaluate((secret) => { window.btoa = () => { throw new Error(secret); }; }, SECRET);
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "page-fetch"); assert.equal(value.category, "serialization-rejected");
    assert.equal(value.nativeRequest, true); assert.equal(value.nativeResponse, true); assert.equal(f.reads(), 1);
  } finally { await f.close(); }
});

test("native diagnostic categorizes loadingFailed metadata without raw network error text", { timeout: 20_000 }, async () => {
  for (const blockedReason of ["csp", SECRET]) {
    const f = await fixture();
    try {
      let ownedRequestId: string | undefined;
      let selectedRequests = 0;
      let injections = 0;
      f.instrument((session) => {
        const send = session.send.bind(session);
        session.send = (async (method: string, parameters: unknown) => {
          if (method === "Network.streamResourceContent") {
            const requestId = (parameters as { requestId?: unknown }).requestId;
            assert.equal(typeof requestId, "string");
            ownedRequestId = requestId as string; selectedRequests++;
          }
          const result = await send(method as Parameters<CDPSession["send"]>[0], parameters as never);
          if (method === "Runtime.evaluate") {
            // Inject only for the selected request, after the owned page fetch
            // and native-evidence barrier have settled. Tying injection to
            // loadingFinished let actual cancellation events determine this
            // synthetic branch instead of guaranteeing the intended metadata.
            assert.ok(ownedRequestId); injections++;
            (session as unknown as { emit: (name: string, data: unknown) => void }).emit("Network.loadingFailed", {
              requestId: ownedRequestId, blockedReason, canceled: false, errorText: SECRET,
            });
          }
          return result;
        }) as CDPSession["send"];
      });
      const value = await diagnostic(f.run());
      assert.equal(value.stage, "native-evidence"); assert.equal(value.category, "loading-failed");
      assert.equal(value.nativeRequest, true); assert.equal(value.nativeFailed, true);
      assert.equal(value.networkFailure, blockedReason === "csp" ? "csp" : "blocked-other");
      assert.equal(selectedRequests, 1); assert.equal(injections, 1);
      assert.equal(value.pageMatches, 1); assert.equal(f.reads(), 1);
    } finally { await f.close(); }
  }
});

test("native diagnostic distinguishes byte comparison from transport or cleanup failures", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args); await response.arrayBuffer();
        const changed = new Response("different bytes", { status: response.status, headers: response.headers });
        Object.defineProperty(changed, "url", { value: response.url }); return changed;
      };
    });
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "byte-comparison"); assert.equal(value.category, "validation");
    assert.equal(value.nativeRequest, true); assert.equal(value.nativeResponse, true); assert.equal(value.nativeFinished, true);
    assert.equal(value.pageReadCompleted, true); assert.equal(value.pageBodyPresent, true);
    assert.equal(value.pageBodyBytes, Buffer.byteLength("different bytes"));
    assert.equal(value.nativeObservedBytes, Buffer.byteLength(PAYLOAD)); assert.equal(value.nativeRetainedBytes, Buffer.byteLength(PAYLOAD));
    assert.equal(value.byteCountsCapped, false);
  } finally { await f.close(); }
});

test("native diagnostic identifies cleanup failure after otherwise valid native evidence", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.instrument((session) => { const detach = session.detach.bind(session); session.detach = async () => { await detach(); throw new Error(SECRET); }; });
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "cleanup", JSON.stringify(value)); assert.equal(value.category, "cleanup-failed");
    assert.equal(value.nativeRequest, true); assert.equal(value.nativeResponse, true); assert.equal(value.nativeFinished, true);
    assert.equal(f.reads(), 1);
  } finally { await f.close(); }
});

test("native diagnostic records a matching response before its service-worker guard refuses it", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.instrument((session) => session.on("Network.responseReceived", (event) => {
      // Inject provenance into our owned native event; do not install/bypass a
      // worker or change production guard behavior to exercise the diagnostic.
      event.response.fromServiceWorker = true;
    }));
    const value = await diagnostic(f.run());
    assert.equal(value.nativeRequest, true); assert.equal(value.nativeResponse, true);
    assert.equal(value.category, "validation"); assert.equal(f.reads(), 1);
  } finally { await f.close(); }
});

test("native diagnostic distinguishes a CDP evidence barrier error from validation", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.instrument((session) => {
      const send = session.send.bind(session);
      session.send = (async (method: string, parameters: unknown) => {
        if (method === "Runtime.evaluate") throw new Error(SECRET);
        return send(method as Parameters<CDPSession["send"]>[0], parameters as never);
      }) as CDPSession["send"];
    });
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "native-evidence"); assert.equal(value.category, "cdp-command");
    assert.equal(value.nativeRequest, true); assert.equal(value.nativeResponse, true);
  } finally { await f.close(); }
});

test("native diagnostic distinguishes document-check evaluation failure from validation", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const original = f.page.evaluateHandle.bind(f.page);
    f.page.evaluateHandle = (async (...args: any[]) => {
      const handle = await original(args[0], args[1]);
      const evaluate = handle.evaluate.bind(handle); let first = true;
      handle.evaluate = (async (...values: any[]) => {
        if (first) { first = false; throw new Error(SECRET); }
        return evaluate(values[0], values[1]);
      }) as typeof handle.evaluate;
      return handle;
    }) as typeof f.page.evaluateHandle;
    const value = await diagnostic(f.run());
    assert.equal(value.stage, "document-check"); assert.equal(value.category, "page-evaluate");
    assert.equal(value.nativeFinished, true); assert.equal(value.stream, "ready");
  } finally { await f.close(); }
});

test("native diagnostic labels cleanup expiry as timeout without replacing an earlier failure", { timeout: 20_000 }, async () => {
  for (const fetchFailure of [false, true]) {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (fetchFailure) await f.page.evaluate((secret) => { window.fetch = async () => { throw new Error(secret); }; }, SECRET);
      f.instrument((session) => { const detach = session.detach.bind(session); session.detach = async () => { await gate; await detach(); }; });
      const value = await diagnostic(f.run(800));
      assert.equal(value.stage, fetchFailure ? "page-fetch" : "cleanup");
      assert.equal(value.category, fetchFailure ? "fetch-rejected" : "timeout");
      assert.equal(value.nativeResponse, !fetchFailure); assert.equal(f.reads(), fetchFailure ? 0 : 1);
    } finally { release(); await new Promise<void>((resolve) => setImmediate(resolve)); await f.close(); }
  }
});

test("native diagnostic preserves the initial fetch failure while a document probe expires", { timeout: 20_000 }, async () => {
  const f = await fixture(); let release!: () => void; let probeStarted = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await f.page.evaluate((secret) => { window.fetch = async () => { throw new Error(secret); }; }, SECRET);
    const original = f.page.evaluateHandle.bind(f.page);
    f.page.evaluateHandle = (async (...args: any[]) => {
      const handle = await original(args[0], args[1]);
      const evaluate = handle.evaluate.bind(handle); let first = true;
      handle.evaluate = (async (...values: any[]) => {
        if (first) { first = false; probeStarted = true; await gate; }
        return evaluate(values[0], values[1]);
      }) as typeof handle.evaluate;
      return handle;
    }) as typeof f.page.evaluateHandle;
    const value = await diagnostic(f.run(800).catch((error: unknown) => {
      assert.ok(error instanceof NativeNetworkReceiptError);
      assert.equal(error.code, "timeout", "The existing deadline refusal code must remain unchanged");
      throw error;
    }));
    assert.equal(probeStarted, true);
    assert.equal(value.stage, "page-fetch"); assert.equal(value.category, "fetch-rejected");
    assert.equal(value.nativeRequest, false); assert.equal(value.nativeResponse, false);
    assert.equal(value.pageMatches, 0); assert.equal(value.stream, "not-started"); assert.equal(f.reads(), 0);
  } finally { release(); await new Promise<void>((resolve) => setImmediate(resolve)); await f.close(); }
});
