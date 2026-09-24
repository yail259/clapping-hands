import type { CapturedExchange } from "./captured-exchange.js";

// Chromium decodes a document with its own charset rules and the client protocol
// hands back that text, not the original wire bytes. Only the recorder's own
// snapshot of that text may back an HTML source row, so the evidence is kept in
// process-private, unforgeable storage: serialized or reconstructed copies lose
// it. Strings are immutable, so retained evidence cannot be edited in place.
const browserDecoded = new WeakMap<CapturedExchange, string>();

export function rememberBrowserDecodedResponse(exchange: CapturedExchange, text: string): void {
  browserDecoded.set(exchange, text);
}

export function browserDecodedResponseText(exchange: CapturedExchange): string | undefined {
  return browserDecoded.get(exchange);
}
