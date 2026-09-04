import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import {
  captureDomOutput,
  compileDomWorkflow,
  recordDomShadow,
  repairDomWorkflow,
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
      instructions: [`Enter ${query} in the search box and run the search`],
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
    assert.equal(plan.repairInstructions.length, 1);
    assert.doesNotMatch(JSON.stringify(plan.repairInstructions), /sofa|chair/);

    const repaired = await repairDomWorkflow({
      act: async (instruction) => {
        assert.equal(typeof instruction, "string");
        const query = String(instruction).match(/^Enter (.+) in the search box/)?.[1] ?? "";
        await page.goto(origin);
        await page.locator("#query").fill(query);
        await page.locator("#run").click();
        return { success: true, message: "repaired", actions: [
          { selector: "#query", description: "Fill", method: "fill", arguments: [query] },
          { selector: "#run", description: "Run", method: "click", arguments: [] },
        ], modelCalls: 1, inputTokens: 10, outputTokens: 2 };
      },
    }, page, plan, { query: "shelf" });
    assert.equal(repaired.text, "Results for shelf");
    assert.equal(repaired.modelCalls, 1);

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

test("allows generated DOM identifiers but rejects high-entropy constant action arguments", () => {
  const output = { selector: "main", tagName: "main", text: "Done", textHash: "hash", url: "https://example.test/result" };
  const generatedSelector = `#${"a1B2c3D4".repeat(8)}`;
  assert.doesNotThrow(() => compileDomWorkflow("generated_id", "https://example.test", [
    { input: { query: "sofa" }, actions: [{ selector: generatedSelector, description: "", method: "fill", arguments: ["sofa"] }], output, modelCalls: 1 },
    { input: { query: "chair" }, actions: [{ selector: generatedSelector, description: "", method: "fill", arguments: ["chair"] }], output, modelCalls: 1 },
  ]));
  const opaque = "a1B2c3D4e5F6g7H8".repeat(4);
  assert.throws(() => compileDomWorkflow("opaque_argument", "https://example.test", [
    { input: { query: "sofa" }, actions: [{ selector: "#query", description: "", method: "fill", arguments: ["sofa", opaque] }], output, modelCalls: 1 },
    { input: { query: "chair" }, actions: [{ selector: "#query", description: "", method: "fill", arguments: ["chair", opaque] }], output, modelCalls: 1 },
  ]), /high-entropy DOM action argument/);
});

test("effectful language cannot be understated as a read workflow", () => {
  const output = { selector: "main", tagName: "main", text: "Done", textHash: "hash", url: "https://example.test/result" };
  const demo = (value: string): DomWorkflowDemonstration => ({
    input: { note: value },
    actions: [
      { selector: "#note", description: "Fill note", method: "fill", arguments: [value] },
      { selector: "#publish", description: "Publish note", method: "click" },
    ],
    output,
    modelCalls: 1,
  });
  assert.throws(
    () => compileDomWorkflow("publish_note", "https://example.test", [demo("one"), demo("two")]),
    /appears effectful/,
  );
  assert.doesNotThrow(
    () => compileDomWorkflow("publish_note", "https://example.test", [demo("one"), demo("two")], {
      effect: "write",
      confirmation: "Publish this note",
    }),
  );
});

test("fails closed when a final action leaves stale output in place", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const output = { selector: "#result", tagName: "output", text: "Ready", textHash: "ready", url: origin };
    const demo = (query: string): DomWorkflowDemonstration => ({
      input: { query },
      actions: [{ selector: "#query", description: `Fill ${query}`, method: "fill", arguments: [query] }],
      output,
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("stale_output", origin, [demo("sofa"), demo("chair")]);
    plan.validation.outputChangeTimeoutMs = 100;
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await assert.rejects(
      () => replayDomWorkflow(page, plan, { query: "lamp" }),
      /did not change after the final action/,
    );
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
