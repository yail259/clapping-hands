import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyFretEvidence, type MarketplaceListing } from "./marketplace.js";

export type JsonPath = Array<string | number>;

export type CapturedExchange = {
  url: string;
  method: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseBody: string;
};

export type MarketplaceSearchParameters = {
  query: string;
  locationSlug: string;
  radiusKm: number;
};

export type MarketplaceNetworkPlan = {
  formatVersion: "clapping-hands.dev/v1alpha1";
  action: "facebook_marketplace_search";
  version: number;
  effect: "read";
  origin: string;
  status: "candidate" | "provisional" | "stable" | "degraded";
  request: {
    method: "POST";
    endpointPath: string;
    operation: {
      docId: string | null;
      friendlyName: string | null;
    };
    variablesField: "variables";
    bindings: {
      query: JsonPath;
      cursor: JsonPath;
      radiusKm: JsonPath | null;
    };
    paginationStart: "null" | "captured";
  };
  response: {
    documentIndex: number;
    edges: JsonPath;
    listing: JsonPath;
    pageInfo: JsonPath;
    fields: {
      id: JsonPath;
      title: JsonPath;
      price: JsonPath | null;
      previousPrice: JsonPath | null;
      location: JsonPath | null;
      imageUrl: JsonPath | null;
    };
  };
  validation: {
    minimumListings: number;
    minimumIdOverlap: number;
    maximumPages: number;
  };
  evidence: {
    demonstrationInputHashes: string[];
    successfulShadowInputHashes: string[];
    failedShadowCount: number;
    consecutiveRuntimeFailures: number;
    promotedAt: string | null;
    lastValidatedAt: string | null;
  };
};

export type CompiledNetworkDemonstration = {
  plan: MarketplaceNetworkPlan;
  inputHash: string;
  listingCount: number;
  runtimeExchange: CapturedExchange;
};

type ResponseLayout = MarketplaceNetworkPlan["response"] & { listingCount: number };

const FORBIDDEN_PERSISTED_KEYS = /(?:cookie|authorization|token|csrf|dtsg|jazoest|\blsd\b|session|password|secret)/i;

export function hashSearchInput(input: MarketplaceSearchParameters): string {
  return createHash("sha256")
    .update(JSON.stringify({
      query: input.query,
      locationSlug: input.locationSlug,
      radiusKm: input.radiusKm,
    }))
    .digest("hex");
}

export function valueAt(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

export function setAt(root: unknown, path: JsonPath, value: unknown): boolean {
  if (path.length === 0) return false;
  let current = root;
  for (const segment of path.slice(0, -1)) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (current === null || typeof current !== "object") return false;
  (current as Record<string | number, unknown>)[path.at(-1)!] = value;
  return true;
}

function walk(root: unknown, visit: (value: unknown, path: JsonPath) => void, path: JsonPath = []): void {
  visit(root, path);
  if (Array.isArray(root)) {
    root.forEach((value, index) => walk(value, visit, [...path, index]));
    return;
  }
  if (root && typeof root === "object") {
    for (const [key, value] of Object.entries(root)) walk(value, visit, [...path, key]);
  }
}

function pathsMatching(root: unknown, predicate: (value: unknown, key: string | number | undefined) => boolean): JsonPath[] {
  const paths: JsonPath[] = [];
  walk(root, (value, path) => {
    if (predicate(value, path.at(-1))) paths.push(path);
  });
  return paths;
}

function firstFieldPath(
  root: unknown,
  names: RegExp[],
  predicate: (value: unknown) => boolean = (value) => typeof value === "string",
): JsonPath | null {
  const matches = pathsMatching(root, (value, key) =>
    typeof key === "string" && names.some((name) => name.test(key)) && predicate(value),
  );
  return matches.sort((left, right) => left.length - right.length)[0] ?? null;
}

function looksLikeListing(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const title = firstFieldPath(value, [/^marketplace_listing_title$/i, /^custom_title$/i]);
  const id = firstFieldPath(value, [/^(?:id|listing_id)$/i], (candidate) =>
    typeof candidate === "string" && /^\d{5,}$/.test(candidate),
  );
  return Boolean(title && id);
}

function findListingPath(root: unknown): JsonPath | null {
  let best: JsonPath | null = null;
  walk(root, (value, path) => {
    if (looksLikeListing(value) && (!best || path.length < best.length)) best = path;
  });
  return best;
}

function findListingPathAcrossEdges(edges: unknown[]): {
  path: JsonPath;
  sample: unknown;
  listingCount: number;
} | null {
  const candidates = new Map<string, { path: JsonPath; sample: unknown; listingCount: number }>();

  for (const edge of edges) {
    const path = findListingPath(edge);
    if (!path) continue;
    const key = JSON.stringify(path);
    const current = candidates.get(key);
    if (current) {
      current.listingCount += 1;
    } else {
      candidates.set(key, { path, sample: valueAt(edge, path), listingCount: 1 });
    }
  }

  return [...candidates.values()].sort((left, right) =>
    right.listingCount - left.listingCount || left.path.length - right.path.length
  )[0] ?? null;
}

export function parseJsonDocuments(body: string): unknown[] {
  const normalized = body.trim().replace(/^for\s*\(;;\);\s*/, "");
  if (!normalized) return [];

  try {
    return [JSON.parse(normalized) as unknown];
  } catch {
    const documents: unknown[] = [];
    for (const line of normalized.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const candidate = line.replace(/^for\s*\(;;\);\s*/, "");
      try {
        documents.push(JSON.parse(candidate) as unknown);
      } catch {
        // Facebook may interleave non-JSON streaming markers. They are ignored;
        // the response layout validator still requires listings and pagination.
      }
    }
    return documents;
  }
}

function safeJsonShape(body: string): string {
  const shapes = new Set<string>();
  for (const [documentIndex, document] of parseJsonDocuments(body).entries()) {
    walk(document, (value, path) => {
      if (path.length === 0 || path.length > 6 || shapes.size >= 40) return;
      const safeSegments = path.map((segment) => {
        if (typeof segment === "number") return "[]";
        return /^[A-Za-z_][A-Za-z0-9_]{0,64}$/.test(segment) ? segment : "?";
      });
      const kind = Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : typeof value;
      shapes.add(`${documentIndex}:${safeSegments.join(".")}:${kind}`);
    });
  }
  return [...shapes].join(",") || "empty-or-unparseable";
}

function discoverResponseLayout(body: string): ResponseLayout | null {
  const documents = parseJsonDocuments(body);
  let best: ResponseLayout | null = null;

  documents.forEach((document, documentIndex) => {
    walk(document, (value, path) => {
      if (!Array.isArray(value) || value.length === 0) return;
      const listingCandidate = findListingPathAcrossEdges(value);
      if (!listingCandidate) return;
      const listingPath = listingCandidate.path;
      const listingCount = listingCandidate.listingCount;
      if (listingCount === 0 || (best && best.listingCount >= listingCount)) return;

      const containerPath = path.slice(0, -1);
      const container = valueAt(document, containerPath);
      const pageInfoRelative = firstFieldPath(
        container,
        [/^page_info$/i],
        (candidate) => Boolean(candidate && typeof candidate === "object"),
      );
      if (!pageInfoRelative) return;
      const pageInfo = valueAt(container, pageInfoRelative);
      const hasNext = firstFieldPath(pageInfo, [/^has_next_page$/i], (candidate) => typeof candidate === "boolean");
      const cursor = firstFieldPath(pageInfo, [/^(?:end_cursor|cursor)$/i], (candidate) =>
        candidate === null || typeof candidate === "string",
      );
      if (!hasNext || !cursor) return;

      const listing = listingCandidate.sample;
      const id = firstFieldPath(listing, [/^(?:id|listing_id)$/i], (candidate) =>
        typeof candidate === "string" && /^\d{5,}$/.test(candidate),
      );
      const title = firstFieldPath(listing, [/^marketplace_listing_title$/i, /^custom_title$/i]);
      if (!id || !title) return;

      best = {
        documentIndex,
        edges: path,
        listing: listingPath,
        pageInfo: [...containerPath, ...pageInfoRelative],
        fields: {
          id,
          title,
          price: firstFieldPath(listing, [/^formatted_amount$/i, /^price_text$/i]),
          previousPrice: firstFieldPath(listing, [/^strikethrough_price$/i, /^previous_price$/i]),
          location: firstFieldPath(listing, [/^display_name$/i, /^location_text$/i]),
          imageUrl: firstFieldPath(listing, [/^(?:uri|image_url)$/i], (candidate) =>
            typeof candidate === "string" && /^(?:https?:|data:)/.test(candidate),
          ),
        },
        listingCount,
      };
    });
  });

  return best;
}

function parseGraphqlRequest(exchange: CapturedExchange): {
  form: URLSearchParams;
  variables: unknown;
  docId: string | null;
  friendlyName: string | null;
} | null {
  if (exchange.method !== "POST" || exchange.responseStatus < 200 || exchange.responseStatus >= 300) return null;
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(exchange.requestBody);
  } catch {
    return null;
  }
  const encodedVariables = form.get("variables");
  if (!encodedVariables) return null;
  try {
    return {
      form,
      variables: JSON.parse(encodedVariables) as unknown,
      docId: form.get("doc_id"),
      friendlyName: form.get("fb_api_req_friendly_name"),
    };
  } catch {
    return null;
  }
}

function networkPlanSignature(plan: MarketplaceNetworkPlan): string {
  return JSON.stringify({
    request: plan.request,
    response: plan.response,
  });
}

export function compileMarketplaceDemonstration(
  exchanges: CapturedExchange[],
  input: MarketplaceSearchParameters,
  expectedOrigin = "https://www.facebook.com",
): CompiledNetworkDemonstration | null {
  const candidates: Array<CompiledNetworkDemonstration & { score: number; exchangeIndex: number }> = [];

  for (const [exchangeIndex, exchange] of exchanges.entries()) {
    let url: URL;
    try {
      url = new URL(exchange.url);
    } catch {
      continue;
    }
    if (url.origin !== expectedOrigin || !/\/api\/graphql\/?$/.test(url.pathname)) continue;

    const request = parseGraphqlRequest(exchange);
    const response = discoverResponseLayout(exchange.responseBody);
    if (!request || !response) continue;

    const query = pathsMatching(request.variables, (value) => value === input.query)
      .sort((left, right) => left.length - right.length)[0];
    const cursor = pathsMatching(request.variables, (value, key) =>
      typeof key === "string" && /cursor/i.test(key) && (value === null || typeof value === "string"),
    ).sort((left, right) => left.length - right.length)[0];
    if (!query || !cursor) continue;

    const radiusKm = pathsMatching(request.variables, (value, key) =>
      typeof key === "string" && /radius/i.test(key) && Number(value) === input.radiusKm,
    ).sort((left, right) => left.length - right.length)[0] ?? null;

    const plan: MarketplaceNetworkPlan = {
      formatVersion: "clapping-hands.dev/v1alpha1",
      action: "facebook_marketplace_search",
      version: 1,
      effect: "read",
      origin: expectedOrigin,
      status: "candidate",
      request: {
        method: "POST",
        endpointPath: url.pathname,
        operation: { docId: request.docId, friendlyName: request.friendlyName },
        variablesField: "variables",
        bindings: { query, cursor, radiusKm },
        paginationStart: valueAt(request.variables, cursor) === null ? "null" : "captured",
      },
      response: {
        documentIndex: response.documentIndex,
        edges: response.edges,
        listing: response.listing,
        pageInfo: response.pageInfo,
        fields: response.fields,
      },
      validation: {
        minimumListings: 1,
        minimumIdOverlap: 0.7,
        maximumPages: 40,
      },
      evidence: {
        demonstrationInputHashes: [],
        successfulShadowInputHashes: [],
        failedShadowCount: 0,
        consecutiveRuntimeFailures: 0,
        promotedAt: null,
        lastValidatedAt: null,
      },
    };

    candidates.push({
      plan,
      inputHash: hashSearchInput(input),
      listingCount: response.listingCount,
      runtimeExchange: exchange,
      score: response.listingCount + (radiusKm ? 5 : 0) + (request.friendlyName ? 2 : 0),
      exchangeIndex,
    });
  }

  return candidates.sort((left, right) => {
    if (left.plan.request.paginationStart === "captured" && right.plan.request.paginationStart === "captured") {
      return left.exchangeIndex - right.exchangeIndex;
    }
    return right.score - left.score;
  })[0] ?? null;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const formatted = firstFieldPath(value, [/^formatted_amount$/i, /^display_name$/i], (candidate) =>
      typeof candidate === "string" || typeof candidate === "number",
    );
    if (formatted) return scalarText(valueAt(value, formatted));
  }
  return null;
}

function marketplaceListingFromNode(node: unknown, plan: MarketplaceNetworkPlan): MarketplaceListing | null {
  const id = scalarText(valueAt(node, plan.response.fields.id));
  const title = scalarText(valueAt(node, plan.response.fields.title));
  if (!id || !title || !/^\d{5,}$/.test(id)) return null;
  const price = plan.response.fields.price ? scalarText(valueAt(node, plan.response.fields.price)) : null;
  const previousPrice = plan.response.fields.previousPrice
    ? scalarText(valueAt(node, plan.response.fields.previousPrice))
    : null;
  const location = plan.response.fields.location ? scalarText(valueAt(node, plan.response.fields.location)) : null;
  const imageUrl = plan.response.fields.imageUrl ? scalarText(valueAt(node, plan.response.fields.imageUrl)) : null;
  const classification = classifyFretEvidence(title);
  return {
    id,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title,
    price,
    previousPrice,
    location,
    imageUrl,
    fretConfidence: classification.confidence,
    evidence: classification.evidence,
    rawText: [price, previousPrice, title, location].filter(Boolean).join("\n"),
  };
}

export function extractMarketplaceNetworkResponse(
  body: string,
  plan: MarketplaceNetworkPlan,
): {
  listings: MarketplaceListing[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const documents = parseJsonDocuments(body);
  const document = documents[plan.response.documentIndex];
  if (!document) throw new Error("Compiled response document is missing.");
  const edges = valueAt(document, plan.response.edges);
  const pageInfo = valueAt(document, plan.response.pageInfo);
  if (!Array.isArray(edges) || !pageInfo || typeof pageInfo !== "object") {
    throw new Error(`Compiled Marketplace response paths no longer match. Safe shape=${safeJsonShape(body)}`);
  }

  const listings = edges.flatMap((edge) => {
    const listingNode = valueAt(edge, plan.response.listing);
    const listing = marketplaceListingFromNode(listingNode, plan);
    return listing ? [listing] : [];
  });
  const hasNextPath = firstFieldPath(pageInfo, [/^has_next_page$/i], (value) => typeof value === "boolean");
  const cursorPath = firstFieldPath(pageInfo, [/^(?:end_cursor|cursor)$/i], (value) =>
    value === null || typeof value === "string",
  );
  if (!hasNextPath || !cursorPath) throw new Error("Compiled pagination fields no longer match.");

  return {
    listings,
    hasNextPage: valueAt(pageInfo, hasNextPath) === true,
    endCursor: scalarText(valueAt(pageInfo, cursorPath)),
  };
}

export function compareListingIds(ui: MarketplaceListing[], network: MarketplaceListing[]): {
  overlap: number;
  matched: number;
  uiCount: number;
  networkCount: number;
} {
  const uiIds = new Set(ui.map((listing) => listing.id));
  const networkIds = new Set(network.map((listing) => listing.id));
  const matched = [...uiIds].filter((id) => networkIds.has(id)).length;
  return {
    overlap: uiIds.size === 0 ? 0 : matched / uiIds.size,
    matched,
    uiCount: uiIds.size,
    networkCount: networkIds.size,
  };
}

export class MarketplacePlanStore {
  constructor(private readonly path: string) {}

  async load(): Promise<MarketplaceNetworkPlan | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as MarketplaceNetworkPlan;
      if (parsed.formatVersion !== "clapping-hands.dev/v1alpha1" || parsed.action !== "facebook_marketplace_search") {
        throw new Error("Unsupported Marketplace plan format.");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async recordDemonstration(candidate: CompiledNetworkDemonstration): Promise<MarketplaceNetworkPlan> {
    const current = await this.load();
    let plan = candidate.plan;
    if (current && networkPlanSignature(current) === networkPlanSignature(candidate.plan)) {
      plan = current;
    } else if (current) {
      plan.version = current.version + 1;
    }
    if (!plan.evidence.demonstrationInputHashes.includes(candidate.inputHash)) {
      plan.evidence.demonstrationInputHashes.push(candidate.inputHash);
    }
    plan.status = plan.evidence.demonstrationInputHashes.length >= 2 ? "provisional" : "candidate";
    await this.save(plan);
    return plan;
  }

  async recordShadowValidation(
    plan: MarketplaceNetworkPlan,
    inputHash: string,
    success: boolean,
  ): Promise<MarketplaceNetworkPlan> {
    if (success) {
      if (!plan.evidence.successfulShadowInputHashes.includes(inputHash)) {
        plan.evidence.successfulShadowInputHashes.push(inputHash);
      }
      plan.evidence.consecutiveRuntimeFailures = 0;
      plan.evidence.lastValidatedAt = new Date().toISOString();
    } else {
      plan.evidence.failedShadowCount += 1;
    }
    const enoughDemonstrations = plan.evidence.demonstrationInputHashes.length >= 2;
    const enoughShadows = plan.evidence.successfulShadowInputHashes.length >= 2;
    if (enoughDemonstrations && enoughShadows) {
      plan.status = "stable";
      plan.evidence.promotedAt ??= new Date().toISOString();
    } else {
      plan.status = enoughDemonstrations ? "provisional" : "candidate";
    }
    await this.save(plan);
    return plan;
  }

  async recordRuntimeFailure(plan: MarketplaceNetworkPlan): Promise<MarketplaceNetworkPlan> {
    plan.evidence.consecutiveRuntimeFailures += 1;
    if (plan.evidence.consecutiveRuntimeFailures >= 2) plan.status = "degraded";
    await this.save(plan);
    return plan;
  }

  async recordRuntimeSuccess(plan: MarketplaceNetworkPlan): Promise<MarketplaceNetworkPlan> {
    plan.evidence.consecutiveRuntimeFailures = 0;
    plan.evidence.lastValidatedAt = new Date().toISOString();
    await this.save(plan);
    return plan;
  }

  private async save(plan: MarketplaceNetworkPlan): Promise<void> {
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;
    if (FORBIDDEN_PERSISTED_KEYS.test(serialized)) {
      const unsafeKeys = Object.keys(plan).filter((key) => FORBIDDEN_PERSISTED_KEYS.test(key));
      if (unsafeKeys.length > 0) throw new Error("Refusing to persist unsafe network-plan fields.");
      // The fixed word "operation" etc. is safe; only inspect JSON keys below.
      const parsed = JSON.parse(serialized) as unknown;
      let unsafe = false;
      walk(parsed, (_value, path) => {
        const key = path.at(-1);
        if (typeof key === "string" && FORBIDDEN_PERSISTED_KEYS.test(key)) unsafe = true;
      });
      if (unsafe) throw new Error("Refusing to persist authentication or secret fields in a network plan.");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export function plansAreCompatible(left: MarketplaceNetworkPlan, right: MarketplaceNetworkPlan): boolean {
  return networkPlanSignature(left) === networkPlanSignature(right);
}
