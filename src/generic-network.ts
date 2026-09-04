import { createHash } from "node:crypto";
import type { BrowserContext } from "playwright-core";
import type { CapturedExchange } from "./network-plan.js";

export type NetworkInput = Record<string, string | number | boolean>;
type Path = Array<string | number>;
type InputReference = { $clappingHandsInput: string };
type TemplateValue = null | string | number | boolean | InputReference | TemplateValue[] | { [key: string]: TemplateValue };

export type JsonShape =
  | { type: "null" | "string" | "number" | "boolean" }
  | { type: "array"; items: JsonShape | null; minimumItems?: 1 }
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
    method: "GET" | "POST";
    endpointOrigin?: string;
    endpointPath: string;
    headers: Record<string, string>;
    queryTemplate: Record<string, TemplateValue[]>;
    bodyCodec: "none" | "json" | "form";
    bodyTemplate: TemplateValue | Record<string, TemplateValue[]> | null;
    bindings: Record<string, Array<{ source: "query" | "body"; path: Path }>>;
    pagination?: {
      strategy: "cursor";
      requestSource: "query" | "body";
      requestPath: Path;
      responseCursorPath: Path;
      responseHasNextPath?: Path;
      maximumPages: number;
    } | {
      strategy: "increment";
      requestSource: "query" | "body";
      requestPath: Path;
      firstContinuationValue: number;
      increment: number;
      termination:
        | { type: "has-next"; responsePath: Path }
        | { type: "next-value"; responsePath: Path }
        | { type: "short-page"; responsePath: Path; pageSize: number };
      maximumPages: number;
    };
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
const READ_NETWORK_METHODS = new Set(["GET", "POST"]);
const PAGINATION_FIELD_NAME = /(?:after|cursor|continuation|next|page.?token)/i;
const HAS_NEXT_FIELD_NAME = /(?:has.?next|more)/i;
const NEXT_VALUE_FIELD_NAME = /(?:next|more)/i;
const INCREMENT_FIELD_NAME = /(?:^|[_-])(?:page|offset|start|skip)(?:$|[_-])/i;
const PAGE_ITEMS_FIELD_NAME = /(?:items|results|topics|posts|edges|records|entries)/i;

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
    const arrays = group as unknown[][];
    const items = arrays.flat();
    return {
      type: "array",
      items: items.length > 0 ? inferJsonShape(items) : null,
      ...(arrays.every((array) => array.length > 0) ? { minimumItems: 1 as const } : {}),
    };
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
    return Array.isArray(value) &&
      (!shape.minimumItems || value.length >= shape.minimumItems) &&
      (!shape.items || value.every((item) => matchesJsonShape(item, shape.items!)));
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

function setPaginationValue(
  value: unknown,
  path: Path,
  replacement: string | number,
  allowOmittedTopLevelQueryParameter: boolean,
): void {
  if (valueAt(value, path) !== undefined) {
    setAt(value, path, replacement);
    return;
  }
  if (allowOmittedTopLevelQueryParameter && value && typeof value === "object" && !Array.isArray(value) &&
    path.length === 2 && typeof path[0] === "string" && path[1] === 0 && !(path[0] in value)) {
    (value as Record<string, TemplateValue[]>)[path[0]] = [replacement];
    return;
  }
  throw new Error("Invalid pagination request template path.");
}

function pathKey(source: "query" | "body", path: Path): string {
  return `${source}:${JSON.stringify(path)}`;
}

function assertTemplatePath(path: unknown, label: string): asserts path is Path {
  if (!Array.isArray(path) || path.length === 0 || path.length > 30 || path.some((segment) =>
    typeof segment === "number"
      ? !Number.isSafeInteger(segment) || segment < 0 || segment > 10_000
      : typeof segment !== "string" || segment.length === 0 || segment.length > 128
  )) {
    throw new Error(`${label} is invalid.`);
  }
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

export function assertGenericJsonPlanSafety(plan: GenericJsonPlan): void {
  if (plan.formatVersion !== "clapping-hands.dev/v1alpha2" || plan.engine !== "json-request-v1" || plan.effect !== "read") {
    throw new Error("Invalid read-only JSON accelerator identity.");
  }
  if (!READ_NETWORK_METHODS.has(plan.request.method)) {
    throw new Error(`Read network acceleration supports GET and evidence-linked POST only; ${String(plan.request.method)} requires the effectful workflow path.`);
  }
  const workflow = new URL(plan.origin);
  if (!new Set(["http:", "https:"]).has(workflow.protocol) || workflow.origin !== plan.origin || workflow.pathname !== "/" || workflow.search || workflow.hash) {
    throw new Error("Compiled workflow origin must be a canonical HTTP(S) origin.");
  }
  const endpointOrigin = plan.request.endpointOrigin ?? plan.origin;
  const endpoint = new URL(endpointOrigin);
  if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.origin !== endpointOrigin || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Compiled network endpoint origin must be a canonical HTTP(S) origin.");
  }
  if (workflow.protocol === "https:" && endpoint.protocol !== "https:") {
    throw new Error("An HTTPS workflow cannot accelerate through a plaintext network endpoint.");
  }
  const resolved = new URL(plan.request.endpointPath, endpointOrigin);
  if (!plan.request.endpointPath.startsWith("/") || resolved.origin !== endpointOrigin ||
    plan.request.endpointPath !== resolved.pathname || resolved.search || resolved.hash) {
    throw new Error("Compiled network endpoint path must be a same-origin absolute path without query or fragment data.");
  }
  for (const [name, value] of Object.entries(plan.request.headers)) {
    if (name !== name.toLowerCase() || !SAFE_HEADERS.has(name) || typeof value !== "string") {
      throw new Error(`Compiled network plan contains a forbidden request header: ${name}.`);
    }
  }
  if (!new Set(["none", "json", "form"]).has(plan.request.bodyCodec)) {
    throw new Error("Compiled network plan has an unsupported request body codec.");
  }
  if (plan.request.bodyCodec === "none" && plan.request.bodyTemplate !== null) {
    throw new Error("A body-less compiled request cannot contain a body template.");
  }
  if (plan.request.bodyCodec !== "none" && plan.request.bodyTemplate === null) {
    throw new Error("A compiled request body codec requires a body template.");
  }
  if (plan.request.pagination !== undefined) {
    const pagination = plan.request.pagination;
    if (!new Set(["cursor", "increment"]).has(pagination.strategy) ||
      !new Set(["query", "body"]).has(pagination.requestSource)) {
      throw new Error("Compiled network pagination strategy is invalid.");
    }
    assertTemplatePath(pagination.requestPath, "Compiled pagination request path");
    if (Object.values(plan.request.bindings).flat().some((binding) =>
      binding.source === pagination.requestSource &&
      JSON.stringify(binding.path) === JSON.stringify(pagination.requestPath)
    )) {
      throw new Error("Compiled pagination cannot overwrite a user input binding.");
    }
    if (pagination.strategy === "cursor") {
      if (!PAGINATION_FIELD_NAME.test(lastNamedSegment(pagination.requestPath))) {
        throw new Error("Compiled cursor request path is not pagination-shaped.");
      }
      assertTemplatePath(pagination.responseCursorPath, "Compiled pagination response-cursor path");
      if (pagination.responseHasNextPath !== undefined) {
        assertTemplatePath(pagination.responseHasNextPath, "Compiled pagination has-next path");
      }
    } else {
      if (!INCREMENT_FIELD_NAME.test(lastNamedSegment(pagination.requestPath))) {
        throw new Error("Compiled increment request path is not pagination-shaped.");
      }
      if (!Number.isSafeInteger(pagination.firstContinuationValue) ||
        !Number.isSafeInteger(pagination.increment) || pagination.increment < 1 || pagination.increment > 1_000_000) {
        throw new Error("Compiled increment pagination values are invalid.");
      }
      assertTemplatePath(pagination.termination.responsePath, "Compiled pagination termination path");
      if (!new Set(["has-next", "next-value", "short-page"]).has(pagination.termination.type)) {
        throw new Error("Compiled pagination termination strategy is invalid.");
      }
      if (pagination.termination.type === "short-page" &&
        (!Number.isSafeInteger(pagination.termination.pageSize) || pagination.termination.pageSize < 1 ||
          pagination.termination.pageSize > 100_000)) {
        throw new Error("Compiled pagination page size is invalid.");
      }
    }
    if (!Number.isSafeInteger(pagination.maximumPages) ||
      pagination.maximumPages < 2 || pagination.maximumPages > 40) {
      throw new Error("Compiled pagination page limit is invalid.");
    }
    const requestRoot = pagination.requestSource === "query"
      ? plan.request.queryTemplate
      : plan.request.bodyTemplate;
    const omittedTopLevelQueryParameter = pagination.strategy === "increment" &&
      pagination.requestSource === "query" && pagination.requestPath.length === 2 &&
      typeof pagination.requestPath[0] === "string" && pagination.requestPath[1] === 0 &&
      requestRoot !== null && valueAt(requestRoot, pagination.requestPath) === undefined;
    if (requestRoot === null ||
      (valueAt(requestRoot, pagination.requestPath) === undefined && !omittedTopLevelQueryParameter)) {
      throw new Error("Compiled pagination request path does not exist in its request template.");
    }
  }
  assertSafeTemplate(plan.request.queryTemplate);
  if (plan.request.bodyTemplate !== null) assertSafeTemplate(plan.request.bodyTemplate);
  if (!Number.isSafeInteger(plan.response.maximumBytes) || plan.response.maximumBytes < 1 || plan.response.maximumBytes > 8 * 1024 * 1024) {
    throw new Error("Compiled network response limit is invalid.");
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

type ParsedPaginationExchange = {
  request: ReturnType<typeof parseRequest>;
  response: unknown;
};

type PaginationPlan = NonNullable<GenericJsonPlan["request"]["pagination"]>;
type CursorPaginationPlan = Extract<PaginationPlan, { strategy: "cursor" }>;
type IncrementPaginationPlan = Extract<PaginationPlan, { strategy: "increment" }>;

type CursorPaginationInference = {
  pagination: CursorPaginationPlan;
  responseShape: JsonShape;
  demonstratedPages: number;
};

type IncrementPaginationInference = {
  pagination: IncrementPaginationPlan;
  responseShape: JsonShape;
  demonstratedPages: number;
};

function lastNamedSegment(path: Path): string {
  return [...path].reverse().find((segment): segment is string => typeof segment === "string") ?? "";
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if ((typeof left === "string" || typeof left === "number") &&
    (typeof right === "string" || typeof right === "number")) {
    return String(left) === String(right);
  }
  return false;
}

function paginationSequence(
  trace: GenericNetworkTrace,
  selected: CapturedExchange,
): ParsedPaginationExchange[] {
  const selectedIndex = trace.exchanges.indexOf(selected);
  if (selectedIndex < 0) return [];
  const signature = requestSignature(selected);
  const sequence: ParsedPaginationExchange[] = [];
  for (const exchange of trace.exchanges.slice(selectedIndex)) {
    let exchangeSignature: string | null;
    try {
      exchangeSignature = candidateSignature(exchange);
    } catch {
      continue;
    }
    if (exchangeSignature !== signature) continue;
    try {
      sequence.push({ request: parseRequest(exchange), response: parseJson(exchange.responseBody) });
    } catch {
      return [];
    }
    if (sequence.length > 40) return [];
  }
  return sequence;
}

function requestRoot(
  request: ReturnType<typeof parseRequest>,
  source: "query" | "body",
): unknown {
  return source === "query" ? request.query : request.body;
}

function sequencePreservesInputs(
  plan: GenericJsonPlan,
  sequence: ParsedPaginationExchange[],
  input: NetworkInput,
): boolean {
  return Object.entries(plan.request.bindings).every(([inputName, bindings]) => bindings.every((binding) =>
    sequence.every((page) => equivalent(
      binding.source,
      valueAt(requestRoot(page.request, binding.source), binding.path),
      input[inputName]!,
    )),
  ));
}

function inferCursorPagination(
  plan: GenericJsonPlan,
  traces: GenericNetworkTrace[],
  demonstrations: GenericNetworkDemonstration[],
): CursorPaginationInference | null {
  const sequences = traces.map((trace, index) => paginationSequence(trace, demonstrations[index]!.exchange));
  if (sequences.some((sequence) => sequence.length < 2) ||
    sequences.some((sequence, index) => !sequencePreservesInputs(plan, sequence, traces[index]!.input))) {
    return null;
  }
  const boundPaths = new Set(Object.values(plan.request.bindings).flat()
    .map((binding) => pathKey(binding.source, binding.path)));
  const requestCandidates: Array<{ source: "query" | "body"; path: Path }> = [];
  for (const source of ["query", "body"] as const) {
    const root = requestRoot(sequences[0]![0]!.request, source);
    if (root === null) continue;
    for (const entry of leafEntries(root)) {
      if (!PAGINATION_FIELD_NAME.test(lastNamedSegment(entry.path)) ||
        boundPaths.has(pathKey(source, entry.path))) continue;
      const initialValues = sequences.map((sequence) =>
        valueAt(requestRoot(sequence[0]!.request, source), entry.path));
      if (!initialValues.every((value) => value === null || value === "") ||
        new Set(initialValues.map((value) => JSON.stringify(value))).size !== 1) continue;
      const everyTransitionChanges = sequences.every((sequence) => sequence.slice(0, -1).every((page, index) => {
        const current = valueAt(requestRoot(page.request, source), entry.path);
        const next = valueAt(requestRoot(sequence[index + 1]!.request, source), entry.path);
        return next !== undefined && !sameScalar(current, next);
      }));
      if (everyTransitionChanges) requestCandidates.push({ source, path: entry.path });
    }
  }

  const rankedRequestCandidates = requestCandidates.sort((left, right) =>
    left.path.length - right.path.length || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const requestCandidate of rankedRequestCandidates) {
    const firstNextToken = valueAt(
      requestRoot(sequences[0]![1]!.request, requestCandidate.source),
      requestCandidate.path,
    );
    const cursorPaths = leafEntries(sequences[0]![0]!.response)
      .filter((entry) => PAGINATION_FIELD_NAME.test(lastNamedSegment(entry.path)) &&
        sameScalar(entry.value, firstNextToken))
      .map((entry) => entry.path)
      .sort((left, right) => left.length - right.length || JSON.stringify(left).localeCompare(JSON.stringify(right)));
    for (const responseCursorPath of cursorPaths) {
      const cursorMatchesEveryTransition = sequences.every((sequence) =>
        sequence.slice(0, -1).every((page, index) => sameScalar(
          valueAt(page.response, responseCursorPath),
          valueAt(requestRoot(sequence[index + 1]!.request, requestCandidate.source), requestCandidate.path),
        )));
      if (!cursorMatchesEveryTransition) continue;

      const hasNextCandidates = leafEntries(sequences[0]![0]!.response)
        .filter((entry) => entry.value === true && HAS_NEXT_FIELD_NAME.test(lastNamedSegment(entry.path)))
        .map((entry) => entry.path)
        .sort((left, right) => left.length - right.length || JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const responseHasNextPath = hasNextCandidates.find((path) => sequences.every((sequence) =>
        sequence.slice(0, -1).every((page) => valueAt(page.response, path) === true) &&
        valueAt(sequence.at(-1)!.response, path) === false
      ));
      const terminalCursorValues = sequences.map((sequence) => valueAt(sequence.at(-1)!.response, responseCursorPath));
      const terminalCursor = terminalCursorValues.every((value) => value === null || value === "");
      if (!responseHasNextPath && !terminalCursor) continue;

      const responses = sequences.flatMap((sequence) => sequence.map((page) => page.response));
      return {
        pagination: {
          strategy: "cursor",
          requestSource: requestCandidate.source,
          requestPath: requestCandidate.path,
          responseCursorPath,
          ...(responseHasNextPath ? { responseHasNextPath } : {}),
          maximumPages: 40,
        },
        responseShape: inferJsonShape(responses),
        demonstratedPages: responses.length,
      };
    }
  }
  return null;
}

function finiteInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function terminalNextValue(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === "";
}

function continuingNextValue(value: unknown): boolean {
  return value === true || typeof value === "number" || (typeof value === "string" && value.length > 0);
}

function inferIncrementPagination(
  plan: GenericJsonPlan,
  traces: GenericNetworkTrace[],
  demonstrations: GenericNetworkDemonstration[],
): IncrementPaginationInference | null {
  const sequences = traces.map((trace, index) => paginationSequence(trace, demonstrations[index]!.exchange));
  if (sequences.some((sequence) => sequence.length < 3) ||
    sequences.some((sequence, index) => !sequencePreservesInputs(plan, sequence, traces[index]!.input))) {
    return null;
  }
  const boundPaths = new Set(Object.values(plan.request.bindings).flat()
    .map((binding) => pathKey(binding.source, binding.path)));
  const requestCandidates: Array<{ source: "query" | "body"; path: Path }> = [];
  for (const source of ["query", "body"] as const) {
    const uniquePaths = new Map<string, Path>();
    for (const page of sequences[0]!.slice(1)) {
      const root = requestRoot(page.request, source);
      if (root === null) continue;
      for (const entry of leafEntries(root)) uniquePaths.set(JSON.stringify(entry.path), entry.path);
    }
    for (const path of uniquePaths.values()) {
      if (!INCREMENT_FIELD_NAME.test(lastNamedSegment(path)) || boundPaths.has(pathKey(source, path))) continue;
      const continuationValues = sequences.map((sequence) => sequence.slice(1)
        .map((page) => finiteInteger(valueAt(requestRoot(page.request, source), path))));
      if (continuationValues.some((values) => values.some((value) => value === null))) continue;
      const firstContinuationValues = continuationValues.map((values) => values[0]! as number);
      if (new Set(firstContinuationValues).size !== 1) continue;
      const increments = continuationValues.flatMap((values) => values.slice(1)
        .map((value, index) => (value as number) - (values[index] as number)));
      if (increments.length === 0 || new Set(increments).size !== 1 || increments[0]! < 1 || increments[0]! > 1_000_000) continue;
      const firstValues = sequences.map((sequence) =>
        finiteInteger(valueAt(requestRoot(sequence[0]!.request, source), path)));
      const allOmitted = firstValues.every((value) => value === null);
      const expectedFirst = firstContinuationValues[0]! - increments[0]!;
      if (!allOmitted && !firstValues.every((value) => value === expectedFirst)) continue;
      requestCandidates.push({ source, path });
    }
  }

  const rankedRequestCandidates = requestCandidates.sort((left, right) =>
    left.path.length - right.path.length || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const requestCandidate of rankedRequestCandidates) {
    const firstContinuationValue = finiteInteger(valueAt(
      requestRoot(sequences[0]![1]!.request, requestCandidate.source),
      requestCandidate.path,
    ));
    const secondContinuationValue = finiteInteger(valueAt(
      requestRoot(sequences[0]![2]!.request, requestCandidate.source),
      requestCandidate.path,
    ));
    if (firstContinuationValue === null || secondContinuationValue === null) continue;
    const increment = secondContinuationValue - firstContinuationValue;

    const firstResponseEntries = leafEntries(sequences[0]![0]!.response);
    const hasNextPath = firstResponseEntries
      .filter((entry) => entry.value === true && HAS_NEXT_FIELD_NAME.test(lastNamedSegment(entry.path)))
      .map((entry) => entry.path)
      .sort((left, right) => left.length - right.length || JSON.stringify(left).localeCompare(JSON.stringify(right)))
      .find((path) => sequences.every((sequence) =>
        sequence.slice(0, -1).every((page) => valueAt(page.response, path) === true) &&
        valueAt(sequence.at(-1)!.response, path) === false));

    const nextValuePath = firstResponseEntries
      .filter((entry) => NEXT_VALUE_FIELD_NAME.test(lastNamedSegment(entry.path)) && continuingNextValue(entry.value))
      .map((entry) => entry.path)
      .sort((left, right) => left.length - right.length || JSON.stringify(left).localeCompare(JSON.stringify(right)))
      .find((path) => sequences.every((sequence) =>
        sequence.slice(0, -1).every((page) => continuingNextValue(valueAt(page.response, path))) &&
        terminalNextValue(valueAt(sequence.at(-1)!.response, path))));

    const shortPage = firstResponseEntries
      .filter((entry) => Array.isArray(entry.value) && entry.value.length > 0 &&
        PAGE_ITEMS_FIELD_NAME.test(lastNamedSegment(entry.path)))
      .map((entry) => ({ path: entry.path, pageSize: (entry.value as unknown[]).length }))
      .sort((left, right) => right.pageSize - left.pageSize || left.path.length - right.path.length ||
        JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)))
      .find((candidate) => sequences.every((sequence) => {
        const pageValues = sequence.map((page) => valueAt(page.response, candidate.path));
        return pageValues.every(Array.isArray) &&
          pageValues.slice(0, -1).every((value) => value.length === candidate.pageSize) &&
          pageValues.at(-1)!.length < candidate.pageSize;
      }));

    const termination: IncrementPaginationPlan["termination"] | null = hasNextPath
      ? { type: "has-next", responsePath: hasNextPath }
      : nextValuePath
        ? { type: "next-value", responsePath: nextValuePath }
        : shortPage
          ? { type: "short-page", responsePath: shortPage.path, pageSize: shortPage.pageSize }
          : null;
    if (!termination) continue;
    const responses = sequences.flatMap((sequence) => sequence.map((page) => page.response));
    return {
      pagination: {
        strategy: "increment",
        requestSource: requestCandidate.source,
        requestPath: requestCandidate.path,
        firstContinuationValue,
        increment,
        termination,
        maximumPages: 40,
      },
      responseShape: inferJsonShape(responses),
      demonstratedPages: responses.length,
    };
  }
  return null;
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
        const cursorPagination = inferCursorPagination(plan, traces, demonstrations);
        const incrementPagination = cursorPagination ? null : inferIncrementPagination(plan, traces, demonstrations);
        const pagination = cursorPagination ?? incrementPagination;
        if (pagination) {
          plan.request.pagination = pagination.pagination;
          plan.response.shape = pagination.responseShape;
          assertGenericJsonPlanSafety(plan);
        }
        compiled.push({
          plan,
          demonstrations,
          score: Object.values(plan.request.bindings).flat().length * 100 +
            shapeWeight(plan.response.shape) + (pagination ? 1_000 + pagination.demonstratedPages : 0),
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
  const method = demonstrations[0]!.exchange.method.toUpperCase();
  if (!READ_NETWORK_METHODS.has(method)) {
    throw new Error(`Read network acceleration supports GET and evidence-linked POST only; ${method} requires the effectful workflow path.`);
  }
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
  if (new URL(origin).protocol === "https:" && new URL(endpointOrigin).protocol !== "https:") {
    throw new Error("An HTTPS workflow cannot accelerate through a plaintext network endpoint.");
  }
  if (!allowedNetworkOrigins.has(endpointOrigin)) {
    throw new Error(`Network endpoint origin was not explicitly allowed: ${endpointOrigin}`);
  }
  const plan: GenericJsonPlan = {
    formatVersion: "clapping-hands.dev/v1alpha2",
    engine: "json-request-v1",
    action,
    version: 1,
    effect: "read",
    origin,
    status: "provisional",
    request: {
      method: method as GenericJsonPlan["request"]["method"],
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
  assertGenericJsonPlanSafety(plan);
  return plan;
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
): Promise<{ data: unknown; status: number; durationMs: number; requests: number; navigations: 0; complete: true }> {
  assertGenericJsonPlanSafety(plan);
  const expectedInputs = Object.keys(plan.request.bindings).sort();
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedInputs)) {
    throw new Error(`Compiled input keys must be exactly: ${expectedInputs.join(", ")}.`);
  }
  const startedAt = performance.now();
  const pagination = plan.request.pagination;
  const maximumPages = pagination?.maximumPages ?? 1;
  const pages: unknown[] = [];
  const seenCursors = new Set<string>();
  let nextCursor: string | number | undefined;
  let totalBytes = 0;
  let status = 0;

  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    const queryTemplate = structuredClone(plan.request.queryTemplate);
    const bodyTemplate = structuredClone(plan.request.bodyTemplate);
    if (pagination && pageIndex > 0) {
      const target = pagination.requestSource === "query" ? queryTemplate : bodyTemplate;
      if (target === null) throw new Error("Compiled pagination lost its request template before replay.");
      let requestPaginationValue: string | number;
      if (pagination.strategy === "cursor") {
        if (nextCursor === undefined) throw new Error("Compiled pagination lost its next cursor before replay.");
        requestPaginationValue = nextCursor;
      } else {
        requestPaginationValue = pagination.firstContinuationValue + ((pageIndex - 1) * pagination.increment);
        if (!Number.isSafeInteger(requestPaginationValue)) {
          throw new Error("Compiled increment pagination exceeded the safe integer range.");
        }
      }
      setPaginationValue(
        target,
        pagination.requestPath,
        requestPaginationValue,
        pagination.strategy === "increment" && pagination.requestSource === "query",
      );
    }

    const url = new URL(plan.request.endpointPath, plan.request.endpointOrigin ?? plan.origin);
    url.search = materializeParameters(queryTemplate, input).toString();
    let requestData: string | undefined;
    if (plan.request.bodyCodec === "json") {
      requestData = JSON.stringify(materialize(bodyTemplate as TemplateValue, input));
    }
    if (plan.request.bodyCodec === "form") {
      requestData = materializeParameters(bodyTemplate as Record<string, TemplateValue[]>, input).toString();
    }
    const response = await context.request.fetch(url.href, {
      method: plan.request.method,
      headers: plan.request.headers,
      data: requestData,
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: 30_000,
    });
    status = response.status();
    if (status >= 300 && status < 400) throw new Error("Compiled JSON request refused an unvalidated redirect.");
    if (!response.ok()) throw new Error(`Compiled JSON request returned HTTP ${status}.`);
    const contentType = response.headers()["content-type"] ?? "";
    if (!/(?:json|graphql|javascript)/i.test(contentType)) {
      throw new Error(`Compiled JSON response returned an unexpected content type: ${contentType || "missing"}.`);
    }
    const responseBody = await response.body();
    totalBytes += responseBody.byteLength;
    if (totalBytes > plan.response.maximumBytes) {
      throw new Error("Compiled JSON pagination exceeded its aggregate response size limit.");
    }
    const parsed = parseJson(responseBody.toString("utf8"));
    if (!matchesJsonShape(parsed, plan.response.shape)) {
      throw new Error("Compiled JSON response failed its structural contract.");
    }
    pages.push(parsed);
    if (!pagination) break;

    if (pagination.strategy === "increment") {
      const terminationValue = valueAt(parsed, pagination.termination.responsePath);
      let terminal = false;
      if (pagination.termination.type === "has-next") {
        if (typeof terminationValue !== "boolean") {
          throw new Error("Compiled pagination returned an invalid has-next value.");
        }
        terminal = !terminationValue;
      } else if (pagination.termination.type === "next-value") {
        if (!terminalNextValue(terminationValue) && !continuingNextValue(terminationValue)) {
          throw new Error("Compiled pagination returned an invalid next-page value.");
        }
        terminal = terminalNextValue(terminationValue);
      } else {
        if (!Array.isArray(terminationValue)) {
          throw new Error("Compiled pagination returned an invalid page-items value.");
        }
        if (terminationValue.length > pagination.termination.pageSize) {
          throw new Error("Compiled pagination exceeded its demonstrated page size.");
        }
        terminal = terminationValue.length < pagination.termination.pageSize;
      }
      if (terminal) {
        return {
          data: pages,
          status,
          durationMs: performance.now() - startedAt,
          requests: pages.length,
          navigations: 0,
          complete: true,
        };
      }
      continue;
    }

    const hasNext = pagination.responseHasNextPath === undefined
      ? undefined
      : valueAt(parsed, pagination.responseHasNextPath);
    if (hasNext !== undefined && typeof hasNext !== "boolean") {
      throw new Error("Compiled pagination returned an invalid has-next value.");
    }
    const cursor = valueAt(parsed, pagination.responseCursorPath);
    if (hasNext === false || cursor === null || cursor === "") {
      return {
        data: pages,
        status,
        durationMs: performance.now() - startedAt,
        requests: pages.length,
        navigations: 0,
        complete: true,
      };
    }
    if (typeof cursor !== "string" && typeof cursor !== "number") {
      throw new Error("Compiled pagination returned a missing or invalid next cursor.");
    }
    const cursorKey = JSON.stringify(cursor);
    if (seenCursors.has(cursorKey)) throw new Error("Compiled pagination returned a repeated cursor.");
    seenCursors.add(cursorKey);
    nextCursor = cursor;
  }

  if (pagination) throw new Error("Compiled pagination reached its page limit before a terminal response.");
  return {
    data: pages[0],
    status,
    durationMs: performance.now() - startedAt,
    requests: 1,
    navigations: 0,
    complete: true,
  };
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
