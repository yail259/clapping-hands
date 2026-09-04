import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import {
  compileFormWorkflow,
  demonstrateFormWorkflow,
  FormWorkflowPlanStore,
  extractMainResult,
  inspectFormPage,
  inspectFormCandidates,
  recordFormShadow,
  replayFormWorkflow,
  replayFormWorkflowInBrowser,
  type FormWorkflowAnswers,
} from "../src/form-workflow.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function page(body: string): string {
  return `<!doctype html><html><body><main>${body}</main></body></html>`;
}

async function fixture(): Promise<{
  server: Server;
  origin: string;
  activateLoginShell: () => void;
  activateRedirect: (target: string) => void;
}> {
  let loginShell = false;
  let redirectTarget: string | null = null;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/generic") {
      response.end(page(`<form id="site-search" action="/noop"><input name="q"><button>Search</button></form>
        <h1>Profile</h1><form id="profile-form" action="/generic/result" method="post">
        <input type="hidden" name="csrf" value="fresh-fixture-value">
        <input required name="display"><input name="nickname" value="default nick">
        <label><input type="checkbox" name="newsletter" value="yes" checked> Newsletter</label>
        <select name="locale"><option value="en" selected>English</option><option value="fr">French</option></select>
        <button type="submit" name="intent" value="save">Save</button></form>`));
      return;
    }
    if (url.pathname === "/generic/result" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      response.end(page(`<h1>Profile saved</h1><p>${["display", "nickname", "newsletter", "locale", "intent"]
        .map((name) => `${name}=${fields.get(name)}`).join("|")}</p>`));
      return;
    }
    if (url.pathname === "/spa") {
      response.end(page(`<h1>SPA form</h1><form id="spa-form"><input name="message" required><button>Finish</button></form>
        <script>document.querySelector('#spa-form').addEventListener('submit', event => {
          event.preventDefault(); const value = new FormData(event.currentTarget).get('message');
          document.querySelector('main').innerHTML = '<h1>Complete</h1><p>Received ' + value + '</p>';
        });</script>`));
      return;
    }
    if (url.pathname === "/post") {
      response.end(page(`<h1>Topics</h1><form data-question-key="topics" action="/post/result" method="post">
        <input type="hidden" name="csrf" value="rotating-fixture-secret">
        <label><input required type="checkbox" name="topic" value="a"> A</label>
        <label><input required type="checkbox" name="topic" value="b"> B</label>
        <button type="submit">Continue</button></form>`));
      return;
    }
    if (url.pathname === "/post/result" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const topics = fields.getAll("topic");
      response.end(page(topics.length === 2
        ? `<h1>Saved</h1><p>Received ${topics.join(" and ")}</p>`
        : `<h1>Invalid</h1><p>Expected two topics, received ${topics.length}</p>`));
      return;
    }
    if (url.pathname === "/wizard") {
      response.end(page(`<h1>Choose calculation</h1><form data-question-key="which" action="/wizard/date" method="get">
        <label><input required type="radio" name="response" value="age"> Age</label>
        <label><input required type="radio" name="response" value="pass"> Pass</label>
        <button type="submit">Continue</button></form>`));
      return;
    }
    if (url.pathname === "/wizard/date" && url.searchParams.get("response") === "age") {
      response.end(page(`<h1>Date of birth</h1><form data-question-key="dob" action="/wizard/result" method="get">
        <input name="response[day]" required><input name="response[month]" required><input name="response[year]" required>
        <button type="submit">Continue</button></form>`));
      return;
    }
    if (url.pathname === "/wizard/result") {
      if (redirectTarget) {
        response.statusCode = 302;
        response.setHeader("location", redirectTarget);
        response.end();
        return;
      }
      if (loginShell) {
        response.end(page("<h1>Sign in</h1><p>Your session has expired.</p>"));
        return;
      }
      const values = ["day", "month", "year"].map((key) => url.searchParams.get(`response[${key}]`));
      response.end(page(`<h1>Result</h1><p>Calculated for ${values.join("/")}</p>`));
      return;
    }
    response.statusCode = 404;
    response.end(page("<h1>Not found</h1>"));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind.");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    activateLoginShell: () => { loginShell = true; },
    activateRedirect: (target) => { redirectTarget = target; },
  };
}

const answers: FormWorkflowAnswers = {
  which: { response: "age" },
  dob: { "response[day]": "1", "response[month]": "1", "response[year]": "1960" },
};

test("inspects a same-origin form without retaining current values", () => {
  const step = inspectFormPage(page(`<form data-question-key="email" action="/done" method="post">
    <input type="hidden" name="csrf" value="fixture-secret"><input required name="address" value="person@example.test"><button>Go</button>
  </form>`), "https://example.test/start");
  assert.equal(step?.actionPath, "/done");
  assert.deepEqual(step?.controls.map(({ name, kind }) => ({ name, kind })), [
    { name: "csrf", kind: "hidden" },
    { name: "address", kind: "text" },
  ]);
  assert.doesNotMatch(JSON.stringify(step), /fixture-secret|person@example/);
});

test("rejects cross-origin form actions", () => {
  assert.throws(
    () => inspectFormPage(page('<form data-question-key="x" action="https://other.test/done"><input name="x"><button>Go</button></form>'), "https://example.test/start"),
    /left the allowed origin/,
  );
});

test("discovers a generic form among unrelated forms and honors document base URLs", () => {
  const html = page(`<base href="/base/"><form id="search" action="search"><input name="q"><button>Go</button></form>
    <form id="checkout" action="result" method="post"><input required name="name"><button name="intent" value="save">Save</button></form>`);
  const candidates = inspectFormCandidates(html, "https://example.test/start");
  assert.equal(candidates.length, 2);
  const selected = inspectFormPage(html, "https://example.test/start", { answerKeys: ["checkout"] });
  assert.equal(selected?.questionKey, "checkout");
  assert.equal(selected?.actionPath, "/base/result");
  assert.equal(selected?.submitter.name, "intent");
});

test("result comparison excludes client-enhanced contextual furniture", () => {
  const result = extractMainResult(page(`<article><h1>Answer</h1><p>Stable result</p></article>
    <aside class="gem-c-contextual-sidebar">Show all steps, client-only state</aside>`), "https://example.test/result");
  assert.equal(result.mainText, "Answer Stable result");
});

test("demonstrates, compiles, validates, and replays a live form workflow", async () => {
  const { server, origin } = await fixture();
  const userDataDir = await mkdtemp(resolve(tmpdir(), "clapping-hands-form-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true });
    const demonstration = await demonstrateFormWorkflow(await context.newPage(), `${origin}/wizard`, answers);
    const second = await demonstrateFormWorkflow(await context.newPage(), `${origin}/wizard`, {
      ...answers,
      dob: { "response[day]": "2", "response[month]": "2", "response[year]": "1961" },
    });
    let plan = compileFormWorkflow("fixture_calculate", `${origin}/wizard`, [demonstration, second]);
    assert.equal(plan.status, "provisional");
    assert.equal(plan.steps.length, 2);

    const replay = await replayFormWorkflow(context, plan, answers);
    assert.equal(replay.mainText, demonstration.result.mainText);
    assert.equal(replay.navigations, 0);
    assert.equal(replay.requests, 3);
    plan = recordFormShadow(plan, demonstration.inputHash, replay.resultHash === demonstration.result.resultHash);
    const replayTwo = await replayFormWorkflow(context, plan, {
      ...answers,
      dob: { "response[day]": "2", "response[month]": "2", "response[year]": "1961" },
    });
    plan = recordFormShadow(plan, second.inputHash, replayTwo.resultHash === second.result.resultHash);
    assert.equal(plan.status, "stable");

    const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-form-plan-"));
    try {
      const path = resolve(directory, "plan.json");
      await new FormWorkflowPlanStore(path).save(plan);
      const persisted = await readFile(path, "utf8");
      assert.doesNotMatch(persisted, /1960|1961|fixture-secret|person@example/);
      assert.equal((await new FormWorkflowPlanStore(path).load())?.status, "stable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("compiled POST replay preserves repeated successful controls", async () => {
  const { server, origin } = await fixture();
  const userDataDir = await mkdtemp(resolve(tmpdir(), "clapping-hands-post-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true });
    const postAnswers = { topics: { topic: ["a", "b"] } };
    const demonstration = await demonstrateFormWorkflow(await context.newPage(), `${origin}/post`, postAnswers);
    const plan = compileFormWorkflow("fixture_post", `${origin}/post`, [demonstration]);
    const replay = await replayFormWorkflow(context, plan, postAnswers);
    assert.equal(replay.mainText, demonstration.result.mainText);
    assert.match(replay.mainText, /Received a and b/);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("generic form replay preserves browser default successful controls", async () => {
  const { server, origin } = await fixture();
  const userDataDir = await mkdtemp(resolve(tmpdir(), "clapping-hands-generic-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true });
    const genericAnswers = { "profile-form": { display: "Ada" } };
    const demonstration = await demonstrateFormWorkflow(await context.newPage(), `${origin}/generic`, genericAnswers);
    const plan = compileFormWorkflow("fixture_generic", `${origin}/generic`, [demonstration]);
    const replay = await replayFormWorkflow(context, plan, genericAnswers);
    assert.equal(replay.mainText, demonstration.result.mainText);
    assert.match(replay.mainText, /nickname=default nick\|newsletter=yes\|locale=en\|intent=save/);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("same-document forms compile to deterministic browser replay and refuse network replay", async () => {
  const { server, origin } = await fixture();
  const userDataDir = await mkdtemp(resolve(tmpdir(), "clapping-hands-spa-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true });
    const spaAnswers = { "spa-form": { message: "hello" } };
    const demonstration = await demonstrateFormWorkflow(await context.newPage(), `${origin}/spa`, spaAnswers);
    assert.equal(demonstration.steps[0]?.transition, "same-document");
    const plan = compileFormWorkflow("fixture_spa", `${origin}/spa`, [demonstration]);
    await assert.rejects(() => replayFormWorkflow(context!, plan, spaAnswers), /browser replay/);
    const replay = await replayFormWorkflowInBrowser(await context.newPage(), plan, spaAnswers);
    assert.equal(replay.mainText, demonstration.result.mainText);
    assert.equal(replay.navigations, 1);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("compiled replay rejects an HTTP-200 login shell", async () => {
  const { server, origin, activateLoginShell } = await fixture();
  const userDataDir = await mkdtemp(resolve(tmpdir(), "clapping-hands-login-shell-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true });
    const demonstration = await demonstrateFormWorkflow(await context.newPage(), `${origin}/wizard`, answers);
    const plan = compileFormWorkflow("fixture_login_shell", `${origin}/wizard`, [demonstration]);
    activateLoginShell();
    await assert.rejects(() => replayFormWorkflow(context!, plan, answers), /final result|login|heading|authentication/i);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("compiled replay does not follow a cross-origin redirect", async () => {
  let externalHits = 0;
  const external = createServer((_request, response) => {
    externalHits += 1;
    response.setHeader("content-type", "text/html");
    response.end(page("<h1>External</h1>"));
  });
  await new Promise<void>((resolvePromise) => external.listen(0, "127.0.0.1", resolvePromise));
  const externalAddress = external.address();
  if (!externalAddress || typeof externalAddress === "string") throw new Error("External fixture did not bind.");
  const { server, origin, activateRedirect } = await fixture();
  const userDataDir = await mkdtemp(resolve(tmpdir(), "clapping-hands-redirect-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true });
    const demonstration = await demonstrateFormWorkflow(await context.newPage(), `${origin}/wizard`, answers);
    const plan = compileFormWorkflow("fixture_redirect", `${origin}/wizard`, [demonstration]);
    activateRedirect(`http://127.0.0.1:${externalAddress.port}/capture`);
    await assert.rejects(() => replayFormWorkflow(context!, plan, answers), /origin|redirect/i);
    assert.equal(externalHits, 0);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await new Promise<void>((resolvePromise, reject) => external.close((error) => error ? reject(error) : resolvePromise()));
    await rm(userDataDir, { recursive: true, force: true });
  }
});
