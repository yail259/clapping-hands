import type { BrowserContext, Page, Request, Response } from "playwright-core";

export type WorkflowAccessReason = "http-401" | "http-403" | "login-form" | "checkpoint";

/** Fixed, actionable evidence only. Never retain page text, query strings, or credentials. */
export class WorkflowAccessError extends Error {
  readonly code = "WORKFLOW_ACCESS_REQUIRED";
  readonly #reason: WorkflowAccessReason;
  readonly #origin: string;

  constructor(reason: WorkflowAccessReason, origin: string) {
    super(reason === "http-403" ? "The site refused access to the workflow." : "The workflow requires an authentication or checkpoint handoff.");
    this.name = "WorkflowAccessError";
    this.#reason = reason;
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Workflow authentication requires an HTTP origin.");
    this.#origin = parsed.origin;
  }

  get reason(): WorkflowAccessReason { return this.#reason; }
  get origin(): string { return this.#origin; }
}

type NavigationEvidence = { request: Request; response?: { status: number; url: string } };
const navigationEvidence = new WeakMap<Page, NavigationEvidence>();
const tracking = new WeakMap<BrowserContext, { references: number; stop(): void }>();

function mainNavigationPage(request: Request): Page | undefined {
  try {
    if (!request.isNavigationRequest()) return;
    const frame = request.frame();
    const page = frame.page();
    if (frame === page.mainFrame()) return page;
  } catch { /* Service-worker or detached-frame requests are not document evidence. */ }
}

/** Observe main-document status without bodies/headers. Must start before navigation. */
export function trackWorkflowAuth(context: BrowserContext): () => void {
  let registration = tracking.get(context);
  if (!registration) {
    const onRequest = (request: Request) => {
      const page = mainNavigationPage(request);
      // Clear prior status at issuance, not framenavigated (which follows response).
      if (page) navigationEvidence.set(page, { request });
    };
    const onResponse = (response: Response) => {
      const request = response.request();
      const page = mainNavigationPage(request);
      if (!page) return;
      const evidence = navigationEvidence.get(page);
      if (evidence?.request === request) evidence.response = { status: response.status(), url: response.url() };
    };
    const onFailed = (request: Request) => {
      const page = mainNavigationPage(request);
      if (page && navigationEvidence.get(page)?.request === request) navigationEvidence.delete(page);
    };
    const stop = () => {
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailed);
      context.off("close", stop);
      for (const page of context.pages()) navigationEvidence.delete(page);
      tracking.delete(context);
    };
    registration = { references: 0, stop };
    tracking.set(context, registration);
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfailed", onFailed);
    context.on("close", stop);
  }
  registration.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (tracking.get(context) === registration && --registration.references === 0) registration.stop();
  };
}

/** Conservative negative signal, never an assertion that the user is authenticated. */
export async function assertWorkflowAuth(page: Page, expectedOrigin: string): Promise<void> {
  const response = navigationEvidence.get(page)?.response;
  if (response && response.url.split("#", 1)[0] === page.url().split("#", 1)[0]) {
    if (response.status === 401) throw new WorkflowAccessError("http-401", expectedOrigin);
    if (response.status === 403) throw new WorkflowAccessError("http-403", expectedOrigin);
  }
  // A fixed source string keeps browser code independent of tsx/esbuild function-name helpers.
  const reason = await page.evaluate<"login-form" | "checkpoint" | null>(String.raw`(() => {
    const visible = (element) => {
      if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
    };
    const text = (element) => (element.textContent ?? "").trim().slice(0, 300);
    const login = /\b(?:sign\s*in|log\s*in|login)\b/i;
    const verification = /\b(?:verify (?:your )?(?:identity|account)|verification|security check|two.factor|one.time|captcha|prove you are human)\b/i;
    const headings = [...document.querySelectorAll("h1, h2, h3, [role='heading']")].filter(visible);
    const pageLogin = headings.some((heading) => login.test(text(heading)));
    const pageVerification = headings.some((heading) => verification.test(text(heading)));
    const forms = [...document.querySelectorAll("form, [role='dialog']")].filter(visible);
    for (const form of forms) {
      const inputs = [...form.querySelectorAll("input")].filter(visible);
      const buttons = [...form.querySelectorAll("button, input[type='submit'], [role='button']")].filter(visible);
      const buttonTexts = buttons.map((button) => button instanceof HTMLInputElement ? button.value : text(button));
      const formHeadings = [...form.querySelectorAll("h1, h2, h3, [role='heading']")].filter(visible);
      const verifyHeading = pageVerification || formHeadings.some((heading) => verification.test(text(heading)));
      const oneTimeCode = inputs.some((input) => input.autocomplete === "one-time-code");
      if (verifyHeading && oneTimeCode) return "checkpoint";
      const password = inputs.some((input) => input.type === "password" && input.autocomplete !== "new-password");
      const username = inputs.some((input) => input.autocomplete === "username" || input.type === "email");
      const loginHeading = pageLogin || formHeadings.some((heading) => login.test(text(heading)));
      const loginButton = buttonTexts.some((value) => login.test(value));
      if ((password || username) && loginHeading && loginButton) return "login-form";
    }
    return null;
  })()`);
  if (reason) throw new WorkflowAccessError(reason, expectedOrigin);
}
