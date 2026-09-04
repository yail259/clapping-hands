import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  compileGenericJsonPlan,
  replayGenericJsonPlan,
  type GenericNetworkDemonstration,
} from "../src/generic-network.js";

const executeFile = promisify(execFile);
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SAMPLE_SIZE = 20;

function responseFor(query: string) {
  return {
    items: [{ id: query.length * 101, title: `Fresh ${query} result`, price: query.length * 7 }],
    meta: { count: 1 },
  };
}

function demonstration(origin: string, query: string): GenericNetworkDemonstration {
  return {
    input: { query },
    exchange: {
      url: `${origin}/api/search?q=${encodeURIComponent(query)}`,
      method: "GET",
      resourceType: "fetch",
      requestHeaders: { accept: "application/json" },
      requestBody: "",
      responseStatus: 200,
      responseBody: JSON.stringify(responseFor(query)),
    },
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index]!.toFixed(2));
}

async function browserBaseline(page: Page, origin: string, query: string): Promise<{ durationMs: number; correct: boolean }> {
  const startedAt = performance.now();
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#query").fill(query);
  await page.locator("#search").click();
  const expected = responseFor(query).items[0]!;
  await page.locator("#results").filter({ hasText: expected.title }).waitFor({ state: "visible", timeout: 10_000 });
  const text = (await page.locator("#results").innerText()).trim();
  return {
    durationMs: performance.now() - startedAt,
    correct: text === `${expected.title}|${expected.price}`,
  };
}

async function main(): Promise<void> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(responseFor(query)));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main>
      <label>Search <input id="query"></label><button id="search">Search</button>
      <output id="results">Ready</output>
      <script>document.querySelector('#search').onclick = async () => {
        const value = await (await fetch('/api/search?q=' + encodeURIComponent(document.querySelector('#query').value))).json();
        const item = value.items[0];
        document.querySelector('#results').textContent = item.title + '|' + item.price;
      }</script>
    </main>`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Controlled benchmark fixture did not bind.");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(resolve(tmpdir(), "clapping-hands-controlled-benchmark-"));
  let context: BrowserContext | null = null;

  try {
    const compileStartedAt = performance.now();
    const plan = compileGenericJsonPlan("controlled_search", [
      demonstration(origin, "sofa"),
      demonstration(origin, "chair"),
    ]);
    const compileMs = performance.now() - compileStartedAt;
    context = await chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true });
    const browserVersion = context.browser()?.version() ?? "unknown";
    const page = context.pages()[0] ?? await context.newPage();

    for (const query of ["warmup-one", "warmup-two", "warmup-three"]) {
      await browserBaseline(page, origin, query);
      await replayGenericJsonPlan(context, plan, { query });
    }

    const baselineMs: number[] = [];
    const compiledMs: number[] = [];
    let baselineCorrect = 0;
    let compiledCorrect = 0;
    for (let index = 0; index < SAMPLE_SIZE; index += 1) {
      const query = `case-${index}-${index % 2 === 0 ? "alpha" : "beta"}`;
      const runBaseline = async (): Promise<void> => {
        const result = await browserBaseline(page, origin, query);
        baselineMs.push(result.durationMs);
        if (result.correct) baselineCorrect += 1;
      };
      const runCompiled = async (): Promise<void> => {
        const result = await replayGenericJsonPlan(context!, plan, { query });
        compiledMs.push(result.durationMs);
        if (JSON.stringify(result.data) === JSON.stringify(responseFor(query))) compiledCorrect += 1;
      };
      if (index % 2 === 0) {
        await runBaseline();
        await runCompiled();
      } else {
        await runCompiled();
        await runBaseline();
      }
    }

    const baselineP50 = percentile(baselineMs, 0.5);
    const compiledP50 = percentile(compiledMs, 0.5);
    const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gitSha: stdout.trim(),
      runner: "scripts/benchmark-controlled-general.ts",
      runClass: "controlled-protocol-performance",
      intervention: "fixture-authored action and oracle; not semantic compiler evidence",
      environment: { browserVersion, platform: process.platform, architecture: process.arch },
      workflow: {
        id: "controlled-json-search",
        engine: plan.engine,
        sampleSize: SAMPLE_SIZE,
        compileMs: Number(compileMs.toFixed(2)),
        browser: {
          p50Ms: baselineP50,
          p95Ms: percentile(baselineMs, 0.95),
          slowestMs: Number(Math.max(...baselineMs).toFixed(2)),
          correctness: `${baselineCorrect}/${SAMPLE_SIZE}`,
          requestsPerRun: 2,
          navigationsPerRun: 1,
          modelCallsPerRun: 0,
        },
        compiled: {
          p50Ms: compiledP50,
          p95Ms: percentile(compiledMs, 0.95),
          slowestMs: Number(Math.max(...compiledMs).toFixed(2)),
          correctness: `${compiledCorrect}/${SAMPLE_SIZE}`,
          requestsPerRun: 1,
          navigationsPerRun: 0,
          modelCallsPerRun: 0,
        },
        medianSpeedup: Number((baselineP50 / compiledP50).toFixed(2)),
      },
    };
    const outputDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = resolve(outputDirectory, "controlled-general-compiler.json");
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await context?.close().catch(() => {});
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(profile, { recursive: true, force: true });
  }
}

await main();
