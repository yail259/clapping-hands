import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_ORIGIN = "https://api.github.com";
const REPOSITORY = "yail259/clapping-hands";
const RUN_REQUESTS = 1;
const DAILY_DOMAIN_CAP = 10;
const MAX_RESPONSE_BYTES = 1_000_000;

if (!process.argv.includes("--live")) {
  throw new Error("GitHub API traffic is disabled. Pass --live after reviewing the traffic count.");
}
const countArgument = process.argv.find((argument) => argument.startsWith("--external-requests-today="));
const externalRequests = countArgument ? Number.parseInt(countArgument.split("=")[1] ?? "", 10) : Number.NaN;
if (!Number.isSafeInteger(externalRequests) || externalRequests < 0) {
  throw new Error("Pass --external-requests-today=N including requests outside this runner.");
}
if (externalRequests + RUN_REQUESTS > DAILY_DOMAIN_CAP) {
  throw new Error(`This run would exceed the ${DAILY_DOMAIN_CAP}-request daily API-domain cap.`);
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
const startedAt = performance.now();
let response: Response;
try {
  response = await fetch(`${API_ORIGIN}/repos/${REPOSITORY}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "clapping-hands-benchmark",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeout);
}
const durationMs = performance.now() - startedAt;
if (!response.ok) throw new Error(`GitHub REST negative control returned HTTP ${response.status}.`);
if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
  throw new Error("GitHub REST negative control did not return JSON.");
}
const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
  throw new Error("GitHub REST negative-control response exceeded the byte limit.");
}
const body = await response.text();
if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
  throw new Error("GitHub REST negative-control response exceeded the byte limit.");
}
const repository = JSON.parse(body) as Record<string, unknown>;
const exactResult = repository.full_name === REPOSITORY &&
  repository.html_url === `https://github.com/${REPOSITORY}` &&
  repository.private === false;
if (!exactResult) throw new Error("GitHub REST negative control returned the wrong repository identity.");

const report = {
  schemaVersion: 1,
  kind: "api-first-negative-control",
  generatedAt: new Date().toISOString(),
  compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  application: "GitHub",
  task: "read public repository metadata",
  repository: REPOSITORY,
  integrationDecision: "official-api",
  decisionReason: "GitHub's documented REST endpoint fully covers this task, so UI compilation is unnecessary",
  authentication: "none-required-for-this-public-request",
  evidence: {
    apiRequests: RUN_REQUESTS,
    browserNavigations: 0,
    uiCompilerInvocations: 0,
    modelCalls: 0,
    durationMs,
    exactResult,
  },
  traffic: {
    externalRequestsBeforeRun: externalRequests,
    runnerRequests: RUN_REQUESTS,
    dailyDomainCap: DAILY_DOMAIN_CAP,
  },
  claimScope: "Routing negative control; n=1 capability evidence, not a speed benchmark",
  summary: { passed: 1, total: 1, falseSuccesses: 0 },
};
const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, "github-api-first-control.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
