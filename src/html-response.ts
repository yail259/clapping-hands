import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type HtmlResponseEncoding = "utf-8" | "windows-1252";
export type HtmlValueResponseRecipe = {
  kind: "server-html-input-values-v1";
  encoding: HtmlResponseEncoding;
  region: string;
  item: string;
  fields: Array<{ name: string; selector: string }>;
};
export type HtmlResponseFailure = "invalid-recipe" | "content-type" | "encoding" | "encoding-conflict"
  | "response-too-large" | "invalid-document" | "unsafe-control" | "field-cardinality" | "login-form" | "checkpoint";

/** Only fixed categories leave this module; never attach HTML, attributes or parser errors. */
export class HtmlResponseError extends Error {
  readonly code = "HTML_RESPONSE_REFUSED";
  constructor(readonly reason: HtmlResponseFailure) {
    super(`Server HTML response refused (${reason}).`);
    this.name = "HtmlResponseError";
  }
}
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 100;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
function fail(reason: HtmlResponseFailure): never { throw new HtmlResponseError(reason); }

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key]; return descriptor?.enumerable && "value" in descriptor;
  });
}

function simpleCompoundLength(value: string): number {
  let rest = value;
  const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
  if (tag) rest = rest.slice(tag[0].length);
  let parts = tag ? 1 : 0;
  for (;;) {
    const part = /^(?:[.#][A-Za-z_][A-Za-z0-9_-]{0,127}|\[(?:name|id|type|role)=(?:'[A-Za-z_][A-Za-z0-9_-]{0,127}'|"[A-Za-z_][A-Za-z0-9_-]{0,127}")\])/.exec(rest);
    if (!part) break;
    if (++parts > 8) return 0;
    rest = rest.slice(part[0].length);
  }
  return parts ? value.length - rest.length : 0;
}

/** Only one :has(single simple compound) per outer compound. No nested/list/
 * relative selectors, other pseudos, escapes or arbitrary attribute values. */
function safeSelector(value: unknown, empty = false): value is string {
  if (typeof value !== "string" || value.length > 500 || value !== value.trim()) return false;
  if (empty && value === "") return true;
  let rest = value;
  let compounds = 0;
  while (rest) {
    if (++compounds > 8) return false;
    const compoundLength = simpleCompoundLength(rest);
    if (!compoundLength) return false;
    rest = rest.slice(compoundLength);
    if (rest.startsWith(":has(")) {
      const end = rest.indexOf(")", 5);
      if (end === -1) return false;
      const inner = rest.slice(5, end).trim();
      if (!inner || simpleCompoundLength(inner) !== inner.length) return false;
      rest = rest.slice(end + 1);
    }
    if (!rest) return true;
    const separator = /^(?:\s*>\s*|\s+)/.exec(rest);
    if (!separator) return false;
    rest = rest.slice(separator[0].length);
    if (!rest) return false;
  }
  return false;
}

export function assertHtmlValueResponseRecipe(value: unknown): asserts value is HtmlValueResponseRecipe {
  try {
    if (!record(value, ["kind", "encoding", "region", "item", "fields"]) || value.kind !== "server-html-input-values-v1" ||
      !["utf-8", "windows-1252"].includes(value.encoding as string) || !safeSelector(value.region) || !safeSelector(value.item) ||
      !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 12) fail("invalid-recipe");
    const names = new Set<string>();
    for (const field of value.fields) {
      if (!record(field, ["name", "selector"]) || typeof field.name !== "string" ||
        !/^[a-z][a-z0-9_]{0,39}$/.test(field.name) || forbiddenKeys.has(field.name) || names.has(field.name) ||
        !safeSelector(field.selector, true)) fail("invalid-recipe");
      names.add(field.name);
    }
  } catch { fail("invalid-recipe"); }
}

function encodingLabel(label: string): HtmlResponseEncoding {
  const normalized = label.trim().toLowerCase();
  if (["utf-8", "utf8", "unicode-1-1-utf-8"].includes(normalized)) return "utf-8";
  // These HTML encoding labels deliberately map to Windows-1252, not Node's latin1 codec.
  if (["windows-1252", "cp1252", "x-cp1252", "iso-8859-1", "iso8859-1", "iso_8859-1", "iso_8859-1:1987",
    "latin1", "latin-1", "l1", "ibm819", "cp819", "csisolatin1", "us-ascii", "ascii"].includes(normalized)) return "windows-1252";
  return fail("encoding");
}

function contentTypeParameters(contentType: string): string[] {
  if (typeof contentType !== "string" || contentType.length > 512 || /[\r\n\0]/.test(contentType)) fail("content-type");
  const [media, ...parameters] = contentType.split(";");
  if (media?.trim().toLowerCase() !== "text/html") fail("content-type");
  return parameters;
}

function headerEncoding(contentType: string): HtmlResponseEncoding | undefined {
  const parameters = contentTypeParameters(contentType);
  let encoding: HtmlResponseEncoding | undefined;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*(?:"([^"\s]+)"|'([^'\s]+)'|([^\s"']+))\s*$/i.exec(parameter);
    if (!match || encoding !== undefined) fail("encoding");
    encoding = encodingLabel(match[1] ?? match[2] ?? match[3]!);
  }
  return encoding;
}

function metaEncodings($: CheerioAPI): HtmlResponseEncoding[] {
  const encodings: HtmlResponseEncoding[] = [];
  $("meta").each((_index, element) => {
    const attributes = element.attribs;
    const direct = attributes.charset;
    const indirect = attributes["http-equiv"]?.trim().toLowerCase() === "content-type" ? attributes.content : undefined;
    if (direct !== undefined && indirect !== undefined) fail("encoding-conflict");
    if (direct !== undefined) encodings.push(encodingLabel(direct));
    if (indirect !== undefined) {
      const encoding = headerEncoding(indirect);
      if (!encoding) fail("encoding");
      encodings.push(encoding);
    }
  });
  return encodings;
}

function assertNoRefresh($: CheerioAPI): void {
  $("meta").each((_index, element) => {
    if (element.attribs["http-equiv"]?.trim().toLowerCase() === "refresh") fail("invalid-document");
  });
}

function parse(body: string, prefix = false): CheerioAPI {
  try {
    let invalid = false;
    const $ = load(body, { scriptingEnabled: true, onParseError(error) {
      // Optional end tags and a missing doctype are ordinary HTML. Ambiguous attributes and lexical truncation are not.
      if (error.code === "duplicate-attribute" || !prefix && (error.code.startsWith("eof-in-") || error.code === "unexpected-null-character")) invalid = true;
    } });
    if (invalid) fail("invalid-document");
    const stack: Array<{ node: AnyNode; depth: number }> = $.root().toArray().map((node) => ({ node, depth: 0 }));
    let count = 0;
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (++count > MAX_NODES || depth > MAX_DEPTH) fail("invalid-document");
      if ("children" in node) for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
    }
    return $;
  } catch { return fail("invalid-document"); }
}

function checkBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) fail("invalid-document");
  if (bytes.byteLength > MAX_BYTES) fail("response-too-large");
}

/** WHATWG precedence for this bounded supported subset: BOM > transport > early
 * explicit meta. No user override, statistical detection or guessed default.
 * https://html.spec.whatwg.org/multipage/parsing.html#determining-the-character-encoding */
export function inferHtmlResponseEncoding(contentType: string, bytes?: Uint8Array): HtmlResponseEncoding {
  contentTypeParameters(contentType);
  if (bytes === undefined) return headerEncoding(contentType) ?? fail("encoding");
  checkBytes(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff ||
    bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) fail("encoding");
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : undefined;
  if (bom) return bom;
  const header = headerEncoding(contentType);
  if (header) return header;
  const prefix = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const meta = metaEncodings(parse(prefix, true));
  if (meta.length > 1) fail("encoding-conflict");
  return meta[0] ?? fail("encoding");
}

/** Chromium hands back its own decoded document text, never the original wire
 * bytes, so a learned encoding may only come from declarations that survive that
 * decoding: the transport charset, else the document's own early meta element. A
 * consumed BOM is deliberately not reconstructed; a document that declares no
 * supported encoding cannot pin one. Fresh network bytes are still decoded
 * independently, and a disagreement refuses the compiled response. */
export function declaredResponseEncoding(contentType: string, text: string): HtmlResponseEncoding {
  const header = headerEncoding(contentType);
  if (header) return header;
  if (typeof text !== "string" || text.length === 0) fail("invalid-document");
  const meta = metaEncodings(parse(text.slice(0, 1024), true));
  if (meta.length > 1) fail("encoding-conflict");
  return meta[0] ?? fail("encoding");
}

// WHATWG windows-1252 index, positions 0–31 (bytes 0x80–0x9f).
// https://encoding.spec.whatwg.org/index-windows-1252.txt
// Some supported Node/ICU builds decode this label as ISO-8859-1. Keep the
// browser mapping explicit; all other single-byte values map identically.
const windows1252C1 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

export function decodeHtmlResponseBytes(bytes: Uint8Array, contentType: string, expectedEncoding?: HtmlResponseEncoding): { body: string; encoding: HtmlResponseEncoding } {
  try {
    const encoding = inferHtmlResponseEncoding(contentType, bytes);
    if (expectedEncoding !== undefined && encoding !== expectedEncoding) fail("encoding-conflict");
    const body = encoding === 'windows-1252'
      ? Buffer.from(bytes).toString('latin1').replace(/[\u0080-\u009f]/g, char => windows1252C1[char.charCodeAt(0)-0x80]!)
      : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (body.includes("\0")) fail("invalid-document");
    // Certain BOM/transport metadata wins over HTML declarations. The decoded
    // Unicode string is never reinterpreted using a lower-precedence meta tag.
    assertNoRefresh(parse(body));
    return { body, encoding };
  } catch (error) {
    if (error instanceof HtmlResponseError) throw error;
    return fail("encoding");
  }
}

const isElement = (node: AnyNode): node is Element => "tagName" in node;
function ancestors(element: Element): Element[] {
  const result: Element[] = [];
  let current: AnyNode | null = element;
  while (current) { if (isElement(current)) result.push(current); current = current.parent; }
  return result;
}

/** Static exclusion only. Stylesheets, layout, script state and actual visibility are deliberately not inferred. */
function unsafeAncestry(element: Element): boolean {
  for (const node of ancestors(element)) {
    const attributes = node.attribs;
    if (["script", "style", "template", "noscript", "iframe", "object", "svg", "math"].includes(node.tagName) ||
      ["details", "dialog"].includes(node.tagName) && !Object.hasOwn(attributes, "open") ||
      ["hidden", "inert"].some((name) => Object.hasOwn(attributes, name)) || attributes["aria-hidden"]?.trim().toLowerCase() === "true") return true;
    const style = attributes.style ?? "";
    if (style.length > 4_000 || /\\|\/\*|@/.test(style)) return true;
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase();
      if (property === "display" && !["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "table", "table-row", "table-cell", "list-item"].includes(value) ||
        property === "visibility" && value !== "visible" || property === "content-visibility" && value !== "visible" ||
        property === "opacity" && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || Number(value) <= 0) || property === "all") return true;
    }
  }
  return false;
}

function authCheck($: CheerioAPI): void {
  const login = /\b(?:sign\s*in|log\s*in|login)\b/i;
  const verification = /\b(?:verify (?:your )?(?:identity|account)|verification|security check|two.factor|one.time|captcha|prove you are human)\b/i;
  const headings = $("h1,h2,h3,[role='heading']").toArray().filter((element) => !unsafeAncestry(element));
  const pageLogin = headings.some((element) => login.test($(element).text().slice(0, 300)));
  const pageVerification = headings.some((element) => verification.test($(element).text().slice(0, 300)));
  for (const form of $("form,[role='dialog']").toArray()) {
    if (unsafeAncestry(form)) continue;
    const inputs = $(form).find("input").toArray().filter((element) => !unsafeAncestry(element));
    if (pageVerification && inputs.some((element) => element.attribs.autocomplete?.trim().toLowerCase() === "one-time-code")) fail("checkpoint");
    const loginInput = inputs.some((element) => element.attribs.type?.toLowerCase() === "password" && element.attribs.autocomplete !== "new-password" ||
      element.attribs.type?.toLowerCase() === "email" || element.attribs.autocomplete === "username");
    const loginButton = $(form).find("button,input[type='submit'],[role='button']").toArray().some((element) =>
      !unsafeAncestry(element) && login.test(element.tagName === "input" ? element.attribs.value ?? "" : $(element).text().slice(0, 300)));
    if (pageLogin && loginInput && loginButton) fail("login-form");
  }
}

function controlValue($: CheerioAPI, element: Element, ids: Map<string, Element[]>): string {
  if (element.tagName !== "input" || unsafeAncestry(element)) fail("unsafe-control");
  const attributes = element.attribs;
  const type = (attributes.type ?? "text").trim().toLowerCase();
  if (type !== "text" && type !== "number") fail("unsafe-control");
  const lineage = ancestors(element);
  const disabled = Object.hasOwn(attributes, "disabled") || lineage.slice(1).some((ancestor) => {
    if (ancestor.tagName !== "fieldset" || !Object.hasOwn(ancestor.attribs, "disabled")) return false;
    const legend = ancestor.children.find((node) => isElement(node) && node.tagName === "legend");
    return !legend || !lineage.includes(legend as Element);
  });
  if (!Object.hasOwn(attributes, "readonly") && !disabled) fail("unsafe-control");
  const byId = (id: string): Element => {
    const matches = ids.get(id);
    if (!matches || matches.length !== 1) fail("unsafe-control");
    return matches[0]!;
  };
  if (attributes.id !== undefined && ids.get(attributes.id)?.length !== 1) fail("unsafe-control");
  const form = attributes.form !== undefined ? byId(attributes.form) : lineage.find((ancestor) => ancestor.tagName === "form");
  if (form && form.tagName !== "form") fail("unsafe-control");
  const metadata: string[] = [];
  for (const control of [element, form]) {
    if (!control) continue;
    const autocomplete = control.attribs.autocomplete;
    if (autocomplete !== undefined && autocomplete.trim().toLowerCase() !== "off") fail("unsafe-control");
    for (const name of ["id", "name", "aria-label", "placeholder", "title", "aria-labelledby", "aria-describedby"]) {
      const value = control.attribs[name] ?? "";
      if (value.length > 2_000) fail("unsafe-control");
      metadata.push(value);
    }
    for (const name of ["aria-labelledby", "aria-describedby"]) {
      const references = (control.attribs[name] ?? "").trim().split(/\s+/).filter(Boolean);
      if (references.length > 12) fail("unsafe-control");
      for (const id of references) metadata.push($(byId(id)).text());
    }
  }
  const labels = $("label").toArray().filter((label) => lineage.includes(label) || attributes.id !== undefined && label.attribs.for === attributes.id);
  if (labels.length > 12) fail("unsafe-control");
  for (const label of labels) metadata.push($(label).text());
  if (metadata.some((value) => value.length > 4_000) || metadata.join(" ").length > 16_000) fail("unsafe-control");
  const normalized = metadata.join(" ").normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(?:password|passwd|passcode|credential|credentials|secret|token|cookie|csrf|xsrf|session|auth|authentication|authorization|otp|pin|cvv|cvc|iban|swift|bank|account|routing|payment|credit|debit|card|email|phone|mobile|telephone|address|username|contact|ssn|social|security|passport|license|licence|birth|dob|given|family|surname|fullname|firstname|lastname|name)\b/.test(normalized) ||
    /(?:password|passwd|onetime|api\s*key|access\s*key|auth\s*token)/.test(normalized)) fail("unsafe-control");
  const value = attributes.value;
  // Native text inputs strip newlines; invalid number strings are sanitized to empty. Refuse rather than normalize.
  if (typeof value !== "string" || value.length < 1 || value.length > 4_000 || /[\r\n\0]/.test(value) ||
    type === "number" && (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) fail("unsafe-control");
  return value;
}

/** Passive server value attributes, NOT live DOM values or a rendered-visibility claim. */
export function extractHtmlResponseRows(body: string, recipe: HtmlValueResponseRecipe): { rows: Record<string, string>[] } {
  try {
    assertHtmlValueResponseRecipe(recipe);
    if (typeof body !== "string" || body.length === 0 || body.includes("\0")) fail("invalid-document");
    // Bounds accepted input and AST size, not total parser/process allocation or preemptive CPU time.
    if (Buffer.byteLength(body) > MAX_BYTES) fail("response-too-large");
    const $ = parse(body);
    const ids = new Map<string, Element[]>();
    const stack: Array<{ node: AnyNode; depth: number }> = $.root().toArray().map((node) => ({ node, depth: 0 }));
    let nodes = 0;
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("invalid-document");
      if (isElement(node) && node.attribs.id !== undefined) {
        const matches = ids.get(node.attribs.id) ?? []; matches.push(node); ids.set(node.attribs.id, matches);
      }
      if ("children" in node) for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
    }
    // This API receives Unicode, not bytes: its metadata cannot select a charset.
    assertNoRefresh($);
    authCheck($);
    const region = $(recipe.region);
    if (region.length !== 1) fail("field-cardinality");
    if (!isElement(region[0]!) || unsafeAncestry(region[0]!)) fail("unsafe-control");
    const items = region.find(recipe.item).toArray();
    if (items.length < 1 || items.length > 100) fail("field-cardinality");
    const rows: Record<string, string>[] = [];
    let outputBytes = 0;
    for (const item of items) {
      const row: Record<string, string> = {};
      for (const field of recipe.fields) {
        const matches = field.selector ? $(item).find(field.selector).toArray() : [item];
        if (matches.length !== 1) fail("field-cardinality");
        row[field.name] = controlValue($, matches[0]!, ids);
      }
      outputBytes += Buffer.byteLength(JSON.stringify(row));
      if (outputBytes > MAX_BYTES) fail("response-too-large");
      rows.push(row);
    }
    return { rows };
  } catch (error) {
    if (error instanceof HtmlResponseError) throw error;
    return fail("invalid-document");
  }
}
