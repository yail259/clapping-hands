import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { compileDomWorkflow, type DomWorkflowDemonstration } from "../src/dom-workflow.js";
import { compileGenericJsonPlan, type GenericNetworkDemonstration } from "../src/generic-network.js";
import { NetworkRecorder } from "../src/network-recorder.js";
import { WorkflowRuntime, type RuntimeBrowser } from "../src/workflow-runtime.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function fixture(): Promise<{ server: Server; origin: string; setDrift(value: boolean): void }> {
  let drift = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/api/search") {
      response.setHeader("content-type", "application/json");
      const query = url.searchParams.get("q") ?? "";
      response.end(JSON.stringify(drift ? { wrong: true } : { items: [{ title: `Oak ${query}` }] }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main>
      <input id="query"><button id="run">Search</button><output id="result">Ready</output>
      <script>document.querySelector('#run').onclick = () => {
        const query = document.querySelector('#query').value;
        document.querySelector('#result').textContent = 'Result Oak ' + query;
      }</script>
    </main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime fixture did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}`, setDrift: (value) => { drift = value; } };
}

function domDemo(origin: string, query: string): DomWorkflowDemonstration {
  return {
    input: { query },
    actions: [
      { selector: "#query", description: "Fill", method: "fill", arguments: [query] },
      { selector: "#run", description: "Search", method: "click", arguments: [] },
    ],
    output: {
      selector: "#result",
      tagName: "output",
      text: `Result Oak ${query}`,
      textHash: `hash-${query}`,
      url: origin,
    },
    modelCalls: 1,
  };
}

function networkDemo(origin: string, query: string): GenericNetworkDemonstration {
  return {
    input: { query },
    exchange: {
      url: `${origin}/api/search?q=${query}`,
      method: "GET",
      resourceType: "fetch",
      requestHeaders: { accept: "application/json" },
      requestBody: "",
      responseStatus: 200,
      responseBody: JSON.stringify({ items: [{ title: `Oak ${query}` }] }),
    },
  };
}

test("runtime shadows, promotes, uses, and degrades a network accelerator", async () => {
  const { server, origin, setDrift } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-runtime-"));
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let runtime: WorkflowRuntime | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    const runtimeBrowser: RuntimeBrowser = {
      network: new NetworkRecorder(),
      page: async () => page!,
      context: async () => context!,
      goto: async (url) => { await page!.goto(url); return page!; },
      act: async () => ({ success: false, message: "not used", actions: [], modelCalls: 0, inputTokens: 0, outputTokens: 0 }),
      close: async () => { await context?.close(); },
    };
    runtime = new WorkflowRuntime(directory, () => runtimeBrowser);
    const baseline = compileDomWorkflow("search_catalog", origin, [domDemo(origin, "sofa"), domDemo(origin, "chair")]);
    const accelerator = compileGenericJsonPlan("search_catalog", [networkDemo(origin, "sofa"), networkDemo(origin, "chair")]);
    await runtime.store.save(baseline, accelerator);

    const first = await runtime.run("search_catalog", { query: "lamp" });
    assert.equal(first.engine, "browser-dom");
    assert.deepEqual(first.shadow, { matched: true, acceleratorStatus: "provisional" });
    const second = await runtime.run("search_catalog", { query: "desk" });
    assert.deepEqual(second.shadow, { matched: true, acceleratorStatus: "stable" });
    await assert.rejects(
      () => runtime!.run("search_catalog", { query: "table", unexpected: true }),
      /input keys must be exactly: query/,
    );
    assert.equal((await runtime.store.load("search_catalog"))?.accelerator?.status, "stable");
    const third = await runtime.run("search_catalog", { query: "table" });
    assert.equal(third.engine, "network");
    assert.equal(third.accelerated, true);

    setDrift(true);
    const fallback = await runtime.run("search_catalog", { query: "shelf" });
    assert.equal(fallback.engine, "browser-dom");
    assert.match(fallback.fallbackReason ?? "", /structural contract/);
    assert.equal((await runtime.store.load("search_catalog"))?.accelerator?.status, "degraded");
  } finally {
    await runtime?.close();
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
