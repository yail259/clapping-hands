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

const ORIGIN = process.env.CLAPPING_HANDS_PRESTASHOP_ORIGIN ?? "http://127.0.0.1:18103";
const APP_CONTAINER = process.env.CLAPPING_HANDS_PRESTASHOP_CONTAINER ?? "clapping-hands-prestashop";
const DATABASE_CONTAINER = process.env.CLAPPING_HANDS_PRESTASHOP_DATABASE_CONTAINER ??
  "clapping-hands-prestashop-db";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ADMIN_EMAIL = "benchmark-admin@example.invalid";
const APP_IMAGE = "prestashop/prestashop:9";
const APP_IMAGE_DIGEST = "sha256:c8cb26ace9dbf8100b9307b815ed9c61dd06c732a31c93e1583954e5a28aac76";
const DATABASE_IMAGE = "mariadb:11.4";
const DATABASE_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const STOCK_OUTPUT_SELECTOR = "#stock-app";
const ORDER_OUTPUT_SELECTOR = "#order-view-page";
const FIXTURE_STATUS_NAME = "CH Benchmark Reviewed";

if (!process.argv.includes("--local")) {
  throw new Error("PrestaShop local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The PrestaShop benchmark only permits a loopback origin.");
}
for (const identifier of [APP_CONTAINER, DATABASE_CONTAINER]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(identifier)) {
    throw new Error("A PrestaShop fixture identifier is invalid.");
  }
}

type SearchInput = DomInput & { query: string };
type StockInput = DomInput & { query: string; adjustment: number };
type OrderInput = DomInput & { orderId: number };
type StockSnapshot = {
  productId: number;
  stockId: number;
  name: string;
  quantity: number;
  physical: number;
  reserved: number;
};
type OrderSnapshot = {
  orderId: number;
  stateId: number;
  historyCount: number;
};
type Fixture = {
  priorPasswordHash: string;
  statusId: number;
  priorMovementId: number;
  priorHistoryId: number;
  products: StockSnapshot[];
  orders: OrderSnapshot[];
};

function database(sql: string): string {
  try {
    return execFileSync("docker", [
      "exec", DATABASE_CONTAINER, "mariadb", "-uroot", "prestashop", "-N", "-e", sql,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 5 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error("The local PrestaShop database command failed; arguments were suppressed.");
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sanitizedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "PrestaShop benchmark failed.";
  return message.replace(/([?&]_token=)[^\s"'<>]+/g, "$1[redacted]");
}

function passwordHash(password: string): string {
  try {
    return execFileSync("docker", [
      "exec", "-i", APP_CONTAINER, "php", "-r",
      "$p=stream_get_contents(STDIN);echo password_hash($p,PASSWORD_BCRYPT);",
    ], {
      input: password,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("The local PrestaShop password rotation failed; secret-bearing stdin was suppressed.");
  }
}

function adminDirectory(): string {
  let output: string;
  try {
    output = execFileSync("docker", [
      "exec", APP_CONTAINER, "find", "/var/www/html", "-maxdepth", "1", "-mindepth", "1",
      "-type", "d", "-name", "admin*", "-print",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("The local PrestaShop back-office discovery command failed.");
  }
  const candidate = output.trim().split(/\r?\n/).find((path) =>
    path !== "/var/www/html/admin-api" && /^\/var\/www\/html\/admin[A-Za-z0-9_-]+$/.test(path));
  if (!candidate) throw new Error("The local PrestaShop back-office directory was not found.");
  return candidate.split("/").at(-1)!;
}

function rows(output: string): string[][] {
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => line.split("\t"));
}

function setupFixture(password: string): Fixture {
  const priorPasswordHash = database(
    `SELECT passwd FROM ps_employee WHERE email=${sqlString(ADMIN_EMAIL)} AND active=1 LIMIT 1;`,
  );
  if (!/^\$2[aby]\$/.test(priorPasswordHash)) {
    throw new Error("The synthetic PrestaShop employee hash had an unexpected format.");
  }
  const products = rows(database(`
    SELECT p.id_product,sa.id_stock_available,pl.name,sa.quantity,sa.physical_quantity,sa.reserved_quantity
    FROM ps_product p
    JOIN ps_product_lang pl ON pl.id_product=p.id_product AND pl.id_lang=1 AND pl.id_shop=1
    JOIN ps_stock_available sa ON sa.id_product=p.id_product AND sa.id_product_attribute=0 AND sa.id_shop=1
    WHERE p.id_product IN (6,7,19)
    ORDER BY p.id_product;
  `)).map(([productId, stockId, name, quantity, physical, reserved]) => ({
    productId: Number(productId),
    stockId: Number(stockId),
    name: String(name),
    quantity: Number(quantity),
    physical: Number(physical),
    reserved: Number(reserved),
  }));
  if (products.length !== 3 || products.some((product) =>
    !Number.isSafeInteger(product.productId) || !Number.isSafeInteger(product.stockId) || !product.name ||
    !Number.isSafeInteger(product.quantity) || !Number.isSafeInteger(product.physical) ||
    !Number.isSafeInteger(product.reserved))) {
    throw new Error("The PrestaShop stock fixture had an unexpected shape.");
  }
  const orders = rows(database(`
    SELECT o.id_order,o.current_state,COUNT(oh.id_order_history)
    FROM ps_orders o
    LEFT JOIN ps_order_history oh ON oh.id_order=o.id_order
    WHERE o.id_order IN (2,4,5)
    GROUP BY o.id_order,o.current_state
    ORDER BY o.id_order;
  `)).map(([orderId, stateId, historyCount]) => ({
    orderId: Number(orderId),
    stateId: Number(stateId),
    historyCount: Number(historyCount),
  }));
  if (orders.length !== 3 || orders.some((order) =>
    !Number.isSafeInteger(order.orderId) || !Number.isSafeInteger(order.stateId) ||
    !Number.isSafeInteger(order.historyCount))) {
    throw new Error("The PrestaShop order fixture had an unexpected shape.");
  }
  const priorMovementId = Number(database("SELECT COALESCE(MAX(id_stock_mvt),0) FROM ps_stock_mvt;"));
  const priorHistoryId = Number(database("SELECT COALESCE(MAX(id_order_history),0) FROM ps_order_history;"));
  database(`
    DELETE osl FROM ps_order_state_lang osl
    JOIN ps_order_state os ON os.id_order_state=osl.id_order_state
    WHERE osl.name=${sqlString(FIXTURE_STATUS_NAME)};
    DELETE os FROM ps_order_state os
    LEFT JOIN ps_order_state_lang osl ON osl.id_order_state=os.id_order_state
    WHERE os.module_name='clappinghands' AND osl.id_order_state IS NULL;
    INSERT INTO ps_order_state
      (invoice,send_email,module_name,color,unremovable,hidden,logable,delivery,shipped,paid,pdf_invoice,pdf_delivery,deleted)
    VALUES (0,0,'clappinghands','#6C868E',0,0,0,0,0,0,0,0,0);
    SET @ch_status_id=LAST_INSERT_ID();
    INSERT INTO ps_order_state_lang (id_order_state,id_lang,name,template)
      SELECT @ch_status_id,id_lang,${sqlString(FIXTURE_STATUS_NAME)},'' FROM ps_lang;
  `);
  const statusId = Number(database(`
    SELECT os.id_order_state
    FROM ps_order_state os
    JOIN ps_order_state_lang osl ON osl.id_order_state=os.id_order_state
    WHERE os.module_name='clappinghands' AND osl.name=${sqlString(FIXTURE_STATUS_NAME)}
    ORDER BY os.id_order_state DESC LIMIT 1;
  `));
  if (!Number.isSafeInteger(statusId) || statusId < 1) {
    throw new Error("The inert PrestaShop benchmark order status was not created.");
  }
  database(`UPDATE ps_employee SET passwd=${sqlString(passwordHash(password))} WHERE email=${sqlString(ADMIN_EMAIL)} AND active=1;`);
  return { priorPasswordHash, statusId, priorMovementId, priorHistoryId, products, orders };
}

function stockSnapshot(productIds: number[]): StockSnapshot[] {
  const ids = productIds.map((id) => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("A PrestaShop product ID was invalid.");
    return String(id);
  }).join(",");
  return rows(database(`
    SELECT p.id_product,sa.id_stock_available,pl.name,sa.quantity,sa.physical_quantity,sa.reserved_quantity
    FROM ps_product p
    JOIN ps_product_lang pl ON pl.id_product=p.id_product AND pl.id_lang=1 AND pl.id_shop=1
    JOIN ps_stock_available sa ON sa.id_product=p.id_product AND sa.id_product_attribute=0 AND sa.id_shop=1
    WHERE p.id_product IN (${ids}) ORDER BY p.id_product;
  `)).map(([productId, stockId, name, quantity, physical, reserved]) => ({
    productId: Number(productId),
    stockId: Number(stockId),
    name: String(name),
    quantity: Number(quantity),
    physical: Number(physical),
    reserved: Number(reserved),
  }));
}

function orderSnapshot(orderIds: number[]): OrderSnapshot[] {
  const ids = orderIds.map((id) => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("A PrestaShop order ID was invalid.");
    return String(id);
  }).join(",");
  return rows(database(`
    SELECT o.id_order,o.current_state,COUNT(oh.id_order_history)
    FROM ps_orders o
    LEFT JOIN ps_order_history oh ON oh.id_order=o.id_order
    WHERE o.id_order IN (${ids})
    GROUP BY o.id_order,o.current_state ORDER BY o.id_order;
  `)).map(([orderId, stateId, historyCount]) => ({
    orderId: Number(orderId),
    stateId: Number(stateId),
    historyCount: Number(historyCount),
  }));
}

function cleanupFixture(fixture: Fixture): boolean {
  for (const product of fixture.products) {
    database(`
      UPDATE ps_stock_available
      SET quantity=${product.quantity},physical_quantity=${product.physical},reserved_quantity=${product.reserved}
      WHERE id_stock_available=${product.stockId};
    `);
  }
  for (const order of fixture.orders) {
    database(`UPDATE ps_orders SET current_state=${order.stateId} WHERE id_order=${order.orderId};`);
  }
  database(`
    DELETE FROM ps_stock_mvt WHERE id_stock_mvt>${fixture.priorMovementId};
    DELETE FROM ps_order_history
      WHERE id_order_history>${fixture.priorHistoryId} AND id_order_state=${fixture.statusId}
        AND id_order IN (${fixture.orders.map((order) => order.orderId).join(",")});
    DELETE FROM ps_order_state_lang WHERE id_order_state=${fixture.statusId};
    DELETE FROM ps_order_state WHERE id_order_state=${fixture.statusId};
    UPDATE ps_employee SET passwd=${sqlString(fixture.priorPasswordHash)}
      WHERE email=${sqlString(ADMIN_EMAIL)} AND active=1;
  `);
  const stockRestored = JSON.stringify(stockSnapshot(fixture.products.map((product) => product.productId))) ===
    JSON.stringify(fixture.products);
  const ordersRestored = JSON.stringify(orderSnapshot(fixture.orders.map((order) => order.orderId))) ===
    JSON.stringify(fixture.orders);
  const statusRemoved = Number(database(`SELECT COUNT(*) FROM ps_order_state WHERE id_order_state=${fixture.statusId};`)) === 0;
  const passwordRestored = database(
    `SELECT passwd FROM ps_employee WHERE email=${sqlString(ADMIN_EMAIL)} AND active=1 LIMIT 1;`,
  ) === fixture.priorPasswordHash;
  return stockRestored && ordersRestored && statusRemoved && passwordRestored;
}

async function waitForOrigin(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(3_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Keep the bounded readiness probe quiet until the deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("The loopback PrestaShop fixture did not become ready.");
}

function dashboardUrl(): string {
  return `${ORIGIN}/${adminDirectory()}/`;
}

async function authenticate(page: Page, password: string, dashboard: string): Promise<void> {
  await navigateForCompiledDomWorkflow(page, dashboard);
  if (await page.locator('input[name="email"]').isVisible().catch(() => false)) {
    await page.locator('input[name="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[name="passwd"]').fill(password);
    await page.locator("#submit_login").click();
  }
  await page.locator("#subtab-AdminCatalog").waitFor({ state: "visible", timeout: 30_000 });
}

function guidedAction(action: { selector: string; description: string; method: string; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local PrestaShop action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function openCatalog(page: Page): Promise<ReturnType<typeof guidedAction>> {
  const selector = "#subtab-AdminCatalog > a";
  await page.locator(selector).click();
  await page.waitForFunction(() => document.body?.innerText.includes("Products"), undefined, { timeout: 30_000 });
  return guidedAction({ selector, description: "Open the catalog page", method: "click" });
}

async function revealStock(page: Page): Promise<ReturnType<typeof guidedAction>> {
  const selector = "#subtab-AdminCatalog";
  await page.locator(selector).hover();
  await page.locator("#subtab-AdminStockManagement > a").waitFor({ state: "visible", timeout: 10_000 });
  return guidedAction({ selector, description: "Reveal the catalog navigation", method: "hover" });
}

async function demonstrateStockSearch(page: Page, dashboard: string, input: SearchInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) return openCatalog(page);
      if (step === 2) {
        return revealStock(page);
      }
      if (step === 3) {
        const selector = "#subtab-AdminStockManagement > a";
        await page.locator(selector).click();
        await page.locator(STOCK_OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
        return guidedAction({ selector, description: "Open the stock page", method: "click" });
      }
      if (step === 4) {
        const selector = 'input.form-control.input[placeholder=""]';
        await page.locator(selector).fill(input.query);
        await page.waitForTimeout(300);
        return guidedAction({
          selector,
          description: `Enter stock search ${input.query}`,
          method: "fill",
          arguments: [input.query],
        });
      }
      const selector = "button.search-button";
      await page.locator(selector).click();
      await page.waitForFunction((query) => {
        const rows = Array.from(document.querySelectorAll('td[data-role="product-id"]'))
          .map((cell) => cell.closest("tr"));
        return rows.length === 1 && rows[0]?.textContent?.includes(String(query));
      }, input.query, { timeout: 15_000 });
      return guidedAction({ selector, description: "Run the stock search", method: "click" });
    },
  }, page, dashboard, input, [
    "Open the catalog page",
    "Reveal the catalog navigation",
    "Open the stock page",
    `Enter stock search ${input.query}`,
    "Run the stock search",
  ], STOCK_OUTPUT_SELECTOR);
}

async function waitForStock(productId: number, quantity: number): Promise<StockSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = stockSnapshot([productId])[0];
    if (current?.quantity === quantity && current.physical === quantity) return current;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("The PrestaShop database did not reach the expected stock state.");
}

async function demonstrateStockWrite(
  page: Page,
  dashboard: string,
  input: StockInput,
  product: StockSnapshot,
): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) return openCatalog(page);
      if (step === 2) {
        return revealStock(page);
      }
      if (step === 3) {
        const selector = "#subtab-AdminStockManagement > a";
        await page.locator(selector).click();
        await page.locator(STOCK_OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
        return guidedAction({ selector, description: "Open the stock page", method: "click" });
      }
      if (step === 4) {
        const selector = 'input.form-control.input[placeholder=""]';
        await page.locator(selector).fill(input.query);
        await page.waitForTimeout(300);
        return guidedAction({
          selector,
          description: `Enter stock search ${input.query}`,
          method: "fill",
          arguments: [input.query],
        });
      }
      if (step === 5) {
        const selector = "button.search-button";
        await page.locator(selector).click();
        await page.waitForFunction((query) => {
          const rows = Array.from(document.querySelectorAll('td[data-role="product-id"]'))
            .map((cell) => cell.closest("tr"));
          return rows.length === 1 && rows[0]?.textContent?.includes(String(query));
        }, input.query, { timeout: 15_000 });
        return guidedAction({ selector, description: "Run the stock search", method: "click" });
      }
      const selector = 'td[data-role="update-quantity"] input[type="number"]';
      if (step === 6) {
        await page.locator(selector).fill(String(input.adjustment));
        return guidedAction({
          selector,
          description: `Enter stock adjustment ${input.adjustment}`,
          method: "fill",
          arguments: [String(input.adjustment)],
        });
      }
      await page.locator(selector).press("Enter");
      await waitForStock(product.productId, product.quantity + input.adjustment);
      return guidedAction({
        selector,
        description: "Apply the stock adjustment",
        method: "press",
        arguments: ["Enter"],
      });
    },
  }, page, dashboard, input, [
    "Open the catalog page",
    "Reveal the catalog navigation",
    "Open the stock page",
    `Enter stock search ${input.query}`,
    "Run the stock search",
    `Enter stock adjustment ${input.adjustment}`,
    "Apply the stock adjustment",
  ], STOCK_OUTPUT_SELECTOR);
}

async function waitForOrder(orderId: number, stateId: number): Promise<OrderSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = orderSnapshot([orderId])[0];
    if (current?.stateId === stateId) return current;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("The PrestaShop database did not reach the expected order state.");
}

async function demonstrateOrderStatus(
  page: Page,
  dashboard: string,
  input: OrderInput,
  statusId: number,
): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = "#subtab-AdminParentOrders > a";
        await page.locator(selector).click();
        return guidedAction({ selector, description: "Open the orders navigation", method: "click" });
      }
      if (step === 2) {
        const selector = "#subtab-AdminOrders > a";
        await page.locator(selector).waitFor({ state: "visible", timeout: 10_000 });
        await page.locator(selector).click();
        const orderLink = page.locator(`a.grid-view-row-link[href*="/sell/orders/${input.orderId}/view"]`);
        try {
          await orderLink.waitFor({ state: "visible", timeout: 30_000 });
        } catch {
          const orderViewPaths = await page.locator("a[href]").evaluateAll((elements) => elements
            .map((element) => new URL((element as HTMLAnchorElement).href).pathname)
            .filter((path) => /\/sell\/orders\/\d+\/view$/.test(path)));
          throw new Error(`The expected synthetic order row did not hydrate: ${JSON.stringify({
            currentPath: new URL(page.url()).pathname,
            orderViewPaths,
          })}`);
        }
        return guidedAction({ selector, description: "Open the orders page", method: "click" });
      }
      if (step === 3) {
        const selector = `a.grid-view-row-link[href*="/sell/orders/${input.orderId}/view"]`;
        await page.locator(selector).click();
        await page.locator("#update_order_status_action_input").waitFor({ state: "visible", timeout: 30_000 });
        return guidedAction({ selector, description: `Open synthetic order ${input.orderId}`, method: "click" });
      }
      if (step === 4) {
        const selector = "#update_order_status_action_input";
        await page.locator(selector).selectOption(String(statusId));
        return guidedAction({
          selector,
          description: "Choose the inert benchmark order status",
          method: "selectOption",
          arguments: [String(statusId)],
        });
      }
      const selector = "#update_order_status_action_btn";
      await page.locator(selector).click();
      await waitForOrder(input.orderId, statusId);
      return guidedAction({ selector, description: "Update the synthetic order status", method: "click" });
    },
  }, page, dashboard, input, [
    "Open the orders navigation",
    "Open the orders page",
    `Open synthetic order ${input.orderId}`,
    "Choose the inert benchmark order status",
    "Update the synthetic order status",
  ], ORDER_OUTPUT_SELECTOR);
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-prestashop-"));
const password = randomBytes(24).toString("base64url");
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let fixture: Fixture | null = null;
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;

try {
  await waitForOrigin();
  fixture = setupFixture(password);
  const dashboard = dashboardUrl();
  const productIds = fixture.products.map((product) => product.productId);
  const orderIds = fixture.orders.map((order) => order.orderId);
  const initialStocks = stockSnapshot(productIds);
  const initialOrders = orderSnapshot(orderIds);
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page, password, dashboard);

  const searchDemonstrations = [
    await demonstrateStockSearch(page, dashboard, { query: fixture.products[0]!.name }),
    await demonstrateStockSearch(page, dashboard, { query: fixture.products[1]!.name }),
  ];
  let compileStartedAt = performance.now();
  const searchPlan = compileDomWorkflow("prestashop_search_stock", dashboard, searchDemonstrations);
  const searchCompileMs = performance.now() - compileStartedAt;

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await navigateForCompiledDomWorkflow(page, dashboard);
  const authSurvivedFirstRestart = await page.locator("#subtab-AdminCatalog").isVisible().catch(() => false) &&
    !await page.locator('input[name="passwd"]').isVisible().catch(() => false);
  const unseenSearch: SearchInput = { query: fixture.products[2]!.name };
  const searchReplay = await replayDomWorkflow(page, searchPlan, unseenSearch);
  const searchRows = (await page.locator('td[data-role="product-id"]').locator("xpath=ancestor::tr").allTextContents())
    .map((text) => text.replace(/\s+/g, " ").trim());
  const afterSearch = stockSnapshot(productIds);
  const searchExact = searchReplay.modelCalls === 0 && searchRows.length === 1 &&
    searchRows[0]!.includes(unseenSearch.query) &&
    fixture.products.slice(0, 2).every((product) => !searchRows[0]!.includes(product.name)) &&
    JSON.stringify(afterSearch) === JSON.stringify(initialStocks);

  const stockDemonstrations: DomWorkflowDemonstration[] = [];
  const stockDemonstrationOracles: Array<{ productId: number; expected: number; observed: number; exact: boolean }> = [];
  const stockInputs: StockInput[] = [
    { query: fixture.products[0]!.name, adjustment: 2 },
    { query: fixture.products[1]!.name, adjustment: 3 },
  ];
  for (const [index, input] of stockInputs.entries()) {
    const product = fixture.products[index]!;
    stockDemonstrations.push(await demonstrateStockWrite(page, dashboard, input, product));
    const observed = stockSnapshot([product.productId])[0]?.quantity ?? Number.NaN;
    stockDemonstrationOracles.push({
      productId: product.productId,
      expected: product.quantity + input.adjustment,
      observed,
      exact: observed === product.quantity + input.adjustment,
    });
  }
  compileStartedAt = performance.now();
  const stockPlan = compileDomWorkflow(
    "prestashop_adjust_stock",
    dashboard,
    stockDemonstrations,
    { effect: "write", confirmation: "Adjust one synthetic product stock level in the loopback-only PrestaShop fixture" },
  );
  const stockCompileMs = performance.now() - compileStartedAt;
  if (stockPlan.effect.commitActionIndex !== 3 || stockDemonstrationOracles.some((oracle) => !oracle.exact)) {
    throw new Error("The PrestaShop stock demonstrations or effect boundary were not exact.");
  }

  const orderDemonstrations: DomWorkflowDemonstration[] = [];
  const orderDemonstrationOracles: Array<{ orderId: number; expected: number; observed: number; exact: boolean }> = [];
  for (const order of fixture.orders.slice(0, 2)) {
    const input: OrderInput = { orderId: order.orderId };
    orderDemonstrations.push(await demonstrateOrderStatus(page, dashboard, input, fixture.statusId));
    const observed = orderSnapshot([order.orderId])[0]?.stateId ?? Number.NaN;
    orderDemonstrationOracles.push({
      orderId: order.orderId,
      expected: fixture.statusId,
      observed,
      exact: observed === fixture.statusId,
    });
  }
  compileStartedAt = performance.now();
  const orderPlan = compileDomWorkflow(
    "prestashop_advance_order_to_reviewed",
    dashboard,
    orderDemonstrations,
    { effect: "write", confirmation: "Move one synthetic order to the inert benchmark status in the loopback-only PrestaShop fixture" },
  );
  const orderCompileMs = performance.now() - compileStartedAt;
  if (orderPlan.effect.commitActionIndex !== 3 || orderDemonstrationOracles.some((oracle) => !oracle.exact)) {
    throw new Error("The PrestaShop order demonstrations or effect boundary were not exact.");
  }

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await navigateForCompiledDomWorkflow(page, dashboard);
  const authSurvivedSecondRestart = await page.locator("#subtab-AdminCatalog").isVisible().catch(() => false) &&
    !await page.locator('input[name="passwd"]').isVisible().catch(() => false);

  const unseenProduct = fixture.products[2]!;
  const stockInput: StockInput = { query: unseenProduct.name, adjustment: 5 };
  const beforeStock = stockSnapshot([unseenProduct.productId])[0]!;
  const stockReceipt = await prepareDomWorkflowWrite(page, journal, stockPlan, stockInput);
  const afterStockPrepare = stockSnapshot([unseenProduct.productId])[0]!;
  const stockCommit = await commitPreparedDomWorkflowWrite(
    page, journal, stockReceipt.id, stockPlan, stockInput,
  );
  const afterStockCommit = stockSnapshot([unseenProduct.productId])[0]!;
  const stockRepeatRejected = await commitPreparedDomWorkflowWrite(
    page, journal, stockReceipt.id, stockPlan, stockInput,
  ).then(() => false, () => true);
  const afterStockRepeat = stockSnapshot([unseenProduct.productId])[0]!;
  const stockExact = JSON.stringify(afterStockPrepare) === JSON.stringify(beforeStock) &&
    afterStockCommit.quantity === beforeStock.quantity + stockInput.adjustment &&
    afterStockCommit.physical === beforeStock.physical + stockInput.adjustment &&
    afterStockCommit.reserved === beforeStock.reserved &&
    stockCommit.receipt.status === "committed" && stockCommit.result.modelCalls === 0 &&
    stockRepeatRejected && JSON.stringify(afterStockRepeat) === JSON.stringify(afterStockCommit);

  const unseenOrder = fixture.orders[2]!;
  const orderInput: OrderInput = { orderId: unseenOrder.orderId };
  const beforeOrder = orderSnapshot([unseenOrder.orderId])[0]!;
  const orderReceipt = await prepareDomWorkflowWrite(page, journal, orderPlan, orderInput);
  const afterOrderPrepare = orderSnapshot([unseenOrder.orderId])[0]!;
  const orderCommit = await commitPreparedDomWorkflowWrite(
    page, journal, orderReceipt.id, orderPlan, orderInput,
  );
  const afterOrderCommit = orderSnapshot([unseenOrder.orderId])[0]!;
  const orderRepeatRejected = await commitPreparedDomWorkflowWrite(
    page, journal, orderReceipt.id, orderPlan, orderInput,
  ).then(() => false, () => true);
  const afterOrderRepeat = orderSnapshot([unseenOrder.orderId])[0]!;
  const orderExact = JSON.stringify(afterOrderPrepare) === JSON.stringify(beforeOrder) &&
    afterOrderCommit.stateId === fixture.statusId && afterOrderCommit.historyCount === beforeOrder.historyCount + 1 &&
    orderCommit.receipt.status === "committed" && orderCommit.result.modelCalls === 0 &&
    orderRepeatRejected && JSON.stringify(afterOrderRepeat) === JSON.stringify(afterOrderCommit);

  cleanupVerified = cleanupFixture(fixture);
  const rows = [
    {
      id: "search-stock-for-unseen-product",
      effect: "read",
      engine: searchPlan.engine,
      exactResult: searchExact,
      modelCalls: searchReplay.modelCalls,
      compiledDurationMs: Number(searchReplay.durationMs.toFixed(2)),
      oracle: {
        visibleResultCount: searchRows.length,
        expectedProductFound: searchRows.some((row) => row.includes(unseenSearch.query)),
        seededDecoysExcluded: searchRows.every((row) =>
          fixture!.products.slice(0, 2).every((product) => !row.includes(product.name))),
        applicationStateUnchanged: JSON.stringify(afterSearch) === JSON.stringify(initialStocks),
      },
    },
    {
      id: "adjust-unseen-product-stock",
      effect: "write",
      engine: stockPlan.engine,
      exactResult: stockExact,
      preparedWithoutEffect: JSON.stringify(afterStockPrepare) === JSON.stringify(beforeStock),
      repeatedCommitRejected: stockRepeatRejected,
      modelCalls: stockCommit.result.modelCalls,
      compiledDurationMs: Number(stockCommit.result.durationMs.toFixed(2)),
      oracle: {
        before: beforeStock.quantity,
        afterCommit: afterStockCommit.quantity,
        physicalMovedExactly: afterStockCommit.physical === beforeStock.physical + stockInput.adjustment,
        reservedUnchanged: afterStockCommit.reserved === beforeStock.reserved,
        afterRejectedRepeatUnchanged: JSON.stringify(afterStockRepeat) === JSON.stringify(afterStockCommit),
      },
    },
    {
      id: "advance-unseen-order-once",
      effect: "commit",
      engine: orderPlan.engine,
      exactResult: orderExact,
      preparedWithoutEffect: JSON.stringify(afterOrderPrepare) === JSON.stringify(beforeOrder),
      repeatedCommitRejected: orderRepeatRejected,
      modelCalls: orderCommit.result.modelCalls,
      compiledDurationMs: Number(orderCommit.result.durationMs.toFixed(2)),
      oracle: {
        priorStatePreservedUntilCommit: afterOrderPrepare.stateId === beforeOrder.stateId,
        targetStateReached: afterOrderCommit.stateId === fixture.statusId,
        exactlyOneHistoryRowAdded: afterOrderCommit.historyCount === beforeOrder.historyCount + 1,
        afterRejectedRepeatUnchanged: JSON.stringify(afterOrderRepeat) === JSON.stringify(afterOrderCommit),
      },
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "PrestaShop 9.1.5",
    origin: ORIGIN,
    containerImages: {
      application: { image: APP_IMAGE, digest: APP_IMAGE_DIGEST },
      database: { image: DATABASE_IMAGE, digest: DATABASE_IMAGE_DIGEST },
    },
    intervention: "guided demonstrations",
    policyBasis: "Loopback-only official containers with bundled sample products and orders, exact restoration, and an inert synthetic order status",
    credentialHandling: "Generated a synthetic administrator password in process memory and restored the exact prior hash; persisted no credential, session value, or tokenized back-office URL",
    claimScope: "Three post-v2 capability regressions; not untouched holdouts or latency distributions",
    distinctMechanisms: [
      "Vue stock management with asynchronous menu hydration and inline quantity adjustment",
      "server-rendered tokenized back-office navigation replayed through live DOM links without persisting route tokens",
      "prepare/commit receipt enforcement with independent inventory and order-history oracles",
    ],
    authSurvivedBrowserRestart: authSurvivedFirstRestart && authSurvivedSecondRestart,
    compileMs: {
      search: Number(searchCompileMs.toFixed(2)),
      stock: Number(stockCompileMs.toFixed(2)),
      order: Number(orderCompileMs.toFixed(2)),
    },
    effectBoundaryActionIndexes: {
      stock: stockPlan.effect.commitActionIndex,
      order: orderPlan.effect.commitActionIndex,
    },
    demonstrationOracles: { stock: stockDemonstrationOracles, order: orderDemonstrationOracles },
    apiRoutingControl: {
      backOfficeWebserviceEnabled: database("SELECT value FROM ps_configuration WHERE name='PS_WEBSERVICE' LIMIT 1;") === "1",
    },
    rows,
    cleanupVerified,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.modelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: stockRepeatRejected && orderRepeatRejected ? 0 : 1,
    },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "prestashop-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.authSurvivedBrowserRestart || report.summary.passed !== report.summary.total ||
    report.summary.falseSuccesses !== 0 || report.summary.duplicateCommits !== 0 || !cleanupVerified) {
    throw new Error(`PrestaShop local capability failed: ${JSON.stringify({
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
} catch (error) {
  throw new Error(sanitizedErrorMessage(error));
} finally {
  await browser?.close().catch(() => {});
  if (fixture) {
    try {
      cleanupVerified = cleanupFixture(fixture);
    } catch {
      cleanupVerified = false;
    }
  }
  await rm(directory, { recursive: true, force: true });
}
