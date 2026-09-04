import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import {
  compileGenericJsonPlan,
  compileGenericJsonFromTraces,
  recordGenericJsonShadow,
  replayGenericJsonPlan,
  type GenericNetworkDemonstration,
  type NetworkInput,
} from "../src/generic-network.js";
import type { CapturedExchange } from "../src/network-plan.js";
import { NetworkRecorder } from "../src/network-recorder.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function exchange(
  url: string,
  input: NetworkInput,
  response: unknown,
  options: { method?: string; requestBody?: unknown; contentType?: string } = {},
): GenericNetworkDemonstration {
  const method = options.method ?? "GET";
  const contentType = options.contentType ?? (options.requestBody ? "application/json" : "");
  const captured: CapturedExchange = {
    url,
    method,
    resourceType: "fetch",
    requestHeaders: contentType ? { "content-type": contentType, accept: "application/json" } : { accept: "application/json" },
    requestBody: options.requestBody ? JSON.stringify(options.requestBody) : "",
    responseStatus: 200,
    responseBody: JSON.stringify(response),
  };
  return { input, exchange: captured };
}

async function apiFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/capture") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><script>fetch('/api/search?q=captured', {
        headers: { authorization: 'Bearer fixture-secret', 'x-csrf-token': 'fixture-csrf' }
      }).then(response => response.json()).then(value => document.body.textContent = value.items[0].title)</script>`);
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      response.end(JSON.stringify(query === "drift"
        ? { wrong: true }
        : { items: [{ id: query.length, title: query }], meta: { count: 1 } }));
      return;
    }
    if (url.pathname === "/api/filter" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query?: string; limit?: number };
      response.end(JSON.stringify({ items: [{ title: body.query }], limit: body.limit }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("API fixture did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function searchDemonstrations(origin: string): GenericNetworkDemonstration[] {
  return ["sofa", "chair"].map((query, index) => exchange(
    `${origin}/api/search?q=${query}&limit=5`,
    { query },
    { items: [{ id: index + 1, title: query }], meta: { count: 1 } },
  ));
}

test("infers a redacted GET query plan from two demonstrations and validates replay", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-get-"));
  let context: BrowserContext | null = null;
  try {
    const plan = compileGenericJsonPlan("search", searchDemonstrations(origin));
    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /sofa|chair/);
    assert.equal(plan.request.endpointPath, "/api/search");
    assert.equal(plan.status, "provisional");
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const replay = await replayGenericJsonPlan(context, plan, { query: "lamp" });
    assert.deepEqual(replay.data, { items: [{ id: 4, title: "lamp" }], meta: { count: 1 } });
    let stable = recordGenericJsonShadow(plan, { query: "lamp" }, true);
    stable = recordGenericJsonShadow(stable, { query: "desk" }, true);
    assert.equal(stable.status, "stable");
    await assert.rejects(() => replayGenericJsonPlan(context!, plan, { query: "drift" }), /structural contract/);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("infers JSON body bindings while retaining safe constants", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-post-"));
  let context: BrowserContext | null = null;
  try {
    const demos = ["sofa", "chair"].map((query) => exchange(
      `${origin}/api/filter`,
      { query },
      { items: [{ title: query }], limit: 5 },
      { method: "POST", requestBody: { query, limit: 5 } },
    ));
    const plan = compileGenericJsonPlan("filter", demos);
    assert.equal(plan.request.bodyCodec, "json");
    assert.doesNotMatch(JSON.stringify(plan), /sofa|chair/);
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const replay = await replayGenericJsonPlan(context, plan, { query: "lamp" });
    assert.deepEqual(replay.data, { items: [{ title: "lamp" }], limit: 5 });
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses unbound dynamic values and sensitive constants", () => {
  const origin = "https://example.test";
  assert.throws(() => compileGenericJsonPlan("dynamic", [
    exchange(`${origin}/api`, { query: "sofa" }, { ok: true }, { method: "POST", requestBody: { query: "sofa", nonce: "one" } }),
    exchange(`${origin}/api`, { query: "chair" }, { ok: true }, { method: "POST", requestBody: { query: "chair", nonce: "two" } }),
  ]), /Unbound dynamic request value/);

  assert.throws(() => compileGenericJsonPlan("secret", [
    exchange(`${origin}/api`, { query: "sofa" }, { ok: true }, { method: "POST", requestBody: { query: "sofa", csrf_token: "fixed" } }),
    exchange(`${origin}/api`, { query: "chair" }, { ok: true }, { method: "POST", requestBody: { query: "chair", csrf_token: "fixed" } }),
  ]), /sensitive request field/);
});

test("generic recorder captures same-origin GET JSON and strips secret headers", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-recorder-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const page = await context.newPage();
    const recorder = new NetworkRecorder();
    recorder.attach(page);
    const mark = recorder.mark();
    await page.goto(`${origin}/capture`, { waitUntil: "networkidle" });
    const captured = await recorder.since(mark);
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.url, /\/api\/search\?q=captured/);
    assert.equal(captured[0]!.requestBody, "");
    assert.equal("authorization" in captured[0]!.requestHeaders, false);
    assert.equal("x-csrf-token" in captured[0]!.requestHeaders, false);
    assert.deepEqual((await recorder.diagnosticsSince(mark)).operations, ["GET /api/search"]);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("generic recorder captures requests from every attached page", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-recorder-pages-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const first = await context.newPage();
    const second = await context.newPage();
    const recorder = new NetworkRecorder();
    recorder.attach(first);
    recorder.attach(second);
    const mark = recorder.mark();
    await Promise.all([
      first.goto(`${origin}/capture`, { waitUntil: "networkidle" }),
      second.goto(`${origin}/capture`, { waitUntil: "networkidle" }),
    ]);
    assert.equal((await recorder.since(mark)).length, 2);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("selects the input-bound operation from noisy browser traces", () => {
  const origin = "https://example.test";
  const noise = (event: string): CapturedExchange => exchange(
    `${origin}/telemetry?event=${event}`,
    { ignored: event },
    { accepted: true },
  ).exchange;
  const traces = ["sofa", "chair"].map((query, index) => ({
    input: { query },
    exchanges: [
      noise(`page-${index}`),
      exchange(`${origin}/api/search?q=${query}`, { query }, { items: [{ title: query }] }).exchange,
    ],
  }));
  const compiled = compileGenericJsonFromTraces("search", traces);
  assert.equal(compiled.plan.request.endpointPath, "/api/search");
  assert.deepEqual(Object.keys(compiled.plan.request.bindings), ["query"]);
});

test("selects only a request whose response is evidenced in the rendered output", () => {
  const origin = "https://example.test";
  const traces = [
    { query: "sofa", title: "Oak daybed", telemetryId: "event-one" },
    { query: "chair", title: "Blue armchair", telemetryId: "event-two" },
  ].map(({ query, title, telemetryId }) => ({
    input: { query },
    outputText: `Search results ${title}`,
    exchanges: [
      exchange(`${origin}/telemetry?q=${query}`, { query }, { event: telemetryId }).exchange,
      exchange(`${origin}/api/search?q=${query}`, { query }, { items: [{ title }] }).exchange,
    ],
  }));
  const compiled = compileGenericJsonFromTraces("search", traces);
  assert.equal(compiled.plan.request.endpointPath, "/api/search");
});
