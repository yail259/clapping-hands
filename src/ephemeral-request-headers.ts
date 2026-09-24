import type { CapturedExchange } from "./captured-exchange.js";

// Capture-only side channel: never a property on exchange/plan/model evidence.
const headersByExchange = new WeakMap<CapturedExchange, Record<string, string>>();
export function isSessionHeaderName(name: string): boolean {
  return /^x-[a-z0-9-]{1,70}$/.test(name) && /(?:csrf|xsrf|(?:^|-)lsd(?:-|$)|dtsg|auth-token)/.test(name);
}
export function rememberSessionHeaders(exchange: CapturedExchange, headers: Record<string, string>): void {
  const selected = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => isSessionHeaderName(name));
  if (selected.length > 16 || selected.some(([, value]) => !value || value.length > 8192 || /[\r\n]/.test(value))) throw new Error("Captured session headers exceed the context contract.");
  headersByExchange.set(exchange, Object.fromEntries(selected));
}
export function capturedSessionHeaders(exchange: CapturedExchange): Record<string, string> {
  return { ...(headersByExchange.get(exchange) ?? {}) };
}
