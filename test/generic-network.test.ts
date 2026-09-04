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
  type GenericJsonPlan,
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
    requestBody: options.requestBody
      ? typeof options.requestBody === "string" ? options.requestBody : JSON.stringify(options.requestBody)
      : "",
    responseStatus: 200,
    responseBody: JSON.stringify(response),
  };
  return { input, exchange: captured };
}

async function apiFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("access-control-allow-origin", "*");
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
        : query === "empty-drift"
          ? { items: [], meta: { count: 0 } }
          : { items: [{ id: query.length, title: query }], meta: { count: 1 } }));
      return;
    }
    if (url.pathname === "/api/paged") {
      const query = url.searchParams.get("q") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      const page = cursor ? Number.parseInt(cursor.split("-").at(-1) ?? "0", 10) : 0;
      const terminal = query === "endless" || query === "repeat" ? false : query === "lamp" ? page >= 2 : page >= 1;
      response.end(JSON.stringify({
        items: [{ id: `${query}-${page}`, title: `${query} page ${page + 1}` }],
        pageInfo: {
          hasNextPage: !terminal,
          endCursor: terminal ? null : query === "repeat" ? "repeat-1" : `${query}-${page + 1}`,
        },
      }));
      return;
    }
    if (url.pathname === "/api/numbered") {
      const query = url.searchParams.get("q") ?? "";
      const page = Number(url.searchParams.get("page") ?? "0");
      const terminal = query === "endless-numbered" ? false : page >= 2;
      response.end(JSON.stringify({
        items: terminal ? [] : [{ id: `${query}-${page}`, title: `${query} page ${page + 1}` }],
        ...(terminal ? {} : { nextPageUrl: `/api/numbered?q=${query}&page=${page + 1}` }),
      }));
      return;
    }
    if (url.pathname === "/api/html-json") {
      response.setHeader("content-type", "text/html");
      response.end(JSON.stringify({ items: [{ title: "looks structured" }] }));
      return;
    }
    if (url.pathname === "/api/status") {
      response.end(JSON.stringify({ status: "ok", checked: true }));
      return;
    }
    if (url.pathname === "/api/filter" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query?: string; limit?: number };
      response.end(JSON.stringify({ items: [{ title: body.query }], limit: body.limit }));
      return;
    }
    if (url.pathname === "/api/graphql" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const variables = JSON.parse(form.get("variables") ?? "{}") as { query?: string; limit?: number };
      response.end(JSON.stringify({ data: { items: [{ title: variables.query }], limit: variables.limit } }));
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

function cursorTrace(origin: string, query: string) {
  return {
    input: { query },
    outputText: `${query} page 1 ${query} page 2`,
    exchanges: [
      exchange(
        `${origin}/api/paged?q=${query}&cursor=`,
        { query },
        {
          items: [{ id: `${query}-0`, title: `${query} page 1` }],
          pageInfo: { hasNextPage: true, endCursor: `${query}-1` },
        },
      ).exchange,
      exchange(
        `${origin}/api/paged?q=${query}&cursor=${query}-1`,
        { query },
        {
          items: [{ id: `${query}-1`, title: `${query} page 2` }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ).exchange,
    ],
  };
}

function incrementTrace(origin: string, query: string) {
  return {
    input: { query },
    outputText: `${query} page 1 ${query} page 2`,
    exchanges: [
      exchange(
        `${origin}/api/numbered?q=${query}`,
        { query },
        {
          items: [{ id: `${query}-0`, title: `${query} page 1` }],
          nextPageUrl: `/api/numbered?q=${query}&page=1`,
        },
      ).exchange,
      exchange(
        `${origin}/api/numbered?q=${query}&page=1`,
        { query },
        {
          items: [{ id: `${query}-1`, title: `${query} page 2` }],
          nextPageUrl: `/api/numbered?q=${query}&page=2`,
        },
      ).exchange,
      exchange(
        `${origin}/api/numbered?q=${query}&page=2`,
        { query },
        { items: [] },
      ).exchange,
    ],
  };
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
    await assert.rejects(() => replayGenericJsonPlan(context!, plan, { query: "empty-drift" }), /structural contract/);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("infers terminal cursor pagination from traces and replays every unseen page", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-pagination-"));
  let context: BrowserContext | null = null;
  try {
    const compiled = compileGenericJsonFromTraces("paged_search", [
      cursorTrace(origin, "sofa"),
      cursorTrace(origin, "chair"),
    ]);
    const plan = compiled.plan;
    assert.deepEqual(plan.request.pagination, {
      strategy: "cursor",
      requestSource: "query",
      requestPath: ["cursor", 0],
      responseCursorPath: ["pageInfo", "endCursor"],
      responseHasNextPath: ["pageInfo", "hasNextPage"],
      maximumPages: 40,
    });
    assert.doesNotMatch(JSON.stringify(plan), /sofa|chair/);

    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const replay = await replayGenericJsonPlan(context, plan, { query: "lamp" });
    assert.equal(replay.requests, 3);
    assert.equal(replay.complete, true);
    assert.deepEqual(replay.data, [
      {
        items: [{ id: "lamp-0", title: "lamp page 1" }],
        pageInfo: { hasNextPage: true, endCursor: "lamp-1" },
      },
      {
        items: [{ id: "lamp-1", title: "lamp page 2" }],
        pageInfo: { hasNextPage: true, endCursor: "lamp-2" },
      },
      {
        items: [{ id: "lamp-2", title: "lamp page 3" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);

    const bounded = structuredClone(plan);
    bounded.request.pagination!.maximumPages = 2;
    await assert.rejects(
      () => replayGenericJsonPlan(context!, bounded, { query: "endless" }),
      /page limit before a terminal response/,
    );
    await assert.rejects(
      () => replayGenericJsonPlan(context!, plan, { query: "repeat" }),
      /repeated cursor/,
    );

    const overwriting = structuredClone(plan);
    overwriting.request.pagination!.requestPath = ["q", 0];
    await assert.rejects(
      () => replayGenericJsonPlan(context!, overwriting, { query: "lamp" }),
      /cannot overwrite a user input binding/,
    );
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("infers omitted-first numbered pagination and replays to the terminal page", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-increment-pagination-"));
  let context: BrowserContext | null = null;
  try {
    const compiled = compileGenericJsonFromTraces("numbered_search", [
      incrementTrace(origin, "sofa"),
      incrementTrace(origin, "chair"),
    ]);
    const plan = compiled.plan;
    assert.deepEqual(plan.request.pagination, {
      strategy: "increment",
      requestSource: "query",
      requestPath: ["page", 0],
      firstContinuationValue: 1,
      increment: 1,
      termination: { type: "next-value", responsePath: ["nextPageUrl"] },
      maximumPages: 40,
    });
    assert.equal("page" in plan.request.queryTemplate, false);
    assert.doesNotMatch(JSON.stringify(plan), /sofa|chair/);

    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const replay = await replayGenericJsonPlan(context, plan, { query: "lamp" });
    assert.equal(replay.requests, 3);
    assert.deepEqual(replay.data, [
      {
        items: [{ id: "lamp-0", title: "lamp page 1" }],
        nextPageUrl: "/api/numbered?q=lamp&page=1",
      },
      {
        items: [{ id: "lamp-1", title: "lamp page 2" }],
        nextPageUrl: "/api/numbered?q=lamp&page=2",
      },
      { items: [] },
    ]);

    const bounded = structuredClone(plan);
    bounded.request.pagination!.maximumPages = 2;
    await assert.rejects(
      () => replayGenericJsonPlan(context!, bounded, { query: "endless-numbered" }),
      /page limit before a terminal response/,
    );
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
    const persistedHash = "ab".repeat(32);
    const demos = ["sofa", "chair"].map((query) => exchange(
      `${origin}/api/filter`,
      { query },
      { items: [{ title: query }], limit: 5 },
      { method: "POST", requestBody: { query, limit: 5, extensions: { persistedQuery: { sha256Hash: persistedHash } } } },
    ));
    const plan = compileGenericJsonPlan("filter", demos);
    assert.equal(plan.request.bodyCodec, "json");
    assert.match(JSON.stringify(plan.request.bodyTemplate), new RegExp(persistedHash));
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

test("binds inputs nested in form-encoded GraphQL variables", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-graphql-form-"));
  let context: BrowserContext | null = null;
  try {
    const demos = ["sofa", "chair"].map((query) => exchange(
      `${origin}/api/graphql`,
      { query },
      { data: { items: [{ title: query }], limit: 5 } },
      {
        method: "POST",
        requestBody: new URLSearchParams({
          variables: JSON.stringify({ query, limit: 5 }),
          doc_id: "123456",
        }).toString(),
        contentType: "application/x-www-form-urlencoded",
      },
    ));
    const plan = compileGenericJsonPlan("graphql_search", demos);
    assert.equal(plan.request.bodyCodec, "form");
    assert.deepEqual(plan.request.bindings.query, [{ source: "body", path: ["variables", 0, "query"] }]);
    assert.doesNotMatch(JSON.stringify(plan), /sofa|chair/);
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const result = await replayGenericJsonPlan(context, plan, { query: "lamp" });
    assert.deepEqual(result.data, { data: { items: [{ title: "lamp" }], limit: 5 } });
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiles a zero-argument JSON request and counts repeated independent shadows", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-status-"));
  let context: BrowserContext | null = null;
  try {
    const demonstrations = [
      exchange(`${origin}/api/status`, {}, { status: "ok", checked: true }),
      exchange(`${origin}/api/status`, {}, { status: "ok", checked: true }),
    ];
    const plan = compileGenericJsonPlan("check_status", demonstrations);
    assert.deepEqual(plan.request.bindings, {});
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const result = await replayGenericJsonPlan(context, plan, {});
    assert.deepEqual(result.data, { status: "ok", checked: true });
    let stable = recordGenericJsonShadow(plan, {}, true);
    stable = recordGenericJsonShadow(stable, {}, true);
    assert.equal(stable.evidence.successfulShadowInputHashes.length, 1);
    assert.equal(stable.evidence.successfulShadowCount, 2);
    assert.equal(stable.status, "stable");
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiles an explicitly allowed API origin without changing workflow identity", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-cross-origin-"));
  let context: BrowserContext | null = null;
  try {
    const demonstrations = [
      exchange(`${origin}/api/status`, {}, { status: "ok", checked: true }),
      exchange(`${origin}/api/status`, {}, { status: "ok", checked: true }),
    ];
    assert.throws(
      () => compileGenericJsonPlan("cross_origin_status", demonstrations, { workflowOrigin: "http://app.example" }),
      /not explicitly allowed/,
    );
    const plan = compileGenericJsonPlan("cross_origin_status", demonstrations, {
      workflowOrigin: "http://app.example",
      allowedNetworkOrigins: [origin],
    });
    assert.equal(plan.origin, "http://app.example");
    assert.equal(plan.request.endpointOrigin, origin);
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const result = await replayGenericJsonPlan(context, plan, {});
    assert.deepEqual(result.data, { status: "ok", checked: true });
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("recorder captures only explicitly allowed cross-origin API responses", async () => {
  const api = await apiFixture();
  const pageServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><script>fetch(${JSON.stringify(`${api.origin}/api/status`)})</script>`);
  });
  await new Promise<void>((resolvePromise) => pageServer.listen(0, "127.0.0.1", resolvePromise));
  const address = pageServer.address();
  if (!address || typeof address === "string") throw new Error("Page fixture did not bind.");
  const pageOrigin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-recorder-cross-origin-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    const page = await context.newPage();
    const denied = new NetworkRecorder();
    denied.attach(page);
    const deniedMark = denied.mark();
    await page.goto(pageOrigin, { waitUntil: "networkidle" });
    assert.equal((await denied.since(deniedMark)).length, 0);
    assert.equal((await denied.diagnosticsSince(deniedMark)).outcomes["cross-origin"], 1);

    const allowed = new NetworkRecorder();
    allowed.setAllowedOrigins([pageOrigin, api.origin]);
    allowed.attach(page);
    const allowedMark = allowed.mark();
    await page.reload({ waitUntil: "networkidle" });
    const captured = await allowed.since(allowedMark);
    assert.equal(captured.length, 1);
    assert.equal(new URL(captured[0]!.url).origin, api.origin);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => pageServer.close((error) => error ? reject(error) : resolvePromise()));
    await new Promise<void>((resolvePromise, reject) => api.server.close((error) => error ? reject(error) : resolvePromise()));
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

test("read accelerators reject mutation methods and HTTPS downgrade endpoints", () => {
  const origin = "https://example.test";
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.throws(() => compileGenericJsonPlan(`unsafe_${method.toLowerCase()}`, [
      exchange(`${origin}/api?q=sofa`, { query: "sofa" }, { ok: true }, { method }),
      exchange(`${origin}/api?q=chair`, { query: "chair" }, { ok: true }, { method }),
    ]), /requires the effectful workflow path/);
  }

  assert.throws(() => compileGenericJsonPlan("downgrade", [
    exchange("http://api.example.test/search?q=sofa", { query: "sofa" }, { items: [{ title: "sofa" }] }),
    exchange("http://api.example.test/search?q=chair", { query: "chair" }, { items: [{ title: "chair" }] }),
  ], {
    workflowOrigin: origin,
    allowedNetworkOrigins: ["http://api.example.test"],
  }), /plaintext network endpoint/);
});

test("replay rejects a JSON-shaped body served as HTML", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-content-type-"));
  let context: BrowserContext | null = null;
  try {
    const demonstrations = ["sofa", "chair"].map((query) => exchange(
      `${origin}/api/html-json?q=${query}`,
      { query },
      { items: [{ title: "looks structured" }] },
    ));
    const plan = compileGenericJsonPlan("content_type_guard", demonstrations);
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });
    await assert.rejects(
      () => replayGenericJsonPlan(context!, plan, { query: "lamp" }),
      /unexpected content type: text\/html/,
    );
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay revalidates persisted endpoints, methods, headers, and response limits", async () => {
  const { server, origin } = await apiFixture();
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-json-plan-safety-"));
  let context: BrowserContext | null = null;
  try {
    const plan = compileGenericJsonPlan("persisted_plan_guard", searchDemonstrations(origin));
    context = await chromium.launchPersistentContext(directory, { executablePath: CHROME, headless: true });

    const endpoint = structuredClone(plan);
    endpoint.request.endpointPath = "https://attacker.invalid/collect";
    await assert.rejects(() => replayGenericJsonPlan(context!, endpoint, { query: "lamp" }), /same-origin absolute path/);

    const method = structuredClone(plan);
    (method.request as unknown as { method: string }).method = "DELETE";
    await assert.rejects(() => replayGenericJsonPlan(context!, method as GenericJsonPlan, { query: "lamp" }), /effectful workflow path/);

    const header = structuredClone(plan);
    header.request.headers.authorization = "Bearer should-never-leave";
    await assert.rejects(() => replayGenericJsonPlan(context!, header, { query: "lamp" }), /forbidden request header/);

    const responseLimit = structuredClone(plan);
    responseLimit.response.maximumBytes = Number.MAX_SAFE_INTEGER;
    await assert.rejects(() => replayGenericJsonPlan(context!, responseLimit, { query: "lamp" }), /response limit is invalid/);
  } finally {
    await context?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
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
