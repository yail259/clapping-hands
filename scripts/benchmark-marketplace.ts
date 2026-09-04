import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AuthStatus } from "../src/profile.js";
import type { MarketplaceSearchResult } from "../src/search.js";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(projectRoot, ".data/marketplace-benchmark.json");
const profileDir = resolve(projectRoot, ".data/browser-profile");
const query = process.argv.slice(2).join(" ").trim() || "sofa bed";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(projectRoot, "dist/src/server.js")],
  cwd: projectRoot,
  env: {
    ...process.env,
    CLAPPING_HANDS_PROFILE_DIR: profileDir,
    CLAPPING_HANDS_HEADLESS: "false",
  },
  stderr: "inherit",
});
const client = new Client({ name: "clapping-hands-benchmark", version: "0.0.1" });

async function authStatus(): Promise<AuthStatus> {
  const response = await client.callTool({ name: "facebook_marketplace_auth_status", arguments: {} });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return (response.structuredContent as { auth: AuthStatus }).auth;
}

async function search(): Promise<MarketplaceSearchResult> {
  const response = await client.callTool({
    name: "facebook_marketplace_search",
    arguments: { query, locationSlug: "sydney", radiusKm: 65, maxScrolls: 3, executionMode: "auto" },
  }, undefined, { timeout: 180_000 });
  if (response.isError) throw new Error(JSON.stringify(response.structuredContent ?? response.content));
  return response.structuredContent as MarketplaceSearchResult;
}

try {
  await client.connect(transport);
  const auth = await authStatus();
  if (auth.state !== "authenticated") {
    throw new Error(`${auth.safeSummary} Run npm run auth:marketplace before benchmarking.`);
  }

  const runs: MarketplaceSearchResult[] = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await search();
    runs.push(result);
    process.stderr.write(
      `run ${index + 1}: ${result.execution.durationMs}ms, level=${result.execution.level}, ` +
        `listings=${result.totalListings}, complete=${result.complete}\n`,
    );
  }
  const durations = runs.map((run) => run.execution.durationMs).sort((left, right) => left - right);
  const report = {
    benchmarkedAt: new Date().toISOString(),
    query,
    auth: { state: auth.state, persistence: auth.persistence },
    runs: runs.map((run) => ({
      retrievedAt: run.retrievedAt,
      totalListings: run.totalListings,
      complete: run.complete,
      execution: run.execution,
      listingIds: run.listings.map((listing) => listing.id),
    })),
    medianMs: durations[Math.floor(durations.length / 2)],
    allZeroModel: runs.every((run) => run.execution.modelCalls === 0),
    allNetwork: runs.every((run) => run.execution.level === "network" || run.execution.level === "network-bootstrap"),
  };
  await mkdir(resolve(projectRoot, ".data"), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`RESULT_PATH=${outputPath}\n`);
  process.stdout.write(`MEDIAN_MS=${report.medianMs}\n`);
  process.stdout.write(`ALL_ZERO_MODEL=${report.allZeroModel}\n`);
  process.stdout.write(`ALL_NETWORK=${report.allNetwork}\n`);
} finally {
  await client.close().catch(() => {});
}
