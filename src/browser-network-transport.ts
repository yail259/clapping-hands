import type { BrowserContext, JSHandle, Page } from "playwright-core";
import { nativeNetworkReceipt, NativeNetworkReceiptError, nativeFailureDiagnostic, type NativeNetworkReceiptFailure, type NativeFailureDiagnostic } from "./native-network-receipt.js";
import { isSessionHeaderName } from "./ephemeral-request-headers.js";

const MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_HEADERS = new Set(["accept", "content-type", "x-requested-with"]);
const RESPONSE_HEADERS = ["content-range", "link", "x-pagination-pages", "x-total-pages", "x-wp-totalpages"];
type FailureCode = NativeNetworkReceiptFailure;

export class BrowserNetworkTransportError extends Error {
  constructor(readonly code: FailureCode) { super(`Browser-network transport refused (${code}).`); }
}
const nativeDiagnostics = new WeakMap<object, NativeFailureDiagnostic>();
export function browserNetworkFailureDiagnostic(error: unknown): NativeFailureDiagnostic | undefined {
  if (!error || typeof error !== "object" && typeof error !== "function") return;
  const diagnostic = nativeDiagnostics.get(error);
  return diagnostic && { ...diagnostic };
}

declare const documentBrand: unique symbol;
export type BrowserNetworkDocument = { readonly [documentBrand]: true };
type DocumentState = { context: BrowserContext; page: Page; url: string; document: JSHandle<Document> };
const documents = new WeakMap<BrowserNetworkDocument, DocumentState>();

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserNetworkTransportError("timeout")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** In-memory document identity, never a persisted cookie or DOM snapshot. */
export async function captureBrowserNetworkDocument(context: BrowserContext, page: Page): Promise<BrowserNetworkDocument> {
  let handle: JSHandle<Document> | undefined;
  let finished = false;
  try {
    if (page.context() !== context || page.isClosed()) throw new BrowserNetworkTransportError("document-changed");
    const url = new URL(page.url());
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new BrowserNetworkTransportError("invalid-request");
    const pending = page.evaluateHandle(() => document).then((document) => {
      if (finished) void document.dispose().catch(() => {});
      return document;
    });
    handle = await bounded(pending, 5000);
    if (page.url() !== url.href || page.context() !== context || page.isClosed()) throw new BrowserNetworkTransportError("document-changed");
    const lease = Object.freeze({}) as BrowserNetworkDocument;
    documents.set(lease, { context, page, url: url.href, document: handle });
    handle = undefined;
    return lease;
  } catch (error) {
    if (error instanceof BrowserNetworkTransportError) throw error;
    throw new BrowserNetworkTransportError("document-changed");
  } finally {
    finished = true;
    await handle?.dispose().catch(() => {});
  }
}

export async function disposeBrowserNetworkDocument(lease: BrowserNetworkDocument): Promise<void> {
  const state = documents.get(lease);
  documents.delete(lease);
  await state?.document.dispose().catch(() => {});
}

export type BrowserNetworkRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maximumBytes?: number;
  /** Experimental: may refuse already-finished responses; never silently downgraded. */
  nativeReceipt?: boolean;
};
export type BrowserNetworkResponse = { status: number; ok: boolean; contentType: string; headers: Record<string, string>; body: string; bytes: Buffer };

/** Transport only: endpoint, input and read semantics must already be validated.
 * The default path retains its conservative worker-controller refusal. Explicit
 * nativeReceipt trials instead require exact native request/response byte evidence;
 * a nonintercepting controller can pass, but already-finished bodies may be refused.
 * Neither path performs UI/model work, Node fallback, retries or worker bypass. */
export async function browserNetworkFetch(
  context: BrowserContext, page: Page, lease: BrowserNetworkDocument, request: BrowserNetworkRequest,
): Promise<BrowserNetworkResponse> {
  if (request.nativeReceipt !== true) return legacyBrowserNetworkFetch(context, page, lease, request);
  try {
    const state = documents.get(lease);
    if (!state || state.context !== context || state.page !== page || page.context() !== context || page.isClosed() || page.url() !== state.url) {
      throw new BrowserNetworkTransportError("document-changed");
    }
    const timeoutMs = request.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new BrowserNetworkTransportError("invalid-request");
    const receipt = await nativeNetworkReceipt(
      { page, document: state.document, documentUrl: state.url },
      { url: request.url, method: request.method, headers: request.headers, body: request.body },
      { deadlineAt: performance.now() + timeoutMs, maximumBytes: request.maximumBytes ?? MAX_BYTES },
    );
    if (page.isClosed() || page.context() !== context || page.url() !== state.url) throw new BrowserNetworkTransportError("document-changed");
    return { status: receipt.status, ok: receipt.ok, contentType: receipt.contentType, headers: receipt.headers,
      body: receipt.bytes.toString("utf8"), bytes: receipt.bytes };
  } catch (error) {
    if (error instanceof BrowserNetworkTransportError) throw error;
    if (error instanceof NativeNetworkReceiptError) {
      const wrapped = new BrowserNetworkTransportError(error.code);
      const diagnostic = nativeFailureDiagnostic(error);
      if (diagnostic) nativeDiagnostics.set(wrapped, diagnostic);
      throw wrapped;
    }
    throw new BrowserNetworkTransportError("transport-failed");
  }
}

/** Main-world fetch is not independent native freshness evidence. Keep the
 * previous opt-in browser-fetch behavior scoped to pages without a controller;
 * independent exact output checks are still required before promotion. */
async function legacyBrowserNetworkFetch(
  context: BrowserContext, page: Page, lease: BrowserNetworkDocument, request: BrowserNetworkRequest,
): Promise<BrowserNetworkResponse> {
  try {
    const state = documents.get(lease);
    if (!state || state.context !== context || state.page !== page || page.context() !== context || page.isClosed() || page.url() !== state.url) {
      throw new BrowserNetworkTransportError("document-changed");
    }
    const url = new URL(request.url);
    const timeoutMs = request.timeoutMs ?? 30_000;
    const maximumBytes = request.maximumBytes ?? MAX_BYTES;
    if (url.origin !== new URL(state.url).origin || url.username || url.password || url.hash ||
      !new Set(["GET", "POST"]).has(request.method) || request.method === "GET" && request.body !== undefined ||
      request.body !== undefined && (typeof request.body !== "string" || Buffer.byteLength(request.body) > MAX_BYTES) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BYTES) {
      throw new BrowserNetworkTransportError("invalid-request");
    }
    const headers: Record<string, string> = {};
    if (Object.keys(request.headers).length > 32) throw new BrowserNetworkTransportError("invalid-request");
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if ((!REQUEST_HEADERS.has(lower) && !isSessionHeaderName(lower)) || Object.hasOwn(headers, lower) ||
        typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value)) throw new BrowserNetworkTransportError("invalid-request");
      headers[lower] = value;
    }
    const evaluated = page.evaluate(async (args) => {
      if (document !== args.document || location.href !== args.documentUrl || location.origin !== new URL(args.url).origin) return { error: "document-changed" as const };
      if (navigator.serviceWorker?.controller) return { error: "service-worker" as const };
      const controller = new AbortController();
      let failure: "timeout" | "document-changed" | "service-worker" | undefined;
      const timer = setTimeout(() => { failure = "timeout"; controller.abort(); }, args.timeoutMs);
      const listeners = [() => { failure = "document-changed"; controller.abort(); }, () => { failure = "service-worker"; controller.abort(); }];
      addEventListener("pagehide", listeners[0]!, { once: true });
      navigator.serviceWorker?.addEventListener("controllerchange", listeners[1]!);
      try {
        const response = await fetch(args.url, {
          method: args.method, headers: args.headers, ...(args.body === undefined ? {} : { body: args.body }),
          credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        });
        if (response.redirected || new URL(response.url).origin !== location.origin) return { error: "transport-failed" as const };
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > args.maximumBytes) {
              controller.abort(); void reader.cancel().catch(() => {});
              return { error: "response-too-large" as const };
            }
            chunks.push(chunk.value);
          }
        }
        if (failure) return { error: failure };
        if (document !== args.document || location.href !== args.documentUrl || location.origin !== new URL(args.url).origin) return { error: "document-changed" as const };
        if (navigator.serviceWorker?.controller) return { error: "service-worker" as const };
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
        const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) && mediaType.length <= 120 ? mediaType : "";
        const responseHeaders: Record<string, string> = {};
        for (const name of args.responseHeaders) {
          const value = response.headers.get(name);
          if (value !== null && value.length <= 4096) responseHeaders[name] = value;
        }
        return { response: { status: response.status, ok: response.ok, contentType, headers: responseHeaders, body: new TextDecoder().decode(bytes) } };
      } catch {
        return { error: failure ?? "transport-failed" as const };
      } finally {
        clearTimeout(timer); removeEventListener("pagehide", listeners[0]!);
        navigator.serviceWorker?.removeEventListener("controllerchange", listeners[1]!);
      }
    }, { document: state.document, documentUrl: state.url, url: url.href, method: request.method, headers,
      body: request.body, timeoutMs, maximumBytes, responseHeaders: RESPONSE_HEADERS });
    const outcome = await bounded(evaluated, timeoutMs);
    if (outcome.error) throw new BrowserNetworkTransportError(outcome.error);
    if (page.isClosed() || page.context() !== context || page.url() !== state.url) throw new BrowserNetworkTransportError("document-changed");
    if (!outcome.response) throw new BrowserNetworkTransportError("transport-failed");
    return { ...outcome.response, bytes: Buffer.from(outcome.response.body) };
  } catch (error) {
    if (error instanceof BrowserNetworkTransportError) throw error;
    throw new BrowserNetworkTransportError("transport-failed");
  }
}
