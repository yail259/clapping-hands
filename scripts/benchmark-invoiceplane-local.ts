import { randomBytes } from "node:crypto";
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

const ORIGIN = process.env.CLAPPING_HANDS_INVOICEPLANE_ORIGIN ?? "http://127.0.0.1:18096";
const APP_CONTAINER = process.env.CLAPPING_HANDS_INVOICEPLANE_APP_CONTAINER ??
  "clapping-hands-invoiceplane-app";
const DB_CONTAINER = process.env.CLAPPING_HANDS_INVOICEPLANE_DB_CONTAINER ??
  "clapping-hands-invoiceplane-db";
const ADMIN_EMAIL = "admin@clapping-hands.invalid";
const START_URL = `${ORIGIN}/invoices`;
const OUTPUT_SELECTOR = "#content";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const INVOICEPLANE_VERSION = "1.7.2";
const INVOICEPLANE_SOURCE_COMMIT = "aaeea1e4825785c6138fa84be49ac373bac4f0af";
const INVOICEPLANE_IMAGE_DIGEST = "sha256:f9567a143b25da43c334a09ec31e6789614079f0702010b1c4eb0f9701b1abba";
const SYNTHETIC_CLIENT_PREFIX = "Clapping Hands Fixture ";

if (!process.argv.includes("--local")) {
  throw new Error("InvoicePlane fixture traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The InvoicePlane benchmark only permits a loopback origin.");
}
for (const container of [APP_CONTAINER, DB_CONTAINER]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) {
    throw new Error("An InvoicePlane fixture container name is invalid.");
  }
}

type InvoiceInput = DomInput & {
  clientName: string;
  itemName: string;
  quantity: string;
  unitPrice: string;
};

type InvoiceRow = {
  invoiceId: number;
  itemId: number;
  statusId: number;
  clientName: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  total: number;
  balance: number;
};

const inputs: InvoiceInput[] = [
  {
    clientName: `${SYNTHETIC_CLIENT_PREFIX}Alpha`,
    itemName: "Clapping Hands Audit Alpha",
    quantity: "2",
    unitPrice: "19.50",
  },
  {
    clientName: `${SYNTHETIC_CLIENT_PREFIX}Beta`,
    itemName: "Clapping Hands Audit Beta",
    quantity: "3",
    unitPrice: "7.25",
  },
  {
    clientName: `${SYNTHETIC_CLIENT_PREFIX}Gamma`,
    itemName: "Clapping Hands Audit Gamma",
    quantity: "4",
    unitPrice: "11.50",
  },
];

function containerEnvironment(container: string): string[] {
  const inspected = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" })) as Array<{
    Config?: { Env?: string[] };
  }>;
  return inspected[0]?.Config?.Env ?? [];
}

const databasePassword = containerEnvironment(APP_CONTAINER)
  .find((entry) => entry.startsWith("DB_PASSWORD="))?.slice("DB_PASSWORD=".length);
if (!databasePassword) throw new Error("The InvoicePlane fixture database credential is unavailable.");

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function runDatabase(sql: string): string {
  return execFileSync("docker", [
    "exec",
    "-e",
    `MYSQL_PWD=${databasePassword}`,
    DB_CONTAINER,
    "mariadb",
    "-uinvoiceplane",
    "-Dinvoiceplane",
    "-N",
    "-e",
    sql,
  ], { encoding: "utf8" }).trim();
}

function imageId(reference: string): string {
  return execFileSync("docker", ["image", "inspect", reference, "--format", "{{.Id}}"], {
    encoding: "utf8",
  }).trim();
}

function rotateSyntheticAdministrator(): string {
  const password = randomBytes(24).toString("base64url");
  const hash = execFileSync("docker", [
    "exec",
    "-e",
    `CLAPPING_HANDS_PASSWORD=${password}`,
    APP_CONTAINER,
    "php",
    "-r",
    'echo password_hash(getenv("CLAPPING_HANDS_PASSWORD"), PASSWORD_BCRYPT);',
  ], { encoding: "utf8" }).trim();
  const salt = randomBytes(16).toString("hex");
  const changed = runDatabase(`
    UPDATE ip_users
    SET user_password=${sqlLiteral(hash)}, user_psalt=${sqlLiteral(salt)}
    WHERE user_email=${sqlLiteral(ADMIN_EMAIL)};
    SELECT ROW_COUNT();
  `).split(/\s+/).at(-1);
  if (changed !== "1") throw new Error("The synthetic InvoicePlane administrator could not be rotated.");
  return password;
}

function syntheticInvoiceIds(): number[] {
  const output = runDatabase(`
    SELECT DISTINCT i.invoice_id
    FROM ip_invoices i
    JOIN ip_clients c ON c.client_id=i.client_id
    WHERE c.client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)}
    ORDER BY i.invoice_id;
  `);
  if (!output) return [];
  const ids = output.split(/\s+/).map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("The InvoicePlane fixture returned an invalid synthetic invoice id.");
  }
  return ids;
}

function removeInvoices(ids: number[]): void {
  if (ids.length === 0) return;
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("Refusing to remove invalid InvoicePlane invoice ids.");
  }
  const list = ids.join(",");
  runDatabase(`
    START TRANSACTION;
    DELETE FROM ip_payments WHERE invoice_id IN (${list});
    DELETE FROM ip_merchant_responses WHERE invoice_id IN (${list});
    DELETE FROM ip_invoice_tax_rates WHERE invoice_id IN (${list});
    DELETE FROM ip_invoice_sumex WHERE sumex_invoice IN (${list});
    DELETE FROM ip_invoice_custom WHERE invoice_id IN (${list});
    DELETE FROM ip_invoice_items WHERE invoice_id IN (${list});
    DELETE FROM ip_invoice_amounts WHERE invoice_id IN (${list});
    DELETE FROM ip_invoices_recurring WHERE invoice_id IN (${list});
    DELETE FROM ip_quotes WHERE invoice_id IN (${list});
    DELETE FROM ip_invoices WHERE invoice_id IN (${list});
    COMMIT;
  `);
}

function cleanupSyntheticData(): void {
  removeInvoices(syntheticInvoiceIds());
  runDatabase(`
    START TRANSACTION;
    DELETE uc FROM ip_user_clients uc
      JOIN ip_clients c ON c.client_id=uc.client_id
      WHERE c.client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)};
    DELETE cc FROM ip_client_custom cc
      JOIN ip_clients c ON c.client_id=cc.client_id
      WHERE c.client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)};
    DELETE cn FROM ip_client_notes cn
      JOIN ip_clients c ON c.client_id=cn.client_id
      WHERE c.client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)};
    DELETE FROM ip_clients WHERE client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)};
    COMMIT;
  `);
}

function seedSyntheticClients(): void {
  const userId = Number(runDatabase(`SELECT user_id FROM ip_users WHERE user_email=${sqlLiteral(ADMIN_EMAIL)};`));
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error("The synthetic InvoicePlane administrator is missing.");
  const statements = inputs.map((input, index) => `
    INSERT INTO ip_clients (
      client_date_created, client_date_modified, client_name, client_company, client_language, client_active
    ) VALUES (
      NOW(), NOW(), ${sqlLiteral(input.clientName)}, ${sqlLiteral(`Fixture Company ${index + 1}`)}, 'system', 1
    );
    SET @client_${index}=LAST_INSERT_ID();
    INSERT INTO ip_user_clients (user_id, client_id) VALUES (${userId}, @client_${index});
  `).join("\n");
  runDatabase(`START TRANSACTION; ${statements} COMMIT;`);
  const count = Number(runDatabase(`
    SELECT COUNT(*) FROM ip_clients WHERE client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)};
  `));
  if (count !== inputs.length) throw new Error("The synthetic InvoicePlane clients were not seeded exactly once.");
}

function invoiceRows(input: InvoiceInput): InvoiceRow[] {
  const output = runDatabase(`
    SELECT i.invoice_id, ii.item_id, i.invoice_status_id, c.client_name, ii.item_name,
      ii.item_quantity, ii.item_price, ia.invoice_item_subtotal, ia.invoice_total, ia.invoice_balance
    FROM ip_invoices i
    JOIN ip_clients c ON c.client_id=i.client_id
    JOIN ip_invoice_items ii ON ii.invoice_id=i.invoice_id
    JOIN ip_invoice_amounts ia ON ia.invoice_id=i.invoice_id
    WHERE c.client_name=${sqlLiteral(input.clientName)} AND ii.item_name=${sqlLiteral(input.itemName)}
    ORDER BY i.invoice_id;
  `);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [invoiceId, itemId, statusId, clientName, itemName, quantity, unitPrice, subtotal, total, balance] =
      line.split("\t");
    return {
      invoiceId: Number(invoiceId),
      itemId: Number(itemId),
      statusId: Number(statusId),
      clientName: clientName ?? "",
      itemName: itemName ?? "",
      quantity: Number(quantity),
      unitPrice: Number(unitPrice),
      subtotal: Number(subtotal),
      total: Number(total),
      balance: Number(balance),
    };
  });
}

function expectedTotal(input: InvoiceInput): number {
  return Number(input.quantity) * Number(input.unitPrice);
}

function exactInvoiceRow(input: InvoiceInput, row: InvoiceRow | undefined): boolean {
  const expected = expectedTotal(input);
  return Boolean(row) && row!.statusId === 1 && row!.clientName === input.clientName &&
    row!.itemName === input.itemName && row!.quantity === Number(input.quantity) &&
    row!.unitPrice === Number(input.unitPrice) && row!.subtotal === expected &&
    row!.total === expected && row!.balance === expected;
}

async function waitForInvoice(input: InvoiceInput): Promise<InvoiceRow[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = invoiceRows(input);
    if (rows.length > 0) return rows;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The synthetic InvoicePlane draft for ${input.clientName} did not become observable.`);
}

async function login(page: Page, password: string): Promise<void> {
  await page.goto(`${ORIGIN}/sessions/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#email").isVisible().catch(() => false)) {
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(password);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/dashboard", { waitUntil: "domcontentloaded", timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.locator("nav").filter({ hasText: "Dashboard" }).waitFor({ state: "visible", timeout: 30_000 });
}

function guidedClick(selector: string, description: string) {
  return {
    success: true,
    message: "guided local InvoicePlane action",
    actions: [{ selector, description, method: "click" }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function guidedFill(selector: string, description: string, value: string) {
  return {
    success: true,
    message: "guided local InvoicePlane action",
    actions: [{ selector, description, method: "fill", arguments: [value] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateInvoice(page: Page, input: InvoiceInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  const clientPicker =
    '#create-invoice .select2-selection[aria-labelledby="select2-create_invoice_client_id-container"]';
  const clientSearch = ".select2-container--open .select2-search__field";
  const clientResult = `.select2-container--open [role=option]:has-text(${JSON.stringify(input.clientName)})`;
  const itemName = "#item_table .item:visible input[name=item_name]";
  const quantity = "#item_table .item:visible input[name=item_quantity]";
  const unitPrice = "#item_table .item:visible input[name=item_price]";
  const total = expectedTotal(input).toFixed(2);

  const demonstration = await demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        await page.locator("a.create-invoice").click();
        await page.locator("#create-invoice").waitFor({ state: "visible", timeout: 15_000 });
        return guidedClick("a.create-invoice", "Open the draft invoice dialog");
      }
      if (step === 2) {
        await page.locator(clientPicker).click();
        await page.locator(clientSearch).waitFor({ state: "visible", timeout: 15_000 });
        return guidedClick(clientPicker, "Open the fixture client picker");
      }
      if (step === 3) {
        await page.locator(clientSearch).fill(input.clientName);
        await page.locator(clientResult).waitFor({ state: "visible", timeout: 15_000 });
        return guidedFill(clientSearch, "Search for the requested fixture client", input.clientName);
      }
      if (step === 4) {
        await page.locator(clientResult).click();
        await page.locator("#select2-create_invoice_client_id-container").filter({ hasText: input.clientName })
          .waitFor({ state: "visible", timeout: 15_000 });
        return guidedClick(clientResult, "Choose the requested fixture client");
      }
      if (step === 5) {
        await Promise.all([
          page.waitForURL((url) => /^\/invoices\/view\/\d+$/.test(url.pathname), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }),
          page.locator("#invoice_create_confirm").click(),
        ]);
        await page.locator(itemName).waitFor({ state: "visible", timeout: 30_000 });
        return guidedClick("#invoice_create_confirm", "Submit the synthetic draft invoice header");
      }
      if (step === 6) {
        await page.locator(itemName).fill(input.itemName);
        return guidedFill(itemName, "Fill the synthetic line-item name", input.itemName);
      }
      if (step === 7) {
        await page.locator(quantity).fill(input.quantity);
        return guidedFill(quantity, "Fill the synthetic line-item quantity", input.quantity);
      }
      if (step === 8) {
        await page.locator(unitPrice).fill(input.unitPrice);
        return guidedFill(unitPrice, "Fill the synthetic line-item unit price", input.unitPrice);
      }
      await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/invoices/ajax/save" && response.ok(), { timeout: 30_000 }),
        page.locator("#btn_save_invoice").click(),
      ]);
      await page.locator("#content .alert").filter({ hasText: "Record successfully updated" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page.locator(OUTPUT_SELECTOR).filter({ hasText: `$${total}` }).waitFor({ state: "visible", timeout: 15_000 });
      return guidedClick("#btn_save_invoice", "Save the synthetic draft invoice");
    },
  }, page, START_URL, input, [
    "Open the draft invoice dialog",
    "Open the fixture client picker",
    "Search for the requested fixture client",
    "Choose the requested fixture client",
    "Submit the synthetic draft invoice header",
    "Fill the synthetic line-item name",
    "Fill the synthetic line-item quantity",
    "Fill the synthetic line-item unit price",
    "Save the synthetic draft invoice",
  ], OUTPUT_SELECTOR);

  const rows = await waitForInvoice(input);
  if (rows.length !== 1 || !exactInvoiceRow(input, rows[0])) {
    throw new Error("A guided InvoicePlane demonstration failed its database oracle.");
  }
  return demonstration;
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-invoiceplane-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;
try {
  cleanupSyntheticData();
  seedSyntheticClients();
  const password = rotateSyntheticAdministrator();

  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await login(page, password);

  const demonstrations: DomWorkflowDemonstration[] = [];
  for (const input of inputs.slice(0, 2)) {
    demonstrations.push(await demonstrateInvoice(page, input));
    removeInvoices(invoiceRows(input).map((row) => row.invoiceId));
  }
  const plan = compileDomWorkflow("invoiceplane_create_draft_invoice", START_URL, demonstrations, {
    effect: "write",
    confirmation: "Create one synthetic draft invoice in the loopback-only InvoicePlane fixture",
  });
  const demonstratedValues = inputs.slice(0, 2).flatMap((input) => Object.values(input));
  if (demonstratedValues.some((value) => JSON.stringify(plan).includes(String(value)))) {
    throw new Error("The compiled InvoicePlane plan retained a demonstrated input value.");
  }
  if (plan.actions.length !== 9 || plan.effect.commitActionIndex !== 2 ||
    !plan.validation.inputEvidenceNames?.includes("clientName")) {
    throw new Error("The InvoicePlane plan did not retain the frozen action/effect/output contract.");
  }

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredCookies = (await (await browser.context()).cookies([ORIGIN])).length;
  if (restoredCookies === 0) throw new Error("InvoicePlane auth state did not survive a clean browser restart.");

  const replayInput = inputs[2]!;
  const beforePrepare = invoiceRows(replayInput);
  const prepareUrl = page.url();
  const receipt = await prepareDomWorkflowWrite(page, journal, plan, replayInput);
  const afterPrepare = invoiceRows(replayInput);
  const prepareLeftBrowserUntouched = page.url() === prepareUrl;
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, replayInput);
  const afterCommit = await waitForInvoice(replayInput);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, replayInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = invoiceRows(replayInput);
  const visibleItemName = await page.locator("#item_table .item:visible input[name=item_name]").inputValue();
  const visibleQuantity = Number(await page.locator("#item_table .item:visible input[name=item_quantity]").inputValue());
  const visibleUnitPrice = Number(await page.locator("#item_table .item:visible input[name=item_price]").inputValue());
  const renderedTotal = `$${expectedTotal(replayInput).toFixed(2)}`;

  const exactResult = beforePrepare.length === 0 && afterPrepare.length === 0 && prepareLeftBrowserUntouched &&
    afterCommit.length === 1 && exactInvoiceRow(replayInput, afterCommit[0]) &&
    afterRejectedRepeat.length === 1 && afterRejectedRepeat[0]?.invoiceId === afterCommit[0]?.invoiceId &&
    afterRejectedRepeat[0]?.itemId === afterCommit[0]?.itemId && committed.receipt.status === "committed" &&
    committed.result.modelCalls === 0 && repeatedCommitRejected &&
    committed.result.text.includes(replayInput.clientName) && committed.result.text.includes(renderedTotal) &&
    visibleItemName === replayInput.itemName && visibleQuantity === Number(replayInput.quantity) &&
    visibleUnitPrice === Number(replayInput.unitPrice);

  cleanupSyntheticData();
  cleanupVerified = syntheticInvoiceIds().length === 0 && Number(runDatabase(`
    SELECT COUNT(*) FROM ip_clients WHERE client_name LIKE ${sqlLiteral(`${SYNTHETIC_CLIENT_PREFIX}%`)};
  `)) === 0;

  const rows = [{
    task: "create-unseen-draft-invoice-with-line-item",
    effect: "write",
    architecture: "CodeIgniter server UI with Select2 AJAX lookup and jQuery JSON line-item save",
    path: "compiled-dom-prepare-commit",
    exactResult,
    preparedWithoutEffect: afterPrepare.length === 0,
    prepareLeftBrowserUntouched,
    receiptStatus: committed.receipt.status,
    repeatedCommitRejected,
    oracle: {
      databaseRowsAfterCommit: afterCommit.length,
      exactDatabaseRecordAndTotals: exactInvoiceRow(replayInput, afterCommit[0]),
      unchangedAfterRejectedRepeat: afterRejectedRepeat[0]?.invoiceId === afterCommit[0]?.invoiceId &&
        afterRejectedRepeat[0]?.itemId === afterCommit[0]?.itemId,
      renderedClientMatched: committed.result.text.includes(replayInput.clientName),
      renderedTotalMatched: committed.result.text.includes(renderedTotal),
      visibleItemFieldsMatched: visibleItemName === replayInput.itemName &&
        visibleQuantity === Number(replayInput.quantity) && visibleUnitPrice === Number(replayInput.unitPrice),
    },
    outputEvidenceNames: plan.validation.inputEvidenceNames,
    compiledModelCalls: committed.result.modelCalls,
    compiledDurationMs: Number(committed.result.durationMs.toFixed(2)),
  }];
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: `Self-hosted InvoicePlane ${INVOICEPLANE_VERSION}`,
    origin: ORIGIN,
    source: {
      repository: "https://github.com/InvoicePlane/InvoicePlane",
      tag: `v${INVOICEPLANE_VERSION}`,
      commit: INVOICEPLANE_SOURCE_COMMIT,
    },
    containerImages: {
      application: imageId("clapping-hands-invoiceplane:1.7.2"),
      expectedApplication: INVOICEPLANE_IMAGE_DIGEST,
      database: imageId("mariadb:11.4"),
    },
    intervention: "guided",
    policyBasis: "Loopback-only official source/container recipe with one synthetic administrator, three synthetic clients, and synthetic drafts",
    credentialHandling: "Rotated the disposable administrator password in memory; persisted no credential, cookie, or session material in plans or reports",
    claimScope: "Capability regression on one pinned InvoicePlane workflow; not a speed or untouched-holdout result",
    apiDisposition: "No task-complete first-party external invoice CRUD API was identified in the pinned release documentation; the exercised AJAX controllers are authenticated UI internals",
    environment: {
      browserVersion: await page.context().browser()?.version(),
      platform: process.platform,
      architecture: process.arch,
    },
    authSurvivedBrowserRestart: restoredCookies > 0,
    fixtureCleanupVerified: cleanupVerified,
    plan: {
      actionCount: plan.actions.length,
      commitActionIndex: plan.effect.commitActionIndex,
      outputMode: plan.validation.outputMode,
      inputEvidenceNames: plan.validation.inputEvidenceNames,
    },
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: repeatedCommitRejected ? 0 : 1,
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.duplicateCommits !== 0 ||
    !report.authSurvivedBrowserRestart || !cleanupVerified ||
    report.containerImages.application !== report.containerImages.expectedApplication) {
    throw new Error(`InvoicePlane capability run failed: ${JSON.stringify(report.summary)}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "invoiceplane-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (!cleanupVerified) {
    try { cleanupSyntheticData(); } catch { /* best-effort exact synthetic cleanup */ }
  }
  await rm(directory, { recursive: true, force: true });
}
