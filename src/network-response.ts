import type { GenericJsonPlan } from "./generic-network.js";
import type { CapturedExchange } from "./captured-exchange.js";
import { browserDecodedResponseText } from "./captured-response.js";
import { outputRecipeSchema, type OutputRecipe } from "./learned-output.js";
import { decodeJsonResponse, inferJsonResponse } from "./network-codecs.js";
import { assertHtmlValueResponseRecipe, declaredResponseEncoding, decodeHtmlResponseBytes, extractHtmlResponseRows,
  type HtmlValueResponseRecipe, type HtmlResponseEncoding } from "./html-response.js";

type ResponseContract = GenericJsonPlan["response"];

/** One decoder boundary for learning, captured context and fresh replay. HTML
 * yields only the explicitly selected server attributes, never a page tree. */
export function decodeGenericResponseBytes(contract: ResponseContract, bytes: Uint8Array, contentType: string): unknown {
  if (bytes.byteLength > contract.maximumBytes) throw new Error("Compiled response exceeds its byte limit.");
  if(contract.codec==='html-document')return decodeHtmlResponseBytes(bytes,contentType,contract.documentEncoding).body;
  if (contract.codec !== "html-input-values") return decodeJsonResponse(Buffer.from(bytes).toString("utf8"), contract.codec ?? "json");
  assertHtmlValueResponseRecipe(contract.htmlRecipe);
  const decoded = decodeHtmlResponseBytes(bytes, contentType, contract.htmlRecipe.encoding);
  return extractHtmlResponseRows(decoded.body, contract.htmlRecipe);
}

/** Captured browser evidence is already-decoded document text, so it is read
 * through its own boundary; only fresh transport bytes carry a wire charset. */
export function decodeGenericCapturedResponse(contract: ResponseContract, exchange: CapturedExchange): unknown {
  if(contract.codec==='html-document'){
    const text=browserDecodedText(exchange);
    if(Buffer.byteLength(text)>contract.maximumBytes || declaredResponseEncoding(exchange.responseHeaders?.['content-type']??'',text)!==contract.documentEncoding)throw new Error('Captured HTML document differs from its encoding contract.');
    return text;
  }
  if (contract.codec !== "html-input-values") return decodeJsonResponse(exchange.responseBody, contract.codec ?? "json");
  assertHtmlValueResponseRecipe(contract.htmlRecipe);
  const text = browserDecodedText(exchange);
  if (Buffer.byteLength(text) > contract.maximumBytes) throw new Error("Captured response exceeds its byte limit.");
  return extractHtmlResponseRows(text, contract.htmlRecipe);
}

function browserDecodedText(exchange: CapturedExchange): string {
  const text = browserDecodedResponseText(exchange);
  if (text === undefined) throw new Error("HTML rows require the recorder's own process-private browser-decoded response.");
  return text;
}

export function inferCapturedNetworkResponse(exchange: CapturedExchange, outputRecipe?: OutputRecipe, allowHtmlDocument=false): {
  codec: NonNullable<ResponseContract["codec"]>; value: unknown; htmlRecipe?: HtmlValueResponseRecipe; documentEncoding?:HtmlResponseEncoding;
} {
  const contentType = exchange.responseHeaders?.["content-type"] ?? "";
  if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType)) return inferJsonResponse(exchange.responseBody);
  if(allowHtmlDocument && !outputRecipe){
    if(exchange.responseStatus!==200)throw new Error('HTML document response was not successful.');
    const value=browserDecodedText(exchange);
    if(Buffer.byteLength(value)>1024*1024)throw new Error('HTML document evidence exceeds its byte limit.');
    return {codec:'html-document',value,documentEncoding:declaredResponseEncoding(contentType,value)};
  }
  if (!outputRecipe) throw new Error("HTML responses require learned browser fields.");
  const source = outputRecipeSchema.parse(outputRecipe);
  if (source.fields.some((field) => field.source !== "value" || field.line !== null)) throw new Error("Unsupported HTML output source.");
  const text = browserDecodedText(exchange);
  // The learned encoding is the site's own surviving declaration, not a guess
  // from re-encoded browser text; replay decodes fresh bytes and must agree.
  const htmlRecipe: HtmlValueResponseRecipe = { kind: "server-html-input-values-v1", encoding: declaredResponseEncoding(contentType, text),
    region: source.region, item: source.item, fields: source.fields.map(({ name, selector }) => ({ name, selector })) };
  assertHtmlValueResponseRecipe(htmlRecipe);
  return { codec: "html-input-values", htmlRecipe, value: extractHtmlResponseRows(text, htmlRecipe) };
}
