import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  captureDomOutput,
  compileDomWorkflow,
  replayDomWorkflow,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";

const ORIGIN = "https://www.saucedemo.com";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!process.argv.includes("--live")) {
  throw new Error(
    "Live traffic is disabled. Review docs/BENCHMARK_CORPUS.md, then pass --live for a bounded run on Sauce Labs' public test application.",
  );
}

async function launch(profileDirectory: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDirectory, {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
}

async function loginFromPublishedFixtureText(page: Page): Promise<void> {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const usernames = (await page.locator("#login_credentials").innerText()).split(/\s+/);
  const username = usernames.find((value) => value === "standard_user");
  const passwordLines = (await page.locator(".login_password").innerText()).split(/\s+/).filter(Boolean);
  const password = passwordLines.at(-1);
  if (!username || !password) throw new Error("SauceDemo no longer publishes the expected fixture login on its page.");
  await page.locator("#user-name").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#login-button").click();
  await page.locator(".inventory_list").waitFor({ state: "visible", timeout: 15_000 });
}

function inventoryNames(page: Page): Promise<string[]> {
  return page.locator(".inventory_item_name").allInnerTexts();
}

async function sortDemonstration(page: Page, sort: string): Promise<DomWorkflowDemonstration> {
  await page.goto(`${ORIGIN}/inventory.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("[data-test=product-sort-container]").selectOption(sort);
  return {
    input: { sort },
    actions: [{
      selector: "[data-test=product-sort-container]",
      description: `Sort inventory by ${sort}`,
      method: "selectOptionFromDropdown",
      arguments: [sort],
    }],
    output: await captureDomOutput(page, ".inventory_list"),
    modelCalls: 1,
    instructions: [`Sort inventory by ${sort}`],
  };
}

async function cartDemonstration(page: Page, product: string): Promise<DomWorkflowDemonstration> {
  await page.goto(`${ORIGIN}/inventory.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const selector = `#add-to-cart-${product}`;
  await page.locator(selector).click();
  const demonstration: DomWorkflowDemonstration = {
    input: { product },
    actions: [{ selector, description: `Add ${product} to cart`, method: "click", arguments: [] }],
    output: await captureDomOutput(page, ".shopping_cart_badge"),
    modelCalls: 1,
    instructions: [`Add ${product} to the cart`],
  };
  await page.locator(`#remove-${product}`).click();
  await page.locator(".shopping_cart_badge").waitFor({ state: "detached", timeout: 10_000 });
  return demonstration;
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-saucedemo-"));
const profileDirectory = resolve(directory, "profile");
let context: BrowserContext | null = null;
try {
  context = await launch(profileDirectory);
  let page = context.pages()[0] ?? await context.newPage();
  await loginFromPublishedFixtureText(page);
  await context.close();

  context = await launch(profileDirectory);
  page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${ORIGIN}/inventory.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const authRestartPassed = await page.locator(".inventory_list").isVisible().catch(() => false);
  if (!authRestartPassed) throw new Error("SauceDemo fixture authentication did not survive the profile restart.");

  const sortPlan = compileDomWorkflow("saucedemo_inventory_sort", `${ORIGIN}/inventory.html`, [
    await sortDemonstration(page, "lohi"),
    await sortDemonstration(page, "hilo"),
  ]);
  const sortResult = await replayDomWorkflow(page, sortPlan, { sort: "az" });
  const names = await inventoryNames(page);
  const expectedNames = [...names].sort((left, right) => left.localeCompare(right));
  const sortExact = JSON.stringify(names) === JSON.stringify(expectedNames);

  const cartPlan = compileDomWorkflow("saucedemo_add_cart", `${ORIGIN}/inventory.html`, [
    await cartDemonstration(page, "sauce-labs-backpack"),
    await cartDemonstration(page, "sauce-labs-bike-light"),
  ], { effect: "write", confirmation: "Add this public fixture product to the reversible test cart" });
  const cartInput = { product: "sauce-labs-bolt-t-shirt" };
  const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
  const receipt = await prepareDomWorkflowWrite(page, journal, cartPlan, cartInput);
  const preparedCartEmpty = !await page.locator(".shopping_cart_badge").isVisible().catch(() => false);
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, cartPlan, cartInput);
  const cartExact = preparedCartEmpty && committed.result.text === "1" && committed.receipt.status === "committed";
  await page.locator("#remove-sauce-labs-bolt-t-shirt").click();

  const rows = [
    {
      task: "login-profile-restart",
      effect: "read",
      path: "auth-handoff-fixture",
      exactResult: authRestartPassed,
      compiledModelCalls: 0,
    },
    {
      task: "inventory-sort",
      effect: "read",
      path: "browser-dom",
      exactResult: sortExact,
      compiledModelCalls: sortResult.modelCalls,
      compiledDurationMs: sortResult.durationMs,
    },
    {
      task: "add-cart-item",
      effect: "write",
      path: "prepare-commit",
      exactResult: cartExact,
      compiledModelCalls: committed.result.modelCalls,
      compiledDurationMs: committed.result.durationMs,
      preparedCartEmpty,
      receiptStatus: committed.receipt.status,
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "live-purpose-built-smoke",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "SauceDemo / Swag Labs",
    origin: ORIGIN,
    policyBasis: "Sauce Labs documentation uses Swag Labs as its automated login example",
    credentialHandling: "Read public fixture credentials from the login page; did not persist or report them",
    traffic: { pageJourneys: 9, realOrders: 0, cartItemsLeftBehind: 0 },
    intervention: "guided",
    claimScope: "Capability smoke only; n=1 compiled run per task, not a speed benchmark",
    developmentHistory: [{
      attempt: 1,
      task: "inventory-sort",
      result: "failed-closed",
      reason: "Selecting the already-default A-to-Z state produced no DOM delta for the freshness gate.",
      fix: "Allow freshly navigated select/check controls to prove that the requested state was already satisfied.",
      journeys: 5,
    }],
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
    },
  };
  if (report.summary.passed !== report.summary.total) throw new Error(`SauceDemo smoke failed: ${JSON.stringify(report.summary)}`);
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "saucedemo-live-smoke.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
