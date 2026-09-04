import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import type {
  BrowserAction,
  BrowserActResult,
  BrowserLearnerLease,
} from "./browser-learner.js";

export type DomInput = Record<string, string | number | boolean>;

type InputReference = { $clappingHandsInput: string };
type TemplatePart = string | InputReference;

export type DomActionTemplate = {
  selector: TemplatePart[];
  method: DomActionMethod;
  arguments: TemplatePart[][];
};

export type DomActionMethod =
  | "click"
  | "fill"
  | "type"
  | "press"
  | "selectOption"
  | "check"
  | "uncheck"
  | "hover"
  | "scrollIntoViewIfNeeded";

export type DomOutputSnapshot = {
  selector: string;
  tagName: string;
  text: string;
  textHash: string;
  url: string;
};

export type DomWorkflowDemonstration = {
  input: DomInput;
  actions: BrowserAction[];
  output: DomOutputSnapshot;
  modelCalls: number;
  instructions?: string[];
};

export type DomWorkflowPlan = {
  formatVersion: "clapping-hands.dev/v1alpha2";
  engine: "stagehand-action-v1";
  action: string;
  version: number;
  effect: {
    level: "read" | "write";
    commitActionIndex: number | null;
    confirmation: string | null;
  };
  origin: string;
  startPath: string;
  status: "candidate" | "provisional" | "stable" | "degraded";
  inputNames: string[];
  actions: DomActionTemplate[];
  repairInstructions: TemplatePart[][];
  validation: {
    maximumActions: number;
    outputSelector: string;
    outputTagName: string;
    outputMode: "one-of" | "present";
    outputTextHashes: string[];
  };
  evidence: {
    demonstrationInputHashes: string[];
    successfulShadowInputHashes: string[];
    failedShadowCount: number;
    lastValidatedAt: string | null;
  };
};

export type DomWorkflowResult = DomOutputSnapshot & {
  actions: number;
  navigations: number;
  modelCalls: number;
  durationMs: number;
};

const SUPPORTED_METHODS = new Set<DomActionMethod>([
  "click",
  "fill",
  "type",
  "press",
  "selectOption",
  "check",
  "uncheck",
  "hover",
  "scrollIntoViewIfNeeded",
]);
const SENSITIVE_INPUT_NAME = /(?:password|passwd|secret|token|csrf|xsrf|session|cookie|authorization|api[_-]?key)/i;
const MAX_ACTIONS = 30;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function assertSameOrigin(url: string, origin: string, label: string): void {
  const actual = new URL(url);
  if (actual.origin !== origin) throw new Error(`${label} left the allowed origin: ${actual.origin}`);
}

function normalizeMethod(action: BrowserAction): DomActionMethod {
  const method = action.method ?? "click";
  if (!SUPPORTED_METHODS.has(method as DomActionMethod)) {
    throw new Error(`Unsupported learned DOM method ${method}.`);
  }
  return method as DomActionMethod;
}

function looksHighEntropy(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(value) ||
    (value.length >= 48 && /^[A-Za-z0-9+/_=-]+$/.test(value) && new Set(value).size >= 12);
}

function splitByInputs(
  values: string[],
  demonstrations: DomWorkflowDemonstration[],
  inputNames: string[],
  bound: Set<string>,
  rejectHighEntropyConstant = false,
): TemplatePart[] {
  if (new Set(values).size === 1) {
    if (rejectHighEntropyConstant && looksHighEntropy(values[0]!)) {
      throw new Error("Refusing to persist a high-entropy DOM action argument constant.");
    }
    return [values[0]!];
  }

  const sentinels = new Map<string, string>();
  const skeletons = values.map((value, index) => {
    let skeleton = value;
    for (const inputName of inputNames) {
      const raw = String(demonstrations[index]!.input[inputName]);
      if (!raw || !skeleton.includes(raw)) continue;
      const sentinel = `\u0000${inputName}\u0000`;
      sentinels.set(sentinel, inputName);
      skeleton = skeleton.split(raw).join(sentinel);
    }
    return skeleton;
  });
  if (new Set(skeletons).size !== 1) {
    throw new Error("A learned selector or argument varied without a demonstrated input binding.");
  }
  const skeleton = skeletons[0]!;
  const pattern = /\u0000([^\u0000]+)\u0000/g;
  const parts: TemplatePart[] = [];
  let offset = 0;
  for (const match of skeleton.matchAll(pattern)) {
    if (match.index! > offset) parts.push(skeleton.slice(offset, match.index));
    const inputName = sentinels.get(match[0]);
    if (!inputName) throw new Error("Invalid DOM input template.");
    parts.push({ $clappingHandsInput: inputName });
    bound.add(inputName);
    offset = match.index! + match[0].length;
  }
  if (offset < skeleton.length) parts.push(skeleton.slice(offset));
  if (parts.length === 0) throw new Error("A learned DOM action varied without a safe input binding.");
  return parts;
}

function actionAt(demonstration: DomWorkflowDemonstration, index: number): BrowserAction {
  const action = demonstration.actions[index];
  if (!action) throw new Error("DOM demonstrations contained different action counts.");
  return action;
}

export function compileDomWorkflow(
  action: string,
  startUrl: string,
  demonstrations: DomWorkflowDemonstration[],
  options: { effect?: "read" | "write"; confirmation?: string } = {},
): DomWorkflowPlan {
  if (demonstrations.length < 2) throw new Error("Two distinct DOM demonstrations are required.");
  const start = new URL(startUrl);
  const inputNames = Object.keys(demonstrations[0]!.input).sort();
  if (inputNames.length === 0) throw new Error("DOM demonstrations require at least one input.");
  if (inputNames.some((name) => SENSITIVE_INPUT_NAME.test(name))) {
    throw new Error("Secrets and authentication material cannot be compiled as DOM tool inputs.");
  }
  for (const demonstration of demonstrations) {
    if (JSON.stringify(Object.keys(demonstration.input).sort()) !== JSON.stringify(inputNames)) {
      throw new Error("DOM demonstrations must use the same input schema.");
    }
    assertSameOrigin(demonstration.output.url, start.origin, "DOM demonstration");
  }
  for (const inputName of inputNames) {
    if (new Set(demonstrations.map((demo) => JSON.stringify(demo.input[inputName]))).size < 2) {
      throw new Error(`Input ${inputName} did not vary across demonstrations.`);
    }
  }
  const actionCount = demonstrations[0]!.actions.length;
  if (actionCount === 0 || actionCount > MAX_ACTIONS) {
    throw new Error(`DOM demonstration must contain 1-${MAX_ACTIONS} learned actions.`);
  }
  if (demonstrations.some((demo) => demo.actions.length !== actionCount)) {
    throw new Error("DOM demonstrations contained different action counts.");
  }

  const bound = new Set<string>();
  const templates: DomActionTemplate[] = [];
  for (let index = 0; index < actionCount; index += 1) {
    const actions = demonstrations.map((demo) => actionAt(demo, index));
    const methods = actions.map(normalizeMethod);
    if (new Set(methods).size !== 1) throw new Error(`Learned DOM method drift at action ${index + 1}.`);
    const argumentCounts = actions.map((candidate) => candidate.arguments?.length ?? 0);
    if (new Set(argumentCounts).size !== 1) throw new Error(`Learned DOM argument drift at action ${index + 1}.`);
    templates.push({
      selector: splitByInputs(actions.map((candidate) => candidate.selector), demonstrations, inputNames, bound),
      method: methods[0]!,
      arguments: Array.from({ length: argumentCounts[0]! }, (_unused, argumentIndex) => splitByInputs(
        actions.map((candidate) => candidate.arguments![argumentIndex]!),
        demonstrations,
        inputNames,
        bound,
        true,
      )),
    });
  }
  const unbound = inputNames.filter((name) => !bound.has(name));
  if (unbound.length > 0) throw new Error(`Could not bind DOM inputs: ${unbound.join(", ")}.`);

  let repairInstructions: TemplatePart[][] = [];
  if (demonstrations.every((demo) => demo.instructions)) {
    const instructionCounts = demonstrations.map((demo) => demo.instructions!.length);
    if (new Set(instructionCounts).size !== 1) throw new Error("DOM demonstrations used different repair instruction counts.");
    repairInstructions = Array.from({ length: instructionCounts[0]! }, (_unused, index) => splitByInputs(
      demonstrations.map((demo) => demo.instructions![index]!),
      demonstrations,
      inputNames,
      new Set<string>(),
      true,
    ));
  }

  const outputSelector = demonstrations[0]!.output.selector;
  const outputTagName = demonstrations[0]!.output.tagName;
  if (demonstrations.some((demo) => demo.output.selector !== outputSelector || demo.output.tagName !== outputTagName)) {
    throw new Error("DOM demonstrations used different output regions.");
  }
  const outputTextHashes = [...new Set(demonstrations.map((demo) => demo.output.textHash))];
  const outputMode = outputTextHashes.length === 1 ? "one-of" : "present";
  const effectLevel = options.effect ?? "read";
  const confirmation = options.confirmation?.trim() || null;
  if (effectLevel === "write" && !confirmation) {
    throw new Error("Write workflows require a plain-language confirmation description.");
  }
  if (confirmation && confirmation.length > 240) {
    throw new Error("Write confirmation descriptions are limited to 240 characters.");
  }
  return {
    formatVersion: "clapping-hands.dev/v1alpha2",
    engine: "stagehand-action-v1",
    action,
    version: 1,
    effect: {
      level: effectLevel,
      commitActionIndex: effectLevel === "write" ? templates.length - 1 : null,
      confirmation: effectLevel === "write" ? confirmation : null,
    },
    origin: start.origin,
    startPath: normalizedPath(start),
    status: "provisional",
    inputNames,
    actions: templates,
    repairInstructions,
    validation: {
      maximumActions: MAX_ACTIONS,
      outputSelector,
      outputTagName,
      outputMode,
      outputTextHashes: outputMode === "one-of" ? outputTextHashes : [],
    },
    evidence: {
      demonstrationInputHashes: demonstrations.map((demo) => hash(demo.input)),
      successfulShadowInputHashes: [],
      failedShadowCount: 0,
      lastValidatedAt: null,
    },
  };
}

function materialize(parts: TemplatePart[], input: DomInput): string {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    const name = part.$clappingHandsInput;
    if (!(name in input)) throw new Error(`Missing compiled input ${name}.`);
    return String(input[name]);
  }).join("");
}

function materializeAction(template: DomActionTemplate, input: DomInput): BrowserAction {
  return {
    selector: materialize(template.selector, input),
    description: `Compiled ${template.method} action`,
    method: template.method,
    arguments: template.arguments.map((argument) => materialize(argument, input)),
  };
}

export async function captureDomOutput(page: Page, selector: string): Promise<DomOutputSnapshot> {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count !== 1) throw new Error(`Expected one DOM output region for ${selector}, found ${count}.`);
  if (!await locator.isVisible()) throw new Error(`DOM output region ${selector} was not visible.`);
  const text = normalizedText(await locator.innerText());
  if (!text) throw new Error("DOM output region was empty.");
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  return { selector, tagName, text, textHash: hashText(text), url: page.url() };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
}

async function outputTextIfPresent(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) return null;
  if (!await locator.isVisible().catch(() => false)) return null;
  return normalizedText(await locator.innerText().catch(() => "")) || null;
}

async function waitForOutputChange(page: Page, selector: string, before: string | null): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await outputTextIfPresent(page, selector);
    if (current && current !== before) return;
    await delay(50);
  }
}

export async function demonstrateDomWorkflow(
  lease: Pick<BrowserLearnerLease, "act">,
  page: Page,
  startUrl: string,
  input: DomInput,
  instructions: string[],
  outputSelector: string,
): Promise<DomWorkflowDemonstration> {
  const origin = new URL(startUrl).origin;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const actions: BrowserAction[] = [];
  let modelCalls = 0;
  for (const instruction of instructions) {
    const result = await lease.act(instruction);
    if (!result.success) throw new Error(`Browser learner failed: ${result.message}`);
    actions.push(...result.actions);
    modelCalls += result.modelCalls;
    if (actions.length > MAX_ACTIONS) throw new Error(`DOM demonstration exceeded ${MAX_ACTIONS} actions.`);
    await settle(page);
    assertSameOrigin(page.url(), origin, "DOM demonstration");
  }
  return { input, actions, output: await captureDomOutput(page, outputSelector), modelCalls, instructions };
}

async function executePlaywrightAction(page: Page, action: BrowserAction): Promise<void> {
  const locator = page.locator(action.selector);
  if (await locator.count() !== 1) {
    throw new Error(`Compiled selector matched ${await locator.count()} elements: ${action.selector}`);
  }
  const args = action.arguments ?? [];
  switch (normalizeMethod(action)) {
    case "click": await locator.click(); break;
    case "fill": await locator.fill(args[0] ?? ""); break;
    case "type": await locator.pressSequentially(args[0] ?? ""); break;
    case "press": await locator.press(args[0] ?? "Enter"); break;
    case "selectOption": await locator.selectOption(args); break;
    case "check": await locator.check(); break;
    case "uncheck": await locator.uncheck(); break;
    case "hover": await locator.hover(); break;
    case "scrollIntoViewIfNeeded": await locator.scrollIntoViewIfNeeded(); break;
  }
}

export function validateDomOutput(plan: DomWorkflowPlan, output: DomOutputSnapshot): void {
  assertSameOrigin(output.url, plan.origin, "Compiled DOM replay");
  if (output.tagName !== plan.validation.outputTagName) {
    throw new Error("Compiled DOM output changed element type.");
  }
  if (plan.validation.outputMode === "one-of" && !plan.validation.outputTextHashes.includes(output.textHash)) {
    throw new Error("Compiled DOM output did not match the demonstrated result.");
  }
  if (/\b(?:sign[ -]?in|log[ -]?in|session expired|captcha|checkpoint|access denied|verify (?:you|your identity))\b/i.test(output.text.slice(0, 500))) {
    throw new Error("Compiled DOM output appears to be an authentication or access-control page.");
  }
}

export async function replayDomWorkflow(
  page: Page,
  plan: DomWorkflowPlan,
  input: DomInput,
): Promise<DomWorkflowResult> {
  if (plan.effect.level !== "read") {
    throw new Error("Write workflows require prepareDomWorkflowWrite and commitPreparedDomWorkflowWrite.");
  }
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(plan.inputNames)) {
    throw new Error(`Compiled input keys must be exactly: ${plan.inputNames.join(", ")}.`);
  }
  if (plan.actions.length > plan.validation.maximumActions) throw new Error("Compiled DOM action budget exceeded.");
  const startedAt = performance.now();
  await page.goto(new URL(plan.startPath, plan.origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  let navigations = 1;
  for (const [index, template] of plan.actions.entries()) {
    const beforeUrl = page.url();
    const beforeOutput = index === plan.actions.length - 1
      ? await outputTextIfPresent(page, plan.validation.outputSelector)
      : null;
    await executePlaywrightAction(page, materializeAction(template, input));
    await settle(page);
    if (index === plan.actions.length - 1) {
      await waitForOutputChange(page, plan.validation.outputSelector, beforeOutput);
    }
    assertSameOrigin(page.url(), plan.origin, "Compiled DOM replay");
    if (page.url() !== beforeUrl) navigations += 1;
  }
  const output = await captureDomOutput(page, plan.validation.outputSelector);
  validateDomOutput(plan, output);
  return {
    ...output,
    actions: plan.actions.length,
    navigations,
    modelCalls: 0,
    durationMs: performance.now() - startedAt,
  };
}

export async function replayDomWorkflowWithStagehand(
  lease: BrowserLearnerLease,
  page: Page,
  plan: DomWorkflowPlan,
  input: DomInput,
): Promise<DomWorkflowResult> {
  if (plan.effect.level !== "read") {
    throw new Error("Write workflows require an explicit prepare/commit lifecycle.");
  }
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(plan.inputNames)) {
    throw new Error(`Compiled input keys must be exactly: ${plan.inputNames.join(", ")}.`);
  }
  const startedAt = performance.now();
  await page.goto(new URL(plan.startPath, plan.origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  let navigations = 1;
  for (const [index, template] of plan.actions.entries()) {
    const beforeUrl = page.url();
    const beforeOutput = index === plan.actions.length - 1
      ? await outputTextIfPresent(page, plan.validation.outputSelector)
      : null;
    const result: BrowserActResult = await lease.act(materializeAction(template, input));
    if (!result.success) throw new Error(`Compiled DOM action failed: ${result.message}`);
    if (result.modelCalls !== 0) throw new Error("Compiled DOM replay unexpectedly invoked a model.");
    await settle(page);
    if (index === plan.actions.length - 1) {
      await waitForOutputChange(page, plan.validation.outputSelector, beforeOutput);
    }
    assertSameOrigin(page.url(), plan.origin, "Compiled DOM replay");
    if (page.url() !== beforeUrl) navigations += 1;
  }
  const output = await captureDomOutput(page, plan.validation.outputSelector);
  validateDomOutput(plan, output);
  return { ...output, actions: plan.actions.length, navigations, modelCalls: 0, durationMs: performance.now() - startedAt };
}

export async function repairDomWorkflow(
  lease: Pick<BrowserLearnerLease, "act">,
  page: Page,
  plan: DomWorkflowPlan,
  input: DomInput,
): Promise<DomWorkflowResult> {
  if (plan.effect.level !== "read") throw new Error("Semantic repair cannot cross a write effect boundary.");
  if (plan.repairInstructions.length === 0) throw new Error("This workflow has no redacted semantic repair recipe.");
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(plan.inputNames)) {
    throw new Error(`Compiled input keys must be exactly: ${plan.inputNames.join(", ")}.`);
  }
  const startedAt = performance.now();
  await page.goto(new URL(plan.startPath, plan.origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  let modelCalls = 0;
  let actions = 0;
  let navigations = 1;
  for (const instruction of plan.repairInstructions) {
    const beforeUrl = page.url();
    const result = await lease.act(materialize(instruction, input));
    if (!result.success) throw new Error(`Semantic repair failed: ${result.message}`);
    modelCalls += result.modelCalls;
    actions += result.actions.length;
    await settle(page);
    assertSameOrigin(page.url(), plan.origin, "Semantic DOM repair");
    if (page.url() !== beforeUrl) navigations += 1;
  }
  const output = await captureDomOutput(page, plan.validation.outputSelector);
  validateDomOutput(plan, output);
  return { ...output, actions, navigations, modelCalls, durationMs: performance.now() - startedAt };
}

export function recordDomShadow(plan: DomWorkflowPlan, input: DomInput, matches: boolean): DomWorkflowPlan {
  const updated = structuredClone(plan);
  const inputHash = hash(input);
  if (matches) {
    if (!updated.evidence.successfulShadowInputHashes.includes(inputHash)) {
      updated.evidence.successfulShadowInputHashes.push(inputHash);
    }
    updated.evidence.lastValidatedAt = new Date().toISOString();
    if (updated.evidence.successfulShadowInputHashes.length >= 2) updated.status = "stable";
  } else {
    updated.evidence.failedShadowCount += 1;
    updated.status = "degraded";
  }
  return updated;
}
