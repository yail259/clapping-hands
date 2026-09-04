import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import {
  captureDomOutput,
  compileDomWorkflow,
  recordDomShadow,
  replayDomWorkflow,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function fixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/selector") {
      response.end(`<!doctype html><main>
        <button data-name="sofa">Sofa</button><button data-name="chair">Chair</button><button data-name="lamp">Lamp</button>
        <output id="result">Choose a product</output>
        <script>document.querySelectorAll('button').forEach(button => button.onclick = () => {
          document.querySelector('#result').textContent = 'Selected ' + button.dataset.name;
        })</script>
      </main>`);
      return;
    }
    response.end(`<!doctype html><main>
      <label>Search <input id="query"></label><button id="run">Run</button>
      <output id="result">Ready</output>
      <script>document.querySelector('#run').onclick = () => {
        const query = document.querySelector('#query').value;
        history.pushState({}, '', '/results?q=' + encodeURIComponent(query));
        document.querySelector('#result').textContent = 'Results for ' + query;
      }</script>
    </main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("DOM fixture did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function searchDemo(browser: Browser, origin: string, query: string): Promise<DomWorkflowDemonstration> {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    await page.locator("#query").fill(query);
    await page.locator("#run").click();
    return {
      input: { query },
      actions: [
        { selector: "#query", description: `Fill ${query}`, method: "fill", arguments: [query] },
        { selector: "#run", description: "Run search", method: "click", arguments: [] },
      ],
      output: await captureDomOutput(page, "#result"),
      modelCalls: 1,
    };
  } finally {
    await page.close();
  }
}

test("compiles semantic DOM actions into redacted zero-model Playwright replay", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const demonstrations = await Promise.all([
      searchDemo(browser, origin, "sofa"),
      searchDemo(browser, origin, "chair"),
    ]);
    const plan = compileDomWorkflow("search", origin, demonstrations);
    assert.doesNotMatch(JSON.stringify(plan), /sofa|chair|Fill/);
    assert.equal(plan.actions[0]!.method, "fill");
    assert.equal(plan.validation.outputMode, "present");

    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { query: "lamp" });
    assert.equal(result.text, "Results for lamp");
    assert.equal(result.modelCalls, 0);
    assert.equal(result.actions, 2);
    assert.equal(result.navigations, 2);

    let stable = recordDomShadow(plan, { query: "lamp" }, true);
    stable = recordDomShadow(stable, { query: "desk" }, true);
    assert.equal(stable.status, "stable");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("redacts an input embedded in a learned selector", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const demo = (product: string): DomWorkflowDemonstration => ({
      input: { product },
      actions: [{
        selector: `button[data-name="${product}"]`,
        description: `Choose ${product}`,
        method: "click",
        arguments: [],
      }],
      output: {
        selector: "#result",
        tagName: "output",
        text: `Selected ${product}`,
        textHash: `hash-${product}`,
        url: `${origin}/selector`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("select-product", `${origin}/selector`, [demo("sofa"), demo("chair")]);
    assert.doesNotMatch(JSON.stringify(plan), /sofa|chair|Choose/);
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { product: "lamp" });
    assert.equal(result.text, "Selected lamp");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("refuses unbound action drift and secret-shaped inputs", () => {
  const output = { selector: "main", tagName: "main", text: "Done", textHash: "hash", url: "https://example.test/result" };
  assert.throws(() => compileDomWorkflow("drift", "https://example.test", [
    { input: { query: "sofa" }, actions: [{ selector: "#one", description: "", method: "click" }], output, modelCalls: 1 },
    { input: { query: "chair" }, actions: [{ selector: "#two", description: "", method: "click" }], output, modelCalls: 1 },
  ]), /varied without a demonstrated input binding/);
  assert.throws(() => compileDomWorkflow("secret", "https://example.test", [
    { input: { password: "one" }, actions: [{ selector: "#password", description: "", method: "fill", arguments: ["one"] }], output, modelCalls: 1 },
    { input: { password: "two" }, actions: [{ selector: "#password", description: "", method: "fill", arguments: ["two"] }], output, modelCalls: 1 },
  ]), /Secrets and authentication material/);
});
