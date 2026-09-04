import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import {
  captureDomOutput,
  compileDomWorkflow,
  demonstrateDomWorkflow,
  executeCompiledDomAction,
  recordDomShadow,
  repairDomWorkflow,
  replayDomWorkflow,
  validateDomOutput,
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
    if (url.pathname === "/record") {
      const id = url.searchParams.get("id") ?? "missing";
      response.end(`<!doctype html><main>
        <p id="record-id">Record ${id}</p><input id="note"><button id="preview">Preview</button>
        <output id="result">Ready</output>
        <script>document.querySelector('#preview').onclick = () => {
          document.querySelector('#result').textContent = 'Record ${id}: ' + document.querySelector('#note').value;
        };</script>
      </main>`);
      return;
    }
    if (url.pathname === "/popup") {
      response.end(`<!doctype html><main>
        <label>Search <input id="query"></label><button id="open">Open result</button>
        <script>document.querySelector('#open').onclick = () => {
          window.open('/popup-result?q=' + encodeURIComponent(document.querySelector('#query').value), '_blank');
        }</script>
      </main>`);
      return;
    }
    if (url.pathname === "/popup-result") {
      response.end(`<!doctype html><main><output id="popup-result">Result for ${url.searchParams.get("q") ?? ""}</output></main>`);
      return;
    }
    if (url.pathname === "/frame") {
      response.end(`<!doctype html><main><iframe id="app" title="Search app" src="/frame-body"></iframe></main>`);
      return;
    }
    if (url.pathname === "/async-frame") {
      response.end(`<!doctype html><main><script>
        setTimeout(() => {
          const frame = document.createElement('iframe');
          frame.id = 'app';
          frame.title = 'Delayed search app';
          frame.src = '/frame-body';
          document.querySelector('main').append(frame);
        }, 100);
      </script></main>`);
      return;
    }
    if (url.pathname === "/async-handler.js") {
      response.setHeader("content-type", "text/javascript");
      setTimeout(() => response.end(`document.querySelector('#async-run').onclick = () => {
        document.querySelector('#async-result').textContent = 'Async handler ready';
      };`), 150);
      return;
    }
    if (url.pathname === "/async-handler") {
      response.end(`<!doctype html><main>
        <button id="async-run">Run async handler</button><output id="async-result">Ready</output>
        <script async src="/async-handler.js"></script>
      </main>`);
      return;
    }
    if (url.pathname === "/hydration-ready") {
      response.setHeader("content-type", "application/json");
      setTimeout(() => response.end('{"ready":true}'), 150);
      return;
    }
    if (url.pathname === "/post-load-hydration") {
      response.end(`<!doctype html><main>
        <button id="hydrated-run">Run hydrated handler</button><output id="hydrated-result">Ready</output>
        <script>window.addEventListener('load', async () => {
          await fetch('/hydration-ready');
          document.querySelector('#hydrated-run').onclick = () => {
            document.querySelector('#hydrated-result').textContent = 'Hydrated handler ready';
          };
        });</script>
      </main>`);
      return;
    }
    if (url.pathname === "/never-load-image") {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": "1",
      });
      request.on("close", () => response.destroy());
      return;
    }
    if (url.pathname === "/dom-ready-never-load") {
      response.end(`<!doctype html><main>
        <img src="/never-load-image" alt="">
        <button id="dom-ready-run">Run usable app</button><output id="dom-ready-result">Ready</output>
        <script>document.querySelector('#dom-ready-run').onclick = () => {
          document.querySelector('#dom-ready-result').textContent = 'Usable before global load';
        };</script>
      </main>`);
      return;
    }
    if (url.pathname === "/rich-editor") {
      response.end(`<!doctype html><main><form>
        <div id="editor" contenteditable="true"></div><textarea id="source" hidden></textarea>
        <button id="preview" type="button">Preview</button><output id="rich-result">Ready</output>
        <script>
          document.querySelector('#editor').addEventListener('blur', () => setTimeout(() => {
            document.querySelector('#source').value = document.querySelector('#editor').innerText;
          }, 75));
          document.querySelector('#preview').onclick = () => {
            document.querySelector('#rich-result').textContent = 'Submitted ' + document.querySelector('#source').value;
          };
        </script>
      </form></main>`);
      return;
    }
    if (url.pathname === "/intercepted-rich-editor") {
      response.end(`<!doctype html><main><form>
        <div id="editor" contenteditable="true"></div><textarea id="source" hidden></textarea>
        <button id="preview" type="button">Preview</button><output id="rich-result">Ready</output>
        <script>
          document.querySelector('#editor').addEventListener('keydown', event => event.preventDefault());
          document.querySelector('#editor').addEventListener('input', () => {
            document.querySelector('#source').value = document.querySelector('#editor').innerText;
          });
          document.querySelector('#preview').onclick = () => {
            document.querySelector('#rich-result').textContent = 'Submitted ' + document.querySelector('#source').value;
          };
        </script>
      </form></main>`);
      return;
    }
    if (url.pathname === "/frame-body") {
      response.end(`<!doctype html><main>
        <label>Search <input id="frame-query"></label><button id="frame-run">Run</button>
        <output id="frame-result">Ready</output>
        <script>document.querySelector('#frame-run').onclick = () => {
          document.querySelector('#frame-result').textContent = 'Frame result for ' + document.querySelector('#frame-query').value;
        }</script>
      </main>`);
      return;
    }
    if (url.pathname === "/shadow") {
      response.end(`<!doctype html><main><search-panel></search-panel>
        <script>
          const host = document.querySelector('search-panel');
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<label>Search <input id="shadow-query"></label><button id="shadow-run">Run</button><output id="shadow-result">Ready</output>';
          root.querySelector('#shadow-run').onclick = () => {
            root.querySelector('#shadow-result').textContent = 'Shadow result for ' + root.querySelector('#shadow-query').value;
          };
        </script>
      </main>`);
      return;
    }
    if (url.pathname === "/fixed-status") {
      response.end(`<!doctype html><main><button id="check">Check status</button><output id="status">Ready</output>
        <script>document.querySelector('#check').onclick = () => setTimeout(() => {
          document.querySelector('#status').textContent = 'Service healthy';
        }, 25)</script></main>`);
      return;
    }
    if (url.pathname === "/dialog") {
      response.end(`<!doctype html><main><button id="confirm">Open confirmation</button><output id="result">Ready</output>
        <script>document.querySelector('#confirm').onclick = () => {
          document.querySelector('#result').textContent = confirm('Use the compiled path?') ? 'Accepted' : 'Dismissed';
        };</script></main>`);
      return;
    }
    if (url.pathname === "/download") {
      response.end(`<!doctype html><main><a id="download" href="/report.txt" download>Download report</a></main>`);
      return;
    }
    if (url.pathname === "/report.txt") {
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-disposition", 'attachment; filename="report.txt"');
      response.end("controlled artifact contents\n");
      return;
    }
    if (url.pathname === "/advanced-actions") {
      response.end(`<!doctype html><main>
        <select id="choice"><option value="one">One</option><option value="two">Two</option></select>
        <button id="double">Double click</button>
        <div id="drag-source" draggable="true">Source</div><div id="drag-target">Target</div>
        <div id="scroller" style="height:40px;overflow:auto"><div style="height:400px">Tall content</div></div>
        <output id="result">Ready</output>
        <script>
          document.querySelector('#choice').onchange = event => document.querySelector('#result').textContent = 'Selected ' + event.target.value;
          document.querySelector('#double').ondblclick = () => document.querySelector('#result').textContent = 'Double clicked';
          document.querySelector('#drag-target').ondragover = event => event.preventDefault();
          document.querySelector('#drag-target').ondrop = event => { event.preventDefault(); document.querySelector('#result').textContent = 'Dropped'; };
          document.querySelector('#scroller').onscroll = () => document.querySelector('#result').textContent = 'Scrolled';
        </script>
      </main>`);
      return;
    }
    if (url.pathname === "/upload-learning") {
      response.end(`<!doctype html><main><input id="file" type="file"><output id="result">Ready</output>
        <script>document.querySelector('#file').onchange = event => {
          document.querySelector('#result').textContent = 'Selected ' + event.target.files[0].name;
        };</script></main>`);
      return;
    }
    if (url.pathname === "/idempotent-select") {
      response.end(`<!doctype html><main><select id="sort"><option value="az" selected>A to Z</option><option value="za">Z to A</option></select>
        <output id="result">Inventory ready</output></main>`);
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
    assert.deepEqual(plan.validation.inputEvidenceNames, ["query"]);
    assert.throws(() => validateDomOutput(plan, {
      ...demonstrations[0]!.output,
      text: "Results unavailable",
      textHash: "different",
    }, { query: "lamp" }), /required evidence for input query/);

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

test("waits for an asynchronously mounted compiled iframe", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (query: string): DomWorkflowDemonstration => ({
      input: { query },
      actions: [
        {
          selector: "#frame-query",
          framePath: ["#app"],
          description: `Fill ${query}`,
          method: "fill",
          arguments: [query],
        },
        {
          selector: "#frame-run",
          framePath: ["#app"],
          description: "Run search",
          method: "click",
          arguments: [],
        },
      ],
      output: {
        selector: "#frame-result",
        framePath: ["#app"],
        tagName: "output",
        text: `Frame result for ${query}`,
        textHash: createHash("sha256").update(`Frame result for ${query}`).digest("hex"),
        url: `${origin}/async-frame`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("async_frame_search", `${origin}/async-frame`, [
      demonstration("sofa"),
      demonstration("chair"),
    ]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { query: "lamp" });
    assert.equal(result.text, "Frame result for lamp");
    assert.equal(result.modelCalls, 0);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("waits for asynchronous page scripts before executing compiled actions", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (): DomWorkflowDemonstration => ({
      input: {},
      actions: [{
        selector: "#async-run",
        description: "Run the asynchronous handler",
        method: "click",
        arguments: [],
      }],
      output: {
        selector: "#async-result",
        tagName: "output",
        text: "Async handler ready",
        textHash: createHash("sha256").update("Async handler ready").digest("hex"),
        url: `${origin}/async-handler`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("async_handler", `${origin}/async-handler`, [demonstration(), demonstration()]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, {});
    assert.equal(result.text, "Async handler ready");
    assert.equal(result.modelCalls, 0);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("compiles an input-bound same-origin start URL", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (id: string, note: string): DomWorkflowDemonstration => ({
      input: { id, note },
      startUrl: `${origin}/record?id=${encodeURIComponent(id)}`,
      actions: [
        { selector: "#note", description: `Enter ${note}`, method: "fill", arguments: [note] },
        { selector: "#preview", description: "Preview record", method: "click", arguments: [] },
      ],
      output: {
        selector: "#result",
        tagName: "output",
        text: `Record ${id}: ${note}`,
        textHash: createHash("sha256").update(`Record ${id}: ${note}`).digest("hex"),
        url: `${origin}/record?id=${encodeURIComponent(id)}`,
      },
      modelCalls: 1,
    });
    const demonstrations = [demonstration("record one", "first note"), demonstration("record two", "second note")];
    const plan = compileDomWorkflow("preview_record", demonstrations[0]!.startUrl!, demonstrations);
    assert.ok(plan.startPathTemplate?.some((part) => typeof part !== "string" && part.$clappingHandsInput === "id"));
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { id: "record/three", note: "unseen note" });
    assert.equal(result.text, "Record record/three: unseen note");
    assert.equal(page.url(), `${origin}/record?id=record%2Fthree`);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("waits for asynchronous page scripts before demonstrating actions", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const demonstration = await demonstrateDomWorkflow({
      act: async () => {
        await page.locator("#async-run").click();
        return {
          success: true,
          message: "clicked the asynchronously initialized control",
          actions: [{
            selector: "#async-run",
            description: "Run the asynchronous handler",
            method: "click",
            arguments: [],
          }],
          modelCalls: 1,
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    }, page, `${origin}/async-handler`, {}, ["Run the asynchronous handler"], "#async-result");
    assert.equal(demonstration.output.text, "Async handler ready");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("waits for bounded post-load hydration before executing compiled actions", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (): DomWorkflowDemonstration => ({
      input: {},
      actions: [{
        selector: "#hydrated-run",
        description: "Run the hydrated handler",
        method: "click",
        arguments: [],
      }],
      output: {
        selector: "#hydrated-result",
        tagName: "output",
        text: "Hydrated handler ready",
        textHash: createHash("sha256").update("Hydrated handler ready").digest("hex"),
        url: `${origin}/post-load-hydration`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("post_load_hydration", `${origin}/post-load-hydration`, [
      demonstration(),
      demonstration(),
    ]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, {});
    assert.equal(result.text, "Hydrated handler ready");
    assert.equal(result.modelCalls, 0);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("executes a DOM-ready app whose global load event never completes", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (): DomWorkflowDemonstration => ({
      input: {},
      actions: [{
        selector: "#dom-ready-run",
        description: "Run the usable app",
        method: "click",
        arguments: [],
      }],
      output: {
        selector: "#dom-ready-result",
        tagName: "output",
        text: "Usable before global load",
        textHash: createHash("sha256").update("Usable before global load").digest("hex"),
        url: `${origin}/dom-ready-never-load`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("dom_ready_never_load", `${origin}/dom-ready-never-load`, [
      demonstration(),
      demonstration(),
    ]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const startedAt = performance.now();
    const result = await replayDomWorkflow(page, plan, {});
    assert.equal(result.text, "Usable before global load");
    assert.equal(result.modelCalls, 0);
    assert.ok(performance.now() - startedAt < 10_000);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("preserves focus-sensitive action chains and observes rich-editor source synchronization", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (body: string): DomWorkflowDemonstration => ({
      input: { body },
      actions: [
        { selector: "#editor", description: "Focus editor", method: "click", arguments: [] },
        { selector: "#editor", description: `Type ${body}`, method: "type", arguments: [body] },
        { selector: "#editor", description: "Finish editing", method: "press", arguments: ["Tab"] },
        { selector: "#preview", description: "Render preview", method: "click", arguments: [] },
      ],
      output: {
        selector: "#rich-result",
        tagName: "output",
        text: `Submitted ${body}`,
        textHash: createHash("sha256").update(`Submitted ${body}`).digest("hex"),
        url: `${origin}/rich-editor`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("rich_editor_preview", `${origin}/rich-editor`, [
      demonstration("first body"),
      demonstration("second body"),
    ]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { body: "unseen body" });
    assert.equal(result.text, "Submitted unseen body");
    assert.equal(result.modelCalls, 0);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("explicitly blurs a compiled rich editor and waits for its form source", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (body: string): DomWorkflowDemonstration => ({
      input: { body },
      actions: [
        { selector: "#editor", description: "Focus editor", method: "click", arguments: [] },
        { selector: "#editor", description: `Type ${body}`, method: "type", arguments: [body] },
        { selector: "#editor", description: "Blur editor", method: "blur", arguments: [] },
        { selector: "#preview", description: "Render preview", method: "click", arguments: [] },
      ],
      output: {
        selector: "#rich-result",
        tagName: "output",
        text: `Submitted ${body}`,
        textHash: createHash("sha256").update(`Submitted ${body}`).digest("hex"),
        url: `${origin}/rich-editor`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("rich_editor_blur", `${origin}/rich-editor`, [
      demonstration("first body"),
      demonstration("second body"),
    ]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { body: "blurred body" });
    assert.equal(result.text, "Submitted blurred body");
    assert.equal(result.modelCalls, 0);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("atomically recovers a type action when an editor suppresses every key event", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demonstration = (body: string): DomWorkflowDemonstration => ({
      input: { body },
      actions: [
        { selector: "#editor", description: `Type ${body}`, method: "type", arguments: [body] },
        { selector: "#preview", description: "Render preview", method: "click", arguments: [] },
      ],
      output: {
        selector: "#rich-result",
        tagName: "output",
        text: `Submitted ${body}`,
        textHash: createHash("sha256").update(`Submitted ${body}`).digest("hex"),
        url: `${origin}/intercepted-rich-editor`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("intercepted_rich_editor", `${origin}/intercepted-rich-editor`, [
      demonstration("first body"),
      demonstration("second body"),
    ]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { body: "recovered body" });
    assert.equal(result.text, "Submitted recovered body");
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

test("persists and replays a same-origin new-page transition", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const demonstrate = (query: string) => demonstrateDomWorkflow({
      act: async (instruction) => {
        const value = String(instruction).match(/^Open (.+)$/)?.[1] ?? "";
        await page.locator("#query").fill(value);
        await page.locator("#open").click();
        return {
          success: true,
          message: "opened",
          actions: [
            { selector: "#query", description: `Fill ${value}`, method: "fill", arguments: [value] },
            { selector: "#open", description: "Open result", method: "click", arguments: [] },
          ],
          modelCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    }, page, `${origin}/popup`, { query }, [`Open ${query}`], "#popup-result");
    const plan = compileDomWorkflow("popup_search", `${origin}/popup`, [
      await demonstrate("sofa"),
      await demonstrate("chair"),
    ]);
    assert.equal(plan.actions[1]!.opensNewPage, true);
    const result = await replayDomWorkflow(page, plan, { query: "lamp" });
    assert.equal(result.text, "Result for lamp");
    assert.equal(new URL(result.url).pathname, "/popup-result");
    assert.equal(result.navigations, 2);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("discovers and replays actions and output inside a same-origin iframe", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const demonstrate = (query: string) => demonstrateDomWorkflow({
      act: async (instruction) => {
        const value = String(instruction).match(/^Search for (.+)$/)?.[1] ?? "";
        const frame = page.frameLocator("#app");
        await frame.locator("#frame-query").fill(value);
        await frame.locator("#frame-run").click();
        return {
          success: true,
          message: "done",
          actions: [
            { selector: "#frame-query", description: `Fill ${value}`, method: "fill", arguments: [value] },
            { selector: "#frame-run", description: "Run", method: "click", arguments: [] },
          ],
          modelCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    }, page, `${origin}/frame`, { query }, [`Search for ${query}`], "#frame-result");
    const demonstrations = [await demonstrate("sofa"), await demonstrate("chair")];
    assert.deepEqual(demonstrations[0]!.actions[0]!.framePath, ['iframe[id="app"]']);
    assert.deepEqual(demonstrations[0]!.output.framePath, ['iframe[id="app"]']);
    const plan = compileDomWorkflow("frame_search", `${origin}/frame`, demonstrations);
    assert.equal(plan.actions[0]!.framePath?.length, 1);
    const result = await replayDomWorkflow(page, plan, { query: "lamp" });
    assert.equal(result.text, "Frame result for lamp");
    assert.deepEqual(result.framePath, ['iframe[id="app"]']);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("discovers and replays controls inside an open shadow root", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const demonstrate = (query: string) => demonstrateDomWorkflow({
      act: async (instruction) => {
        const value = String(instruction).match(/^Search shadow for (.+)$/)?.[1] ?? "";
        await page.locator("#shadow-query").fill(value);
        await page.locator("#shadow-run").click();
        return {
          success: true,
          message: "done",
          actions: [
            { selector: "#shadow-query", description: `Fill ${value}`, method: "fill", arguments: [value] },
            { selector: "#shadow-run", description: "Run", method: "click", arguments: [] },
          ],
          modelCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    }, page, `${origin}/shadow`, { query }, [`Search shadow for ${query}`], "#shadow-result");
    const plan = compileDomWorkflow("shadow_search", `${origin}/shadow`, [
      await demonstrate("sofa"),
      await demonstrate("chair"),
    ]);
    const result = await replayDomWorkflow(page, plan, { query: "lamp" });
    assert.equal(result.text, "Shadow result for lamp");
    assert.equal(result.modelCalls, 0);
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
  const postcodeDemo = (postcode: string): DomWorkflowDemonstration => ({
    input: { postcode },
    actions: [
      { selector: "#postcode", description: "Fill post code", method: "fill", arguments: [postcode] },
      { selector: "#search", description: "Search", method: "click" },
    ],
    output: { ...output, text: `Schools near ${postcode}`, textHash: `hash-${postcode}` },
    modelCalls: 1,
    instructions: [`Enter post code ${postcode} and search`],
  });
  assert.doesNotThrow(() => compileDomWorkflow(
    "search_by_postcode",
    "https://example.test",
    [postcodeDemo("SW1A 1AA"), postcodeDemo("M1 1AE")],
  ));

  for (const [name, instruction, description] of [
    ["submit_application", "Submit the application", "Submit application"],
    ["invite_user", "Invite a user", "Invite user"],
    ["update_profile", "Update my profile", "Save"],
    ["cancel_booking", "Cancel the booking", "Confirm cancellation"],
    ["make_offer", "Make an offer", "Send offer"],
  ] as const) {
    const mutationDemo = (value: string): DomWorkflowDemonstration => ({
      input: { value },
      actions: [
        { selector: "#value", description: "Fill value", method: "fill", arguments: [value] },
        { selector: "#submit", description, method: "click", arguments: [] },
      ],
      output: { ...output, text: `Done ${value}`, textHash: `hash-${value}` },
      modelCalls: 1,
      instructions: [`${instruction} ${value}`],
    });
    assert.throws(
      () => compileDomWorkflow(name, "https://example.test", [mutationDemo("one"), mutationDemo("two")]),
      /appears effectful/,
    );
  }

  for (const [name, instruction, description] of [
    ["apply_filters", "Apply filters", "Apply"],
    ["remove_filter", "Remove the color filter", "Remove filter"],
    ["change_sort", "Change sort order", "Sort"],
  ] as const) {
    const readDemo = (value: string): DomWorkflowDemonstration => ({
      input: { value },
      actions: [
        { selector: "#value", description: "Fill value", method: "fill", arguments: [value] },
        { selector: "#submit", description, method: "click", arguments: [] },
      ],
      output: { ...output, text: `Results ${value}`, textHash: `hash-${value}` },
      modelCalls: 1,
      instructions: [`${instruction} ${value}`],
    });
    assert.doesNotThrow(
      () => compileDomWorkflow(name, "https://example.test", [readDemo("one"), readDemo("two")]),
    );
  }
});

test("file selection is write-only and establishes the earliest effect boundary", () => {
  const uploadDemo = (file: string): DomWorkflowDemonstration => ({
    input: { file },
    actions: [
      { selector: "#file", description: "Choose file", method: "setInputFiles", arguments: [file] },
      { selector: "#finish", description: "Finish", method: "click", arguments: [] },
    ],
    output: {
      selector: "#result",
      tagName: "output",
      text: `Uploaded ${file}`,
      textHash: `hash-${file}`,
      url: "https://example.com/upload",
    },
    modelCalls: 1,
  });
  const demonstrations = [uploadDemo("first.txt"), uploadDemo("second.txt")];
  assert.throws(
    () => compileDomWorkflow("upload", "https://example.com/upload", demonstrations),
    /appears effectful/,
  );
  const plan = compileDomWorkflow("upload", "https://example.com/upload", demonstrations, {
    effect: "write",
    confirmation: "Upload the selected file",
  });
  assert.equal(plan.effect.commitActionIndex, 0);
  assert.doesNotMatch(JSON.stringify(plan), /first\.txt|second\.txt/);
});

test("a write conservatively starts its commit suffix at the first non-passive interaction", () => {
  const demo = (product: string): DomWorkflowDemonstration => ({
    input: { product },
    actions: [
      { selector: "#query", description: "Fill product", method: "fill", arguments: [product] },
      { selector: "#add", description: "Add to cart", method: "click", arguments: [] },
      { selector: "#view", description: "View cart", method: "click", arguments: [] },
    ],
    output: {
      selector: "#cart",
      tagName: "output",
      text: `Cart contains ${product}`,
      textHash: `hash-${product}`,
      url: "https://example.com/shop",
    },
    modelCalls: 1,
  });
  const plan = compileDomWorkflow("add-product", "https://example.com/shop", [demo("lamp"), demo("desk")], {
    effect: "write",
    confirmation: "Add this product to the cart",
  });
  assert.equal(plan.effect.commitActionIndex, 0);
});

test("demonstration records an explicitly handled browser confirmation", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const demonstration = await demonstrateDomWorkflow({
      act: async () => {
        await page.locator("#confirm").click();
        return {
          success: true,
          message: "confirmed",
          actions: [{ selector: "#confirm", description: "Open confirmation", method: "click", arguments: [] }],
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 2,
        };
      },
    }, page, `${origin}/dialog`, {}, ["Open the confirmation and accept the dialog"], "#result");
    assert.deepEqual(demonstration.actions[0]!.dialog, {
      action: "accept",
      type: "confirm",
      message: "Use the compiled path?",
    });
    assert.equal(demonstration.output.text, "Accepted");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("learns a download and returns a size-bounded hashed artifact", async () => {
  const { server, origin } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-download-"));
  const previousArtifactRoot = process.env.CLAPPING_HANDS_ARTIFACT_ROOT;
  let browser: Browser | null = null;
  try {
    process.env.CLAPPING_HANDS_ARTIFACT_ROOT = directory;
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    let page = await browser.newPage({ acceptDownloads: true });
    const demonstrate = () => demonstrateDomWorkflow({
      act: async () => {
        await page.locator("#download").click();
        return {
          success: true,
          message: "downloaded",
          actions: [{ selector: "#download", description: "Download report", method: "click", arguments: [] }],
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 2,
        };
      },
    }, page, `${origin}/download`, {}, ["Download the report"], "#download");
    const plan = compileDomWorkflow("download_report", `${origin}/download`, [await demonstrate(), await demonstrate()]);
    assert.deepEqual(plan.actions[0]!.download, { suggestedFilename: ["report.txt"] });
    await page.close();
    page = await browser.newPage({ acceptDownloads: true });
    const result = await replayDomWorkflow(page, plan, {});
    assert.equal(result.text, "Download report");
    assert.equal(result.downloads?.length, 1);
    const artifact = result.downloads![0]!;
    assert.equal(artifact.suggestedFilename, "report.txt");
    assert.equal(await readFile(artifact.path, "utf8"), "controlled artifact contents\n");
    assert.equal(artifact.sha256, createHash("sha256").update("controlled artifact contents\n").digest("hex"));
    const canonicalDirectory = await realpath(directory);
    assert.ok(!relative(canonicalDirectory, artifact.path).startsWith(".."));

    const changed = structuredClone(plan);
    changed.actions[0]!.download!.suggestedFilename = ["changed.txt"];
    await assert.rejects(() => replayDomWorkflow(page, changed, {}), /unexpected or changed download/);
    await page.close();
  } finally {
    if (previousArtifactRoot === undefined) delete process.env.CLAPPING_HANDS_ARTIFACT_ROOT;
    else process.env.CLAPPING_HANDS_ARTIFACT_ROOT = previousArtifactRoot;
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("executes the Stagehand v4 action vocabulary without another model call", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await page.goto(`${origin}/advanced-actions`);

    await executeCompiledDomAction(page, {
      selector: "#choice",
      description: "Select two",
      method: "selectOptionFromDropdown",
      arguments: ["two"],
    });
    assert.equal(await page.locator("#result").innerText(), "Selected two");

    await executeCompiledDomAction(page, {
      selector: "#double",
      description: "Double click",
      method: "doubleClick",
      arguments: [],
    });
    assert.equal(await page.locator("#result").innerText(), "Double clicked");

    await executeCompiledDomAction(page, {
      selector: "#drag-source",
      description: "Drag source to target",
      method: "dragAndDrop",
      arguments: ["#drag-target"],
    });
    assert.equal(await page.locator("#result").innerText(), "Dropped");

    await executeCompiledDomAction(page, {
      selector: "#scroller",
      description: "Scroll to bottom",
      method: "scrollTo",
      arguments: ["100%"],
    });
    await page.locator("#result").filter({ hasText: "Scrolled" }).waitFor();
    assert.equal(await page.locator("#result").innerText(), "Scrolled");
    assert.ok(await page.locator("#scroller").evaluate((element) => element.scrollTop > 0));
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("learns a single allowlisted file input without asking Stagehand for an unsupported method", async () => {
  const { server, origin } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-guided-upload-"));
  const uploadRoot = resolve(directory, "uploads");
  const first = resolve(uploadRoot, "first.txt");
  const second = resolve(uploadRoot, "second.txt");
  const previousUploadRoot = process.env.CLAPPING_HANDS_UPLOAD_ROOT;
  let browser: Browser | null = null;
  try {
    await mkdir(uploadRoot);
    await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
    process.env.CLAPPING_HANDS_UPLOAD_ROOT = uploadRoot;
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const demonstrate = (file: string) => demonstrateDomWorkflow({
      act: async () => { throw new Error("Stagehand should not be asked to synthesize file selection."); },
    }, page, `${origin}/upload-learning`, { file }, [`Choose the upload file ${file}`], "#result");
    const demonstrations = [await demonstrate(first), await demonstrate(second)];
    assert.equal(demonstrations[0]!.modelCalls, 0);
    assert.equal(demonstrations[0]!.actions[0]!.method, "setInputFiles");
    const plan = compileDomWorkflow("guided_upload", `${origin}/upload-learning`, demonstrations, {
      effect: "write",
      confirmation: "Select this controlled fixture file",
    });
    assert.equal(plan.effect.commitActionIndex, 0);
    assert.doesNotMatch(JSON.stringify(plan), /first\.txt|second\.txt/);
    await page.close();
  } finally {
    if (previousUploadRoot === undefined) delete process.env.CLAPPING_HANDS_UPLOAD_ROOT;
    else process.env.CLAPPING_HANDS_UPLOAD_ROOT = previousUploadRoot;
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts a fresh result when a state-setting action is already satisfied", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demo = (sort: string): DomWorkflowDemonstration => ({
      input: { sort },
      actions: [{
        selector: "#sort",
        description: `Sort ${sort}`,
        method: "selectOptionFromDropdown",
        arguments: [sort],
      }],
      output: {
        selector: "#result",
        tagName: "output",
        text: "Inventory ready",
        textHash: createHash("sha256").update("Inventory ready").digest("hex"),
        url: `${origin}/idempotent-select`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("default_sort", `${origin}/idempotent-select`, [demo("az"), demo("za")]);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, { sort: "az" });
    assert.equal(result.text, "Inventory ready");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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

test("compiles and promotes a zero-argument workflow after independent shadows", async () => {
  const { server, origin } = await fixture();
  let browser: Browser | null = null;
  try {
    const demo = (): DomWorkflowDemonstration => ({
      input: {},
      actions: [{ selector: "#check", description: "Check status", method: "click", arguments: [] }],
      output: {
        selector: "#status",
        tagName: "output",
        text: "Service healthy",
        textHash: createHash("sha256").update("Service healthy").digest("hex"),
        url: `${origin}/fixed-status`,
      },
      modelCalls: 1,
    });
    const plan = compileDomWorkflow("check_status", `${origin}/fixed-status`, [demo(), demo()]);
    assert.deepEqual(plan.inputNames, []);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const result = await replayDomWorkflow(page, plan, {});
    assert.equal(result.text, "Service healthy");
    let stable = recordDomShadow(plan, {}, true);
    stable = recordDomShadow(stable, {}, true);
    assert.equal(stable.evidence.successfulShadowInputHashes.length, 1);
    assert.equal(stable.evidence.successfulShadowCount, 2);
    assert.equal(stable.status, "stable");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
