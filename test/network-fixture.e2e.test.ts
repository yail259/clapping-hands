import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright-core";
import { compareListingIds, compileMarketplaceDemonstration, MarketplacePlanStore } from "../src/network-plan.js";
import { NetworkRecorder } from "../src/network-recorder.js";
import { replayMarketplaceNetworkSearch } from "../src/network-replay.js";
import type { MarketplaceListing } from "../src/marketplace.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SESSION_SECRET = "controlled-fixture-session-secret";
const CSRF_PREFIX = "controlled-fixture-csrf-secret";

function numericSeed(value: string): number {
  return [...value].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 100_000, 10_000);
}

function responseBody(query: string, cursor: string | null) {
  const offset = cursor ? 2 : 0;
  const seed = numericSeed(query);
  return {
    data: {
      marketplace_search: {
        feed_units: {
          edges: [0, 1].map((index) => ({
            node: {
              listing: {
                id: String(seed * 10 + offset + index),
                marketplace_listing_title: `${query} fixture ${offset + index}`,
                listing_price: { formatted_amount: `AU$${200 + offset + index}` },
                strikethrough_price: { formatted_amount: `AU$${250 + offset + index}` },
                location: { reverse_geocode: { city_page: { display_name: "Sydney, NSW" } } },
                primary_listing_photo: { image: { uri: `http://images.invalid/${seed + offset + index}.jpg` } },
              },
            },
          })),
          page_info: {
            has_next_page: cursor === null,
            end_cursor: cursor === null ? "fixture-next" : null,
          },
        },
      },
    },
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function listingFromFixture(query: string, index: number): MarketplaceListing {
  const id = String(numericSeed(query) * 10 + index);
  return {
    id,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title: `${query} fixture ${index}`,
    price: `AU$${200 + index}`,
    previousPrice: `AU$${250 + index}`,
    location: "Sydney, NSW",
    imageUrl: `http://images.invalid/${numericSeed(query) + index}.jpg`,
    fretConfidence: "unknown",
    evidence: [],
    rawText: "",
  };
}

test("controlled browser fixture proves auth restart, promotion, warm replay, and redaction", { timeout: 90_000 }, async () => {
  let requestCounter = 0;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/login") {
      response.writeHead(302, {
        location: "/marketplace/search/?query=login-check",
        "set-cookie": `fixture_session=${SESSION_SECRET}; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/`,
      });
      response.end();
      return;
    }
    if (url.pathname === "/marketplace/search/") {
      if (!request.headers.cookie?.includes(`fixture_session=${SESSION_SECRET}`)) {
        response.writeHead(401, { "content-type": "text/html" });
        response.end("<h1>Login required</h1>");
        return;
      }
      const query = url.searchParams.get("query") ?? "";
      const csrf = `${CSRF_PREFIX}-${++requestCounter}`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body><main id="results"></main><script>
        const query = ${JSON.stringify(query)};
        const form = new URLSearchParams({
          fb_dtsg: ${JSON.stringify(csrf)},
          jazoest: "fixture-jazoest-secret",
          doc_id: "fixture-doc-id",
          fb_api_req_friendly_name: "MarketplaceSearchFixtureQuery",
          variables: JSON.stringify({ marketplace: { query, cursor: null, radius: 65 } })
        });
        fetch("/api/graphql/", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-fixture-csrf": ${JSON.stringify(csrf)} },
          body: form.toString()
        }).then(response => response.json()).then(payload => {
          const root = document.querySelector("#results");
          for (const edge of payload.data.marketplace_search.feed_units.edges) {
            const listing = edge.node.listing;
            const anchor = document.createElement("a");
            anchor.href = "/marketplace/item/" + listing.id + "/";
            anchor.textContent = listing.listing_price.formatted_amount + "\\n" + listing.marketplace_listing_title + "\\nSydney, NSW";
            root.append(anchor);
          }
        });
      </script></body></html>`);
      return;
    }
    if (url.pathname === "/api/graphql/" && request.method === "POST") {
      if (!request.headers.cookie?.includes(`fixture_session=${SESSION_SECRET}`)) {
        response.writeHead(401).end();
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      if (!form.get("fb_dtsg")?.startsWith(CSRF_PREFIX)) {
        response.writeHead(403).end();
        return;
      }
      const variables = JSON.parse(form.get("variables") ?? "{}") as {
        marketplace?: { query?: string; cursor?: string | null };
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody(
        variables.marketplace?.query ?? "",
        variables.marketplace?.cursor ?? null,
      )));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const temporary = await mkdtemp(resolve(tmpdir(), "clapping-hands-browser-fixture-"));
  const userDataDir = resolve(temporary, "profile");
  const planPath = resolve(temporary, "plan.json");
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROME,
      headless: true,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
    assert.equal((await context.cookies(origin)).some((cookie) => cookie.name === "fixture_session"), true);

    const recorder = new NetworkRecorder();
    recorder.attach(page);
    const store = new MarketplacePlanStore(planPath);
    let plan = null;
    for (const query of ["sofa bed", "24 fret guitar"]) {
      const mark = recorder.mark();
      await page.goto(`${origin}/marketplace/search/?query=${encodeURIComponent(query)}`, { waitUntil: "networkidle" });
      await page.waitForSelector('a[href*="/marketplace/item/"]');
      const demonstration = compileMarketplaceDemonstration(
        await recorder.since(mark),
        { query, locationSlug: "sydney", radiusKm: 65 },
        origin,
      );
      assert.ok(demonstration);
      plan = await store.recordDemonstration(demonstration);
      const replay = await replayMarketplaceNetworkSearch(
        context,
        plan,
        demonstration.runtimeExchange,
        { query, locationSlug: "sydney", radiusKm: 65 },
        10,
      );
      const comparison = compareListingIds(
        [listingFromFixture(query, 0), listingFromFixture(query, 1)],
        replay.listings,
      );
      assert.equal(comparison.overlap, 1);
      plan = await store.recordShadowValidation(plan, demonstration.inputHash, true);
    }
    assert.ok(plan);
    assert.equal(plan.status, "stable");

    const beforeUrl = page.url();
    const latestExchange = recorder.latest().at(-1);
    assert.ok(latestExchange);
    const warm = await replayMarketplaceNetworkSearch(
      context,
      plan,
      latestExchange,
      { query: "fresh sofa", locationSlug: "sydney", radiusKm: 65 },
      10,
    );
    assert.equal(warm.complete, true);
    assert.equal(warm.listings.length, 4);
    assert.equal(page.url(), beforeUrl, "warm replay unexpectedly navigated the UI");

    const serialized = await readFile(planPath, "utf8");
    for (const secret of [SESSION_SECRET, CSRF_PREFIX, "fixture-jazoest-secret", "sofa bed", "24 fret guitar"]) {
      assert.equal(serialized.includes(secret), false, `serialized plan leaked ${secret}`);
    }

    await context.close();
    context = null;
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROME,
      headless: true,
    });
    assert.equal((await context.cookies(origin)).some((cookie) => cookie.name === "fixture_session"), true);
  } finally {
    await context?.close().catch(() => {});
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(temporary, { recursive: true, force: true });
  }
});
