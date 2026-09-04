import type { Page, Request, Response } from "playwright-core";
import type { CapturedExchange } from "./network-plan.js";

const MAX_EXCHANGES = 200;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type NetworkRecorderMark = {
  exchangeIndex: number;
  diagnosticIndex: number;
};

type CaptureOutcome = "captured" | "missing-request-body" | "response-too-large" | "response-body-error";

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

function safeOperation(requestBody: string | null): string {
  if (!requestBody) return "unknown";
  try {
    const value = new URLSearchParams(requestBody).get("fb_api_req_friendly_name") ?? "unknown";
    return /^[A-Za-z0-9_]{1,120}$/.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

function isCandidate(request: Request): boolean {
  if (request.method() !== "POST") return false;
  if (!new Set(["xhr", "fetch"]).has(request.resourceType())) return false;
  try {
    const url = new URL(request.url());
    return url.pathname.endsWith("/api/graphql/") || url.pathname.endsWith("/api/graphql");
  } catch {
    return false;
  }
}

function boundedHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (["cookie", "authorization", "proxy-authorization"].includes(lower)) continue;
    output[lower] = value;
  }
  return output;
}

export class NetworkRecorder {
  private readonly exchanges: CapturedExchange[] = [];
  private readonly diagnostics: CaptureDiagnostic[] = [];
  private readonly pending = new Set<Promise<void>>();
  private attached = false;

  attach(page: Page): void {
    if (this.attached) return;
    this.attached = true;
    page.on("response", (response) => {
      const request = response.request();
      if (!isCandidate(request)) return;
      const capture = this.capture(request, response).catch(() => {});
      this.pending.add(capture);
      void capture.finally(() => this.pending.delete(capture));
    });
  }

  mark(): NetworkRecorderMark {
    return { exchangeIndex: this.exchanges.length, diagnosticIndex: this.diagnostics.length };
  }

  async since(mark: NetworkRecorderMark): Promise<CapturedExchange[]> {
    await this.flush();
    return this.exchanges.slice(mark.exchangeIndex);
  }

  peekSince(mark: NetworkRecorderMark): CapturedExchange[] {
    return this.exchanges.slice(mark.exchangeIndex);
  }

  async diagnosticsSince(mark: NetworkRecorderMark): Promise<NetworkCaptureSummary> {
    await this.flush();
    return this.diagnosticSummary(mark);
  }

  diagnosticSnapshotSince(mark: NetworkRecorderMark): NetworkCaptureSummary {
    return this.diagnosticSummary(mark);
  }

  private diagnosticSummary(mark: NetworkRecorderMark): NetworkCaptureSummary {
    const events = this.diagnostics.slice(mark.diagnosticIndex);
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

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async capture(request: Request, response: Response): Promise<void> {
    const requestBody = request.postData();
    const operation = safeOperation(requestBody);
    if (!requestBody) {
      this.recordDiagnostic({ outcome: "missing-request-body", operation });
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
    const exchange: CapturedExchange = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: boundedHeaders(await request.allHeaders()),
      requestBody,
      responseStatus: response.status(),
      responseBody: body.toString("utf8"),
    };
    this.exchanges.push(exchange);
    if (this.exchanges.length > MAX_EXCHANGES) this.exchanges.splice(0, this.exchanges.length - MAX_EXCHANGES);
    this.recordDiagnostic({ outcome: "captured", operation });
  }

  private recordDiagnostic(diagnostic: CaptureDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > MAX_EXCHANGES * 4) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_EXCHANGES * 4);
    }
  }
}
