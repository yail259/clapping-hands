import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { assertProjectionSource, assertResponseValue, projectContractValue, responseSchemaSchema,
  responseValueSchema, valueProjectionSchema, ResponseContractError, RESPONSE_CONTRACT_LIMITS,
  type ResponseSchema, type ValueProjection, type ValueTransform } from "../src/response-contract.js";

const at = (path: Array<string | number>, transform?: ValueTransform | null): ValueProjection => ({ kind: "value", path, ...(transform === undefined ? {} : { transform }) });
const number = (options: Partial<Extract<ValueTransform, { kind: "number" }>> = {}): Extract<ValueTransform, { kind: "number" }> => ({
  kind: "number", decimalSeparator: ".", groupSeparator: null, prefix: "", suffix: "", scale: 1, ...options,
});
const typed: ResponseSchema = { type: "object", additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, description: "Visible item label" },
    price: { type: "number", minimum: -10_000, maximum: 10_000 },
    available: { type: "boolean" }, owner: { type: ["string", "null"] },
  }, required: ["title", "price", "available", "owner"] };
const output: ResponseSchema = { type: "object", additionalProperties: false, required: ["items", "total"],
  properties: { items: { type: "array", items: typed, maxItems: 5 }, total: { type: "integer", minimum: 0 } } };

test("caller schema supports exact nested typed JSON, null and optional properties", () => {
  assert.deepEqual(responseSchemaSchema.parse(output), output);
  const value = { items: [{ title: "Oak bench", price: 1234.5, available: false, owner: null }], total: 1 };
  assert.deepEqual(assertResponseValue(output, value), value);
  assert.notEqual(assertResponseValue(output, value), value, "Return detached parsed JSON, not caller aliases");
  const optional: ResponseSchema = { type: "object", properties: { note: { type: "string" } }, additionalProperties: false };
  assert.deepEqual(assertResponseValue(optional, {}), {});
  assert.throws(() => assertResponseValue(optional, { note: undefined }));
  assert.equal(responseValueSchema(optional).safeParse({ note: undefined }).success, false);
});

test("schema validation never coerces scalar types or silently strips unknown fields", () => {
  for (const [schema, values] of [
    [{ type: "number" }, ["12", true, null, NaN, Infinity]],
    [{ type: "integer" }, [1.5, "1", Number.MAX_SAFE_INTEGER + 1]],
    [{ type: "boolean" }, ["true", "false", 0, 1, null]],
    [{ type: "string" }, [false, 12, null]],
    [{ type: "null" }, ["null", undefined, false]],
  ] as Array<[ResponseSchema, unknown[]]>) for (const value of values) assert.throws(() => assertResponseValue(schema, value));
  assert.throws(() => assertResponseValue(typed, { title: "Bench", price: 12, available: true, owner: null, extra: "no" }));
  assert.throws(() => assertResponseValue(typed, { title: "Bench", price: 12, available: true }));
  assert.deepEqual(assertResponseValue({ type: ["null", "array"], items: { type: "boolean" } }, [true, false]), [true, false]);
  assert.equal(assertResponseValue({ type: ["null", "array"], items: { type: "boolean" } }, null), null);
});

test("scalar enums and numeric, string, array bounds remain caller-controlled", () => {
  assert.equal(assertResponseValue({ type: "string", enum: ["open", "closed"] }, "open"), "open");
  assert.throws(() => assertResponseValue({ type: "string", enum: ["open", "closed"] }, "OPEN"));
  assert.equal(assertResponseValue({ type: ["integer", "null"], enum: [1, null] }, null), null);
  assert.throws(() => assertResponseValue({ type: "number", minimum: 0, maximum: 10 }, 10.1));
  assert.throws(() => assertResponseValue({ type: "array", items: { type: "number" }, minItems: 1, maxItems: 2 }, []));
  assert.throws(() => assertResponseValue({ type: "array", items: { type: "number" }, maxItems: 2 }, [1, 2, 3]));
  assert.equal(assertResponseValue({ type: "string", minLength: 1, maxLength: 1 }, "👏"), "👏", "JSON Schema counts Unicode code points");
  assert.throws(() => assertResponseValue({ type: "string", minLength: 2 }, "👏"));
  assert.equal(assertResponseValue({ type: "string" }, ""), "", "Empty strings are not globally reinterpreted as null/missing");
  assert.throws(() => assertResponseValue({ type: "string", minLength: 1 }, ""));
});

test("tool JSON Schema advertises caller enums and exact string/numeric/array bounds", () => {
  const schema: ResponseSchema = { type: "object", additionalProperties: false, required: ["label", "state", "count", "values"], properties: {
    label: { type: "string", minLength: 1, maxLength: 2 },
    state: { type: ["string", "null"], enum: ["open", "closed", null], maxLength: 8 },
    count: { type: "number", enum: [1, 2, 3], minimum: 2, maximum: 3 },
    values: { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 2 },
  } };
  const advertised = z.toJSONSchema(responseValueSchema(schema)) as { properties: Record<string, Record<string, unknown>> };
  assert.equal(advertised.properties.label!.minLength, 1); assert.equal(advertised.properties.label!.maxLength, 2);
  assert.deepEqual(advertised.properties.state!.enum, ["open", "closed", null]);
  assert.equal(advertised.properties.state!.maxLength, 8);
  assert.deepEqual(advertised.properties.count!.enum, [1, 2, 3]);
  assert.equal(advertised.properties.count!.minimum, 2); assert.equal(advertised.properties.count!.maximum, 3);
  assert.equal(advertised.properties.values!.minItems, 1); assert.equal(advertised.properties.values!.maxItems, 2);
  assert.throws(() => assertResponseValue(schema, { label: "ok", state: "open", count: 1, values: [true] }));
});

test("unsupported, conflicting and incomplete JSON Schemas fail closed", () => {
  for (const schema of [
    {}, true, { type: "date" }, { type: ["string", "number"] }, { type: ["null", "null"] },
    { type: ["string", "number", "null"] }, { type: "string", format: "email" },
    { type: "string", pattern: ".*" }, { type: "string", default: "invented" },
    { type: "string", $ref: "https://private.invalid/schema" }, { type: "string", anyOf: [] },
    { type: "string", minimum: 0 }, { type: "number", minLength: 0 },
    { type: "string", minLength: -1 }, { type: "string", minLength: 5, maxLength: 4 },
    { type: "string", maxLength: RESPONSE_CONTRACT_LIMITS.string + 1 },
    { type: "number", minimum: 5, maximum: 4 }, { type: "number", maximum: Infinity },
    { type: "array" }, { type: "array", items: { type: "string" }, maxItems: 1001 },
    { type: "object", properties: {} }, { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: {}, additionalProperties: false, required: ["missing"] },
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: false, required: ["a", "a"] },
    { type: "boolean", enum: [] }, { type: "number", enum: [1, "1"] },
    { type: "string", enum: ["a", "a"] }, { type: "object", properties: {}, additionalProperties: false, enum: [{}] },
  ]) assert.equal(responseSchemaSchema.safeParse(schema).success, false);
});

test("schema depth, node, property and encoded-size limits are enforced before recursion", () => {
  let deep: unknown = { type: "string" };
  for (let index = 0; index < 20; index++) deep = { type: "array", items: deep };
  assert.equal(responseSchemaSchema.safeParse(deep).success, false);
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => ["field" + index, { type: "string" }]));
  assert.equal(responseSchemaSchema.safeParse({ type: "object", properties: many, additionalProperties: false }).success, false);
  const wide = Object.fromEntries(Array.from({ length: 50 }, (_, index) => ["field" + index,
    { type: "string", description: "é".repeat(1000) }]));
  assert.equal(responseSchemaSchema.safeParse({ type: "object", properties: wide, additionalProperties: false }).success, false);
  const cyclic: Record<string, unknown> = { type: "array" }; cyclic.items = cyclic;
  assert.equal(responseSchemaSchema.safeParse(cyclic).success, false);
});

test("one generic AST projects raw browser rows and an independent network tree", () => {
  const browserPlan: ValueProjection = { kind: "object", fields: {
    items: { kind: "array", path: ["rows"], item: { kind: "object", fields: {
      title: at(["label"], { kind: "collapse-ascii-whitespace" }),
      price: at(["amount"], number({ decimalSeparator: ",", groupSeparator: ".", suffix: " €" })),
      available: at(["state"], { kind: "boolean", trueValues: ["in stock"], falseValues: ["sold"] }),
      owner: { kind: "literal", value: null },
    } } }, total: at(["count"], number()),
  } };
  const expected = { items: [{ title: "Oak bench", price: -1234.5, available: false, owner: null }], total: 1 };
  assert.deepEqual(projectContractValue({ rows: [{ label: "  Oak\tbench\n", amount: "-1.234,50 €", state: "sold" }], count: "1" }, browserPlan, output), expected);
  const networkPlan: ValueProjection = { kind: "object", fields: {
    items: { kind: "array", path: ["payload", "records"], item: { kind: "object", fields: {
      title: at(["title"]), price: at(["price"]), available: at(["available"]), owner: at(["owner"]),
    } } }, total: at(["payload", "total"]),
  } };
  assert.deepEqual(projectContractValue({ payload: { records: expected.items, total: 1 } }, networkPlan, output), expected);
});

test("paths remain relative to each array item, with numeric indexes and nested arrays", () => {
  const plan: ValueProjection = { kind: "array", path: ["groups"], item: { kind: "array", path: ["values"], item: at([]) } };
  const schema: ResponseSchema = { type: "array", items: { type: "array", items: { type: ["number", "null"] } } };
  assert.deepEqual(projectContractValue({ groups: [{ values: [1, null] }, { values: [2] }] }, plan, schema), [[1, null], [2]]);
  assert.equal(projectContractValue({ values: [false, true] }, at(["values", 1]), { type: "boolean" }), true);
  assert.throws(() => projectContractValue({ values: [false, true] }, at(["values", "1"]), { type: "boolean" }));
});

test("number transforms explicitly parse locale, exact affixes, sign and scale", () => {
  for (const [source, transform, expected] of [
    ["$1,234.50", number({ prefix: "$", groupSeparator: "," }), 1234.5],
    ["-$1,234.50", number({ prefix: "$", groupSeparator: "," }), -1234.5],
    ["$-1,234.50", number({ prefix: "$", groupSeparator: "," }), -1234.5],
    ["-1.234,50 €", number({ decimalSeparator: ",", groupSeparator: ".", suffix: " €" }), -1234.5],
    ["1\u00a0234,5", number({ decimalSeparator: ",", groupSeparator: "\u00a0" }), 1234.5],
    ["1 234.5", number({ groupSeparator: " " }), 1234.5],
    ["12.34", number({ scale: 100 }), 1234], ["3", number({ scale: 0.1 }), 0.3],
    ["-0.00", number(), 0],
  ] as Array<[string, ValueTransform, number]>) assert.equal(projectContractValue(source, at([], transform), { type: "number" }), expected);
  assert.equal(projectContractValue(12.34, at([]), { type: "number" }), 12.34);
  assert.throws(() => projectContractValue("12.34", at([]), { type: "number" }), "No implicit string-to-number conversion");
});

test("strict numbers refuse grouping guesses, coercion and precision loss", () => {
  for (const source of ["", " 1", "1 ", "+1", "01", "1e3", "0x10", "1.", ".1", "1,23", "12,34,567", "1,234,56", "1_000",
    "NaN", "Infinity", "(1)", "--1", "9007199254740992", "0.1234567890123", "99999999999999.99", 1, true, null]) {
    assert.throws(() => projectContractValue(source, at([], number({ groupSeparator: "," })), { type: "number" }));
  }
  assert.throws(() => projectContractValue("-$-1", at([], number({ prefix: "$" })), { type: "number" }));
  assert.throws(() => projectContractValue("€1", at([], number({ prefix: "$" })), { type: "number" }));
  assert.throws(() => projectContractValue("1 USD", at([], number({ suffix: " EUR" })), { type: "number" }));
  for (const scale of [0, NaN, Infinity, 1e13, 1e-13]) assert.equal(valueProjectionSchema.safeParse(at([], number({ scale }))).success, false);
});

test("boolean transforms use disjoint exact typed source lists without truthiness", () => {
  const transform: ValueTransform = { kind: "boolean", trueValues: ["yes", 1, true], falseValues: ["no", 0, false, null] };
  for (const source of ["yes", 1, true]) assert.equal(projectContractValue(source, at([], transform), { type: "boolean" }), true);
  for (const source of ["no", 0, false, null]) assert.equal(projectContractValue(source, at([], transform), { type: "boolean" }), false);
  for (const source of ["YES", "true", "1", "", [], {}]) assert.throws(() => projectContractValue(source, at([], transform), { type: "boolean" }));
  for (const bad of [{ kind: "boolean", trueValues: [1], falseValues: [1] },
    { kind: "boolean", trueValues: [], falseValues: [false] }, { kind: "boolean", trueValues: [1, 1], falseValues: [0] }]) {
    assert.equal(valueProjectionSchema.safeParse({ kind: "value", path: [], transform: bad }).success, false);
  }
});

test("text is opt-in, ASCII-only and cannot rescue empty/oversized source values", () => {
  const source = " \tMixed\n CASE\u00a0e\u0301 ";
  for (const transform of [undefined, null, { kind: "identity" } as const]) {
    assert.equal(projectContractValue(source, at([], transform), { type: "string" }), source);
  }
  assert.equal(projectContractValue(source, at([], { kind: "collapse-ascii-whitespace" }), { type: "string" }), "Mixed CASE\u00a0e\u0301");
  for (const value of ["", " \t\n", " ".repeat(16_000) + "x", 12, null]) {
    assert.throws(() => projectContractValue(value, at([], { kind: "collapse-ascii-whitespace" }), { type: "string" }));
  }
  assert.equal(projectContractValue({}, { kind: "literal", value: "" }, { type: "string" }), "");
  assert.throws(() => projectContractValue({}, { kind: "literal", value: null }, { type: "string" }));
  assert.equal(projectContractValue({}, { kind: "literal", value: null }, { type: ["string", "null"] }), null);
});

test("URL conversion has explicit stripping and rejects credentials or unsafe protocols", () => {
  const source = "https://example.invalid/item?q=one#two";
  assert.equal(projectContractValue(source, at([], { kind: "url", stripQuery: false, stripFragment: false }), { type: "string" }), source);
  assert.equal(projectContractValue(source, at([], { kind: "url", stripQuery: true, stripFragment: true }), { type: "string" }), "https://example.invalid/item");
  assert.equal(projectContractValue(source, at([], { kind: "url", stripQuery: false, stripFragment: true }), { type: "string" }), "https://example.invalid/item?q=one");
  for (const bad of ["/relative", "javascript:alert(1)", "file:///private", "https://person:private-fixture@example.invalid", " https://example.invalid", "https://example.invalid/\npath"]) {
    assert.throws(() => projectContractValue(bad, at([], { kind: "url", stripQuery: true, stripFragment: true }), { type: "string" }));
  }
  assert.equal(valueProjectionSchema.safeParse(at([], { kind: "url" } as ValueTransform)).success, false);
});

test("missing/null paths and malformed trees never become defaults or partial arrays", () => {
  for (const source of [{}, { nested: null }, { nested: [] }, { nested: {} }]) {
    assert.throws(() => projectContractValue(source, at(["nested", "value"]), { type: ["string", "null"] }));
  }
  const plan: ValueProjection = { kind: "array", path: ["rows"], item: at(["amount"], number()) };
  assert.throws(() => projectContractValue({ rows: [{ amount: "1" }, {}] }, plan, { type: "array", items: { type: "number" } }));
  assert.throws(() => projectContractValue({ rows: "not-an-array" }, plan, { type: "array", items: { type: "number" } }));
  assert.deepEqual(projectContractValue({ rows: [] }, plan, { type: "array", items: { type: "number" } }), []);
});

test("schema, projection and source reject prototype keys/accessors without invoking getters", () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { invoked++; throw new Error("private-fixture"); } });
  const toJSON = { toJSON() { invoked++; throw new Error("private-fixture"); } };
  for (const value of [accessor, toJSON, new Date(), new String("private-fixture"), Object.create({ value: "inherited" }),
    JSON.parse('{"__proto__":{"value":"private-fixture"}}'), { constructor: "private-fixture" }, { prototype: "private-fixture" }]) {
    assert.throws(() => assertProjectionSource(value));
    assert.throws(() => projectContractValue(value, at(["value"]), { type: "string" }));
  }
  assert.equal(invoked, 0);
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.equal(valueProjectionSchema.safeParse(at([key])).success, false);
    assert.equal(responseSchemaSchema.safeParse({ type: "object", properties: { [key]: { type: "string" } }, additionalProperties: false }).success, false);
    assert.equal(valueProjectionSchema.safeParse({ kind: "object", fields: { [key]: { kind: "literal", value: null } } }).success, false);
  }
  assert.equal(valueProjectionSchema.safeParse({ kind: "value", path: [], transform: accessor }).success, false);
  assert.equal(responseSchemaSchema.safeParse(accessor).success, false);
  assert.equal(invoked, 0);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private-fixture"); } });
  assert.throws(() => assertProjectionSource(hostile), ResponseContractError);
  assert.equal(responseSchemaSchema.safeParse(hostile).success, false);
});

test("all parsers reject arbitrary AST code, conflicting keywords, cycles and deep projections", () => {
  for (const bad of [{ kind: "eval", code: "private-fixture" }, { kind: "literal", value: {} },
    { kind: "value", path: [], transform: { kind: "trim" } }, { kind: "value", path: [], fallback: null },
    { kind: "value", path: ["rows", -1] }, { kind: "value", path: [1.5] }, { kind: "value", path: Array(21).fill("next") },
    { kind: "object", fields: [] }, { kind: "array", path: [] },
    at([], number({ decimalSeparator: ",", groupSeparator: "," }))]) assert.equal(valueProjectionSchema.safeParse(bad).success, false);
  let deep: ValueProjection = at([]);
  for (let index = 0; index < 20; index++) deep = { kind: "array", path: [], item: deep };
  assert.equal(valueProjectionSchema.safeParse(deep).success, false);
  const cycle: Record<string, unknown> = { kind: "array", path: [] }; cycle.item = cycle;
  assert.equal(valueProjectionSchema.safeParse(cycle).success, false);
});

test("aggregate output/source caps, sparse arrays and cyclic data are not bypassed by identity", () => {
  const schema: ResponseSchema = { type: "array", items: { type: "string" } };
  for (const value of [Array(2), Array(1001).fill("small"), Array(100).fill("x".repeat(16_000)), ["x".repeat(16_001)]]) {
    assert.throws(() => assertResponseValue(schema, value));
    assert.throws(() => projectContractValue(value, at([]), schema));
  }
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  assert.throws(() => assertProjectionSource(cyclic));
  let deep: unknown = null;
  for (let index = 0; index < 40; index++) deep = { next: deep };
  assert.throws(() => assertProjectionSource(deep));
  assert.throws(() => assertProjectionSource(Array(10_001).fill(null)));
});

test("public core failures never echo raw source, schema properties or parser payloads", () => {
  const privateValue = "PRIVATE_FIXTURE_DO_NOT_DISCLOSE";
  const errors: unknown[] = [];
  for (const operation of [
    () => projectContractValue(privateValue, at([], number()), { type: "number" }),
    () => assertResponseValue({ type: "number" }, privateValue),
    () => responseValueSchema({ type: "string", [privateValue]: true } as ResponseSchema),
    () => projectContractValue({}, { kind: privateValue } as unknown as ValueProjection, { type: "number" }),
  ]) { try { operation(); assert.fail("Expected a fixed error"); } catch (error) { assert.ok(error instanceof ResponseContractError); errors.push({ message: error.message, code: error.code }); } }
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_FIXTURE/);
  const result = responseSchemaSchema.safeParse({ type: "string", [privateValue]: true });
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE/);
});
