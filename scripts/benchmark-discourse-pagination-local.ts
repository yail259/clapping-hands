import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import {
  compileGenericJsonFromTraces,
  replayGenericJsonPlan,
  type GenericNetworkTrace,
} from "../src/generic-network.js";
import type { CapturedExchange } from "../src/network-plan.js";

const ORIGIN = process.env.CLAPPING_HANDS_DISCOURSE_ORIGIN ?? "http://127.0.0.1:18121";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const container = process.env.CLAPPING_HANDS_DISCOURSE_CONTAINER ?? "clapping-hands-discourse-dev";
const SOURCE_COMMIT = "4cefc8c471e4fb40aa1ce5710198bed2f1706474";
const IMAGE = "discourse/discourse_dev:20260812-0036";
const IMAGE_DIGEST = "sha256:ed44e808f7430432712745da7245d6e256c0c417d4c874772ca5b1b3d311242";
const FIXTURE_COUNT = 65;
const fixturePath = resolve("bench/fixtures/discourse/clapping_hands_fixture.rb");

if (!process.argv.includes("--local")) {
  throw new Error("Discourse pagination traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The Discourse pagination runner only permits a loopback origin.");
}

type PaginationSnapshot = { count: number; topics: Array<{ id: number; title: string }> };

function parseFixtureJson<T>(output: string): T {
  const line = output.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("CH_JSON="));
  if (!line) throw new Error("The Discourse fixture command did not return JSON.");
  return JSON.parse(line.slice("CH_JSON=".length)) as T;
}

function fixture<T>(command: string, environment: Record<string, string> = {}): T {
  const environmentArguments = Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  const output = execFileSync("docker", [
    "exec", "-u", "discourse:discourse", "-w", "/src", "-e", `CH_DISCOURSE_COMMAND=${command}`,
    ...environmentArguments, container, "bin/rails", "runner", "/tmp/clapping_hands_fixture.rb",
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return parseFixtureJson<T>(output);
}

async function capture(path: string): Promise<CapturedExchange> {
  const url = new URL(path, ORIGIN).href;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`Discourse pagination capture returned HTTP ${response.status}.`);
  JSON.parse(responseBody);
  return {
    url,
    method: "GET",
    resourceType: "fetch",
    requestHeaders: { accept: "application/json" },
    requestBody: "",
    responseStatus: response.status,
    responseBody,
  };
}

async function trace(): Promise<GenericNetworkTrace> {
  return {
    input: {},
    exchanges: await Promise.all([
      capture("/latest.json"),
      capture("/latest.json?page=1"),
      capture("/latest.json?page=2"),
    ]),
  };
}

function replayedTopics(data: unknown): Array<{ id: number; title: string }> {
  if (!Array.isArray(data)) throw new Error("Compiled Discourse pagination did not return pages.");
  return data.flatMap((page) => {
    const topics = (page as { topic_list?: { topics?: unknown } }).topic_list?.topics;
    if (!Array.isArray(topics)) throw new Error("Compiled Discourse page did not contain a topic list.");
    return topics.map((topic) => {
      const candidate = topic as { id?: unknown; title?: unknown };
      if (typeof candidate.id !== "number" || typeof candidate.title !== "string") {
        throw new Error("Compiled Discourse page returned an invalid topic record.");
      }
      return { id: candidate.id, title: candidate.title };
    });
  });
}

execFileSync("docker", ["cp", fixturePath, `${container}:/tmp/clapping_hands_fixture.rb`]);
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-discourse-pagination-"));
let context: BrowserContext | null = null;
let cleanupVerified = false;

try {
  const firstSeed = fixture<PaginationSnapshot>("seed-pagination", {
    CH_DISCOURSE_PAGINATION_COUNT: String(FIXTURE_COUNT),
  });
  if (firstSeed.count !== FIXTURE_COUNT) throw new Error("The first Discourse pagination seed was incomplete.");
  const compileStartedAt = performance.now();
  const compiled = compileGenericJsonFromTraces("discourse_latest_topics", [await trace(), await trace()]);
  const compileMs = performance.now() - compileStartedAt;
  const plan = compiled.plan;
  if (plan.request.pagination?.strategy !== "increment" ||
    plan.request.pagination.firstContinuationValue !== 1 || plan.request.pagination.increment !== 1 ||
    plan.request.pagination.termination.type !== "next-value") {
    throw new Error(`Discourse numbered pagination was not inferred exactly: ${JSON.stringify(plan.request.pagination)}.`);
  }

  const unseenSeed = fixture<PaginationSnapshot>("seed-pagination", {
    CH_DISCOURSE_PAGINATION_COUNT: String(FIXTURE_COUNT),
  });
  if (unseenSeed.count !== FIXTURE_COUNT) throw new Error("The unseen Discourse pagination seed was incomplete.");
  const demonstrationIds = new Set(firstSeed.topics.map((topic) => topic.id));
  if (unseenSeed.topics.some((topic) => demonstrationIds.has(topic.id))) {
    throw new Error("The unseen Discourse state reused demonstration topic identifiers.");
  }

  context = await chromium.launchPersistentContext(resolve(directory, "profile"), {
    executablePath: CHROME,
    headless: true,
  });
  const replay = await replayGenericJsonPlan(context, plan, {});
  const topics = replayedTopics(replay.data);
  const replayedIds = topics.map((topic) => topic.id);
  const expectedIds = new Set(unseenSeed.topics.map((topic) => topic.id));
  const expectedTopicsExactlyOnce = unseenSeed.topics.every((topic) =>
    replayedIds.filter((id) => id === topic.id).length === 1 &&
    topics.some((candidate) => candidate.id === topic.id && candidate.title === topic.title));
  const duplicateIds = replayedIds.length - new Set(replayedIds).size;
  if (!expectedTopicsExactlyOnce || duplicateIds !== 0 || replay.requests !== 3 || !replay.complete) {
    throw new Error(`Discourse pagination replay failed its oracle: ${JSON.stringify({
      expectedTopicsExactlyOnce,
      duplicateIds,
      requests: replay.requests,
      complete: replay.complete,
      expectedCount: expectedIds.size,
    })}.`);
  }

  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Self-hosted Discourse development fixture",
    origin: ORIGIN,
    sources: { discourse: SOURCE_COMMIT },
    containerImages: { application: IMAGE, digest: IMAGE_DIGEST },
    intervention: "scripted capture of six real application responses across two independent demonstrations",
    policyBasis: "Loopback-only official Discourse source and developer image with disposable synthetic topics",
    claimScope: "Generic numbered-pagination capability on one pinned self-hosted application; not a speed or untouched-holdout claim",
    workflow: {
      id: "discourse-latest-numbered-pagination",
      engine: plan.engine,
      compileMs: Number(compileMs.toFixed(2)),
      pagination: plan.request.pagination,
      unseenStateReplacedAllDemonstrationTopicIds: true,
      expectedSyntheticTopics: expectedIds.size,
      expectedTopicsExactlyOnce,
      duplicateIds,
      requests: replay.requests,
      navigations: replay.navigations,
      complete: replay.complete,
      compiledDurationMs: Number(replay.durationMs.toFixed(2)),
      modelCalls: 0,
    },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "discourse-local-pagination-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    reportPath,
    expectedTopicsExactlyOnce,
    duplicateIds,
    requests: replay.requests,
    complete: replay.complete,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  try {
    cleanupVerified = fixture<PaginationSnapshot>("clear-pagination").count === 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (!cleanupVerified) throw new Error("Discourse pagination fixture cleanup was not verified.");
}
