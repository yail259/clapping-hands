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

const ORIGIN = "https://try.discourse.org";
const START_URL = `${ORIGIN}/categories`;
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_JOURNEYS = 3;
const DAILY_DOMAIN_CAP = 10;

if (!process.argv.includes("--live")) {
  throw new Error("Discourse demo traffic is disabled. Pass --live after reviewing the official sandbox policy and traffic count.");
}
const countArgument = process.argv.find((argument) => argument.startsWith("--external-journeys-today="));
const externalJourneys = countArgument ? Number.parseInt(countArgument.split("=")[1] ?? "", 10) : Number.NaN;
if (!Number.isSafeInteger(externalJourneys) || externalJourneys < 0) {
  throw new Error("Pass --external-journeys-today=N including manual discovery outside this runner.");
}
if (externalJourneys + RUN_JOURNEYS > DAILY_DOMAIN_CAP) {
  throw new Error(`This run would exceed the ${DAILY_DOMAIN_CAP}-journey daily sandbox domain cap.`);
}

type CategoryInput = DomInput & { categoryName: string };

function categorySelector(categoryName: string): string {
  return `a.parent-box-link[href^="/c/"]:has-text(${JSON.stringify(categoryName)})`;
}

async function demonstrateCategory(page: Page, input: CategoryInput): Promise<DomWorkflowDemonstration> {
  return demonstrateDomWorkflow({
    act: async () => {
      const selector = categorySelector(input.categoryName);
      const beforeUrl = page.url();
      await page.locator(selector).click();
      await page.waitForURL((url) => url.href !== beforeUrl && url.pathname.startsWith(`/c/${input.categoryName}/`), {
        timeout: 15_000,
      });
      await page.locator("#main-outlet").filter({ hasText: input.categoryName }).waitFor({
        state: "visible",
        timeout: 15_000,
      });
      return {
        success: true,
        message: "guided Discourse category navigation",
        actions: [{
          selector,
          description: `Open the ${input.categoryName} category`,
          method: "click",
        }],
        modelCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  }, page, START_URL, input, [`Open the ${input.categoryName} category`], "#main-outlet");
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-discourse-"));
const browser = new PersistentWorkflowBrowser({
  allowedOrigins: [ORIGIN],
  profileDirectory: resolve(directory, "profile"),
  executablePath: CHROME,
  headless: true,
});
try {
  const page = await browser.page();
  const demonstrations = [
    await demonstrateCategory(page, { categoryName: "general" }),
    await demonstrateCategory(page, { categoryName: "tech" }),
  ];
  const plan = compileDomWorkflow("discourse_open_category", START_URL, demonstrations);
  const replayInput: CategoryInput = { categoryName: "support" };
  const replay = await replayDomWorkflow(page, plan, replayInput);
  const finalPath = new URL(replay.url).pathname;
  const exactResult = finalPath === "/c/support/50" &&
    replay.text.toLowerCase().includes(replayInput.categoryName);
  if (!exactResult || replay.modelCalls !== 0) {
    throw new Error("Discourse compiled replay did not reach the exact unseen category.");
  }

  const report = {
    schemaVersion: 1,
    kind: "live-resettable-sandbox-smoke",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Discourse Demo",
    origin: ORIGIN,
    policyBasis: "Discourse identifies try.discourse.org as its no-setup demo sandbox for testing and exploration",
    intervention: "guided",
    claimScope: "Corpus-v2 candidate capability smoke; one compiled replay, not a speed benchmark",
    traffic: {
      externalJourneysBeforeRun: externalJourneys,
      runnerJourneys: RUN_JOURNEYS,
      dailyDomainCap: DAILY_DOMAIN_CAP,
      sharedContentCreated: 0,
    },
    task: {
      id: "open-category",
      demonstrations: [{ categoryName: "general" }, { categoryName: "tech" }],
      replay: replayInput,
      mechanism: "ember-client-route",
      compiledModelCalls: replay.modelCalls,
      compiledDurationMs: replay.durationMs,
      navigations: replay.navigations,
      exactResult,
      finalPath,
    },
    summary: { passed: 1, total: 1, falseSuccesses: 0 },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "discourse-demo-live-smoke.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
