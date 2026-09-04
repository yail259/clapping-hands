import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Effect = "read" | "write" | "commit";
type AuthoringMode = "automatic" | "demonstrated";
type ResultStatus = "passed" | "failed" | "blocked" | "unsupported";

type Corpus = {
  schemaVersion: 2;
  status: "frozen";
  compilerFreezeSha: string;
  applications: Array<{
    id: string;
    tasks: Array<{ id: string; effect: Effect; authoringMode: AuthoringMode }>;
  }>;
};

type ResultTask = {
  id: string;
  effect: Effect;
  status: ResultStatus;
  unseen: boolean;
  authoringMode: AuthoringMode;
  engine: string;
  exactResult: boolean;
  falseSuccess: boolean;
  duplicateCommits: number;
  cleanupVerified: boolean;
  requests: number;
  navigations: number;
  modelCalls: number;
  failureClassification?: string;
};

type BenchmarkResult = {
  schemaVersion: 2;
  generatedAt: string;
  compilerCommit: string;
  corpus: { path: string; freezeSha: string };
  application: { id: string; name: string; environment: string; policyReviewDate: string; trafficBudget: string };
  tasks: ResultTask[];
  summary: { passed: number; total: number; successRate: number; falseSuccesses: number; duplicateCommits: number };
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireNonnegativeInteger(value: unknown, field: string): asserts value is number {
  requireCondition(Number.isSafeInteger(value) && Number(value) >= 0, `${field} must be a nonnegative integer.`);
}

const resultArgument = process.argv[2];
if (!resultArgument) throw new Error("Pass a benchmark result JSON path.");
const resultPath = resolve(process.cwd(), resultArgument);
const result = JSON.parse(await readFile(resultPath, "utf8")) as BenchmarkResult;
requireCondition(result.schemaVersion === 2, "Only benchmark result schema v2 is claim-checkable.");
requireCondition(!Number.isNaN(Date.parse(result.generatedAt)), "Result generatedAt must be an ISO-compatible timestamp.");
requireCondition(/^[0-9a-f]{7,40}$/.test(result.compilerCommit), "Result compilerCommit is invalid.");
requireCondition(typeof result.corpus?.path === "string" && result.corpus.path.length > 0, "Result corpus path is missing.");

const corpusPath = resolve(process.cwd(), result.corpus.path);
const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as Corpus;
requireCondition(corpus.schemaVersion === 2 && corpus.status === "frozen", "Result must reference a frozen v2 corpus.");
requireCondition(result.corpus.freezeSha === corpus.compilerFreezeSha, "Result freeze SHA does not match its corpus.");
requireCondition(result.compilerCommit === corpus.compilerFreezeSha, "Frozen task outcomes must identify the corpus compiler commit.");

const application = corpus.applications.find((candidate) => candidate.id === result.application?.id);
requireCondition(application, `Result application is not declared in the corpus: ${result.application?.id ?? "missing"}`);
for (const field of ["name", "environment", "policyReviewDate", "trafficBudget"] as const) {
  requireCondition(typeof result.application[field] === "string" && result.application[field].trim().length > 0,
    `Result application ${field} is missing.`);
}
requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(result.application.policyReviewDate), "Result policyReviewDate must be YYYY-MM-DD.");
requireCondition(Array.isArray(result.tasks) && result.tasks.length > 0, "Result requires at least one task row.");

const seen = new Set<string>();
for (const task of result.tasks) {
  requireCondition(!seen.has(task.id), `Duplicate result task: ${task.id}`);
  seen.add(task.id);
  const declared = application.tasks.find((candidate) => candidate.id === task.id);
  requireCondition(declared, `Result task is not declared for ${application.id}: ${task.id}`);
  requireCondition(task.effect === declared.effect, `Result effect drifted for ${task.id}.`);
  requireCondition(task.authoringMode === declared.authoringMode, `Result authoring mode drifted for ${task.id}.`);
  requireCondition(new Set<ResultStatus>(["passed", "failed", "blocked", "unsupported"]).has(task.status),
    `Result status is invalid for ${task.id}.`);
  requireCondition(typeof task.engine === "string" && task.engine.trim().length > 0, `Result engine is missing for ${task.id}.`);
  for (const field of ["requests", "navigations", "modelCalls", "duplicateCommits"] as const) {
    requireNonnegativeInteger(task[field], `${task.id}.${field}`);
  }
  if (task.status === "passed") {
    requireCondition(task.unseen && task.exactResult && !task.falseSuccess && task.duplicateCommits === 0 && task.cleanupVerified,
      `Passing task ${task.id} violates an unseen/correct/safe/clean claim invariant.`);
  } else {
    requireCondition(typeof task.failureClassification === "string" && task.failureClassification.length > 0,
      `Non-passing task ${task.id} requires a failure classification.`);
  }
}

const passed = result.tasks.filter((task) => task.status === "passed").length;
const falseSuccesses = result.tasks.filter((task) => task.falseSuccess).length;
const duplicateCommits = result.tasks.reduce((sum, task) => sum + task.duplicateCommits, 0);
requireNonnegativeInteger(result.summary?.passed, "summary.passed");
requireNonnegativeInteger(result.summary?.total, "summary.total");
requireNonnegativeInteger(result.summary?.falseSuccesses, "summary.falseSuccesses");
requireNonnegativeInteger(result.summary?.duplicateCommits, "summary.duplicateCommits");
requireCondition(result.summary.total === result.tasks.length, "Summary total does not equal the number of task rows.");
requireCondition(result.summary.passed === passed, "Summary passed count does not equal the task rows.");
requireCondition(result.summary.falseSuccesses === falseSuccesses, "Summary false-success count does not equal the task rows.");
requireCondition(result.summary.duplicateCommits === duplicateCommits, "Summary duplicate-commit count does not equal the task rows.");
requireCondition(Number.isFinite(result.summary.successRate) &&
  Math.abs(result.summary.successRate - passed / result.tasks.length) < 1e-12,
"Summary success rate does not equal passed / total.");

console.log(JSON.stringify({
  path: resultArgument,
  application: application.id,
  tasks: result.tasks.length,
  passed,
  successRate: result.summary.successRate,
  falseSuccesses,
  duplicateCommits,
}, null, 2));
