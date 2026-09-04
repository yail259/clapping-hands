import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fixture(): Promise<{ server: Server; origin: string; commits: () => number; drafts: () => number }> {
  let commitCount = 0;
  let draftCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/commit" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      commitCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ commitCount }));
      return;
    }
    if (url.pathname === "/draft" && request.method === "POST") {
      for await (const _chunk of request) { /* consume request */ }
      draftCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ draftCount }));
      return;
    }
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/framed") {
      response.end(`<!doctype html><main><iframe id="editor" src="/framed-body"></iframe></main>`);
      return;
    }
    if (url.pathname === "/upload") {
      response.end(`<!doctype html><main>
        <label>Attachment <input id="attachment" type="file"></label><button id="finish">Finish upload</button>
        <output id="result">Ready</output>
        <script>
          let pendingUpload = Promise.resolve();
          let uploaded = 0;
          document.querySelector('#attachment').onchange = () => {
            pendingUpload = fetch('/commit', { method: 'POST', body: 'file-selected' })
              .then(response => response.json()).then(value => { uploaded = value.commitCount; });
          };
          document.querySelector('#finish').onclick = async () => {
            await pendingUpload;
            document.querySelector('#result').textContent = 'Uploaded ' + uploaded;
          };
        </script>
      </main>`);
      return;
    }
    if (url.pathname === "/dialog") {
      response.end(`<!doctype html><main>
        <button id="confirm">Commit test record</button><output id="result">Ready</output>
        <script>document.querySelector('#confirm').onclick = async () => {
          if (!confirm('Commit the test record?')) {
            document.querySelector('#result').textContent = 'Cancelled';
            return;
          }
          const response = await fetch('/commit', { method: 'POST', body: 'confirmed' });
          const value = await response.json();
          document.querySelector('#result').textContent = 'Committed ' + value.commitCount;
        };</script>
      </main>`);
      return;
    }
    if (url.pathname === "/autosave") {
      response.end(`<!doctype html><main>
        <label>Title <input id="title"></label><button id="commit">Publish</button><output id="result">Ready</output>
        <script>
          document.querySelector('#title').oninput = () => fetch('/draft', { method: 'POST', body: 'draft' });
          document.querySelector('#commit').onclick = async () => {
            const response = await fetch('/commit', { method: 'POST', body: document.querySelector('#title').value });
            const value = await response.json();
            document.querySelector('#result').textContent = 'Published ' + value.commitCount;
          };
        </script>
      </main>`);
      return;
    }
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
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    commits: () => commitCount,
    drafts: () => draftCount,
  };
}

function uploadDemonstration(origin: string, file: string, ordinal: number): DomWorkflowDemonstration {
  return {
    input: { file },
    actions: [
      { selector: "#attachment", description: "Choose upload file", method: "setInputFiles", arguments: [file] },
      { selector: "#finish", description: "Finish upload", method: "click", arguments: [] },
    ],
    output: {
      selector: "#result",
      tagName: "output",
      text: `Uploaded ${ordinal}`,
      textHash: `dynamic-${ordinal}`,
      url: `${origin}/upload`,
    },
    modelCalls: 1,
  };
}

function dialogDemonstration(origin: string, message: string, ordinal: number): DomWorkflowDemonstration {
  return {
    input: {},
    actions: [{
      selector: "#confirm",
      description: "Commit test record",
      method: "click",
      arguments: [],
      dialog: { action: "accept", type: "confirm", message },
    }],
    output: {
      selector: "#result",
      tagName: "output",
      text: `Committed ${ordinal}`,
      textHash: `dialog-${ordinal}`,
      url: `${origin}/dialog`,
    },
    modelCalls: 1,
  };
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

function autosaveDemonstration(origin: string, title: string): DomWorkflowDemonstration {
  return {
    input: { title },
    actions: [
      { selector: "#title", description: `Fill ${title}`, method: "fill", arguments: [title] },
      { selector: "#commit", description: "Publish", method: "click", arguments: [] },
    ],
    output: {
      selector: "#result",
      tagName: "output",
      text: `Published ${title}`,
      textHash: `autosave-${title}`,
      url: `${origin}/autosave`,
    },
    modelCalls: 1,
  };
}

test("prepare performs no browser actions and hidden autosaves stay inside the one-shot commit", async () => {
  const { server, origin, commits, drafts } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-effects-autosave-"));
  let browser: Browser | null = null;
  try {
    const plan = compileDomWorkflow("publish-autosaved-topic", `${origin}/autosave`, [
      autosaveDemonstration(origin, "first"),
      autosaveDemonstration(origin, "second"),
    ], { effect: "write", confirmation: "Publish this autosaved synthetic topic" });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const journal = new EffectJournal(resolve(directory, "journal.json"));
    const input = { title: "final title" };

    const receipt = await prepareDomWorkflowWrite(page, journal, plan, input);
    assert.equal(receipt.status, "prepared");
    assert.equal(receipt.preparedUrl, `${origin}/autosave`);
    assert.equal(page.url(), "about:blank");
    assert.equal(drafts(), 0);
    assert.equal(commits(), 0);

    const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input);
    assert.equal(committed.receipt.status, "committed");
    assert.equal(drafts(), 1);
    assert.equal(commits(), 1);
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input),
      /will not be repeated/,
    );
    assert.equal(drafts(), 1);
    assert.equal(commits(), 1);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("prepared writes execute inside a same-origin iframe", async () => {
  const { server, origin, commits } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-effects-frame-"));
  let browser: Browser | null = null;
  try {
    const framedDemo = (note: string): DomWorkflowDemonstration => ({
      ...demonstration(origin, note),
      actions: demonstration(origin, note).actions.map((action) => ({ ...action, framePath: ["#editor"] })),
      output: {
        ...demonstration(origin, note).output,
        url: `${origin}/framed`,
        framePath: ["#editor"],
      },
    });
    const plan = compileDomWorkflow("publish_framed_note", `${origin}/framed`, [
      framedDemo("first"),
      framedDemo("second"),
    ], { effect: "write", confirmation: "Publish this framed test note" });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const journal = new EffectJournal(resolve(directory, "journal.json"));
    const input = { note: "framed payload" };
    const receipt = await prepareDomWorkflowWrite(page, journal, plan, input);
    assert.equal(commits(), 0);
    const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, input);
    assert.equal(committed.result.text, "Published 1");
    assert.deepEqual(committed.result.framePath, ["#editor"]);
    assert.equal(commits(), 1);
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("file selection starts the one-shot commit suffix and only reads allowlisted unchanged files", async () => {
  const { server, origin, commits } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-effects-upload-"));
  const uploadRoot = resolve(directory, "uploads");
  const firstFile = resolve(uploadRoot, "first.txt");
  const secondFile = resolve(uploadRoot, "second.txt");
  const finalFile = resolve(uploadRoot, "final.txt");
  const outsideFile = resolve(directory, "outside.txt");
  const previousUploadRoot = process.env.CLAPPING_HANDS_UPLOAD_ROOT;
  let browser: Browser | null = null;
  try {
    await mkdir(uploadRoot);
    await Promise.all([
      writeFile(firstFile, "first fixture"),
      writeFile(secondFile, "second fixture"),
      writeFile(finalFile, "approved contents"),
      writeFile(outsideFile, "outside contents"),
    ]);
    process.env.CLAPPING_HANDS_UPLOAD_ROOT = uploadRoot;
    const plan = compileDomWorkflow("upload-attachment", `${origin}/upload`, [
      uploadDemonstration(origin, firstFile, 1),
      uploadDemonstration(origin, secondFile, 2),
    ], { effect: "write", confirmation: "Upload this attachment to the site" });
    assert.equal(plan.effect.commitActionIndex, 0);

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const journalPath = resolve(directory, "journal.json");
    const journal = new EffectJournal(journalPath);

    await assert.rejects(
      () => prepareDomWorkflowWrite(page, journal, plan, { file: outsideFile }),
      /outside the allowed upload root/,
    );
    assert.equal(commits(), 0);

    const receipt = await prepareDomWorkflowWrite(page, journal, plan, { file: finalFile });
    assert.equal(receipt.finalAction.method, "setInputFiles");
    assert.ok(receipt.effectPayloadHash);
    assert.equal(commits(), 0);
    assert.doesNotMatch(await readFile(journalPath, "utf8"), /final\.txt|approved contents/);

    await writeFile(finalFile, "changed after prepare");
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, { file: finalFile }),
      /upload contents changed/,
    );
    assert.equal((await journal.get(receipt.id))?.status, "prepared");
    assert.equal(commits(), 0);

    await writeFile(finalFile, "approved contents");
    const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, { file: finalFile });
    assert.equal(committed.result.text, "Uploaded 1");
    assert.equal(committed.receipt.status, "committed");
    assert.equal(commits(), 1);
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, { file: finalFile }),
      /will not be repeated/,
    );
    assert.equal(commits(), 1);
    await page.close();
  } finally {
    if (previousUploadRoot === undefined) delete process.env.CLAPPING_HANDS_UPLOAD_ROOT;
    else process.env.CLAPPING_HANDS_UPLOAD_ROOT = previousUploadRoot;
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a declared confirm dialog commits once while changed dialog text fails closed", async () => {
  const { server, origin, commits } = await fixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-effects-dialog-"));
  let browser: Browser | null = null;
  try {
    const plan = compileDomWorkflow("confirm-test-record", `${origin}/dialog`, [
      dialogDemonstration(origin, "Commit the test record?", 1),
      dialogDemonstration(origin, "Commit the test record?", 2),
    ], { effect: "write", confirmation: "Commit the synthetic test record" });
    assert.equal(plan.effect.commitActionIndex, 0);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const journal = new EffectJournal(resolve(directory, "journal.json"));
    const receipt = await prepareDomWorkflowWrite(page, journal, plan, {});
    assert.equal(commits(), 0);
    const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, {});
    assert.equal(committed.result.text, "Committed 1");
    assert.equal(commits(), 1);

    const changedDialogPlan = compileDomWorkflow("changed-confirm", `${origin}/dialog`, [
      dialogDemonstration(origin, "A different prompt", 1),
      dialogDemonstration(origin, "A different prompt", 2),
    ], { effect: "write", confirmation: "Commit the synthetic test record" });
    const changedReceipt = await prepareDomWorkflowWrite(page, journal, changedDialogPlan, {});
    await assert.rejects(
      () => commitPreparedDomWorkflowWrite(page, journal, changedReceipt.id, changedDialogPlan, {}),
      /unexpected or changed browser dialog/,
    );
    assert.equal(commits(), 1);
    assert.equal((await journal.get(changedReceipt.id))?.status, "uncertain");
    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
