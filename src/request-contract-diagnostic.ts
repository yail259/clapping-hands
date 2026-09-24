export type RequestContractDifference = { source: "query" | "body"; path: Array<string | number>; kind: "shape" | "constant" };
export type RequestContractDiagnostic = { differences: RequestContractDifference[]; truncated: boolean };
const diagnostics = new WeakMap<object, RequestContractDiagnostic>();

/** Paths come only from the persisted template. Never report values or new remote keys. */
export function requestContractError(expected: { query: unknown; body: unknown }, actual: { query: unknown; body: unknown }): Error {
  const diagnostic: RequestContractDiagnostic = { differences: [], truncated: false };
  let remaining = 2000;
  const record = (source: "query" | "body", path: Array<string | number>, kind: RequestContractDifference["kind"]) => {
    if (diagnostic.differences.length >= 20) { diagnostic.truncated = true; return; }
    diagnostic.differences.push({ source, path: path.map((key) => typeof key === "number" ? key : /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(key) ? key : "[redacted-key]"), kind });
  };
  const charge = (): boolean => {
    if (remaining === 0) { diagnostic.truncated = true; return false; }
    remaining--;
    return true;
  };
  // Key inspection shares the node budget. Do not allocate/sort an unbounded
  // Object.keys list or compare a whole subtree before checking the limit.
  const keys = (value: object): string[] | null => {
    const found: string[] = [];
    for (const key in value) {
      if (!charge()) return null;
      if (Object.hasOwn(value, key)) found.push(key);
    }
    return found;
  };
  type Visit = { source: "query" | "body"; before: unknown; after: unknown; path: Array<string | number>; key?: string; afterHasKey?: boolean };
  try {
    const pending: Visit[] = [
      { source: "body", before: expected.body, after: actual.body, path: [] },
      { source: "query", before: expected.query, after: actual.query, path: [] },
    ];
    while (pending.length) {
      if (diagnostic.differences.length >= 20 || !charge()) { diagnostic.truncated = true; break; }
      const task = pending.pop()!;
      const { source, path } = task;
      // Child values are read only when their visit has acquired budget, not
      // eagerly while scheduling a broad object's remaining descendants.
      const before = task.key === undefined ? task.before : (task.before as Record<string, unknown>)[task.key];
      const after = task.key === undefined ? task.after : task.afterHasKey ? (task.after as Record<string, unknown>)[task.key] : undefined;
      // Identity/scalar equality is constant-depth; structural equality is only
      // established by the individually budgeted visits below.
      if (Object.is(before, after)) continue;
      if (before === null || typeof before !== "object") {
        record(source, path, after !== null && typeof after === "object" || typeof before !== typeof after ? "shape" : "constant");
        continue;
      }
      if (after === null || typeof after !== "object" || Array.isArray(before) !== Array.isArray(after)) {
        record(source, path, "shape"); continue;
      }
      const beforeKeys = keys(before), afterKeys = beforeKeys === null ? null : keys(after);
      if (beforeKeys === null || afterKeys === null) break;
      const actualKeys = new Set(afterKeys);
      if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key) => !actualKeys.has(key))) record(source, path, "shape");
      if (path.length === 12 && beforeKeys.length) { diagnostic.truncated = true; continue; }
      // Reverse scheduling keeps diagnostics in persisted-template order. Only
      // template keys can become paths; unexpected remote keys are never read.
      for (let index = beforeKeys.length - 1; index >= 0; index--) {
        const key = beforeKeys[index]!;
        const segment = Array.isArray(before) && /^(?:0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key)) ? Number(key) : key;
        pending.push({ source, before, after, key, afterHasKey: actualKeys.has(key), path: [...path, segment] });
      }
    }
  } catch {
    // Diagnostics must never replace the original safe error with a raw getter,
    // proxy or parser failure. An incomplete inspection is explicitly marked.
    diagnostic.truncated = true;
  }
  const error = new Error("Captured runtime context request contract mismatch.");
  diagnostics.set(error, diagnostic);
  return error;
}

export function capturedRequestContractDiagnostic(error: unknown): RequestContractDiagnostic | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const diagnostic = diagnostics.get(error);
  return diagnostic ? structuredClone(diagnostic) : undefined;
}
