import { createHash } from "node:crypto";
import type { BrowserContext } from "playwright-core";
import type { CapturedExchange } from "./network-plan.js";

export type NetworkInput = Record<string, string | number | boolean>;
type Path = Array<string | number>;
type InputReference = { $clappingHandsInput: string };
type TemplateValue = null | string | number | boolean | InputReference | TemplateValue[] | { [key: string]: TemplateValue };

export type JsonShape =
  | { type: "null" | "string" | "number" | "boolean" }
  | { type: "array"; items: JsonShape | null }
  | { type: "object"; required: string[]; properties: Record<string, JsonShape> }
  | { type: "union"; anyOf: JsonShape[] };

export type GenericJsonPlan = {
  formatVersion: "clapping-hands.dev/v1alpha2";
  engine: "json-request-v1";
  action: string;
  version: number;
  effect: "read";
  origin: string;
  status: "candidate" | "provisional" | "stable" | "degraded";
  request: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    endpointOrigin?: string;
    endpointPath: string;
    headers: Record<string, string>;
    queryTemplate: Record<string, TemplateValue[]>;
    bodyCodec: "none" | "json" | "form";
    bodyTemplate: TemplateValue | Record<string, TemplateValue[]> | null;
    bindings: Record<string, Array<{ source: "query" | "body"; path: Path }>>;
  };
  response: {
    shape: JsonShape;
    maximumBytes: number;
  };
  evidence: {
    demonstrationInputHashes: string[];
    successfulShadowInputHashes: string[];
    successfulShadowCount?: number;
    failedShadowCount: number;
    lastValidatedAt: string | null;
  };
};

export type GenericNetworkDemonstration = {
  input: NetworkInput;
  exchange: CapturedExchange;
};

export type GenericNetworkTrace = {
  input: NetworkInput;
  exchanges: CapturedExchange[];
  outputText?: string;
};

const SENSITIVE_NAME = /(?:authorization|cookie|password|passwd|secret|token|csrf|xsrf|session|api[_-]?key|jazoest|dtsg|\blsd\b)/i;
const PUBLIC_OPAQUE_CONSTANT_NAME = /^(?:sha256hash|sha256_hash)$/i;
const SAFE_HEADERS = new Set(["accept", "content-type", "x-requested-with"]);

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function inferJsonShape(values: unknown[]): JsonShape {
  const groups = new Map<string, unknown[]>();
  for (const value of values) {
    const kind = valueKind(value);
    const group = groups.get(kind) ?? [];
    group.push(value);
    groups.set(kind, group);
  }
  if (groups.size > 1) {
    return { type: "union", anyOf: [...groups.values()].map((group) => inferJsonShape(group)) };
  }
  const [kind, group] = [...groups.entries()][0] ?? ["null", [null]];
  if (["null", "string", "number", "boolean"].includes(kind)) {
    return { type: kind as "null" | "string" | "number" | "boolean" };
  }
  if (kind === "array") {
    const items = group.flatMap((value) => value as unknown[]);
    return { type: "array", items: items.length > 0 ? inferJsonShape(items) : null };
  }
  const objects = group as Array<Record<string, unknown>>;
  const required = Object.keys(objects[0] ?? {}).filter((key) => objects.every((object) => key in object)).sort();
  return {
    type: "object",
    required,
    properties: Object.fromEntries(required.map((key) => [key, inferJsonShape(objects.map((object) => object[key]))])),
  };
}

export function matchesJsonShape(value: unknown, shape: JsonShape): boolean {
  if (shape.type === "union") return shape.anyOf.some((candidate) => matchesJsonShape(value, candidate));
  if (shape.type === "null") return value === null;
  if (shape.type === "array") {
    return Array.isArray(value) && (!shape.items || value.every((item) => matchesJsonShape(item, shape.items!)));
  }
  if (shape.type === "object") {
    return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
      shape.required.every((key) => key in (value as Record<string, unknown>) &&
        matchesJsonShape((value as Record<string, unknown>)[key], shape.properties[key]!));
  }
  return typeof value === shape.type;
}

function parseJson(body: string): unknown {
  const normalized = body.trim().replace(/^for\s*\(;;\);\s*/, "").replace(/^\)\]\}',?\s*/, "");
  return JSON.parse(normalized) as unknown;
}

function requestHeaders(exchange: CapturedExchange): Record<string, string> {
  return Object.fromEntries(Object.entries(exchange.requestHeaders)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => SAFE_HEADERS.has(name)));
}

function bodyCodec(exchange: CapturedExchange): "none" | "json" | "form" {
  if (!exchange.requestBody) return "none";
  const contentType = Object.entries(exchange.requestHeaders)
    .find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  if (/json/i.test(contentType)) return "json";
  if (/x-www-form-urlencoded/i.test(contentType)) return "form";
  throw new Error(`Unsupported request body content type ${contentType || "unknown"}.`);
}

function embeddedJson(value: string): TemplateValue {
  const candidate = value.trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return value;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" ? parsed as TemplateValue : value;
  } catch {
    return value;
  }
}

function recordFromSearchParams(parameters: URLSearchParams): Record<string, TemplateValue[]> {
  const output: Record<string, TemplateValue[]> = {};
  for (const [name, value] of parameters) (output[name] ??= []).push(embeddedJson(value));
  return output;
}

function parseRequest(exchange: CapturedExchange): {
  url: URL;
  query: Record<string, TemplateValue[]>;
  codec: "none" | "json" | "form";
  body: TemplateValue | Record<string, TemplateValue[]> | null;
} {
  const url = new URL(exchange.url);
  const codec = bodyCodec(exchange);
  let body: TemplateValue | Record<string, TemplateValue[]> | null = null;
  if (codec === "json") body = parseJson(exchange.requestBody) as TemplateValue;
  if (codec === "form") body = recordFromSearchParams(new URLSearchParams(exchange.requestBody));
  return { url, query: recordFromSearchParams(url.searchParams), codec, body };
}

function leafEntries(value: unknown, path: Path = []): Array<{ path: Path; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => leafEntries(item, [...path, index]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => leafEntries(child, [...path, key]));
  }
  return [{ path, value }];
}

function valueAt(value: unknown, path: Path): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function setAt(value: unknown, path: Path, replacement: TemplateValue): void {
  let current = value;
  for (const segment of path.slice(0, -1)) {
    if (!current || typeof current !== "object") throw new Error("Invalid request template path.");
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (!current || typeof current !== "object" || path.length === 0) throw new Error("Invalid request template path.");
  (current as Record<string | number, TemplateValue>)[path.at(-1)!] = replacement;
}

function pathKey(source: "query" | "body", path: Path): string {
  return `${source}:${JSON.stringify(path)}`;
}

function equivalent(source: "query" | "body", value: unknown, input: string | number | boolean): boolean {
  return source === "query" || typeof value === "string" ? String(value) === String(input) : value === input;
}

function looksHighEntropy(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(value) ||
    (value.length >= 48 && /^[A-Za-z0-9+/_=-]+$/.test(value) && new Set(value).size >= 12);
}

function assertSafeTemplate(value: unknown, path: Path = []): void {
  if (value && typeof value === "object" && "$clappingHandsInput" in value) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeTemplate(child, [...path, index]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_NAME.test(key)) throw new Error(`Refusing to persist sensitive request field ${key}.`);
      assertSafeTemplate(child, [...path, key]);
    }
    return;
  }
  if (typeof value === "string" && looksHighEntropy(value)) {
    const fieldName = [...path].reverse().find((segment): segment is string => typeof segment === "string");
    if (fieldName && PUBLIC_OPAQUE_CONSTANT_NAME.test(fieldName)) return;
    throw new Error(`Refusing to persist a high-entropy request constant at ${path.join(".")}.`);
  }
}

function requestSignature(exchange: CapturedExchange): string {
  const url = new URL(exchange.url);
  return `${exchange.method.toUpperCase()} ${url.origin}${url.pathname} ${bodyCodec(exchange)}`;
}

function candidateSignature(exchange: CapturedExchange): string | null {
  if (exchange.responseStatus < 200 || exchange.responseStatus >= 300) return null;
  try {
    parseJson(exchange.responseBody);
    return requestSignature(exchange);
  } catch {
    return null;
  }
}

function shapeWeight(shape: JsonShape): number {
  if (shape.type === "object") {
    return 1 + Object.values(shape.properties).reduce((total, child) => total + shapeWeight(child), 0);
  }
  if (shape.type === "array") return 1 + (shape.items ? shapeWeight(shape.items) : 0);
  if (shape.type === "union") return 1 + shape.anyOf.reduce((total, child) => total + shapeWeight(child), 0);
  return 1;
}

function normalizedEvidenceText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\\u[0-9a-f]{4}/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function responseScalars(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(responseScalars);
  if (value && typeof value === "object") return Object.values(value).flatMap(responseScalars);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  return [];
}

export function jsonResponseSupportsOutput(responseBody: string, outputText: string, input: NetworkInput): boolean {
  let parsed: unknown;
  try {
    parsed = parseJson(responseBody);
  } catch {
    return false;
  }
  const output = normalizedEvidenceText(outputText);
  const inputValues = new Set(Object.values(input).map((value) => normalizedEvidenceText(String(value))));
  return responseScalars(parsed).some((value) => {
    const candidate = normalizedEvidenceText(value);
    return candidate.length >= 3 && !inputValues.has(candidate) && output.includes(candidate);
  });
}

export function compileGenericJsonFromTraces(
  action: string,
  traces: GenericNetworkTrace[],
  options: { workflowOrigin?: string; allowedNetworkOrigins?: string[] } = {},
): { plan: GenericJsonPlan; demonstrations: GenericNetworkDemonstration[] } {
  if (traces.length < 2) throw new Error("Two network traces are required.");
  const indexed = traces.map((trace) => {
    const groups = new Map<string, CapturedExchange[]>();
    for (const exchange of trace.exchanges) {
      const signature = candidateSignature(exchange);
      if (!signature) continue;
      const values = groups.get(signature) ?? [];
      if (values.length < 8) values.push(exchange);
      groups.set(signature, values);
    }
    return groups;
  });
  const shared = [...indexed[0]!.keys()].filter((signature) => indexed.every((group) => group.has(signature)));
  const compiled: Array<{
    plan: GenericJsonPlan;
    demonstrations: GenericNetworkDemonstration[];
    score: number;
  }> = [];

  for (const signature of shared) {
    const choices = indexed.map((group) => group.get(signature)!);
    const combinations: CapturedExchange[][] = [];
    const build = (depth: number, current: CapturedExchange[]): void => {
      if (combinations.length >= 64) return;
      if (depth === choices.length) {
        combinations.push([...current]);
        return;
      }
      for (const exchange of choices[depth]!) {
        current.push(exchange);
        build(depth + 1, current);
        current.pop();
      }
    };
    build(0, []);
    for (const combination of combinations) {
      const demonstrations = combination.map((exchange, index) => ({ input: traces[index]!.input, exchange }));
      try {
        if (traces.some((trace, index) => trace.outputText !== undefined &&
          !jsonResponseSupportsOutput(combination[index]!.responseBody, trace.outputText, trace.input))) {
          continue;
        }
        const plan = compileGenericJsonPlan(action, demonstrations, options);
        compiled.push({
          plan,
          demonstrations,
          score: Object.values(plan.request.bindings).flat().length * 100 + shapeWeight(plan.response.shape),
        });
      } catch {
        // Most same-page traffic is analytics, configuration, or unrelated
        // hydration. Only operations that bind every varying action input and
        // satisfy the redaction contract are eligible.
      }
    }
  }
  const best = compiled.sort((left, right) => right.score - left.score)[0];
  if (!best) throw new Error("No captured JSON operation safely bound every demonstrated input.");
  return { plan: best.plan, demonstrations: best.demonstrations };
}

export function compileGenericJsonPlan(
  action: string,
  demonstrations: GenericNetworkDemonstration[],
  options: { workflowOrigin?: string; allowedNetworkOrigins?: string[] } = {},
): GenericJsonPlan {
  if (demonstrations.length < 2) throw new Error("Two distinct network demonstrations are required.");
  const signatures = new Set(demonstrations.map(({ exchange }) => requestSignature(exchange)));
  if (signatures.size !== 1) throw new Error("Network demonstrations do not describe the same operation.");
  const parsed = demonstrations.map(({ exchange }) => parseRequest(exchange));
  const first = parsed[0]!;
  const inputs = Object.keys(demonstrations[0]!.input).sort();
  if (demonstrations.some((demo) => JSON.stringify(Object.keys(demo.input).sort()) !== JSON.stringify(inputs))) {
    throw new Error("Network demonstrations must use the same input schema.");
  }
  const queryTemplate = structuredClone(first.query);
  const bodyTemplate = structuredClone(first.body);
  const bindings: GenericJsonPlan["request"]["bindings"] = {};
  const allBoundPaths = new Set<string>();

  for (const inputName of inputs) {
    const distinct = new Set(demonstrations.map((demo) => JSON.stringify(demo.input[inputName])));
    if (distinct.size < 2) throw new Error(`Input ${inputName} did not vary across demonstrations.`);
    const locations: Array<{ source: "query" | "body"; path: Path }> = [];
    for (const source of ["query", "body"] as const) {
      const templateRoot = source === "query" ? first.query : first.body;
      if (templateRoot === null) continue;
      for (const entry of leafEntries(templateRoot)) {
        if (demonstrations.every((demo, index) => {
          const root = source === "query" ? parsed[index]!.query : parsed[index]!.body;
          return equivalent(source, valueAt(root, entry.path), demo.input[inputName]!);
        })) locations.push({ source, path: entry.path });
      }
    }
    if (locations.length === 0) throw new Error(`Could not infer a request binding for input ${inputName}.`);
    bindings[inputName] = locations;
    for (const location of locations) {
      allBoundPaths.add(pathKey(location.source, location.path));
      setAt(location.source === "query" ? queryTemplate : bodyTemplate, location.path, { $clappingHandsInput: inputName });
    }
  }

  for (const source of ["query", "body"] as const) {
    const root = source === "query" ? first.query : first.body;
    if (root === null) continue;
    for (const entry of leafEntries(root)) {
      const values = parsed.map((request) => valueAt(source === "query" ? request.query : request.body, entry.path));
      if (new Set(values.map((value) => JSON.stringify(value))).size > 1 && !allBoundPaths.has(pathKey(source, entry.path))) {
        throw new Error(`Unbound dynamic request value at ${source}:${JSON.stringify(entry.path)}.`);
      }
    }
  }

  assertSafeTemplate(queryTemplate);
  if (bodyTemplate !== null) assertSafeTemplate(bodyTemplate);
  const responses = demonstrations.map(({ exchange }) => parseJson(exchange.responseBody));
  const endpointOrigin = first.url.origin;
  if (parsed.some((request) => request.url.origin !== endpointOrigin)) throw new Error("Network demonstrations crossed origins.");
  const origin = options.workflowOrigin ? new URL(options.workflowOrigin).origin : endpointOrigin;
  const allowedNetworkOrigins = new Set([origin, ...(options.allowedNetworkOrigins ?? []).map((value) => new URL(value).origin)]);
  if (!allowedNetworkOrigins.has(endpointOrigin)) {
    throw new Error(`Network endpoint origin was not explicitly allowed: ${endpointOrigin}`);
  }
  return {
    formatVersion: "clapping-hands.dev/v1alpha2",
    engine: "json-request-v1",
    action,
    version: 1,
    effect: "read",
    origin,
    status: "provisional",
    request: {
      method: demonstrations[0]!.exchange.method.toUpperCase() as GenericJsonPlan["request"]["method"],
      ...(endpointOrigin !== origin ? { endpointOrigin } : {}),
      endpointPath: first.url.pathname,
      headers: requestHeaders(demonstrations[0]!.exchange),
      queryTemplate,
      bodyCodec: first.codec,
      bodyTemplate,
      bindings,
    },
    response: { shape: inferJsonShape(responses), maximumBytes: 8 * 1024 * 1024 },
    evidence: {
      demonstrationInputHashes: demonstrations.map((demo) => hash(demo.input)),
      successfulShadowInputHashes: [],
      successfulShadowCount: 0,
      failedShadowCount: 0,
      lastValidatedAt: null,
    },
  };
}

function materialize(value: TemplateValue, input: NetworkInput): unknown {
  if (value && typeof value === "object" && "$clappingHandsInput" in value) {
    const name = (value as InputReference).$clappingHandsInput;
    if (!(name in input)) throw new Error(`Missing compiled input ${name}.`);
    return input[name];
  }
  if (Array.isArray(value)) return value.map((child) => materialize(child, input));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child, input)]));
  }
  return value;
}

function materializeParameters(template: Record<string, TemplateValue[]>, input: NetworkInput): URLSearchParams {
  const output = new URLSearchParams();
  for (const [name, values] of Object.entries(template)) {
    values.forEach((value) => {
      const rendered = materialize(value, input);
      output.append(name, rendered && typeof rendered === "object" ? JSON.stringify(rendered) : String(rendered));
    });
  }
  return output;
}

export async function replayGenericJsonPlan(
  context: BrowserContext,
  plan: GenericJsonPlan,
  input: NetworkInput,
): Promise<{ data: unknown; status: number; durationMs: number; requests: 1; navigations: 0 }> {
  const expectedInputs = Object.keys(plan.request.bindings).sort();
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedInputs)) {
    throw new Error(`Compiled input keys must be exactly: ${expectedInputs.join(", ")}.`);
  }
  const startedAt = performance.now();
  const url = new URL(plan.request.endpointPath, plan.request.endpointOrigin ?? plan.origin);
  url.search = materializeParameters(plan.request.queryTemplate, input).toString();
  let data: string | undefined;
  if (plan.request.bodyCodec === "json") data = JSON.stringify(materialize(plan.request.bodyTemplate as TemplateValue, input));
  if (plan.request.bodyCodec === "form") {
    data = materializeParameters(plan.request.bodyTemplate as Record<string, TemplateValue[]>, input).toString();
  }
  const response = await context.request.fetch(url.href, {
    method: plan.request.method,
    headers: plan.request.headers,
    data,
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: 30_000,
  });
  if (response.status() >= 300 && response.status() < 400) throw new Error("Compiled JSON request refused an unvalidated redirect.");
  if (!response.ok()) throw new Error(`Compiled JSON request returned HTTP ${response.status()}.`);
  const body = await response.body();
  if (body.byteLength > plan.response.maximumBytes) throw new Error("Compiled JSON response exceeded its size limit.");
  const parsed = parseJson(body.toString("utf8"));
  if (!matchesJsonShape(parsed, plan.response.shape)) throw new Error("Compiled JSON response failed its structural contract.");
  return { data: parsed, status: response.status(), durationMs: performance.now() - startedAt, requests: 1, navigations: 0 };
}

export function recordGenericJsonShadow(
  plan: GenericJsonPlan,
  input: NetworkInput,
  matches: boolean,
): GenericJsonPlan {
  const updated = structuredClone(plan);
  const inputHash = hash(input);
  if (matches) {
    updated.evidence.successfulShadowCount = (updated.evidence.successfulShadowCount ??
      updated.evidence.successfulShadowInputHashes.length) + 1;
    if (!updated.evidence.successfulShadowInputHashes.includes(inputHash)) {
      updated.evidence.successfulShadowInputHashes.push(inputHash);
    }
    updated.evidence.lastValidatedAt = new Date().toISOString();
    const enoughEvidence = Object.keys(updated.request.bindings).length === 0
      ? updated.evidence.successfulShadowCount >= 2
      : updated.evidence.successfulShadowInputHashes.length >= 2;
    if (enoughEvidence) updated.status = "stable";
  } else {
    updated.evidence.failedShadowCount += 1;
    updated.status = "degraded";
  }
  return updated;
}
