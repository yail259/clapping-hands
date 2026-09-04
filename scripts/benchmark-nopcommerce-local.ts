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
import {
  compileFormWorkflow,
  demonstrateFormWorkflow,
  inspectFormCandidates,
  replayFormWorkflow,
  replayFormWorkflowInBrowser,
  type FormWorkflowAnswers,
  type FormWorkflowResult,
} from "../src/form-workflow.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = process.env.CLAPPING_HANDS_NOPCOMMERCE_ORIGIN ?? "http://127.0.0.1:18120";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const password = process.env.CLAPPING_HANDS_NOPCOMMERCE_PASSWORD;
const databaseContainer = process.env.CLAPPING_HANDS_NOPCOMMERCE_DB_CONTAINER ?? "clapping-hands-nop-db";
const APP_IMAGE_DIGEST = "sha256:d5234d39ca3649b41b106729e55122298206cecf88f509553d8a7633447e9591";
const DB_IMAGE_DIGEST = "sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675";
const SAMPLE_SIZE = 20;
const WARMUPS = 3;

if (!process.argv.includes("--local")) {
  throw new Error("nopCommerce local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The nopCommerce local runner only permits a loopback origin.");
}
if (!password) throw new Error("Set the rotated synthetic nopCommerce administrator password.");

type Product = { id: number; slug: string; name: string };
type CartInput = DomInput & { productId: number; productSlug: string };
type CartRow = { productId: number; quantity: number };

const products: Product[] = [
  { id: 18, slug: "htc-smartphone", name: "HTC smartphone" },
  { id: 20, slug: "nokia-lumia-1020", name: "Nokia Lumia 1020" },
  { id: 17, slug: "apple-icam", name: "Apple iCam" },
];
const expectedSearchTitles: Record<string, string> = {
  HTC: "HTC smartphone",
  Apple: "Apple MacBook Pro",
  Nikon: "Nikon D5500 DSLR",
};
const searchQueries = Object.keys(expectedSearchTitles);

function database(sql: string): string {
  return execFileSync("docker", [
    "exec", databaseContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", "nop", "-d", "nop", "-Atc", sql,
  ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }).trim();
}

function fixtureCustomerId(): number {
  const id = Number(database('select "Id" from "Customer" where "Email" = \'benchmark-admin@example.invalid\';'));
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("The synthetic nopCommerce customer was not found.");
  return id;
}

function verifyProductFixture(): void {
  for (const product of products) {
    const observed = database(`select "Name" from "Product" where "Id" = ${product.id};`);
    if (observed !== product.name) throw new Error(`The nopCommerce product fixture drifted at ID ${product.id}.`);
  }
}

function clearCart(customerId: number): void {
  database(`delete from "ShoppingCartItem" where "CustomerId" = ${customerId};`);
}

function cart(customerId: number): CartRow[] {
  const output = database(`select "ProductId", "Quantity" from "ShoppingCartItem" where "CustomerId" = ${customerId} and "ShoppingCartTypeId" = 1 order by "ProductId";`);
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const [productId, quantity] = line.split("|").map(Number);
    if (!Number.isSafeInteger(productId) || !Number.isSafeInteger(quantity)) {
      throw new Error("The nopCommerce cart oracle returned an invalid row.");
    }
    return { productId: productId!, quantity: quantity! };
  });
}

function exactCart(rows: CartRow[], productId: number): boolean {
  return rows.length === 1 && rows[0]!.productId === productId && rows[0]!.quantity === 1;
}

async function apiSurface(): Promise<Array<{ method: string; path: string; status: number }>> {
  const probes = [
    { method: "GET", path: "/api/index.html" },
    { method: "POST", path: "/api-frontend/Authenticate/GetToken" },
  ];
  return Promise.all(probes.map(async ({ method, path }) => ({
    method,
    path,
    status: (await fetch(new URL(path, ORIGIN), {
      method,
      headers: method === "POST" ? { "content-type": "application/json-patch+json" } : undefined,
      body: method === "POST" ? "{}" : undefined,
      redirect: "manual",
    })).status,
  })));
}

async function authenticate(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#Email").isVisible().catch(() => false)) {
    await page.locator("#Email").fill("benchmark-admin@example.invalid");
    await page.locator("#Password").fill(password!);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });
  }
  if (!await page.locator(".ico-logout").isVisible().catch(() => false)) {
    throw new Error("The synthetic nopCommerce administrator session did not authenticate.");
  }
}

function searchAnswers(questionKey: string, query: string): FormWorkflowAnswers {
  return { [questionKey]: { q: query } };
}

function exactSearchResult(query: string, result: FormWorkflowResult): boolean {
  const expected = expectedSearchTitles[query];
  const finalUrl = new URL(result.finalUrl);
  return Boolean(expected) && finalUrl.pathname === "/search" && finalUrl.searchParams.get("q") === query &&
    result.mainText.includes(expected!);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function roundedSamples(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(2)));
}

function guidedClick(selector: string, description: string) {
  return {
    success: true,
    message: "guided local nopCommerce action",
    actions: [{ selector, description, method: "click", arguments: [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateCart(page: Page, product: Product): Promise<DomWorkflowDemonstration> {
  const input: CartInput = { productId: product.id, productSlug: product.slug };
  const selector = `#add-to-cart-button-${product.id}`;
  return demonstrateDomWorkflow({
    act: async () => {
      await page.locator(selector).click();
      await page.locator("#bar-notification").filter({ hasText: "added to your shopping cart" })
        .waitFor({ state: "visible", timeout: 15_000 });
      return guidedClick(selector, `Add product ${product.id} to cart`);
    },
  }, page, `${ORIGIN}/${product.slug}`, input, [`Add product ${product.id} to cart`], "#bar-notification");
}

verifyProductFixture();
const customerId = fixtureCustomerId();
clearCart(customerId);
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-nopcommerce-local-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;
try {
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page);
  const browserVersion = page.context().browser()?.version() ?? "unknown";

  const searchStartUrl = `${ORIGIN}/`;
  await page.goto(searchStartUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const searchCandidate = inspectFormCandidates(await page.content(), page.url()).find((form) =>
    form.method === "GET" && form.actionPath === "/search" &&
    form.controls.some((control) => control.name === "q"));
  if (!searchCandidate) throw new Error("The nopCommerce product-search form was not safely eligible.");
  const compileStartedAt = performance.now();
  const searchDemonstrations = [];
  for (const query of ["HTC", "Apple"]) {
    searchDemonstrations.push(await demonstrateFormWorkflow(
      page,
      searchStartUrl,
      searchAnswers(searchCandidate.questionKey, query),
    ));
  }
  const searchPlan = compileFormWorkflow("nopcommerce_search_products", searchStartUrl, searchDemonstrations);
  const compileMs = performance.now() - compileStartedAt;
  const searchQuestionKey = searchPlan.steps[0]!.questionKey;

  const cartDemonstrations: DomWorkflowDemonstration[] = [];
  const cartDemonstrationOracles: Array<{ productId: number; rows: CartRow[] }> = [];
  for (const product of products.slice(0, 2)) {
    clearCart(customerId);
    cartDemonstrations.push(await demonstrateCart(page, product));
    const rows = cart(customerId);
    cartDemonstrationOracles.push({ productId: product.id, rows });
    if (!exactCart(rows, product.id)) throw new Error("A guided nopCommerce cart demonstration failed its database oracle.");
    clearCart(customerId);
  }
  const cartPlan = compileDomWorkflow(
    "nopcommerce_add_product_to_cart",
    `${ORIGIN}/${products[0]!.slug}`,
    cartDemonstrations,
    { effect: "write", confirmation: "Add one sample product to the synthetic loopback-only shopping cart" },
  );
  if (cartPlan.effect.commitActionIndex !== 0) throw new Error("The add-to-cart action was not fully withheld until commit.");

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredCookies = (await (await browser.context()).cookies([ORIGIN])).length;

  const replayQuery = "Nikon";
  const replayAnswers = searchAnswers(searchQuestionKey, replayQuery);
  const searchReplay = await replayFormWorkflow(await browser.context(), searchPlan, replayAnswers);
  const searchExact = exactSearchResult(replayQuery, searchReplay);

  for (let index = 0; index < WARMUPS; index += 1) {
    const query = searchQueries[index % searchQueries.length]!;
    const answers = searchAnswers(searchQuestionKey, query);
    const browserResult = await replayFormWorkflowInBrowser(page, searchPlan, answers);
    const compiledResult = await replayFormWorkflow(await browser.context(), searchPlan, answers);
    const browserExact = exactSearchResult(query, browserResult);
    const compiledExact = exactSearchResult(query, compiledResult);
    if (!browserExact || !compiledExact) {
      const titlePresence = (result: FormWorkflowResult) => Object.fromEntries(
        Object.entries(expectedSearchTitles).map(([name, title]) => [name, result.mainText.includes(title)]),
      );
      throw new Error(`nopCommerce warmup returned an inexact result for ${query}: ${JSON.stringify({
        browserExact,
        compiledExact,
        browserTitles: titlePresence(browserResult),
        compiledTitles: titlePresence(compiledResult),
      })}`);
    }
  }

  const browserMs: number[] = [];
  const compiledMs: number[] = [];
  let browserCorrect = 0;
  let compiledCorrect = 0;
  for (let index = 0; index < SAMPLE_SIZE; index += 1) {
    const query = searchQueries[index % searchQueries.length]!;
    const answers = searchAnswers(searchQuestionKey, query);
    const runBrowser = async (): Promise<void> => {
      const result = await replayFormWorkflowInBrowser(page, searchPlan, answers);
      browserMs.push(result.durationMs);
      if (exactSearchResult(query, result)) browserCorrect += 1;
    };
    const runCompiled = async (): Promise<void> => {
      const result = await replayFormWorkflow(await browser!.context(), searchPlan, answers);
      compiledMs.push(result.durationMs);
      if (exactSearchResult(query, result)) compiledCorrect += 1;
    };
    if (index % 2 === 0) {
      await runBrowser();
      await runCompiled();
    } else {
      await runCompiled();
      await runBrowser();
    }
  }
  if (browserCorrect !== SAMPLE_SIZE || compiledCorrect !== SAMPLE_SIZE) {
    throw new Error(`nopCommerce performance correctness failed: browser ${browserCorrect}/${SAMPLE_SIZE}, compiled ${compiledCorrect}/${SAMPLE_SIZE}.`);
  }

  const replayProduct = products[2]!;
  const cartInput: CartInput = { productId: replayProduct.id, productSlug: replayProduct.slug };
  clearCart(customerId);
  const beforeCart = cart(customerId);
  const receipt = await prepareDomWorkflowWrite(page, journal, cartPlan, cartInput);
  const afterPrepare = cart(customerId);
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, cartPlan, cartInput);
  const afterCommit = cart(customerId);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, cartPlan, cartInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = cart(customerId);
  const cartExact = beforeCart.length === 0 && afterPrepare.length === 0 && exactCart(afterCommit, replayProduct.id) &&
    JSON.stringify(afterRejectedRepeat) === JSON.stringify(afterCommit) && repeatedCommitRejected &&
    committed.receipt.status === "committed" && committed.result.modelCalls === 0;

  clearCart(customerId);
  cleanupVerified = cart(customerId).length === 0;
  const browserP50 = percentile(browserMs, 0.5);
  const compiledP50 = percentile(compiledMs, 0.5);
  const rows = [
    {
      task: "search-unseen-product-term",
      effect: "read",
      engine: searchPlan.engine,
      exactResult: searchExact,
      compiledModelCalls: 0,
      compiledDurationMs: searchReplay.durationMs,
    },
    {
      task: "add-unseen-product-to-cart",
      effect: "write",
      engine: cartPlan.engine,
      exactResult: cartExact,
      preparedWithoutEffect: afterPrepare.length === 0,
      repeatedCommitRejected,
      compiledModelCalls: committed.result.modelCalls,
      compiledDurationMs: committed.result.durationMs,
      oracle: { productId: replayProduct.id, afterCommit, afterRejectedRepeat },
    },
  ];
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runClass: "self-hosted-application-capability-and-performance",
    application: "Self-hosted nopCommerce 4.90.6",
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    environment: { browserVersion, platform: process.platform, architecture: process.arch },
    intervention: "guided",
    policyBasis: "Loopback-only official container with the vendor's sample catalogue and one synthetic administrator",
    credentialHandling: "Read a rotated synthetic credential from the process environment; persisted no credential, anti-forgery token, plan, or page body in the report",
    apiDisposition: {
      documentedCoverage: "The vendor's separately licensed Web API frontend documents buying capabilities; prefer it whenever licensed, configured, and task-complete",
      localSurface: await apiSurface(),
      decision: "This fresh installation had no Swagger surface or configured token issuer, so the documented separately licensed API was not usable for these tasks",
    },
    setupCorrections: [
      "Use an already allocated default Docker bridge because Docker Desktop had exhausted its predefined subnet pools.",
      "Enable PostgreSQL citext before the application process starts so Npgsql loads the extension type mapping.",
      "Treat the application's intentional post-install process exit as a restart boundary rather than an installation failure.",
      "Scope product-search exactness to the submitted query URL and expected result instead of rejecting personalized recently-viewed product furniture.",
      "Probe the documented token route with POST; a GET 404 alone cannot distinguish an absent route from a method mismatch.",
    ],
    authSurvivedBrowserRestart: restoredCookies > 0,
    fixtureCleanupVerified: cleanupVerified,
    cartDemonstrationOracles,
    rows,
    performance: {
      task: "product-search",
      protocol: {
        warmups: WARMUPS,
        pairedSamples: SAMPLE_SIZE,
        order: "interleaved; browser first on even samples and compiled first on odd samples",
        queryCycle: searchQueries,
      },
      compileMs: Number(compileMs.toFixed(2)),
      browser: {
        p50Ms: browserP50,
        p95Ms: percentile(browserMs, 0.95),
        samplesMs: roundedSamples(browserMs),
        correctness: `${browserCorrect}/${SAMPLE_SIZE}`,
        requestsPerRun: 2,
        navigationsPerRun: 2,
        modelCallsPerRun: 0,
      },
      compiled: {
        p50Ms: compiledP50,
        p95Ms: percentile(compiledMs, 0.95),
        samplesMs: roundedSamples(compiledMs),
        correctness: `${compiledCorrect}/${SAMPLE_SIZE}`,
        requestsPerRun: 2,
        navigationsPerRun: 0,
        modelCallsPerRun: 0,
      },
      medianSpeedup: Number((browserP50 / compiledP50).toFixed(2)),
    },
    claimScope: "Two workflows on one pinned self-hosted application; the speed distribution covers product search only",
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: repeatedCommitRejected ? 0 : 1,
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.duplicateCommits !== 0 ||
    !report.authSurvivedBrowserRestart || !cleanupVerified) {
    throw new Error(`nopCommerce local run failed: ${JSON.stringify(report.summary)}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "nopcommerce-local.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    reportPath,
    ...report.summary,
    browserP50Ms: browserP50,
    compiledP50Ms: compiledP50,
    medianSpeedup: report.performance.medianSpeedup,
    browserCorrect,
    compiledCorrect,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (!cleanupVerified) clearCart(customerId);
  await rm(directory, { recursive: true, force: true });
}
