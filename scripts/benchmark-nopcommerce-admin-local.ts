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
const applicationContainer = process.env.CLAPPING_HANDS_NOPCOMMERCE_APP_CONTAINER ?? "clapping-hands-nop-web";
const ADMIN_EMAIL = "benchmark-admin@example.invalid";
const OUTPUT_SELECTOR = ".content-wrapper";
const APP_IMAGE_DIGEST = "sha256:d5234d39ca3649b41b106729e55122298206cecf88f509553d8a7633447e9591";
const DB_IMAGE_DIGEST = "sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675";
const NOPCOMMERCE_SOURCE_COMMIT = "e3d129ca4395556094fc64073659b9360142ba4f";

if (!process.argv.includes("--local")) {
  throw new Error("nopCommerce admin local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The nopCommerce admin runner only permits a loopback origin.");
}

type Product = {
  id: number;
  slug: string;
  name: string;
};

type ProductState = Product & {
  shortDescription: string;
  updatedOnUtc: string;
};

type PasswordState = {
  id: number;
  password: string;
  passwordSalt: string;
  passwordFormatId: number;
};

type AdminEditInput = DomInput & {
  productId: number;
  shortDescription: string;
};

const products: Product[] = [
  { id: 18, slug: "htc-smartphone", name: "HTC smartphone" },
  { id: 20, slug: "nokia-lumia-1020", name: "Nokia Lumia 1020" },
  { id: 17, slug: "apple-icam", name: "Apple iCam" },
];

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
  if (!Number.isSafeInteger(observed) || observed < 1) {
    throw new Error("The synthetic nopCommerce administrator was not found.");
  }
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
    throw new Error("The synthetic nopCommerce administrator password row had an unexpected shape.");
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
  setPassword({
    id: original.id,
    password: passwordHash,
    passwordSalt,
    passwordFormatId: 1,
  });
  return password;
}

function productState(product: Product): ProductState {
  const raw = database(`
    select json_build_object(
      'id', "Id",
      'slug', ${sqlString(product.slug)},
      'name', "Name",
      'shortDescription', "ShortDescription",
      'updatedOnUtc', "UpdatedOnUtc"
    )
    from "Product"
    where "Id" = ${product.id};
  `);
  const parsed = JSON.parse(raw) as ProductState;
  if (parsed.id !== product.id || parsed.name !== product.name || typeof parsed.shortDescription !== "string" ||
    typeof parsed.updatedOnUtc !== "string") {
    throw new Error(`The nopCommerce product fixture drifted at ID ${product.id}.`);
  }
  return parsed;
}

function restoreProduct(state: ProductState): void {
  database(`
    update "Product"
    set "ShortDescription" = ${sqlString(state.shortDescription)},
        "UpdatedOnUtc" = ${sqlString(state.updatedOnUtc)}
    where "Id" = ${state.id};
  `);
}

function observedDescription(productId: number): string {
  return database(`select "ShortDescription" from "Product" where "Id" = ${productId};`);
}

async function storefrontContains(product: Product, description: string): Promise<boolean> {
  const response = await fetch(new URL(`/${product.slug}?clapping-hands-check=${Date.now()}`, ORIGIN));
  return response.ok && (await response.text()).includes(description);
}

function pluginInventory(): { frontendInstalled: boolean; backendInstalled: boolean } {
  const output = execFileSync("docker", [
    "exec", applicationContainer, "find", "/app/Plugins", "-maxdepth", "3", "-type", "f", "-print",
  ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
  return {
    frontendInstalled: output.includes("Misc.WebApi.Frontend"),
    backendInstalled: output.includes("WebApi.Backend"),
  };
}

async function apiSurface(): Promise<Array<{ method: string; path: string; status: number }>> {
  const probes = [
    { method: "GET", path: "/api/index.html" },
    { method: "POST", path: "/api-frontend/Authenticate/GetToken" },
    { method: "POST", path: "/api-backend/Authenticate/GetToken" },
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
    throw new Error("The synthetic nopCommerce administrator session did not authenticate.");
  }
}

function guidedAction(action: { selector: string; description: string; method: "fill" | "click"; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local nopCommerce admin action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function editStartUrl(input: AdminEditInput): string {
  return `${ORIGIN}/Admin/Product/Edit/${input.productId}`;
}

async function demonstrateAdminEdit(page: Page, input: AdminEditInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = "#ShortDescription";
        await page.locator(selector).fill(input.shortDescription);
        return guidedAction({
          selector,
          description: "Enter the requested synthetic short description",
          method: "fill",
          arguments: [input.shortDescription],
        });
      }
      const selector = '[name="save"]';
      await page.locator(selector).click();
      await page.waitForURL((url) => url.pathname === "/Admin/Product/List", { timeout: 30_000 });
      await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 15_000 });
      return guidedAction({ selector, description: "Save the synthetic product edit", method: "click" });
    },
  }, page, editStartUrl(input), input, [
    "Enter the requested synthetic short description",
    "Save the synthetic product edit",
  ], OUTPUT_SELECTOR);
}

const adminCustomerId = customerId();
const originalPassword = passwordState(adminCustomerId);
const originalProducts = new Map(products.map((product) => [product.id, productState(product)]));
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-nopcommerce-admin-local-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;
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

  const demonstrationInputs: AdminEditInput[] = [
    { productId: products[0]!.id, shortDescription: "Clapping Hands synthetic admin-edit demonstration alpha" },
    { productId: products[1]!.id, shortDescription: "Clapping Hands synthetic admin-edit demonstration beta" },
  ];
  const demonstrations: DomWorkflowDemonstration[] = [];
  const demonstrationOracles: Array<{
    productId: number;
    databaseExact: boolean;
    storefrontExact: boolean;
    restored: boolean;
  }> = [];
  for (const input of demonstrationInputs) {
    const state = originalProducts.get(input.productId)!;
    restoreProduct(state);
    demonstrations.push(await demonstrateAdminEdit(page, input));
    const databaseExact = observedDescription(input.productId) === input.shortDescription;
    const storefrontExact = await storefrontContains(state, input.shortDescription);
    restoreProduct(state);
    const restored = observedDescription(input.productId) === state.shortDescription;
    demonstrationOracles.push({ productId: input.productId, databaseExact, storefrontExact, restored });
    if (!databaseExact || !storefrontExact || !restored) {
      throw new Error(`The nopCommerce admin demonstration failed its independent or cleanup oracle at product ${input.productId}.`);
    }
  }
  const compileStartedAt = performance.now();
  const plan = compileDomWorkflow(
    "nopcommerce_update_product_short_description",
    editStartUrl(demonstrationInputs[0]!),
    demonstrations,
    {
      effect: "write",
      confirmation: "Update one sample product description in the synthetic loopback-only nopCommerce catalogue",
    },
  );
  const compileMs = performance.now() - compileStartedAt;
  if (plan.effect.commitActionIndex !== 0) {
    throw new Error("The nopCommerce admin edit was not fully withheld until commit.");
  }

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

  const unseenProduct = products[2]!;
  const unseenOriginal = originalProducts.get(unseenProduct.id)!;
  const unseenInput: AdminEditInput = {
    productId: unseenProduct.id,
    shortDescription: "Clapping Hands synthetic unseen admin-edit verification",
  };
  restoreProduct(unseenOriginal);
  const before = observedDescription(unseenProduct.id);
  const receipt = await prepareDomWorkflowWrite(page, journal, plan, unseenInput);
  const afterPrepare = observedDescription(unseenProduct.id);
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, unseenInput);
  const afterCommit = observedDescription(unseenProduct.id);
  const storefrontExact = await storefrontContains(unseenProduct, unseenInput.shortDescription);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, unseenInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = observedDescription(unseenProduct.id);
  const exactResult = before === unseenOriginal.shortDescription && afterPrepare === before &&
    afterCommit === unseenInput.shortDescription && storefrontExact && repeatedCommitRejected &&
    afterRejectedRepeat === afterCommit && committed.receipt.status === "committed" &&
    committed.result.modelCalls === 0;

  for (const state of originalProducts.values()) restoreProduct(state);
  cleanupVerified = [...originalProducts.values()].every((state) =>
    observedDescription(state.id) === state.shortDescription);

  const inventory = pluginInventory();
  const localSurface = await apiSurface();
  const apiGateExact = inventory.frontendInstalled && !inventory.backendInstalled &&
    localSurface.some((probe) => probe.path === "/api-frontend/Authenticate/GetToken" && probe.status === 400) &&
    localSurface.some((probe) => probe.path === "/api-backend/Authenticate/GetToken" && probe.status === 404);
  const rows = [{
    task: "update-unseen-product-short-description",
    effect: "write",
    engine: plan.engine,
    exactResult,
    preparedWithoutEffect: afterPrepare === before,
    repeatedCommitRejected,
    compiledModelCalls: committed.result.modelCalls,
    compiledDurationMs: Number(committed.result.durationMs.toFixed(2)),
    oracle: {
      productId: unseenProduct.id,
      databaseExact: afterCommit === unseenInput.shortDescription,
      storefrontExact,
      afterRejectedRepeatUnchanged: afterRejectedRepeat === afterCommit,
    },
  }];
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runClass: "self-hosted-application-capability",
    application: "Self-hosted nopCommerce 4.90.6 admin",
    origin: ORIGIN,
    sourceCommit: NOPCOMMERCE_SOURCE_COMMIT,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    environment: { browserVersion, platform: process.platform, architecture: process.arch },
    intervention: "guided",
    policyBasis: "Loopback-only official container, vendor sample catalogue, and one synthetic administrator",
    credentialHandling: "Generated and rotated a synthetic administrator password in memory, restored the prior hash and salt, and persisted no credential, token, plan, or page body",
    apiDisposition: {
      pluginInventory: inventory,
      localSurface,
      gateExact: apiGateExact,
      decision: "The installed frontend API exposes a token route but no backend/admin API provider is installed; editing catalogue products was not task-complete through the configured API surface",
    },
    setupCorrections: [
      "nopCommerce admin pages use .content-wrapper rather than the storefront-style #content convention; the harness now observes the actual stable admin region while PostgreSQL and the public storefront remain the success oracles.",
    ],
    authSurvivedBrowserRestart,
    compileMs: Number(compileMs.toFixed(2)),
    effectBoundaryActionIndex: plan.effect.commitActionIndex,
    fixtureCleanupVerified: cleanupVerified,
    demonstrationOracles,
    rows,
    claimScope: "One unseen protected admin write on one pinned self-hosted application, compiled from two varied demonstrations",
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: repeatedCommitRejected ? 0 : 1,
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.falseSuccesses !== 0 ||
    report.summary.duplicateCommits !== 0 || !authSurvivedBrowserRestart || !cleanupVerified || !apiGateExact) {
    throw new Error(`nopCommerce admin local run failed: ${JSON.stringify(report.summary)}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "nopcommerce-admin-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    reportPath,
    ...report.summary,
    authSurvivedBrowserRestart,
    fixtureCleanupVerified: cleanupVerified,
    apiGateExact,
    compileMs: report.compileMs,
    compiledDurationMs: rows[0]!.compiledDurationMs,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  let restorationError: unknown;
  try {
    for (const state of originalProducts.values()) restoreProduct(state);
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
