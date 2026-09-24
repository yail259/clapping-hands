import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type BrowserContext, type Page, type Request, type Response } from "playwright-core";
import { assertWorkflowAuth, trackWorkflowAuth, WorkflowAccessError, type WorkflowAccessReason } from "../src/workflow-auth.js";

const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const login = `<h1>Sign in</h1><form method="post" action="/login"><label>Email<input type="email" autocomplete="username" name="email"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>`;

async function fixture() {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/login" && req.method === "POST") {
      res.writeHead(303, { "set-cookie": "fixture-session=allowed; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax", location: "/protected" }); res.end(); return;
    }
    if (url.pathname === "/protected" && !req.headers.cookie?.includes("fixture-session=allowed")) {
      res.writeHead(302, { location: "/login?return_to=fixture-private-query#fixture-private-fragment" }); res.end(); return;
    }
    const status = url.pathname === "/401" ? 401 : url.pathname === "/403" ? 403 : 200;
    res.writeHead(status, { "content-type": "text/html" });
    if (url.pathname === "/login") { res.end(login); return; }
    if (url.pathname === "/checkpoint") { res.end(`<h1>Verify your identity</h1><form><input autocomplete="one-time-code"><button>Verify</button></form>`); return; }
    if (url.pathname === "/article") { res.end(`<h1>How to sign in</h1><article>Login troubleshooting and verification examples</article><form hidden><input type="password"><button>Sign in</button></form><output>0</output>`); return; }
    if (url.pathname === "/settings") { res.end(`<h1>Change password</h1><form><input type="password" autocomplete="current-password"><input type="password" autocomplete="new-password"><button>Save password</button></form>`); return; }
    if (url.pathname === "/register") { res.end(`<h1>Sign in or register</h1><form><input type="password" autocomplete="new-password"><button>Sign in</button></form>`); return; }
    res.end(`<h1>Fixture</h1><output>Result 0</output>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) };
}

function accessFailure(reason: WorkflowAccessReason, origin: string) {
  return (error: unknown) => {
    assert.ok(error instanceof WorkflowAccessError);
    assert.equal(error.reason, reason); assert.equal(error.origin, origin);
    assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-private/);
    return true;
  };
}

test("main-document HTTP failures, 200 credential shells, redirects and checkpoints are typed without secrets", async () => {
  const f = await fixture(); const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext(); const stop = trackWorkflowAuth(context); const page = await context.newPage();
  try {
    for (const [path, reason] of [["/401", "http-401"], ["/403", "http-403"], ["/login", "login-form"], ["/protected", "login-form"], ["/checkpoint", "checkpoint"]] as const) {
      await page.goto(f.origin + path + "?fixture-private=query#fixture-private-fragment");
      await assert.rejects(assertWorkflowAuth(page, f.origin + "/private?secret=fixture-private"), accessFailure(reason, f.origin));
    }
    for (const path of ["/article", "/settings", "/register", "/ordinary"]) {
      await page.goto(f.origin + path); await assertWorkflowAuth(page, f.origin);
    }
    await page.goto(f.origin + "/ordinary");
    await page.evaluate(async () => { await fetch("/401"); await fetch("/403"); });
    await assertWorkflowAuth(page, f.origin); // Subresource failures do not prove document authentication state.
  } finally { stop(); await browser.close(); await f.close(); }
});

test("manual fixture login recovers in-place and the persistent cookie survives browser restart", async () => {
  const f = await fixture(); const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-auth-helper-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const stop = trackWorkflowAuth(context); const page = context.pages()[0]!;
    await page.goto(f.origin + "/protected");
    await assert.rejects(assertWorkflowAuth(page, f.origin), accessFailure("login-form", f.origin));
    // Controlled stand-in for the human handoff; no learner/model has these credentials.
    await page.locator("input[type=email]").fill("fixture@example.invalid");
    await page.locator("input[type=password]").fill("fixture-only-password");
    await Promise.all([page.waitForURL(f.origin + "/protected"), page.getByRole("button", { name: "Sign in", exact: true }).click()]);
    await assertWorkflowAuth(page, f.origin); assert.equal(await page.locator("output").innerText(), "Result 0");
    stop(); await context.close(); context = undefined;
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const stopAgain = trackWorkflowAuth(context); const restarted = context.pages()[0]!;
    await restarted.goto(f.origin + "/protected");
    await assertWorkflowAuth(restarted, f.origin); assert.equal(await restarted.locator("output").innerText(), "Result 0");
    stopAgain();
  } finally { await context?.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("late old navigation status, subframes and reference-counted disposal cannot poison a newer document", async () => {
  const context = new EventEmitter() as EventEmitter & { pages(): Page[] };
  let url = "https://fixture.invalid/document";
  const page = { url: () => url, mainFrame: () => frame, evaluate: async () => null } as unknown as Page;
  const frame = { page: () => page };
  context.pages = () => [page];
  const request = (main = true) => ({ isNavigationRequest: () => true, frame: () => main ? frame : { page: () => page } }) as unknown as Request;
  const response = (req: Request, status: number) => ({ request: () => req, status: () => status, url: () => url }) as unknown as Response;
  const first = trackWorkflowAuth(context as unknown as BrowserContext); const second = trackWorkflowAuth(context as unknown as BrowserContext);
  try {
    const old = request(); const current = request();
    context.emit("request", old); context.emit("request", current);
    context.emit("response", response(current, 200)); context.emit("response", response(old, 401));
    await assertWorkflowAuth(page, "https://fixture.invalid");
    const subframe = request(false); context.emit("request", subframe); context.emit("response", response(subframe, 403));
    await assertWorkflowAuth(page, "https://fixture.invalid");
    first(); first();
    const denied = request(); context.emit("request", denied); context.emit("response", response(denied, 401));
    context.emit("framenavigated", frame);
    await assert.rejects(assertWorkflowAuth(page, "https://fixture.invalid"), accessFailure("http-401", "https://fixture.invalid"));
    url += "#fragment";
    await assert.rejects(assertWorkflowAuth(page, "https://fixture.invalid"), accessFailure("http-401", "https://fixture.invalid"));
    const pending = request(); context.emit("request", pending);
    await assertWorkflowAuth(page, "https://fixture.invalid");
    context.emit("response", response(denied, 403)); await assertWorkflowAuth(page, "https://fixture.invalid");
    context.emit("requestfailed", pending);
    await assertWorkflowAuth(page, "https://fixture.invalid");
  } finally { first(); second(); }
  assert.equal(context.listenerCount("request"), 0); assert.equal(context.listenerCount("response"), 0);
});

test("access error reason and origin cannot be replaced or serialize page evidence", () => {
  const error = new WorkflowAccessError("http-403", "https://fixture.invalid/login?fixture-private#fixture-private");
  assert.throws(() => { Object.assign(error, { reason: "login-form" }); }, TypeError);
  assert.throws(() => { Object.assign(error, { origin: "https://bad.invalid" }); }, TypeError);
  assert.equal(error.reason, "http-403"); assert.equal(error.origin, "https://fixture.invalid");
  assert.doesNotMatch(JSON.stringify(error), /fixture-private/);
});
