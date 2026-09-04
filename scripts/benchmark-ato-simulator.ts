import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const ORIGIN = "https://onlineservicessimulator.ato.gov.au";
const START_URL = `${ORIGIN}/Individual/Home`;
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA_DIRECTORY = resolve(process.cwd(), ".data/live-benchmark");
// Scenario bootstrap, two demonstrations, a conservative restored-tab load,
// and one held-out replay.
const RUN_JOURNEYS = 5;
const DAILY_DOMAIN_CAP = 10;
const OUTPUT_SELECTOR = "main[role=main]";
const SUPER_MENU_SELECTOR = "#atoo-fid-atomastermenu-001-2";
const INFORMATION_MENU_SELECTOR = "#atoo-fid-atomastermenu-001-2-1";
const INFORMATION_LIST_SELECTOR = "#atoo-fid-atomastermenu-001-2-1-item";

if (!process.argv.includes("--live")) {
  throw new Error("ATO simulator traffic is disabled. Pass --live after reviewing the traffic count and simulator scope.");
}
const countArgument = process.argv.find((argument) => argument.startsWith("--external-journeys-today="));
const externalJourneys = countArgument ? Number.parseInt(countArgument.split("=")[1] ?? "", 10) : Number.NaN;
if (!Number.isSafeInteger(externalJourneys) || externalJourneys < 0) {
  throw new Error("Pass --external-journeys-today=N including manual discovery outside this runner.");
}

type ServiceInput = DomInput & { serviceName: string };

const servicePaths = new Map<string, string>([
  ["Transfer balance cap", "/Individual/TransferBalanceAccount"],
  ["Employer contributions", "/Individual/EmployerContributions"],
  ["YourSuper comparison", "/Individual/YSCT"],
]);

function serviceSelector(serviceName: string): string {
  return `${INFORMATION_LIST_SELECTOR} a.ato-menu-link:has-text(${JSON.stringify(serviceName)})`;
}

async function reserveTrafficBudget(): Promise<{ day: string; priorScriptedJourneys: number }> {
  await mkdir(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  const budgetPath = resolve(DATA_DIRECTORY, `ato-traffic-${day}.json`);
  let priorScriptedJourneys = 0;
  try {
    const budget = JSON.parse(await readFile(budgetPath, "utf8")) as { scriptedJourneys?: number };
    priorScriptedJourneys = budget.scriptedJourneys ?? 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (externalJourneys + priorScriptedJourneys + RUN_JOURNEYS > DAILY_DOMAIN_CAP) {
    throw new Error(
      `Live run refused: ${externalJourneys} external + ${priorScriptedJourneys} scripted + ${RUN_JOURNEYS} planned journeys exceeds the daily ATO simulator cap of ${DAILY_DOMAIN_CAP}.`,
    );
  }
  // Reserve before launch so a crash or interruption cannot silently permit a
  // second run that exceeds the declared domain budget.
  await writeFile(budgetPath, `${JSON.stringify({
    day,
    scriptedJourneys: priorScriptedJourneys + RUN_JOURNEYS,
  }, null, 2)}\n`, { mode: 0o600 });
  return { day, priorScriptedJourneys };
}

async function bootstrapMockScenario(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const audience = page.getByLabel(/Tell us about you/i);
  await audience.selectOption({ label: "Other" });

  const scenario = page.getByLabel(/Choose a client scenario/i);
  const scenarioOptions = await scenario.locator("option").evaluateAll((options) => options.map((option) => ({
    label: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
    value: (option as HTMLOptionElement).value,
  })));
  const firstScenario = scenarioOptions.find((option) => /^1(?:\.|\s|-)/.test(option.label));
  if (!firstScenario?.value) throw new Error("ATO simulator scenario 1 was not available.");
  await scenario.selectOption(firstScenario.value);

  const start = page.getByRole("button", { name: "Start", exact: true });
  await start.waitFor({ state: "visible", timeout: 15_000 });
  await Promise.all([
    page.waitForURL((url) => url.pathname.toLowerCase() === "/individual/home", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }),
    start.click(),
  ]);
  await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(/Logged in as/i).first().waitFor({ state: "visible", timeout: 30_000 });
}

function guidedResult(selector: string, description: string) {
  return {
    success: true,
    message: "guided ATO simulator navigation",
    actions: [{ selector, description, method: "click" }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateService(page: Page, input: ServiceInput): Promise<DomWorkflowDemonstration> {
  const expectedPath = servicePaths.get(input.serviceName);
  if (!expectedPath) throw new Error(`Unknown frozen ATO simulator service ${input.serviceName}.`);
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        await page.locator(SUPER_MENU_SELECTOR).click();
        await page.locator(SUPER_MENU_SELECTOR).waitFor({ state: "visible", timeout: 10_000 });
        await page.locator(`${SUPER_MENU_SELECTOR}[aria-expanded=true]`).waitFor({ state: "visible", timeout: 10_000 });
        return guidedResult(SUPER_MENU_SELECTOR, "Open the Super menu");
      }
      if (step === 2) {
        await page.locator(INFORMATION_MENU_SELECTOR).click();
        await page.locator(`${INFORMATION_MENU_SELECTOR}[aria-expanded=true]`).waitFor({ state: "visible", timeout: 10_000 });
        return guidedResult(INFORMATION_MENU_SELECTOR, "Open the Super information menu");
      }
      const selector = serviceSelector(input.serviceName);
      const link = page.locator(selector);
      if (await link.count() !== 1) throw new Error(`Expected one menu link for ${input.serviceName}.`);
      await Promise.all([
        page.waitForURL((url) => url.pathname === expectedPath, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        }),
        link.click(),
      ]);
      await page.locator(OUTPUT_SELECTOR).filter({ hasText: input.serviceName }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      return guidedResult(selector, "Open the requested Super information service");
    },
  }, page, START_URL, input, [
    "Open the Super menu",
    "Open the Super information menu",
    "Open the requested Super information service",
  ], OUTPUT_SELECTOR);
}

const traffic = await reserveTrafficBudget();
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-ato-"));
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
  await bootstrapMockScenario(page);

  const demonstrations = [
    await demonstrateService(page, { serviceName: "Transfer balance cap" }),
    await demonstrateService(page, { serviceName: "Employer contributions" }),
  ];
  const plan = compileDomWorkflow("ato_open_super_information_service", START_URL, demonstrations);

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
    throw new Error("The persistent browser restored no first-party ATO simulator state.");
  }

  const replayInput: ServiceInput = { serviceName: "YourSuper comparison" };
  const replay = await replayDomWorkflow(page, plan, replayInput);
  const finalPath = new URL(replay.url).pathname;
  const visibleHeadings = (await page.getByRole("heading").allInnerTexts()).map((value) => value.replace(/\s+/g, " ").trim());
  const exactResult = finalPath === servicePaths.get(replayInput.serviceName) &&
    replay.text.includes(replayInput.serviceName) &&
    visibleHeadings.some((heading) => heading.includes(replayInput.serviceName));
  if (!exactResult || replay.modelCalls !== 0) {
    throw new Error("ATO simulator compiled replay did not reach the exact unseen service page.");
  }

  const report = {
    schemaVersion: 1,
    kind: "live-educational-simulator-smoke",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "ATO online services simulator",
    origin: ORIGIN,
    policyBasis: "ATO publishes this simulator for learning online services with mock data; it cannot lodge, update, or pay against real ATO records",
    intervention: "guided",
    credentialHandling: "Selected a published mock scenario; no credentials, taxpayer data, or session material were persisted in the plan or report",
    claimScope: "Corpus-v2 candidate capability smoke; one compiled replay, not a speed benchmark or an untouched holdout",
    traffic: {
      externalJourneysBeforeRun: externalJourneys,
      priorScriptedJourneys: traffic.priorScriptedJourneys,
      runnerJourneysReserved: RUN_JOURNEYS,
      dailyDomainCap: DAILY_DOMAIN_CAP,
      realRecordsRead: 0,
      realRecordsChanged: 0,
      submissions: 0,
    },
    task: {
      id: "open-super-information-service",
      demonstrations: [
        { serviceName: "Transfer balance cap" },
        { serviceName: "Employer contributions" },
      ],
      replay: replayInput,
      mechanism: "stateful server-rendered multi-level menu navigation",
      compiledModelCalls: replay.modelCalls,
      compiledDurationMs: replay.durationMs,
      actions: replay.actions,
      navigations: replay.navigations,
      exactResult,
      finalPath,
      visibleHeadingMatched: true,
      sessionSurvivedBrowserRestart: true,
      restoredFirstPartyCookieCount,
    },
    summary: { passed: 1, total: 1, falseSuccesses: 0 },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs", traffic.day);
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "ato-simulator-live-smoke.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
