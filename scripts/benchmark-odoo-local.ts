import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  navigateForCompiledDomWorkflow,
  replayDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = process.env.CLAPPING_HANDS_ODOO_ORIGIN ?? "http://127.0.0.1:18102";
const CONTAINER = process.env.CLAPPING_HANDS_ODOO_CONTAINER ?? "clapping-hands-odoo";
const DATABASE_HOST = process.env.CLAPPING_HANDS_ODOO_DATABASE_HOST ?? "clapping-hands-odoo-db";
const DATABASE = process.env.CLAPPING_HANDS_ODOO_DATABASE ?? "ch_benchmark";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SALES_URL = `${ORIGIN}/odoo/sales`;
const OUTPUT_SELECTOR = ".o_list_view";
const ODOO_IMAGE = "odoo:19.0";
const ODOO_IMAGE_DIGEST = "sha256:f99ffac95cb39a0924622ea4118481c95651d9c84187e5b30a21c2cc4419c7dd";
const POSTGRES_IMAGE = "postgres:15";
const POSTGRES_IMAGE_DIGEST = "sha256:9b1d34adbce1dd07ee6e94b4a2cf698884b89bd44a6c9c12f5da8f3acbfe4957";

if (!process.argv.includes("--local")) {
  throw new Error("Odoo local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The Odoo benchmark only permits a loopback origin.");
}
for (const identifier of [CONTAINER, DATABASE_HOST, DATABASE]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(identifier)) {
    throw new Error("An Odoo fixture identifier is invalid.");
  }
}

type SearchInput = DomInput & { query: string };
type QuantityInput = DomInput & { orderId: number; quantity: number };
type ConfirmInput = DomInput & { orderId: number };
type OrderSnapshot = {
  id: number;
  name: string;
  customer: string;
  reference: string;
  state: string;
  quantity: number;
  writeDate: string;
};
type Fixture = {
  adminId: number;
  priorPasswordHash: string | null;
  orders: OrderSnapshot[];
};
type Cleanup = { orders: number; partners: number; products: number; passwordRestored: boolean };

const databaseArguments = [
  `--db_host=${DATABASE_HOST}`,
  "--db_user=odoo",
  "--db_password=",
];

function odooShell(source: string): string {
  try {
    return execFileSync("docker", [
      "exec", "-i", CONTAINER, "odoo", "shell", "-d", DATABASE, "--no-http", ...databaseArguments,
    ], {
      input: source,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    throw new Error("The Odoo fixture command failed; secret-bearing stdin was suppressed.");
  }
}

function fixtureJson<T>(source: string): T {
  const output = odooShell(source);
  const line = output.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("CH_JSON="));
  if (!line) throw new Error("The Odoo fixture command did not return JSON.");
  return JSON.parse(line.slice("CH_JSON=".length)) as T;
}

function setupFixture(password: string): Fixture {
  const raw = fixtureJson<{
    adminId: number;
    priorPasswordHash: string | null;
    orders: OrderSnapshot[];
  }>(`
import json
admin = env.ref("base.user_admin")
env.cr.execute("SELECT password FROM res_users WHERE id=%s", (admin.id,))
prior_hash = env.cr.fetchone()[0]
orders = env["sale.order"].search([("client_order_ref", "like", "CH-%")])
pickings = orders.picking_ids
for order in orders:
    if order.state not in ("draft", "cancel"):
        order.action_cancel()
for picking in pickings.exists():
    if picking.state != "cancel":
        picking.action_cancel()
pickings.exists().unlink()
orders.exists().unlink()
env["res.partner"].search([("ref", "like", "CH-CUSTOMER-%")]).unlink()
env["product.product"].search([("default_code", "like", "CH-WIDGET-%")]).unlink()
rows = []
for suffix, quantity in [("Alpha", 2.0), ("Beta", 3.0), ("Gamma", 4.0)]:
    partner = env["res.partner"].create({"name": "CH Customer " + suffix, "ref": "CH-CUSTOMER-" + suffix.upper()})
    product = env["product.product"].create({"name": "CH Widget " + suffix, "default_code": "CH-WIDGET-" + suffix.upper(), "list_price": 10.0 + quantity, "type": "service"})
    order = env["sale.order"].create({"partner_id": partner.id, "client_order_ref": "CH-" + suffix.upper(), "user_id": admin.id})
    env["sale.order.line"].create({"order_id": order.id, "product_id": product.id, "name": product.name, "product_uom_qty": quantity, "product_uom_id": product.uom_id.id, "price_unit": product.list_price})
    rows.append({"id": order.id, "name": order.name, "customer": partner.name, "reference": order.client_order_ref, "state": order.state, "quantity": order.order_line[0].product_uom_qty, "writeDate": str(order.write_date)})
admin.password = ${JSON.stringify(password)}
env.cr.commit()
print("CH_JSON=" + json.dumps({"adminId": admin.id, "priorPasswordHash": prior_hash, "orders": rows}))
`);
  if (!Number.isSafeInteger(raw.adminId) || raw.adminId < 1 || raw.orders.length !== 3 ||
    raw.orders.some((order) => !Number.isSafeInteger(order.id) || order.state !== "draft")) {
    throw new Error("The Odoo fixture manifest had an unexpected shape.");
  }
  return raw;
}

function orderSnapshot(): OrderSnapshot[] {
  return fixtureJson<OrderSnapshot[]>(`
import json
orders = env["sale.order"].search([("client_order_ref", "like", "CH-%")], order="id")
rows = []
for order in orders:
    rows.append({"id": order.id, "name": order.name, "customer": order.partner_id.name, "reference": order.client_order_ref, "state": order.state, "quantity": order.order_line[0].product_uom_qty if order.order_line else 0, "writeDate": str(order.write_date)})
print("CH_JSON=" + json.dumps(rows))
`);
}

function cleanupFixture(fixture: Fixture): Cleanup {
  const priorHashLiteral = fixture.priorPasswordHash === null ? "None" : JSON.stringify(fixture.priorPasswordHash);
  return fixtureJson<Cleanup>(`
import json
orders = env["sale.order"].search([("client_order_ref", "like", "CH-%")])
pickings = orders.picking_ids
for order in orders:
    if order.state not in ("draft", "cancel"):
        order.action_cancel()
for picking in pickings.exists():
    if picking.state != "cancel":
        picking.action_cancel()
pickings.exists().unlink()
orders.exists().unlink()
env["res.partner"].search([("ref", "like", "CH-CUSTOMER-%")]).unlink()
env["product.product"].search([("default_code", "like", "CH-WIDGET-%")]).unlink()
env.cr.execute("UPDATE res_users SET password=%s WHERE id=%s", (${priorHashLiteral}, ${fixture.adminId}))
env.cr.commit()
orders_count = env["sale.order"].search_count([("client_order_ref", "like", "CH-%")])
partners_count = env["res.partner"].search_count([("ref", "like", "CH-CUSTOMER-%")])
products_count = env["product.product"].search_count([("default_code", "like", "CH-WIDGET-%")])
env.cr.execute("SELECT password IS NOT DISTINCT FROM %s FROM res_users WHERE id=%s", (${priorHashLiteral}, ${fixture.adminId}))
password_restored = bool(env.cr.fetchone()[0])
print("CH_JSON=" + json.dumps({"orders": orders_count, "partners": partners_count, "products": products_count, "passwordRestored": password_restored}))
`);
}

async function waitForOrigin(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/web/login?db=${encodeURIComponent(DATABASE)}`, {
        signal: AbortSignal.timeout(3_000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Keep the bounded readiness probe quiet until the deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("The loopback Odoo fixture did not become ready.");
}

async function authenticate(page: Page, password: string): Promise<void> {
  await navigateForCompiledDomWorkflow(page, `${ORIGIN}/web/login?db=${encodeURIComponent(DATABASE)}`);
  if (await page.locator("input[name=login]").isVisible().catch(() => false)) {
    await page.locator("input[name=login]").fill("admin");
    await page.locator("input[name=password]").fill(password);
    await page.locator("button[type=submit]").click();
  }
  await page.locator(".o_web_client").waitFor({ state: "visible", timeout: 30_000 });
  await navigateForCompiledDomWorkflow(page, SALES_URL);
  await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
}

function guidedAction(action: { selector: string; description: string; method: string; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local Odoo action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateSearch(page: Page, input: SearchInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      const selector = ".o_searchview_input";
      if (step === 1) {
        await page.locator(selector).fill(input.query);
        return guidedAction({
          selector,
          description: `Enter quotation search ${input.query}`,
          method: "fill",
          arguments: [input.query],
        });
      }
      await page.locator(selector).press("Enter");
      await page.waitForFunction((query) => {
        const rows = Array.from(document.querySelectorAll(".o_data_row"));
        return rows.length === 1 && rows[0]?.textContent?.includes(String(query));
      }, input.query, { timeout: 15_000 });
      return guidedAction({
        selector,
        description: `Search quotations for ${input.query}`,
        method: "press",
        arguments: ["Enter"],
      });
    },
  }, page, SALES_URL, input, [
    `Enter quotation search ${input.query}`,
    `Search quotations for ${input.query}`,
  ], OUTPUT_SELECTOR);
}

function orderUrl(orderId: number): string {
  return `${ORIGIN}/odoo/sales/${orderId}`;
}

async function waitForOrder(
  orderId: number,
  predicate: (order: OrderSnapshot) => boolean,
  label: string,
): Promise<OrderSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const order = orderSnapshot().find((candidate) => candidate.id === orderId);
    if (order && predicate(order)) return order;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The Odoo database did not reach the expected ${label} state.`);
}

async function demonstrateQuantityEdit(page: Page, input: QuantityInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  const quantity = String(input.quantity);
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = 'td[name="product_uom_qty"]';
        await page.locator(selector).click();
        return guidedAction({ selector, description: "Open the synthetic line quantity control", method: "click" });
      }
      if (step === 2) {
        const selector = 'td[name="product_uom_qty"] input';
        await page.locator(selector).fill(quantity);
        return guidedAction({
          selector,
          description: `Enter synthetic line quantity ${quantity}`,
          method: "fill",
          arguments: [quantity],
        });
      }
      if (step === 3) {
        const selector = 'td[name="product_uom_qty"] input';
        await page.locator(selector).press("Tab");
        return guidedAction({ selector, description: "Leave the synthetic quantity control", method: "press", arguments: ["Tab"] });
      }
      const selector = 'button[aria-label="Save manually"]';
      await page.locator(selector).click();
      await waitForOrder(input.orderId, (order) => order.quantity === input.quantity, "quantity demonstration");
      return guidedAction({ selector, description: "Save the synthetic quotation changes", method: "click" });
    },
  }, page, orderUrl(input.orderId), input, [
    "Open the synthetic line quantity control",
    `Enter synthetic line quantity ${quantity}`,
    "Leave the synthetic quantity control",
    "Save the synthetic quotation changes",
  ], ".o_form_view");
}

async function demonstrateConfirmation(page: Page, input: ConfirmInput): Promise<DomWorkflowDemonstration> {
  const selector = 'button[name="action_confirm"]';
  return demonstrateDomWorkflow({
    act: async () => {
      await page.locator(selector).click();
      await waitForOrder(input.orderId, (order) => order.state === "sale", "confirmation demonstration");
      return guidedAction({ selector, description: "Confirm the synthetic quotation", method: "click" });
    },
  }, page, orderUrl(input.orderId), input, ["Confirm the synthetic quotation"], ".o_form_view");
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-odoo-"));
const password = randomBytes(24).toString("base64url");
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let fixture: Fixture | null = null;
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;

try {
  await waitForOrigin();
  fixture = setupFixture(password);
  const before = orderSnapshot();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page, password);

  const searchDemonstrations = [
    await demonstrateSearch(page, { query: fixture.orders[0]!.customer }),
    await demonstrateSearch(page, { query: fixture.orders[1]!.customer }),
  ];
  let compileStartedAt = performance.now();
  const searchPlan = compileDomWorkflow("odoo_search_quotations", SALES_URL, searchDemonstrations);
  const searchCompileMs = performance.now() - compileStartedAt;

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await navigateForCompiledDomWorkflow(page, SALES_URL);
  const authSurvivedBrowserRestart = await page.locator(".o_web_client").isVisible().catch(() => false) &&
    !await page.locator("input[name=password]").isVisible().catch(() => false);
  const unseenInput: SearchInput = { query: fixture.orders[2]!.customer };
  const seededDecoyCustomers = [fixture.orders[0]!.customer, fixture.orders[1]!.customer];
  let replayRequests = 0;
  const countReplayRequest = (): void => { replayRequests += 1; };
  page.on("request", countReplayRequest);
  const searchReplay = await replayDomWorkflow(page, searchPlan, unseenInput);
  page.off("request", countReplayRequest);
  const visibleResultRows = (await page.locator(".o_data_row").allTextContents())
    .map((text) => text.replace(/\s+/g, " ").trim());
  const searchInputValue = await page.locator(".o_searchview_input").inputValue();
  const afterSearch = orderSnapshot();
  const searchExact = searchReplay.modelCalls === 0 && visibleResultRows.length === 1 &&
    visibleResultRows[0]!.includes(unseenInput.query) &&
    seededDecoyCustomers.every((customer) => !visibleResultRows[0]!.includes(customer)) &&
    JSON.stringify(afterSearch) === JSON.stringify(before);

  const quantityDemonstrations: DomWorkflowDemonstration[] = [];
  const quantityDemonstrationOracles: Array<{ orderId: number; expected: number; observed: number; exact: boolean }> = [];
  const quantityInputs: QuantityInput[] = [
    { orderId: fixture.orders[0]!.id, quantity: 5 },
    { orderId: fixture.orders[1]!.id, quantity: 6 },
  ];
  for (const input of quantityInputs) {
    quantityDemonstrations.push(await demonstrateQuantityEdit(page, input));
    const observed = orderSnapshot().find((order) => order.id === input.orderId)?.quantity ?? Number.NaN;
    quantityDemonstrationOracles.push({
      orderId: input.orderId,
      expected: input.quantity,
      observed,
      exact: observed === input.quantity,
    });
  }
  compileStartedAt = performance.now();
  const quantityPlan = compileDomWorkflow(
    "odoo_update_quotation_line_quantity",
    orderUrl(quantityInputs[0]!.orderId),
    quantityDemonstrations,
    { effect: "write", confirmation: "Update one synthetic quotation line quantity in the loopback-only Odoo fixture" },
  );
  const quantityCompileMs = performance.now() - compileStartedAt;
  if (quantityPlan.effect.commitActionIndex !== 1 || quantityDemonstrationOracles.some((oracle) => !oracle.exact)) {
    throw new Error("The Odoo quantity demonstrations or effect boundary were not exact.");
  }

  const confirmationDemonstrations: DomWorkflowDemonstration[] = [];
  const confirmationDemonstrationOracles: Array<{ orderId: number; observed: string; exact: boolean }> = [];
  const confirmationInputs: ConfirmInput[] = quantityInputs.map(({ orderId }) => ({ orderId }));
  for (const input of confirmationInputs) {
    confirmationDemonstrations.push(await demonstrateConfirmation(page, input));
    const observed = orderSnapshot().find((order) => order.id === input.orderId)?.state ?? "missing";
    confirmationDemonstrationOracles.push({ orderId: input.orderId, observed, exact: observed === "sale" });
  }
  compileStartedAt = performance.now();
  const confirmationPlan = compileDomWorkflow(
    "odoo_confirm_quotation",
    orderUrl(confirmationInputs[0]!.orderId),
    confirmationDemonstrations,
    { effect: "write", confirmation: "Confirm one synthetic quotation in the loopback-only Odoo fixture" },
  );
  const confirmationCompileMs = performance.now() - compileStartedAt;
  if (confirmationPlan.effect.commitActionIndex !== 0 || confirmationDemonstrationOracles.some((oracle) => !oracle.exact)) {
    throw new Error("The Odoo confirmation demonstrations or effect boundary were not exact.");
  }

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await navigateForCompiledDomWorkflow(page, orderUrl(fixture.orders[2]!.id));
  const writeAuthSurvivedBrowserRestart = await page.locator(".o_web_client").isVisible().catch(() => false) &&
    !await page.locator("input[name=password]").isVisible().catch(() => false);

  const quantityInput: QuantityInput = { orderId: fixture.orders[2]!.id, quantity: 7 };
  const beforeQuantity = orderSnapshot().find((order) => order.id === quantityInput.orderId)!;
  const quantityReceipt = await prepareDomWorkflowWrite(page, journal, quantityPlan, quantityInput);
  const afterQuantityPrepare = orderSnapshot().find((order) => order.id === quantityInput.orderId)!;
  const quantityCommit = await commitPreparedDomWorkflowWrite(
    page, journal, quantityReceipt.id, quantityPlan, quantityInput,
  );
  const afterQuantityCommit = orderSnapshot().find((order) => order.id === quantityInput.orderId)!;
  const quantityRepeatRejected = await commitPreparedDomWorkflowWrite(
    page, journal, quantityReceipt.id, quantityPlan, quantityInput,
  ).then(() => false, () => true);
  const afterQuantityRepeat = orderSnapshot().find((order) => order.id === quantityInput.orderId)!;
  const quantityExact = beforeQuantity.quantity === fixture.orders[2]!.quantity &&
    JSON.stringify(afterQuantityPrepare) === JSON.stringify(beforeQuantity) &&
    afterQuantityCommit.quantity === quantityInput.quantity &&
    quantityCommit.receipt.status === "committed" && quantityCommit.result.modelCalls === 0 &&
    quantityRepeatRejected && JSON.stringify(afterQuantityRepeat) === JSON.stringify(afterQuantityCommit);

  const confirmInput: ConfirmInput = { orderId: fixture.orders[2]!.id };
  const beforeConfirm = orderSnapshot().find((order) => order.id === confirmInput.orderId)!;
  const confirmReceipt = await prepareDomWorkflowWrite(page, journal, confirmationPlan, confirmInput);
  const afterConfirmPrepare = orderSnapshot().find((order) => order.id === confirmInput.orderId)!;
  const confirmCommit = await commitPreparedDomWorkflowWrite(
    page, journal, confirmReceipt.id, confirmationPlan, confirmInput,
  );
  const afterConfirmCommit = orderSnapshot().find((order) => order.id === confirmInput.orderId)!;
  const confirmRepeatRejected = await commitPreparedDomWorkflowWrite(
    page, journal, confirmReceipt.id, confirmationPlan, confirmInput,
  ).then(() => false, () => true);
  const afterConfirmRepeat = orderSnapshot().find((order) => order.id === confirmInput.orderId)!;
  const confirmationExact = beforeConfirm.state === "draft" &&
    JSON.stringify(afterConfirmPrepare) === JSON.stringify(beforeConfirm) &&
    afterConfirmCommit.state === "sale" && confirmCommit.receipt.status === "committed" &&
    confirmCommit.result.modelCalls === 0 && confirmRepeatRejected &&
    JSON.stringify(afterConfirmRepeat) === JSON.stringify(afterConfirmCommit);

  const cleanup = cleanupFixture(fixture);
  cleanupVerified = cleanup.orders === 0 && cleanup.partners === 0 && cleanup.products === 0 && cleanup.passwordRestored;
  const rows = [
    {
      id: "search-synthetic-quotation-by-customer",
      effect: "read",
      engine: searchPlan.engine,
      exactResult: searchExact,
      modelCalls: searchReplay.modelCalls,
      compiledDurationMs: Number(searchReplay.durationMs.toFixed(2)),
      oracle: {
        searchInputValue,
        visibleResultCount: visibleResultRows.length,
        expectedCustomerFound: visibleResultRows.some((row) => row.includes(unseenInput.query)),
        seededDecoysExcluded: visibleResultRows.every((row) =>
          seededDecoyCustomers.every((customer) => !row.includes(customer))),
        applicationStateUnchanged: JSON.stringify(afterSearch) === JSON.stringify(before),
      },
    },
    {
      id: "update-synthetic-quotation-line-quantity",
      effect: "write",
      engine: quantityPlan.engine,
      exactResult: quantityExact,
      preparedWithoutEffect: JSON.stringify(afterQuantityPrepare) === JSON.stringify(beforeQuantity),
      repeatedCommitRejected: quantityRepeatRejected,
      modelCalls: quantityCommit.result.modelCalls,
      compiledDurationMs: Number(quantityCommit.result.durationMs.toFixed(2)),
      oracle: {
        before: beforeQuantity.quantity,
        afterCommit: afterQuantityCommit.quantity,
        afterRejectedRepeatUnchanged: JSON.stringify(afterQuantityRepeat) === JSON.stringify(afterQuantityCommit),
      },
    },
    {
      id: "confirm-synthetic-quotation-once",
      effect: "commit",
      engine: confirmationPlan.engine,
      exactResult: confirmationExact,
      preparedWithoutEffect: JSON.stringify(afterConfirmPrepare) === JSON.stringify(beforeConfirm),
      repeatedCommitRejected: confirmRepeatRejected,
      modelCalls: confirmCommit.result.modelCalls,
      compiledDurationMs: Number(confirmCommit.result.durationMs.toFixed(2)),
      oracle: {
        before: beforeConfirm.state,
        afterCommit: afterConfirmCommit.state,
        afterRejectedRepeatUnchanged: JSON.stringify(afterConfirmRepeat) === JSON.stringify(afterConfirmCommit),
      },
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Odoo Community 19.0",
    origin: ORIGIN,
    containerImages: {
      application: { image: ODOO_IMAGE, digest: ODOO_IMAGE_DIGEST },
      database: { image: POSTGRES_IMAGE, digest: POSTGRES_IMAGE_DIGEST },
    },
    intervention: "guided demonstrations",
    policyBasis: "Loopback-only official containers with synthetic partners, service products, and quotations",
    credentialHandling: "Generated a synthetic administrator password in process memory and restored the exact prior hash; persisted no credential or session value",
    claimScope: "Three post-v2 capability regressions; not untouched holdouts or latency distributions",
    runtimeCorrections: [
      "Controlled text-entry widgets receive a bounded client-state settle window before a dependent action.",
      "A changed final output must remain stable before replay can report success, preventing transient loading views from satisfying input evidence.",
    ],
    authSurvivedBrowserRestart: authSurvivedBrowserRestart && writeAuthSurvivedBrowserRestart,
    compileMs: {
      search: Number(searchCompileMs.toFixed(2)),
      quantity: Number(quantityCompileMs.toFixed(2)),
      confirmation: Number(confirmationCompileMs.toFixed(2)),
    },
    effectBoundaryActionIndexes: {
      quantity: quantityPlan.effect.commitActionIndex,
      confirmation: confirmationPlan.effect.commitActionIndex,
    },
    demonstrationOracles: { quantity: quantityDemonstrationOracles, confirmation: confirmationDemonstrationOracles },
    searchReplayTraffic: { requests: replayRequests, navigations: searchReplay.navigations },
    rows,
    cleanupVerified,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.modelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: quantityRepeatRejected && confirmRepeatRejected ? 0 : 1,
    },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "odoo-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.authSurvivedBrowserRestart || report.summary.passed !== report.summary.total ||
    report.summary.falseSuccesses !== 0 || report.summary.duplicateCommits !== 0 || !cleanupVerified) {
    throw new Error(`Odoo local capability failed: ${JSON.stringify({
      summary: report.summary,
      authSurvivedBrowserRestart: report.authSurvivedBrowserRestart,
      cleanupVerified,
    })}`);
  }
  console.log(JSON.stringify({
    reportPath,
    summary: report.summary,
    authSurvivedBrowserRestart: report.authSurvivedBrowserRestart,
    cleanupVerified,
    compileMs: report.compileMs,
  }, null, 2));
  fixture = null;
} finally {
  await browser?.close().catch(() => {});
  if (fixture) {
    try {
      const cleanup = cleanupFixture(fixture);
      cleanupVerified = cleanup.orders === 0 && cleanup.partners === 0 && cleanup.products === 0 && cleanup.passwordRestored;
    } catch {
      cleanupVerified = false;
    }
  }
  await rm(directory, { recursive: true, force: true });
}
