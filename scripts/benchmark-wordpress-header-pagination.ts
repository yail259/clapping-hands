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

const ORIGIN = process.env.CLAPPING_HANDS_WORDPRESS_ORIGIN ?? "http://127.0.0.1:18090";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const container = process.env.CLAPPING_HANDS_WORDPRESS_CONTAINER ?? "clapping-hands-wordpress-app";
const APP_IMAGE = "wordpress:7.1.0-php8.3-apache";
const APP_IMAGE_DIGEST = "sha256:5a93c470ae8220fddf71f6ebe3bc94e615ddc2ae4d9810f795b830fb11c41a17";
const DB_IMAGE = "mariadb:11.4";
const DB_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const TITLE = "Clapping Hands Header Pagination Holdout";

if (!process.argv.includes("--local")) {
  throw new Error("WordPress header-pagination traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The WordPress header-pagination runner only permits a loopback origin.");
}

function postsUrl(page: number): string {
  const url = new URL(ORIGIN);
  url.searchParams.set("rest_route", "/wp/v2/posts");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("page", String(page));
  return url.href;
}

async function capture(page: number): Promise<CapturedExchange> {
  const url = postsUrl(page);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`WordPress REST capture returned HTTP ${response.status}.`);
  JSON.parse(responseBody);
  const totalPages = response.headers.get("x-wp-totalpages");
  if (!totalPages) throw new Error("WordPress REST response omitted X-WP-TotalPages.");
  return {
    url,
    method: "GET",
    resourceType: "fetch",
    requestHeaders: { accept: "application/json" },
    requestBody: "",
    responseStatus: response.status,
    responseHeaders: { "x-wp-totalpages": totalPages },
    responseBody,
  };
}

async function trace(totalPages: number): Promise<GenericNetworkTrace> {
  const exchanges: CapturedExchange[] = [];
  for (let page = 1; page <= totalPages; page += 1) exchanges.push(await capture(page));
  return { input: {}, exchanges };
}

function runWordPressPhp(code: string, environment: Record<string, string> = {}): string {
  const environmentArguments = Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  return execFileSync("docker", [
    "exec", ...environmentArguments, "-w", "/var/www/html", container, "php", "-r", code,
  ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }).trim();
}

function insertPost(): number {
  const output = runWordPressPhp(
    'require "wp-load.php"; $id = wp_insert_post(["post_title" => getenv("CH_TITLE"), "post_content" => "Synthetic header pagination body.", "post_status" => "publish", "post_type" => "post"], true); if (is_wp_error($id)) { fwrite(STDERR, $id->get_error_message()); exit(1); } echo $id;',
    { CH_TITLE: TITLE },
  );
  const id = Number(output);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("WordPress did not return a valid synthetic post ID.");
  return id;
}

function removePost(id: number): boolean {
  return runWordPressPhp(
    'require "wp-load.php"; $id = (int) getenv("CH_POST_ID"); wp_delete_post($id, true); echo get_post($id) === null ? "removed" : "present";',
    { CH_POST_ID: String(id) },
  ) === "removed";
}

function replayedPosts(data: unknown): Array<{ id: number; title: string }> {
  if (!Array.isArray(data)) throw new Error("Compiled WordPress pagination did not return pages.");
  return data.flatMap((page) => {
    if (!Array.isArray(page)) throw new Error("Compiled WordPress page was not an array.");
    return page.map((post) => {
      const candidate = post as { id?: unknown; title?: { rendered?: unknown } };
      if (typeof candidate.id !== "number" || typeof candidate.title?.rendered !== "string") {
        throw new Error("Compiled WordPress page returned an invalid post record.");
      }
      return { id: candidate.id, title: candidate.title.rendered };
    });
  });
}

const first = await capture(1);
const initialTotalPages = Number(first.responseHeaders?.["x-wp-totalpages"]);
if (!Number.isSafeInteger(initialTotalPages) || initialTotalPages < 3 || initialTotalPages > 10) {
  throw new Error(`WordPress pagination fixture requires 3-10 initial public posts; observed ${initialTotalPages}.`);
}
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-wordpress-header-pagination-"));
let context: BrowserContext | null = null;
let postId: number | null = null;
let cleanupVerified = false;

try {
  const compileStartedAt = performance.now();
  const compiled = compileGenericJsonFromTraces("wordpress_public_posts", [
    await trace(initialTotalPages),
    await trace(initialTotalPages),
  ]);
  const compileMs = performance.now() - compileStartedAt;
  const plan = compiled.plan;
  if (plan.request.pagination?.strategy !== "increment" ||
    plan.request.pagination.increment !== 1 ||
    plan.request.pagination.termination.type !== "total-pages-header" ||
    plan.request.pagination.termination.header !== "x-wp-totalpages") {
    throw new Error(`WordPress header pagination was not inferred exactly: ${JSON.stringify(plan.request.pagination)}.`);
  }

  postId = insertPost();
  const postOracle = JSON.parse(runWordPressPhp(
    'require "wp-load.php"; $post = get_post((int) getenv("CH_POST_ID")); echo wp_json_encode(["id" => $post?->ID, "title" => $post?->post_title, "status" => $post?->post_status]);',
    { CH_POST_ID: String(postId) },
  )) as { id: number; title: string; status: string };
  if (postOracle.id !== postId || postOracle.title !== TITLE || postOracle.status !== "publish") {
    throw new Error("WordPress application oracle did not observe the synthetic post exactly.");
  }

  context = await chromium.launchPersistentContext(resolve(directory, "profile"), {
    executablePath: CHROME,
    headless: true,
  });
  const replay = await replayGenericJsonPlan(context, plan, {});
  const posts = replayedPosts(replay.data);
  const matchingPosts = posts.filter((post) => post.id === postId && post.title === TITLE);
  const duplicateIds = posts.length - new Set(posts.map((post) => post.id)).size;
  const expectedRequests = initialTotalPages + 1;
  if (matchingPosts.length !== 1 || duplicateIds !== 0 || replay.requests !== expectedRequests || !replay.complete) {
    throw new Error(`WordPress header pagination replay failed its oracle: ${JSON.stringify({
      matchingPosts: matchingPosts.length,
      duplicateIds,
      requests: replay.requests,
      expectedRequests,
      complete: replay.complete,
    })}.`);
  }

  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-protocol-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Self-hosted WordPress 7.1",
    origin: ORIGIN,
    containerImages: {
      application: { image: APP_IMAGE, digest: APP_IMAGE_DIGEST },
      database: { image: DB_IMAGE, digest: DB_IMAGE_DIGEST },
    },
    intervention: "scripted capture of documented REST responses plus an application-side synthetic post oracle",
    policyBasis: "Loopback-only official WordPress image with disposable synthetic content",
    apiDisposition: "Documented first-party API negative control; applications should call it directly when task-complete",
    claimScope: "Generic response-header pagination capability on one pinned self-hosted application; not a UI-compilation or speed claim",
    workflow: {
      id: "wordpress-rest-total-pages-header",
      engine: plan.engine,
      compileMs: Number(compileMs.toFixed(2)),
      pagination: plan.request.pagination,
      initialTotalPages,
      expectedRequests,
      insertedPostFoundExactlyOnce: matchingPosts.length === 1,
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
  const reportPath = resolve(reportDirectory, "wordpress-local-header-pagination-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    reportPath,
    insertedPostFoundExactlyOnce: matchingPosts.length === 1,
    duplicateIds,
    requests: replay.requests,
    complete: replay.complete,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  if (postId !== null) cleanupVerified = removePost(postId);
  await rm(directory, { recursive: true, force: true });
  if (postId !== null && !cleanupVerified) throw new Error("WordPress synthetic pagination post cleanup was not verified.");
}
