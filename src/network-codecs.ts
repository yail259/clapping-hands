export type JsonResponseCodec = "json" | "json-lines";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 128;
export type ServerErrorCategory = "authentication" | "access-restriction" | "throttling" | "request-validation" | "temporary-server-error" | "unclassified";
function errorCategory(parsed: unknown): ServerErrorCategory {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unclassified";
  const object = parsed as Record<string, unknown>;
  // Examine only bounded, conventional error text fields. Never return their text.
  const message = ["errorSummary", "errorDescription", "message", "error", "errors"].flatMap((key) => {
    const value = object[key];
    if (typeof value === "string") return [value.slice(0, 4096)];
    // Some conventional error fields wrap rendered text in {__html: ...}.
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).__html === "string") {
      return [(value as { __html: string }).__html.slice(0, 4096).replace(/<[^>]*>/g, " ")];
    }
    return [];
  }).join(" ");
  if (/captcha|checkpoint|access denied|not permitted|permission denied|blocked|unusual activity/i.test(message)) return "access-restriction";
  if (/rate limit|too many requests|throttl/i.test(message)) return "throttling";
  if (/log[ -]?in|sign[ -]?in|not authenticated|session expired|authentication required/i.test(message)) return "authentication";
  if (/csrf|xsrf|invalid (?:request|parameter|token)|missing (?:parameter|token)|malformed/i.test(message)) return "request-validation";
  if (/temporar|something went wrong|try again later|internal server/i.test(message)) return "temporary-server-error";
  return "unclassified";
}
export class JsonResponseCodecError extends Error {
  readonly diagnostic: { lines: number; singleJson: boolean; errorEnvelope: boolean; html: boolean; category: ServerErrorCategory; applicationErrorCode?: number };
  constructor(body: string) {
    super("JSON response does not match its declared codec.");
    let singleJson = false, errorEnvelope = false;
    let category: ServerErrorCategory = "unclassified";
    let applicationErrorCode: number | undefined;
    try {
      const parsed: unknown = JSON.parse(stripPrefix(body));
      singleJson = true;
      errorEnvelope = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && ["error", "errors", "errorSummary", "errorDescription"].some((key) => Object.hasOwn(parsed, key)));
      if (errorEnvelope) category = errorCategory(parsed);
      if (errorEnvelope) {
        const code = (parsed as Record<string, unknown>).error;
        if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 2_147_483_647) applicationErrorCode = code;
      }
    } catch { /* Metadata only; never retain a parser message or input. */ }
    this.diagnostic = { lines: Math.min(body.split(/\r?\n/).filter((line) => line.trim()).length, 129), singleJson, errorEnvelope,
      html: /^\s*<(?:!doctype|html)/i.test(body), category, ...(applicationErrorCode !== undefined ? { applicationErrorCode } : {}) };
  }
}
function stripPrefix(value: string): string {
  return value.trim().replace(/^for\s*\(;;\);\s*/, "").replace(/^\)\]\}',?\s*/, "");
}
export function decodeJsonResponse(body: string, codec: JsonResponseCodec): unknown {
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("JSON response exceeds codec limit.");
  try {
    if (codec === "json") return JSON.parse(stripPrefix(body));
    if (codec !== "json-lines") throw new Error();
    const lines = body.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2 || lines.length > MAX_RECORDS) throw new Error();
    // Preserve frame boundaries. Never execute JS or merge incremental patches.
    return lines.map((line) => JSON.parse(stripPrefix(line)) as unknown);
  } catch { throw new JsonResponseCodecError(body); }
}
export function inferJsonResponse(body: string): { codec: JsonResponseCodec; value: unknown } {
  try { return { codec: "json", value: decodeJsonResponse(body, "json") }; }
  catch { return { codec: "json-lines", value: decodeJsonResponse(body, "json-lines") }; }
}

export type RelativeUrlValue = { pathname: string; query: Record<string, string[]> };
export function decodeRelativeUrl(value: string): RelativeUrlValue | null {
  if (value.length > 8192 || !value.startsWith("/") || value.startsWith("//") || !value.includes("?")) return null;
  try {
    const url = new URL(value, "https://codec.invalid");
    if (url.origin !== "https://codec.invalid" || url.hash || url.pathname !== value.split("?")[0]) return null;
    const query: Record<string, string[]> = Object.create(null);
    for (const [key, part] of url.searchParams) (query[key] ??= []).push(part);
    return { pathname: url.pathname, query };
  } catch { return null; }
}
export function encodeRelativeUrl(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid relative URL value.");
  const { pathname, query } = value as RelativeUrlValue;
  if (typeof pathname !== "string" || !query || typeof query !== "object" || Array.isArray(query)) throw new Error("Invalid relative URL structure.");
  const parameters = new URLSearchParams();
  for (const [key, values] of Object.entries(query)) {
    if (!Array.isArray(values) || values.some((part) => typeof part !== "string" && typeof part !== "number" && typeof part !== "boolean")) {
      throw new Error("Invalid relative URL query values.");
    }
    for (const part of values) parameters.append(key, String(part));
  }
  const result = pathname + "?" + parameters.toString();
  if (!decodeRelativeUrl(result)) throw new Error("Unsafe relative URL value.");
  return result;
}
