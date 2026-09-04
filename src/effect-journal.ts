import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import {
  captureDomOutput,
  type DomInput,
  type DomWorkflowPlan,
  type DomWorkflowResult,
} from "./dom-workflow.js";
import type { BrowserAction } from "./browser-learner.js";

export type EffectReceiptStatus = "prepared" | "committing" | "committed" | "uncertain" | "expired";

export type EffectReceipt = {
  id: string;
  status: EffectReceiptStatus;
  planHash: string;
  inputHash: string;
  origin: string;
  confirmation: string;
  preparedAt: string;
  expiresAt: string;
  committedAt: string | null;
  preparedUrl: string;
  finalAction: {
    method: string;
    selectorHash: string;
  };
};

type JournalFile = {
  formatVersion: "clapping-hands.dev/effect-journal-v1";
  receipts: EffectReceipt[];
};

const EMPTY_JOURNAL: JournalFile = {
  formatVersion: "clapping-hands.dev/effect-journal-v1",
  receipts: [],
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function planHash(plan: DomWorkflowPlan): string {
  return hash({
    engine: plan.engine,
    action: plan.action,
    version: plan.version,
    effect: plan.effect,
    origin: plan.origin,
    startPath: plan.startPath,
    inputNames: plan.inputNames,
    actions: plan.actions,
    repairInstructions: plan.repairInstructions,
    validation: plan.validation,
  });
}

function materialize(parts: Array<string | { $clappingHandsInput: string }>, input: DomInput): string {
  return parts.map((part) => typeof part === "string" ? part : String(input[part.$clappingHandsInput])).join("");
}

function materializeAction(plan: DomWorkflowPlan, index: number, input: DomInput): BrowserAction {
  const template = plan.actions[index];
  if (!template) throw new Error(`Compiled action ${index + 1} does not exist.`);
  return {
    selector: materialize(template.selector, input),
    description: `Compiled ${template.method} action`,
    method: template.method,
    arguments: template.arguments.map((argument) => materialize(argument, input)),
  };
}

function assertInput(plan: DomWorkflowPlan, input: DomInput): void {
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(plan.inputNames)) {
    throw new Error(`Compiled input keys must be exactly: ${plan.inputNames.join(", ")}.`);
  }
}

function assertWritePlan(plan: DomWorkflowPlan): number {
  if (plan.effect.level !== "write" || plan.effect.commitActionIndex === null || !plan.effect.confirmation) {
    throw new Error("This plan is not an explicitly declared write workflow.");
  }
  if (plan.effect.commitActionIndex !== plan.actions.length - 1) {
    throw new Error("The externally effectful action must be the final compiled action.");
  }
  return plan.effect.commitActionIndex;
}

async function executeAction(page: Page, action: BrowserAction): Promise<void> {
  const locator = page.locator(action.selector);
  const count = await locator.count();
  if (count !== 1) throw new Error(`Compiled selector matched ${count} elements: ${action.selector}`);
  const args = action.arguments ?? [];
  switch (action.method ?? "click") {
    case "click": await locator.click(); break;
    case "fill": await locator.fill(args[0] ?? ""); break;
    case "type": await locator.pressSequentially(args[0] ?? ""); break;
    case "press": await locator.press(args[0] ?? "Enter"); break;
    case "selectOption": await locator.selectOption(args); break;
    case "check": await locator.check(); break;
    case "uncheck": await locator.uncheck(); break;
    case "hover": await locator.hover(); break;
    case "scrollIntoViewIfNeeded": await locator.scrollIntoViewIfNeeded(); break;
    default: throw new Error(`Unsupported compiled write method ${action.method}.`);
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
}

async function outputTextIfPresent(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) return null;
  if (!await locator.isVisible().catch(() => false)) return null;
  const text = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  return text || null;
}

async function waitForOutputChange(page: Page, selector: string, before: string | null): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await outputTextIfPresent(page, selector);
    if (current && current !== before) return;
    await delay(50);
  }
}

async function executePrefix(page: Page, plan: DomWorkflowPlan, input: DomInput, finalIndex: number): Promise<void> {
  await page.goto(new URL(plan.startPath, plan.origin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  for (let index = 0; index < finalIndex; index += 1) {
    await executeAction(page, materializeAction(plan, index, input));
    await settle(page);
    if (new URL(page.url()).origin !== plan.origin) throw new Error("Prepared write workflow left its allowed origin.");
  }
}

export class EffectJournal {
  constructor(private readonly path: string) {}

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Effect journal is busy; retry without repeating the site action.");
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  private async loadUnlocked(): Promise<JournalFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as JournalFile;
      if (parsed.formatVersion !== EMPTY_JOURNAL.formatVersion || !Array.isArray(parsed.receipts)) {
        throw new Error("Unsupported effect journal format.");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_JOURNAL);
      throw error;
    }
  }

  private async saveUnlocked(journal: JournalFile): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async create(receipt: EffectReceipt): Promise<void> {
    await this.withLock(async () => {
      const journal = await this.loadUnlocked();
      journal.receipts.push(receipt);
      if (journal.receipts.length > 500) journal.receipts.splice(0, journal.receipts.length - 500);
      await this.saveUnlocked(journal);
    });
  }

  async get(id: string): Promise<EffectReceipt | null> {
    return this.withLock(async () => {
      const journal = await this.loadUnlocked();
      return structuredClone(journal.receipts.find((receipt) => receipt.id === id) ?? null);
    });
  }

  async transition(id: string, from: EffectReceiptStatus, to: EffectReceiptStatus): Promise<EffectReceipt> {
    return this.withLock(async () => {
      const journal = await this.loadUnlocked();
      const receipt = journal.receipts.find((candidate) => candidate.id === id);
      if (!receipt) throw new Error("Prepared effect receipt was not found.");
      if (receipt.status !== from) {
        throw new Error(`Prepared effect is ${receipt.status}; it cannot transition from ${from} to ${to}.`);
      }
      receipt.status = to;
      if (to === "committed") receipt.committedAt = new Date().toISOString();
      await this.saveUnlocked(journal);
      return structuredClone(receipt);
    });
  }
}

export async function prepareDomWorkflowWrite(
  page: Page,
  journal: EffectJournal,
  plan: DomWorkflowPlan,
  input: DomInput,
  ttlMs = 10 * 60_000,
): Promise<EffectReceipt> {
  assertInput(plan, input);
  const finalIndex = assertWritePlan(plan);
  await executePrefix(page, plan, input, finalIndex);
  const finalAction = materializeAction(plan, finalIndex, input);
  const preparedAt = new Date();
  const receipt: EffectReceipt = {
    id: randomUUID(),
    status: "prepared",
    planHash: planHash(plan),
    inputHash: hash(input),
    origin: plan.origin,
    confirmation: plan.effect.confirmation!,
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(preparedAt.getTime() + ttlMs).toISOString(),
    committedAt: null,
    preparedUrl: page.url(),
    finalAction: { method: finalAction.method ?? "click", selectorHash: hash(finalAction.selector) },
  };
  await journal.create(receipt);
  return receipt;
}

export async function commitPreparedDomWorkflowWrite(
  page: Page,
  journal: EffectJournal,
  receiptId: string,
  plan: DomWorkflowPlan,
  input: DomInput,
): Promise<{ receipt: EffectReceipt; result: DomWorkflowResult }> {
  assertInput(plan, input);
  const finalIndex = assertWritePlan(plan);
  const receipt = await journal.get(receiptId);
  if (!receipt) throw new Error("Prepared effect receipt was not found.");
  if (receipt.planHash !== planHash(plan) || receipt.inputHash !== hash(input)) {
    throw new Error("Prepared effect does not match this plan and input.");
  }
  if (receipt.status !== "prepared") throw new Error(`Prepared effect is ${receipt.status}; it will not be repeated.`);
  if (Date.parse(receipt.expiresAt) <= Date.now()) {
    await journal.transition(receipt.id, "prepared", "expired");
    throw new Error("Prepared effect expired before commit.");
  }

  const startedAt = performance.now();
  await executePrefix(page, plan, input, finalIndex);
  await journal.transition(receipt.id, "prepared", "committing");
  try {
    const beforeOutput = await outputTextIfPresent(page, plan.validation.outputSelector);
    await executeAction(page, materializeAction(plan, finalIndex, input));
    await settle(page);
    await waitForOutputChange(page, plan.validation.outputSelector, beforeOutput);
    if (new URL(page.url()).origin !== plan.origin) throw new Error("Committed write workflow left its allowed origin.");
    const output = await captureDomOutput(page, plan.validation.outputSelector);
    if (output.tagName !== plan.validation.outputTagName) throw new Error("Committed DOM output changed element type.");
    if (plan.validation.outputMode === "one-of" && !plan.validation.outputTextHashes.includes(output.textHash)) {
      throw new Error("Committed DOM output did not match the demonstrated result.");
    }
    if (/\b(?:sign[ -]?in|log[ -]?in|session expired|captcha|checkpoint|access denied|verify (?:you|your identity))\b/i.test(output.text.slice(0, 500))) {
      throw new Error("Committed DOM output appears to be an authentication or access-control page.");
    }
    const committed = await journal.transition(receipt.id, "committing", "committed");
    return {
      receipt: committed,
      result: {
        ...output,
        actions: plan.actions.length,
        navigations: 1,
        modelCalls: 0,
        durationMs: performance.now() - startedAt,
      },
    };
  } catch (error) {
    await journal.transition(receipt.id, "committing", "uncertain").catch(() => {});
    throw error;
  }
}
