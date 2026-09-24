import { createHash, randomUUID } from "node:crypto";

export type RequestContextScope = {
  profile: object;
  epoch: string;
  origin: string;
  operation: string;
};
export type RuntimeFieldValue = string | number | boolean | null;
export type RequestContextTicket = { id: string; expiresAt: number };

/** Process-local capability storage. Values never appear in tickets or JSON. */
export class RequestContextVault {
  #entries = new Map<string, { scope: RequestContextScope; values: RuntimeFieldValue[]; expiresAt: number; uses: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  issue(scope: RequestContextScope, values: RuntimeFieldValue[], options: { ttlMs: number; maximumUses: number }): RequestContextTicket {
    const url = new URL(scope.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== scope.origin || !scope.profile || typeof scope.profile !== "object" ||
      !scope.epoch || !/^[a-f0-9]{64}$/.test(scope.operation)) throw new Error("Invalid runtime context scope.");
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 60_000 ||
      !Number.isSafeInteger(options.maximumUses) || options.maximumUses < 1 || options.maximumUses > 10) throw new Error("Invalid runtime context budget.");
    if (!Array.isArray(values) || values.length < 1 || values.length > 100 || values.some((value) =>
      value !== null && (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" ||
        typeof value === "string" && value.length > 8192 || typeof value === "number" && !Number.isFinite(value)))) {
      throw new Error("Invalid runtime context values.");
    }
    this.expire();
    if (this.#entries.size >= 100) throw new Error("Runtime context capacity exceeded.");
    const id = randomUUID(); const expiresAt = this.clock() + options.ttlMs;
    this.#entries.set(id, { scope: { ...scope }, values: [...values], expiresAt, uses: options.maximumUses });
    return { id, expiresAt };
  }

  consume(ticket: RequestContextTicket, scope: RequestContextScope): RuntimeFieldValue[] {
    const entry = this.#entries.get(ticket.id);
    if (entry && entry.expiresAt <= this.clock()) this.#entries.delete(ticket.id);
    if (!entry || entry.expiresAt <= this.clock() || entry.uses < 1 || ticket.expiresAt !== entry.expiresAt ||
      entry.scope.profile !== scope.profile || entry.scope.epoch !== scope.epoch ||
      entry.scope.origin !== scope.origin || entry.scope.operation !== scope.operation) {
      throw new Error("Runtime request context is unavailable, stale, or out of scope.");
    }
    // Reserve a use before sending anything. Ambiguous failures must not refund it.
    entry.uses--;
    const values = [...entry.values];
    if (!entry.uses) this.#entries.delete(ticket.id);
    return values;
  }

  invalidate(profile: object): void {
    for (const [key, entry] of this.#entries) if (entry.scope.profile === profile) this.#entries.delete(key);
  }
  clear(): void { this.#entries.clear(); }
  private expire(): void {
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= this.clock()) this.#entries.delete(key);
  }
  toJSON() { return { kind: "ephemeral-request-context", persistedValues: false }; }
}

/** Input must be the redacted immutable operation contract, not captured traffic. */
export function requestOperationFingerprint(contract: unknown): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}
