import type { Page, Request, Response } from "playwright-core";
import type { CapturedExchange } from "./captured-exchange.js";
import { rememberSessionHeaders } from "./ephemeral-request-headers.js";
import { rememberBrowserDecodedResponse } from "./captured-response.js";

const MAX_EXCHANGES = 200;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-range",
  "link",
  "x-pagination-pages",
  "x-total-pages",
  "x-wp-totalpages",
]);

export type NetworkRecorderMark = {
  exchangeIndex: number;
  diagnosticIndex: number;
  requestSequence: number;
};

type RequestProvenance = { page: Page; startedAt: number; sequence: number; mainFrame: boolean };

type CaptureOutcome =
  | "captured"
  | "cross-origin"
  | "unsupported-content-type"
  | "response-too-large"
  | "response-decoding-error"
  | "response-body-error";

type CaptureDiagnostic = {
  outcome: CaptureOutcome;
  operation: string;
};

export type NetworkCaptureSummary = {
  candidateResponses: number;
  capturedResponses: number;
  outcomes: Partial<Record<CaptureOutcome, number>>;
  operations: string[];
};

function safeOperation(request: Request): string {
  const requestBody = request.postData();
  try {
    if (requestBody) {
      const value = new URLSearchParams(requestBody).get("fb_api_req_friendly_name");
      if (value && /^[A-Za-z0-9_]{1,120}$/.test(value)) return value;
    }
    const url = new URL(request.url());
    return `${request.method()} ${url.pathname.slice(0, 160)}`;
  } catch {
    return "unknown";
  }
}

function isCandidate(request: Request, documentEvidence = false): boolean {
  if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(request.method())) return false;
  if (!new Set(["xhr", "fetch"]).has(request.resourceType()) && !(documentEvidence &&
    request.resourceType() === "document" && ["GET", "POST"].includes(request.method()))) return false;
  try {
    const url = new URL(request.url());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function boundedHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      ["cookie", "authorization", "proxy-authorization"].includes(lower) ||
      /(?:token|csrf|xsrf|api-key|secret|\blsd\b|dtsg)/i.test(lower)
    ) continue;
    output[lower] = value;
  }
  return output;
}

function boundedResponseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name, value]) => SAFE_RESPONSE_HEADERS.has(name) && value.length <= 4_096));
}

export class NetworkRecorder {
  constructor(private readonly options: { passiveCrossOriginEvidence?: boolean } = {}) {}
  private readonly exchanges: CapturedExchange[] = [];
  private readonly diagnostics: CaptureDiagnostic[] = [];
  private exchangeOffset = 0;
  private diagnosticOffset = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly attachedPages = new WeakSet<Page>();
  private allowedOrigins: Set<string> | null = null;
  private replayDepth = 0;
  private readonly replayRequests = new WeakSet<Request>();
  private requestSequence = 0;
  private readonly requestProvenance = new WeakMap<Request, RequestProvenance>();
  private readonly exchangeProvenance = new WeakMap<CapturedExchange, RequestProvenance>();
  private documentCaptureDepth = 0;
  private readonly documentRequests = new WeakSet<Request>();

  /** Opt in only around authorized learning actions; late responses retain the
   * request-start scope. Subframes and redirect chains are not form evidence. */
  async withDocumentResponses<T>(operation: () => Promise<T>): Promise<T> {
    this.documentCaptureDepth++;
    try { return await operation(); } finally { this.documentCaptureDepth--; }
  }

  /** Requests emitted by a compiled browser fetch must never become learning evidence. */
  async withoutReplayEvidence<T>(operation: () => Promise<T>): Promise<T> {
    this.replayDepth++;
    try { return await operation(); } finally { this.replayDepth--; }
  }

  setAllowedOrigins(origins: string[]): void {
    const normalized = origins.map((origin) => {
      const url = new URL(origin);
      if (!new Set(["http:", "https:"]).has(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
        throw new Error(`Network capture origin must be an HTTP(S) origin without a path: ${origin}`);
      }
      return url.origin;
    });
    this.allowedOrigins = new Set(normalized);
  }

  attach(page: Page): void {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    page.on("request", (request) => {
      if (this.replayDepth > 0) this.replayRequests.add(request);
      let mainFrame = false;
      try { mainFrame = request.frame() === page.mainFrame(); } catch { /* Worker requests cannot supply page context. */ }
      this.requestProvenance.set(request, { page, startedAt: performance.now(), sequence: ++this.requestSequence, mainFrame });
      if (mainFrame && this.documentCaptureDepth > 0 && request.resourceType() === "document" &&
        request.isNavigationRequest() && !request.redirectedFrom()) this.documentRequests.add(request);
    });
    page.on("response", (response) => {
      const request = response.request();
      if (this.replayRequests.has(request) || this.replayDepth > 0) return;
      if (!isCandidate(request, this.documentRequests.has(request))) return;
      const capture = this.capture(page, request, response).catch(() => {});
      this.pending.add(capture);
      void capture.finally(() => this.pending.delete(capture));
    });
  }

  mark(): NetworkRecorderMark {
    return {
      exchangeIndex: this.exchangeOffset + this.exchanges.length,
      diagnosticIndex: this.diagnosticOffset + this.diagnostics.length,
      requestSequence: this.requestSequence,
    };
  }

  /** Process-private provenance: late completion cannot make an old request fresh. */
  sourceSince(exchange: CapturedExchange, mark: NetworkRecorderMark): { page: Page; startedAt: number } | undefined {
    const source = this.exchangeProvenance.get(exchange);
    if (!source?.mainFrame || source.sequence <= mark.requestSequence) return undefined;
    return { page: source.page, startedAt: source.startedAt };
  }

  async since(mark: NetworkRecorderMark): Promise<CapturedExchange[]> {
    await this.flush();
    return this.peekSince(mark);
  }

  peekSince(mark: NetworkRecorderMark): CapturedExchange[] {
    if (mark.exchangeIndex < this.exchangeOffset) {
      throw new Error("Network capture window expired; repeat the demonstration with a shorter recording window.");
    }
    return this.exchanges.slice(mark.exchangeIndex - this.exchangeOffset);
  }

  async diagnosticsSince(mark: NetworkRecorderMark): Promise<NetworkCaptureSummary> {
    await this.flush();
    return this.diagnosticSummary(mark);
  }

  diagnosticSnapshotSince(mark: NetworkRecorderMark): NetworkCaptureSummary {
    return this.diagnosticSummary(mark);
  }

  private diagnosticSummary(mark: NetworkRecorderMark): NetworkCaptureSummary {
    if (mark.diagnosticIndex < this.diagnosticOffset) {
      throw new Error("Network diagnostic window expired; capture completeness cannot be established.");
    }
    const events = this.diagnostics.slice(mark.diagnosticIndex - this.diagnosticOffset);
    const outcomes: NetworkCaptureSummary["outcomes"] = {};
    for (const event of events) outcomes[event.outcome] = (outcomes[event.outcome] ?? 0) + 1;
    return {
      candidateResponses: events.length,
      capturedResponses: outcomes.captured ?? 0,
      outcomes,
      operations: [...new Set(events.map((event) => event.operation))].sort(),
    };
  }

  latest(): CapturedExchange[] {
    return [...this.exchanges];
  }

  async flush(timeoutMs = 5000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid capture deadline.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Network capture did not settle before its deadline; incomplete evidence was refused.")), timeoutMs);
    });
    try {
      while (this.pending.size > 0) await Promise.race([Promise.all([...this.pending]), deadline]);
    } finally { clearTimeout(timer); }
  }

  private async capture(page: Page, request: Request, response: Response): Promise<void> {
    const operation = safeOperation(request);
    try {
      const pageOrigin = new URL(page.url()).origin;
      const requestOrigin = new URL(request.url()).origin;
      const allowed = this.allowedOrigins ?? new Set([pageOrigin]);
      if (!allowed.has(requestOrigin) && !this.options.passiveCrossOriginEvidence) {
        this.recordDiagnostic({ outcome: "cross-origin", operation });
        return;
      }
    } catch {
      this.recordDiagnostic({ outcome: "cross-origin", operation });
      return;
    }
    const contentType = response.headers()["content-type"] ?? "";
    if (!/(?:^text\/|json|javascript|x-ndjson|graphql)/i.test(contentType)) {
      this.recordDiagnostic({ outcome: "unsupported-content-type", operation });
      return;
    }
    let body: Buffer;
    try {
      body = await response.body();
    } catch {
      this.recordDiagnostic({ outcome: "response-body-error", operation });
      return;
    }
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      this.recordDiagnostic({ outcome: "response-too-large", operation });
      return;
    }
    let responseBody = body.toString("utf8");
    const html = /^text\/html(?:\s*;|\s*$)/i.test(contentType);
    if (html) {
      // Chromium already decoded this document with its own charset rules and the
      // client protocol re-encodes that text as UTF-8. These are not wire bytes,
      // so applying a transport charset here would decode the document twice.
      try { responseBody = new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { this.recordDiagnostic({ outcome: "response-decoding-error", operation }); return; }
      if (responseBody.length === 0 || responseBody.includes("\0")) {
        this.recordDiagnostic({ outcome: "response-decoding-error", operation });
        return;
      }
    }
    const headers = await request.allHeaders();
    const exchange: CapturedExchange = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: boundedHeaders(headers),
      requestBody: request.postData() ?? "",
      responseStatus: response.status(),
      responseHeaders: boundedResponseHeaders(response.headers()),
      responseBody,
    };
    if (html) rememberBrowserDecodedResponse(exchange, responseBody);
    rememberSessionHeaders(exchange, headers);
    const provenance = this.requestProvenance.get(request);
    if (provenance) this.exchangeProvenance.set(exchange, provenance);
    this.exchanges.push(exchange);
    if (this.exchanges.length > MAX_EXCHANGES) {
      const removed = this.exchanges.length - MAX_EXCHANGES;
      this.exchanges.splice(0, removed);
      this.exchangeOffset += removed;
    }
    this.recordDiagnostic({ outcome: "captured", operation });
  }

  private recordDiagnostic(diagnostic: CaptureDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > MAX_EXCHANGES * 4) {
      const removed = this.diagnostics.length - MAX_EXCHANGES * 4;
      this.diagnostics.splice(0, removed);
      this.diagnosticOffset += removed;
    }
  }
}
