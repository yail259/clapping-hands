import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AuthStatus } from "../src/profile.js";
import type { MarketplaceExecutionMode, MarketplaceSearchResult } from "../src/search.js";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(projectRoot, ".data/marketplace-dogfood.json");
const profileDir = resolve(projectRoot, ".data/browser-profile");

async function connect(): Promise<Client> {
  const client = new Client({ name: "clapping-hands-dogfood", version: "0.0.1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, "dist/src/server.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      CLAPPING_HANDS_PROFILE_DIR: profileDir,
      CLAPPING_HANDS_HEADLESS: "false",
    },
    stderr: "inherit",
  }));
  return client;
}

async function auth(client: Client, open = false): Promise<AuthStatus> {
  const response = await client.callTool({
    name: open ? "facebook_marketplace_auth_open" : "facebook_marketplace_auth_status",
    arguments: {},
  });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return (response.structuredContent as { auth: AuthStatus }).auth;
}

async function search(client: Client, query: string, executionMode: MarketplaceExecutionMode, maxScrolls = 40) {
  const response = await client.callTool({
    name: "facebook_marketplace_search",
    arguments: { query, locationSlug: "sydney", radiusKm: 65, maxScrolls, executionMode },
  }, undefined, { timeout: 180_000 });
  if (response.isError) throw new Error(JSON.stringify(response.structuredContent ?? response.content));
  const result = response.structuredContent as MarketplaceSearchResult;
  process.stderr.write(
    `${query} [${executionMode}]: ${result.execution.durationMs}ms, level=${result.execution.level}, ` +
      `listings=${result.totalListings}, complete=${result.complete}, plan=${result.execution.planStatus}, ` +
      `networkPages=${result.execution.networkPages}, shadow=${result.execution.shadowValidation.passed}, ` +
      `overlap=${result.execution.shadowValidation.overlap ?? "n/a"}, ` +
      `networkComplete=${result.execution.shadowValidation.networkComplete ?? "n/a"}\n`,
  );
  if (result.execution.capture) {
    process.stderr.write(
      `  capture: candidates=${result.execution.capture.candidateResponses}, ` +
      `captured=${result.execution.capture.capturedResponses}, ` +
      `operations=${result.execution.capture.operations.join(",") || "none"}\n`,
    );
  }
  for (const warning of result.warnings) process.stderr.write(`  warning: ${warning}\n`);
  return result;
}

function waitForEnter(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveWait) => {
    readline.question(
      "Complete Facebook login or its checkpoint in the Clapping Hands Chrome window, then press Enter here.\n",
      () => {
        readline.close();
        resolveWait();
      },
    );
  });
}

function summary(result: MarketplaceSearchResult) {
  return {
    query: result.query,
    retrievedAt: result.retrievedAt,
    authenticated: result.authenticated,
    authPersistence: result.auth.persistence,
    complete: result.complete,
    totalListings: result.totalListings,
    execution: result.execution,
    listingIds: result.listings.map((listing) => listing.id),
    warnings: result.warnings,
  };
}

let client: Client | null = null;
let restartedClient: Client | null = null;
let cleaningUp = false;

async function cleanup(): Promise<void> {
  if (cleaningUp) return;
  cleaningUp = true;
  await client?.close().catch(() => {});
  await restartedClient?.close().catch(() => {});
  client = null;
  restartedClient = null;
}

function handleSignal(exitCode: number): void {
  void cleanup().finally(() => process.exit(exitCode));
}

process.once("SIGINT", () => handleSignal(130));
process.once("SIGTERM", () => handleSignal(143));

try {
  client = await connect();
  let authState = await auth(client);
  if (authState.state !== "authenticated") {
    authState = await auth(client, true);
    while (authState.state !== "authenticated") {
      process.stderr.write(`${authState.safeSummary}\n`);
      await waitForEnter();
      authState = await auth(client);
    }
  }

  const demonstrations = [
    await search(client, "sofa bed", "dom"),
    await search(client, "24 fret guitar", "dom"),
  ];
  const warmRuns = [
    await search(client, "sofa bed", "auto", 3),
    await search(client, "sofa bed", "auto", 3),
    await search(client, "sofa bed", "auto", 3),
  ];

  await client.close();
  client = null;
  await delay(1_000);

  restartedClient = await connect();
  const authAfterRestart = await auth(restartedClient);
  const restartedRun = authAfterRestart.state === "authenticated"
    ? await search(restartedClient, "sofa bed", "auto", 3)
    : null;

  const warmDurations = warmRuns.map((run) => run.execution.durationMs).sort((a, b) => a - b);
  const domDurations = demonstrations.map((run) => run.execution.durationMs).sort((a, b) => a - b);
  const warmMedian = warmDurations[Math.floor(warmDurations.length / 2)]!;
  const domMedian = domDurations.reduce((sum, duration) => sum + duration, 0) / domDurations.length;
  const report = {
    benchmarkedAt: new Date().toISOString(),
    authBefore: authState,
    authAfterRestart,
    demonstrations: demonstrations.map(summary),
    warmRuns: warmRuns.map(summary),
    restartedRun: restartedRun ? summary(restartedRun) : null,
    acceptance: {
      authenticationSurvivesRestart: authAfterRestart.state === "authenticated",
      twoDistinctDemonstrations: new Set(demonstrations.map((run) => run.query)).size === 2,
      twoShadowValidations: demonstrations.every((run) => run.execution.shadowValidation.passed),
      promoted: warmRuns.every((run) =>
        run.execution.planStatus === "stable" &&
        (run.execution.level === "network" || run.execution.level === "network-bootstrap")
      ),
      zeroModelCalls: [...demonstrations, ...warmRuns, ...(restartedRun ? [restartedRun] : [])]
        .every((run) => run.execution.modelCalls === 0),
      warmMedianMs: warmMedian,
      domMedianMs: domMedian,
      warmUnderThreeSeconds: warmMedian < 3_000,
      atLeastTwiceAsFast: warmMedian * 2 <= domMedian,
      restartUsesBootstrapNetwork: restartedRun?.execution.level === "network-bootstrap",
    },
  };

  await mkdir(resolve(projectRoot, ".data"), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`RESULT_PATH=${outputPath}\n`);
  process.stdout.write(`${JSON.stringify(report.acceptance, null, 2)}\n`);
  if (!Object.entries(report.acceptance)
    .filter(([name]) => !["warmMedianMs", "domMedianMs"].includes(name))
    .every(([, value]) => value === true)) process.exitCode = 1;
} finally {
  await cleanup();
}
