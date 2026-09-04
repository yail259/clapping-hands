import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  captureDomOutput,
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

const ORIGIN = process.env.CLAPPING_HANDS_WORDPRESS_ORIGIN ?? "http://127.0.0.1:18090";
const CONTAINER = process.env.CLAPPING_HANDS_WORDPRESS_CONTAINER ?? "clapping-hands-wordpress-app";
const APP_IMAGE_DIGEST = "sha256:5a93c470ae8220fddf71f6ebe3bc94e615ddc2ae4d9810f795b830fb11c41a17";
const DB_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const PLUGIN_VERSION = "5.10.0";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const username = process.env.CLAPPING_HANDS_WORDPRESS_USERNAME ?? "benchmark-admin";
const password = process.env.CLAPPING_HANDS_WORDPRESS_PASSWORD;
const START_URL = `${ORIGIN}/wp-admin/tools.php?page=redirection.php`;
const OUTPUT_SELECTOR = "#react-ui";
const SOURCE_SELECTOR = `${OUTPUT_SELECTOR} form:not(.redirect-searchbox) input[name="url"]`;
const TARGET_SELECTOR = `${OUTPUT_SELECTOR} form:not(.redirect-searchbox) input[name="text"]`;
const GROUP_SELECTOR = `${OUTPUT_SELECTOR} form:not(.redirect-searchbox) select[name="group"]`;
const SUBMIT_SELECTOR = `${OUTPUT_SELECTOR} form:not(.redirect-searchbox) button[type="submit"]`;

if (!process.argv.includes("--local")) {
  throw new Error("WordPress plugin traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The WordPress plugin runner only permits a loopback origin.");
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(CONTAINER)) {
  throw new Error("The WordPress fixture container name is invalid.");
}
if (!password) throw new Error("Set CLAPPING_HANDS_WORDPRESS_PASSWORD for the local synthetic fixture.");

type RedirectInput = DomInput & { sourceUrl: string; targetUrl: string };
type RedirectRow = {
  id: number;
  url: string;
  status: string;
  actionType: string;
  actionCode: number;
  actionData: string;
  matchType: string;
  groupId: number;
};

const redirectInputs: RedirectInput[] = [
  { sourceUrl: "/clapping-hands-redirection-alpha", targetUrl: "/clapping-hands-target-alpha" },
  { sourceUrl: "/clapping-hands-redirection-beta", targetUrl: "/clapping-hands-target-beta" },
  { sourceUrl: "/clapping-hands-redirection-gamma", targetUrl: "/clapping-hands-target-gamma" },
];

function runFixturePhp(source: string, environment: Record<string, string> = {}): string {
  const environmentArgs = Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  return execFileSync("docker", ["exec", ...environmentArgs, CONTAINER, "php", "-r", source], {
    encoding: "utf8",
  }).trim();
}

function fixturePluginVersion(): string {
  return runFixturePhp(`
    require '/var/www/html/wp-load.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $data = get_plugin_data(WP_PLUGIN_DIR . '/redirection/redirection.php', false, false);
    echo $data['Version'] ?? '';
  `);
}

function redirectRows(sourceUrl: string): RedirectRow[] {
  const payload = runFixturePhp(`
    require '/var/www/html/wp-load.php';
    global $wpdb;
    $source = getenv('CLAPPING_HANDS_REDIRECT_SOURCE');
    $rows = $wpdb->get_results($wpdb->prepare(
      "SELECT id, url, status, action_type, action_code, action_data, match_type, group_id
       FROM {$wpdb->prefix}redirection_items WHERE url = %s ORDER BY id",
      $source
    ), ARRAY_A);
    echo wp_json_encode($rows);
  `, { CLAPPING_HANDS_REDIRECT_SOURCE: sourceUrl });
  const rows = JSON.parse(payload) as Array<Record<string, string>>;
  return rows.map((row) => ({
    id: Number(row.id),
    url: row.url ?? "",
    status: row.status ?? "",
    actionType: row.action_type ?? "",
    actionCode: Number(row.action_code),
    actionData: row.action_data ?? "",
    matchType: row.match_type ?? "",
    groupId: Number(row.group_id),
  }));
}

function removeRedirect(sourceUrl: string): void {
  runFixturePhp(`
    require '/var/www/html/wp-load.php';
    global $wpdb;
    $source = getenv('CLAPPING_HANDS_REDIRECT_SOURCE');
    $wpdb->delete($wpdb->prefix . 'redirection_items', array('url' => $source), array('%s'));
    wp_cache_flush();
  `, { CLAPPING_HANDS_REDIRECT_SOURCE: sourceUrl });
}

async function waitForRedirect(sourceUrl: string): Promise<RedirectRow[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = redirectRows(sourceUrl);
    if (rows.length > 0) return rows;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The synthetic WordPress redirect ${sourceUrl} did not become observable.`);
}

function exactRow(input: RedirectInput, row: RedirectRow | undefined): boolean {
  return Boolean(row) && row!.url === input.sourceUrl && row!.status === "enabled" &&
    row!.actionType === "url" && row!.actionCode === 301 && row!.actionData === input.targetUrl &&
    row!.matchType === "url" && row!.groupId === 1;
}

async function login(page: Page): Promise<void> {
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#user_login").isVisible().catch(() => false)) {
    await page.locator("#user_login").fill(username);
    await page.locator("#user_pass").fill(password!);
    await Promise.all([
      page.waitForURL((url) => url.pathname.startsWith("/wp-admin/"), { timeout: 30_000 }),
      page.locator("#wp-submit").click(),
    ]);
  }
  await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
  if (!await page.locator("#wpadminbar").isVisible().catch(() => false)) {
    throw new Error("The synthetic local WordPress administrator session did not authenticate.");
  }
}

function guidedRedirect(input: RedirectInput) {
  return {
    success: true,
    message: "guided local WordPress Redirection action",
    actions: [
      { selector: SOURCE_SELECTOR, description: "Fill source URL", method: "fill", arguments: [input.sourceUrl] },
      { selector: TARGET_SELECTOR, description: "Fill target URL", method: "fill", arguments: [input.targetUrl] },
      { selector: GROUP_SELECTOR, description: "Select Redirections group", method: "selectOption", arguments: ["1"] },
      { selector: SUBMIT_SELECTOR, description: "Add redirect", method: "click", arguments: [] },
    ],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateRedirect(page: Page, input: RedirectInput): Promise<DomWorkflowDemonstration> {
  const demonstration = await demonstrateDomWorkflow({
    act: async () => {
      await page.locator(SOURCE_SELECTOR).fill(input.sourceUrl);
      await page.locator(TARGET_SELECTOR).fill(input.targetUrl);
      await page.locator(GROUP_SELECTOR).selectOption("1");
      await page.locator(SUBMIT_SELECTOR).click();
      await waitForRedirect(input.sourceUrl);
      await page.locator(OUTPUT_SELECTOR).filter({ hasText: input.sourceUrl }).filter({ hasText: input.targetUrl })
        .waitFor({ state: "visible", timeout: 15_000 });
      return guidedRedirect(input);
    },
  }, page, START_URL, input, [
    `Create a 301 redirect from ${input.sourceUrl} to ${input.targetUrl} in the Redirections group`,
  ], OUTPUT_SELECTOR);
  const rows = redirectRows(input.sourceUrl);
  if (rows.length !== 1 || !exactRow(input, rows[0])) {
    throw new Error("A guided WordPress Redirection demonstration failed its database oracle.");
  }
  demonstration.output = await captureDomOutput(page, OUTPUT_SELECTOR);
  return demonstration;
}

async function publicRedirect(input: RedirectInput): Promise<{ status: number; locationPath: string | null }> {
  const response = await fetch(new URL(input.sourceUrl, ORIGIN), { redirect: "manual" });
  const location = response.headers.get("location");
  return {
    status: response.status,
    locationPath: location ? new URL(location, ORIGIN).pathname : null,
  };
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-wordpress-redirection-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;
try {
  const installedPluginVersion = fixturePluginVersion();
  if (installedPluginVersion !== PLUGIN_VERSION) {
    throw new Error(`Expected Redirection ${PLUGIN_VERSION}, found ${installedPluginVersion || "no installed version"}.`);
  }
  for (const input of redirectInputs) removeRedirect(input.sourceUrl);

  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await login(page);

  const demonstrations: DomWorkflowDemonstration[] = [];
  for (const input of redirectInputs.slice(0, 2)) {
    removeRedirect(input.sourceUrl);
    demonstrations.push(await demonstrateRedirect(page, input));
    removeRedirect(input.sourceUrl);
  }
  const plan = compileDomWorkflow("wordpress_redirection_create_redirect", START_URL, demonstrations, {
    effect: "write",
    confirmation: "Create one synthetic 301 redirect in the loopback-only WordPress fixture",
  });
  const demonstratedValues = redirectInputs.slice(0, 2).flatMap((input) => [input.sourceUrl, input.targetUrl]);
  if (demonstratedValues.some((value) => JSON.stringify(plan).includes(value))) {
    throw new Error("The compiled WordPress plugin plan retained a demonstrated redirect value.");
  }
  if (plan.effect.commitActionIndex !== 0 || plan.actions.at(-1)?.method !== "click" ||
    JSON.stringify(plan.validation.inputEvidenceNames) !== JSON.stringify(["sourceUrl", "targetUrl"])) {
    throw new Error("The WordPress plugin plan did not preserve its conservative write boundary and output evidence.");
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
  const replayInput = redirectInputs[2]!;
  const beforePrepare = redirectRows(replayInput.sourceUrl);
  const prepareUrl = page.url();
  const receipt = await prepareDomWorkflowWrite(page, journal, plan, replayInput);
  const afterPrepare = redirectRows(replayInput.sourceUrl);
  const prepareLeftBrowserUntouched = page.url() === prepareUrl;
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, replayInput);
  const afterCommit = await waitForRedirect(replayInput.sourceUrl);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, replayInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = redirectRows(replayInput.sourceUrl);
  const redirectResponse = await publicRedirect(replayInput);

  const exactResult = beforePrepare.length === 0 && afterPrepare.length === 0 && prepareLeftBrowserUntouched &&
    afterCommit.length === 1 && exactRow(replayInput, afterCommit[0]) &&
    afterRejectedRepeat.length === 1 && afterRejectedRepeat[0]?.id === afterCommit[0]?.id &&
    committed.receipt.status === "committed" && committed.result.modelCalls === 0 && repeatedCommitRejected &&
    committed.result.text.includes(replayInput.sourceUrl) && committed.result.text.includes(replayInput.targetUrl) &&
    redirectResponse.status === 301 && redirectResponse.locationPath === replayInput.targetUrl;

  for (const input of redirectInputs) removeRedirect(input.sourceUrl);
  cleanupVerified = redirectInputs.every((input) => redirectRows(input.sourceUrl).length === 0);
  const rows = [{
    task: "create-unseen-plugin-redirect",
    effect: "write",
    architecture: "WordPress plugin React SPA over same-origin REST API",
    path: "compiled-dom-prepare-commit",
    exactResult,
    preparedWithoutEffect: afterPrepare.length === 0,
    prepareLeftBrowserUntouched,
    receiptStatus: committed.receipt.status,
    repeatedCommitRejected,
    oracle: {
      databaseRowsAfterCommit: afterCommit.length,
      exactDatabaseRecord: exactRow(replayInput, afterCommit[0]),
      unchangedAfterRejectedRepeat: afterRejectedRepeat[0]?.id === afterCommit[0]?.id,
      publicRequestStatus: redirectResponse.status,
      publicLocationMatched: redirectResponse.locationPath === replayInput.targetUrl,
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
    application: `Self-hosted WordPress 7.1 with Redirection ${installedPluginVersion}`,
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    plugin: {
      slug: "redirection",
      version: installedPluginVersion,
      source: "https://wordpress.org/plugins/redirection/",
    },
    intervention: "guided",
    policyBasis: "Loopback-only official containers with one synthetic administrator and synthetic redirect paths",
    credentialHandling: "Read a rotated synthetic credential from the process environment; persisted no credential in plans or reports",
    claimScope: "Capability regression on one pinned WordPress/plugin pair; not a speed or untouched-holdout result",
    apiDisposition: "The plugin REST API is an internal UI transport here; the database and public 301 response were independent correctness oracles",
    developmentHistory: [{
      stage: "write-output-validation",
      result: "general-compiler-fix",
      reason: "Write plans ignored demonstrated input evidence even when the result UI echoed every input.",
      fix: "Retain proven write-result evidence and require both unseen redirect inputs after commit.",
    }],
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
    !report.authSurvivedBrowserRestart || !cleanupVerified) {
    throw new Error(`WordPress plugin capability run failed: ${JSON.stringify(report.summary)}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "wordpress-redirection-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (!cleanupVerified) {
    for (const input of redirectInputs) {
      try { removeRedirect(input.sourceUrl); } catch { /* best-effort synthetic cleanup */ }
    }
  }
  await rm(directory, { recursive: true, force: true });
}
