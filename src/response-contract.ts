import { z } from "zod";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type ResponseType = "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";
type NonNullType = Exclude<ResponseType, "null">;

/** Deliberately small JSON Schema subset. Unknown/inapplicable keywords fail. */
export type ResponseSchema = {
  type: ResponseType | [NonNullType, "null"] | ["null", NonNullType];
  description?: string;
  enum?: JsonScalar[];
  properties?: Record<string, ResponseSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ResponseSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type ValueTransform =
  | { kind: "identity" }
  | { kind: "collapse-ascii-whitespace" }
  | { kind: "number"; decimalSeparator: "." | ","; groupSeparator: null | "." | "," | " " | "\u00a0";
      prefix: string; suffix: string; scale: number }
  | { kind: "boolean"; trueValues: JsonScalar[]; falseValues: JsonScalar[] }
  | { kind: "url"; stripQuery: boolean; stripFragment: boolean };
export type ValueProjection =
  | { kind: "value"; path: Array<string | number>; transform?: ValueTransform | null }
  | { kind: "object"; fields: Record<string, ValueProjection> }
  | { kind: "array"; path: Array<string | number>; item: ValueProjection }
  | { kind: "literal"; value: JsonScalar };

export const RESPONSE_CONTRACT_LIMITS = Object.freeze({
  schemaDepth: 12, schemaNodes: 256, schemaBytes: 65_536, properties: 50, path: 20,
  string: 16_000, arrayItems: 1_000, valueDepth: 32, valueNodes: 10_000, valueBytes: 1_048_576,
  sourceNodes: 50_000, sourceBytes: 8_388_608, sourceArrayItems: 10_000,
});

export class ResponseContractError extends Error {
  constructor(readonly code: "INVALID_RESPONSE_SCHEMA" | "INVALID_RESPONSE_VALUE" | "INVALID_VALUE_PROJECTION" | "VALUE_PROJECTION_FAILED") {
    super({ INVALID_RESPONSE_SCHEMA: "The response schema is unsupported or exceeds its limits.",
      INVALID_RESPONSE_VALUE: "The response does not satisfy the strict output contract.",
      INVALID_VALUE_PROJECTION: "The value projection is unsupported or exceeds its limits.",
      VALUE_PROJECTION_FAILED: "The value projection could not produce a valid response." }[code]);
  }
}

const L = RESPONSE_CONTRACT_LIMITS;
const TYPES = new Set<ResponseType>(["string", "number", "integer", "boolean", "null", "object", "array"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();
type JsonLimits = { depth: number; nodes: number; bytes: number; string: number; array: number };
const VALUE_LIMITS: JsonLimits = { depth: L.valueDepth, nodes: L.valueNodes, bytes: L.valueBytes, string: L.string, array: L.arrayItems };
const SOURCE_LIMITS: JsonLimits = { depth: L.valueDepth, nodes: L.sourceNodes, bytes: L.sourceBytes, string: L.sourceBytes, array: L.sourceArrayItems };
const META_LIMITS: JsonLimits = { depth: 40, nodes: 10_000, bytes: L.schemaBytes, string: L.string, array: 1_000 };

function fail(): never { throw new Error("Invalid contract data."); }
function safeKey(key: string): boolean {
  return key.length > 0 && key.length <= 120 && !FORBIDDEN_KEYS.has(key) && !/[\u0000-\u001f\u007f]/u.test(key);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function scalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value);
}

/** Clone data properties only. No getters, toJSON, inherited paths, cycles or
 * non-JSON objects. Limits are acceptance bounds, not a process-allocation cap. */
function boundedJson(value: unknown, limits: JsonLimits): JsonValue {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => { bytes += amount; if (bytes > limits.bytes) fail(); };
  const string = (text: string) => {
    if (text.length > limits.string) fail();
    charge(encoder.encode(JSON.stringify(text)).byteLength);
  };
  const visit = (current: unknown, depth: number): JsonValue => {
    if (++nodes > limits.nodes || depth > limits.depth) fail();
    if (current === null || typeof current === "boolean") { charge(current === null ? 4 : current ? 4 : 5); return current; }
    if (typeof current === "string") { string(current); return current; }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail();
      charge(JSON.stringify(current).length); return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object" || ancestors.has(current)) fail();
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(current);
    if (keys.some((key) => typeof key !== "string") || keys.length > limits.nodes) fail();
    ancestors.add(current); charge(2);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(current, "length");
        if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0
          || length.value > limits.array || keys.length !== length.value + 1) fail();
        const result: JsonValue[] = [];
        for (let index = 0; index < length.value; index++) {
          const property = Object.getOwnPropertyDescriptor(current, String(index));
          if (!property || !("value" in property) || !property.enumerable) fail();
          if (index) charge(1);
          result.push(visit(property.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, JsonValue> = {};
      for (const [index, key] of (keys as string[]).entries()) {
        if (!safeKey(key)) fail();
        const property = Object.getOwnPropertyDescriptor(current, key);
        if (!property || !("value" in property) || !property.enumerable) fail();
        if (index) charge(1);
        string(key); charge(1);
        result[key] = visit(property.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(current); }
  };
  return visit(value, 0);
}

function keysOnly(value: Record<string, unknown>, keys: string[], required: string[] = []): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) fail();
}
function integerLimit(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function schemaType(schema: ResponseSchema): NonNullType | "null" {
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== "null")! : schema.type;
}
function nullable(schema: ResponseSchema): boolean { return Array.isArray(schema.type); }
function matchesType(value: JsonScalar, type: ResponseType): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function parseResponseSchema(input: unknown): ResponseSchema {
  const root = boundedJson(input, META_LIMITS);
  let nodes = 0;
  function visit(value: unknown, depth: number): ResponseSchema {
    if (++nodes > L.schemaNodes || depth > L.schemaDepth || !record(value)) fail();
    const declared = value.type;
    let type: ResponseType;
    if (typeof declared === "string" && TYPES.has(declared as ResponseType)) type = declared as ResponseType;
    else if (Array.isArray(declared) && declared.length === 2 && declared.includes("null")
      && declared[0] !== declared[1] && declared.every((item) => typeof item === "string" && TYPES.has(item as ResponseType))) {
      type = declared.find((item) => item !== "null") as NonNullType;
    } else fail();
    const keywords = ["type", "description", "enum"];
    if (type === "object") keywords.push("properties", "required", "additionalProperties");
    if (type === "array") keywords.push("items", "minItems", "maxItems");
    if (type === "string") keywords.push("minLength", "maxLength");
    if (type === "number" || type === "integer") keywords.push("minimum", "maximum");
    keysOnly(value, keywords, ["type"]);
    if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1_000)) fail();
    if (Object.hasOwn(value, "enum")) {
      if (type === "object" || type === "array" || !Array.isArray(value.enum) || !value.enum.length || value.enum.length > 50
        || value.enum.some((item) => !scalar(item) || !(matchesType(item, type) || Array.isArray(declared) && item === null))
        || new Set(value.enum.map((item) => JSON.stringify(item))).size !== value.enum.length) fail();
    }
    if (type === "object") {
      if (!record(value.properties) || Object.keys(value.properties).length > L.properties || value.additionalProperties !== false) fail();
      for (const child of Object.values(value.properties)) visit(child, depth + 1);
      if (Object.hasOwn(value, "required") && (!Array.isArray(value.required) || value.required.length > L.properties
        || value.required.some((key) => typeof key !== "string" || !Object.hasOwn(value.properties!, key))
        || new Set(value.required).size !== value.required.length)) fail();
    }
    if (type === "array") visit(value.items, depth + 1);
    for (const [minimum, maximum, limit] of [["minLength", "maxLength", L.string], ["minItems", "maxItems", L.arrayItems]] as const) {
      if (Object.hasOwn(value, minimum) && !integerLimit(value[minimum], limit)
        || Object.hasOwn(value, maximum) && !integerLimit(value[maximum], limit)
        || typeof value[minimum] === "number" && typeof value[maximum] === "number" && value[minimum] > value[maximum]) fail();
    }
    for (const key of ["minimum", "maximum"]) if (Object.hasOwn(value, key) && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) fail();
    if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) fail();
    return value as ResponseSchema;
  }
  return visit(root, 0);
}

function safeParser<T>(parse: (value: unknown) => T, message: string): z.ZodType<T> {
  return z.unknown().transform((value, context) => {
    try { return parse(value); }
    catch { context.addIssue({ code: "custom", message }); return z.NEVER; }
  }) as z.ZodType<T>;
}
export const responseSchemaSchema: z.ZodType<ResponseSchema> = safeParser(parseResponseSchema, "Invalid or unsupported response schema.");

function valueValidator(schema: ResponseSchema): z.ZodType<JsonValue> {
  const type = schemaType(schema);
  let validator: z.ZodType;
  if (type === "string") {
    // Zod's native length check counts UTF-16 units; JSON Schema counts code
    // points. Use a conservative native ceiling and advertise the exact bound.
    validator = z.string().min(schema.minLength ?? 0).max(Math.min(L.string, (schema.maxLength ?? L.string) * 2)).refine((value) => {
      const length = [...value].length;
      return length >= (schema.minLength ?? 0) && length <= (schema.maxLength ?? L.string);
    }, "String length does not match the response contract.").meta({ maxLength: schema.maxLength ?? L.string });
  } else if (type === "number" || type === "integer") {
    let number = type === "integer" ? z.number().int() : z.number();
    if (schema.minimum !== undefined) number = number.min(schema.minimum);
    if (schema.maximum !== undefined) number = number.max(schema.maximum);
    validator = number;
  } else if (type === "boolean") validator = z.boolean();
  else if (type === "null") validator = z.null();
  else if (type === "array") validator = z.array(valueValidator(schema.items!)).min(schema.minItems ?? 0).max(schema.maxItems ?? L.arrayItems);
  else {
    const required = new Set(schema.required ?? []);
    const fields: Record<string, z.ZodType> = {};
    for (const [key, child] of Object.entries(schema.properties!)) {
      const item = valueValidator(child); fields[key] = required.has(key) ? item : item.optional();
    }
    validator = z.object(fields).strict();
  }
  if (nullable(schema)) validator = validator.nullable();
  if (schema.enum) {
    const base = validator;
    validator = z.literal(schema.enum).refine((value) => base.safeParse(value).success, "Enum value does not satisfy its response bounds.")
      .meta({ type: schema.type,
        ...(type === "string" ? { minLength: schema.minLength ?? 0, maxLength: schema.maxLength ?? L.string } : {}),
        ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
        ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
      });
  }
  if (schema.description !== undefined) validator = validator.describe(schema.description);
  return validator as z.ZodType<JsonValue>;
}

/** Native per-type Zod schema for tool boundaries. For arbitrary in-process
 * objects use assertResponseValue, which prechecks JSON safety and total limits. */
export function responseValueSchema(schema: ResponseSchema): z.ZodType<JsonValue> {
  try {
    return valueValidator(parseResponseSchema(schema)).superRefine((value, context) => {
      try { boundedJson(value, VALUE_LIMITS); }
      catch { context.addIssue({ code: "custom", message: "Response JSON exceeds the contract limits." }); }
    });
  }
  catch { throw new ResponseContractError("INVALID_RESPONSE_SCHEMA"); }
}
export function assertResponseValue(schema: ResponseSchema, value: unknown): JsonValue {
  const validator = responseValueSchema(schema);
  try { return validator.parse(boundedJson(value, VALUE_LIMITS)); }
  catch { throw new ResponseContractError("INVALID_RESPONSE_VALUE"); }
}

function validatePath(value: unknown): void {
  if (!Array.isArray(value) || value.length > L.path || value.some((key) =>
    !(typeof key === "string" && safeKey(key)) && !integerLimit(key, L.sourceArrayItems - 1))) fail();
}
function validateTransform(value: unknown): void {
  if (!record(value)) fail();
  if (value.kind === "identity" || value.kind === "collapse-ascii-whitespace") { keysOnly(value, ["kind"], ["kind"]); return; }
  if (value.kind === "number") {
    keysOnly(value, ["kind", "decimalSeparator", "groupSeparator", "prefix", "suffix", "scale"],
      ["kind", "decimalSeparator", "groupSeparator", "prefix", "suffix", "scale"]);
    if (![".", ","].includes(String(value.decimalSeparator))
      || ![null, ".", ",", " ", "\u00a0"].includes(value.groupSeparator as string | null)
      || value.groupSeparator === value.decimalSeparator || typeof value.prefix !== "string" || value.prefix.length > 100
      || typeof value.suffix !== "string" || value.suffix.length > 100 || typeof value.scale !== "number"
      || !Number.isFinite(value.scale) || Math.abs(value.scale) < 1e-12 || Math.abs(value.scale) > 1e12) fail();
    return;
  }
  if (value.kind === "boolean") {
    keysOnly(value, ["kind", "trueValues", "falseValues"], ["kind", "trueValues", "falseValues"]);
    for (const list of [value.trueValues, value.falseValues]) {
      if (!Array.isArray(list) || !list.length || list.length > 20 || list.some((item) => !scalar(item))
        || new Set(list.map((item) => JSON.stringify(item))).size !== list.length) fail();
    }
    if ((value.trueValues as JsonScalar[]).some((item) => (value.falseValues as JsonScalar[]).includes(item))) fail();
    return;
  }
  if (value.kind === "url") {
    keysOnly(value, ["kind", "stripQuery", "stripFragment"], ["kind", "stripQuery", "stripFragment"]);
    if (typeof value.stripQuery !== "boolean" || typeof value.stripFragment !== "boolean") fail();
    return;
  }
  fail();
}
function parseValueProjection(input: unknown): ValueProjection {
  const root = boundedJson(input, META_LIMITS);
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > L.schemaNodes || depth > L.schemaDepth || !record(value)) fail();
    if (value.kind === "value") {
      keysOnly(value, ["kind", "path", "transform"], ["kind", "path"]); validatePath(value.path);
      if (value.transform !== undefined && value.transform !== null) validateTransform(value.transform);
    } else if (value.kind === "array") {
      keysOnly(value, ["kind", "path", "item"], ["kind", "path", "item"]); validatePath(value.path); visit(value.item, depth + 1);
    } else if (value.kind === "object") {
      keysOnly(value, ["kind", "fields"], ["kind", "fields"]);
      if (!record(value.fields) || Object.keys(value.fields).length > L.properties) fail();
      for (const child of Object.values(value.fields)) visit(child, depth + 1);
    } else if (value.kind === "literal") {
      keysOnly(value, ["kind", "value"], ["kind", "value"]);
      if (!scalar(value.value)) fail();
    } else fail();
  }
  visit(root, 0); return root as ValueProjection;
}
export const valueProjectionSchema: z.ZodType<ValueProjection> = safeParser(parseValueProjection, "Invalid or unsupported value projection.");

/** A detached, bounded JSON source for compilation evidence or projection. */
export function assertProjectionSource(source: unknown): JsonValue {
  try { return boundedJson(source, SOURCE_LIMITS); }
  catch { throw new ResponseContractError("VALUE_PROJECTION_FAILED"); }
}
function sourceAt(source: JsonValue, path: Array<string | number>): JsonValue {
  let current = source;
  for (const key of path) {
    if (Array.isArray(current)) {
      if (typeof key !== "number" || key >= current.length) fail();
      current = current[key]!;
    } else {
      if (current === null || typeof current !== "object" || typeof key !== "string" || !Object.hasOwn(current, key)) fail();
      current = current[key]!;
    }
  }
  return current;
}
function decimalParts(value: string): { coefficient: bigint; exponent: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) fail();
  let coefficient = BigInt(match[1]! + match[2]! + (match[3] ?? ""));
  let exponent = Number(match[4] ?? "0") - (match[3]?.length ?? 0);
  while (coefficient !== 0n && coefficient % 10n === 0n) { coefficient /= 10n; exponent++; }
  if (!coefficient) exponent = 0;
  return { coefficient, exponent };
}
function numericValue(source: JsonValue, transform: Extract<ValueTransform, { kind: "number" }>): number {
  if (typeof source !== "string" || !source || source.length > L.string) fail();
  let body = source, negative = false;
  // One '-' may precede the exact prefix OR follow it. Parentheses, '+' and
  // arbitrary locale guessing are deliberately unsupported.
  if (body.startsWith("-") && !transform.prefix.startsWith("-")) { negative = true; body = body.slice(1); }
  if (!body.startsWith(transform.prefix) || !body.endsWith(transform.suffix)
    || body.length < transform.prefix.length + transform.suffix.length) fail();
  body = body.slice(transform.prefix.length, transform.suffix.length ? -transform.suffix.length : undefined);
  if (body.startsWith("-")) { if (negative) fail(); negative = true; body = body.slice(1); }
  const parts = body.split(transform.decimalSeparator);
  if (parts.length > 2 || !parts[0] || parts.length === 2 && !/^\d{1,12}$/.test(parts[1]!)) fail();
  let whole = parts[0];
  if (transform.groupSeparator && whole.includes(transform.groupSeparator)) {
    const groups = whole.split(transform.groupSeparator);
    if (!/^[1-9]\d{0,2}$/.test(groups[0]!) || groups.slice(1).some((group) => !/^\d{3}$/.test(group))) fail();
    whole = groups.join("");
  }
  if (!/^(?:0|[1-9]\d{0,29})$/.test(whole)) fail();
  const input = decimalParts((negative ? "-" : "") + whole + (parts[1] === undefined ? "" : "." + parts[1]));
  const scale = decimalParts(String(transform.scale));
  const expected = decimalParts(String(input.coefficient * scale.coefficient) + "e" + String(input.exponent + scale.exponent));
  const result = Number(String(expected.coefficient) + "e" + String(expected.exponent));
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) fail();
  const actual = decimalParts(String(result));
  if (actual.coefficient !== expected.coefficient || actual.exponent !== expected.exponent) fail();
  return Object.is(result, -0) ? 0 : result;
}
function transformedValue(source: JsonValue, transform?: ValueTransform | null): JsonValue {
  if (!transform || transform.kind === "identity") return source;
  if (transform.kind === "number") return numericValue(source, transform);
  if (transform.kind === "boolean") {
    if (!scalar(source)) fail();
    if (transform.trueValues.includes(source)) return true;
    if (transform.falseValues.includes(source)) return false;
    fail();
  }
  if (typeof source !== "string" || source.length > L.string) fail();
  if (transform.kind === "collapse-ascii-whitespace") {
    const result = source.replace(/[ \t\n\f\r]+/g, " ").replace(/^ | $/g, "");
    if (!result) fail(); return result;
  }
  if (!source || /[\u0000-\u0020\u007f]/u.test(source)) fail();
  const url = new URL(source);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) fail();
  if (transform.stripQuery) url.search = "";
  if (transform.stripFragment) url.hash = "";
  return url.href;
}

/** Execute an already-evidenced plan. This core does not infer that literals,
 * affixes, scaling, labels or URL stripping are semantically justified. */
export function projectContractValue(source: unknown, projection: ValueProjection, schema: ResponseSchema): JsonValue {
  const validator = responseValueSchema(schema);
  let plan: ValueProjection;
  try { plan = parseValueProjection(projection); }
  catch { throw new ResponseContractError("INVALID_VALUE_PROJECTION"); }
  try {
    const input = assertProjectionSource(source);
    let nodes = 0;
    function project(current: JsonValue, node: ValueProjection, depth: number): JsonValue {
      if (++nodes > L.valueNodes || depth > L.valueDepth) fail();
      if (node.kind === "literal") return node.value;
      if (node.kind === "value") return transformedValue(sourceAt(current, node.path), node.transform);
      if (node.kind === "array") {
        const array = sourceAt(current, node.path);
        if (!Array.isArray(array) || array.length > L.arrayItems) fail();
        return array.map((item) => project(item, node.item, depth + 1));
      }
      return Object.fromEntries(Object.entries(node.fields).map(([key, child]) => [key, project(current, child, depth + 1)]));
    }
    return validator.parse(boundedJson(project(input, plan, 0), VALUE_LIMITS));
  } catch { throw new ResponseContractError("VALUE_PROJECTION_FAILED"); }
}
