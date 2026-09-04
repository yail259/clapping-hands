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
  optionValues: string[];
};

export type ObservedFormStep = {
  questionKey: string;
  pagePath: string;
  method: "GET" | "POST";
  actionPath: string;
  controls: FormControl[];
};

export type FormWorkflowPlan = {
  formatVersion: "clapping-hands.dev/v1alpha1";
  engine: "html-form-v1";
  action: string;
  version: number;
  effect: "read";
  origin: string;
  startPath: string;
  status: "candidate" | "provisional" | "stable" | "degraded";
  steps: ObservedFormStep[];
  validation: {
    maximumSteps: number;
    finalContentSelector: "main";
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

export function extractMainResult(html: string, url: string): Omit<FormWorkflowResult, "questionKeys" | "requests" | "navigations" | "durationMs"> {
  const $ = load(html);
  const main = $("main").first();
  if (main.length !== 1) throw new Error("Final page did not contain exactly one main result region.");
  // Compare the task result, not page furniture whose text can change after
  // client-side enhancement (for example an expandable GOV.UK step nav).
  main.find("script, style, form, .govuk-feedback, .gem-c-feedback, .gem-c-contextual-sidebar").remove();
  main.find("h1, h2, h3, h4, h5, h6, p, li, dt, dd, section, article, div, aside, br").after(" ");
  const mainText = normalizedText(main.text());
  if (!mainText) throw new Error("Final page main result region was empty.");
  const heading = normalizedText(main.find("h1").first().text()) || null;
  return {
    finalUrl: url,
    heading,
    mainText,
    resultHash: hashText(mainText),
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

export function inspectFormPage(html: string, currentUrl: string): ObservedFormStep | null {
  const current = new URL(currentUrl);
  const $ = load(html);
  const forms = $("form[data-question-key]");
  if (forms.length === 0) return null;
  if (forms.length !== 1) throw new Error(`Expected one active workflow form, found ${forms.length}.`);
  const form = forms.first();
  const questionKey = normalizedText(form.attr("data-question-key") ?? "");
  if (!questionKey) throw new Error("Workflow form is missing data-question-key.");
  const method = (form.attr("method") ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") throw new Error(`Unsupported form method ${method}.`);
  const action = new URL(form.attr("action") || current.href, current);
  assertSameOrigin(action, current.origin, "Form action");
  if (form.find('input[type="file"]').length > 0) throw new Error("File uploads require a separately gated compiler.");

  const grouped = new Map<string, FormControl>();
  form.find("input[name], select[name], textarea[name]").each((_index, element) => {
    const candidate = $(element);
    if (candidate.is(":disabled")) return;
    const name = candidate.attr("name") ?? "";
    if (!name) return;
    const kind = controlKind(element.tagName, candidate.attr("type")?.toLowerCase());
    if (!kind) return;
    const existing = grouped.get(name);
    const optionValues = kind === "select"
      ? candidate.find("option").map((_optionIndex, option) => $(option).attr("value") ?? $(option).text()).get()
      : kind === "radio" || kind === "checkbox"
        ? [candidate.attr("value") ?? "on"]
        : [];
    if (existing) {
      existing.optionValues.push(...optionValues.filter((value) => !existing.optionValues.includes(value)));
    } else {
      grouped.set(name, {
        name,
        kind,
        required: candidate.is("[required]"),
        optionValues,
      });
    }
  });

  return {
    questionKey,
    pagePath: normalizedPath(current),
    method,
    actionPath: normalizedPath(action),
    controls: [...grouped.values()],
  };
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
  const form = page.locator("form[data-question-key]").first();
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
  const expectedControls = expected.controls.map(({ name, kind, optionValues }) => ({ name, kind, optionValues }));
  const actualControls = actual.controls.map(({ name, kind, optionValues }) => ({ name, kind, optionValues }));
  if (
    expected.questionKey !== actual.questionKey ||
    expected.method !== actual.method ||
    expected.actionPath !== actual.actionPath ||
    JSON.stringify(expectedControls) !== JSON.stringify(actualControls)
  ) {
    throw new Error(`Workflow drift at ${actual.questionKey}; compiled plan refused to guess.`);
  }
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
  let navigations = 1;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertSameOrigin(new URL(page.url()), origin, "Browser workflow");

  while (steps.length < maximumSteps) {
    const html = await page.content();
    const step = inspectFormPage(html, page.url());
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
    const answer = answers[step.questionKey];
    if (!answer) throw new Error(`No guided answer was provided for question ${step.questionKey}.`);
    await fillBrowserForm(page, step, answer);
    steps.push(step);
    const submit = page.locator("form[data-question-key]").first().locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    if (await submit.count() !== 1) throw new Error(`No unique submit control found for ${step.questionKey}.`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
      submit.click(),
    ]);
    navigations += 1;
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
  return {
    formatVersion: "clapping-hands.dev/v1alpha1",
    engine: "html-form-v1",
    action,
    version: 1,
    effect: "read",
    origin: url.origin,
    startPath: normalizedPath(url),
    status: demonstrations.length >= 2 ? "provisional" : "candidate",
    steps: first.steps,
    validation: { maximumSteps: 10, finalContentSelector: "main", finalHeadingHashes },
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
  const form = $("form[data-question-key]").first();
  const fields = new URLSearchParams();
  form.find('input[type="hidden"][name]').each((_index, element) => {
    const candidate = $(element);
    fields.append(candidate.attr("name")!, candidate.attr("value") ?? "");
  });
  for (const [name, raw] of Object.entries(answers)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) fields.append(name, value);
  }
  const submit = form.find('button[type="submit"][name], input[type="submit"][name], button:not([type])[name]').first();
  if (submit.length) fields.append(submit.attr("name")!, submit.attr("value") ?? submit.text());
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
  const startedAt = performance.now();
  const start = new URL(plan.startPath, plan.origin);
  assertSameOrigin(start, plan.origin, "Compiled workflow");
  let response = await requestHtml(context.request, start, "GET", plan.origin);
  let requests = 1;
  const questionKeys: string[] = [];

  for (const expected of plan.steps) {
    const current = new URL(response.url);
    assertSameOrigin(current, plan.origin, "Compiled workflow");
    const actual = inspectFormPage(response.html, response.url);
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

  if (inspectFormPage(response.html, response.url)) {
    throw new Error("Workflow entered an uncompiled branch; compiled plan refused to continue.");
  }
  assertSameOrigin(new URL(response.url), plan.origin, "Compiled result");
  const extracted = extractMainResult(response.html, response.url);
  if (!extracted.heading || !plan.validation.finalHeadingHashes.includes(hashText(extracted.heading))) {
    throw new Error("Compiled response did not match a demonstrated final result heading.");
  }
  return {
    ...extracted,
    questionKeys,
    requests,
    navigations: 0,
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
