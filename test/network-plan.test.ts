import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import {
  compileMarketplaceDemonstration,
  extractMarketplaceNetworkResponse,
  MarketplacePlanStore,
  type CapturedExchange,
} from "../src/network-plan.js";
import { replayMarketplaceNetworkSearch } from "../src/network-replay.js";
import { ProfileInUseError, ProfileLease } from "../src/profile.js";
import { MarketplaceSearchService } from "../src/search.js";
import type { StagehandBrowser } from "../src/stagehand-browser.js";

const COOKIE_SECRET = "fixture-cookie-secret";
const CSRF_SECRET = "fixture-csrf-secret";
const AUTH_SECRET = "fixture-authorization-secret";

function fixtureBody(query: string, cursor: string | null, hasNextPage = false): string {
  const offset = cursor ? 2 : 0;
  return JSON.stringify({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [0, 1].map((index) => ({
            node: {
              listing: {
                id: String(10_000 + offset + index),
                marketplace_listing_title: `${query} listing ${offset + index}`,
                listing_price: { formatted_amount: `AU$${100 + offset + index}` },
                strikethrough_price: { formatted_amount: `AU$${150 + offset + index}` },
                location: { reverse_geocode: { city_page: { display_name: "Sydney, NSW" } } },
                primary_listing_photo: { image: { uri: `https://images.example/${offset + index}.jpg` } },
              },
            },
          })),
          page_info: {
            has_next_page: hasNextPage,
            end_cursor: hasNextPage ? "cursor-2" : null,
          },
        },
      },
    },
  });
}

function fixtureExchange(query: string, cursor: string | null = null): CapturedExchange {
  const form = new URLSearchParams({
    fb_dtsg: CSRF_SECRET,
    jazoest: "fixture-jazoest-secret",
    doc_id: "fixture-doc-id",
    fb_api_req_friendly_name: "MarketplaceSearchFixtureQuery",
    variables: JSON.stringify({
      marketplace: { query, cursor, radius: 65 },
    }),
  });
  return {
    url: "https://www.facebook.com/api/graphql/",
    method: "POST",
    resourceType: "fetch",
    requestHeaders: {
      ":authority": "www.facebook.com",
      "content-type": "application/x-www-form-urlencoded",
      authorization: AUTH_SECRET,
      cookie: `fixture_session=${COOKIE_SECRET}`,
      "x-fb-friendly-name": "MarketplaceSearchFixtureQuery",
    },
    requestBody: form.toString(),
    responseStatus: 200,
    responseBody: fixtureBody(query, cursor),
  };
}

test("compiles two redacted demonstrations and promotes only after two shadows", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "clapping-hands-plan-"));
  try {
    const path = resolve(temporary, "plan.json");
    const store = new MarketplacePlanStore(path);
    const first = compileMarketplaceDemonstration(
      [fixtureExchange("sofa bed")],
      { query: "sofa bed", locationSlug: "sydney", radiusKm: 65 },
    );
    const second = compileMarketplaceDemonstration(
      [fixtureExchange("24 fret guitar")],
      { query: "24 fret guitar", locationSlug: "sydney", radiusKm: 65 },
    );
    assert.ok(first);
    assert.ok(second);

    let plan = await store.recordDemonstration(first);
    plan = await store.recordShadowValidation(plan, first.inputHash, true);
    assert.equal(plan.status, "candidate");
    plan = await store.recordDemonstration(second);
    assert.equal(plan.status, "provisional");
    plan = await store.recordShadowValidation(plan, second.inputHash, true);
    assert.equal(plan.status, "stable");

    const serialized = await readFile(path, "utf8");
    for (const secret of [COOKIE_SECRET, CSRF_SECRET, AUTH_SECRET, "fixture-jazoest-secret", "sofa bed", "24 fret guitar"]) {
      assert.equal(serialized.includes(secret), false, `plan leaked ${secret}`);
    }
    assert.equal(serialized.includes("fixture-doc-id"), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("replays a compiled request with fresh inputs and paginates", async () => {
  const input = { query: "sofa bed", locationSlug: "sydney", radiusKm: 65 };
  const demonstration = compileMarketplaceDemonstration([fixtureExchange(input.query)], input);
  assert.ok(demonstration);
  const seenVariables: unknown[] = [];
  const seenHeaders: Array<Record<string, string>> = [];
  const fakeContext = {
    request: {
      async fetch(_url: string, options: { data: string; headers: Record<string, string> }) {
        const form = new URLSearchParams(options.data);
        const variables = JSON.parse(form.get("variables")!) as { marketplace: { query: string; cursor: string | null } };
        seenVariables.push(variables);
        seenHeaders.push(options.headers);
        const firstPage = variables.marketplace.cursor === null;
        const body = fixtureBody(variables.marketplace.query, variables.marketplace.cursor, firstPage);
        return {
          status: () => 200,
          ok: () => true,
          text: async () => body,
        };
      },
    },
  } as unknown as BrowserContext;

  const result = await replayMarketplaceNetworkSearch(
    fakeContext,
    demonstration.plan,
    demonstration.runtimeExchange,
    { ...input, query: "fresh sofa" },
    10,
  );
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.listings.length, 4);
  assert.deepEqual(
    seenVariables.map((value) => (value as { marketplace: { cursor: string | null } }).marketplace.cursor),
    [null, "cursor-2"],
  );
  assert.equal(
    seenHeaders.some((headers) =>
      "cookie" in headers || "authorization" in headers || Object.keys(headers).some((name) => name.startsWith(":"))
    ),
    false,
  );
});

test("response drift fails instead of producing a plausible empty success", () => {
  const input = { query: "sofa bed", locationSlug: "sydney", radiusKm: 65 };
  const demonstration = compileMarketplaceDemonstration([fixtureExchange(input.query)], input);
  assert.ok(demonstration);
  assert.throws(
    () => extractMarketplaceNetworkResponse(JSON.stringify({ data: { changed: true } }), demonstration.plan),
    /no longer match|missing/i,
  );
});

test("profile lease enforces one active writer", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "clapping-hands-profile-"));
  const first = new ProfileLease(temporary, "fixture");
  const second = new ProfileLease(temporary, "fixture");
  try {
    await first.acquire();
    await assert.rejects(() => second.acquire(), ProfileInUseError);
    await first.release();
    await second.acquire();
  } finally {
    await first.release();
    await second.release();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("network response drift falls back to fresh DOM extraction", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "clapping-hands-fallback-"));
  try {
    const store = new MarketplacePlanStore(resolve(temporary, "plan.json"));
    const first = compileMarketplaceDemonstration(
      [fixtureExchange("sofa bed")],
      { query: "sofa bed", locationSlug: "sydney", radiusKm: 65 },
    );
    const second = compileMarketplaceDemonstration(
      [fixtureExchange("24 fret guitar")],
      { query: "24 fret guitar", locationSlug: "sydney", radiusKm: 65 },
    );
    assert.ok(first);
    assert.ok(second);
    let plan = await store.recordDemonstration(first);
    plan = await store.recordShadowValidation(plan, first.inputHash, true);
    plan = await store.recordDemonstration(second);
    plan = await store.recordShadowValidation(plan, second.inputHash, true);
    assert.equal(plan.status, "stable");

    let navigations = 0;
    const fakeBrowser = {
      network: {
        latest: () => [fixtureExchange("sofa bed")],
        mark: () => ({ exchangeIndex: 0, diagnosticIndex: 0 }),
        since: async () => [],
        diagnosticsSince: async () => ({
          candidateResponses: 0,
          capturedResponses: 0,
          outcomes: {},
          operations: [],
        }),
      },
      async state() {
        return {
          state: "authenticated",
          persistence: "persistent",
          profileId: "facebook-marketplace",
          canRetryWithoutHuman: true,
          challenge: null,
          safeSummary: "Authenticated fixture.",
          authenticated: true,
          hasLoginForm: false,
          currentUrl: "https://www.facebook.com/marketplace/",
        } as const;
      },
      async context() {
        return {
          request: {
            async fetch() {
              return {
                status: () => 200,
                ok: () => true,
                text: async () => JSON.stringify({ data: { shape_changed: true } }),
              };
            },
          },
        } as unknown as BrowserContext;
      },
      async goto() {
        navigations += 1;
      },
      async collectMarketplaceCards() {
        return {
          cards: [{
            href: "https://www.facebook.com/marketplace/item/123456/",
            ariaLabel: null,
            text: "AU$300\nFresh DOM sofa bed\nSydney, NSW",
            imageUrl: null,
            imageAlt: null,
          }],
          initialCards: [],
          counts: [1, 1, 1, 1],
          stabilized: true,
        };
      },
      async close() {},
    } as unknown as StagehandBrowser;
    const service = new MarketplaceSearchService(fakeBrowser, store);
    const result = await service.search({ query: "sofa bed", executionMode: "auto" });
    assert.equal(result.execution.level, "dom");
    assert.equal(result.execution.fallback.attemptedLevel, "network");
    assert.match(result.warnings.join(" "), /DOM fallback used/);
    assert.equal(result.totalListings, 1);
    assert.equal(navigations, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
