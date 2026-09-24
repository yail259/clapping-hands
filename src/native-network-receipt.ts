import type { CDPSession, JSHandle, Page, Request } from "playwright-core";
import { isSessionHeaderName } from "./ephemeral-request-headers.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS = 64;
const MAX_EVENTS = 2048;
const MAX_METADATA_BYTES = 256 * 1024;
const REQUEST_HEADERS = new Set(["accept", "content-type", "x-requested-with"]);
const RESPONSE_HEADERS = ["content-range", "link", "x-pagination-pages", "x-total-pages", "x-wp-totalpages"];
const activePages = new WeakSet<Page>();

export type NativeNetworkReceiptFailure = "invalid-request" | "busy" | "document-changed" | "service-worker"
  | "browser-cache" | "ambiguous-request" | "request-mismatch" | "redirect" | "timeout" | "response-too-large"
  | "evidence-limit" | "stream-unavailable" | "transport-failed";
export class NativeNetworkReceiptError extends Error {
  constructor(readonly code: NativeNetworkReceiptFailure) { super(`Native network receipt refused (${code}).`); }
}
export type NativeFailureDiagnostic = {
  stage: "session" | "network-setup" | "document-setup" | "page-fetch" | "native-evidence" | "byte-comparison" | "document-check" | "cleanup";
  category: "cdp-command" | "page-evaluate" | "fetch-rejected" | "body-read-rejected" | "serialization-rejected" | "loading-failed" | "event-handler" | "session-closed" | "validation" | "cleanup-failed" | "timeout";
  pageMatches: 0 | 1 | 2;
  nativeRequest: boolean;
  nativeResponse: boolean;
  nativeFinished: boolean;
  nativeFailed: boolean;
  stream: "not-started" | "pending" | "ready" | "unavailable";
  /** Page-facing completion is diagnostic only, never native freshness proof. */
  pageReadCompleted: boolean;
  pageBodyPresent?: boolean;
  pageBodyBytes?: number;
  nativeObservedBytes: number;
  nativeRetainedBytes: number;
  byteCountsCapped: boolean;
  networkFailure?: "cancelled" | "cors" | "csp" | "mixed-content" | "origin" | "inspector" | "integrity" | "subresource-filter" | "content-type" | "blocked-other" | "aborted" | "network-error";
};
const failureDiagnostics = new WeakMap<object, NativeFailureDiagnostic>();
/** Fixed diagnostic evidence only; getters/serializers on thrown values are never inspected. */
export function nativeFailureDiagnostic(error: unknown): NativeFailureDiagnostic | undefined {
  if (!error || typeof error !== "object" && typeof error !== "function") return;
  const diagnostic = failureDiagnostics.get(error);
  return diagnostic && { ...diagnostic };
}
export type NativeNetworkScope = { page: Page; document: JSHandle<Document>; documentUrl: string };
export type NativeNetworkRequest = { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string };
export type NativeNetworkReceipt = {
  url: string; status: number; ok: boolean; bytes: Buffer; contentType: string; headers: Record<string, string>;
  provenance: { transport: "chromium-cdp"; requestCount: 1; fromServiceWorker: false; fromBrowserCache: false };
};
type Watch = {
  document: Document; url: string; controller: AbortController; serviceWorker: ServiceWorker | null;
  changed: boolean; timedOut: boolean; timer: ReturnType<typeof setTimeout>; listeners: Array<() => void>;
};
type ResponseEvidence = {
  status: number; url: string; frameId?: string; loaderId: string; hasExtraInfo: boolean;
  contentType: string; headers: Record<string, string>;
};
type Candidate = {
  id: string; response?: ResponseEvidence; finished: boolean; failed: boolean; streamed: boolean; streamUnavailable: boolean;
  prefix?: Buffer; chunks: Buffer[]; retainedBytes: number; dataLength: number;
};
type Event = "Network.requestWillBeSent" | "Network.responseReceived" | "Network.requestWillBeSentExtraInfo"
  | "Network.responseReceivedExtraInfo" | "Network.requestServedFromCache" | "Network.dataReceived"
  | "Network.loadingFinished" | "Network.loadingFailed";

function safeError(error: unknown): NativeNetworkReceiptError {
  return error instanceof NativeNetworkReceiptError ? error : new NativeNetworkReceiptError("transport-failed");
}
function validate(scope: NativeNetworkScope, request: NativeNetworkRequest, options: { deadlineAt: number; maximumBytes?: number }) {
  try {
    const documentUrl = new URL(scope.documentUrl);
    const url = new URL(request.url);
    const maximumBytes = options.maximumBytes ?? MAX_BYTES;
    const remaining = options.deadlineAt - performance.now();
    if (!["http:", "https:"].includes(documentUrl.protocol) || documentUrl.username || documentUrl.password
      || url.origin !== documentUrl.origin || url.username || url.password || url.hash || url.href !== request.url
      || request.url.length > 16_384 || !["GET", "POST"].includes(request.method)
      || request.method === "GET" && request.body !== undefined
      || request.body !== undefined && (typeof request.body !== "string" || Buffer.byteLength(request.body) > MAX_BYTES)
      || !Number.isFinite(remaining) || remaining <= 0 || remaining > 30_000
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BYTES
      || !request.headers || typeof request.headers !== "object" || Object.keys(request.headers).length > 32) {
      throw new NativeNetworkReceiptError("invalid-request");
    }
    const headers: Record<string, string> = {};
    let headerBytes = 0;
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if ((!REQUEST_HEADERS.has(lower) && !isSessionHeaderName(lower)) || Object.hasOwn(headers, lower)
        || typeof value !== "string" || value.length > 8192 || value.trim() !== value || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw new NativeNetworkReceiptError("invalid-request");
      }
      headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (headerBytes > 64 * 1024) throw new NativeNetworkReceiptError("invalid-request");
      headers[lower] = value;
    }
    return { headers, maximumBytes, body: Buffer.from(request.body ?? ""), context: scope.page.context() };
  } catch (error) {
    if (error instanceof NativeNetworkReceiptError) throw error;
    throw new NativeNetworkReceiptError("invalid-request");
  }
}

/** Chromium-only, in-memory receipt for ONE caller-authorized read. This is not
 * effect classification: the caller must validate the endpoint/read semantics.
 * No navigation, interception, cache disabling, worker bypass, marker headers,
 * body-refetch APIs, retries or persisted authentication evidence are used.
 *
 * The limits bound retained Node native payload and serialized/accepted page
 * bytes, not total allocation or peak memory in Chromium/CDP. Native data events
 * trigger an asynchronous scoped abort on decoded-size overflow; arrayBuffer
 * can allocate the whole browser body before that abort or its final size check.
 * streamResourceContent is experimental and may be unavailable for
 * already-finished requests; incomplete/unavailable binary evidence is refused.
 * Uniqueness applies to this owned request window, not arbitrary future traffic
 * scheduled by site scripts after the receipt has completed.
 * See https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent
 * Bytes are content-decoded (e.g. after gzip), before charset/BOM/JSON decoding.
 */
export async function nativeNetworkReceipt(
  scope: NativeNetworkScope, request: NativeNetworkRequest, options: { deadlineAt: number; maximumBytes?: number },
): Promise<NativeNetworkReceipt> {
  // Do not let an in-flight caller mutation change the correlation contract.
  try {
    scope = { page: scope.page, document: scope.document, documentUrl: scope.documentUrl };
    request = { url: request.url, method: request.method, headers: request.headers, body: request.body };
    options = { deadlineAt: options.deadlineAt, maximumBytes: options.maximumBytes };
  } catch { throw new NativeNetworkReceiptError("invalid-request"); }
  const { headers, maximumBytes, body, context } = validate(scope, request, options);
  request.headers = headers;
  const page = scope.page;
  if (activePages.has(page)) throw new NativeNetworkReceiptError("busy");
  if (page.isClosed() || page.url() !== scope.documentUrl) throw new NativeNetworkReceiptError("document-changed");
  activePages.add(page);
  const cleanupReserve = Math.min(250, Math.max(1, (options.deadlineAt - performance.now()) / 10));
  const workDeadline = options.deadlineAt - cleanupReserve;
  const mainFrame = page.mainFrame();
  let session: CDPSession | undefined;
  let watch: JSHandle<Watch> | undefined;
  let collecting = true;
  let failure: NativeNetworkReceiptError | undefined;
  let stage: NativeFailureDiagnostic["stage"] = "session";
  let category: NativeFailureDiagnostic["category"] = "cdp-command";
  let firstDiagnostic: NativeFailureDiagnostic | undefined;
  let networkFailure: NativeFailureDiagnostic["networkFailure"];
  let pageReadCompleted = false;
  let pageBodyPresent: boolean | undefined;
  let pageBodyBytes: number | undefined;
  let wake: (() => void) | undefined;
  let rejectFailure!: (error: NativeNetworkReceiptError) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failed.catch(() => {});
  const snapshot = (): NativeFailureDiagnostic => ({ stage, category, pageMatches: Math.min(2, pageMatches) as 0 | 1 | 2,
    nativeRequest: Boolean(candidate), nativeResponse: nativeResponseSeen, nativeFinished: candidate?.finished === true,
    nativeFailed: candidate?.failed === true, stream: !candidate ? "not-started" : candidate.streamUnavailable ? "unavailable" : candidate.streamed ? "ready" : "pending",
    pageReadCompleted, ...(pageBodyPresent === undefined ? {} : { pageBodyPresent }), ...(pageBodyBytes === undefined ? {} : { pageBodyBytes }),
    nativeObservedBytes: Math.min(MAX_BYTES, candidate?.dataLength ?? 0), nativeRetainedBytes: Math.min(MAX_BYTES, candidate?.retainedBytes ?? 0),
    byteCountsCapped: (candidate?.dataLength ?? 0) > MAX_BYTES || (candidate?.retainedBytes ?? 0) > MAX_BYTES,
    ...(networkFailure ? { networkFailure } : {}) });
  const fail = (code: NativeNetworkReceiptFailure, reason?: NativeFailureDiagnostic["category"]) => {
    if (!failure) {
      category = reason ?? (code === "timeout" ? "timeout" : code === "transport-failed" ? category : "validation");
      firstDiagnostic ??= snapshot();
      failure = new NativeNetworkReceiptError(code); rejectFailure(failure);
    }
    wake?.(); wake = undefined;
    // Scoped abort only: do not stop/navigate the page or other browser traffic.
    if (watch) void watch.evaluate((state) => state.controller.abort()).catch(() => {});
  };
  const timer = setTimeout(() => fail("timeout"), Math.max(1, workDeadline - performance.now()));
  const within = <T>(promise: Promise<T>): Promise<T> => {
    if (performance.now() >= workDeadline) fail("timeout");
    return Promise.race([promise, failed]);
  };
  const until = async (condition: () => boolean) => {
    while (!condition()) {
      if (failure) throw failure;
      await within(new Promise<void>((done) => { wake = done; }));
    }
    if (failure) throw failure;
  };
  let eventCount = 0;
  let metadataBytes = 0;
  let requestCount = 0;
  let pageMatches = 0;
  let candidate: Candidate | undefined;
  let nativeResponseSeen = false;
  let frameId = "";
  let loaderId = "";
  const requestHeaders = new Map<string, Record<string, string>>();
  const responseStatuses = new Map<string, number>();
  const cacheHits = new Set<string>();
  const listeners: Array<[Event, (...args: any[]) => void]> = [];
  const retainMetadata = (size: number) => {
    metadataBytes += size;
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > MAX_METADATA_BYTES) fail("evidence-limit");
  };
  const tick = () => {
    if (!collecting || failure) return false;
    if (++eventCount > MAX_EVENTS) { fail("evidence-limit"); return false; }
    return true;
  };
  const decode = (value: unknown, remaining: number): Buffer | undefined => {
    if (typeof value !== "string" || value.length % 4 !== 0) {
      fail("stream-unavailable"); return;
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const size = value.length / 4 * 3 - padding;
    if (size > remaining) { fail("response-too-large"); return; }
    // Guard length BEFORE scanning/allocating. Repeating base64 regexes can
    // overflow V8's regexp stack on valid multi-megabyte response bodies.
    for (let index = 0; index < value.length - padding; index++) {
      const code = value.charCodeAt(index);
      if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) {
        fail("stream-unavailable"); return;
      }
    }
    return Buffer.from(value, "base64");
  };
  const headerSubset = (value: unknown, selected: string[]): Record<string, string> | undefined => {
    if (!value || typeof value !== "object") { fail("request-mismatch"); return; }
    const keys = Object.keys(value);
    if (keys.length > 128) { fail("evidence-limit"); return; }
    const found: Record<string, string> = {};
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (!selected.includes(lower)) continue;
      const item = (value as Record<string, unknown>)[key];
      if (Object.hasOwn(found, lower) || typeof item !== "string" || item.length > 8192 || /[\r\n\0]/.test(item)) {
        fail("request-mismatch"); return;
      }
      retainMetadata(Buffer.byteLength(item) + lower.length);
      if (failure) return;
      found[lower] = item;
    }
    return found;
  };
  const verifyWireHeaders = () => {
    if (!candidate) return;
    const actual = requestHeaders.get(candidate.id);
    if (actual && Object.entries(headers).some(([name, value]) => actual[name] !== value)) fail("request-mismatch");
  };
  const onPageRequest = (observed: Request) => {
    if (!tick()) return;
    if (observed.url() !== request.url || observed.method() !== request.method) return;
    const actualBody = observed.postDataBuffer();
    if (actualBody && actualBody.byteLength > MAX_BYTES) { fail("evidence-limit"); return; }
    if (!(actualBody ?? Buffer.alloc(0)).equals(body)) return;
    if (++pageMatches !== 1) { fail("ambiguous-request"); return; }
    try { if (observed.serviceWorker() || observed.frame() !== mainFrame) fail("request-mismatch"); }
    catch { fail("request-mismatch"); }
    if (observed.redirectedFrom()) fail("redirect");
  };
  const onNavigation = (frame: ReturnType<Page["mainFrame"]>) => { if (frame === mainFrame) fail("document-changed"); };
  const onClosed = () => { if (collecting) fail("document-changed"); };
  const onSessionClosed = () => { if (collecting) fail("transport-failed", "session-closed"); };
  const listen = (event: Event, callback: (event: any) => void) => {
    const listener = (value: unknown) => {
      if (!tick()) return;
      try { callback(value); } catch { fail("transport-failed", "event-handler"); }
      wake?.(); wake = undefined;
    };
    listeners.push([event, listener]); session!.on(event, listener);
  };
  let output: NativeNetworkReceipt | undefined;
  let sessionAcquisition: Promise<CDPSession> | undefined;
  let watchAcquisition: Promise<JSHandle<Watch>> | undefined;
  const disposeWatch = async (value: JSHandle<Watch>) => {
    try {
      await value.evaluate((state) => {
        state.controller.abort(); clearTimeout(state.timer);
        removeEventListener("pagehide", state.listeners[0]!);
        navigator.serviceWorker?.removeEventListener("controllerchange", state.listeners[1]!);
      });
    } finally { await value.dispose().catch(() => {}); }
  };
  try {
    sessionAcquisition = context.newCDPSession(page).then(async (value) => {
      if (!collecting) await value.detach();
      else session = value;
      return value;
    });
    await within(sessionAcquisition);
    session!.on("close", onSessionClosed);
    stage = "network-setup";
    await within(session!.send("Page.enable"));
    await within(session!.send("Network.enable", { maxTotalBufferSize: maximumBytes + MAX_BYTES,
      maxResourceBufferSize: maximumBytes, maxPostDataSize: Math.max(1, body.byteLength), enableDurableMessages: false }));
    const { frameTree } = await within(session!.send("Page.getFrameTree"));
    frameId = frameTree.frame.id; loaderId = frameTree.frame.loaderId;
    if (!frameId || !loaderId || frameTree.frame.url !== scope.documentUrl) throw new NativeNetworkReceiptError("document-changed");
    stage = "document-setup"; category = "page-evaluate";
    watchAcquisition = page.evaluateHandle((args) => {
      if (document !== args.document || location.href !== args.url) throw new Error("document-changed");
      const state = { document, url: args.url, controller: new AbortController(), serviceWorker: navigator.serviceWorker?.controller ?? null,
        changed: false, timedOut: false, timer: undefined as unknown as ReturnType<typeof setTimeout>, listeners: [] as Array<() => void> };
      state.listeners = [() => { state.changed = true; state.controller.abort(); }, () => { state.changed = true; state.controller.abort(); }];
      addEventListener("pagehide", state.listeners[0]!);
      navigator.serviceWorker?.addEventListener("controllerchange", state.listeners[1]!);
      state.timer = setTimeout(() => { state.timedOut = true; state.controller.abort(); }, args.remaining);
      return state;
    }, { document: scope.document, url: scope.documentUrl, remaining: Math.max(1, workDeadline - performance.now()) }).then(async (value) => {
      if (!collecting) await disposeWatch(value);
      else watch = value;
      return value;
    });
    try { await within(watchAcquisition); }
    catch (error) { if (failure) throw failure; throw new NativeNetworkReceiptError("document-changed"); }
    page.on("request", onPageRequest); page.on("framenavigated", onNavigation); page.on("close", onClosed); page.on("crash", onClosed);
    listen("Network.requestWillBeSent", (event) => {
      if (++requestCount > MAX_REQUESTS) { fail("evidence-limit"); return; }
      if (candidate?.id === event.requestId || event.redirectResponse && event.request.url === request.url) { fail("redirect"); return; }
      if (event.request.url !== request.url || event.request.method !== request.method) return;
      const entries = event.request.postDataEntries;
      let actualBody = Buffer.alloc(0);
      if (event.request.hasPostData || entries?.length) {
        if (!Array.isArray(entries) || entries.length > 64) { fail("request-mismatch"); return; }
        const parts: Buffer[] = []; let bytes = 0;
        for (const entry of entries) {
          const part = decode(entry.bytes, MAX_BYTES - bytes); if (!part) return;
          bytes += part.byteLength; parts.push(part);
        }
        actualBody = Buffer.concat(parts, bytes);
      }
      if (!actualBody.equals(body)) return;
      if (candidate) { fail("ambiguous-request"); return; }
      if (event.frameId !== frameId || event.loaderId !== loaderId || event.type === "Document") { fail("request-mismatch"); return; }
      candidate = { id: event.requestId, finished: false, failed: false, streamed: false, streamUnavailable: false,
        chunks: [], retainedBytes: 0, dataLength: 0 };
      const selected = candidate;
      if (cacheHits.has(selected.id) || responseStatuses.get(selected.id) === 304) { fail("browser-cache"); return; }
      verifyWireHeaders();
      // Start before response completion. Binary events may arrive before this
      // command resolves; the returned buffered prefix is prepended at the end.
      void session!.send("Network.streamResourceContent", { requestId: selected.id }).then((result) => {
        if (!collecting || failure) return;
        const prefix = decode(result.bufferedData, maximumBytes - selected.retainedBytes);
        if (prefix) { selected.prefix = prefix; selected.retainedBytes += prefix.byteLength; selected.streamed = true; }
        wake?.(); wake = undefined;
      }).catch(() => { selected.streamUnavailable = true; wake?.(); wake = undefined; });
    });
    listen("Network.requestWillBeSentExtraInfo", (event) => {
      if (requestHeaders.size >= MAX_REQUESTS) { fail("evidence-limit"); return; }
      const actual = headerSubset(event.headers, Object.keys(headers));
      if (actual) requestHeaders.set(event.requestId, actual);
      verifyWireHeaders();
    });
    listen("Network.responseReceivedExtraInfo", (event) => {
      if (responseStatuses.size >= MAX_REQUESTS) { fail("evidence-limit"); return; }
      responseStatuses.set(event.requestId, event.statusCode);
      if (candidate?.id === event.requestId && event.statusCode === 304) fail("browser-cache");
    });
    listen("Network.requestServedFromCache", (event) => {
      if (cacheHits.size >= MAX_REQUESTS) { fail("evidence-limit"); return; }
      cacheHits.add(event.requestId);
      if (candidate?.id === event.requestId) fail("browser-cache");
    });
    listen("Network.responseReceived", (event) => {
      if (!candidate || candidate.id !== event.requestId) return;
      // Receipt of the matching native response is evidence even when one of
      // the provenance/header guards below immediately refuses that response.
      nativeResponseSeen = true;
      if (event.response.fromServiceWorker) { fail("service-worker"); return; }
      if (event.response.fromDiskCache || event.response.fromPrefetchCache) { fail("browser-cache"); return; }
      if (event.response.status >= 300 && event.response.status < 400) { fail("redirect"); return; }
      if (event.frameId !== frameId || event.loaderId !== loaderId || event.response.url !== request.url) { fail("request-mismatch"); return; }
      const selected = headerSubset(event.response.headers, ["content-type", ...RESPONSE_HEADERS]);
      if (!selected) return;
      const media = (selected["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const contentType = media.length <= 120 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(media) ? media : "";
      const safeHeaders: Record<string, string> = {};
      for (const name of RESPONSE_HEADERS) if (selected[name] !== undefined && selected[name]!.length <= 4096) safeHeaders[name] = selected[name]!;
      candidate.response = { status: event.response.status, url: event.response.url, frameId: event.frameId,
        loaderId: event.loaderId, hasExtraInfo: event.hasExtraInfo === true, contentType, headers: safeHeaders };
    });
    listen("Network.dataReceived", (event) => {
      if (!candidate || candidate.id !== event.requestId) return;
      if (!Number.isSafeInteger(event.dataLength) || event.dataLength < 0) { fail("stream-unavailable"); return; }
      candidate.dataLength += event.dataLength;
      if (candidate.dataLength > maximumBytes) { fail("response-too-large"); return; }
      if (event.data !== undefined) {
        const chunk = decode(event.data, maximumBytes - candidate.retainedBytes); if (!chunk) return;
        if (chunk.byteLength !== event.dataLength) { fail("stream-unavailable"); return; }
        candidate.retainedBytes += chunk.byteLength; candidate.chunks.push(chunk);
      }
    });
    listen("Network.loadingFinished", (event) => { if (candidate && candidate.id === event.requestId) candidate.finished = true; });
    // A navigation can report loadingFailed before framenavigated/pagehide is
    // delivered. Preserve the failure and let document verification classify it.
    listen("Network.loadingFailed", (event) => {
      if (!candidate || candidate.id !== event.requestId) return;
      candidate.failed = true;
      const blocked = new Set(["csp", "mixed-content", "origin", "inspector", "integrity", "subresource-filter", "content-type"]);
      networkFailure = event.canceled === true ? "cancelled" : event.corsErrorStatus ? "cors"
        : blocked.has(event.blockedReason) ? event.blockedReason as NativeFailureDiagnostic["networkFailure"]
          : event.blockedReason ? "blocked-other" : event.errorText === "net::ERR_ABORTED" ? "aborted" : "network-error";
    });

    if (performance.now() >= workDeadline) throw new NativeNetworkReceiptError("timeout");
    stage = "page-fetch"; category = "page-evaluate";
    const value = await within(page.evaluate(async (args) => {
      const state = args.watch;
      if (state.changed || document !== state.document || location.href !== state.url) return { error: "document-changed" as const };
      let phase: "fetch-rejected" | "body-read-rejected" | "serialization-rejected" = "fetch-rejected";
      try {
        const response = await fetch(args.request.url, { method: args.request.method, headers: args.headers,
          ...(args.request.body === undefined ? {} : { body: args.request.body }), credentials: "same-origin", mode: "same-origin",
          cache: "no-store", redirect: "error", signal: state.controller.signal });
        if (response.redirected) return { error: "redirect" as const };
        if (response.url !== args.request.url) return { error: "request-mismatch" as const };
        phase = "body-read-rejected";
        const bodyPresent = Boolean(response.body);
        // Native body loading avoids Chromium's JS-reader EOF cancellation path.
        // Incremental native/CDP limits still abort this owned fetch. This final
        // page check bounds serialization, NOT whole-body allocation in Chrome.
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > args.maximumBytes) {
          state.controller.abort();
          return { error: "response-too-large" as const };
        }
        if (state.changed || document !== state.document || location.href !== state.url
          || (navigator.serviceWorker?.controller ?? null) !== state.serviceWorker) return { error: "document-changed" as const };
        if (state.timedOut) return { error: "timeout" as const };
        if (state.controller.signal.aborted) return { error: "transport-failed" as const, phase };
        phase = "serialization-rejected";
        const binary: string[] = [];
        for (let index = 0; index < bytes.length; index += 4096) binary.push(String.fromCharCode(...bytes.subarray(index, index + 4096)));
        return { status: response.status, url: response.url, base64: btoa(binary.join("")), bodyPresent, bodyBytes: bytes.byteLength };
      } catch {
        return { error: state.changed ? "document-changed" as const : state.timedOut ? "timeout" as const : "transport-failed" as const, phase };
      }
    }, { watch: watch!, request, headers, maximumBytes }));
    if (value.error) { category = value.phase ?? "validation"; throw new NativeNetworkReceiptError(value.error); }
    pageReadCompleted = true;
    if (typeof value.bodyPresent === "boolean") pageBodyPresent = value.bodyPresent;
    if (Number.isSafeInteger(value.bodyBytes) && value.bodyBytes! >= 0 && value.bodyBytes! <= maximumBytes) pageBodyBytes = value.bodyBytes;
    stage = "native-evidence"; category = "cdp-command";
    // Protocol barriers are not global quiescence; they follow this owned fetch.
    await within(session!.send("Runtime.evaluate", { expression: "0", returnByValue: true }));
    category = "validation";
    if (!candidate || pageMatches !== 1) throw new NativeNetworkReceiptError("request-mismatch");
    const selected: Candidate = candidate;
    await until(() => selected.failed || Boolean(selected.response && selected.finished && requestHeaders.has(selected.id)
      && (!selected.response.hasExtraInfo || responseStatuses.has(selected.id)) && (selected.streamed || selected.streamUnavailable)));
    if (selected.failed) { category = "loading-failed"; throw new NativeNetworkReceiptError("transport-failed"); }
    if (selected.streamUnavailable || !selected.prefix) throw new NativeNetworkReceiptError("stream-unavailable");
    // An evicted prefix can produce an apparently successful empty stream.
    // Require complete decoded-byte accounting from the request's first event.
    if (selected.retainedBytes !== selected.dataLength) throw new NativeNetworkReceiptError("stream-unavailable");
    stage = "byte-comparison";
    verifyWireHeaders();
    const pageBytes = decode(value.base64, maximumBytes);
    if (!pageBytes || failure) throw failure ?? new NativeNetworkReceiptError("stream-unavailable");
    const nativeBytes = Buffer.concat([selected.prefix, ...selected.chunks], selected.retainedBytes);
    if (!nativeBytes.equals(pageBytes) || selected.response!.status !== value.status || value.url !== request.url
      || responseStatuses.has(selected.id) && responseStatuses.get(selected.id) !== value.status) {
      throw new NativeNetworkReceiptError("request-mismatch");
    }
    stage = "document-check"; category = "page-evaluate";
    const unchanged = await within(watch!.evaluate((state) => !state.changed && !state.timedOut && document === state.document
      && location.href === state.url && (navigator.serviceWorker?.controller ?? null) === state.serviceWorker));
    category = "validation";
    if (!unchanged || page.isClosed() || page.context() !== context || page.url() !== scope.documentUrl) {
      throw new NativeNetworkReceiptError("document-changed");
    }
    if (failure) throw failure;
    if (performance.now() >= workDeadline) throw new NativeNetworkReceiptError("timeout");
    if (pageMatches !== 1) throw new NativeNetworkReceiptError("ambiguous-request");
    output = { url: request.url, status: value.status!, ok: value.status! >= 200 && value.status! < 300, bytes: nativeBytes,
      contentType: selected.response!.contentType, headers: selected.response!.headers,
      provenance: { transport: "chromium-cdp", requestCount: 1, fromServiceWorker: false, fromBrowserCache: false } };
  } catch (error) {
    let safe = safeError(error);
    // Freeze the initial failure before the asynchronous document probe. A
    // later deadline/event may still reclassify the refusal code, but must not
    // replace the evidence of what originally failed.
    if (!failure) {
      category = safe.code === "timeout" ? "timeout" : safe.code === "transport-failed" ? category : "validation";
      firstDiagnostic ??= snapshot();
    }
    if (!failure && watch && safe.code === "transport-failed") {
      try {
        const unchanged = await within(watch.evaluate((state) => !state.changed && document === state.document && location.href === state.url));
        if (!unchanged) safe = new NativeNetworkReceiptError("document-changed");
      } catch { safe = failure ?? new NativeNetworkReceiptError("document-changed"); }
    }
    fail(safe.code);
  } finally {
    stage = "cleanup"; category = "cleanup-failed";
    const recordCleanupFailure = (code: NativeNetworkReceiptFailure) => {
      if (failure) return; // Cleanup must never replace the first failure.
      category = code === "timeout" ? "timeout" : "cleanup-failed";
      firstDiagnostic ??= snapshot();
      failure = new NativeNetworkReceiptError(code);
    };
    collecting = false; clearTimeout(timer); wake = undefined;
    page.off("request", onPageRequest); page.off("framenavigated", onNavigation); page.off("close", onClosed); page.off("crash", onClosed);
    if (session) {
      session.off("close", onSessionClosed);
      for (const [event, listener] of listeners) session.off(event, listener);
    }
    const cleanup = Promise.allSettled([
      watch ? disposeWatch(watch) : watchAcquisition?.then(() => {}),
      session ? session.detach() : sessionAcquisition?.then(() => {}),
    ]).then((results) => {
      activePages.delete(page);
      if (results.some((result) => result.status === "rejected")) recordCleanupFailure("transport-failed");
    });
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleanup, new Promise<never>((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new NativeNetworkReceiptError("timeout")), Math.max(1, options.deadlineAt - performance.now()));
      })]);
    } catch (error) { recordCleanupFailure(safeError(error).code); }
    finally { clearTimeout(cleanupTimer); }
    if (performance.now() > options.deadlineAt) recordCleanupFailure("timeout");
    if (candidate) { candidate.chunks = []; candidate.prefix = undefined; }
    requestHeaders.clear(); responseStatuses.clear(); cacheHits.clear();
  }
  if (failure) { failureDiagnostics.set(failure, firstDiagnostic ?? snapshot()); throw failure; }
  if (!output) throw new NativeNetworkReceiptError("transport-failed");
  return output;
}
