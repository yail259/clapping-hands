import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Frame, FrameLocator, Locator, Page } from "playwright-core";
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
  opensNewPage?: boolean;
  framePath?: TemplatePart[][];
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
  framePath?: string[];
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
  allowedNetworkOrigins?: string[];
  startPath: string;
  status: "candidate" | "provisional" | "stable" | "degraded";
  inputNames: string[];
  actions: DomActionTemplate[];
  repairInstructions: TemplatePart[][];
  validation: {
    maximumActions: number;
    outputChangeTimeoutMs?: number;
    outputSelector: string;
    outputFramePath?: string[];
    outputTagName: string;
    outputMode: "one-of" | "present";
    outputTextHashes: string[];
    minimumOutputCharacters?: number;
    inputEvidenceNames?: string[];
  };
  evidence: {
    demonstrationInputHashes: string[];
    successfulShadowInputHashes: string[];
    successfulShadowCount?: number;
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
const EFFECTFUL_INTENT_LANGUAGE = /\b(?:publish|send|purchase|buy|checkout|place (?:an )?order|delete|post (?:a |the |this )?(?:comment|message|reply|update|review|listing|content)|save|create|approve|transfer|pay|book (?:an? |the )?(?:appointment|room|ticket|table|flight|hotel)|reserve|subscribe|unsubscribe|upload|register|sign up|invite (?:a |the )?(?:user|member|person|collaborator)|follow (?:a |the )?(?:user|person|account|page)|like (?:a |the |this )?(?:post|comment|page|item)|connect with|bid (?:on|for)|make (?:an )?offer|apply (?:for|to)|submit (?:an? |the |this )?(?:application|order|request|claim|registration|response|review|comment|message)|cancel (?:an? |the |this )?(?:booking|reservation|order|subscription|appointment)|remove (?:an? |the |this )?(?:item|record|account|user|member|file|listing|post|comment)|(?:edit|update|change) (?:an? |the |this |my )?(?:profile|address|email|password|booking|reservation|order|listing|record|status|settings|subscription|quantity)|add (?:an? |the |this )?(?:item )?to (?:cart|basket|wishlist))\b/i;
const EFFECTFUL_CONTROL_LANGUAGE = /^(?:click|press|choose|select)?\s*(?:the\s+)?(?:publish|send|purchase|buy|checkout|delete|post|save|create|approve|transfer|pay|book|reserve|subscribe|unsubscribe|follow|like|upload|register|sign up|invite|add to (?:cart|basket|wishlist)|submit (?:application|order|request|claim|registration|response|review|comment|message))(?:\s+(?:button|link|item|post|user|member))?\s*$/i;
const MAX_ACTIONS = 30;
const DEFAULT_OUTPUT_CHANGE_TIMEOUT_MS = 10_000;

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

function locatorInFramePath(page: Page, framePath: string[], selector: string): Locator {
  let scope: Page | FrameLocator = page;
  for (const frameSelector of framePath) scope = scope.frameLocator(frameSelector);
  return scope.locator(selector);
}

async function stableFrameElementSelector(frame: Frame): Promise<string> {
  const element = await frame.frameElement();
  return element.evaluate((node) => {
    const ownerDocument = node.ownerDocument;
    if (!ownerDocument) throw new Error("Iframe element is not attached to a document.");
    const element = node as HTMLElement;
    const attributeCandidates: string[] = [];
    for (const [name, value] of [
      ["id", element.id],
      ["data-testid", element.getAttribute("data-testid")],
      ["name", element.getAttribute("name")],
      ["title", element.getAttribute("title")],
    ] as Array<[string, string | null]>) {
      if (!value) continue;
      if (value.length >= 48 && /^[A-Za-z0-9+/_=-]+$/.test(value)) continue;
      attributeCandidates.push(`${element.tagName.toLowerCase()}[${name}="${CSS.escape(value)}"]`);
    }
    for (const selector of attributeCandidates) {
      try {
        if (ownerDocument.querySelectorAll(selector).length === 1) return selector;
      } catch {
        // Try the next safe attribute candidate.
      }
    }

    const segments: string[] = [];
    let current: Element | null = element;
    while (current && current !== ownerDocument.documentElement) {
      const tag = current.tagName.toLowerCase();
      let position = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) position += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(`${tag}:nth-of-type(${Math.max(position, 1)})`);
      const candidate = segments.join(" > ");
      try {
        if (ownerDocument.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // Continue toward a fully qualified element path.
      }
      current = current.parentElement;
    }
    throw new Error("Could not derive a unique selector for an iframe element.");
  });
}

async function framePathFor(frame: Frame, origin: string): Promise<string[]> {
  const frames: Frame[] = [];
  let current: Frame | null = frame;
  while (current?.parentFrame()) {
    const url = current.url();
    if (url !== "about:blank" && url !== "about:srcdoc") assertSameOrigin(url, origin, "DOM frame");
    frames.unshift(current);
    current = current.parentFrame();
  }
  const path: string[] = [];
  for (const nested of frames) path.push(await stableFrameElementSelector(nested));
  return path;
}

async function discoverFramePath(page: Page, selector: string, origin: string): Promise<string[]> {
  const matches: Frame[] = [];
  for (const frame of page.frames()) {
    let count = 0;
    try {
      count = await frame.locator(selector).count();
    } catch {
      continue;
    }
    if (count > 1) throw new Error(`Learned selector matched ${count} elements in one frame: ${selector}`);
    if (count === 1) matches.push(frame);
  }
  if (matches.length !== 1) {
    throw new Error(`Learned selector must match exactly one page or frame context; found ${matches.length}: ${selector}`);
  }
  return matches[0] === page.mainFrame() ? [] : framePathFor(matches[0]!, origin);
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
  options: { effect?: "read" | "write"; confirmation?: string; allowedNetworkOrigins?: string[] } = {},
): DomWorkflowPlan {
  if (demonstrations.length < 2) throw new Error("Two distinct DOM demonstrations are required.");
  const start = new URL(startUrl);
  const allowedNetworkOrigins = [...new Set((options.allowedNetworkOrigins ?? []).map((value) => {
    const candidate = new URL(value);
    if (!new Set(["http:", "https:"]).has(candidate.protocol) || candidate.pathname !== "/" || candidate.search || candidate.hash) {
      throw new Error(`Allowed network origin must not include a path: ${value}`);
    }
    if (start.protocol === "https:" && candidate.protocol !== "https:") {
      throw new Error("An HTTPS workflow cannot allow a plaintext network endpoint.");
    }
    return candidate.origin;
  }))].filter((origin) => origin !== start.origin).sort();
  const inputNames = Object.keys(demonstrations[0]!.input).sort();
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
    const pageTransitions = actions.map((candidate) => Boolean(candidate.opensNewPage));
    if (new Set(pageTransitions).size !== 1) throw new Error(`Learned DOM page-transition drift at action ${index + 1}.`);
    if (pageTransitions[0] && methods[0] !== "click") {
      throw new Error("Only a compiled click action may open a new page.");
    }
    const framePathLengths = actions.map((candidate) => candidate.framePath?.length ?? 0);
    if (new Set(framePathLengths).size !== 1) throw new Error(`Learned DOM frame-path drift at action ${index + 1}.`);
    const framePath = Array.from({ length: framePathLengths[0]! }, (_unused, frameIndex) => splitByInputs(
      actions.map((candidate) => candidate.framePath![frameIndex]!),
      demonstrations,
      inputNames,
      bound,
      false,
    ));
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
      ...(pageTransitions[0] ? { opensNewPage: true } : {}),
      ...(framePath.length > 0 ? { framePath } : {}),
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
  const outputFramePath = demonstrations[0]!.output.framePath ?? [];
  if (demonstrations.some((demo) => demo.output.selector !== outputSelector ||
    demo.output.tagName !== outputTagName ||
    JSON.stringify(demo.output.framePath ?? []) !== JSON.stringify(outputFramePath))) {
    throw new Error("DOM demonstrations used different output regions.");
  }
  const outputTextHashes = [...new Set(demonstrations.map((demo) => demo.output.textHash))];
  const outputMode = outputTextHashes.length === 1 ? "one-of" : "present";
  const effectLevel = options.effect ?? "read";
  const minimumOutputCharacters = Math.max(1, Math.floor(Math.min(
    ...demonstrations.map((demo) => normalizedText(demo.output.text).length),
  ) * 0.25));
  const inputEvidenceNames = effectLevel === "read"
    ? inputNames.filter((name) => demonstrations.every((demo) => {
      const evidence = normalizedText(String(demo.input[name])).toLowerCase();
      return evidence.length > 0 && normalizedText(demo.output.text).toLowerCase().includes(evidence);
    }))
    : [];
  const confirmation = options.confirmation?.trim() || null;
  const demonstratedInstructions = demonstrations.flatMap((demo) => demo.instructions ?? []);
  const demonstratedControls = demonstrations.flatMap((demo) => demo.actions
    .filter((candidate) => (candidate.method ?? "click") === "click")
    .map((candidate) => candidate.description.trim()));
  if (effectLevel === "read" && (
    demonstratedInstructions.some((instruction) => EFFECTFUL_INTENT_LANGUAGE.test(instruction)) ||
    demonstratedControls.some((description) => EFFECTFUL_INTENT_LANGUAGE.test(description) || EFFECTFUL_CONTROL_LANGUAGE.test(description))
  )) {
    throw new Error("This demonstration appears effectful; declare it as a write workflow with an explicit confirmation description.");
  }
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
    ...(allowedNetworkOrigins.length > 0 ? { allowedNetworkOrigins } : {}),
    startPath: normalizedPath(start),
    status: "provisional",
    inputNames,
    actions: templates,
    repairInstructions,
    validation: {
      maximumActions: MAX_ACTIONS,
      outputChangeTimeoutMs: DEFAULT_OUTPUT_CHANGE_TIMEOUT_MS,
      outputSelector,
      ...(outputFramePath.length > 0 ? { outputFramePath } : {}),
      outputTagName,
      outputMode,
      outputTextHashes: outputMode === "one-of" ? outputTextHashes : [],
      minimumOutputCharacters,
      inputEvidenceNames,
    },
    evidence: {
      demonstrationInputHashes: demonstrations.map((demo) => hash(demo.input)),
      successfulShadowInputHashes: [],
      successfulShadowCount: 0,
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
    ...(template.opensNewPage ? { opensNewPage: true } : {}),
    ...(template.framePath ? { framePath: template.framePath.map((segment) => materialize(segment, input)) } : {}),
  };
}

export async function captureDomOutput(page: Page, selector: string, framePath: string[] = []): Promise<DomOutputSnapshot> {
  const locator = locatorInFramePath(page, framePath, selector);
  const count = await locator.count();
  if (count !== 1) throw new Error(`Expected one DOM output region for ${selector}, found ${count}.`);
  if (!await locator.isVisible()) throw new Error(`DOM output region ${selector} was not visible.`);
  const text = normalizedText(await locator.innerText());
  if (!text) throw new Error("DOM output region was empty.");
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  return {
    selector,
    tagName,
    text,
    textHash: hashText(text),
    url: page.url(),
    ...(framePath.length > 0 ? { framePath } : {}),
  };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
}

export async function readDomOutputTextIfPresent(page: Page, selector: string, framePath: string[] = []): Promise<string | null> {
  const locator = locatorInFramePath(page, framePath, selector);
  if (await locator.count() !== 1) return null;
  if (!await locator.isVisible().catch(() => false)) return null;
  return normalizedText(await locator.innerText().catch(() => "")) || null;
}

export async function waitForDomOutputChange(
  page: Page,
  selector: string,
  before: string | null,
  timeoutMs = DEFAULT_OUTPUT_CHANGE_TIMEOUT_MS,
  framePath: string[] = [],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readDomOutputTextIfPresent(page, selector, framePath);
    if (current && current !== before) return;
    await delay(50);
  }
  throw new Error(`DOM output ${selector} did not change after the final action.`);
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
  let activePage = page;
  const actions: BrowserAction[] = [];
  let modelCalls = 0;
  for (const instruction of instructions) {
    const actionPage = activePage;
    const pagesBefore = new Set(page.context().pages());
    const result = await lease.act(instruction);
    if (!result.success) throw new Error(`Browser learner failed: ${result.message}`);
    const learnedActions = result.actions.map((action) => ({ ...action }));
    for (const action of learnedActions) {
      try {
        const framePath = await discoverFramePath(actionPage, action.selector, origin);
        if (framePath.length > 0) action.framePath = framePath;
      } catch (error) {
        // A top-level control may disappear as the result of the action that
        // targeted it. With no child frames there is still only one possible
        // execution context; otherwise failing closed avoids guessing a frame.
        if (actionPage.frames().length > 1) throw error;
      }
    }
    const openedPages = page.context().pages().filter((candidate) => !pagesBefore.has(candidate));
    if (openedPages.length > 1) throw new Error("A single semantic instruction opened more than one page.");
    if (openedPages.length === 1) {
      if (learnedActions.length === 0) throw new Error("The browser learner opened a page without returning its triggering action.");
      learnedActions[learnedActions.length - 1]!.opensNewPage = true;
      activePage = openedPages[0]!;
      await activePage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    }
    actions.push(...learnedActions);
    modelCalls += result.modelCalls;
    if (actions.length > MAX_ACTIONS) throw new Error(`DOM demonstration exceeded ${MAX_ACTIONS} actions.`);
    await settle(activePage);
    assertSameOrigin(activePage.url(), origin, "DOM demonstration");
  }
  const outputFramePath = await discoverFramePath(activePage, outputSelector, origin);
  return {
    input,
    actions,
    output: await captureDomOutput(activePage, outputSelector, outputFramePath),
    modelCalls,
    instructions,
  };
}

async function executePlaywrightAction(page: Page, action: BrowserAction): Promise<Page> {
  const locator = locatorInFramePath(page, action.framePath ?? [], action.selector);
  if (await locator.count() !== 1) {
    throw new Error(`Compiled selector matched ${await locator.count()} elements: ${action.selector}`);
  }
  const args = action.arguments ?? [];
  const method = normalizeMethod(action);
  const pagesBefore = new Set(page.context().pages());
  const openedPage = action.opensNewPage
    ? page.context().waitForEvent("page", { timeout: 10_000 })
    : null;
  switch (method) {
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
  if (!openedPage) {
    const unexpectedPages = page.context().pages().filter((candidate) => !pagesBefore.has(candidate));
    if (unexpectedPages.length > 0) throw new Error("Compiled DOM action opened an undeclared page.");
    return page;
  }
  const nextPage = await openedPage;
  await nextPage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  return nextPage;
}

export function validateDomOutput(plan: DomWorkflowPlan, output: DomOutputSnapshot, input?: DomInput): void {
  assertSameOrigin(output.url, plan.origin, "Compiled DOM replay");
  if (JSON.stringify(output.framePath ?? []) !== JSON.stringify(plan.validation.outputFramePath ?? [])) {
    throw new Error("Compiled DOM output changed frame context.");
  }
  if (output.tagName !== plan.validation.outputTagName) {
    throw new Error("Compiled DOM output changed element type.");
  }
  if (plan.validation.outputMode === "one-of" && !plan.validation.outputTextHashes.includes(output.textHash)) {
    throw new Error("Compiled DOM output did not match the demonstrated result.");
  }
  if (output.text.length < (plan.validation.minimumOutputCharacters ?? 1)) {
    throw new Error("Compiled DOM output was implausibly short relative to the demonstrations.");
  }
  for (const name of plan.validation.inputEvidenceNames ?? []) {
    const evidence = input && name in input ? normalizedText(String(input[name])).toLowerCase() : "";
    if (!evidence || !normalizedText(output.text).toLowerCase().includes(evidence)) {
      throw new Error(`Compiled DOM output did not contain required evidence for input ${name}.`);
    }
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
  let activePage = page;
  let navigations = 1;
  for (const [index, template] of plan.actions.entries()) {
    const beforeUrl = activePage.url();
    const beforeOutput = index === plan.actions.length - 1
      ? await readDomOutputTextIfPresent(activePage, plan.validation.outputSelector, plan.validation.outputFramePath)
      : null;
    activePage = await executePlaywrightAction(activePage, materializeAction(template, input));
    await settle(activePage);
    if (index === plan.actions.length - 1) {
      await waitForDomOutputChange(
        activePage,
        plan.validation.outputSelector,
        beforeOutput,
        plan.validation.outputChangeTimeoutMs,
        plan.validation.outputFramePath,
      );
    }
    assertSameOrigin(activePage.url(), plan.origin, "Compiled DOM replay");
    if (activePage.url() !== beforeUrl) navigations += 1;
  }
  const output = await captureDomOutput(activePage, plan.validation.outputSelector, plan.validation.outputFramePath);
  validateDomOutput(plan, output, input);
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
  let activePage = page;
  let navigations = 1;
  for (const [index, template] of plan.actions.entries()) {
    const beforeUrl = activePage.url();
    const beforeOutput = index === plan.actions.length - 1
      ? await readDomOutputTextIfPresent(activePage, plan.validation.outputSelector, plan.validation.outputFramePath)
      : null;
    const pagesBefore = new Set(activePage.context().pages());
    const result: BrowserActResult = await lease.act(materializeAction(template, input));
    if (!result.success) throw new Error(`Compiled DOM action failed: ${result.message}`);
    if (result.modelCalls !== 0) throw new Error("Compiled DOM replay unexpectedly invoked a model.");
    const openedPages = activePage.context().pages().filter((candidate) => !pagesBefore.has(candidate));
    if (template.opensNewPage) {
      if (openedPages.length !== 1) throw new Error("Compiled DOM action did not open exactly one expected page.");
      activePage = openedPages[0]!;
    } else if (openedPages.length > 0) {
      throw new Error("Compiled DOM action opened an undeclared page.");
    }
    await settle(activePage);
    if (index === plan.actions.length - 1) {
      await waitForDomOutputChange(
        activePage,
        plan.validation.outputSelector,
        beforeOutput,
        plan.validation.outputChangeTimeoutMs,
        plan.validation.outputFramePath,
      );
    }
    assertSameOrigin(activePage.url(), plan.origin, "Compiled DOM replay");
    if (activePage.url() !== beforeUrl) navigations += 1;
  }
  const output = await captureDomOutput(activePage, plan.validation.outputSelector, plan.validation.outputFramePath);
  validateDomOutput(plan, output, input);
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
  let activePage = page;
  let modelCalls = 0;
  let actions = 0;
  let navigations = 1;
  for (const instruction of plan.repairInstructions) {
    const beforeUrl = activePage.url();
    const pagesBefore = new Set(activePage.context().pages());
    const result = await lease.act(materialize(instruction, input));
    if (!result.success) throw new Error(`Semantic repair failed: ${result.message}`);
    modelCalls += result.modelCalls;
    actions += result.actions.length;
    const openedPages = activePage.context().pages().filter((candidate) => !pagesBefore.has(candidate));
    if (openedPages.length > 1) throw new Error("A semantic repair instruction opened more than one page.");
    if (openedPages.length === 1) activePage = openedPages[0]!;
    await settle(activePage);
    assertSameOrigin(activePage.url(), plan.origin, "Semantic DOM repair");
    if (activePage.url() !== beforeUrl) navigations += 1;
  }
  const output = await captureDomOutput(activePage, plan.validation.outputSelector, plan.validation.outputFramePath);
  validateDomOutput(plan, output, input);
  return { ...output, actions, navigations, modelCalls, durationMs: performance.now() - startedAt };
}

export function recordDomShadow(plan: DomWorkflowPlan, input: DomInput, matches: boolean): DomWorkflowPlan {
  const updated = structuredClone(plan);
  const inputHash = hash(input);
  if (matches) {
    updated.evidence.successfulShadowCount = (updated.evidence.successfulShadowCount ??
      updated.evidence.successfulShadowInputHashes.length) + 1;
    if (!updated.evidence.successfulShadowInputHashes.includes(inputHash)) {
      updated.evidence.successfulShadowInputHashes.push(inputHash);
    }
    updated.evidence.lastValidatedAt = new Date().toISOString();
    const enoughEvidence = updated.inputNames.length === 0
      ? updated.evidence.successfulShadowCount >= 2
      : updated.evidence.successfulShadowInputHashes.length >= 2;
    if (enoughEvidence) updated.status = "stable";
  } else {
    updated.evidence.failedShadowCount += 1;
    updated.status = "degraded";
  }
  return updated;
}
