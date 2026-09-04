import type { BrowserContext } from "playwright-core";
import type { MarketplaceListing } from "./marketplace.js";
import {
  extractMarketplaceNetworkResponse,
  setAt,
  valueAt,
  type CapturedExchange,
  type MarketplaceNetworkPlan,
  type MarketplaceSearchParameters,
} from "./network-plan.js";

const OMITTED_REPLAY_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "origin",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
]);

function replayHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      !name.startsWith(":") && !OMITTED_REPLAY_HEADERS.has(name.toLowerCase())
    ),
  );
}

async function authenticatedFetch(
  context: BrowserContext,
  url: string,
  method: "POST",
  headers: Record<string, string>,
  data: string,
): Promise<{ status: number; ok: boolean; body: string }> {
  const page = typeof context.pages === "function"
    ? context.pages().find((candidate) => {
      try {
        return new URL(candidate.url()).origin === new URL(url).origin;
      } catch {
        return false;
      }
    })
    : null;

  if (page) {
    return page.evaluate(async ({ requestUrl, requestMethod, requestHeaders, requestBody }) => {
      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers: requestHeaders,
        body: requestBody,
        credentials: "include",
      });
      return { status: response.status, ok: response.ok, body: await response.text() };
    }, {
      requestUrl: url,
      requestMethod: method,
      requestHeaders: headers,
      requestBody: data,
    });
  }

  const response = await context.request.fetch(url, {
    method,
    headers,
    data,
    failOnStatusCode: false,
    timeout: 20_000,
  });
  return { status: response.status(), ok: response.ok(), body: await response.text() };
}

function templateMatches(
  plan: MarketplaceNetworkPlan,
  exchange: CapturedExchange,
  input?: MarketplaceSearchParameters,
): boolean {
  try {
    const url = new URL(exchange.url);
    const form = new URLSearchParams(exchange.requestBody);
    const encodedVariables = form.get(plan.request.variablesField);
    if (!encodedVariables) return false;
    const variables = JSON.parse(encodedVariables) as unknown;
    if (input && valueAt(variables, plan.request.bindings.query) !== input.query) return false;
    const capturedCursor = valueAt(variables, plan.request.bindings.cursor);
    if (plan.request.paginationStart === "captured" && typeof capturedCursor !== "string") return false;
    return (
      url.origin === plan.origin &&
      url.pathname === plan.request.endpointPath &&
      exchange.method === plan.request.method &&
      (!plan.request.operation.docId || form.get("doc_id") === plan.request.operation.docId) &&
      (!plan.request.operation.friendlyName ||
        form.get("fb_api_req_friendly_name") === plan.request.operation.friendlyName)
    );
  } catch {
    return false;
  }
}

export function selectRuntimeExchange(
  plan: MarketplaceNetworkPlan,
  exchanges: CapturedExchange[],
  input?: MarketplaceSearchParameters,
): CapturedExchange | null {
  return exchanges.find((exchange) => templateMatches(plan, exchange, input)) ?? null;
}

export async function replayMarketplaceNetworkSearch(
  context: BrowserContext,
  plan: MarketplaceNetworkPlan,
  exchange: CapturedExchange,
  input: MarketplaceSearchParameters,
  maximumPages: number,
): Promise<{
  listings: MarketplaceListing[];
  complete: boolean;
  pages: number;
  responseStatuses: number[];
}> {
  if (!templateMatches(plan, exchange)) throw new Error("Live request does not match the compiled plan.");
  const sourceForm = new URLSearchParams(exchange.requestBody);
  const encodedVariables = sourceForm.get(plan.request.variablesField);
  if (!encodedVariables) throw new Error("Live request is missing GraphQL variables.");
  const baseVariables = JSON.parse(encodedVariables) as unknown;
  const listings: MarketplaceListing[] = [];
  const responseStatuses: number[] = [];
  const seenCursors = new Set<string>();
  const capturedCursor = valueAt(baseVariables, plan.request.bindings.cursor);
  let cursor: string | null = plan.request.paginationStart === "captured"
    ? typeof capturedCursor === "string" ? capturedCursor : null
    : null;
  if (plan.request.paginationStart === "captured" && !cursor) {
    throw new Error("Live pagination request is missing its captured starting cursor.");
  }
  let complete = false;
  let pages = 0;

  const pageLimit = Math.max(1, Math.min(maximumPages, plan.validation.maximumPages));
  while (pages < pageLimit) {
    const variables = structuredClone(baseVariables);
    if (!setAt(variables, plan.request.bindings.query, input.query)) {
      throw new Error("Compiled query binding no longer matches the live request.");
    }
    if (!setAt(variables, plan.request.bindings.cursor, cursor)) {
      throw new Error("Compiled cursor binding no longer matches the live request.");
    }
    if (
      plan.request.bindings.radiusKm &&
      !setAt(variables, plan.request.bindings.radiusKm, input.radiusKm)
    ) {
      throw new Error("Compiled radius binding no longer matches the live request.");
    }

    const form = new URLSearchParams(sourceForm);
    form.set(plan.request.variablesField, JSON.stringify(variables));
    const response = await authenticatedFetch(
      context,
      exchange.url,
      plan.request.method,
      replayHeaders(exchange.requestHeaders),
      form.toString(),
    );
    responseStatuses.push(response.status);
    if (!response.ok) throw new Error(`Compiled network request returned HTTP ${response.status}.`);
    const extracted = extractMarketplaceNetworkResponse(response.body, plan);
    listings.push(...extracted.listings);
    pages += 1;

    if (!extracted.hasNextPage) {
      complete = true;
      break;
    }
    if (!extracted.endCursor || seenCursors.has(extracted.endCursor)) {
      throw new Error("Compiled network pagination returned a missing or repeated cursor.");
    }
    seenCursors.add(extracted.endCursor);
    cursor = extracted.endCursor;
  }

  const unique = [...new Map(listings.map((listing) => [listing.id, listing])).values()];
  if (unique.length < plan.validation.minimumListings) {
    throw new Error(`Compiled network result contained only ${unique.length} valid listings.`);
  }

  return { listings: unique, complete, pages, responseStatuses };
}
