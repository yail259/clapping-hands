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

const ORIGIN = process.env.CLAPPING_HANDS_OSTICKET_ORIGIN ?? "http://127.0.0.1:18089";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_IMAGE_DIGEST = "sha256:2900dc6d032b13548e9f15194c298f464d5a0ee70441c0c592fcb7f87e009400";
const DB_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const SAMPLE_SIZE = 20;
const WARMUPS = 3;
const username = process.env.CLAPPING_HANDS_OSTICKET_USERNAME;
const password = process.env.CLAPPING_HANDS_OSTICKET_PASSWORD;

if (!process.argv.includes("--local")) {
  throw new Error("osTicket performance traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The osTicket performance runner only permits a loopback origin.");
}
if (!username || !password) {
  throw new Error("Set the synthetic local osTicket username and password in the process environment.");
}

const expectedSubjects: Record<string, string> = {
  Printer: "Printer calibration fixture",
  VPN: "VPN access fixture",
  Invoice: "Invoice export fixture",
};
const queries = Object.keys(expectedSubjects);

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function roundedSamples(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(2)));
}

function exactSearchResult(query: string, result: FormWorkflowResult): boolean {
  const expected = expectedSubjects[query];
  if (!expected || !result.mainText.includes(expected)) return false;
  return Object.values(expectedSubjects).filter((subject) => subject !== expected)
    .every((subject) => !result.mainText.includes(subject));
}

async function login(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/scp/login.php`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#name").isVisible().catch(() => false)) {
    await page.locator("#name").fill(username!);
    await page.locator("#pass").fill(password!);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/scp\/(?:index|tickets)\.php/, { timeout: 15_000 });
  }
  if (!await page.locator("#pjax-container").isVisible().catch(() => false)) {
    throw new Error("The synthetic local osTicket staff session did not authenticate.");
  }
}

function answersFor(questionKey: string, query: string): FormWorkflowAnswers {
  return { [questionKey]: { query } };
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-osticket-performance-"));
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

  const startUrl = `${ORIGIN}/scp/index.php`;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const candidate = inspectFormCandidates(await page.content(), page.url()).find((form) =>
    form.method === "GET" && form.actionPath === "/scp/tickets.php" &&
    form.controls.some((control) => control.name === "query"));
  if (!candidate) throw new Error("The local osTicket ticket-search form was not found.");

  const compileStartedAt = performance.now();
  const demonstrations = [];
  for (const query of ["Printer", "VPN"]) {
    demonstrations.push(await demonstrateFormWorkflow(page, startUrl, answersFor(candidate.questionKey, query)));
  }
  const plan = compileFormWorkflow("osticket_search_ticket_performance", startUrl, demonstrations);
  const compileMs = performance.now() - compileStartedAt;
  const questionKey = plan.steps[0]!.questionKey;

  for (let index = 0; index < WARMUPS; index += 1) {
    const query = queries[index % queries.length]!;
    const answers = answersFor(questionKey, query);
    const browserResult = await replayFormWorkflowInBrowser(page, plan, answers);
    const compiledResult = await replayFormWorkflow(context, plan, answers);
    if (!exactSearchResult(query, browserResult) || !exactSearchResult(query, compiledResult)) {
      throw new Error(`osTicket warmup returned an inexact result for ${query}.`);
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
    throw new Error(`osTicket performance correctness failed: browser ${browserCorrect}/${SAMPLE_SIZE}, compiled ${compiledCorrect}/${SAMPLE_SIZE}.`);
  }
  const browserP50 = percentile(browserMs, 0.5);
  const compiledP50 = percentile(compiledMs, 0.5);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runner: "scripts/benchmark-osticket-performance.ts",
    runClass: "self-hosted-application-performance",
    intervention: "guided form demonstrations plus an independent exact subject oracle",
    application: "Self-hosted osTicket",
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    environment: { browserVersion, platform: process.platform, architecture: process.arch },
    credentialHandling: "Read a synthetic loopback-only fixture credential from the process environment; persisted no credential in plans or results",
    protocol: {
      warmups: WARMUPS,
      pairedSamples: SAMPLE_SIZE,
      order: "interleaved; browser first on even samples and compiled first on odd samples",
      queryCycle: queries,
    },
    workflow: {
      id: "osticket-search-ticket",
      engine: plan.engine,
      compileMs: Number(compileMs.toFixed(2)),
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
    claimScope: "One pinned self-hosted application and one read workflow; not a general website speed claim",
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "osticket-local-performance.json");
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
