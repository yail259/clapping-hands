import { createHash } from "node:crypto";
import { observedPathBindings, pathSignature, materializeRequestPath } from './request-path.js';
import { WorkflowAccessError } from "./workflow-auth.js";
import { isDeepStrictEqual } from "node:util";
import { requestContractError } from "./request-contract-diagnostic.js";
import { RequestContextVault, requestOperationFingerprint, type RequestContextTicket, type RuntimeFieldValue } from "./request-context.js";
import type { BrowserContext, Page } from "playwright-core";
import { browserNetworkFetch, type BrowserNetworkDocument } from "./browser-network-transport.js";
import type { CapturedExchange } from "./captured-exchange.js";
import { capturedSessionHeaders, isSessionHeaderName } from "./ephemeral-request-headers.js";
import { decodeJsonResponse, inferJsonResponse, decodeRelativeUrl, encodeRelativeUrl, type JsonResponseCodec } from "./network-codecs.js";
import { assertHtmlValueResponseRecipe, HtmlResponseError, type HtmlValueResponseRecipe } from "./html-response.js";
import { decodeGenericCapturedResponse, decodeGenericResponseBytes, inferCapturedNetworkResponse } from "./network-response.js";
import type { OutputRecipe } from "./learned-output.js";

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
    pathBindings?: Record<string, number[]>;
    headers: Record<string, string>;
    queryTemplate: Record<string, TemplateValue[]>;
    bodyCodec: "none" | "json" | "form";
    bodyTemplate: TemplateValue | Record<string, TemplateValue[]> | null;
    bodyUrlFields?: Array<{ name: string; index: number }>;
    runtimeFields?: Array<RequestFieldPath & { type: "string" | "number" | "boolean" }>;
    runtimeHeaders?: string[];
    transport?: "browser-fetch";
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
        | { type: "short-page"; responsePath: Path; pageSize: number }
        | { type: "total-pages-header"; header: string };
      maximumPages: number;
    } | {
      strategy: "next-url";
      responseNextUrlPath?: Path;
      responseLinkHeader?: "link";
      mutableQueryPaths: Path[];
      maximumPages: number;
    };
  };
  response: {
    codec?: JsonResponseCodec | "html-input-values" | "html-document";
    documentEncoding?: 'utf-8' | 'windows-1252';
    htmlRecipe?: HtmlValueResponseRecipe;
    records?: number;
    shape: JsonShape;
    maximumBytes: number;
  };
  evidence: {
    inputHashVersion?: "sorted-flat-v1";
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
  outputRows?: Record<string, string>[];
};

export type GenericNetworkTrace = {
  input: NetworkInput;
  exchanges: CapturedExchange[];
  outputText?: string;
  outputRows?: Record<string, string>[];
};

type RequestFieldPath = { source: "query" | "body"; path: Path };
export class RequestContextRequiredError extends Error {
  constructor(readonly dynamicFields: RequestFieldPath[], readonly sensitiveFields: RequestFieldPath[]) {
    const first = dynamicFields[0]!;
    super(`Unbound dynamic request value at ${first.source}:${JSON.stringify(first.path)}.`);
    this.name = "RequestContextRequiredError";
  }
}

const SENSITIVE_NAME = /(?:authorization|cookie|password|passwd|secret|token|csrf|xsrf|session|api[_-]?key|jazoest|dtsg|\blsd\b)/i;
const PUBLIC_OPAQUE_CONSTANT_NAME = /^(?:sha256hash|sha256_hash)$/i;
const SAFE_HEADERS = new Set(["accept", "content-type", "x-requested-with"]);
const READ_NETWORK_METHODS = new Set(["GET", "POST"]);
const PAGINATION_FIELD_NAME = /(?:after|cursor|continuation|next|page.?token)/i;
const HAS_NEXT_FIELD_NAME = /(?:has.?next|more)/i;
const NEXT_VALUE_FIELD_NAME = /(?:next|more)/i;
const INCREMENT_FIELD_NAME = /^(?:page(?:[_-]?(?:number|index|no))?|offset|start(?:[_-]?(?:at|index))?|skip(?:[_-]?count)?|from)$/i;
const PAGE_ITEMS_FIELD_NAME = /(?:items|results|topics|posts|edges|records|entries)/i;
const TOTAL_PAGES_HEADER_NAME = /^(?:x-wp-totalpages|x-total-pages|x-pagination-pages)$/;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inputEvidenceHash(input: NetworkInput): string {
  return hash(Object.fromEntries(Object.keys(input).sort().map((key) => [key, input[key]])));
}

function assertGenericJsonEvidence(evidence: GenericJsonPlan["evidence"]): void {
  const hashes = (value: unknown): value is string[] => Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry));
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
    evidence.inputHashVersion !== undefined && evidence.inputHashVersion !== "sorted-flat-v1" ||
    !hashes(evidence.demonstrationInputHashes) || !hashes(evidence.successfulShadowInputHashes) ||
    !count(evidence.failedShadowCount) || evidence.successfulShadowCount !== undefined &&
      (!count(evidence.successfulShadowCount) || evidence.successfulShadowCount < evidence.successfulShadowInputHashes.length) ||
    evidence.lastValidatedAt !== null && (typeof evidence.lastValidatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidence.lastValidatedAt) ||
      !Number.isFinite(Date.parse(evidence.lastValidatedAt)))) {
    throw new Error("Invalid compiled network promotion evidence.");
  }
}

function hasHeldOutGenericJsonEvidence(plan: GenericJsonPlan): boolean {
  const evidence = plan.evidence;
  // Old insertion-order hashes cannot establish whether differently ordered
  // objects represented the same input. Keep that history, but require relearning.
  if (evidence.inputHashVersion !== "sorted-flat-v1" || evidence.failedShadowCount !== 0 ||
    evidence.lastValidatedAt === null) return false;
  const demonstrations = new Set(evidence.demonstrationInputHashes);
  const heldOut = new Set(evidence.successfulShadowInputHashes.filter((value) => !demonstrations.has(value)));
  return demonstrations.size >= 2 && heldOut.size >= 2;
}

/** Stable is evidence-backed, not merely a persisted status label. */
export function isStableGenericJsonPlan(plan: GenericJsonPlan): boolean {
  try { assertGenericJsonPlanSafety(plan); } catch { return false; }
  return plan.status === "stable" && hasHeldOutGenericJsonEvidence(plan);
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
  return inferJsonResponse(body).value;
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
  // Some browser search APIs send JSON as a CORS-safelisted text body. Preserve
  // the observed content type; admit only strict structured JSON, never script.
  if (/^text\/plain(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(contentType) && Buffer.byteLength(exchange.requestBody)<=1_000_000) {
    const value=JSON.parse(exchange.requestBody);
    if(value && typeof value==='object')return 'json';
  }
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
  bodyUrlFields: Array<{ name: string; index: number }>;
} {
  const url = new URL(exchange.url);
  const codec = bodyCodec(exchange);
  let body: TemplateValue | Record<string, TemplateValue[]> | null = null;
  const bodyUrlFields: Array<{ name: string; index: number }> = [];
  if (codec === "json") body = decodeJsonResponse(exchange.requestBody, "json") as TemplateValue;
  if (codec === "form") body = recordFromSearchParams(new URLSearchParams(exchange.requestBody));
  if (codec === "form" && body) for (const [name, values] of Object.entries(body as Record<string, TemplateValue[]>)) {
    values.forEach((value, index) => {
      if (typeof value !== "string") return;
      const parsed = decodeRelativeUrl(value);
      if (parsed) { values[index] = parsed; bodyUrlFields.push({ name, index }); }
    });
  }
  return { url, query: recordFromSearchParams(url.searchParams), codec, body, bodyUrlFields };
}

function leafEntries(value: unknown, path: Path = []): Array<{ path: Path; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => leafEntries(item, [...path, index]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => leafEntries(child, [...path, key]));
  }
  return [{ path, value }];
}

function nestedEntries(value: unknown, path: Path = []): Array<{ path: Path; value: unknown }> {
  const current = [{ path, value }];
  if (Array.isArray(value)) {
    return current.concat(value.flatMap((item, index) => nestedEntries(item, [...path, index])));
  }
  if (value && typeof value === "object") {
    return current.concat(Object.entries(value).flatMap(([key, child]) => nestedEntries(child, [...path, key])));
  }
  return current;
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
  try {
    setAt(value, path, replacement);
    return;
  } catch {
    // A missing leaf can be added when its parent was demonstrated. A wholly
    // omitted top-level query parameter needs the explicit array wrapper below.
  }
  if (allowOmittedTopLevelQueryParameter && value && typeof value === "object" && !Array.isArray(value) &&
    path.length === 2 && typeof path[0] === "string" && path[1] === 0 && !(path[0] in value)) {
    (value as Record<string, TemplateValue[]>)[path[0]] = [replacement];
    return;
  }
  throw new Error("Invalid pagination request template path.");
}

function canSetPaginationValue(value: unknown, path: Path): boolean {
  try {
    setAt(structuredClone(value), path, 0);
    return true;
  } catch {
    return false;
  }
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

function assertSafeTemplate(value: unknown, path: Path = [], contextPaths: Set<string> = new Set()): void {
  if (value && typeof value === "object" && "$clappingHandsInput" in value) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeTemplate(child, [...path, index], contextPaths));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_NAME.test(key) && !leafEntries(child, [...path, key]).every((entry) =>
        entry.value === null && contextPaths.has(JSON.stringify(entry.path)))) throw new Error(`Refusing to persist sensitive request field ${key}.`);
      assertSafeTemplate(child, [...path, key], contextPaths);
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
  if (!["candidate", "provisional", "stable", "degraded"].includes(plan.status)) throw new Error("Invalid compiled network status.");
  assertGenericJsonEvidence(plan.evidence);
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
  if(plan.request.pathBindings!==undefined){
    const paths=plan.request.pathBindings,used=new Set<number>();
    if(!paths || Array.isArray(paths) || typeof paths!=='object' || !Object.keys(paths).length ||
      plan.request.method!=='GET' || plan.request.bodyCodec!=='none' || plan.request.pagination || plan.request.transport ||
      plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length)throw new Error('Unsupported path-input request.');
    for(const [name,indices] of Object.entries(paths)){
      if(!Object.hasOwn(plan.request.bindings,name) || !Array.isArray(indices) || !indices.length || indices.length>32)throw new Error('Invalid path binding.');
      for(const index of indices){
        if(!Number.isSafeInteger(index) || index<2 || index>=plan.request.endpointPath.split('/').length || used.has(index))throw new Error('Invalid path binding location.');
        used.add(index);
      }
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
    if (!new Set(["cursor", "increment", "next-url"]).has(pagination.strategy)) {
      throw new Error("Compiled network pagination strategy is invalid.");
    }
    if (pagination.strategy === "next-url") {
      const sourceCount = Number(pagination.responseNextUrlPath !== undefined) +
        Number(pagination.responseLinkHeader !== undefined);
      if (sourceCount !== 1) throw new Error("Compiled pagination must declare exactly one next-URL source.");
      if (pagination.responseNextUrlPath !== undefined) {
        assertTemplatePath(pagination.responseNextUrlPath, "Compiled pagination next-URL path");
        if (!NEXT_VALUE_FIELD_NAME.test(lastNamedSegment(pagination.responseNextUrlPath))) {
          throw new Error("Compiled pagination next-URL path is not pagination-shaped.");
        }
      }
      if (pagination.responseLinkHeader !== undefined && pagination.responseLinkHeader !== "link") {
        throw new Error("Compiled pagination Link header is invalid.");
      }
      if (!Array.isArray(pagination.mutableQueryPaths) || pagination.mutableQueryPaths.length < 1 ||
        pagination.mutableQueryPaths.length > 50) {
        throw new Error("Compiled pagination mutable-query paths are invalid.");
      }
      const mutablePathKeys = new Set<string>();
      for (const path of pagination.mutableQueryPaths) {
        assertTemplatePath(path, "Compiled pagination mutable-query path");
        const key = JSON.stringify(path);
        if (mutablePathKeys.has(key)) throw new Error("Compiled pagination mutable-query paths must be unique.");
        mutablePathKeys.add(key);
      }
      if (plan.request.method !== "GET" || plan.request.bodyCodec !== "none" ||
        Object.values(plan.request.bindings).flat().some((binding) => binding.source !== "query")) {
        throw new Error("Compiled next-URL pagination requires a body-less GET with query-only inputs.");
      }
      if (Object.values(plan.request.bindings).flat().some((binding) =>
        mutablePathKeys.has(JSON.stringify(binding.path)))) {
        throw new Error("Compiled pagination cannot mutate a user input binding.");
      }
    } else {
      if (!new Set(["query", "body"]).has(pagination.requestSource)) {
        throw new Error("Compiled network pagination request source is invalid.");
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
        if (!new Set(["has-next", "next-value", "short-page", "total-pages-header"]).has(pagination.termination.type)) {
          throw new Error("Compiled pagination termination strategy is invalid.");
        }
        if (pagination.termination.type === "total-pages-header") {
          if (!TOTAL_PAGES_HEADER_NAME.test(pagination.termination.header)) {
            throw new Error("Compiled pagination total-pages header is invalid.");
          }
        } else {
          assertTemplatePath(pagination.termination.responsePath, "Compiled pagination termination path");
        }
        if (pagination.termination.type === "short-page" &&
          (!Number.isSafeInteger(pagination.termination.pageSize) || pagination.termination.pageSize < 1 ||
            pagination.termination.pageSize > 100_000)) {
          throw new Error("Compiled pagination page size is invalid.");
        }
      }
      const requestRoot = pagination.requestSource === "query"
        ? plan.request.queryTemplate
        : plan.request.bodyTemplate;
      const omittedTopLevelQueryParameter = pagination.requestSource === "query" && pagination.requestPath.length === 2 &&
        typeof pagination.requestPath[0] === "string" && pagination.requestPath[1] === 0 &&
        requestRoot !== null && valueAt(requestRoot, pagination.requestPath) === undefined;
      if (requestRoot === null ||
        (valueAt(requestRoot, pagination.requestPath) === undefined &&
          !omittedTopLevelQueryParameter && !canSetPaginationValue(requestRoot, pagination.requestPath))) {
        throw new Error("Compiled pagination request path does not exist in its request template.");
      }
    }
    if (!Number.isSafeInteger(pagination.maximumPages) ||
      pagination.maximumPages < 2 || pagination.maximumPages > 40) {
      throw new Error("Compiled pagination page limit is invalid.");
    }
  }
  const contextPaths = { query: new Set<string>(), body: new Set<string>() };
  if (plan.request.transport !== undefined && (plan.request.transport !== "browser-fetch" || plan.request.pagination ||
    (plan.request.endpointOrigin ?? plan.origin) !== plan.origin || !(plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length))) {
    throw new Error("Invalid browser-network transport contract.");
  }
  if (plan.request.runtimeFields !== undefined) {
    if (!Array.isArray(plan.request.runtimeFields) || !plan.request.runtimeFields.length || plan.request.runtimeFields.length > 100 || plan.request.pagination) {
      throw new Error("Invalid runtime field contract; context pagination is not supported.");
    }
    for (const field of plan.request.runtimeFields) {
      if (!field || !["query", "body"].includes(field.source) || !["string", "number", "boolean"].includes(field.type)) throw new Error("Invalid runtime field.");
      assertTemplatePath(field.path, "Runtime field path");
      if (field.path.some((key) => ["__proto__", "prototype", "constructor", "$clappingHandsInput"].includes(String(key)))) throw new Error("Unsafe runtime field path.");
      if (field.path.some((key) => /^(?:operation(?:Name)?|query|mutation|doc_id|document_id|action|method|pathname|url|endpoint)$/i.test(String(key)))) throw new Error("Operation identity cannot be runtime context.");
      const key = JSON.stringify(field.path);
      if (contextPaths[field.source].has(key) || valueAt(field.source === "query" ? plan.request.queryTemplate : plan.request.bodyTemplate, field.path) !== null) throw new Error("Runtime fields must be unique null placeholders.");
      if (Object.values(plan.request.bindings).flat().some((binding) => pathKey(binding.source, binding.path) === pathKey(field.source, field.path))) throw new Error("Runtime field overlaps an input.");
      contextPaths[field.source].add(key);
    }
  }
  if (plan.request.runtimeHeaders !== undefined && (!Array.isArray(plan.request.runtimeHeaders) || !plan.request.runtimeHeaders.length ||
    plan.request.runtimeHeaders.length > 16 || new Set(plan.request.runtimeHeaders).size !== plan.request.runtimeHeaders.length ||
    plan.request.runtimeHeaders.some((name) => typeof name !== "string" || !isSessionHeaderName(name)) || plan.request.pagination ||
    (plan.request.runtimeFields?.length ?? 0) + plan.request.runtimeHeaders.length > 100 || (plan.request.endpointOrigin ?? plan.origin) !== plan.origin)) {
    throw new Error("Invalid runtime header contract; only same-origin session headers are supported.");
  }
  if (plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length) {
    const operationText = [plan.request.endpointPath, ...leafEntries(plan.request.queryTemplate).map((entry) => entry.value),
      ...leafEntries(plan.request.bodyTemplate).map((entry) => entry.value)].filter((value) => typeof value === "string");
    if (operationText.some((value) => /mutation|(?:^|[/_\s])(?:delete|commit|purchase|create|update|remove)(?:$|[/_\s])/i.test(value as string))) {
      throw new Error("Mutation-shaped operations cannot use read runtime context.");
    }
  }
  assertSafeTemplate(plan.request.queryTemplate, [], contextPaths.query);
  if (plan.request.bodyTemplate !== null) assertSafeTemplate(plan.request.bodyTemplate, [], contextPaths.body);
  if (plan.request.bodyUrlFields !== undefined) {
    if (plan.request.bodyCodec !== "form" || !Array.isArray(plan.request.bodyUrlFields) || plan.request.bodyUrlFields.length > 20) throw new Error("Invalid nested URL codecs.");
    const seen = new Set<string>();
    for (const field of plan.request.bodyUrlFields) {
      if (!field || typeof field.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(field.name) ||
        !Number.isSafeInteger(field.index) || field.index < 0 || field.index > 100) throw new Error("Invalid nested URL field.");
      const key = JSON.stringify([field.name, field.index]);
      if (seen.has(key)) throw new Error("Duplicate nested URL codec."); seen.add(key);
      const value = valueAt(plan.request.bodyTemplate, [field.name, field.index]) as { pathname?: unknown; query?: unknown } | undefined;
      if (!value || typeof value.pathname !== "string" || !decodeRelativeUrl(value.pathname + "?codec_check=1") ||
        !value.query || typeof value.query !== "object" || Array.isArray(value.query)) throw new Error("Invalid nested URL template.");
    }
  }
  if (plan.response.codec !== undefined && !["json", "json-lines", "html-input-values", "html-document"].includes(plan.response.codec)) throw new Error("Invalid response codec.");
  if(plan.response.codec==='html-document'){
    if(!['utf-8','windows-1252'].includes(plan.response.documentEncoding??'') || plan.response.shape.type!=='string'
      || plan.response.htmlRecipe || plan.response.records!==undefined || plan.request.pagination || plan.request.transport
      || plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length || (plan.request.endpointOrigin??plan.origin)!==plan.origin
      || plan.response.maximumBytes>1024*1024)throw new Error('Unsupported HTML document request contract.');
  }else if(plan.response.documentEncoding!==undefined)throw new Error('Document encoding requires HTML document codec.');
  if (plan.response.codec === "html-input-values") {
    assertHtmlValueResponseRecipe(plan.response.htmlRecipe);
    if (plan.response.records !== undefined || plan.request.pagination || plan.request.transport ||
      plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length ||
      (plan.request.endpointOrigin ?? plan.origin) !== plan.origin || plan.response.maximumBytes > 1024 * 1024) {
      throw new Error("Unsupported HTML response request contract.");
    }
  } else if (plan.response.htmlRecipe !== undefined) throw new Error("HTML recipe requires its declared response codec.");
  if (plan.response.codec === "json-lines" && (!Number.isSafeInteger(plan.response.records) || plan.response.records! < 2 || plan.response.records! > 128)) {
    throw new Error("Invalid response frame count.");
  }
  if (!Number.isSafeInteger(plan.response.maximumBytes) || plan.response.maximumBytes < 1 || plan.response.maximumBytes > 8 * 1024 * 1024) {
    throw new Error("Compiled network response limit is invalid.");
  }
}

function requestSignature(exchange: CapturedExchange, input?: NetworkInput): string {
  const url = new URL(exchange.url);
  return `${exchange.method.toUpperCase()} ${url.origin}${input?pathSignature(url.pathname,input):url.pathname} ${bodyCodec(exchange)}`;
}

function candidateSignature(exchange: CapturedExchange, htmlOutputRecipe?: OutputRecipe, input?: NetworkInput): string | null {
  if (exchange.responseStatus < 200 || exchange.responseStatus >= 300) return null;
  try {
    inferCapturedNetworkResponse(exchange, htmlOutputRecipe);
    return requestSignature(exchange,input);
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
  responseHeaders: Record<string, string>;
};

type PaginationPlan = NonNullable<GenericJsonPlan["request"]["pagination"]>;
type CursorPaginationPlan = Extract<PaginationPlan, { strategy: "cursor" }>;
type IncrementPaginationPlan = Extract<PaginationPlan, { strategy: "increment" }>;
type NextUrlPaginationPlan = Extract<PaginationPlan, { strategy: "next-url" }>;

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

type NextUrlPaginationInference = {
  pagination: NextUrlPaginationPlan;
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
      sequence.push({
        request: parseRequest(exchange),
        response: parseJson(exchange.responseBody),
        responseHeaders: Object.fromEntries(Object.entries(exchange.responseHeaders ?? {})
          .map(([name, value]) => [name.toLowerCase(), value])),
      });
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
    const uniquePaths = new Map<string, Path>();
    for (const page of sequences[0]!.slice(1)) {
      const root = requestRoot(page.request, source);
      if (root === null) continue;
      for (const entry of leafEntries(root)) uniquePaths.set(JSON.stringify(entry.path), entry.path);
    }
    for (const path of uniquePaths.values()) {
      if (!PAGINATION_FIELD_NAME.test(lastNamedSegment(path)) ||
        boundPaths.has(pathKey(source, path))) continue;
      const initialValues = sequences.map((sequence) =>
        valueAt(requestRoot(sequence[0]!.request, source), path));
      if (!initialValues.every((value) => value === undefined || value === null || value === "") ||
        new Set(initialValues.map((value) => JSON.stringify(value))).size !== 1) continue;
      const everyTransitionChanges = sequences.every((sequence) => sequence.slice(0, -1).every((page, index) => {
        const current = valueAt(requestRoot(page.request, source), path);
        const next = valueAt(requestRoot(sequence[index + 1]!.request, source), path);
        return next !== undefined && !sameScalar(current, next);
      }));
      if (everyTransitionChanges) requestCandidates.push({ source, path });
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

    const totalPagesHeader = Object.keys(sequences[0]![0]!.responseHeaders)
      .filter((name) => TOTAL_PAGES_HEADER_NAME.test(name))
      .sort()
      .find((name) => sequences.every((sequence) => {
        const values = sequence.map((page) => finiteInteger(page.responseHeaders[name]));
        return values.every((value) => value !== null && value > 0 && value <= 40) &&
          new Set(values).size === 1 && values[0] === sequence.length;
      }));

    const shortPage = nestedEntries(sequences[0]![0]!.response)
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
        : totalPagesHeader
          ? { type: "total-pages-header", header: totalPagesHeader }
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

function canonicalUrl(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.hash) return null;
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

function inferMutableQueryPaths(plan: GenericJsonPlan, sequences: ParsedPaginationExchange[][]): Path[] | null {
  const mutablePathsBySequence = sequences.map((sequence) => {
    const paths = new Map<string, Path>();
    for (const page of sequence) {
      for (const entry of leafEntries(page.request.query)) paths.set(JSON.stringify(entry.path), entry.path);
    }
    return [...paths.entries()]
      .filter(([, path]) => new Set(sequence.map((page) =>
        JSON.stringify(valueAt(page.request.query, path)))).size > 1)
      .map(([key, path]) => ({ key, path }))
      .sort((left, right) => left.key.localeCompare(right.key));
  });
  const mutableKeys = mutablePathsBySequence[0]!.map((entry) => entry.key);
  if (mutableKeys.length === 0 || mutablePathsBySequence.some((entries) =>
    JSON.stringify(entries.map((entry) => entry.key)) !== JSON.stringify(mutableKeys))) return null;
  const boundQueryPaths = new Set(Object.values(plan.request.bindings).flat()
    .filter((binding) => binding.source === "query")
    .map((binding) => JSON.stringify(binding.path)));
  if (mutableKeys.some((key) => boundQueryPaths.has(key))) return null;
  return mutablePathsBySequence[0]!.map((entry) => entry.path);
}

function inferNextUrlPagination(
  plan: GenericJsonPlan,
  traces: GenericNetworkTrace[],
  demonstrations: GenericNetworkDemonstration[],
): NextUrlPaginationInference | null {
  if (plan.request.method !== "GET" || plan.request.bodyCodec !== "none" ||
    Object.values(plan.request.bindings).flat().some((binding) => binding.source !== "query")) return null;
  const sequences = traces.map((trace, index) => paginationSequence(trace, demonstrations[index]!.exchange));
  if (sequences.some((sequence) => sequence.length < 2) ||
    sequences.some((sequence, index) => !sequencePreservesInputs(plan, sequence, traces[index]!.input))) {
    return null;
  }
  const mutableQueryPaths = inferMutableQueryPaths(plan, sequences);
  if (!mutableQueryPaths) return null;
  const nextUrlPath = leafEntries(sequences[0]![0]!.response)
    .filter((entry) => typeof entry.value === "string" && entry.value.length > 0 &&
      NEXT_VALUE_FIELD_NAME.test(lastNamedSegment(entry.path)))
    .map((entry) => entry.path)
    .sort((left, right) => left.length - right.length || JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .find((path) => sequences.every((sequence) => {
      const transitionsMatch = sequence.slice(0, -1).every((page, index) => {
        const value = valueAt(page.response, path);
        if (typeof value !== "string" || value.length === 0) return false;
        const expected = canonicalUrl(value, page.request.url.href);
        const actual = canonicalUrl(sequence[index + 1]!.request.url.href);
        return expected !== null && expected === actual;
      });
      return transitionsMatch && terminalNextValue(valueAt(sequence.at(-1)!.response, path));
    }));
  if (!nextUrlPath) return null;
  const responses = sequences.flatMap((sequence) => sequence.map((page) => page.response));
  return {
    pagination: {
      strategy: "next-url",
      responseNextUrlPath: nextUrlPath,
      mutableQueryPaths,
      maximumPages: 40,
    },
    responseShape: inferJsonShape(responses),
    demonstratedPages: responses.length,
  };
}

function nextUrlFromLinkHeader(header: string | undefined): string | null {
  if (!header) return null;
  const matches: string[] = [];
  for (const entry of header.split(/,(?=\s*<)/)) {
    const target = entry.match(/^\s*<([^<>]+)>/);
    if (!target) continue;
    const relation = entry.match(/;\s*rel\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i);
    const relations = (relation?.[1] ?? relation?.[2] ?? "").toLowerCase().split(/\s+/);
    if (relations.includes("next")) matches.push(target[1]!);
  }
  if (matches.length > 1) throw new Error("Pagination Link header declared multiple next URLs.");
  return matches[0] ?? null;
}

function inferLinkHeaderPagination(
  plan: GenericJsonPlan,
  traces: GenericNetworkTrace[],
  demonstrations: GenericNetworkDemonstration[],
): NextUrlPaginationInference | null {
  if (plan.request.method !== "GET" || plan.request.bodyCodec !== "none" ||
    Object.values(plan.request.bindings).flat().some((binding) => binding.source !== "query")) return null;
  const sequences = traces.map((trace, index) => paginationSequence(trace, demonstrations[index]!.exchange));
  if (sequences.some((sequence) => sequence.length < 2) ||
    sequences.some((sequence, index) => !sequencePreservesInputs(plan, sequence, traces[index]!.input))) {
    return null;
  }
  const mutableQueryPaths = inferMutableQueryPaths(plan, sequences);
  if (!mutableQueryPaths) return null;
  const matches = sequences.every((sequence) => {
    const transitionsMatch = sequence.slice(0, -1).every((page, index) => {
      const value = nextUrlFromLinkHeader(page.responseHeaders.link);
      if (!value) return false;
      const expected = canonicalUrl(value, page.request.url.href);
      const actual = canonicalUrl(sequence[index + 1]!.request.url.href);
      return expected !== null && expected === actual;
    });
    return transitionsMatch && nextUrlFromLinkHeader(sequence.at(-1)!.responseHeaders.link) === null;
  });
  if (!matches) return null;
  const responses = sequences.flatMap((sequence) => sequence.map((page) => page.response));
  return {
    pagination: {
      strategy: "next-url",
      responseLinkHeader: "link",
      mutableQueryPaths,
      maximumPages: 40,
    },
    responseShape: inferJsonShape(responses),
    demonstratedPages: responses.length,
  };
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

function responseSupportsTrace(exchange: CapturedExchange, trace: GenericNetworkTrace, recipe?: OutputRecipe): boolean {
  if (/^text\/html(?:\s*;|\s*$)/i.test(exchange.responseHeaders?.["content-type"] ?? "")) {
    try {
      const decoded = inferCapturedNetworkResponse(exchange, recipe);
      return Boolean(trace.outputRows?.length) && isDeepStrictEqual(decoded.value, { rows: trace.outputRows });
    } catch { return false; }
  }
  // Caller-shaped learning is validated by source-bound typed projections later.
  // Display-text overlap cannot rank numeric units or native input values.
  if (trace.outputRows !== undefined) return true;
  return trace.outputText === undefined || jsonResponseSupportsOutput(exchange.responseBody, trace.outputText, trace.input);
}

export function compileGenericJsonFromTraces(
  action: string,
  traces: GenericNetworkTrace[],
  options: { workflowOrigin?: string; allowedNetworkOrigins?: string[]; experimentalRuntimeContext?: boolean } = {},
): { plan: GenericJsonPlan; demonstrations: GenericNetworkDemonstration[] } {
  return compileGenericJsonCandidatesFromTraces(action, traces, options)[0]!;
}

export type CandidateCompilationAudit = {
  traceCount: number; capturedCounts: number[]; eligibleCounts: number[];
  preShortlistEligibleCounts: number[]; shortlistDiscardedCounts: number[];
  sharedGroups: number; attemptedCombinations: number; truncatedGroups: number;
  compiledPlans: number; returnedCandidates: number;
  prefilterRejections?: { responseEvidence: number; inputBinding: number; requestParse: number; responseCodec: number };
  rejections: Partial<Record<"operation" | "input-binding" | "unbound-dynamic" | "secret-constant" | "mutation-shaped"
    | "runtime-type" | "runtime-context-required" | "response-framing" | "request-codec" | "network-origin" | "other", number>>;
};
function candidateRejection(error: unknown): keyof CandidateCompilationAudit["rejections"] {
  // Inspect an own data property only. Never return exception text or paths.
  let message = "";
  try { const property = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
    if (property && "value" in property && typeof property.value === "string") message = property.value;
  } catch { return "other"; }
  return /same operation|Operation identity/.test(message) ? "operation"
    : /infer a request binding|did not vary|input schema/.test(message) ? "input-binding"
    : /Session (?:request headers require runtime context|header shape changed)/.test(message) ? "runtime-context-required"
    : /Unbound dynamic/.test(message) ? "unbound-dynamic"
    : /high-entropy|secret|sensitive/i.test(message) ? "secret-constant"
    : /Mutation-shaped/.test(message) ? "mutation-shaped"
    : /stable scalar|context.*type/i.test(message) ? "runtime-type"
    : /Response codec|Response frame|response.*framing/i.test(message) ? "response-framing"
    : /Nested URL|body codec|request content type/i.test(message) ? "request-codec"
    : /origin|plaintext network/i.test(message) ? "network-origin" : "other";
}

export function compileGenericJsonCandidatesFromTraces(
  action: string,
  traces: GenericNetworkTrace[],
  options: { workflowOrigin?: string; allowedNetworkOrigins?: string[]; experimentalRuntimeContext?: boolean;
    onAudit?: (audit: CandidateCompilationAudit) => void; htmlOutputRecipe?: OutputRecipe; allowPathInputs?: boolean } = {},
): Array<{ plan: GenericJsonPlan; demonstrations: GenericNetworkDemonstration[] }> {
  if (traces.length < 2) throw new Error("Two network traces are required.");
  const preShortlistEligibleCounts: number[] = [], shortlistDiscardedCounts: number[] = [];
  const prefilterRejections = { responseEvidence: 0, inputBinding: 0, requestParse: 0, responseCodec: 0 };
  const indexed = traces.map((trace, traceIndex) => {
    preShortlistEligibleCounts[traceIndex] = 0; shortlistDiscardedCounts[traceIndex] = 0;
    const groups = new Map<string, CapturedExchange[]>();
    for (const exchange of trace.exchanges) {
      // Apply evidence filters before the bounded shortlist; otherwise a shared
      // endpoint's early configuration traffic can crowd out the actual action.
      if (!responseSupportsTrace(exchange, trace, options.htmlOutputRecipe)) { prefilterRejections.responseEvidence++; continue; }
      try {
        const parsed = parseRequest(exchange);
        if (!Object.entries(trace.input).every(([name,input]) =>
          (options.allowPathInputs && observedPathBindings(parsed.url.pathname,trace.input)[name]?.length) ||
          leafEntries(parsed.query).some((entry) => equivalent("query", entry.value, input)) ||
          leafEntries(parsed.body).some((entry) => equivalent("body", entry.value, input)))) { prefilterRejections.inputBinding++; continue; }
      } catch { prefilterRejections.requestParse++; continue; }
      const signature = candidateSignature(exchange, options.htmlOutputRecipe,options.allowPathInputs?trace.input:undefined);
      if (!signature) { prefilterRejections.responseCodec++; continue; }
      preShortlistEligibleCounts[traceIndex]++;
      const values = groups.get(signature) ?? [];
      if (values.length < 8) values.push(exchange);
      else shortlistDiscardedCounts[traceIndex]++;
      groups.set(signature, values);
    }
    return groups;
  });
  const shared = [...indexed[0]!.keys()].filter((signature) => indexed.every((group) => group.has(signature)));
  const audit: CandidateCompilationAudit = { traceCount: traces.length,
    capturedCounts: traces.slice(0, 10).map((trace) => trace.exchanges.length),
    preShortlistEligibleCounts: preShortlistEligibleCounts.slice(0, 10), shortlistDiscardedCounts: shortlistDiscardedCounts.slice(0, 10),
    eligibleCounts: indexed.slice(0, 10).map((group) => [...group.values()].reduce((count, values) => count + values.length, 0)),
    sharedGroups: shared.length, attemptedCombinations: 0, truncatedGroups: 0, compiledPlans: 0, returnedCandidates: 0, rejections: {}, prefilterRejections };
  const compiled: Array<{
    plan: GenericJsonPlan;
    demonstrations: GenericNetworkDemonstration[];
    score: number;
  }> = [];

  for (const signature of shared) {
    const choices = indexed.map((group) => group.get(signature)!);
    if (choices.reduce((count, values) => Math.min(65, count * values.length), 1) > 64) audit.truncatedGroups++;
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
      audit.attemptedCombinations++;
      const demonstrations = combination.map((exchange, index) => ({ input: traces[index]!.input, exchange, outputRows: traces[index]!.outputRows }));
      try {
        if (traces.some((trace, index) => !responseSupportsTrace(combination[index]!, trace, options.htmlOutputRecipe))) {
          continue;
        }
        const plan = compileGenericJsonPlan(action, demonstrations, options);
        const html = plan.response.codec === "html-input-values" || Boolean(plan.request.pathBindings);
        const cursorPagination = html ? null : inferCursorPagination(plan, traces, demonstrations);
        const incrementPagination = html || cursorPagination ? null : inferIncrementPagination(plan, traces, demonstrations);
        const nextUrlPagination = html || cursorPagination || incrementPagination
          ? null
          : inferNextUrlPagination(plan, traces, demonstrations);
        const linkHeaderPagination = html || cursorPagination || incrementPagination || nextUrlPagination
          ? null
          : inferLinkHeaderPagination(plan, traces, demonstrations);
        const pagination = cursorPagination ?? incrementPagination ?? nextUrlPagination ?? linkHeaderPagination;
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
      } catch (error) {
        // Most same-page traffic is analytics, configuration, or unrelated
        // hydration. Only operations that bind every varying action input and
        // satisfy the redaction contract are eligible.
        const category = candidateRejection(error);
        audit.rejections[category] = (audit.rejections[category] ?? 0) + 1;
      }
    }
  }
  const seen = new Set<string>();
  const candidates = compiled.sort((left, right) => right.score - left.score).filter(({ plan }) => {
    const key = hash({ request: plan.request, response: plan.response });
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 8).map(({ plan, demonstrations }) => ({ plan, demonstrations }));
  audit.compiledPlans = compiled.length; audit.returnedCandidates = candidates.length;
  options.onAudit?.(audit);
  if (!candidates.length) throw new Error("No captured JSON operation safely bound every demonstrated input.");
  return candidates;
}

/** Admit varying scalar request arguments without assuming they came directly
 * from caller input. The model must explain their dataflow in executable code;
 * offline request matching and held-out comparisons remain mandatory. */
export function compileObservedJsonResources(action:string,traces:GenericNetworkTrace[],
  options:{workflowOrigin:string;allowedNetworkOrigins?:string[]}):Array<{plan:GenericJsonPlan;demonstrations:GenericNetworkDemonstration[]}>{
  if(traces.length!==2)return [];
  const groups=traces.map(trace=>{
    const result=new Map<string,CapturedExchange[]>();
    for(const exchange of trace.exchanges.slice(0,200)){
      const signature=candidateSignature(exchange);if(!signature)continue;
      const values=result.get(signature)??[];if(values.length<8)values.push(exchange);result.set(signature,values);
    }
    return result;
  });
  const result:Array<{plan:GenericJsonPlan;demonstrations:GenericNetworkDemonstration[]}>=[];
  for(const [signature,first] of groups[0]!){
    const second=groups[1]!.get(signature);if(!second || second.length!==first.length)continue;
    for(let index=0;index<first.length && result.length<16;index++)try{
      const exchanges=[first[index]!,second[index]!],parsed=exchanges.map(parseRequest);
      const inputs:NetworkInput[]=[{},{}],vectors=new Map<string,string>();
      for(const source of ['query','body'] as const){
        const leaves=parsed.map(p=>leafEntries(p[source]));
        if(!isDeepStrictEqual(leaves[0]!.map(e=>e.path),leaves[1]!.map(e=>e.path)))throw new Error('Observed request structure changed.');
        for(const [i,entry] of leaves[0]!.entries()){
          const values=[entry.value,leaves[1]![i]!.value];if(isDeepStrictEqual(values[0],values[1]))continue;
          if(values.some(v=>!['string','number','boolean'].includes(typeof v) || (typeof v==='number'&&!Number.isFinite(v)) ||
            (typeof v==='string'&&(looksHighEntropy(v)||/^\s*(?:query|mutation|subscription)\b.*[{(]/s.test(v)))) ||
            entry.path.some(p=>typeof p==='string' && (SENSITIVE_NAME.test(p)||/^(?:operationName|operation|mutation|doc_id|document_id|action|method|url|endpoint|pathname)$/i.test(p))))throw new Error('Unsupported observed argument.');
          const vector=JSON.stringify(values);if(vectors.has(vector))continue;
          if(vectors.size>=16)throw new Error('Too many observed arguments.');
          const name='argument_'+vectors.size;vectors.set(vector,name);
          inputs[0]![name]=values[0] as string|number|boolean;inputs[1]![name]=values[1] as string|number|boolean;
        }
      }
      if(!vectors.size)continue;
      const demonstrations=exchanges.map((exchange,i)=>({exchange,input:inputs[i]!}));
      const plan=compileGenericJsonPlan(action,demonstrations,options);
      result.push({plan,demonstrations});
    }catch{/* Non-scalar, ambiguous or unsafe observed resources are not executable. */}
  }
  return result;
}

export function compileGenericJsonPlan(
  action: string,
  demonstrations: GenericNetworkDemonstration[],
  options: { workflowOrigin?: string; allowedNetworkOrigins?: string[]; experimentalRuntimeContext?: boolean; htmlOutputRecipe?: OutputRecipe; allowHtmlDocument?:boolean; allowPathInputs?:boolean } = {},
): GenericJsonPlan {
  if (demonstrations.length < 2) throw new Error("Two distinct network demonstrations are required.");
  const method = demonstrations[0]!.exchange.method.toUpperCase();
  if (!READ_NETWORK_METHODS.has(method)) {
    throw new Error(`Read network acceleration supports GET and evidence-linked POST only; ${method} requires the effectful workflow path.`);
  }
  const signatures = new Set(demonstrations.map(({ exchange,input }) => requestSignature(exchange,options.allowPathInputs?input:undefined)));
  if (signatures.size !== 1) throw new Error("Network demonstrations do not describe the same operation.");
  const parsed = demonstrations.map(({ exchange }) => parseRequest(exchange));
  const first = parsed[0]!;
  if(demonstrations.some(d=>requestHeaders(d.exchange)['content-type']!==requestHeaders(demonstrations[0]!.exchange)['content-type']))throw new Error('Request content type changed across demonstrations.');
  if (parsed.some((request) => JSON.stringify(request.bodyUrlFields) !== JSON.stringify(first.bodyUrlFields))) throw new Error("Nested URL codec drift across demonstrations.");
  const inputs = Object.keys(demonstrations[0]!.input).sort();
  if (demonstrations.some((demo) => JSON.stringify(Object.keys(demo.input).sort()) !== JSON.stringify(inputs))) {
    throw new Error("Network demonstrations must use the same input schema.");
  }
  const queryTemplate = structuredClone(first.query);
  const bodyTemplate = structuredClone(first.body);
  const bindings: GenericJsonPlan["request"]["bindings"] = {};
  const pathBindings=options.allowPathInputs?observedPathBindings(first.url.pathname,demonstrations[0]!.input):{};
  if(options.allowPathInputs && demonstrations.some((demo,i)=>!isDeepStrictEqual(pathBindings,observedPathBindings(parsed[i]!.url.pathname,demo.input))))throw new Error('Path bindings changed across demonstrations.');
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
    if (locations.length === 0 && !pathBindings[inputName]?.length) throw new Error(`Could not infer a request binding for input ${inputName}.`);
    bindings[inputName] = locations;
    for (const location of locations) {
      allBoundPaths.add(pathKey(location.source, location.path));
      setAt(location.source === "query" ? queryTemplate : bodyTemplate, location.path, { $clappingHandsInput: inputName });
    }
  }

  const dynamicFields: RequestFieldPath[] = [];
  const sensitiveFields: RequestFieldPath[] = [];
  const opaqueFields: RequestFieldPath[] = [];
  for (const source of ["query", "body"] as const) {
    const root = source === "query" ? first.query : first.body;
    if (root === null) continue;
    for (const entry of leafEntries(root)) {
      const values = parsed.map((request) => valueAt(source === "query" ? request.query : request.body, entry.path));
      const fieldName = [...entry.path].reverse().find((part): part is string => typeof part === "string");
      if (values.some((value) => typeof value === "string" && looksHighEntropy(value)) &&
        !(fieldName && PUBLIC_OPAQUE_CONSTANT_NAME.test(fieldName))) opaqueFields.push({ source, path: entry.path });
      if (entry.path.some((key) => typeof key === "string" && SENSITIVE_NAME.test(key))) sensitiveFields.push({ source, path: entry.path });
      if (new Set(values.map((value) => JSON.stringify(value))).size > 1 && !allBoundPaths.has(pathKey(source, entry.path))) {
        dynamicFields.push({ source, path: entry.path });
      }
    }
  }

  const runtimeFields: NonNullable<GenericJsonPlan["request"]["runtimeFields"]> = [];
  const headerSets = demonstrations.map((demo) => Object.keys(capturedSessionHeaders(demo.exchange)).sort());
  if (headerSets.some((headers) => !isDeepStrictEqual(headers, headerSets[0]))) throw new Error("Session header shape changed across demonstrations.");
  const runtimeHeaders = headerSets[0]!;
  if (runtimeHeaders.length && !options.experimentalRuntimeContext) throw new Error("Session request headers require runtime context.");
  if (options.experimentalRuntimeContext) {
    for (const field of [...dynamicFields, ...sensitiveFields, ...opaqueFields]) {
      if (runtimeFields.some((other) => pathKey(other.source, other.path) === pathKey(field.source, field.path))) continue;
      if (allBoundPaths.has(pathKey(field.source, field.path))) throw new Error("Sensitive context cannot be a user input.");
      const values = parsed.map((request) => valueAt(field.source === "query" ? request.query : request.body, field.path));
      const type = typeof values[0];
      if (!["string", "number", "boolean"].includes(type) || values.some((value) => typeof value !== type)) throw new Error("Runtime context must have a stable scalar type.");
      runtimeFields.push({ ...field, type: type as "string" | "number" | "boolean" });
      setAt(field.source === "query" ? queryTemplate : bodyTemplate, field.path, null);
    }
  } else if (dynamicFields.length) throw new RequestContextRequiredError(dynamicFields, sensitiveFields);

  assertSafeTemplate(queryTemplate, [], new Set(runtimeFields.filter((field) => field.source === "query").map((field) => JSON.stringify(field.path))));
  if (bodyTemplate !== null) assertSafeTemplate(bodyTemplate, [], new Set(runtimeFields.filter((field) => field.source === "body").map((field) => JSON.stringify(field.path))));
  const decodedResponses = demonstrations.map(({ exchange, outputRows }) => {
    const decoded = inferCapturedNetworkResponse(exchange, options.htmlOutputRecipe,options.allowHtmlDocument);
    if (decoded.codec === "html-input-values" && (!outputRows?.length || !isDeepStrictEqual(decoded.value, { rows: outputRows }))) {
      throw new Error("HTML attributes do not match the independent browser sources.");
    }
    return decoded;
  });
  if (new Set(decodedResponses.map((item) => item.codec)).size !== 1) throw new Error("Response codec drift across demonstrations.");
  const responseCodec = decodedResponses[0]!.codec;
  if(responseCodec==='html-document' && decodedResponses.some(item=>item.documentEncoding!==decodedResponses[0]!.documentEncoding))throw new Error('HTML document encoding drift across demonstrations.');
  if (responseCodec === "html-input-values" && decodedResponses.some((item) =>
    !isDeepStrictEqual(item.htmlRecipe, decodedResponses[0]!.htmlRecipe))) throw new Error("HTML recipe or encoding drift across demonstrations.");
  const responses = decodedResponses.map((item) => item.value);
  const records = responseCodec === "json-lines" ? (responses[0] as unknown[]).length : undefined;
  if (records !== undefined && responses.some((value) => (value as unknown[]).length !== records)) throw new Error("Response frame count drift across demonstrations.");
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
      ...(Object.keys(pathBindings).length?{pathBindings}:{}),
      headers: requestHeaders(demonstrations[0]!.exchange),
      queryTemplate,
      bodyCodec: first.codec,
      bodyTemplate,
      ...(first.bodyUrlFields.length ? { bodyUrlFields: first.bodyUrlFields } : {}),
      ...(runtimeFields.length ? { runtimeFields } : {}),
      ...(runtimeHeaders.length ? { runtimeHeaders } : {}),
      bindings,
    },
    response: { shape: inferJsonShape(responses), maximumBytes: responseCodec === "html-input-values" || responseCodec==='html-document' ? 1024 * 1024 : 8 * 1024 * 1024,
      ...(responseCodec === "json-lines" ? { codec: responseCodec, records } : {}),
      ...(responseCodec === "html-input-values" ? { codec: responseCodec, htmlRecipe: decodedResponses[0]!.htmlRecipe } : {}),
      ...(responseCodec==='html-document'?{codec:responseCodec,documentEncoding:decodedResponses[0]!.documentEncoding}:{}) },
    evidence: {
      inputHashVersion: "sorted-flat-v1",
      demonstrationInputHashes: demonstrations.map((demo) => inputEvidenceHash(demo.input)),
      successfulShadowInputHashes: [],
      successfulShadowCount: 0,
      failedShadowCount: 0,
      lastValidatedAt: null,
    },
  };
  assertGenericJsonPlanSafety(plan);
  if (runtimeFields.length || runtimeHeaders.length) for (const demo of demonstrations) capturedContextValues(plan, demo.exchange, demo.input);
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

function materializeParameters(template: Record<string, TemplateValue[]>, input: NetworkInput, urlFields: Array<{ name: string; index: number }> = []): URLSearchParams {
  const output = new URLSearchParams();
  for (const [name, values] of Object.entries(template)) {
    values.forEach((value, index) => {
      const rendered = materialize(value, input);
      output.append(name, urlFields.some((field) => field.name === name && field.index === index) ? encodeRelativeUrl(rendered)
        : rendered && typeof rendered === "object" ? JSON.stringify(rendered) : String(rendered));
    });
  }
  return output;
}

function validatedNextPageUrl(raw: string, currentUrl: string, plan: GenericJsonPlan, input: NetworkInput): URL {
  const pagination = plan.request.pagination;
  if (pagination?.strategy !== "next-url") throw new Error("Compiled pagination next-page strategy is invalid.");
  const canonical = canonicalUrl(raw, currentUrl);
  if (!canonical) throw new Error("Compiled pagination returned an invalid next-page URL.");
  const url = new URL(canonical);
  const endpointOrigin = plan.request.endpointOrigin ?? plan.origin;
  if (url.origin !== endpointOrigin || url.pathname !== plan.request.endpointPath) {
    throw new Error("Compiled pagination returned a next-page URL outside its validated endpoint.");
  }
  const query = recordFromSearchParams(url.searchParams);
  const expectedQuery = recordFromSearchParams(materializeParameters(plan.request.queryTemplate, input));
  const mutablePathKeys = new Set(pagination.mutableQueryPaths.map((path) => JSON.stringify(path)));
  const expectedPaths = new Map(leafEntries(expectedQuery).map((entry) => [JSON.stringify(entry.path), entry.path]));
  for (const path of pagination.mutableQueryPaths) expectedPaths.set(JSON.stringify(path), path);
  const actualPaths = new Map(leafEntries(query).map((entry) => [JSON.stringify(entry.path), entry.path]));
  const expectedPathKeys = [...expectedPaths.keys()].sort();
  const actualPathKeys = [...actualPaths.keys()].sort();
  if (JSON.stringify(expectedPathKeys) !== JSON.stringify(actualPathKeys)) {
    throw new Error("Compiled pagination next-page URL changed its demonstrated query shape.");
  }
  const boundPathKeys = new Set(Object.values(plan.request.bindings).flat()
    .filter((binding) => binding.source === "query")
    .map((binding) => JSON.stringify(binding.path)));
  for (const [key, path] of expectedPaths) {
    if (mutablePathKeys.has(key) || boundPathKeys.has(key)) continue;
    if (JSON.stringify(valueAt(query, path)) !== JSON.stringify(valueAt(expectedQuery, path))) {
      throw new Error("Compiled pagination next-page URL changed a stable query value.");
    }
  }
  for (const [inputName, bindings] of Object.entries(plan.request.bindings)) {
    if (bindings.some((binding) => binding.source !== "query" ||
      !equivalent("query", valueAt(query, binding.path), input[inputName]!))) {
      throw new Error("Compiled pagination next-page URL changed a user input binding.");
    }
  }
  return url;
}

export type GenericRequestContext = { vault: RequestContextVault; ticket: RequestContextTicket; epoch: string; browserHeaders?: { origin?: string; referer?: string };
  browserTransport?: { page: Page; document: BrowserNetworkDocument } };

export type GenericContextCaptureFailure = "operation" | "input-schema" | "context-type" | "request-contract" |
  "response-codec" | "response-contract" | "session-headers" | "source-provenance" | "source-expired" | "unknown";

/** Only fixed categories escape a rejected capture; never stringify network data/errors. */
export function genericContextCaptureFailure(error: unknown): GenericContextCaptureFailure {
  try {
    const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
    switch (message) {
      case "Captured runtime context does not match the compiled operation.": return "operation";
      case "Captured input schema mismatch.": return "input-schema";
      case "Captured runtime context type mismatch.": return "context-type";
      case "Captured runtime context request contract mismatch.": return "request-contract";
      case "JSON response does not match its declared codec.": return "response-codec";
      case "Captured runtime context response contract mismatch.": return "response-contract";
      case "Captured runtime session header contract mismatch.": return "session-headers";
      case "Captured runtime request provenance is unavailable or out of scope.": return "source-provenance";
      case "Captured runtime request source has expired.": return "source-expired";
      default: return "unknown";
    }
  } catch { return "unknown"; }
}

function validatedBrowserHeaders(plan: GenericJsonPlan, headers: { origin?: string; referer?: string } = {}): Record<string, string> {
  const output: Record<string, string> = {};
  if (headers.origin !== undefined) {
    if (headers.origin !== plan.origin) throw new Error("Runtime browser origin header is outside the workflow origin.");
    output.origin = headers.origin;
  }
  if (headers.referer !== undefined) {
    const ref = new URL(headers.referer);
    if (headers.referer.length > 8192 || ref.origin !== plan.origin || ref.username || ref.password || ref.hash) throw new Error("Runtime browser referrer is outside the workflow origin.");
    output.referer = headers.referer;
  }
  return output;
}

function operationContextScope(context: BrowserContext, plan: GenericJsonPlan, epoch: string) {
  return { profile: context, epoch, origin: plan.request.endpointOrigin ?? plan.origin,
    operation: requestOperationFingerprint({ origin: plan.origin, request: plan.request, response: plan.response }) };
}

/** Validates the entire source request before extracting any ephemeral values. */
function capturedContextValues(plan: GenericJsonPlan, exchange: CapturedExchange, capturedInput: NetworkInput): RuntimeFieldValue[] {
  assertGenericJsonPlanSafety(plan);
  const parsed = parseRequest(exchange);
  if (exchange.method.toUpperCase() !== plan.request.method || parsed.url.origin !== (plan.request.endpointOrigin ?? plan.origin) ||
    parsed.url.pathname !== plan.request.endpointPath || parsed.url.username || parsed.url.password || parsed.url.hash ||
    parsed.codec !== plan.request.bodyCodec || !isDeepStrictEqual(parsed.bodyUrlFields, plan.request.bodyUrlFields ?? []) ||
    !isDeepStrictEqual(requestHeaders(exchange), plan.request.headers) || exchange.responseStatus < 200 || exchange.responseStatus >= 300) {
    throw new Error("Captured runtime context does not match the compiled operation.");
  }
  if (!isDeepStrictEqual(Object.keys(capturedInput).sort(), Object.keys(plan.request.bindings).sort())) throw new Error("Captured input schema mismatch.");
  const values: RuntimeFieldValue[] = [];
  for (const field of plan.request.runtimeFields ?? []) {
    const root = field.source === "query" ? parsed.query : parsed.body;
    const value = valueAt(root, field.path);
    if (typeof value !== field.type) throw new Error("Captured runtime context type mismatch.");
    values.push(value as RuntimeFieldValue);
    setAt(root, field.path, null);
  }
  // Exact object/array structure and constants: extra fields are also rejected.
  // Decoded nested-URL dictionaries intentionally have null prototypes. The
  // persisted/materialized template uses ordinary records; compare JSON data,
  // not that implementation detail. Structured cloning preserves own keys/types.
  const expected = { query: materialize(plan.request.queryTemplate, capturedInput), body: materialize(plan.request.bodyTemplate, capturedInput) };
  const actual = { query: structuredClone(parsed.query), body: structuredClone(parsed.body) };
  if (!isDeepStrictEqual(actual.query, expected.query) || !isDeepStrictEqual(actual.body, expected.body)) {
    throw requestContractError(expected, actual);
  }
  const response = decodeGenericCapturedResponse(plan.response, exchange);
  if (!matchesJsonShape(response, plan.response.shape) ||
    plan.response.codec === "json-lines" && (response as unknown[]).length !== plan.response.records) throw new Error("Captured runtime context response contract mismatch.");
  const headers = capturedSessionHeaders(exchange);
  if (!isDeepStrictEqual(Object.keys(headers).sort(), [...(plan.request.runtimeHeaders ?? [])].sort())) throw new Error("Captured runtime session header contract mismatch.");
  for (const name of plan.request.runtimeHeaders ?? []) values.push(headers[name]!);
  return values;
}

/** A single short-lived attempt, not a claim that the site permits token reuse. */
export function captureGenericRequestContext(
  context: BrowserContext, plan: GenericJsonPlan, exchange: CapturedExchange,
  capturedInput: NetworkInput, epoch: string, vault: RequestContextVault,
): GenericRequestContext {
  const values = capturedContextValues(plan, exchange, capturedInput);
  const browserHeaders = validatedBrowserHeaders(plan, { origin: exchange.requestHeaders.origin, referer: exchange.requestHeaders.referer });
  return { vault, epoch, browserHeaders, ticket: vault.issue(operationContextScope(context, plan, epoch), values, { ttlMs: 5000, maximumUses: 1 }) };
}

export type GenericReplayStage = "plan-validation" | "context-consumption" | "request-materialization" | "transport" | "http-validation" | "response-body" | "response-decoding" | "response-validation";

export async function replayGenericJsonPlan(
  context: BrowserContext,
  plan: GenericJsonPlan,
  input: NetworkInput,
  runtimeContext?: GenericRequestContext,
  onStage?: (stage: GenericReplayStage) => void,
): Promise<{ data: unknown; status: number; durationMs: number; requests: number; navigations: 0; complete: true }> {
  onStage?.("plan-validation");
  assertGenericJsonPlanSafety(plan);
  const expectedInputs = Object.keys(plan.request.bindings).sort();
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedInputs)) {
    throw new Error(`Compiled input keys must be exactly: ${expectedInputs.join(", ")}.`);
  }
  const startedAt = performance.now();
  onStage?.("context-consumption");
  const expectedContextValues = (plan.request.runtimeFields?.length ?? 0) + (plan.request.runtimeHeaders?.length ?? 0);
  const contextValues = expectedContextValues
    ? runtimeContext?.vault.consume(runtimeContext.ticket, operationContextScope(context, plan, runtimeContext.epoch))
    : undefined;
  if (expectedContextValues && !contextValues) throw new Error("Fresh validated runtime request context is required.");
  if (contextValues && contextValues.length !== expectedContextValues) throw new Error("Runtime request context count mismatch.");
  const browserHeaders = contextValues ? validatedBrowserHeaders(plan, runtimeContext?.browserHeaders) : {};
  for (const [index, name] of (plan.request.runtimeHeaders ?? []).entries()) {
    const value = contextValues![(plan.request.runtimeFields?.length ?? 0) + index];
    if (typeof value !== "string" || !value || value.length > 8192 || /[\r\n]/.test(value)) throw new Error("Invalid runtime session header value.");
    browserHeaders[name] = value;
  }
  const pagination = plan.request.pagination;
  const maximumPages = pagination?.maximumPages ?? 1;
  const pages: unknown[] = [];
  const seenCursors = new Set<string>();
  const seenRequestUrls = new Set<string>();
  let nextCursor: string | number | undefined;
  let nextPageUrl: string | undefined;
  let totalPagesFromHeader: number | undefined;
  let totalBytes = 0;
  let status = 0;

  // Playwright retains an API response body, and its request/response logs, until
  // the response is disposed or the whole context closes. Release each transport
  // response before the next page and on every success, refusal or error exit.
  let openResponse: { dispose: () => Promise<void> } | undefined;
  const releaseResponse = async (): Promise<void> => {
    const pending = openResponse;
    openResponse = undefined;
    // A cleanup failure retains a buffer; it must never replace a validated
    // result or mask the primary typed error that is already propagating.
    if (pending) { try { await pending.dispose(); } catch { /* retained transport buffer only */ } }
  };
  try {
    for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
      await releaseResponse(); // A continued pagination page never keeps the previous body.
      onStage?.("request-materialization");
      const queryTemplate = structuredClone(plan.request.queryTemplate);
      const bodyTemplate = structuredClone(plan.request.bodyTemplate);
      for (const [index, field] of (plan.request.runtimeFields ?? []).entries()) {
        const value = contextValues![index]!;
        if (typeof value !== field.type) throw new Error("Runtime request context type mismatch.");
        setAt(field.source === "query" ? queryTemplate : bodyTemplate, field.path, value);
      }
      if (pagination && pagination.strategy !== "next-url" && pageIndex > 0) {
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
          pagination.requestSource === "query",
        );
      }

      const initialUrl = new URL(materializeRequestPath(plan.request.endpointPath,plan.request.pathBindings,input), plan.request.endpointOrigin ?? plan.origin);
      initialUrl.search = materializeParameters(queryTemplate, input).toString();
      const url = pagination?.strategy === "next-url" && pageIndex > 0
        ? validatedNextPageUrl(nextPageUrl ?? "", initialUrl.href, plan, input)
        : initialUrl;
      if (pagination?.strategy === "next-url") {
        const requestUrlKey = canonicalUrl(url.href);
        if (!requestUrlKey || seenRequestUrls.has(requestUrlKey)) {
          throw new Error("Compiled pagination returned a missing or repeated request URL.");
        }
        seenRequestUrls.add(requestUrlKey);
      }
      let requestData: string | undefined;
      if (plan.request.bodyCodec === "json") {
        requestData = JSON.stringify(materialize(bodyTemplate as TemplateValue, input));
      }
      if (plan.request.bodyCodec === "form") {
        requestData = materializeParameters(bodyTemplate as Record<string, TemplateValue[]>, input, plan.request.bodyUrlFields).toString();
      }
      onStage?.("transport");
      const requestHeaders = { ...plan.request.headers, ...browserHeaders };
      const browserResponse = plan.request.transport === "browser-fetch" ? await (async () => {
        if (!runtimeContext?.browserTransport) throw new Error("An exact browser document is required for browser-network replay.");
        // Chrome supplies these headers from the actual authorized document.
        delete requestHeaders.origin; delete requestHeaders.referer;
        return browserNetworkFetch(context, runtimeContext.browserTransport.page, runtimeContext.browserTransport.document,
          { url: url.href, method: plan.request.method, headers: requestHeaders, body: requestData, maximumBytes: plan.response.maximumBytes,
            nativeReceipt: process.env.CLAPPING_HANDS_EXPERIMENTAL_NATIVE_RECEIPT === "true" });
      })() : undefined;
      const response = browserResponse ? {
        status: () => browserResponse.status, ok: () => browserResponse.ok,
        headers: (): Record<string, string> => ({ ...browserResponse.headers, "content-type": browserResponse.contentType }),
        body: async () => browserResponse.bytes,
      } : await context.request.fetch(url.href, {
        method: plan.request.method,
        headers: requestHeaders,
        data: requestData,
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: 30_000,
      });
      // Only the transport client owns a disposable handle. A browser receipt is
      // plain in-process data whose page/document lifetime is managed elsewhere.
      if (!browserResponse) openResponse = response as { dispose: () => Promise<void> };
      onStage?.("http-validation");
      status = response.status();
      if (status === 401 || status === 403) throw new WorkflowAccessError(status === 401 ? "http-401" : "http-403", plan.origin);
      if (status >= 300 && status < 400) throw new Error("Compiled JSON request refused an unvalidated redirect.");
      if (!response.ok()) throw new Error(`Compiled JSON request returned HTTP ${status}.`);
      const contentType = response.headers()["content-type"] ?? "";
      if (plan.response.codec !== "html-input-values" && plan.response.codec!=='html-document' && !/(?:json|graphql|javascript)/i.test(contentType)) {
        throw new Error(`Compiled JSON response returned an unexpected content type: ${contentType || "missing"}.`);
      }
      onStage?.("response-body");
      const responseBody = await response.body();
      totalBytes += responseBody.byteLength;
      if (totalBytes > plan.response.maximumBytes) {
        throw new Error("Compiled JSON pagination exceeded its aggregate response size limit.");
      }
      onStage?.("response-decoding");
      let parsed: unknown;
      try { parsed = decodeGenericResponseBytes(plan.response, responseBody, contentType); }
      catch (error) {
        if (error instanceof HtmlResponseError && error.reason === "login-form") throw new WorkflowAccessError("login-form", plan.origin);
        if (error instanceof HtmlResponseError && error.reason === "checkpoint") throw new WorkflowAccessError("checkpoint", plan.origin);
        throw error;
      }
      onStage?.("response-validation");
      if (plan.response.codec === "json-lines" && (parsed as unknown[]).length !== plan.response.records) throw new Error("Compiled response frame count changed.");
      if (!matchesJsonShape(parsed, plan.response.shape)) {
        throw new Error("Compiled JSON response failed its structural contract.");
      }
      pages.push(parsed);
      if (!pagination) break;

      if (pagination.strategy === "next-url") {
        const nextUrl = pagination.responseNextUrlPath !== undefined
          ? valueAt(parsed, pagination.responseNextUrlPath)
          : nextUrlFromLinkHeader(response.headers().link);
        if (terminalNextValue(nextUrl)) {
          return {
            data: pages,
            status,
            durationMs: performance.now() - startedAt,
            requests: pages.length,
            navigations: 0,
            complete: true,
          };
        }
        if (typeof nextUrl !== "string") {
          throw new Error("Compiled pagination returned an invalid next-page URL.");
        }
        nextPageUrl = nextUrl;
        continue;
      }

      if (pagination.strategy === "increment") {
        if (pagination.termination.type === "total-pages-header") {
          const totalPages = finiteInteger(response.headers()[pagination.termination.header]);
          if (totalPages === null || totalPages < 1 || totalPages > pagination.maximumPages) {
            throw new Error("Compiled pagination returned an invalid total-pages header.");
          }
          totalPagesFromHeader ??= totalPages;
          if (totalPagesFromHeader !== totalPages) {
            throw new Error("Compiled pagination total-pages header changed during replay.");
          }
          if (pages.length >= totalPages) {
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
  } finally {
    await releaseResponse();
  }
}

export function recordGenericJsonShadow(
  plan: GenericJsonPlan,
  input: NetworkInput,
  matches: boolean,
): GenericJsonPlan {
  assertGenericJsonPlanSafety(plan);
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(Object.keys(plan.request.bindings).sort()) ||
    Object.values(input).some((value) => !["string", "number", "boolean"].includes(typeof value) ||
      typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("Shadow input does not match the compiled network input contract.");
  }
  const updated = structuredClone(plan);
  const inputHash = updated.evidence.inputHashVersion === "sorted-flat-v1" ? inputEvidenceHash(input) : hash(input);
  if (matches) {
    updated.evidence.successfulShadowCount = (updated.evidence.successfulShadowCount ??
      updated.evidence.successfulShadowInputHashes.length) + 1;
    if (!updated.evidence.successfulShadowInputHashes.includes(inputHash)) {
      updated.evidence.successfulShadowInputHashes.push(inputHash);
    }
    updated.evidence.lastValidatedAt = new Date().toISOString();
    // Historical counts include training/repeated inputs; only distinct held-out
    // values qualify. A previously failed plan must be relearned, not revived.
    if (updated.status !== "degraded") updated.status = hasHeldOutGenericJsonEvidence(updated) ? "stable" : "provisional";
  } else {
    updated.evidence.failedShadowCount += 1;
    updated.status = "degraded";
  }
  return updated;
}
