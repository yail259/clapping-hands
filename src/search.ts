import { performance } from "node:perf_hooks";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deduplicateListings, type MarketplaceListing } from "./marketplace.js";
import {
  compareListingIds,
  compileMarketplaceDemonstration,
  MarketplacePlanStore,
  type MarketplaceNetworkPlan,
} from "./network-plan.js";
import { replayMarketplaceNetworkSearch, selectRuntimeExchange } from "./network-replay.js";
import { AuthRequiredError, type AuthStatus } from "./profile.js";
import { StagehandBrowser } from "./stagehand-browser.js";
import type { NetworkCaptureSummary } from "./network-recorder.js";

const SHADOW_MAXIMUM_PAGES = 10;

export type MarketplaceExecutionMode = "auto" | "dom" | "network";

export type MarketplaceSearchInput = {
  query: string;
  locationSlug?: string;
  radiusKm?: number;
  maxScrolls?: number;
  executionMode?: MarketplaceExecutionMode;
};

export type MarketplaceExecutionEvidence = {
  level: "dom" | "network" | "network-bootstrap";
  durationMs: number;
  modelCalls: 0;
  browserNavigations: number;
  scrollIterations: number;
  networkPages: number;
  planStatus: MarketplaceNetworkPlan["status"] | "none";
  planVersion: number | null;
  shadowValidation: {
    attempted: boolean;
    passed: boolean;
    overlap: number | null;
    uiCount: number | null;
    networkCount: number | null;
    networkComplete: boolean | null;
  };
  fallback: {
    attemptedLevel: "network" | null;
    safeReason: string | null;
  };
  capture: NetworkCaptureSummary | null;
};

export type MarketplaceSearchResult = {
  query: string;
  location: string;
  radiusKm: number;
  sourceUrl: string;
  retrievedAt: string;
  auth: AuthStatus;
  authenticated: boolean;
  complete: boolean;
  totalListings: number;
  countsWhileScrolling: number[];
  listings: MarketplaceListing[];
  warnings: string[];
  execution: MarketplaceExecutionEvidence;
};

function planPath(): string {
  const configured = process.env.CLAPPING_HANDS_MARKETPLACE_PLAN ?? ".data/plans/facebook-marketplace-search.json";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 300);
}

function mergeListings(...groups: MarketplaceListing[][]): MarketplaceListing[] {
  return [...new Map(groups.flat().map((listing) => [listing.id, listing])).values()];
}

export class MarketplaceSearchService {
  private readonly plans: MarketplacePlanStore;

  constructor(
    private readonly browser = new StagehandBrowser(),
    plans = new MarketplacePlanStore(planPath()),
  ) {
    this.plans = plans;
  }

  async authStatus(): Promise<AuthStatus> {
    const state = await this.browser.state();
    return {
      state: state.state,
      persistence: state.persistence,
      profileId: state.profileId,
      canRetryWithoutHuman: state.canRetryWithoutHuman,
      challenge: state.challenge,
      safeSummary: state.safeSummary,
    };
  }

  async compilationStatus(): Promise<{
    status: MarketplaceNetworkPlan["status"] | "none";
    version: number | null;
    demonstrations: number;
    successfulShadows: number;
    consecutiveRuntimeFailures: number;
    promotedAt: string | null;
    lastValidatedAt: string | null;
  }> {
    const plan = await this.plans.load();
    return {
      status: plan?.status ?? "none",
      version: plan?.version ?? null,
      demonstrations: plan?.evidence.demonstrationInputHashes.length ?? 0,
      successfulShadows: plan?.evidence.successfulShadowInputHashes.length ?? 0,
      consecutiveRuntimeFailures: plan?.evidence.consecutiveRuntimeFailures ?? 0,
      promotedAt: plan?.evidence.promotedAt ?? null,
      lastValidatedAt: plan?.evidence.lastValidatedAt ?? null,
    };
  }

  async openAuthentication(): Promise<AuthStatus> {
    const state = await this.browser.openAuthentication();
    return {
      state: state.state,
      persistence: state.persistence,
      profileId: state.profileId,
      canRetryWithoutHuman: state.canRetryWithoutHuman,
      challenge: state.challenge,
      safeSummary: state.safeSummary,
    };
  }

  async search(input: MarketplaceSearchInput): Promise<MarketplaceSearchResult> {
    const startedAt = performance.now();
    const query = input.query.trim();
    if (!query) throw new Error("query must not be empty");

    const locationSlug = (input.locationSlug ?? "sydney").toLowerCase();
    if (!/^[a-z0-9-]+$/.test(locationSlug)) throw new Error("locationSlug contains unsupported characters");

    const radiusKm = Math.min(Math.max(input.radiusKm ?? 65, 1), 500);
    const maxScrolls = Math.min(Math.max(input.maxScrolls ?? 40, 1), 100);
    const executionMode = input.executionMode ?? "auto";
    const url = new URL(`https://www.facebook.com/marketplace/${locationSlug}/search/`);
    url.searchParams.set("query", query);
    url.searchParams.set("exact", "false");
    url.searchParams.set("radius", String(radiusKm));
    url.searchParams.set("category_id", "1078592699170502");
    const parameters = { query, locationSlug, radiusKm };
    let plan = await this.plans.load();
    let fallbackReason: string | null = null;

    if (executionMode !== "dom") {
      if (plan?.status === "stable" || (executionMode === "network" && plan && plan.status !== "degraded")) {
        let exchange = plan.request.paginationStart === "captured"
          ? null
          : selectRuntimeExchange(plan, this.browser.network.latest(), parameters);
        let level: MarketplaceExecutionEvidence["level"] = "network";
        let browserNavigations = 0;
        let scrollIterations = 0;
        let bootstrapListings: MarketplaceListing[] = [];
        let bootstrapCapture: NetworkCaptureSummary | null = null;

        if (plan.request.paginationStart === "captured") {
          const mark = this.browser.network.mark();
          await this.browser.goto(url.toString(), 300);
          browserNavigations = 1;
          level = "network-bootstrap";
          const state = await this.browser.state();
          if (!state.authenticated) throw new AuthRequiredError(state);
          bootstrapListings = deduplicateListings(await this.browser.snapshotMarketplaceCards());
          for (let attempt = 0; attempt < 3 && !exchange; attempt += 1) {
            await this.browser.scrollMarketplaceOnce(200);
            scrollIterations += 1;
            for (let poll = 0; poll < 20 && !exchange; poll += 1) {
              exchange = selectRuntimeExchange(plan, this.browser.network.peekSince(mark), parameters);
              if (!exchange) await delay(50);
            }
          }
          bootstrapCapture = this.browser.network.diagnosticSnapshotSince(mark);
        } else if (!exchange) {
          const mark = this.browser.network.mark();
          await this.browser.goto(url.toString(), 750);
          browserNavigations = 1;
          level = "network-bootstrap";
          const state = await this.browser.state();
          if (!state.authenticated) throw new AuthRequiredError(state);
          exchange = selectRuntimeExchange(plan, await this.browser.network.since(mark), parameters);
          bootstrapCapture = await this.browser.network.diagnosticsSince(mark);
        }

        try {
          if (!exchange) throw new Error("No current authenticated request matched the compiled plan.");
          const auth = await this.authStatus();
          if (auth.state !== "authenticated") throw new AuthRequiredError(auth);
          const replay = await replayMarketplaceNetworkSearch(
            await this.browser.context(),
            plan,
            exchange,
            parameters,
            maxScrolls,
          );
          const combinedListings = mergeListings(bootstrapListings, replay.listings);
          plan = await this.plans.recordRuntimeSuccess(plan);
          const warnings = replay.complete
            ? []
            : ["Compiled network pagination reached the configured page cap; additional listings may exist."];
          return {
            query,
            location: locationSlug,
            radiusKm,
            sourceUrl: url.toString(),
            retrievedAt: new Date().toISOString(),
            auth,
            authenticated: true,
            complete: replay.complete,
            totalListings: combinedListings.length,
            countsWhileScrolling: bootstrapListings.length > 0 ? [bootstrapListings.length] : [],
            listings: combinedListings,
            warnings,
            execution: {
              level,
              durationMs: Math.round(performance.now() - startedAt),
              modelCalls: 0,
              browserNavigations,
              scrollIterations,
              networkPages: replay.pages,
              planStatus: plan.status,
              planVersion: plan.version,
              shadowValidation: {
                attempted: false,
                passed: false,
                overlap: null,
                uiCount: null,
                networkCount: null,
                networkComplete: null,
              },
              fallback: { attemptedLevel: null, safeReason: null },
              capture: bootstrapCapture,
            },
          };
        } catch (error) {
          if (error instanceof AuthRequiredError) throw error;
          plan = await this.plans.recordRuntimeFailure(plan);
          fallbackReason = safeFailureReason(error);
          if (executionMode === "network") throw error;
        }
      } else if (executionMode === "network") {
        throw new Error("No validated Marketplace network plan is available.");
      }
    }

    const mark = this.browser.network.mark();
    await this.browser.goto(url.toString());
    const pageState = await this.browser.state();
    if (!pageState.authenticated) throw new AuthRequiredError(pageState);
    const collection = await this.browser.collectMarketplaceCards(maxScrolls);
    const listings = deduplicateListings(collection.cards);
    const warnings: string[] = [];
    if (!collection.stabilized) {
      warnings.push("Result loading did not stabilize before maxScrolls; additional listings may exist.");
    }
    if (fallbackReason) warnings.push(`Network replay failed validation; fresh DOM fallback used: ${fallbackReason}`);

    const exchanges = await this.browser.network.since(mark);
    const capture = await this.browser.network.diagnosticsSince(mark);
    const demonstration = compileMarketplaceDemonstration(exchanges, parameters);
    let shadow: MarketplaceExecutionEvidence["shadowValidation"] = {
      attempted: false,
      passed: false,
      overlap: null,
      uiCount: null,
      networkCount: null,
      networkComplete: null,
    };
    let shadowPages = 0;
    if (demonstration) {
      plan = await this.plans.recordDemonstration(demonstration);
      shadow.attempted = true;
      try {
        const replay = await replayMarketplaceNetworkSearch(
          await this.browser.context(),
          plan,
          demonstration.runtimeExchange,
          parameters,
          Math.min(maxScrolls, SHADOW_MAXIMUM_PAGES),
        );
        shadowPages = replay.pages;
        const observedWindow = collection.snapshots.slice(0, replay.pages + 1).flat();
        const initialListings = deduplicateListings(collection.initialCards);
        const shadowListings = mergeListings(initialListings, replay.listings);
        const comparison = compareListingIds(deduplicateListings(observedWindow), shadowListings);
        const passed = comparison.overlap >= plan.validation.minimumIdOverlap;
        shadow = {
          attempted: true,
          passed,
          overlap: comparison.overlap,
          uiCount: comparison.uiCount,
          networkCount: comparison.networkCount,
          networkComplete: replay.complete,
        };
        plan = await this.plans.recordShadowValidation(plan, demonstration.inputHash, passed);
        if (!passed) warnings.push("A read-only network candidate was observed, but shadow equivalence did not pass.");
        if (!replay.complete) {
          warnings.push(
            "Network shadow reached the configured page cap; equivalence used observed IDs and completeness remains false.",
          );
        }
      } catch (error) {
        plan = await this.plans.recordShadowValidation(plan, demonstration.inputHash, false);
        warnings.push(`A read-only network candidate was observed, but shadow replay failed: ${safeFailureReason(error)}`);
      }
    } else {
      warnings.push(
        "No promotable Marketplace network request was identified in this DOM run. " +
        `Capture candidates=${capture.candidateResponses}, captured=${capture.capturedResponses}, ` +
        `outcomes=${JSON.stringify(capture.outcomes)}, operations=${capture.operations.join(",") || "none"}.`,
      );
    }

    return {
      query,
      location: locationSlug,
      radiusKm,
      sourceUrl: url.toString(),
      retrievedAt: new Date().toISOString(),
      auth: {
        state: pageState.state,
        persistence: pageState.persistence,
        profileId: pageState.profileId,
        canRetryWithoutHuman: pageState.canRetryWithoutHuman,
        challenge: pageState.challenge,
        safeSummary: pageState.safeSummary,
      },
      authenticated: true,
      complete: collection.stabilized,
      totalListings: listings.length,
      countsWhileScrolling: collection.counts,
      listings,
      warnings,
      execution: {
        level: "dom",
        durationMs: Math.round(performance.now() - startedAt),
        modelCalls: 0,
        browserNavigations: 1,
        scrollIterations: Math.max(collection.counts.length - 1, 0),
        networkPages: shadowPages,
        planStatus: plan?.status ?? "none",
        planVersion: plan?.version ?? null,
        shadowValidation: shadow,
        fallback: { attemptedLevel: fallbackReason ? "network" : null, safeReason: fallbackReason },
        capture,
      },
    };
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
