import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
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

const ORIGIN = process.env.CLAPPING_HANDS_MOODLE_ORIGIN ?? "http://127.0.0.1:18092";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const teacherPassword = process.env.CLAPPING_HANDS_MOODLE_TEACHER_PASSWORD;
const studentPassword = process.env.CLAPPING_HANDS_MOODLE_STUDENT_PASSWORD;
const compose = resolve(process.env.CLAPPING_HANDS_MOODLE_COMPOSE ??
  ".data/moodle-local/moodle-docker/bin/moodle-docker-compose");
const APP_IMAGE_DIGEST = "sha256:7fd5f3356a71889fc6eda2a7cca2b44ed1e3f90556f5c3bcd9f2091789739af2";
const DB_IMAGE_DIGEST = "sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675";
const MOODLE_SOURCE_COMMIT = "8ad9354efae75c49a23ca63ec1c5e071f9fefc57";
const MOODLE_DOCKER_COMMIT = "f4c2324d32fb74d7753264381f0a9b418b6034b2";
const SAMPLE_SIZE = 20;
const WARMUPS = 3;

if (!process.argv.includes("--local")) {
  throw new Error("Moodle performance traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The Moodle performance runner only permits a loopback origin.");
}
if (!teacherPassword || !studentPassword) {
  throw new Error("Set rotated synthetic Moodle teacher and student passwords in the process environment.");
}

type SeedResult = {
  courses: Array<{ fullname: string }>;
};

const composeEnvironment = {
  ...process.env,
  MOODLE_DOCKER_WWWROOT: process.env.MOODLE_DOCKER_WWWROOT ?? resolve(".data/moodle-local/wwwroot"),
  MOODLE_DOCKER_DB: process.env.MOODLE_DOCKER_DB ?? "pgsql",
  MOODLE_DOCKER_DB_VERSION: process.env.MOODLE_DOCKER_DB_VERSION ?? "17",
  MOODLE_DOCKER_WEB_HOST: process.env.MOODLE_DOCKER_WEB_HOST ?? "127.0.0.1",
  MOODLE_DOCKER_WEB_PORT: process.env.MOODLE_DOCKER_WEB_PORT ?? "127.0.0.1:18092",
  MOODLE_DOCKER_PHP_VERSION: process.env.MOODLE_DOCKER_PHP_VERSION ?? "8.3",
  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "clapping-hands-moodle",
};

function seedFixture(): SeedResult {
  const output = execFileSync(compose, [
    "exec", "-T",
    "-e", `CH_MOODLE_TEACHER_PASS=${teacherPassword}`,
    "-e", `CH_MOODLE_STUDENT_PASS=${studentPassword}`,
    "webserver", "php", "clapping_hands_seed.php",
  ], {
    cwd: process.cwd(),
    env: composeEnvironment,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  const line = output.trim().split(/\r?\n/).reverse().find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error("The Moodle fixture did not return its course manifest.");
  const parsed = JSON.parse(line) as SeedResult;
  if (!Array.isArray(parsed.courses) || parsed.courses.length !== 3 ||
    parsed.courses.some((course) => typeof course.fullname !== "string")) {
    throw new Error("The Moodle performance fixture requires exactly three synthetic courses.");
  }
  return parsed;
}

const expectedTitles: Record<string, string> = {
  Compiler: "Compiler Fundamentals",
  Reliability: "Workflow Reliability",
  Effect: "Effect Safety",
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

function answersFor(questionKey: string, query: string): FormWorkflowAnswers {
  return { [questionKey]: { q: query } };
}

function exactSearchResult(query: string, result: FormWorkflowResult): boolean {
  const expected = expectedTitles[query];
  const finalUrl = new URL(result.finalUrl);
  return Boolean(expected) && finalUrl.pathname === "/course/search.php" &&
    finalUrl.searchParams.get("q") === query && result.mainText.includes(expected!) &&
    Object.values(expectedTitles).filter((title) => title !== expected)
      .every((title) => !result.mainText.includes(title));
}

async function login(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/login/index.php`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#username").isVisible().catch(() => false)) {
    await page.locator("#username").fill("benchmark-student");
    await page.locator("#password").fill(studentPassword!);
    await page.locator("#loginbtn").click();
    await page.waitForURL((url) => !url.pathname.includes("/login/"), { timeout: 30_000 });
  }
  if (!await page.locator('[data-action="toggle-drawer"]').first().isVisible().catch(() => false) &&
    !await page.getByRole("button", { name: "User menu" }).isVisible().catch(() => false)) {
    throw new Error("The synthetic Moodle student session did not authenticate.");
  }
}

const fixture = seedFixture();
if (new Set(fixture.courses.map((course) => course.fullname)).size !== Object.keys(expectedTitles).length ||
  Object.values(expectedTitles).some((title) => !fixture.courses.some((course) => course.fullname === title))) {
  throw new Error("The Moodle performance course titles drifted from the frozen exact oracle.");
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-moodle-performance-"));
let browser: PersistentWorkflowBrowser | null = null;
try {
  const profileDirectory = resolve(directory, "profile");
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory,
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await login(page);

  const startUrl = `${ORIGIN}/course/search.php`;
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const candidate = inspectFormCandidates(await page.content(), page.url()).find((form) =>
    form.method === "GET" && form.actionPath === "/course/search.php" &&
    form.controls.some((control) => control.name === "q"));
  if (!candidate) throw new Error("The Moodle course-search form was not safely eligible.");

  const demonstrations = [];
  for (const query of ["Compiler", "Reliability"]) {
    demonstrations.push(await demonstrateFormWorkflow(
      page,
      startUrl,
      answersFor(candidate.questionKey, query),
    ));
  }
  const compileStartedAt = performance.now();
  const plan = compileFormWorkflow("moodle_search_courses_performance", startUrl, demonstrations);
  const compileMs = performance.now() - compileStartedAt;
  const questionKey = plan.steps[0]!.questionKey;

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory,
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const authSurvivedBrowserRestart = new URL(page.url()).pathname === "/course/search.php" &&
    !await page.locator("#username").isVisible().catch(() => false);
  if (!authSurvivedBrowserRestart) {
    throw new Error("The synthetic Moodle student session did not survive a clean browser restart.");
  }
  const context = await browser.context();
  const browserVersion = context.browser()?.version() ?? "unknown";

  for (let index = 0; index < WARMUPS; index += 1) {
    const query = queries[index % queries.length]!;
    const answers = answersFor(questionKey, query);
    const browserResult = await replayFormWorkflowInBrowser(page, plan, answers);
    const compiledResult = await replayFormWorkflow(context, plan, answers);
    if (!exactSearchResult(query, browserResult) || !exactSearchResult(query, compiledResult)) {
      throw new Error(`Moodle warmup returned an inexact result for ${query}.`);
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
    throw new Error(`Moodle performance correctness failed: browser ${browserCorrect}/${SAMPLE_SIZE}, compiled ${compiledCorrect}/${SAMPLE_SIZE}.`);
  }
  const browserP50 = percentile(browserMs, 0.5);
  const compiledP50 = percentile(compiledMs, 0.5);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runner: "scripts/benchmark-moodle-performance.ts",
    runClass: "self-hosted-application-performance",
    intervention: "guided form demonstrations plus an independent exact course-title oracle",
    application: "Self-hosted Moodle 5.2.2",
    origin: ORIGIN,
    sources: { moodle: MOODLE_SOURCE_COMMIT, moodleDocker: MOODLE_DOCKER_COMMIT },
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    environment: { browserVersion, platform: process.platform, architecture: process.arch },
    credentialHandling: "Read synthetic loopback-only fixture credentials from the process environment; persisted no credential, session key, plan, or response body",
    authSurvivedBrowserRestart,
    driverCorrections: [{
      stage: "authenticated-profile-restart",
      result: "failed-closed-then-corrected",
      reason: "Moodle uses a session cookie, which raw Chromium did not restore after a clean process restart.",
      correction: "Use Clapping Hands' persistent browser runtime, which snapshots and restores first-party session cookies without exposing them.",
      compilerChanged: false,
    }],
    protocol: {
      warmups: WARMUPS,
      pairedSamples: SAMPLE_SIZE,
      order: "interleaved; browser first on even samples and compiled first on odd samples",
      queryCycle: queries,
    },
    workflow: {
      id: "moodle-search-courses",
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
    claimScope: "One pinned self-hosted Moodle version and one authenticated read workflow; not a general website speed claim",
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "moodle-local-performance.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    reportPath,
    browserP50Ms: browserP50,
    compiledP50Ms: compiledP50,
    medianSpeedup: report.workflow.medianSpeedup,
    browserCorrect,
    compiledCorrect,
    authSurvivedBrowserRestart,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
