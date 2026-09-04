import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

const ORIGIN = "https://demo1.nextcloud.com";
const START_URL = `${ORIGIN}/apps/files/files`;
const PROFILE = resolve(process.env.CLAPPING_HANDS_NEXTCLOUD_PROFILE_DIR ?? ".data/nextcloud-v2-profile");
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_JOURNEYS = 3;
const DAILY_DOMAIN_CAP = 10;

if (!process.argv.includes("--live")) {
  throw new Error("Nextcloud trial traffic is disabled. Pass --live after reviewing the official trial policy and traffic count.");
}
const countArgument = process.argv.find((argument) => argument.startsWith("--external-journeys-today="));
const externalJourneys = countArgument ? Number.parseInt(countArgument.split("=")[1] ?? "", 10) : Number.NaN;
if (!Number.isSafeInteger(externalJourneys) || externalJourneys < 0) {
  throw new Error("Pass --external-journeys-today=N including account creation and manual discovery outside this runner.");
}
if (externalJourneys + RUN_JOURNEYS > DAILY_DOMAIN_CAP) {
  throw new Error(`This run would exceed the ${DAILY_DOMAIN_CAP}-journey daily trial-domain cap.`);
}

type FolderInput = DomInput & { folderName: string };

function folderSelector(folderName: string): string {
  return `[aria-label=${JSON.stringify(`Open folder ${folderName}`)}]`;
}

let onboardingDialogsDismissed = 0;

async function dismissTrialOnboarding(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (!await dialog.isVisible().catch(() => false)) return;
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await close.waitFor({ state: "visible", timeout: 10_000 });
  await close.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  onboardingDialogsDismissed += 1;
}

async function demonstrateFolder(page: Page, input: FolderInput): Promise<DomWorkflowDemonstration> {
  return demonstrateDomWorkflow({
    act: async () => {
      await dismissTrialOnboarding(page);
      const selector = folderSelector(input.folderName);
      const beforeUrl = page.url();
      await page.locator(selector).click();
      await page.waitForURL((url) => url.href !== beforeUrl &&
        url.pathname === `/apps/files/files/${encodeURIComponent(input.folderName)}`, { timeout: 15_000 });
      await page.locator("#app-content").filter({ hasText: input.folderName }).waitFor({
        state: "visible",
        timeout: 15_000,
      });
      return {
        success: true,
        message: "guided Nextcloud folder navigation",
        actions: [{
          selector,
          description: `Open folder ${input.folderName}`,
          method: "click",
        }],
        modelCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  }, page, START_URL, input, [`Open folder ${input.folderName}`], "#app-content");
}

function launch(): PersistentWorkflowBrowser {
  return new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: PROFILE,
    executablePath: CHROME,
    headless: true,
  });
}

let browser: PersistentWorkflowBrowser | null = launch();
try {
  let page = await browser.page();
  const demonstrations = [
    await demonstrateFolder(page, { folderName: "Documents" }),
    await demonstrateFolder(page, { folderName: "Photos" }),
  ];
  const plan = compileDomWorkflow("nextcloud_open_folder", START_URL, demonstrations);

  await browser.close();
  browser = launch();
  page = await browser.page();
  const restoredFirstPartyCookieCount = (await (await browser.context()).cookies([ORIGIN])).length;
  if (restoredFirstPartyCookieCount === 0) {
    throw new Error("The production persistent browser did not restore any first-party Nextcloud session state.");
  }

  const replayInput: FolderInput = { folderName: "Templates" };
  const replay = await replayDomWorkflow(page, plan, replayInput);
  const finalPath = new URL(replay.url).pathname;
  const exactResult = finalPath === "/apps/files/files/Templates" && replay.text.includes(replayInput.folderName);
  if (!exactResult || replay.modelCalls !== 0) {
    throw new Error("Nextcloud compiled replay did not reach the exact unseen folder.");
  }

  const report = {
    schemaVersion: 1,
    kind: "live-disposable-trial-smoke",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Nextcloud instant trial",
    origin: ORIGIN,
    policyBasis: "Nextcloud offers an immediate disposable test account for exploring the interface; the account is automatically removed",
    intervention: "guided",
    credentialHandling: "Used only browser-managed state from the official instant-account handoff; persisted no credentials in plans or reports",
    claimScope: "Corpus-v2 candidate capability smoke; one compiled replay, not a speed benchmark",
    traffic: {
      externalJourneysBeforeRun: externalJourneys,
      runnerJourneys: RUN_JOURNEYS,
      dailyDomainCap: DAILY_DOMAIN_CAP,
      sharedContentCreated: 0,
      disposableTrialAccountsCreated: 1,
      onboardingDialogsDismissed,
    },
    task: {
      id: "open-folder",
      demonstrations: [{ folderName: "Documents" }, { folderName: "Photos" }],
      replay: replayInput,
      mechanism: "authenticated-vue-file-route",
      compiledModelCalls: replay.modelCalls,
      compiledDurationMs: replay.durationMs,
      navigations: replay.navigations,
      exactResult,
      finalPath,
      authSurvivedBrowserRestart: true,
      restoredFirstPartyCookieCount,
    },
    summary: { passed: 1, total: 1, falseSuccesses: 0 },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "nextcloud-trial-live-smoke.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
}
