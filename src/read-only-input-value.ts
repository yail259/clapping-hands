/**
 * Passed directly to Playwright evaluate: keep this function self-contained.
 * This is conservative DOM admission, not a sandbox against hostile page code.
 * Never inspect editable/autofilled controls merely because a model asks to.
 */
export function readReadOnlyInputValue(element: Element): {
  value: string; type: "text" | "number"; readOnly: boolean; disabled: boolean;
} | null {
  const view = element.ownerDocument.defaultView;
  if (!view || !(element instanceof view.HTMLInputElement) || !element.isConnected) return null;
  const rawType = (element.getAttribute("type") ?? "text").trim().toLowerCase();
  if (rawType !== "text" && rawType !== "number") return null;
  const readOnlyGetter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "readOnly")?.get;
  if (!readOnlyGetter) return null;
  const readOnly = readOnlyGetter.call(element) === true;
  const disabled = element.matches(":disabled");
  if (!readOnly && !disabled) return null;
  // Traverse shadow hosts too; a visible child must not escape hidden ancestry.
  let ancestor: Element | null = element;
  for (let depth = 0; ancestor; depth++) {
    if (depth > 100 || ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") ||
      ancestor.getAttribute("aria-hidden")?.toLowerCase() === "true") return null;
    const style = view.getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 ||
      style.contentVisibility === "hidden") return null;
    const root = ancestor.getRootNode();
    ancestor = ancestor.parentElement ?? (root instanceof view.ShadowRoot ? root.host : null);
  }
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 || element.getClientRects().length === 0) return null;
  // Unknown autocomplete categories are not safe by default. Check the form
  // separately even when the input overrides it with "off".
  for (const control of [element, element.form]) {
    if (!control) continue;
    const autocomplete = control.getAttribute("autocomplete");
    if (autocomplete !== null && autocomplete.trim().toLowerCase() !== "off") return null;
  }
  const metadata: string[] = [];
  for (const control of [element, element.form]) {
    if (!control) continue;
    for (const attribute of ["id", "name", "aria-label", "placeholder", "title", "aria-labelledby", "aria-describedby"]) {
      const value = control.getAttribute(attribute) ?? "";
      if (value.length > 2_000) return null;
      metadata.push(value);
    }
  }
  const labels = Array.from(element.labels ?? []);
  if (labels.length > 12) return null;
  for (const label of labels) metadata.push(label.textContent ?? "");
  for (const attribute of ["aria-labelledby", "aria-describedby"]) {
    const ids = (element.getAttribute(attribute) ?? "").trim().split(/\s+/).filter(Boolean);
    if (ids.length > 12) return null;
    const root = element.getRootNode();
    if (!(root instanceof view.Document || root instanceof view.ShadowRoot)) return null;
    for (const id of ids) {
      const related = root.getElementById(id);
      if (!related) return null;
      metadata.push(related.textContent ?? "");
    }
  }
  if (metadata.some((value) => value.length > 4_000) || metadata.join(" ").length > 16_000) return null;
  const normalized = metadata.join(" ").normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(?:password|passwd|passcode|credential|credentials|secret|token|cookie|csrf|xsrf|session|auth|authentication|authorization|otp|pin|cvv|cvc|iban|swift|bank|account|routing|payment|credit|debit|card|email|phone|mobile|telephone|address|username|contact|ssn|social|security|passport|license|licence|birth|dob|given|family|surname|fullname|firstname|lastname|name)\b/.test(normalized) ||
    /(?:password|passwd|onetime|api\s*key|access\s*key|auth\s*token)/.test(normalized)) return null;
  // Read the native live property, not the stale attribute/default value or a
  // page-defined accessor on this instance. Do not focus, dispatch, or mutate.
  const getter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.get;
  if (!getter) return null;
  const value: unknown = getter.call(element);
  if (typeof value !== "string" || value.length === 0 || value.length > 4_000) return null;
  return { value, type: rawType, readOnly, disabled };
}
