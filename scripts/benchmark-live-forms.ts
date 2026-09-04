import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import {
  compileFormWorkflow,
  demonstrateFormWorkflow,
  FormWorkflowPlanStore,
  replayFormWorkflow,
  type FormWorkflowAnswers,
} from "../src/form-workflow.js";

const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA_DIRECTORY = resolve(process.cwd(), ".data/live-benchmark");

type Workflow = {
  id: string;
  title: string;
  url: string;
  answers: FormWorkflowAnswers;
  oracle: RegExp;
};

const workflows: Workflow[] = [
  {
    id: "govuk-state-pension-age",
    title: "GOV.UK State Pension age",
    url: "https://www.gov.uk/state-pension-age/y",
    answers: {
      "which-calculation": { response: "age" },
      "dob-age": { "response[day]": "1", "response[month]": "1", "response[year]": "1960" },
    },
    oracle: /State Pension age|reached State Pension age/i,
  },
  {
    id: "govuk-check-uk-visa",
    title: "GOV.UK Check if you need a UK visa",
    url: "https://www.gov.uk/check-uk-visa/y",
    answers: {
      "what-passport-do-you-have": { response: "australia" },
      "dual-british-or-irish-citizenship": { response: "no" },
      "purpose-of-visit": { response: "tourism" },
    },
    oracle: /electronic travel authorisation|visa/i,
  },
  {
    id: "govuk-holiday-entitlement",
    title: "GOV.UK Calculate holiday entitlement",
    url: "https://www.gov.uk/calculate-your-holiday-entitlement/y",
    answers: {
      "regular-or-irregular-hours": { response: "regular" },
      "basis-of-calculation": { response: "days-worked-per-week" },
      "calculation-period": { response: "full-year" },
      "how-many-days-per-week": { response: "5" },
    },
    oracle: /28 days holiday/i,
  },
];

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 300);
}

function differenceSummary(left: string, right: string): { index: number; baseline: string; compiled: string } | null {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  if (index === left.length && index === right.length) return null;
  const start = Math.max(0, index - 60);
  const end = index + 100;
  return {
    index,
    baseline: left.slice(start, end).replace(/\b\d{1,4}\b/g, "#"),
    compiled: right.slice(start, end).replace(/\b\d{1,4}\b/g, "#"),
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    throw new Error("Live traffic is disabled by default. Re-run with --live after reviewing docs/BENCHMARK_PLAN.md.");
  }
  const externalArgument = process.argv.find((argument) => argument.startsWith("--external-journeys-today="));
  if (!externalArgument) {
    throw new Error("Declare manual/browser traffic with --external-journeys-today=N so it counts against the live budget.");
  }
  const externalJourneys = Number(externalArgument.slice("--external-journeys-today=".length));
  if (!Number.isSafeInteger(externalJourneys) || externalJourneys < 0) {
    throw new Error("--external-journeys-today must be a non-negative integer.");
  }
  await mkdir(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  const budgetPath = resolve(DATA_DIRECTORY, `traffic-${day}.json`);
  let scriptedJourneys = 0;
  try {
    const budget = JSON.parse(await readFile(budgetPath, "utf8")) as { scriptedJourneys?: number };
    scriptedJourneys = budget.scriptedJourneys ?? 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length);
  const selected = only ? workflows.filter((workflow) => workflow.id === only) : workflows;
  if (selected.length === 0) throw new Error(`Unknown workflow ${only}.`);
  const plannedJourneys = selected.length * 2;
  if (externalJourneys + scriptedJourneys + plannedJourneys > 10) {
    throw new Error(
      `Live run refused: ${externalJourneys} external + ${scriptedJourneys} scripted + ${plannedJourneys} planned journeys exceeds the daily domain cap of 10.`,
    );
  }
  // Reserve before launch so an interrupted run fails toward less traffic.
  await writeFile(budgetPath, `${JSON.stringify({ day, scriptedJourneys: scriptedJourneys + plannedJourneys }, null, 2)}\n`, { mode: 0o600 });
  const context = await chromium.launchPersistentContext(resolve(DATA_DIRECTORY, "browser-profile"), {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  const browserVersion = context.browser()?.version() ?? "unknown";
  const rows: Array<Record<string, unknown>> = [];

  try {
    for (const [index, workflow] of selected.entries()) {
      if (index > 0) await delay(15_000);
      const page = await context.newPage();
      try {
        const baseline = await demonstrateFormWorkflow(page, workflow.url, workflow.answers);
        const plan = compileFormWorkflow(workflow.id, workflow.url, [baseline]);
        await new FormWorkflowPlanStore(resolve(DATA_DIRECTORY, `${workflow.id}.plan.json`)).save(plan);
        const compiled = await replayFormWorkflow(context, plan, workflow.answers);
        const exactOutputAgreement = baseline.result.resultHash === compiled.resultHash;
        const oraclePass = workflow.oracle.test(baseline.result.mainText) && workflow.oracle.test(compiled.mainText);
        rows.push({
          id: workflow.id,
          title: workflow.title,
          host: new URL(workflow.url).host,
          effect: "read",
          intervention: "guided",
          status: exactOutputAgreement && oraclePass ? "smoke_pass" : "failed",
          steps: plan.steps.length,
          planStatus: plan.status,
          baselineMs: Math.round(baseline.result.durationMs),
          compiledMs: Math.round(compiled.durationMs),
          speedup: Number((baseline.result.durationMs / compiled.durationMs).toFixed(2)),
          baselineNavigations: baseline.result.navigations,
          compiledNavigations: compiled.navigations,
          compiledRequests: compiled.requests,
          modelCalls: 0,
          exactOutputAgreement,
          oraclePass,
          baselineResultHash: baseline.result.resultHash,
          resultHash: compiled.resultHash,
          difference: differenceSummary(baseline.result.mainText, compiled.mainText),
          error: null,
        });
      } catch (error) {
        rows.push({
          id: workflow.id,
          title: workflow.title,
          host: new URL(workflow.url).host,
          effect: "read",
          intervention: "guided",
          status: "failed",
          error: safeError(error),
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runner: "scripts/benchmark-live-forms.ts",
    browserVersion,
    runClass: "low-volume-live-smoke",
    rows,
  };
  const path = resolve(DATA_DIRECTORY, "latest.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.error(`Sanitized local report: ${path}`);
  if (rows.some((row) => row.status !== "smoke_pass")) process.exitCode = 1;
}

await main();
