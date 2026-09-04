import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import { compileDomWorkflow, replayDomWorkflow, type DomWorkflowDemonstration } from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function fixture(): Promise<{ server: Server; origin: string; commits: () => number }> {
  let commitCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/commit" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      commitCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ commitCount }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main>
      <label>Note <input id="note"></label><button id="commit">Publish</button><output id="result">Ready</output>
      <script>document.querySelector('#commit').onclick = async () => {
        const response = await fetch('/commit', { method: 'POST', body: document.querySelector('#note').value });
        const value = await response.json();
        document.querySelector('#result').textContent = 'Published ' + value.commitCount;
      }</script>
    </main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Effect fixture did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}`, commits: () => commitCount };
}

function demonstration(origin: string, note: string): DomWorkflowDemonstration {
  return {
    input: { note },
    actions: [
      { selector: "#note", description: `Fill ${note}`, method: "fill", arguments: [note] },
      { selector: "#commit", description: "Publish", method: "click", arguments: [] },
    ],
    output: {
      selector: "#result",
      tagName: "output",
      text: `Published ${note}`,
      textHash: `dynamic-${note}`,
      url: `${origin}/`,
    },
    modelCalls: 1,
  };
}

test("write workflows require a durable prepare/commit receipt and commit at most once", async () => {
  const { server, origin, commits } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-effects-"));
  const journalPath = resolve(directory, "journal.json");
  let browser: Browser | null = null;
  try {
    const plan = compileDomWorkflow("publish-note", origin, [
      demonstration(origin, "first"),
      demonstration(origin, "second"),
    ], { effect: "write", confirmation: "Publish this note to the site" });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const journal = new EffectJournal(journalPath);
    const input = { note: "final payload" };

    await assert.rejects(() => replayDomWorkflow(page, plan, input), /prepareDomWorkflowWrite/);
    const receipt = await prepareDomWorkflowWrite(page, journal, plan, input);
    assert.equal(receipt.status, "prepared");
    assert.equal(receipt.confirmation, "Publish this note to the site");
    assert.equal(commits(), 0);
    assert.doesNotMatch(await readFile(journalPath, "utf8"), /final payload/);

    const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input);
    assert.equal(committed.receipt.status, "committed");
    assert.equal(committed.result.text, "Published 1");
    assert.equal(commits(), 1);
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input),
      /will not be repeated/,
    );
    assert.equal(commits(), 1);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a post-click validation failure becomes uncertain and is never retried", async () => {
  const { server, origin, commits } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-effects-uncertain-"));
  let browser: Browser | null = null;
  try {
    const plan = compileDomWorkflow("publish-note", origin, [
      demonstration(origin, "first"),
      demonstration(origin, "second"),
    ], { effect: "write", confirmation: "Publish this note to the site" });
    plan.validation.outputSelector = "#missing-after-commit";
    plan.validation.outputChangeTimeoutMs = 100;
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const journal = new EffectJournal(resolve(directory, "journal.json"));
    const input = { note: "only once" };
    const receipt = await prepareDomWorkflowWrite(page, journal, plan, input);
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input),
      /did not change after the final action/,
    );
    assert.equal(commits(), 1);
    assert.equal((await journal.get(receipt.id))?.status, "uncertain");
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input),
      /will not be repeated/,
    );
    assert.equal(commits(), 1);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
