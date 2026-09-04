import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  compileFormWorkflow,
  demonstrateFormWorkflow,
  inspectFormCandidates,
  replayFormWorkflow,
  replayFormWorkflowInBrowser,
  type FormWorkflowAnswers,
  type FormWorkflowResult,
} from "../src/form-workflow.js";

const ORIGIN = process.env.CLAPPING_HANDS_WORDPRESS_ORIGIN ?? "http://127.0.0.1:18090";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_IMAGE_DIGEST = "sha256:5a93c470ae8220fddf71f6ebe3bc94e615ddc2ae4d9810f795b830fb11c41a17";
const DB_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const SETUP_IMAGE_DIGEST = "sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586";
const SAMPLE_SIZE = 20;
const WARMUPS = 3;
const username = process.env.CLAPPING_HANDS_WORDPRESS_USERNAME;
const password = process.env.CLAPPING_HANDS_WORDPRESS_PASSWORD;

if (!process.argv.includes("--local")) {
  throw new Error("WordPress performance traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The WordPress performance runner only permits a loopback origin.");
}
if (!username || !password) {
  throw new Error("Set the synthetic local WordPress username and password in the process environment.");
}

const expectedTitles: Record<string, string> = {
  Printer: "Printer calibration fixture",
  VPN: "VPN access fixture",
  Invoice: "Invoice export fixture",
};
const queries = Object.keys(expectedTitles);

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function roundedSamples(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(2)));
}

function exactSearchResult(query: string, result: FormWorkflowResult): boolean {
  const expected = expectedTitles[query];
  if (!expected || !result.mainText.includes(expected)) return false;
  return Object.values(expectedTitles).filter((title) => title !== expected)
    .every((title) => !result.mainText.includes(title));
}

async function login(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/wp-login.php`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#user_login").isVisible().catch(() => false)) {
    await page.locator("#user_login").fill(username!);
    await page.locator("#user_pass").fill(password!);
    await Promise.all([
      page.waitForURL((url) => url.pathname.startsWith("/wp-admin/"), { timeout: 30_000 }),
      page.locator("#wp-submit").click(),
    ]);
  }
  if (!await page.locator("#wpadminbar").isVisible().catch(() => false)) {
    throw new Error("The synthetic local WordPress administrator session did not authenticate.");
  }
}

function answersFor(questionKey: string, query: string): FormWorkflowAnswers {
  return { [questionKey]: { s: query } };
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-wordpress-performance-"));
let context: BrowserContext | null = null;
try {
  context = await chromium.launchPersistentContext(resolve(directory, "profile"), {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1_440, height: 1_000 },
  });
  const browserVersion = context.browser()?.version() ?? "unknown";
  const page = context.pages()[0] ?? await context.newPage();
  await login(page);

  const startUrl = `${ORIGIN}/wp-admin/edit.php`;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const candidate = inspectFormCandidates(await page.content(), page.url())
    .find((form) => form.questionKey === "posts-filter" && form.method === "GET" &&
      form.controls.some((control) => control.name === "s"));
  if (!candidate) throw new Error("The WordPress Posts search form was not found or was not safely eligible.");

  const compileStartedAt = performance.now();
  const demonstrations = [];
  for (const query of ["Printer", "VPN"]) {
    demonstrations.push(await demonstrateFormWorkflow(page, startUrl, answersFor(candidate.questionKey, query)));
  }
  const plan = compileFormWorkflow("wordpress_search_posts_performance", startUrl, demonstrations);
  const compileMs = performance.now() - compileStartedAt;
  const questionKey = plan.steps[0]!.questionKey;
  if (plan.steps.some((step) => step.controls.some((control) => control.name === "post[]"))) {
    throw new Error("WordPress result-row identifiers survived projection into the read plan.");
  }

  for (let index = 0; index < WARMUPS; index += 1) {
    const query = queries[index % queries.length]!;
    const answers = answersFor(questionKey, query);
    const browserResult = await replayFormWorkflowInBrowser(page, plan, answers);
    const compiledResult = await replayFormWorkflow(context, plan, answers);
    if (!exactSearchResult(query, browserResult) || !exactSearchResult(query, compiledResult)) {
      throw new Error(`WordPress warmup returned an inexact result for ${query}.`);
    }
  }

  const browserMs: number[] = [];
  const compiledMs: number[] = [];
  let browserCorrect = 0;
  let compiledCorrect = 0;
  for (let index = 0; index < SAMPLE_SIZE; index += 1) {
    const query = queries[index % queries.length]!;
    const answers = answersFor(questionKey, query);
    const runBrowser = async (): Promise<void> => {
      const result = await replayFormWorkflowInBrowser(page, plan, answers);
      browserMs.push(result.durationMs);
      if (exactSearchResult(query, result)) browserCorrect += 1;
    };
    const runCompiled = async (): Promise<void> => {
      const result = await replayFormWorkflow(context!, plan, answers);
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
    throw new Error(`WordPress performance correctness failed: browser ${browserCorrect}/${SAMPLE_SIZE}, compiled ${compiledCorrect}/${SAMPLE_SIZE}.`);
  }
  const browserP50 = percentile(browserMs, 0.5);
  const compiledP50 = percentile(compiledMs, 0.5);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runner: "scripts/benchmark-wordpress-performance.ts",
    runClass: "self-hosted-application-performance",
    intervention: "guided form demonstrations plus an independent exact post-title oracle",
    application: "Self-hosted WordPress 7.1",
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST, setupCli: SETUP_IMAGE_DIGEST },
    environment: { browserVersion, platform: process.platform, architecture: process.arch },
    credentialHandling: "Read a synthetic loopback-only fixture credential from the process environment; persisted no credential in plans or results",
    protocol: {
      warmups: WARMUPS,
      pairedSamples: SAMPLE_SIZE,
      order: "interleaved; browser first on even samples and compiled first on odd samples",
      queryCycle: queries,
    },
    workflow: {
      id: "wordpress-search-posts",
      engine: plan.engine,
      compileMs: Number(compileMs.toFixed(2)),
      persistedControlNames: plan.steps[0]!.controls.map((control) => control.name),
      browser: {
        p50Ms: browserP50,
        p95Ms: percentile(browserMs, 0.95),
        slowestMs: Number(Math.max(...browserMs).toFixed(2)),
        samplesMs: roundedSamples(browserMs),
        correctness: `${browserCorrect}/${SAMPLE_SIZE}`,
        requestsPerRun: 2,
        navigationsPerRun: 2,
        modelCallsPerRun: 0,
      },
      compiled: {
        p50Ms: compiledP50,
        p95Ms: percentile(compiledMs, 0.95),
        slowestMs: Number(Math.max(...compiledMs).toFixed(2)),
        samplesMs: roundedSamples(compiledMs),
        correctness: `${compiledCorrect}/${SAMPLE_SIZE}`,
        requestsPerRun: 2,
        navigationsPerRun: 0,
        modelCallsPerRun: 0,
      },
      medianSpeedup: Number((browserP50 / compiledP50).toFixed(2)),
    },
    claimScope: "One pinned self-hosted WordPress version and one read workflow; not a general website speed claim",
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "wordpress-local-performance.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    reportPath,
    browserP50Ms: browserP50,
    compiledP50Ms: compiledP50,
    medianSpeedup: report.workflow.medianSpeedup,
    browserCorrect,
    compiledCorrect,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
