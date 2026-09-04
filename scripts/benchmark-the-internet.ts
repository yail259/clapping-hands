import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  replayDomWorkflow,
  type DomWorkflowDemonstration,
  type DomWorkflowResult,
} from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";

const ORIGIN = "https://the-internet.herokuapp.com";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const live = process.argv.includes("--live");

if (!live) {
  throw new Error(
    "Live traffic is disabled. Review docs/BENCHMARK_CORPUS.md, then pass --live for nine bounded journeys on the purpose-built acceptance-test app.",
  );
}

type SmokeRow = {
  task: string;
  effect: "read" | "commit";
  intervention: "guided";
  demonstrations: number;
  compiledRuns: number;
  compiledModelCalls: number;
  exactResult: boolean;
  compiledDurationMs: number;
  artifact?: { suggestedFilename: string; size: number; sha256: string };
};

function learnerResult(selector: string, description: string) {
  return {
    success: true,
    message: "guided benchmark action",
    actions: [{ selector, description, method: "click", arguments: [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateClick(
  page: Page,
  startPath: string,
  selector: string,
  instruction: string,
  outputSelector: string,
): Promise<DomWorkflowDemonstration> {
  return demonstrateDomWorkflow({
    act: async () => {
      await page.locator(selector).click();
      await page.locator(outputSelector).waitFor({ state: "visible", timeout: 15_000 });
      return learnerResult(selector, instruction);
    },
  }, page, `${ORIGIN}${startPath}`, {}, [instruction], outputSelector);
}

async function dynamicControlRow(browser: Browser): Promise<SmokeRow> {
  const page = await browser.newPage();
  try {
    const selector = "#checkbox-example button";
    const demonstrations = [
      await demonstrateClick(page, "/dynamic_controls", selector, "Remove the checkbox", "#message"),
      await demonstrateClick(page, "/dynamic_controls", selector, "Remove the checkbox", "#message"),
    ];
    const plan = compileDomWorkflow("internet_dynamic_control", `${ORIGIN}/dynamic_controls`, demonstrations);
    const result = await replayDomWorkflow(page, plan, {});
    return {
      task: "delayed-element-removal",
      effect: "read",
      intervention: "guided",
      demonstrations: 2,
      compiledRuns: 1,
      compiledModelCalls: result.modelCalls,
      exactResult: result.text === "It's gone!",
      compiledDurationMs: result.durationMs,
    };
  } finally {
    await page.close();
  }
}

async function confirmDialogRow(browser: Browser, journal: EffectJournal): Promise<SmokeRow> {
  const page = await browser.newPage();
  try {
    const selector = 'button:has-text("Click for JS Confirm")';
    const instruction = "Open the JavaScript confirmation and accept the dialog";
    const demonstrations = [
      await demonstrateClick(page, "/javascript_alerts", selector, instruction, "#result"),
      await demonstrateClick(page, "/javascript_alerts", selector, instruction, "#result"),
    ];
    const plan = compileDomWorkflow("internet_confirm_dialog", `${ORIGIN}/javascript_alerts`, demonstrations, {
      effect: "write",
      confirmation: "Accept the purpose-built test application's JavaScript confirmation",
    });
    const receipt = await prepareDomWorkflowWrite(page, journal, plan, {});
    const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, {});
    return {
      task: "javascript-confirm",
      effect: "commit",
      intervention: "guided",
      demonstrations: 2,
      compiledRuns: 1,
      compiledModelCalls: committed.result.modelCalls,
      exactResult: committed.result.text === "You clicked: Ok" && committed.receipt.status === "committed",
      compiledDurationMs: committed.result.durationMs,
    };
  } finally {
    await page.close();
  }
}

async function downloadRow(browser: Browser): Promise<SmokeRow> {
  let page = await browser.newPage({ acceptDownloads: true });
  try {
    const selector = 'a[href="download/test_file.txt"]';
    const demonstrations = [
      await demonstrateClick(page, "/download", selector, "Download test_file.txt", selector),
      await demonstrateClick(page, "/download", selector, "Download test_file.txt", selector),
    ];
    const plan = compileDomWorkflow("internet_download_file", `${ORIGIN}/download`, demonstrations);
    await page.close();
    page = await browser.newPage({ acceptDownloads: true });
    const result: DomWorkflowResult = await replayDomWorkflow(page, plan, {});
    const artifact = result.downloads?.[0];
    const exactResult = result.text === "test_file.txt" && artifact?.suggestedFilename === "test_file.txt" &&
      Boolean(artifact.size > 0 && /^[0-9a-f]{64}$/.test(artifact.sha256));
    return {
      task: "download-file",
      effect: "read",
      intervention: "guided",
      demonstrations: 2,
      compiledRuns: 1,
      compiledModelCalls: result.modelCalls,
      exactResult,
      compiledDurationMs: result.durationMs,
      ...(artifact ? {
        artifact: {
          suggestedFilename: artifact.suggestedFilename,
          size: artifact.size,
          sha256: artifact.sha256,
        },
      } : {}),
    };
  } finally {
    if (!page.isClosed()) await page.close();
  }
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-the-internet-"));
const previousArtifactRoot = process.env.CLAPPING_HANDS_ARTIFACT_ROOT;
let browser: Browser | null = null;
try {
  process.env.CLAPPING_HANDS_ARTIFACT_ROOT = resolve(directory, "artifacts");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
  const rows = [
    await dynamicControlRow(browser),
    await confirmDialogRow(browser, journal),
    await downloadRow(browser),
  ];
  const report = {
    schemaVersion: 1,
    kind: "live-purpose-built-smoke",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "The Internet",
    origin: ORIGIN,
    policyBasis: "Official example application for automated acceptance tests",
    traffic: { totalJourneys: 10, writesToSharedFileList: 0 },
    intervention: "guided",
    claimScope: "Capability smoke only; n=1 compiled run per task, not a speed benchmark",
    developmentHistory: [{
      attempt: 1,
      task: "delayed-element-removal",
      result: "failed-closed",
      reason: "The guided benchmark action returned before the AJAX result region existed.",
      fix: "Wait for the declared output region before ending each guided demonstration.",
      journeys: 1,
    }],
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
    },
  };
  if (report.summary.passed !== report.summary.total) throw new Error(`Live smoke failed: ${JSON.stringify(report.summary)}`);
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "the-internet-live-smoke.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  if (previousArtifactRoot === undefined) delete process.env.CLAPPING_HANDS_ARTIFACT_ROOT;
  else process.env.CLAPPING_HANDS_ARTIFACT_ROOT = previousArtifactRoot;
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
