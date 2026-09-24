import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { chromium, type CDPSession } from "playwright-core";
import { nativeFailureDiagnostic, nativeNetworkReceipt, NativeNetworkReceiptError } from "../src/native-network-receipt.js";

type Mode = "complete" | "complete-routed" | "cancel-and-replace" | "server-truncated" | "chunked-immediate" | "chunked-delayed";
type Consumer = "reader" | "array-buffer" | "production";
const BODY = '{"result":"controlled native cancellation fixture"}';
const PREFIX = BODY.slice(0, 12);

/** LOCAL ONLY causality experiment. Real stream setup controls fixture response
 * release; no synthetic CDP events, interception, retries, worker changes or
 * response-body/refetch APIs. Holding a finite tail makes cancellation happen
 * before native completion, not after an already-finished response. */
async function scenario(mode: Mode, consumer: Consumer = "reader") {
  const chunked = mode === "chunked-immediate" || mode === "chunked-delayed";
  const body = chunked ? BODY + " ".repeat(98_129 - BODY.length) : BODY;
  const expectedBytes = Buffer.byteLength(body);
  let streamActivated = false;
  let pending: ServerResponse | undefined;
  let released = false;
  let reads = 0;
  let nativeResponses = 0;
  let nativeFinished = 0;
  let nativeFailed = 0;
  let nativeCancelled = 0;
  let nativeBytes = 0;
  let events = 0;
  let eventLimitExceeded = false;
  let eofReleased = false;
  let eofTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (!streamActivated || !pending || released || pending.destroyed) return;
    released = true;
    pending.writeHead(200, { "content-type": "application/json", "cache-control": "no-store",
      ...(chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(expectedBytes) }) });
    if (mode === "complete" || mode === "complete-routed" || mode === "chunked-immediate") { eofReleased = true; pending.end(body); }
    else if (mode === "chunked-delayed") pending.write(body);
    else pending.write(PREFIX); // Tail deliberately held until cancel/truncate.
  };
  const server = createServer((req, res) => {
    if (req.url === "/read") {
      reads++; req.resume();
      if (reads > 1) { res.writeHead(409); res.end(); return; }
      pending = res; release(); return;
    }
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Controlled native cancellation</title>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 5000,
      executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    const chromiumVersion = browser.version();
    assert.match(chromiumVersion, /^\d+\.\d+\.\d+\.\d+$/);
    const context = await browser.newContext();
    if (mode === "complete-routed") await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !request.frame().parentFrame()) {
        if (new URL(request.url()).origin !== origin) { await route.abort("blockedbyclient"); return; }
      }
      await route.continue();
    });
    const page = await context.newPage(); await page.goto(origin, { timeout: 5000 });
    if (consumer === "reader") {
      await page.evaluate(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await original(...args);
          // LOCAL ONLY historical reader comparison. Production now uses native
          // arrayBuffer; this adapter alone reproduces the old JS-reader path
          // on the same original Response and finite owned fixture bytes.
          Object.defineProperty(response, "arrayBuffer", { async value() {
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = []; let length = 0;
            if (reader) while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > 131_072) throw new Error("Controlled historical body exceeds its finite fixture budget.");
              chunks.push(chunk.value);
            }
            const bytes = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return bytes.buffer;
          } });
          return response;
        };
      });
    }
    if (mode === "cancel-and-replace") {
      await page.evaluate((body) => {
        const original = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await original(...args);
          const reader = response.body!.getReader();
          const first = await reader.read();
          if (first.done || !first.value.byteLength) throw new Error("Controlled prefix was unavailable.");
          await reader.cancel(); // Real browser cancellation, never a CDP injection.
          const replacement = new Response(body, { status: response.status, headers: response.headers });
          Object.defineProperty(replacement, "url", { value: response.url });
          return replacement;
        };
      }, BODY);
    }
    const createSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (...args) => {
      const session = await createSession(...args);
      let requestId: string | undefined;
      const counted = () => { if (++events <= 64) return true; eventLimitExceeded = true; pending?.destroy(); return false; };
      session.on("Network.requestWillBeSent", (event) => {
        if (event.request.url === origin + "/read" && counted()) requestId = event.requestId;
      });
      session.on("Network.responseReceived", (event) => { if (event.requestId === requestId && counted()) nativeResponses++; });
      session.on("Network.dataReceived", (event) => {
        if (event.requestId !== requestId || !counted()) return;
        nativeBytes += event.dataLength;
        // The genuine data event proves Chromium received the declared prefix
        // before the server closes its incomplete fixed-length response.
        if (mode === "server-truncated") pending?.destroy();
        if (mode === "chunked-delayed" && nativeBytes === expectedBytes && !eofTimer) {
          // Experimental variable: separate HTTP EOF from payload delivery.
          // This waits for genuine native payload observation, then one bounded
          // 100ms interval; it does not patch fetch/readers or claim an exact
          // page-consumption timestamp from this native delivery event.
          eofTimer = setTimeout(() => { eofReleased = true; pending?.end(); }, 100);
        }
      });
      session.on("Network.loadingFinished", (event) => { if (event.requestId === requestId && counted()) nativeFinished++; });
      session.on("Network.loadingFailed", (event) => {
        if (event.requestId !== requestId || !counted()) return;
        nativeFailed++; if (event.canceled === true) nativeCancelled++;
      });
      const send = session.send.bind(session);
      session.send = (async (method: string, parameters: unknown) => {
        const result = await send(method as Parameters<CDPSession["send"]>[0], parameters as never);
        if (method === "Network.streamResourceContent") {
          // Release next turn, after the module consumes the real stream result.
          setImmediate(() => { streamActivated = true; release(); });
        }
        return result;
      }) as CDPSession["send"];
      return session;
    };
    const document = await page.evaluateHandle(() => window.document);
    let accepted = false;
    let code: string | null = null;
    let diagnostic: ReturnType<typeof nativeFailureDiagnostic>;
    let receiptBytes = 0;
    try {
      const receipt = await nativeNetworkReceipt({ page, document, documentUrl: page.url() },
        { url: origin + "/read", method: "GET", headers: {} }, { deadlineAt: performance.now() + 5000, maximumBytes: 131_072 });
      accepted = true; receiptBytes = receipt.bytes.byteLength;
      assert.equal(receipt.bytes.equals(Buffer.from(body)), true);
    } catch (error) {
      assert.ok(error instanceof NativeNetworkReceiptError);
      code = error.code; diagnostic = nativeFailureDiagnostic(error);
      assert.ok(diagnostic);
    } finally { await document.dispose(); }
    const result = { mode, consumer, chromiumVersion, accepted, code, reads, streamActivated, eofReleased, nativeResponses, nativeFinished,
      nativeFailed, nativeCancelled, nativeBytes, receiptBytes, events, eventLimitExceeded, ...(diagnostic ? { diagnostic } : {}) };
    assert.equal(reads, 1); assert.equal(streamActivated, true); assert.equal(eventLimitExceeded, false);
    assert.ok(nativeBytes <= expectedBytes);
    assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|https?:|controlled native cancellation fixture|responseHeaders|requestHeaders/);
    return result;
  } finally {
    clearTimeout(eofTimer); pending?.destroy(); await browser?.close();
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  }
}

/** Completed fixtures must either pass the production byte/provenance guards
 * (scenario also compares the receipt to every owned expected byte), or refuse
 * the exact observed full-byte native-cancellation signature. Completion timing
 * can vary even for immediate/routed responses. Unknown failures, timeouts and
 * partial bodies are not acceptable alternatives.
 *
 * Audit: the first integrated routed-control failure lacked a retained native
 * diagnostic; this shared assertion does not identify that historical cause. */
function assertUntouchedReceipt(result: Awaited<ReturnType<typeof scenario>>, expectedBytes: number) {
  assert.equal(result.eofReleased, true);
  assert.equal(result.nativeResponses, 1);
  assert.equal(result.nativeBytes, expectedBytes);
  if (result.accepted) {
    assert.equal(result.nativeFinished, 1); assert.equal(result.nativeFailed, 0);
    assert.equal(result.nativeCancelled, 0); assert.equal(result.code, null);
    assert.equal(result.diagnostic, undefined); assert.equal(result.receiptBytes, expectedBytes);
  } else {
    assert.equal(result.nativeFinished, 0); assert.equal(result.nativeFailed, 1);
    assert.equal(result.nativeCancelled, 1); assert.equal(result.code, "transport-failed");
    assert.equal(result.receiptBytes, 0);
    assert.deepEqual(result.diagnostic, { stage: "native-evidence", category: "loading-failed", pageMatches: 1,
      nativeRequest: true, nativeResponse: true, nativeFinished: false, nativeFailed: true, stream: "ready",
      pageReadCompleted: true, pageBodyPresent: true, pageBodyBytes: expectedBytes,
      nativeObservedBytes: expectedBytes, nativeRetainedBytes: expectedBytes, byteCountsCapped: false, networkFailure: "cancelled" });
  }
}

test("real native cancellation distinguishes a page replacement from ordinary server truncation", { timeout: 25_000 }, async (t) => {
  const complete = await scenario("complete");
  t.diagnostic(JSON.stringify(complete));
  assertUntouchedReceipt(complete, Buffer.byteLength(BODY));

  const replaced = await scenario("cancel-and-replace");
  t.diagnostic(JSON.stringify(replaced));
  assert.equal(replaced.accepted, false); assert.equal(replaced.code, "transport-failed");
  assert.equal(replaced.diagnostic?.stage, "native-evidence"); assert.equal(replaced.diagnostic?.category, "loading-failed");
  assert.equal(replaced.diagnostic?.networkFailure, "cancelled"); assert.equal(replaced.diagnostic?.nativeRequest, true);
  assert.equal(replaced.diagnostic?.nativeResponse, true); assert.equal(replaced.diagnostic?.nativeFinished, false);
  assert.equal(replaced.diagnostic?.nativeFailed, true); assert.equal(replaced.diagnostic?.stream, "ready");
  assert.equal(replaced.diagnostic?.pageReadCompleted, true); assert.equal(replaced.diagnostic?.pageBodyPresent, true);
  assert.equal(replaced.diagnostic?.pageBodyBytes, Buffer.byteLength(BODY));
  assert.equal(replaced.diagnostic?.nativeObservedBytes, Buffer.byteLength(PREFIX));
  assert.equal(replaced.diagnostic?.nativeRetainedBytes, Buffer.byteLength(PREFIX));
  assert.equal(replaced.diagnostic?.byteCountsCapped, false);
  assert.equal(replaced.nativeCancelled, 1);

  const truncated = await scenario("server-truncated");
  t.diagnostic(JSON.stringify(truncated));
  assert.equal(truncated.accepted, false); assert.equal(truncated.code, "transport-failed");
  assert.equal(truncated.diagnostic?.stage, "page-fetch"); assert.equal(truncated.diagnostic?.category, "body-read-rejected");
  assert.equal(truncated.nativeFinished, 0); assert.equal(truncated.nativeFailed, 1); assert.equal(truncated.nativeCancelled, 0);
  assert.equal(truncated.diagnostic?.pageReadCompleted, false);
  assert.equal(truncated.diagnostic?.pageBodyBytes, undefined);
  // A first-failure snapshot can precede the genuine loadingFailed event; the
  // external counters above describe the whole observed receipt window.
  assert.equal(truncated.diagnostic?.nativeObservedBytes, Buffer.byteLength(PREFIX));

  const routed = await scenario("complete-routed");
  t.diagnostic(JSON.stringify(routed));
  assertUntouchedReceipt(routed, Buffer.byteLength(BODY));
});

// Hypothesis from matching installed Chromium151.0.7922.138, not an asserted
// causal trace: ResponseBodyLoader::DelegatingBytesConsumer::OnStateChange calls
// its client before HandleResult(kDone); BodyStreamBuffer closes then cancels its
// consumer, which can reenter that delegate before its done state is recorded.
// https://raw.githubusercontent.com/chromium/chromium/151.0.7922.138/third_party/blink/renderer/platform/loader/fetch/response_body_loader.cc#L163-L279
// https://raw.githubusercontent.com/chromium/chromium/151.0.7922.138/third_party/blink/renderer/core/fetch/body_stream_buffer.cc#L353-L495
// Response Cache-Control:no-store selects direct consumer, not delayed buffering:
// https://raw.githubusercontent.com/chromium/chromium/151.0.7922.138/third_party/blink/renderer/core/fetch/fetch_manager.cc#L737-L777
// arrayBuffer follows Body::LoadAndConvertBody -> BodyStreamBuffer::StartLoading
// -> ReleaseHandle -> FetchDataLoader, unlike a JS getReader loop. The consumer
// adapter is fixture-only; no inference here authorizes unbounded production
// arrayBuffer allocation or accepting native cancellation as success.
// https://raw.githubusercontent.com/chromium/chromium/151.0.7922.138/third_party/blink/renderer/core/fetch/body.cc#L211-L245
// https://raw.githubusercontent.com/chromium/chromium/151.0.7922.138/third_party/blink/renderer/core/fetch/body_stream_buffer.cc#L228-L266
test("native consumer comparison accepts exact completion or refuses full-byte native cancellation", { timeout: 25_000 }, async (t) => {
  for (const consumer of ["reader", "array-buffer"] as const) for (const mode of ["chunked-immediate", "chunked-delayed"] as const) {
    const result = await scenario(mode, consumer);
    t.diagnostic(JSON.stringify(result));
    // Reader cancellation observed on installed Chromium151.0.7922.138. A
    // future Chromium fix may produce fully validated completion instead.
    // This captures behavior, not proof of the inferred internal cause.
    assertUntouchedReceipt(result, 98_129);
    if (consumer === "array-buffer") assert.equal(result.accepted, true, "The native consumer must pass the owned complete response");
  }
});

test("production response consumption completes delayed chunked EOF", { timeout: 12_000 }, async (t) => {
  const result = await scenario("chunked-delayed", "production");
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.accepted, true, "The production consumer must complete this stream-eligible native response");
  assertUntouchedReceipt(result, 98_129);
});
