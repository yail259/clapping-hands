import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Dialog, Download, Frame, FrameLocator, Locator, Page } from "playwright-core";
import type {
  BrowserAction,
  BrowserActResult,
  BrowserLearnerLease,
} from "./browser-learner.js";

export type DomInput = Record<string, string | number | boolean>;

type InputReference = { $clappingHandsInput: string };
type TemplatePart = string | InputReference;
type UrlInputReference = { $clappingHandsInput: string; encoding: "none" | "uri-component" };
type UrlTemplatePart = string | UrlInputReference;

export type DomActionTemplate = {
  selector: TemplatePart[];
  method: DomActionMethod;
  arguments: TemplatePart[][];
  opensNewPage?: boolean;
  framePath?: TemplatePart[][];
  dialog?: {
    action: "accept" | "dismiss";
    type: "alert" | "confirm";
    message: TemplatePart[];
  };
  download?: {
    suggestedFilename: TemplatePart[];
  };
};

export type DomActionMethod =
  | "click"
  | "fill"
  | "type"
  | "blur"
  | "press"
  | "selectOption"
  | "check"
  | "uncheck"
  | "hover"
  | "scrollIntoViewIfNeeded"
  | "scrollTo"
  | "nextChunk"
  | "prevChunk"
  | "dblclick"
  | "dragTo"
  | "setInputFiles";

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
  startUrl?: string;
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
  startPathTemplate?: UrlTemplatePart[];
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
  downloads?: DomDownloadArtifact[];
};

export type DomDownloadArtifact = {
  path: string;
  suggestedFilename: string;
  size: number;
  sha256: string;
};

const SUPPORTED_METHODS = new Set<DomActionMethod>([
  "click",
  "fill",
  "type",
  "blur",
  "press",
  "selectOption",
  "check",
  "uncheck",
  "hover",
  "scrollIntoViewIfNeeded",
  "scrollTo",
  "nextChunk",
  "prevChunk",
  "dblclick",
  "dragTo",
  "setInputFiles",
]);
const METHOD_ALIASES: Record<string, DomActionMethod> = {
  selectOptionFromDropdown: "selectOption",
  doubleClick: "dblclick",
  dragAndDrop: "dragTo",
  scroll: "scrollTo",
};
const PASSIVE_METHODS = new Set<DomActionMethod>([
  "hover",
  "scrollIntoViewIfNeeded",
  "scrollTo",
  "nextChunk",
  "prevChunk",
]);
const SENSITIVE_INPUT_NAME = /(?:password|passwd|secret|token|csrf|xsrf|session|cookie|authorization|api[_-]?key)/i;
const EFFECTFUL_INTENT_LANGUAGE = /\b(?:publish|send|purchase|buy|checkout|place (?:an )?order|delete|post (?:a |the |this )?(?:comment|message|reply|update|review|listing|content)|save|create|approve|transfer|pay|book (?:an? |the )?(?:appointment|room|ticket|table|flight|hotel)|reserve|subscribe|unsubscribe|upload|register|sign up|invite (?:a |the )?(?:user|member|person|collaborator)|follow (?:a |the )?(?:user|person|account|page)|like (?:a |the |this )?(?:post|comment|page|item)|connect with|bid (?:on|for)|make (?:an )?offer|apply (?:for|to)|submit (?:an? |the |this )?(?:application|order|request|claim|registration|response|review|comment|message)|cancel (?:an? |the |this )?(?:booking|reservation|order|subscription|appointment)|remove (?:an? |the |this )?(?:item|record|account|user|member|file|listing|post|comment)|(?:edit|update|change) (?:an? |the |this |my )?(?:profile|address|email|password|booking|reservation|order|listing|record|status|settings|subscription|quantity)|add (?:an? |the |this )?(?:item )?to (?:cart|basket|wishlist))\b/i;
const EFFECTFUL_CONTROL_LANGUAGE = /^(?:click|press|choose|select)?\s*(?:the\s+)?(?:publish|send|purchase|buy|checkout|delete|post|save|create|approve|transfer|pay|book|reserve|subscribe|unsubscribe|follow|like|upload|register|sign up|invite|add to (?:cart|basket|wishlist)|submit (?:application|order|request|claim|registration|response|review|comment|message))(?:\s+(?:button|link|item|post|user|member))?\s*$/i;
const MAX_ACTIONS = 30;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_OUTPUT_CHANGE_TIMEOUT_MS = 10_000;
const DEFAULT_ACTION_READINESS_TIMEOUT_MS = 30_000;
const PLAN_STATUSES = new Set(["candidate", "provisional", "stable", "degraded"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertCanonicalOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be a canonical HTTP(S) origin.`);
  }
  return url;
}

function assertStoredPath(value: string, origin: string, label: string): void {
  const resolved = new URL(value, origin);
  if (!value.startsWith("/") || resolved.origin !== origin || resolved.hash || value !== normalizedPath(resolved)) {
    throw new Error(`${label} must be a same-origin absolute path without a fragment.`);
  }
}

function assertTemplateParts(
  value: unknown,
  inputNames: Set<string>,
  label: string,
  options: { maximumParts?: number; rejectHighEntropy?: boolean } = {},
): asserts value is TemplatePart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > (options.maximumParts ?? 50)) {
    throw new Error(`${label} has an invalid template shape.`);
  }
  for (const part of value) {
    if (typeof part === "string") {
      if (part.length > 2_000 || part.includes("\0") || (options.rejectHighEntropy && looksHighEntropy(part))) {
        throw new Error(`${label} contains an unsafe persisted constant.`);
      }
      continue;
    }
    if (!isRecord(part) || Object.keys(part).length !== 1 || typeof part.$clappingHandsInput !== "string" ||
      !inputNames.has(part.$clappingHandsInput)) {
      throw new Error(`${label} contains an invalid input reference.`);
    }
  }
}

function assertUrlTemplateParts(
  value: unknown,
  inputNames: Set<string>,
  origin: string,
): asserts value is UrlTemplatePart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("Compiled DOM start-path template has an invalid shape.");
  }
  for (const part of value) {
    if (typeof part === "string") {
      if (part.length > 2_000 || part.includes("\0")) {
        throw new Error("Compiled DOM start-path template contains an unsafe constant.");
      }
      continue;
    }
    if (!isRecord(part) || Object.keys(part).length !== 2 || typeof part.$clappingHandsInput !== "string" ||
      !inputNames.has(part.$clappingHandsInput) || !new Set(["none", "uri-component"]).has(String(part.encoding))) {
      throw new Error("Compiled DOM start-path template contains an invalid input reference.");
    }
  }
  const structuralProbe = value.map((part) => typeof part === "string" ? part : "clapping-hands-input").join("");
  assertStoredPath(structuralProbe, origin, "Compiled DOM start-path template");
}

export function assertDomWorkflowPlanSafety(plan: DomWorkflowPlan): void {
  if (!isRecord(plan) || plan.formatVersion !== "clapping-hands.dev/v1alpha2" || plan.engine !== "stagehand-action-v1") {
    throw new Error("Invalid compiled DOM workflow identity.");
  }
  if (!Number.isSafeInteger(plan.version) || plan.version < 1 || !PLAN_STATUSES.has(plan.status)) {
    throw new Error("Compiled DOM workflow version or status is invalid.");
  }
  const origin = assertCanonicalOrigin(plan.origin, "Compiled DOM workflow origin");
  assertStoredPath(plan.startPath, plan.origin, "Compiled DOM start path");
  const allowedOrigins = plan.allowedNetworkOrigins ?? [];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 5 || new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new Error("Compiled DOM network-origin allowlist is invalid.");
  }
  for (const allowed of allowedOrigins) {
    const parsed = assertCanonicalOrigin(allowed, "Compiled DOM allowed network origin");
    if (allowed === plan.origin || (origin.protocol === "https:" && parsed.protocol !== "https:")) {
      throw new Error("Compiled DOM network-origin allowlist contains an invalid origin.");
    }
  }
  if (!Array.isArray(plan.inputNames) || plan.inputNames.length > 50 || new Set(plan.inputNames).size !== plan.inputNames.length ||
    plan.inputNames.some((name) => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || SENSITIVE_INPUT_NAME.test(name))) {
    throw new Error("Compiled DOM input names are invalid or sensitive.");
  }
  const inputNames = new Set(plan.inputNames);
  if (plan.startPathTemplate !== undefined) {
    assertUrlTemplateParts(plan.startPathTemplate, inputNames, plan.origin);
  }
  if (!Array.isArray(plan.actions) || plan.actions.length < 1 || plan.actions.length > MAX_ACTIONS) {
    throw new Error("Compiled DOM action list is invalid.");
  }
  for (const [index, action] of plan.actions.entries()) {
    if (!isRecord(action) || !SUPPORTED_METHODS.has(action.method as DomActionMethod) || !Array.isArray(action.arguments) || action.arguments.length > 20) {
      throw new Error(`Compiled DOM action ${index + 1} is invalid.`);
    }
    assertTemplateParts(action.selector, inputNames, `Compiled DOM selector ${index + 1}`);
    action.arguments.forEach((argument, argumentIndex) => assertTemplateParts(
      argument,
      inputNames,
      `Compiled DOM argument ${index + 1}.${argumentIndex + 1}`,
      { rejectHighEntropy: true },
    ));
    if (action.opensNewPage !== undefined && (typeof action.opensNewPage !== "boolean" ||
      (action.opensNewPage && !new Set<DomActionMethod>(["click", "dblclick"]).has(action.method)))) {
      throw new Error("Only a compiled click action may open a new page.");
    }
    if (action.framePath !== undefined) {
      if (!Array.isArray(action.framePath) || action.framePath.length > 8) throw new Error("Compiled DOM frame path is invalid.");
      action.framePath.forEach((part, frameIndex) => assertTemplateParts(part, inputNames, `Compiled DOM frame selector ${index + 1}.${frameIndex + 1}`));
    }
    if (action.method === "setInputFiles" && (action.arguments.length === 0 ||
      action.arguments.some((argument) => argument.length !== 1 || typeof argument[0] === "string"))) {
      throw new Error("Compiled file paths must be direct tool inputs.");
    }
    if (action.dialog !== undefined) {
      if (!isRecord(action.dialog) || !new Set(["accept", "dismiss"]).has(action.dialog.action) ||
        !new Set(["alert", "confirm"]).has(action.dialog.type)) {
        throw new Error("Compiled browser-dialog behavior is invalid.");
      }
      assertTemplateParts(action.dialog.message, inputNames, `Compiled browser-dialog message ${index + 1}`, { rejectHighEntropy: true });
    }
    if (action.download !== undefined) {
      if (!isRecord(action.download)) throw new Error("Compiled download behavior is invalid.");
      assertTemplateParts(action.download.suggestedFilename, inputNames, `Compiled download filename ${index + 1}`, { rejectHighEntropy: true });
      if (action.download.suggestedFilename.some((part) => typeof part === "string" && /[\\/]/.test(part))) {
        throw new Error("Compiled download filenames cannot contain path separators.");
      }
    }
  }
  if (!isRecord(plan.effect) || !new Set(["read", "write"]).has(plan.effect.level)) {
    throw new Error("Compiled DOM effect declaration is invalid.");
  }
  if (plan.effect.level === "read") {
    if (plan.effect.commitActionIndex !== null || plan.effect.confirmation !== null ||
      plan.actions.some((action) => action.method === "setInputFiles" || action.dialog?.action === "accept")) {
      throw new Error("A read DOM workflow cannot contain an effect boundary, file selection, or accepted dialog.");
    }
  } else {
    if (!Number.isSafeInteger(plan.effect.commitActionIndex) || plan.effect.commitActionIndex! < 0 ||
      plan.effect.commitActionIndex! >= plan.actions.length || typeof plan.effect.confirmation !== "string" ||
      plan.effect.confirmation.trim().length === 0 || plan.effect.confirmation.length > 240) {
      throw new Error("Compiled DOM write effect boundary is invalid.");
    }
    const firstUpload = plan.actions.findIndex((action) => action.method === "setInputFiles");
    if (firstUpload >= 0 && firstUpload < plan.effect.commitActionIndex!) {
      throw new Error("A file selection cannot occur before the compiled effect boundary.");
    }
    const firstAcceptedDialog = plan.actions.findIndex((action) => action.dialog?.action === "accept");
    if (firstAcceptedDialog >= 0 && firstAcceptedDialog < plan.effect.commitActionIndex!) {
      throw new Error("An accepted dialog cannot occur before the compiled effect boundary.");
    }
  }
  if (!Array.isArray(plan.repairInstructions) || plan.repairInstructions.length > 20) {
    throw new Error("Compiled DOM repair instructions are invalid.");
  }
  plan.repairInstructions.forEach((instruction, index) => assertTemplateParts(
    instruction,
    inputNames,
    `Compiled DOM repair instruction ${index + 1}`,
    { maximumParts: 100, rejectHighEntropy: true },
  ));
  if (!isRecord(plan.validation) || !Number.isSafeInteger(plan.validation.maximumActions) ||
    plan.validation.maximumActions < plan.actions.length || plan.validation.maximumActions > MAX_ACTIONS ||
    typeof plan.validation.outputSelector !== "string" || plan.validation.outputSelector.length < 1 || plan.validation.outputSelector.length > 2_000 ||
    typeof plan.validation.outputTagName !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(plan.validation.outputTagName) ||
    !new Set(["one-of", "present"]).has(plan.validation.outputMode) || !Array.isArray(plan.validation.outputTextHashes) ||
    (plan.validation.outputMode === "one-of" && plan.validation.outputTextHashes.length === 0) ||
    !Number.isSafeInteger(plan.validation.minimumOutputCharacters ?? 1) || (plan.validation.minimumOutputCharacters ?? 1) < 1) {
    throw new Error("Compiled DOM output validation is invalid.");
  }
  if (plan.validation.outputFramePath !== undefined && (!Array.isArray(plan.validation.outputFramePath) ||
    plan.validation.outputFramePath.some((part) => typeof part !== "string" || part.length < 1 || part.length > 2_000))) {
    throw new Error("Compiled DOM output frame path is invalid.");
  }
  if (plan.validation.outputChangeTimeoutMs !== undefined && (!Number.isSafeInteger(plan.validation.outputChangeTimeoutMs) ||
    plan.validation.outputChangeTimeoutMs < 50 || plan.validation.outputChangeTimeoutMs > 60_000)) {
    throw new Error("Compiled DOM output-change timeout is invalid.");
  }
  if (plan.validation.inputEvidenceNames !== undefined && (!Array.isArray(plan.validation.inputEvidenceNames) ||
    plan.validation.inputEvidenceNames.some((name) => !inputNames.has(name)))) {
    throw new Error("Compiled DOM output evidence names are invalid.");
  }
  if (!isRecord(plan.evidence) || !Array.isArray(plan.evidence.demonstrationInputHashes) ||
    !Array.isArray(plan.evidence.successfulShadowInputHashes) || !Number.isSafeInteger(plan.evidence.failedShadowCount) ||
    plan.evidence.failedShadowCount < 0) {
    throw new Error("Compiled DOM evidence is invalid.");
  }
}

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

async function waitForUniqueCompiledLocator(
  page: Page,
  framePath: string[],
  selector: string,
  timeoutMs = DEFAULT_ACTION_READINESS_TIMEOUT_MS,
): Promise<Locator> {
  const locator = locatorInFramePath(page, framePath, selector);
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await locator.count().catch(() => 0);
    if (count === 1) return locator;
    if (count > 1) throw new Error(`Compiled selector matched ${count} elements: ${selector}`);
    await delay(50);
  }
  throw new Error(`Compiled selector did not become available: ${selector}`);
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
  const rawMethod = action.method ?? "click";
  const method = METHOD_ALIASES[rawMethod] ?? rawMethod;
  if (!SUPPORTED_METHODS.has(method as DomActionMethod)) {
    throw new Error(`Unsupported learned DOM method ${method}.`);
  }
  return method as DomActionMethod;
}

function potentiallyEffectfulAction(action: BrowserAction): boolean {
  const method = normalizeMethod(action);
  if (method === "setInputFiles") return true;
  if (action.dialog?.action === "accept") return true;
  if (PASSIVE_METHODS.has(method)) return false;
  return EFFECTFUL_INTENT_LANGUAGE.test(action.description) || EFFECTFUL_CONTROL_LANGUAGE.test(action.description) ||
    method !== "click";
}

function requestedDialogAction(instruction: string): "accept" | "dismiss" | null {
  const dismiss = /\b(?:dismiss|cancel|decline)\s+(?:the\s+)?(?:dialog|confirmation|alert)\b|\b(?:choose|click|press)\s+(?:no|cancel)\b/i.test(instruction);
  const accept = /\b(?:accept|confirm|approve)\s+(?:the\s+)?(?:dialog|confirmation|alert)\b|\b(?:choose|click|press)\s+(?:ok|yes)\b/i.test(instruction);
  if (accept && dismiss) throw new Error("A browser-dialog instruction cannot request both accept and dismiss.");
  return accept ? "accept" : dismiss ? "dismiss" : null;
}

function looksHighEntropy(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(value) ||
    (value.length >= 48 && /^[A-Za-z0-9+/_=-]+$/.test(value) && new Set(value).size >= 12);
}

function inputBindingOrder(demonstration: DomWorkflowDemonstration, inputNames: string[]): Array<{
  inputName: string;
  inputIndex: number;
  raw: string;
}> {
  return inputNames.map((inputName, inputIndex) => ({
    inputName,
    inputIndex,
    raw: String(demonstration.input[inputName]),
  })).filter((candidate) => candidate.raw.length > 0)
    .sort((left, right) => right.raw.length - left.raw.length || left.inputIndex - right.inputIndex);
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
    for (const { inputName, inputIndex, raw } of inputBindingOrder(demonstrations[index]!, inputNames)) {
      if (!skeleton.includes(raw)) continue;
      const sentinel = `\u0000input:${inputIndex}\u0000`;
      sentinels.set(sentinel, inputName);
      skeleton = skeleton.split(raw).join(sentinel);
    }
    return skeleton;
  });
  if (new Set(skeletons).size !== 1) {
    throw new Error("A learned selector or argument varied without a demonstrated input binding.");
  }
  const skeleton = skeletons[0]!;
  const pattern = /\u0000input:(\d+)\u0000/g;
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

function splitUrlByInputs(
  values: string[],
  demonstrations: DomWorkflowDemonstration[],
  inputNames: string[],
  bound: Set<string>,
): UrlTemplatePart[] {
  if (new Set(values).size === 1) return [values[0]!];

  const sentinels = new Map<string, UrlInputReference>();
  const skeletons = values.map((value, index) => {
    let skeleton = value;
    for (const { inputName, inputIndex, raw } of inputBindingOrder(demonstrations[index]!, inputNames)) {
      const encoded = encodeURIComponent(raw);
      const candidates: Array<{ text: string; encoding: UrlInputReference["encoding"] }> = encoded === raw
        ? [{ text: raw, encoding: "uri-component" }]
        : [{ text: encoded, encoding: "uri-component" }, { text: raw, encoding: "none" }];
      const candidate = candidates.find(({ text }) => skeleton.includes(text));
      if (!candidate) continue;
      const sentinel = `\u0000url:${inputIndex}\u0000`;
      sentinels.set(sentinel, { $clappingHandsInput: inputName, encoding: candidate.encoding });
      skeleton = skeleton.split(candidate.text).join(sentinel);
    }
    return skeleton;
  });
  if (new Set(skeletons).size !== 1) {
    throw new Error("A demonstrated start URL varied without a safe input binding.");
  }
  const skeleton = skeletons[0]!;
  const pattern = /\u0000url:(\d+)\u0000/g;
  const parts: UrlTemplatePart[] = [];
  let offset = 0;
  for (const match of skeleton.matchAll(pattern)) {
    if (match.index! > offset) parts.push(skeleton.slice(offset, match.index));
    const reference = sentinels.get(match[0]);
    if (!reference) throw new Error("Invalid DOM start URL template.");
    parts.push(reference);
    bound.add(reference.$clappingHandsInput);
    offset = match.index! + match[0].length;
  }
  if (offset < skeleton.length) parts.push(skeleton.slice(offset));
  if (parts.length === 0) throw new Error("A demonstrated start URL varied without a safe input binding.");
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
    if (demonstration.startUrl) {
      const demonstratedStart = new URL(demonstration.startUrl);
      assertSameOrigin(demonstratedStart.href, start.origin, "DOM demonstration start");
      if (demonstratedStart.hash) throw new Error("DOM demonstration start URLs cannot contain fragments.");
    }
  }
  for (const inputName of inputNames) {
    if (new Set(demonstrations.map((demo) => JSON.stringify(demo.input[inputName]))).size < 2) {
      throw new Error(`Input ${inputName} did not vary across demonstrations.`);
    }
  }
  const bound = new Set<string>();
  const demonstratedStartPaths = demonstrations.map((demonstration) =>
    normalizedPath(new URL(demonstration.startUrl ?? start.href)));
  const startPathTemplate = new Set(demonstratedStartPaths).size > 1
    ? splitUrlByInputs(demonstratedStartPaths, demonstrations, inputNames, bound)
    : undefined;

  const actionCount = demonstrations[0]!.actions.length;
  if (actionCount === 0 || actionCount > MAX_ACTIONS) {
    throw new Error(`DOM demonstration must contain 1-${MAX_ACTIONS} learned actions.`);
  }
  if (demonstrations.some((demo) => demo.actions.length !== actionCount)) {
    throw new Error("DOM demonstrations contained different action counts.");
  }

  const templates: DomActionTemplate[] = [];
  for (let index = 0; index < actionCount; index += 1) {
    const actions = demonstrations.map((demo) => actionAt(demo, index));
    const methods = actions.map(normalizeMethod);
    if (new Set(methods).size !== 1) throw new Error(`Learned DOM method drift at action ${index + 1}.`);
    const argumentCounts = actions.map((candidate) => candidate.arguments?.length ?? 0);
    if (new Set(argumentCounts).size !== 1) throw new Error(`Learned DOM argument drift at action ${index + 1}.`);
    const pageTransitions = actions.map((candidate) => Boolean(candidate.opensNewPage));
    if (new Set(pageTransitions).size !== 1) throw new Error(`Learned DOM page-transition drift at action ${index + 1}.`);
    if (pageTransitions[0] && !new Set<DomActionMethod>(["click", "dblclick"]).has(methods[0]!)) {
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
    const dialogPresence = actions.map((candidate) => Boolean(candidate.dialog));
    if (new Set(dialogPresence).size !== 1) throw new Error(`Learned browser-dialog drift at action ${index + 1}.`);
    let dialog: DomActionTemplate["dialog"];
    if (dialogPresence[0]) {
      const dialogs = actions.map((candidate) => candidate.dialog!);
      if (new Set(dialogs.map((candidate) => candidate.action)).size !== 1 ||
        new Set(dialogs.map((candidate) => candidate.type)).size !== 1) {
        throw new Error(`Learned browser-dialog behavior drift at action ${index + 1}.`);
      }
      dialog = {
        action: dialogs[0]!.action,
        type: dialogs[0]!.type,
        message: splitByInputs(dialogs.map((candidate) => candidate.message), demonstrations, inputNames, bound, true),
      };
    }
    const downloadPresence = actions.map((candidate) => Boolean(candidate.download));
    if (new Set(downloadPresence).size !== 1) throw new Error(`Learned download drift at action ${index + 1}.`);
    let download: DomActionTemplate["download"];
    if (downloadPresence[0]) {
      download = {
        suggestedFilename: splitByInputs(
          actions.map((candidate) => candidate.download!.suggestedFilename),
          demonstrations,
          inputNames,
          bound,
          true,
        ),
      };
      if (download.suggestedFilename.some((part) => typeof part === "string" && /[\\/]/.test(part))) {
        throw new Error("Learned download filenames cannot contain path separators.");
      }
    }
    const argumentTemplates = Array.from({ length: argumentCounts[0]! }, (_unused, argumentIndex) => splitByInputs(
      actions.map((candidate) => candidate.arguments![argumentIndex]!),
      demonstrations,
      inputNames,
      bound,
      true,
    ));
    if (methods[0] === "setInputFiles") {
      if (argumentTemplates.length === 0) throw new Error("A compiled file selection requires at least one file input.");
      if (argumentTemplates.some((argument) => argument.length !== 1 || typeof argument[0] === "string")) {
        throw new Error("Compiled file paths must be direct tool inputs rather than persisted constants.");
      }
    }
    templates.push({
      selector: splitByInputs(actions.map((candidate) => candidate.selector), demonstrations, inputNames, bound),
      method: methods[0]!,
      arguments: argumentTemplates,
      ...(pageTransitions[0] ? { opensNewPage: true } : {}),
      ...(framePath.length > 0 ? { framePath } : {}),
      ...(dialog ? { dialog } : {}),
      ...(download ? { download } : {}),
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
  const effectLevel = options.effect ?? "read";
  const minimumOutputCharacters = Math.max(1, Math.floor(Math.min(
    ...demonstrations.map((demo) => normalizedText(demo.output.text).length),
  ) * 0.25));
  const inputEvidenceNames = inputNames.filter((name) => demonstrations.every((demo) => {
    const evidence = normalizedText(String(demo.input[name])).toLowerCase();
    return evidence.length > 0 && normalizedText(demo.output.text).toLowerCase().includes(evidence);
  }));
  // Aggregate views can contain every demonstrated item, producing identical
  // full-page hashes even though the requested input is safely evidenced in
  // the output. In that case the evidence is the reusable contract; freezing
  // unrelated surrounding content would reject a valid unseen item.
  const outputMode = outputTextHashes.length === 1 && inputEvidenceNames.length === 0 ? "one-of" : "present";
  const confirmation = options.confirmation?.trim() || null;
  const demonstratedInstructions = demonstrations.flatMap((demo) => demo.instructions ?? []);
  const demonstratedControls = demonstrations.flatMap((demo) => demo.actions.map((candidate) => candidate.description.trim()));
  if (effectLevel === "read" && (
    templates.some((template) => template.method === "setInputFiles" || template.dialog?.action === "accept") ||
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
  const firstPotentialEffect = effectLevel === "write"
    ? Array.from({ length: actionCount }, (_unused, index) => index)
      .find((index) => demonstrations.some((demo) => potentiallyEffectfulAction(actionAt(demo, index))))
    : undefined;
  return {
    formatVersion: "clapping-hands.dev/v1alpha2",
    engine: "stagehand-action-v1",
    action,
    version: 1,
    effect: {
      level: effectLevel,
      commitActionIndex: effectLevel === "write" ? firstPotentialEffect ?? templates.length - 1 : null,
      confirmation: effectLevel === "write" ? confirmation : null,
    },
    origin: start.origin,
    ...(allowedNetworkOrigins.length > 0 ? { allowedNetworkOrigins } : {}),
    startPath: normalizedPath(start),
    ...(startPathTemplate ? { startPathTemplate } : {}),
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

export function materializeDomStartUrl(plan: DomWorkflowPlan, input: DomInput): string {
  const path = plan.startPathTemplate
    ? plan.startPathTemplate.map((part) => {
      if (typeof part === "string") return part;
      const value = input[part.$clappingHandsInput];
      if (value === undefined) throw new Error(`Missing compiled input ${part.$clappingHandsInput}.`);
      return part.encoding === "uri-component" ? encodeURIComponent(String(value)) : String(value);
    }).join("")
    : plan.startPath;
  assertStoredPath(path, plan.origin, "Materialized DOM start path");
  return new URL(path, plan.origin).href;
}

function materializeAction(template: DomActionTemplate, input: DomInput): BrowserAction {
  return {
    selector: materialize(template.selector, input),
    description: `Compiled ${template.method} action`,
    method: template.method,
    arguments: template.arguments.map((argument) => materialize(argument, input)),
    ...(template.opensNewPage ? { opensNewPage: true } : {}),
    ...(template.framePath ? { framePath: template.framePath.map((segment) => materialize(segment, input)) } : {}),
    ...(template.dialog ? { dialog: { ...template.dialog, message: materialize(template.dialog.message, input) } } : {}),
    ...(template.download ? { download: { suggestedFilename: materialize(template.download.suggestedFilename, input) } } : {}),
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

export async function navigateForCompiledDomWorkflow(page: Page, url: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      break;
    } catch (error) {
      const transientNavigationFailure = /net::ERR_(?:ABORTED|EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)/
        .test(error instanceof Error ? error.message : String(error));
      const destinationCommitted = (() => {
        try {
          return new URL(page.url()).href === new URL(url).href;
        } catch {
          return false;
        }
      })();
      if (destinationCommitted) break;
      if (!transientNavigationFailure || attempt === 2) throw error;
      // Some client routers cancel an in-flight document load while detaching
      // the previous SPA route, and a server can close an otherwise safe GET
      // during worker recycling. Bounded retries are limited to the declared
      // start navigation and never repeat a compiled action.
      await delay(attempt === 0 ? 100 : 250);
    }
  }
  // Long-lived applications can keep resources or connections open forever.
  // DOMContentLoaded commits the navigation; load/network-idle are bounded
  // settling hints, while selector and output readiness remain the real gates.
  await Promise.all([
    page.waitForLoadState("load", { timeout: 2_000 }).catch(() => {}),
    page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {}),
  ]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      break;
    } catch (error) {
      const contextReplaced = /execution context was destroyed|most likely because of a navigation/i
        .test(error instanceof Error ? error.message : String(error));
      if (!contextReplaced || attempt === 1) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
      await delay(50);
    }
  }
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

async function guidedFileSelection(
  page: Page,
  input: DomInput,
  instruction: string,
): Promise<BrowserActResult | null> {
  const mentionedFiles = Object.entries(input).filter(([_name, value]) =>
    typeof value === "string" && value.length > 0 && instruction.includes(value));
  if (mentionedFiles.length === 0 || !/\b(?:upload|attach|choose|select|set)\b/i.test(instruction)) return null;
  if (mentionedFiles.length !== 1) throw new Error("A file-selection instruction must mention exactly one compiled file input.");
  const genericSelector = 'input[type="file"]';
  const candidates: Array<{ frame: Frame; selector: string | null; descriptor: string; score: number }> = [];
  let totalInputs = 0;
  for (const frame of page.frames()) {
    const inputs = frame.locator(genericSelector);
    const count = await inputs.count().catch(() => 0);
    totalInputs += count;
    for (let index = 0; index < count; index += 1) {
      const attributes = await inputs.nth(index).evaluate((element) =>
        Object.fromEntries(Array.from(element.attributes, (attribute) => [attribute.name, attribute.value])));
      const descriptor = Object.entries(attributes)
        .filter(([name]) => /^(?:id|name|class|aria-label|title|data-[a-z0-9_-]+)$/i.test(name))
        .flatMap(([name, value]) => [name, value])
        .join(" ")
        .toLowerCase();
      const intent = /\battach\b/i.test(instruction) ? "attach" : /\bupload\b/i.test(instruction) ? "upload" : null;
      let score = /\b(?:file|picker|choose|select)\b/.test(descriptor) ? 1 : 0;
      if (intent && new RegExp(`\\b${intent}\\b`).test(descriptor)) score += 8;
      if (intent === "upload" && /\battach(?:ment)?\b/.test(descriptor)) score -= 3;
      if (intent === "attach" && /\bupload\b/.test(descriptor)) score -= 3;

      const selectorAttributes = Object.entries(attributes)
        .filter(([name, value]) => /^(?:id|name|aria-label|title|data-[a-z0-9_-]+)$/i.test(name) &&
          name !== "data-v-owner" && value.length <= 200)
        .sort(([leftName, leftValue], [rightName, rightValue]) => {
          const rank = (name: string, value: string) =>
            /(?:upload|attach|file|picker)/i.test(`${name} ${value}`) ? 0 : name.startsWith("data-") ? 1 : 2;
          return rank(leftName, leftValue) - rank(rightName, rightValue);
        });
      let selector: string | null = null;
      for (const [name, value] of selectorAttributes) {
        const proposed = value === ""
          ? `${genericSelector}[${name}]`
          : `${genericSelector}[${name}=${JSON.stringify(value)}]`;
        if (await frame.locator(proposed).count().catch(() => 0) === 1) {
          selector = proposed;
          break;
        }
      }
      candidates.push({ frame, selector, descriptor, score });
    }
  }
  let selected = candidates[0];
  if (totalInputs === 1 && selected) {
    selected.selector = genericSelector;
  } else {
    const ranked = candidates.filter((candidate): candidate is {
      frame: Frame; selector: string; descriptor: string; score: number;
    } => candidate.selector !== null).sort((left, right) => right.score - left.score);
    if (!ranked[0] || ranked[0].score < 8 || ranked[0].score === ranked[1]?.score) {
      throw new Error(`Guided file selection could not safely disambiguate ${totalInputs} file inputs.`);
    }
    selected = ranked[0];
  }
  if (!selected?.selector) throw new Error(`Guided file selection could not safely disambiguate ${totalInputs} file inputs.`);
  const file = String(mentionedFiles[0]![1]);
  await selected.frame.locator(selected.selector).setInputFiles(await resolveUploadFiles([file]));
  return {
    success: true,
    message: "Selected an operator-allowlisted file without a model call.",
    actions: [{
      selector: selected.selector,
      description: "Select operator-allowlisted upload file",
      method: "setInputFiles",
      arguments: [file],
    }],
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
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
  await navigateForCompiledDomWorkflow(page, startUrl);
  let activePage = page;
  const actions: BrowserAction[] = [];
  let modelCalls = 0;
  for (const instruction of instructions) {
    const actionPage = activePage;
    const pagesBefore = new Set(page.context().pages());
    const dialogAction = requestedDialogAction(instruction);
    const expectsDownload = /\bdownload\b|\b(?:save|export)\b.{0,40}\b(?:file|document|report|pdf|csv|archive)\b/i.test(instruction);
    const observedDialogs: Array<{ action: "accept" | "dismiss"; type: string; message: string }> = [];
    const dialogTasks: Array<Promise<Error | null>> = [];
    const observedDownloads: Download[] = [];
    const onDialog = (dialog: Dialog): void => {
      const action = observedDialogs.length === 0 ? dialogAction : null;
      observedDialogs.push({ action: action ?? "dismiss", type: dialog.type(), message: dialog.message() });
      dialogTasks.push((async (): Promise<Error | null> => {
        try {
          if (!action || !new Set(["alert", "confirm"]).has(dialog.type())) {
            await dialog.dismiss().catch(() => {});
            return null;
          }
          if (action === "accept") await dialog.accept();
          else await dialog.dismiss();
          return null;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      })());
    };
    actionPage.on("dialog", onDialog);
    const onDownload = (download: Download): void => { observedDownloads.push(download); };
    actionPage.on("download", onDownload);
    const expectedDownload = expectsDownload
      ? actionPage.waitForEvent("download", { timeout: 5_000 }).catch(() => null)
      : null;
    let result: BrowserActResult;
    try {
      result = await guidedFileSelection(actionPage, input, instruction) ?? await lease.act(instruction);
      const dialogErrors = await Promise.all(dialogTasks);
      if (dialogErrors.some(Boolean)) throw dialogErrors.find(Boolean);
      const awaitedDownload = await expectedDownload;
      if (awaitedDownload && !observedDownloads.includes(awaitedDownload)) observedDownloads.push(awaitedDownload);
    } finally {
      actionPage.off("dialog", onDialog);
      actionPage.off("download", onDownload);
    }
    if (observedDialogs.length > 1) throw new Error("A single semantic instruction opened more than one browser dialog.");
    if (observedDialogs.length === 1 && !dialogAction) {
      throw new Error("A browser dialog was dismissed; the instruction must explicitly request accept or dismiss.");
    }
    if (observedDialogs[0] && !new Set(["alert", "confirm"]).has(observedDialogs[0].type)) {
      throw new Error(`Unsupported browser dialog type ${observedDialogs[0].type}.`);
    }
    if (!result.success) throw new Error(`Browser learner failed: ${result.message}`);
    const learnedActions = result.actions.map((action) => ({ ...action }));
    if (observedDialogs[0]) {
      if (learnedActions.length === 0) throw new Error("The browser learner opened a dialog without returning its triggering action.");
      learnedActions[learnedActions.length - 1]!.dialog = {
        action: observedDialogs[0].action,
        type: observedDialogs[0].type as "alert" | "confirm",
        message: observedDialogs[0].message,
      };
    }
    if (observedDownloads.length > 1) throw new Error("A single semantic instruction started more than one download.");
    if (expectsDownload && observedDownloads.length === 0) {
      throw new Error("The browser instruction requested a download but no download started.");
    }
    if (observedDownloads[0]) {
      if (learnedActions.length === 0) throw new Error("The browser learner started a download without returning its triggering action.");
      if (new URL(observedDownloads[0].url()).origin !== origin) {
        await observedDownloads[0].cancel().catch(() => {});
        throw new Error("A demonstrated download left the workflow origin.");
      }
      learnedActions[learnedActions.length - 1]!.download = {
        suggestedFilename: observedDownloads[0].suggestedFilename(),
      };
    }
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
    startUrl,
    actions,
    output: await captureDomOutput(activePage, outputSelector, outputFramePath),
    modelCalls,
    instructions,
  };
}

async function resolveUploadFiles(arguments_: string[], environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (arguments_.length === 0) throw new Error("A compiled file selection requires at least one file input.");
  const configuredRoot = environment.CLAPPING_HANDS_UPLOAD_ROOT?.trim();
  const uploadRoot = await realpath(resolve(configuredRoot || resolve(process.cwd(), ".data/uploads"))).catch(() => {
    throw new Error("The Clapping Hands upload directory does not exist.");
  });
  if (!(await stat(uploadRoot)).isDirectory()) throw new Error("The Clapping Hands upload root must be a directory.");
  const files: string[] = [];
  for (const argument of arguments_) {
    if (!argument || argument.includes("\0")) throw new Error("A compiled upload file path was invalid.");
    const candidate = isAbsolute(argument) ? argument : resolve(uploadRoot, argument);
    const file = await realpath(candidate).catch(() => {
      throw new Error("A compiled upload file does not exist.");
    });
    const relativePath = relative(uploadRoot, file);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("A compiled upload file was outside the allowed upload root.");
    }
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error("A compiled upload target was not a regular file.");
    if (metadata.size > MAX_UPLOAD_BYTES) {
      throw new Error(`A compiled upload file exceeded ${MAX_UPLOAD_BYTES} bytes.`);
    }
    files.push(file);
  }
  return files;
}

export async function fingerprintCompiledDomActions(actions: BrowserAction[]): Promise<string | null> {
  const uploads: Array<{ action: number; file: number; size: number; sha256: string }> = [];
  for (const [actionIndex, action] of actions.entries()) {
    if (normalizeMethod(action) !== "setInputFiles") continue;
    const files = await resolveUploadFiles(action.arguments ?? []);
    for (const [fileIndex, file] of files.entries()) {
      const contents = await readFile(file);
      uploads.push({
        action: actionIndex,
        file: fileIndex,
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
  return uploads.length > 0 ? hash(uploads) : null;
}

async function persistDownloadArtifact(download: Download, environment: NodeJS.ProcessEnv = process.env): Promise<DomDownloadArtifact> {
  const suggestedFilename = download.suggestedFilename();
  if (!suggestedFilename || basename(suggestedFilename) !== suggestedFilename || suggestedFilename.includes("\0")) {
    await download.cancel().catch(() => {});
    throw new Error("The downloaded file had an unsafe suggested filename.");
  }
  const configuredRoot = environment.CLAPPING_HANDS_ARTIFACT_ROOT?.trim();
  const requestedRoot = resolve(configuredRoot || resolve(process.cwd(), ".data/artifacts"));
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const artifactRoot = await realpath(requestedRoot);
  const artifactDirectory = resolve(artifactRoot, randomUUID());
  await mkdir(artifactDirectory, { mode: 0o700 });
  const safeFilename = suggestedFilename.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180) || "download";
  const path = resolve(artifactDirectory, safeFilename);
  try {
    await download.saveAs(path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("The downloaded artifact was not a regular file.");
    if (metadata.size === 0) throw new Error("The downloaded artifact was empty.");
    if (metadata.size > MAX_DOWNLOAD_BYTES) throw new Error(`The downloaded artifact exceeded ${MAX_DOWNLOAD_BYTES} bytes.`);
    const contents = await readFile(path);
    return {
      path,
      suggestedFilename,
      size: metadata.size,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  } catch (error) {
    await unlink(path).catch(() => {});
    await rmdir(artifactDirectory).catch(() => {});
    throw error;
  }
}

async function richTextSourceValues(locator: Locator): Promise<string[]> {
  return locator.evaluate((element) => {
    if (element.getAttribute("contenteditable") !== "true") return [];
    const form = element.closest("form");
    let scope: Element | null = element.parentElement;
    while (scope) {
      const sources = [...scope.querySelectorAll("textarea")];
      if (sources.length > 0) return sources.map((textarea) => textarea.value);
      if (scope === form) break;
      scope = scope.parentElement;
    }
    return [];
  }).catch(() => []);
}

async function waitForRichTextSourceChange(locator: Locator, before: string[]): Promise<void> {
  if (before.length === 0) return;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = await richTextSourceValues(locator);
    if (JSON.stringify(current) !== JSON.stringify(before)) return;
    await delay(25);
  }
  throw new Error("A compiled contenteditable did not synchronize its form source after blur.");
}

async function editableText(locator: Locator): Promise<{ kind: "contenteditable" | "control"; value: string } | null> {
  return locator.evaluate((element) => {
    if (element.getAttribute("contenteditable") === "true") {
      return { kind: "contenteditable" as const, value: element.textContent ?? "" };
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return { kind: "control" as const, value: element.value };
    }
    return null;
  }).catch(() => null);
}

async function typeWithVerifiedFallback(locator: Locator, text: string): Promise<void> {
  const before = await editableText(locator);
  await locator.pressSequentially(text);
  if (!before || text.length === 0) return;
  const after = await editableText(locator);
  if (!after || after.value !== before.value) return;

  // Rich editors and autocomplete widgets can asynchronously reclaim focus or
  // suppress keyboard events. A type action that changed nothing is safe to
  // retry as one atomic state-setting operation; a partial edit is not.
  await locator.fill(`${before.value}${text}`);
  const recovered = await editableText(locator);
  if (!recovered || recovered.value === before.value) {
    throw new Error("A compiled type action produced no editable state change.");
  }
}

export async function executeCompiledDomAction(
  page: Page,
  action: BrowserAction,
  options: { onDownload?: (artifact: DomDownloadArtifact) => void } = {},
): Promise<Page> {
  const locator = await waitForUniqueCompiledLocator(page, action.framePath ?? [], action.selector);
  const args = action.arguments ?? [];
  const method = normalizeMethod(action);
  const pagesBefore = new Set(page.context().pages());
  const openedPage = action.opensNewPage
    ? page.context().waitForEvent("page", { timeout: 10_000 })
    : null;
  let dialogTask: Promise<Error | null> | null = null;
  let dialogCount = 0;
  const onDialog = (dialog: Dialog): void => {
    dialogCount += 1;
    dialogTask = (async (): Promise<Error | null> => {
      try {
        if (dialogCount > 1 || !action.dialog || dialog.type() !== action.dialog.type || dialog.message() !== action.dialog.message) {
          await dialog.dismiss().catch(() => {});
          return new Error("Compiled DOM action opened an unexpected or changed browser dialog.");
        }
        if (action.dialog.action === "accept") await dialog.accept();
        else await dialog.dismiss();
        return null;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })();
  };
  page.on("dialog", onDialog);
  let downloadCount = 0;
  let downloadTask: Promise<{ artifact: DomDownloadArtifact | null; error: Error | null }> | null = null;
  const onDownload = (download: Download): void => {
    downloadCount += 1;
    downloadTask = (async () => {
      try {
        if (downloadCount > 1 || !action.download || download.suggestedFilename() !== action.download.suggestedFilename ||
          new URL(download.url()).origin !== new URL(page.url()).origin) {
          await download.cancel().catch(() => {});
          return { artifact: null, error: new Error("Compiled DOM action started an unexpected or changed download.") };
        }
        return { artifact: await persistDownloadArtifact(download), error: null };
      } catch (error) {
        return { artifact: null, error: error instanceof Error ? error : new Error(String(error)) };
      }
    })();
  };
  page.on("download", onDownload);
  const expectedDownload = action.download
    ? page.waitForEvent("download", { timeout: 10_000 }).catch(() => null)
    : null;
  try {
    switch (method) {
      case "click": {
        const button = args[0];
        if (button && !new Set(["left", "right", "middle"]).has(button)) throw new Error(`Unsupported compiled mouse button ${button}.`);
        await locator.click(button ? { button: button as "left" | "right" | "middle" } : undefined);
        break;
      }
      case "fill": await locator.fill(args[0] ?? ""); break;
      case "type": await typeWithVerifiedFallback(locator, args[0] ?? ""); break;
      case "blur": {
        const sourceValuesBefore = await richTextSourceValues(locator);
        await locator.blur();
        await waitForRichTextSourceChange(locator, sourceValuesBefore);
        break;
      }
      case "press": {
        const key = args[0] ?? "Enter";
        const sourceValuesBefore = key === "Tab" ? await richTextSourceValues(locator) : [];
        await locator.press(key);
        await waitForRichTextSourceChange(locator, sourceValuesBefore);
        break;
      }
      case "selectOption": await locator.selectOption(args); break;
      case "check": await locator.check(); break;
      case "uncheck": await locator.uncheck(); break;
      case "hover": await locator.hover(); break;
      case "scrollIntoViewIfNeeded": await locator.scrollIntoViewIfNeeded(); break;
      case "scrollTo": {
        const match = (args[0] ?? "0%").match(/^(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%$/);
        if (!match) throw new Error("Compiled scroll percentage must be between 0% and 100%.");
        const percentage = Number.parseFloat(args[0] ?? "0%") / 100;
        await locator.evaluate((element, ratio) => {
          const root = element === document.documentElement || element === document.body;
          if (root) window.scrollTo({ top: (document.documentElement.scrollHeight - window.innerHeight) * ratio });
          else element.scrollTo({ top: (element.scrollHeight - element.clientHeight) * ratio });
        }, percentage);
        break;
      }
      case "nextChunk":
      case "prevChunk": {
        const direction = method === "nextChunk" ? 1 : -1;
        await locator.evaluate((element, value) => {
          const root = element === document.documentElement || element === document.body;
          if (root) window.scrollBy({ top: window.innerHeight * value });
          else element.scrollBy({ top: element.clientHeight * value });
        }, direction);
        break;
      }
      case "dblclick": await locator.dblclick(); break;
      case "dragTo": {
        const targetSelector = args[0];
        if (!targetSelector) throw new Error("Compiled drag-and-drop requires a target selector.");
        const target = locatorInFramePath(page, action.framePath ?? [], targetSelector);
        if (await target.count() !== 1) throw new Error(`Compiled drag target matched ${await target.count()} elements: ${targetSelector}`);
        await locator.dragTo(target);
        break;
      }
      case "setInputFiles": await locator.setInputFiles(await resolveUploadFiles(args)); break;
    }
    if (dialogTask) {
      const dialogError = await dialogTask;
      if (dialogError) throw dialogError;
    }
    if (action.dialog && dialogCount === 0) throw new Error("Compiled DOM action did not open its expected browser dialog.");
    const awaitedDownload = await expectedDownload;
    if (awaitedDownload && downloadCount === 0) onDownload(awaitedDownload);
    const pendingDownload = downloadTask as Promise<{ artifact: DomDownloadArtifact | null; error: Error | null }> | null;
    if (pendingDownload) {
      const downloadResult = await pendingDownload;
      if (downloadResult.error) throw downloadResult.error;
      if (downloadResult.artifact) options.onDownload?.(downloadResult.artifact);
    }
    if (action.download && downloadCount === 0) throw new Error("Compiled DOM action did not start its expected download.");
  } catch (error) {
    void openedPage?.catch(() => {});
    throw error;
  } finally {
    page.off("dialog", onDialog);
    page.off("download", onDownload);
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

async function compiledActionAlreadySatisfied(page: Page, action: BrowserAction): Promise<boolean> {
  const method = normalizeMethod(action);
  if (!new Set<DomActionMethod>(["selectOption", "check", "uncheck"]).has(method)) return false;
  const locator = locatorInFramePath(page, action.framePath ?? [], action.selector);
  if (await locator.count() !== 1) return false;
  if (method === "check") return locator.isChecked().catch(() => false);
  if (method === "uncheck") return locator.isChecked().then((checked) => !checked).catch(() => false);
  const expected = action.arguments ?? [];
  const selected = await locator.locator("option:checked").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value)).catch(() => [] as string[]);
  return JSON.stringify(selected) === JSON.stringify(expected);
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
  assertDomWorkflowPlanSafety(plan);
  if (plan.effect.level !== "read") {
    throw new Error("Write workflows require prepareDomWorkflowWrite and commitPreparedDomWorkflowWrite.");
  }
  if (plan.actions.some((action) => action.method === "setInputFiles")) {
    throw new Error("File selection is effectful and cannot run as a read workflow.");
  }
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(plan.inputNames)) {
    throw new Error(`Compiled input keys must be exactly: ${plan.inputNames.join(", ")}.`);
  }
  if (plan.actions.length > plan.validation.maximumActions) throw new Error("Compiled DOM action budget exceeded.");
  const startedAt = performance.now();
  await navigateForCompiledDomWorkflow(page, materializeDomStartUrl(plan, input));
  let activePage = page;
  let navigations = 1;
  const downloads: DomDownloadArtifact[] = [];
  for (const [index, template] of plan.actions.entries()) {
    const action = materializeAction(template, input);
    const beforeUrl = activePage.url();
    const beforeOutput = index === plan.actions.length - 1
      ? await readDomOutputTextIfPresent(activePage, plan.validation.outputSelector, plan.validation.outputFramePath)
      : null;
    const alreadySatisfied = index === plan.actions.length - 1
      ? await compiledActionAlreadySatisfied(activePage, action)
      : false;
    activePage = await executeCompiledDomAction(activePage, action, {
      onDownload: (artifact) => downloads.push(artifact),
    });
    if (index === plan.actions.length - 1 && !template.download && !alreadySatisfied) {
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
    ...(downloads.length > 0 ? { downloads } : {}),
  };
}

export async function replayDomWorkflowWithStagehand(
  _lease: BrowserLearnerLease,
  page: Page,
  plan: DomWorkflowPlan,
  input: DomInput,
): Promise<DomWorkflowResult> {
  // Kept as a compatibility alias. Compiled actions intentionally execute via
  // Playwright so Stagehand cannot reinterpret them or invoke another model.
  return replayDomWorkflow(page, plan, input);
}

export async function repairDomWorkflow(
  lease: Pick<BrowserLearnerLease, "act">,
  page: Page,
  plan: DomWorkflowPlan,
  input: DomInput,
): Promise<DomWorkflowResult> {
  assertDomWorkflowPlanSafety(plan);
  if (plan.actions.some((action) => action.download)) {
    throw new Error("Semantic repair of download workflows is separately gated.");
  }
  if (plan.effect.level !== "read") throw new Error("Semantic repair cannot cross a write effect boundary.");
  if (plan.repairInstructions.length === 0) throw new Error("This workflow has no redacted semantic repair recipe.");
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(plan.inputNames)) {
    throw new Error(`Compiled input keys must be exactly: ${plan.inputNames.join(", ")}.`);
  }
  const startedAt = performance.now();
  await navigateForCompiledDomWorkflow(page, materializeDomStartUrl(plan, input));
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
