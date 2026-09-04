import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  replayDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = "https://sandbox.moodledemo.net";
const START_URL = `${ORIGIN}/`;
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_JOURNEYS = 4;
const DAILY_DOMAIN_CAP = 10;

if (!process.argv.includes("--live")) {
  throw new Error("Moodle demo traffic is disabled. Pass --live after reviewing the official sandbox policy and traffic count.");
}
const countArgument = process.argv.find((argument) => argument.startsWith("--external-journeys-today="));
const externalJourneys = countArgument ? Number.parseInt(countArgument.split("=")[1] ?? "", 10) : Number.NaN;
if (!Number.isSafeInteger(externalJourneys) || externalJourneys < 0) {
  throw new Error("Pass --external-journeys-today=N including manual discovery outside this runner.");
}
if (externalJourneys + RUN_JOURNEYS > DAILY_DOMAIN_CAP) {
  throw new Error(`This run would exceed the ${DAILY_DOMAIN_CAP}-journey daily sandbox domain cap.`);
}

type CourseTabInput = DomInput & { courseName: string; tabName: string };

function guidedResult(actions: Array<{ selector: string; description: string; method: string }>) {
  return {
    success: true,
    message: "guided Moodle demo action",
    actions,
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function authenticate(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/login/index.php`, { waitUntil: "load", timeout: 30_000 });
  const pageText = await page.locator("body").innerText();
  const publicFixture = pageText.match(/teacher\s*\/\s*([^\s]+)/i);
  if (!publicFixture) throw new Error("The official Moodle page no longer publishes the teacher demo fixture.");
  await page.locator("#username").fill("teacher");
  await page.locator("#password").fill(publicFixture[1]!);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login/"), { timeout: 30_000 }),
    page.locator("#loginbtn").click(),
  ]);
  if ((await page.locator("body").innerText()).includes("You are not logged in")) {
    throw new Error("The published Moodle fixture did not establish an authenticated session.");
  }
}

function quotedSelectorText(value: string): string {
  return JSON.stringify(value);
}

async function demonstrateCourseTab(page: Page, input: CourseTabInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = `a[href*="/course/view.php"]:has-text(${quotedSelectorText(input.courseName)})`;
        const beforeUrl = page.url();
        await page.locator(selector).click();
        await page.waitForURL((url) => url.href !== beforeUrl && url.pathname === "/course/view.php", { timeout: 15_000 });
        return guidedResult([{
          selector,
          description: `Open course ${input.courseName}`,
          method: "click",
        }]);
      }
      const selector = `a.nav-link:has-text(${quotedSelectorText(input.tabName)})`;
      const beforeUrl = page.url();
      await page.locator(selector).click();
      await page.waitForURL((url) => url.href !== beforeUrl, { timeout: 15_000 });
      await page.locator("#page").filter({ hasText: input.tabName }).waitFor({ state: "visible", timeout: 15_000 });
      return guidedResult([{
        selector,
        description: `Open ${input.tabName} for ${input.courseName}`,
        method: "click",
      }]);
    },
  }, page, START_URL, input, [
    `Open course ${input.courseName}`,
    `Open ${input.tabName} for ${input.courseName}`,
  ], "#page");
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-moodle-"));
const profile = resolve(directory, "profile");
let browser: PersistentWorkflowBrowser | null = null;
try {
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: profile,
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page);

  const demonstrations = [
    await demonstrateCourseTab(page, { courseName: "My first course", tabName: "Participants" }),
    await demonstrateCourseTab(page, { courseName: "My second course", tabName: "Grades" }),
  ];
  const plan = compileDomWorkflow("moodle_open_course_tab", START_URL, demonstrations);

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: profile,
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredFirstPartyCookieCount = (await (await browser.context()).cookies([ORIGIN])).length;
  if (restoredFirstPartyCookieCount === 0) {
    throw new Error("The production persistent browser did not restore any first-party Moodle session state.");
  }
  const replayInput: CourseTabInput = { courseName: "My first course", tabName: "Grades" };
  const replay = await replayDomWorkflow(page, plan, replayInput);
  const activeTab = (await page.locator("a.nav-link.active").allInnerTexts()).map((value) => value.trim());
  const exactResult = new URL(replay.url).pathname === "/grade/report/index.php" &&
    replay.text.includes(replayInput.courseName) && replay.text.includes(replayInput.tabName) &&
    activeTab.includes(replayInput.tabName);
  if (!exactResult || replay.modelCalls !== 0) {
    throw new Error("Moodle compiled replay did not reach the exact unseen course/tab combination.");
  }

  const report = {
    schemaVersion: 1,
    kind: "live-resettable-sandbox-smoke",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Moodle 5.2 Sandbox",
    origin: ORIGIN,
    policyBasis: "Moodle's official demo page invites experimentation and resets this shared sandbox every hour",
    intervention: "guided",
    credentialHandling: "Read the published teacher fixture from the login page; did not persist it in a plan or report",
    claimScope: "Corpus-v2 candidate capability smoke; one compiled replay, not a speed benchmark",
    traffic: {
      externalJourneysBeforeRun: externalJourneys,
      runnerJourneys: RUN_JOURNEYS,
      dailyDomainCap: DAILY_DOMAIN_CAP,
      sharedContentCreated: 0,
    },
    task: {
      id: "open-course-tab",
      demonstrations: [
        { courseName: "My first course", tabName: "Participants" },
        { courseName: "My second course", tabName: "Grades" },
      ],
      replay: replayInput,
      mechanism: "authenticated-server-navigation",
      compiledModelCalls: replay.modelCalls,
      compiledDurationMs: replay.durationMs,
      navigations: replay.navigations,
      exactResult,
      authSurvivedBrowserRestart: true,
      restoredFirstPartyCookieCount,
    },
    summary: { passed: 1, total: 1, falseSuccesses: 0 },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "moodle-sandbox-live-smoke.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
