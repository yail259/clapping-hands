import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = process.env.CLAPPING_HANDS_NOPCOMMERCE_ORIGIN ?? "http://127.0.0.1:18120";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const databaseContainer = process.env.CLAPPING_HANDS_NOPCOMMERCE_DB_CONTAINER ?? "clapping-hands-nop-db";
const ADMIN_EMAIL = "benchmark-admin@example.invalid";
const OUTPUT_SELECTOR = ".content-wrapper";
const FROZEN_COMPILER_COMMIT = "3e3d2393df2015565fd5d5e350c17b510fb43d2f";

if (!process.argv.includes("--local")) {
  throw new Error("nopCommerce v2 order traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The nopCommerce v2 order runner only permits a loopback origin.");
}

type PasswordState = {
  id: number;
  password: string;
  passwordSalt: string;
  passwordFormatId: number;
};

type OrderState = {
  id: number;
  orderStatusId: number;
  noteIds: number[];
};

type OrderStatusInput = DomInput & {
  orderId: string;
  targetStatus: string;
};

function database(sql: string): string {
  return execFileSync("docker", [
    "exec", databaseContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", "nop", "-d", "nop", "-Atc", sql,
  ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }).trim();
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function customerId(): number {
  const observed = Number(database(`select "Id" from "Customer" where "Email" = ${sqlString(ADMIN_EMAIL)};`));
  if (!Number.isSafeInteger(observed) || observed < 1) throw new Error("The synthetic administrator was not found.");
  return observed;
}

function passwordState(adminCustomerId: number): PasswordState {
  const raw = database(`
    select json_build_object(
      'id', "Id",
      'password', "Password",
      'passwordSalt', "PasswordSalt",
      'passwordFormatId', "PasswordFormatId"
    )
    from "CustomerPassword"
    where "CustomerId" = ${adminCustomerId}
    order by "CreatedOnUtc" desc, "Id" desc
    limit 1;
  `);
  const parsed = JSON.parse(raw) as PasswordState;
  if (!Number.isSafeInteger(parsed.id) || parsed.id < 1 || parsed.passwordFormatId !== 1 ||
    typeof parsed.password !== "string" || typeof parsed.passwordSalt !== "string") {
    throw new Error("The synthetic administrator password row had an unexpected shape.");
  }
  return parsed;
}

function setPassword(state: PasswordState): void {
  database(`
    update "CustomerPassword"
    set "Password" = ${sqlString(state.password)},
        "PasswordSalt" = ${sqlString(state.passwordSalt)},
        "PasswordFormatId" = ${state.passwordFormatId}
    where "Id" = ${state.id};
  `);
}

function rotateSyntheticPassword(original: PasswordState): string {
  const password = `ch-${randomBytes(24).toString("base64url")}`;
  const passwordSalt = randomBytes(5).toString("base64");
  const passwordHash = createHash("sha512")
    .update(`${password}${passwordSalt}`, "utf8")
    .digest("hex")
    .toUpperCase();
  setPassword({ id: original.id, password: passwordHash, passwordSalt, passwordFormatId: 1 });
  return password;
}

function orderState(orderId: number): OrderState {
  const raw = database(`
    select json_build_object(
      'id', o."Id",
      'orderStatusId', o."OrderStatusId",
      'noteIds', coalesce((select json_agg(n."Id" order by n."Id") from "OrderNote" n where n."OrderId" = o."Id"), '[]'::json)
    )
    from "Order" o
    where o."Id" = ${orderId};
  `);
  const parsed = JSON.parse(raw) as OrderState;
  if (parsed.id !== orderId || !Number.isSafeInteger(parsed.orderStatusId) ||
    !Array.isArray(parsed.noteIds) || parsed.noteIds.some((id) => !Number.isSafeInteger(id))) {
    throw new Error(`The nopCommerce order fixture drifted at ID ${orderId}.`);
  }
  return parsed;
}

function observedOrderStatus(orderId: number): number {
  return Number(database(`select "OrderStatusId" from "Order" where "Id" = ${orderId};`));
}

function observedNoteIds(orderId: number): number[] {
  const raw = database(`select coalesce(json_agg("Id" order by "Id"), '[]'::json) from "OrderNote" where "OrderId" = ${orderId};`);
  return JSON.parse(raw) as number[];
}

function newOrderNotes(state: OrderState): string[] {
  const exclusions = state.noteIds.length > 0 ? state.noteIds.join(",") : "0";
  const raw = database(`
    select coalesce(json_agg("Note" order by "Id"), '[]'::json)
    from "OrderNote"
    where "OrderId" = ${state.id} and "Id" not in (${exclusions});
  `);
  return JSON.parse(raw) as string[];
}

function restoreOrder(state: OrderState): void {
  const retained = state.noteIds.length > 0 ? state.noteIds.join(",") : "0";
  database(`
    update "Order" set "OrderStatusId" = ${state.orderStatusId} where "Id" = ${state.id};
    delete from "OrderNote" where "OrderId" = ${state.id} and "Id" not in (${retained});
  `);
}

async function waitForOrderStatus(orderId: number, target: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (observedOrderStatus(orderId) === target) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Order ${orderId} did not reach status ${target}.`);
}

async function authenticate(page: Page, password: string): Promise<void> {
  await page.goto(`${ORIGIN}/Admin`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (new URL(page.url()).pathname === "/login") {
    await page.locator("#Email").fill(ADMIN_EMAIL);
    await page.locator("#Password").fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/Admin"), { timeout: 30_000 });
  }
  if (!new URL(page.url()).pathname.startsWith("/Admin") ||
    !await page.locator('a[href="/logout"]').isVisible().catch(() => false)) {
    throw new Error("The synthetic administrator session did not authenticate.");
  }
}

function guidedAction(action: { selector: string; description: string; method: "click" | "selectOptionFromDropdown"; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local nopCommerce order action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function startUrl(input: OrderStatusInput): string {
  return `${ORIGIN}/Admin/Order/Edit/${input.orderId}`;
}

async function demonstrateOrderStatus(page: Page, input: OrderStatusInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        await page.locator("#btnChangeOrderStatus").click();
        await page.locator("#OrderStatusId").waitFor({ state: "visible", timeout: 5_000 });
        return guidedAction({
          selector: "#btnChangeOrderStatus",
          description: "Open the order status editor",
          method: "click",
        });
      }
      if (step === 2) {
        await page.locator("#OrderStatusId").selectOption(input.targetStatus);
        return guidedAction({
          selector: "#OrderStatusId",
          description: `Select order status ${input.targetStatus}`,
          method: "selectOptionFromDropdown",
          arguments: [input.targetStatus],
        });
      }
      if (step === 3) {
        await page.locator("#btnSaveOrderStatus").click();
        await page.locator("#btnSaveOrderStatus-action-confirmation-submit-button")
          .waitFor({ state: "visible", timeout: 5_000 });
        return guidedAction({
          selector: "#btnSaveOrderStatus",
          description: "Open the order status confirmation",
          method: "click",
        });
      }
      const selector = "#btnSaveOrderStatus-action-confirmation-submit-button";
      await page.locator(selector).click();
      await waitForOrderStatus(Number(input.orderId), Number(input.targetStatus));
      return guidedAction({ selector, description: "Confirm the order status transition", method: "click" });
    },
  }, page, startUrl(input), input, [
    "Open the order status editor",
    `Select order status ${input.targetStatus}`,
    "Open the order status confirmation",
    "Confirm the order status transition",
  ], OUTPUT_SELECTOR);
}

const orders = [3, 4, 2].map(orderState);
const originalPassword = passwordState(customerId());
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-nopcommerce-v2-order-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let passwordRotated = false;

try {
  const generatedPassword = rotateSyntheticPassword(originalPassword);
  passwordRotated = true;
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page, generatedPassword);
  const browserVersion = page.context().browser()?.version() ?? "unknown";

  const demonstrationInputs: OrderStatusInput[] = [
    { orderId: "3", targetStatus: "20" },
    { orderId: "4", targetStatus: "30" },
  ];
  const demonstrations: DomWorkflowDemonstration[] = [];
  const demonstrationOracles: Array<{ orderId: number; exactStatus: boolean; noteAdded: boolean; restored: boolean }> = [];
  for (const input of demonstrationInputs) {
    const state = orders.find((candidate) => candidate.id === Number(input.orderId))!;
    restoreOrder(state);
    demonstrations.push(await demonstrateOrderStatus(page, input));
    const exactStatus = observedOrderStatus(state.id) === Number(input.targetStatus);
    const noteAdded = newOrderNotes(state).length === 1;
    restoreOrder(state);
    const restored = observedOrderStatus(state.id) === state.orderStatusId &&
      JSON.stringify(observedNoteIds(state.id)) === JSON.stringify(state.noteIds);
    demonstrationOracles.push({ orderId: state.id, exactStatus, noteAdded, restored });
    if (!exactStatus || !noteAdded || !restored) {
      throw new Error(`The order-status demonstration failed its independent or cleanup oracle at order ${state.id}.`);
    }
  }

  const compileStartedAt = performance.now();
  const plan = compileDomWorkflow("nopcommerce_advance_synthetic_order_status_once", startUrl(demonstrationInputs[0]!), demonstrations, {
    effect: "write",
    confirmation: "Advance one synthetic local order to the requested later status exactly once",
  });
  const compileMs = performance.now() - compileStartedAt;
  if (plan.effect.commitActionIndex !== 0) throw new Error("The complete order transition was not withheld until commit.");

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await page.goto(`${ORIGIN}/Admin`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const authSurvivedBrowserRestart = new URL(page.url()).pathname.startsWith("/Admin") &&
    await page.locator('a[href="/logout"]').isVisible().catch(() => false);

  const unseenState = orders.find((candidate) => candidate.id === 2)!;
  const unseenInput: OrderStatusInput = { orderId: "2", targetStatus: "30" };
  restoreOrder(unseenState);
  const beforeStatus = observedOrderStatus(unseenState.id);
  const beforeNotes = observedNoteIds(unseenState.id);
  const receipt = await prepareDomWorkflowWrite(page, journal, plan, unseenInput);
  const afterPrepareStatus = observedOrderStatus(unseenState.id);
  const afterPrepareNotes = observedNoteIds(unseenState.id);
  let commitRequests = 0;
  const countCommitRequest = (): void => { commitRequests += 1; };
  page.on("request", countCommitRequest);
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, unseenInput);
  page.off("request", countCommitRequest);
  const afterCommitStatus = observedOrderStatus(unseenState.id);
  const afterCommitNotes = observedNoteIds(unseenState.id);
  const notesAdded = newOrderNotes(unseenState);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, unseenInput)
    .then(() => false, () => true);
  const afterRejectedStatus = observedOrderStatus(unseenState.id);
  const afterRejectedNotes = observedNoteIds(unseenState.id);

  const freshPage = await page.context().newPage();
  await freshPage.goto(startUrl(unseenInput), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const freshAdminExact = await freshPage.locator(OUTPUT_SELECTOR).getByText("Complete", { exact: true })
    .first().isVisible().catch(() => false);
  await freshPage.close();

  const preparedWithoutEffect = beforeStatus === unseenState.orderStatusId &&
    afterPrepareStatus === beforeStatus && JSON.stringify(afterPrepareNotes) === JSON.stringify(beforeNotes);
  const exactResult = preparedWithoutEffect && afterCommitStatus === Number(unseenInput.targetStatus) &&
    afterCommitNotes.length === beforeNotes.length + 1 && notesAdded.length === 1 && freshAdminExact &&
    repeatedCommitRejected && afterRejectedStatus === afterCommitStatus &&
    JSON.stringify(afterRejectedNotes) === JSON.stringify(afterCommitNotes) &&
    committed.receipt.status === "committed" && committed.result.modelCalls === 0;

  for (const state of orders) restoreOrder(state);
  const cleanupVerified = orders.every((state) => observedOrderStatus(state.id) === state.orderStatusId &&
    JSON.stringify(observedNoteIds(state.id)) === JSON.stringify(state.noteIds));
  const task = {
    id: "advance-synthetic-order-status-once",
    effect: "commit",
    status: "failed",
    unseen: true,
    authoringMode: "demonstrated",
    engine: "guided-file-selection-intent-guard",
    exactResult: false,
    falseSuccess: false,
    duplicateCommits: 0,
    cleanupVerified: true,
    requests: 0,
    navigations: 1,
    modelCalls: 0,
    failureClassification: "compiler-defect",
    oracleEvidence: {
      finding: "The frozen compiler intercepted 'Select order status 20' as a file-selection request because the order page contained an unrelated license-file input.",
      failedBeforeFirstDemonstrationEffect: true,
      frozenAttemptApplicationStateChanged: false,
    },
    resetEvidence: {
      frozenAttemptRequiredNoOrderReset: true,
      syntheticAdministratorPasswordRestored: true,
    },
  };
  const regressionCompilerCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    compilerCommit: FROZEN_COMPILER_COMMIT,
    corpus: { path: "bench/corpus-v2.json", freezeSha: FROZEN_COMPILER_COMMIT },
    application: {
      id: "nopcommerce-local-v2",
      name: "Self-hosted nopCommerce 4.90.6",
      environment: `Loopback official container; ${process.platform}/${process.arch}; Chrome ${browserVersion}`,
      policyReviewDate: "2026-09-05",
      trafficBudget: "Local installation; restore sample order status and remove generated notes",
    },
    compileMs: Number(compileMs.toFixed(2)),
    authSurvivedBrowserRestart,
    intervention: "guided demonstrations",
    credentialHandling: "Rotated a synthetic administrator password in memory and restored the prior password row; no credential or session value was persisted",
    demonstrationOracles,
    tasks: [task],
    regression: {
      compilerCommit: regressionCompilerCommit,
      status: exactResult ? "passed" : "failed",
      claimEligible: false,
      reasonExcluded: "The frozen task exposed the compiler defect that motivated this intent-classification fix.",
      engine: plan.engine,
      exactResult,
      preparedWithoutEffect,
      repeatedCommitRejected,
      duplicateCommits: repeatedCommitRejected ? 0 : 1,
      cleanupVerified,
      requests: commitRequests,
      navigations: committed.result.navigations,
      modelCalls: committed.result.modelCalls,
      oracleEvidence: {
        orderId: unseenState.id,
        priorStatus: beforeStatus,
        requestedStatus: Number(unseenInput.targetStatus),
        databaseStatus: afterCommitStatus,
        freshAdminExact,
        notesAdded: notesAdded.length,
        afterRejectedRepeatUnchanged: afterRejectedStatus === afterCommitStatus &&
          JSON.stringify(afterRejectedNotes) === JSON.stringify(afterCommitNotes),
      },
      resetEvidence: {
        restoredStatus: cleanupVerified,
        restoredOriginalNoteIds: cleanupVerified,
      },
    },
    summary: {
      passed: 0,
      total: 1,
      successRate: 0,
      falseSuccesses: 0,
      duplicateCommits: 0,
    },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "nopcommerce-v2-order-status.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!authSurvivedBrowserRestart || !exactResult || !cleanupVerified || task.duplicateCommits !== 0) {
    throw new Error(`nopCommerce v2 order task failed: ${JSON.stringify({ authSurvivedBrowserRestart, exactResult, cleanupVerified, duplicateCommits: task.duplicateCommits })}`);
  }
  console.log(JSON.stringify({
    reportPath,
    frozenHoldoutPassed: false,
    regressionPassed: exactResult,
    repeatedCommitRejected,
    cleanupVerified,
    compileMs: report.compileMs,
    compiledDurationMs: Number(committed.result.durationMs.toFixed(2)),
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  let restorationError: unknown;
  try {
    for (const state of orders) restoreOrder(state);
  } catch (error) {
    restorationError = error;
  }
  try {
    if (passwordRotated) setPassword(originalPassword);
  } catch (error) {
    restorationError ??= error;
  }
  await rm(directory, { recursive: true, force: true });
  if (restorationError) throw restorationError;
}
