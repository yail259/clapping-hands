import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { load } from "cheerio";
import type { APIRequestContext, BrowserContext, Page } from "playwright-core";

export type FormValue = string | string[];
export type FormStepAnswers = Record<string, FormValue>;
export type FormWorkflowAnswers = Record<string, FormStepAnswers>;

export type FormControl = {
  name: string;
  kind: "hidden" | "text" | "radio" | "checkbox" | "select" | "textarea";
  required: boolean;
  multiple: boolean;
  optionValues: string[];
};

export type ObservedFormStep = {
  questionKey: string;
  formIndex: number;
  formSignature: string;
  pagePath: string;
  method: "GET" | "POST";
  actionPath: string;
  encoding: "application/x-www-form-urlencoded";
  submitter: {
    index: number;
    name: string | null;
    value: string | null;
  };
  transition: "unknown" | "navigation" | "same-document";
  controls: FormControl[];
};

export type FormWorkflowPlan = {
  formatVersion: "clapping-hands.dev/v1alpha2";
  engine: "html-form-v2";
  action: string;
  version: number;
  effect: "read";
  origin: string;
  startPath: string;
  status: "candidate" | "provisional" | "stable" | "degraded";
  steps: ObservedFormStep[];
  validation: {
    maximumSteps: number;
    finalContentSelector: string;
    finalHeadingMode: "one-of" | "present";
    finalHeadingHashes: string[];
  };
  evidence: {
    demonstrationInputHashes: string[];
    successfulShadowInputHashes: string[];
    failedShadowCount: number;
    lastValidatedAt: string | null;
  };
};

export type FormWorkflowResult = {
  finalUrl: string;
  heading: string | null;
  mainText: string;
  resultHash: string;
  resultSelector: string;
  questionKeys: string[];
  requests: number;
  navigations: number;
  durationMs: number;
};

export type FormWorkflowDemonstration = {
  steps: ObservedFormStep[];
  result: FormWorkflowResult;
  inputHash: string;
};

const EFFECTFUL_FORM_LANGUAGE = /^(?:publish|send|purchase|buy|checkout|place (?:an )?order|delete|post|save|create|approve|transfer|pay|book|reserve|subscribe|unsubscribe|follow|like|upload|add to (?:cart|basket|wishlist)|register|sign up|invite|submit (?:application|order|request|claim|registration|response|review|comment|message))(?:\b|$)/i;
const EFFECTFUL_POST_ACTION_PATH = /(?:^|\/)(?:checkout|orders?|purchases?|payments?|applications?|registrations?|subscriptions?|bookings?|reservations?|messages?|comments?|invites?|uploads?)(?:\/|$)|(?:^|\/)(?:create|update|edit|delete|remove|publish|send|submit|approve|pay|subscribe|unsubscribe)(?:\/|$)/i;
const PLAN_STATUSES = new Set(["candidate", "provisional", "stable", "degraded"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertStoredFormPath(value: string, origin: string, label: string): void {
  const resolved = new URL(value, origin);
  if (!value.startsWith("/") || resolved.origin !== origin || resolved.hash || value !== normalizedPath(resolved)) {
    throw new Error(`${label} must be a same-origin absolute path without a fragment.`);
  }
}

export function assertFormWorkflowPlanSafety(plan: FormWorkflowPlan): void {
  if (!isRecord(plan) || plan.formatVersion !== "clapping-hands.dev/v1alpha2" || plan.engine !== "html-form-v2" || plan.effect !== "read") {
    throw new Error("Invalid read-only form workflow identity.");
  }
  if (!Number.isSafeInteger(plan.version) || plan.version < 1 || !PLAN_STATUSES.has(plan.status)) {
    throw new Error("Compiled form workflow version or status is invalid.");
  }
  const origin = new URL(plan.origin);
  if (!new Set(["http:", "https:"]).has(origin.protocol) || origin.origin !== plan.origin || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Compiled form workflow origin must be a canonical HTTP(S) origin.");
  }
  assertStoredFormPath(plan.startPath, plan.origin, "Compiled form start path");
  if (!isRecord(plan.validation) || !Number.isSafeInteger(plan.validation.maximumSteps) ||
    plan.validation.maximumSteps < 1 || plan.validation.maximumSteps > 10 ||
    typeof plan.validation.finalContentSelector !== "string" || plan.validation.finalContentSelector.length < 1 ||
    plan.validation.finalContentSelector.length > 2_000 || !new Set(["one-of", "present"]).has(plan.validation.finalHeadingMode) ||
    !Array.isArray(plan.validation.finalHeadingHashes) ||
    (plan.validation.finalHeadingMode === "one-of" && plan.validation.finalHeadingHashes.length === 0)) {
    throw new Error("Compiled form validation contract is invalid.");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > plan.validation.maximumSteps) {
    throw new Error("Compiled form step list is invalid.");
  }
  const questionKeys = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    if (!isRecord(step) || typeof step.questionKey !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(step.questionKey) ||
      questionKeys.has(step.questionKey) || !Number.isSafeInteger(step.formIndex) || step.formIndex < 0 || step.formIndex > 100 ||
      typeof step.formSignature !== "string" || step.formSignature.length < 1 || step.formSignature.length > 128 ||
      !new Set(["GET", "POST"]).has(step.method) || step.encoding !== "application/x-www-form-urlencoded" ||
      !new Set(["unknown", "navigation", "same-document"]).has(step.transition)) {
      throw new Error(`Compiled form step ${index + 1} is invalid.`);
    }
    questionKeys.add(step.questionKey);
    assertStoredFormPath(step.pagePath, plan.origin, `Compiled form page path ${index + 1}`);
    assertStoredFormPath(step.actionPath, plan.origin, `Compiled form action path ${index + 1}`);
    if (step.method === "POST" && EFFECTFUL_POST_ACTION_PATH.test(new URL(step.actionPath, plan.origin).pathname)) {
      throw new Error("A read-only compiled form cannot submit to a mutation-shaped path.");
    }
    if (!isRecord(step.submitter) || !Number.isSafeInteger(step.submitter.index) || step.submitter.index < 0 || step.submitter.index > 100 ||
      (step.submitter.name !== null && (typeof step.submitter.name !== "string" || step.submitter.name.length > 256)) ||
      (step.submitter.value !== null && (typeof step.submitter.value !== "string" || step.submitter.value.length > 2_000))) {
      throw new Error("Compiled form submitter is invalid.");
    }
    if (!Array.isArray(step.controls) || step.controls.length > 500) throw new Error("Compiled form controls are invalid.");
    const controlNames = new Set<string>();
    for (const control of step.controls) {
      if (!isRecord(control) || typeof control.name !== "string" || control.name.length < 1 || control.name.length > 256 ||
        controlNames.has(control.name) || !new Set(["hidden", "text", "radio", "checkbox", "select", "textarea"]).has(control.kind) ||
        typeof control.required !== "boolean" || typeof control.multiple !== "boolean" || !Array.isArray(control.optionValues) ||
        control.optionValues.length > 1_000 || control.optionValues.some((value) => typeof value !== "string" || value.length > 2_000)) {
        throw new Error("Compiled form control is invalid.");
      }
      controlNames.add(control.name);
    }
  }
  if (!isRecord(plan.evidence) || !Array.isArray(plan.evidence.demonstrationInputHashes) ||
    !Array.isArray(plan.evidence.successfulShadowInputHashes) || !Number.isSafeInteger(plan.evidence.failedShadowCount) ||
    plan.evidence.failedShadowCount < 0) {
    throw new Error("Compiled form evidence is invalid.");
  }
}

function assertSameOrigin(url: URL, origin: string, label: string): void {
  if (url.origin !== origin) throw new Error(`${label} left the allowed origin: ${url.origin}`);
}

function normalizedPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFormInput(answers: FormWorkflowAnswers): string {
  return createHash("sha256").update(JSON.stringify(answers)).digest("hex");
}

export function extractMainResult(
  html: string,
  url: string,
  preferredSelector?: string,
): Omit<FormWorkflowResult, "questionKeys" | "requests" | "navigations" | "durationMs"> {
  const $ = load(html);
  const selectors = preferredSelector
    ? [preferredSelector]
    : ["main", '[role="main"]', "#main", "#content", "body"];
  const resultSelector = selectors.find((selector) => $(selector).length === 1);
  if (!resultSelector) throw new Error("Final page did not contain a unique result region.");
  const main = $(resultSelector).first();
  // Compare the task result, not page furniture whose text can change after
  // client-side enhancement (for example an expandable GOV.UK step nav).
  main.find("script, style, input, select, textarea, button, .govuk-feedback, .gem-c-feedback, .gem-c-contextual-sidebar").remove();
  main.find("h1, h2, h3, h4, h5, h6, p, li, dt, dd, section, article, div, aside, br").after(" ");
  const mainText = normalizedText(main.text());
  if (!mainText) throw new Error("Final page main result region was empty.");
  const heading = normalizedText(main.find("h1, h2, h3, h4, h5, h6").first().text()) ||
    normalizedText($("title").first().text()) || null;
  return {
    finalUrl: url,
    heading,
    mainText,
    resultHash: hashText(mainText),
    resultSelector,
  };
}

function controlKind(tagName: string, type: string | undefined): FormControl["kind"] | null {
  if (tagName === "select") return "select";
  if (tagName === "textarea") return "textarea";
  if (tagName !== "input") return null;
  if (type === "hidden") return "hidden";
  if (type === "radio") return "radio";
  if (type === "checkbox") return "checkbox";
  if (["submit", "button", "reset", "image", "file"].includes(type ?? "text")) return null;
  return "text";
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function inspectFormCandidates(html: string, currentUrl: string): ObservedFormStep[] {
  const current = new URL(currentUrl);
  const $ = load(html);
  const declaredBase = $("base[href]").first().attr("href");
  const resolutionBase = declaredBase ? new URL(declaredBase, current) : current;
  assertSameOrigin(resolutionBase, current.origin, "Document base URL");
  const candidates: ObservedFormStep[] = [];

  $("form").each((formIndex, element) => {
    const form = $(element);
    // Authentication is a manual profile handoff. Compiling credential fields
    // would turn passwords into tool inputs and risks persisting or replaying
    // them outside the browser's normal login surface.
    if (form.find('input[type="password"]').length > 0) return;
    const submitters = form.find('button[type="submit"], input[type="submit"], button:not([type]), input[type="image"]');
    const editable = form.find("input[name], select[name], textarea[name]").filter((_index, control) => {
      const candidate = $(control);
      const type = candidate.attr("type")?.toLowerCase();
      return !candidate.is(":disabled") && !["hidden", "submit", "button", "reset", "image"].includes(type ?? "");
    });
    if (submitters.length === 0 || editable.length === 0) return;
    const submitterLanguage = submitters.map((_index, submitter) => {
      const candidate = $(submitter);
      return candidate.attr("value") ?? candidate.attr("aria-label") ?? candidate.text();
    }).get().join(" ");
    if (EFFECTFUL_FORM_LANGUAGE.test(submitterLanguage)) return;
    if (form.find('input[type="file"]').length > 0) {
      throw new Error("File uploads require a separately gated compiler.");
    }
    const method = (form.attr("method") ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error(`Unsupported form method ${method}.`);
    const rawEncoding = (form.attr("enctype") ?? "application/x-www-form-urlencoded").toLowerCase().split(";")[0]!.trim();
    if (rawEncoding !== "application/x-www-form-urlencoded") {
      throw new Error(`Unsupported form encoding ${rawEncoding}.`);
    }
    const action = new URL(form.attr("action") || current.href, resolutionBase);
    assertSameOrigin(action, current.origin, "Form action");
    if (method === "POST" && EFFECTFUL_POST_ACTION_PATH.test(action.pathname)) return;

    const grouped = new Map<string, FormControl>();
    form.find("input[name], select[name], textarea[name]").each((_index, controlElement) => {
      const candidate = $(controlElement);
      if (candidate.is(":disabled")) return;
      const name = candidate.attr("name") ?? "";
      if (!name) return;
      const kind = controlKind(controlElement.tagName, candidate.attr("type")?.toLowerCase());
      if (!kind) return;
      const existing = grouped.get(name);
      const optionValues = kind === "select"
        ? candidate.find("option").map((_optionIndex, option) => $(option).attr("value") ?? $(option).text()).get()
        : kind === "radio" || kind === "checkbox"
          ? [candidate.attr("value") ?? "on"]
          : [];
      if (existing) {
        existing.required ||= candidate.is("[required]");
        existing.multiple ||= candidate.is("[multiple]");
        existing.optionValues.push(...optionValues.filter((value) => !existing.optionValues.includes(value)));
      } else {
        grouped.set(name, {
          name,
          kind,
          required: candidate.is("[required]"),
          multiple: candidate.is("[multiple]") || kind === "checkbox",
          optionValues,
        });
      }
    });
    const controls = [...grouped.values()];
    const firstSubmitter = submitters.first();
    const submitter = {
      index: 0,
      name: firstSubmitter.attr("name") ?? null,
      value: firstSubmitter.attr("value") ?? (firstSubmitter.is("button") ? normalizedText(firstSubmitter.text()) : null),
    };
    const shape = {
      method,
      actionPath: normalizedPath(action),
      controls: controls.map(({ name, kind, multiple, optionValues }) => ({ name, kind, multiple, optionValues })),
      submitter,
    };
    const formSignature = hashText(JSON.stringify(shape));
    const explicitKey = form.attr("data-question-key") ?? form.attr("id") ?? form.attr("name") ?? form.attr("aria-label");
    const actionKey = slug(action.pathname.split("/").filter(Boolean).at(-1) ?? "form");
    const questionKey = slug(explicitKey ?? "") || `${actionKey || "form"}-${formSignature.slice(0, 10)}`;
    candidates.push({
      questionKey,
      formIndex,
      formSignature,
      pagePath: normalizedPath(current),
      method,
      actionPath: normalizedPath(action),
      encoding: "application/x-www-form-urlencoded",
      submitter,
      transition: "unknown",
      controls,
    });
  });
  return candidates;
}

export function inspectFormPage(
  html: string,
  currentUrl: string,
  options: { expected?: ObservedFormStep; answerKeys?: string[] } = {},
): ObservedFormStep | null {
  const candidates = inspectFormCandidates(html, currentUrl);
  if (options.expected) {
    const byKey = candidates.filter((candidate) => candidate.questionKey === options.expected!.questionKey);
    if (byKey.length === 1) return byKey[0]!;
    const bySignature = candidates.filter((candidate) => candidate.formSignature === options.expected!.formSignature);
    if (bySignature.length === 1) return bySignature[0]!;
    if (candidates.length === 1) return candidates[0]!;
    return null;
  }
  if (options.answerKeys) {
    const keys = new Set(options.answerKeys);
    const matches = candidates.filter((candidate) => keys.has(candidate.questionKey));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`Multiple workflow forms matched the supplied answer keys.`);
    return null;
  }
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error(`Expected one workflow form, found ${candidates.length}.`);
  return candidates[0]!;
}

function assertAnswerMatches(step: ObservedFormStep, answers: FormStepAnswers): void {
  const controls = new Map(step.controls.map((control) => [control.name, control]));
  for (const [name, raw] of Object.entries(answers)) {
    const control = controls.get(name);
    if (!control || control.kind === "hidden") throw new Error(`Answer ${name} is not an editable control in ${step.questionKey}.`);
    const values = Array.isArray(raw) ? raw : [raw];
    if ((control.kind === "radio" || control.kind === "select" || control.kind === "checkbox") &&
      values.some((value) => !control.optionValues.includes(value))) {
      throw new Error(`Answer ${name} uses a value that is not offered by ${step.questionKey}.`);
    }
  }
  for (const control of step.controls) {
    if (control.required && control.kind !== "hidden" && answers[control.name] === undefined) {
      throw new Error(`Required answer ${control.name} is missing for ${step.questionKey}.`);
    }
  }
}

function cssAttribute(value: string): string {
  return JSON.stringify(value);
}

async function fillBrowserForm(page: Page, step: ObservedFormStep, answers: FormStepAnswers): Promise<void> {
  const form = page.locator("form").nth(step.formIndex);
  assertAnswerMatches(step, answers);
  for (const [name, raw] of Object.entries(answers)) {
    const control = step.controls.find((candidate) => candidate.name === name)!;
    const values = Array.isArray(raw) ? raw : [raw];
    if (control.kind === "select") {
      await form.locator(`[name=${cssAttribute(name)}]`).selectOption(values);
    } else if (control.kind === "radio") {
      await form.locator(`[name=${cssAttribute(name)}][value=${cssAttribute(values[0] ?? "")}]`).check();
    } else if (control.kind === "checkbox") {
      for (const value of values) {
        await form.locator(`[name=${cssAttribute(name)}][value=${cssAttribute(value)}]`).check();
      }
    } else {
      await form.locator(`[name=${cssAttribute(name)}]`).fill(values[0] ?? "");
    }
  }
}

function assertObservedStep(expected: ObservedFormStep, actual: ObservedFormStep): void {
  const expectedControls = expected.controls.map(({ name, kind, multiple, optionValues }) => ({ name, kind, multiple, optionValues }));
  const actualControls = actual.controls.map(({ name, kind, multiple, optionValues }) => ({ name, kind, multiple, optionValues }));
  if (
    expected.questionKey !== actual.questionKey ||
    expected.method !== actual.method ||
    expected.actionPath !== actual.actionPath ||
    expected.encoding !== actual.encoding ||
    JSON.stringify(expected.submitter) !== JSON.stringify(actual.submitter) ||
    JSON.stringify(expectedControls) !== JSON.stringify(actualControls)
  ) {
    throw new Error(`Workflow drift at ${actual.questionKey}; compiled plan refused to guess.`);
  }
}

async function submitBrowserForm(page: Page, step: ObservedFormStep): Promise<"navigation" | "same-document"> {
  const form = page.locator("form").nth(step.formIndex);
  const submitters = form.locator('button[type="submit"], input[type="submit"], button:not([type]), input[type="image"]');
  const submit = submitters.nth(step.submitter.index);
  if (await submit.count() !== 1) throw new Error(`No compiled submit control found for ${step.questionKey}.`);
  const beforeUrl = page.url();
  const beforeText = await page.locator("body").innerText().catch(() => "");
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 })
    .then((response) => response ? "navigation" as const : "same-document" as const)
    .catch(() => null);
  const sameDocument = page.waitForFunction(
    ({ url, text }) => location.href === url && (document.body?.innerText ?? "") !== text,
    { url: beforeUrl, text: beforeText },
    { timeout: 15_000 },
  ).then(() => "same-document" as const).catch(() => null);
  await form.evaluate((element, submitterIndex) => {
    const formElement = element as HTMLFormElement;
    const submitters = formElement.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"], input[type="submit"], button:not([type]), input[type="image"]',
    );
    const submitter = submitters.item(submitterIndex);
    if (!submitter) throw new Error("Compiled form submitter disappeared before submission.");
    formElement.requestSubmit(submitter);
  }, step.submitter.index);
  const outcome = await Promise.race([navigation, sameDocument]);
  if (!outcome) throw new Error(`Submitting ${step.questionKey} produced no observable page change.`);
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
  return outcome;
}

export async function demonstrateFormWorkflow(
  page: Page,
  startUrl: string,
  answers: FormWorkflowAnswers,
  maximumSteps = 10,
): Promise<FormWorkflowDemonstration> {
  const startedAt = performance.now();
  const origin = new URL(startUrl).origin;
  const steps: ObservedFormStep[] = [];
  const answerKeys = Object.keys(answers);
  let navigations = 1;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertSameOrigin(new URL(page.url()), origin, "Browser workflow");

  while (steps.length < maximumSteps) {
    const html = await page.content();
    const step = inspectFormPage(html, page.url(), { answerKeys });
    if (!step) {
      const extracted = extractMainResult(html, page.url());
      return {
        steps,
        inputHash: hashFormInput(answers),
        result: {
          ...extracted,
          questionKeys: steps.map((candidate) => candidate.questionKey),
          requests: navigations,
          navigations,
          durationMs: performance.now() - startedAt,
        },
      };
    }
    if (steps.some((candidate) => candidate.questionKey === step.questionKey && candidate.formSignature === step.formSignature)) {
      const extracted = extractMainResult(html, page.url());
      return {
        steps,
        inputHash: hashFormInput(answers),
        result: {
          ...extracted,
          questionKeys: steps.map((candidate) => candidate.questionKey),
          requests: navigations,
          navigations,
          durationMs: performance.now() - startedAt,
        },
      };
    }
    const answer = answers[step.questionKey];
    if (!answer) throw new Error(`No guided answer was provided for question ${step.questionKey}.`);
    await fillBrowserForm(page, step, answer);
    const transition = await submitBrowserForm(page, step);
    step.transition = transition;
    steps.push(step);
    if (transition === "navigation") navigations += 1;
    assertSameOrigin(new URL(page.url()), origin, "Browser workflow");
  }
  throw new Error(`Workflow exceeded the ${maximumSteps}-step safety limit.`);
}

export function compileFormWorkflow(
  action: string,
  startUrl: string,
  demonstrations: FormWorkflowDemonstration[],
): FormWorkflowPlan {
  if (demonstrations.length === 0) throw new Error("At least one demonstration is required.");
  const first = demonstrations[0]!;
  if (first.steps.length === 0) throw new Error("Demonstration did not contain a compilable form step.");
  for (const demonstration of demonstrations.slice(1)) {
    if (demonstration.steps.length !== first.steps.length) throw new Error("Demonstrations followed different branches.");
    demonstration.steps.forEach((step, index) => assertObservedStep(first.steps[index]!, step));
  }
  const url = new URL(startUrl);
  const finalHeadingHashes = [...new Set(demonstrations.map((demonstration) => {
    if (!demonstration.result.heading) throw new Error("Demonstrated result is missing a final heading.");
    return hashText(demonstration.result.heading);
  }))];
  const finalContentSelector = first.result.resultSelector;
  if (demonstrations.some((demonstration) => demonstration.result.resultSelector !== finalContentSelector)) {
    throw new Error("Demonstrations used different final result regions.");
  }
  const finalHeadingMode = finalHeadingHashes.length === 1 ? "one-of" : "present";
  return {
    formatVersion: "clapping-hands.dev/v1alpha2",
    engine: "html-form-v2",
    action,
    version: 1,
    effect: "read",
    origin: url.origin,
    startPath: normalizedPath(url),
    status: demonstrations.length >= 2 ? "provisional" : "candidate",
    steps: first.steps,
    validation: {
      maximumSteps: 10,
      finalContentSelector,
      finalHeadingMode,
      finalHeadingHashes: finalHeadingMode === "one-of" ? finalHeadingHashes : [],
    },
    evidence: {
      demonstrationInputHashes: [...new Set(demonstrations.map((demonstration) => demonstration.inputHash))],
      successfulShadowInputHashes: [],
      failedShadowCount: 0,
      lastValidatedAt: null,
    },
  };
}

function successfulFields(html: string, step: ObservedFormStep, answers: FormStepAnswers): URLSearchParams {
  assertAnswerMatches(step, answers);
  const $ = load(html);
  const form = $("form").eq(step.formIndex);
  const fields = new URLSearchParams();
  const emittedAnswers = new Set<string>();
  form.find("input[name], select[name], textarea[name]").each((_index, element) => {
    const candidate = $(element);
    if (candidate.is(":disabled") || candidate.closest("fieldset[disabled]").length > 0) return;
    const name = candidate.attr("name")!;
    const tag = element.tagName;
    const type = (candidate.attr("type") ?? "text").toLowerCase();
    if (["submit", "button", "reset", "image", "file"].includes(type)) return;
    const supplied = answers[name];
    const suppliedValues = supplied === undefined ? null : Array.isArray(supplied) ? supplied : [supplied];
    if (tag === "input" && (type === "radio" || type === "checkbox")) {
      const value = candidate.attr("value") ?? "on";
      if (suppliedValues ? suppliedValues.includes(value) : candidate.is("[checked]")) fields.append(name, value);
      return;
    }
    if (emittedAnswers.has(name)) return;
    emittedAnswers.add(name);
    if (suppliedValues) {
      suppliedValues.forEach((value) => fields.append(name, value));
      return;
    }
    if (tag === "select") {
      const selected = candidate.find("option[selected]");
      const options = selected.length > 0 ? selected : candidate.find("option").first();
      options.each((_optionIndex, option) => fields.append(name, $(option).attr("value") ?? $(option).text()));
      return;
    }
    fields.append(name, tag === "textarea" ? candidate.text() : candidate.attr("value") ?? "");
  });
  if (step.submitter.name) fields.append(step.submitter.name, step.submitter.value ?? "");
  return fields;
}

async function requestHtml(
  request: APIRequestContext,
  url: URL,
  method: "GET" | "POST",
  allowedOrigin: string,
  fields?: URLSearchParams,
) {
  let requestUrl = method === "GET" && fields
    ? new URL(`${url.href}${url.search ? "&" : "?"}${fields.toString()}`)
    : url;
  let requestMethod = method;
  let requestFields = fields;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    assertSameOrigin(requestUrl, allowedOrigin, "Compiled request");
    const response = requestMethod === "GET"
      ? await request.get(requestUrl.href, { failOnStatusCode: false, maxRedirects: 0, timeout: 30_000 })
      : await request.post(requestUrl.href, {
        data: requestFields?.toString() ?? "",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: 30_000,
      });
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers().location;
      if (!location) throw new Error(`Compiled redirect returned HTTP ${status} without a Location header.`);
      if (redirectCount === 5) throw new Error("Compiled request exceeded the redirect safety limit.");
      const target = new URL(location, requestUrl);
      assertSameOrigin(target, allowedOrigin, "Compiled redirect");
      if (status === 303 || ((status === 301 || status === 302) && requestMethod === "POST")) {
        requestMethod = "GET";
        requestFields = undefined;
      }
      requestUrl = target;
      continue;
    }
    if (!response.ok()) throw new Error(`Compiled request returned HTTP ${status}.`);
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("text/html")) throw new Error(`Compiled request returned ${contentType || "an unknown content type"}.`);
    return { html: await response.text(), url: response.url() };
  }
  throw new Error("Compiled request exceeded the redirect safety limit.");
}

export async function replayFormWorkflow(
  context: BrowserContext,
  plan: FormWorkflowPlan,
  answers: FormWorkflowAnswers,
): Promise<FormWorkflowResult> {
  assertFormWorkflowPlanSafety(plan);
  const nonNavigating = plan.steps.find((step) => step.transition !== "navigation" && step.method !== "GET");
  if (nonNavigating) {
    throw new Error(`Step ${nonNavigating.questionKey} requires deterministic browser replay, not direct form requests.`);
  }
  const startedAt = performance.now();
  const start = new URL(plan.startPath, plan.origin);
  assertSameOrigin(start, plan.origin, "Compiled workflow");
  let response = await requestHtml(context.request, start, "GET", plan.origin);
  let requests = 1;
  const questionKeys: string[] = [];

  for (const expected of plan.steps) {
    const current = new URL(response.url);
    assertSameOrigin(current, plan.origin, "Compiled workflow");
    const actual = inspectFormPage(response.html, response.url, { expected });
    if (!actual) throw new Error(`Expected question ${expected.questionKey}, but the workflow ended early.`);
    assertObservedStep(expected, actual);
    const answer = answers[actual.questionKey];
    if (!answer) throw new Error(`No guided answer was provided for question ${actual.questionKey}.`);
    const fields = successfulFields(response.html, actual, answer);
    const action = new URL(actual.actionPath, plan.origin);
    assertSameOrigin(action, plan.origin, "Compiled form action");
    response = await requestHtml(context.request, action, actual.method, plan.origin, fields);
    requests += 1;
    questionKeys.push(actual.questionKey);
  }

  assertSameOrigin(new URL(response.url), plan.origin, "Compiled result");
  const extracted = extractMainResult(response.html, response.url, plan.validation.finalContentSelector);
  validateFinalResult(plan, extracted);
  return {
    ...extracted,
    questionKeys,
    requests,
    navigations: 0,
    durationMs: performance.now() - startedAt,
  };
}

function validateFinalResult(
  plan: FormWorkflowPlan,
  result: Pick<FormWorkflowResult, "heading" | "mainText">,
): void {
  if (!result.heading) throw new Error("Compiled response did not contain a final result heading.");
  if (/\b(?:sign[ -]?in|log[ -]?in|session expired|captcha|checkpoint|access denied|verify (?:you|your identity))\b/i.test(
    `${result.heading} ${result.mainText.slice(0, 500)}`,
  )) {
    throw new Error("Compiled response appears to be an authentication or access-control page.");
  }
  if (
    plan.validation.finalHeadingMode === "one-of" &&
    !plan.validation.finalHeadingHashes.includes(hashText(result.heading))
  ) {
    throw new Error("Compiled response did not match a demonstrated final result heading.");
  }
}

export async function replayFormWorkflowInBrowser(
  page: Page,
  plan: FormWorkflowPlan,
  answers: FormWorkflowAnswers,
): Promise<FormWorkflowResult> {
  assertFormWorkflowPlanSafety(plan);
  const startedAt = performance.now();
  const start = new URL(plan.startPath, plan.origin);
  await page.goto(start.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertSameOrigin(new URL(page.url()), plan.origin, "Browser replay");
  let navigations = 1;
  const questionKeys: string[] = [];
  for (const expected of plan.steps) {
    const actual = inspectFormPage(await page.content(), page.url(), { expected });
    if (!actual) throw new Error(`Expected question ${expected.questionKey}, but the browser workflow ended early.`);
    assertObservedStep(expected, actual);
    const answer = answers[expected.questionKey];
    if (!answer) throw new Error(`No guided answer was provided for question ${expected.questionKey}.`);
    await fillBrowserForm(page, actual, answer);
    const transition = await submitBrowserForm(page, actual);
    if (transition === "navigation") navigations += 1;
    assertSameOrigin(new URL(page.url()), plan.origin, "Browser replay");
    questionKeys.push(expected.questionKey);
  }
  const extracted = extractMainResult(await page.content(), page.url(), plan.validation.finalContentSelector);
  validateFinalResult(plan, extracted);
  return {
    ...extracted,
    questionKeys,
    requests: navigations,
    navigations,
    durationMs: performance.now() - startedAt,
  };
}

export function recordFormShadow(plan: FormWorkflowPlan, inputHash: string, matches: boolean): FormWorkflowPlan {
  const updated = structuredClone(plan);
  if (matches) {
    if (!updated.evidence.successfulShadowInputHashes.includes(inputHash)) {
      updated.evidence.successfulShadowInputHashes.push(inputHash);
    }
    updated.evidence.lastValidatedAt = new Date().toISOString();
    if (updated.evidence.demonstrationInputHashes.length >= 2 && updated.evidence.successfulShadowInputHashes.length >= 2) {
      updated.status = "stable";
    }
  } else {
    updated.evidence.failedShadowCount += 1;
    updated.status = "degraded";
  }
  return updated;
}

export class FormWorkflowPlanStore {
  constructor(private readonly path: string) {}

  async load(): Promise<FormWorkflowPlan | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as FormWorkflowPlan;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(plan: FormWorkflowPlan): Promise<void> {
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
