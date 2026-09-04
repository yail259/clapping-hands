import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  replayDomWorkflow,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";

const ORIGIN = "https://playground.wordpress.net";
const START_URL = `${ORIGIN}/?url=/wp-admin/edit.php`;
const FROZEN_COMPILER_COMMIT = "054bf03d80bf5401e26267e2a7c6d59931670876";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!process.argv.includes("--live")) {
  throw new Error(
    "Live traffic is disabled. Pass --live to run the isolated, browser-local WordPress Playground holdout.",
  );
}

async function wordpressFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) =>
      candidate.url().startsWith(`${ORIGIN}/scope:`) && candidate.url().includes("/wp-admin/edit.php"));
    if (frame) {
      await frame.locator("#post-search-input").waitFor({ state: "visible", timeout: 10_000 });
      return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("WordPress Playground did not expose its posts administration frame.");
}

function learnerResult(selector: string, description: string, method: string, arguments_: string[] = []) {
  return {
    success: true,
    message: "guided holdout action",
    actions: [{ selector, description, method, arguments: arguments_ }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateSearch(page: Page, query: string): Promise<DomWorkflowDemonstration> {
  let instructionIndex = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      const frame = await wordpressFrame(page);
      instructionIndex += 1;
      if (instructionIndex === 1) {
        await frame.locator("#post-search-input").fill(query);
        return learnerResult("#post-search-input", `Enter ${query} in post search`, "fill", [query]);
      }
      await frame.locator("#search-submit").click();
      await frame.locator(".wp-list-table.posts").waitFor({ state: "visible", timeout: 15_000 });
      return learnerResult("#search-submit", `Search posts for ${query}`, "click");
    },
  }, page, START_URL, { query }, [
    `Enter ${query} in the post search field`,
    `Search posts for ${query}`,
  ], ".wp-list-table.posts");
}

let browser: Browser | null = null;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1_000 } });
  const demonstrations = [
    await demonstrateSearch(page, "Hello"),
    await demonstrateSearch(page, "missing-fixture-post"),
  ];
  const plan = compileDomWorkflow("wordpress_playground_search_posts", START_URL, demonstrations);
  const result = await replayDomWorkflow(page, plan, { query: "world" });
  const exactResult = result.text.includes("Hello world!") && !result.text.includes("No posts found.");
  const rows = [{
    task: "search-posts",
    effect: "read",
    path: "same-origin-iframe-dom",
    intervention: "guided",
    demonstrations: demonstrations.length,
    compiledRuns: 1,
    compiledModelCalls: result.modelCalls,
    compiledDurationMs: result.durationMs,
    exactResult,
  }];
  const report = {
    schemaVersion: 1,
    kind: "frozen-holdout-smoke",
    generatedAt: new Date().toISOString(),
    frozenCompilerCommit: FROZEN_COMPILER_COMMIT,
    testedCompilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "WordPress Playground",
    origin: ORIGIN,
    policyBasis: "Official isolated browser sandbox; all state remained in the ephemeral local Playground instance",
    intervention: "guided",
    claimScope: "Frozen-corpus capability holdout; n=1 compiled run, not a speed benchmark",
    traffic: {
      inspectionJourneys: 2,
      failedAttemptJourneys: 6,
      reportedRunJourneys: 3,
      totalTopLevelJourneys: 11,
      externalWordPressSitesModified: 0,
    },
    developmentHistory: [
      {
        attempt: 1,
        compilerCommit: FROZEN_COMPILER_COMMIT,
        result: "failed-closed",
        reason: "The compiled control was checked before the asynchronous Playground iframe mounted.",
        fix: "Wait for a compiled selector to become uniquely available, including through a declared frame path.",
        journeys: 3,
      },
      {
        attempt: 2,
        result: "failed-closed",
        reason: "The two search strings selected the same single result row, so freshness could not be proven.",
        fix: "Correct the holdout inputs to demonstrate a miss and a hit; no compiler behavior changed.",
        journeys: 3,
      },
    ],
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
    },
  };
  if (!exactResult) throw new Error("WordPress Playground returned an inexact compiled result.");
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "wordpress-playground-holdout.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close();
}
