import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Effect = "read" | "write" | "commit";
type Role = "development" | "holdout" | "control";

type Corpus = {
  schemaVersion: number;
  status: "candidate" | "frozen";
  compilerFreezeSha: string | null;
  applications: Array<{
    id: string;
    name: string;
    role: Role;
    architecture: string[];
    policy: string;
    trafficBudget: string;
    tasks: Array<{ id: string; effect: Effect; expectedPath: string }>;
  }>;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const path = resolve(process.cwd(), "bench/corpus-v1.json");
const corpus = JSON.parse(await readFile(path, "utf8")) as Corpus;
requireCondition(corpus.schemaVersion === 1, "Unsupported benchmark corpus schema.");
requireCondition(corpus.applications.length >= 8, "Representative corpus requires at least eight applications.");

const applicationIds = new Set<string>();
const taskIds = new Set<string>();
const effects = new Set<Effect>();
const architectures = new Set<string>();
for (const application of corpus.applications) {
  requireCondition(!applicationIds.has(application.id), `Duplicate application id: ${application.id}`);
  applicationIds.add(application.id);
  requireCondition(application.policy.trim().length > 0, `${application.id} is missing a policy basis.`);
  requireCondition(application.trafficBudget.trim().length > 0, `${application.id} is missing a traffic budget.`);
  requireCondition(application.tasks.length > 0, `${application.id} has no declared tasks.`);
  application.architecture.forEach((architecture) => architectures.add(architecture));
  for (const task of application.tasks) {
    const qualifiedId = `${application.id}/${task.id}`;
    requireCondition(!taskIds.has(qualifiedId), `Duplicate task id: ${qualifiedId}`);
    taskIds.add(qualifiedId);
    effects.add(task.effect);
    requireCondition(task.expectedPath.trim().length > 0, `${qualifiedId} is missing its expected path.`);
  }
}

const holdouts = corpus.applications.filter((application) => application.role === "holdout");
requireCondition(holdouts.length >= 3, "Representative corpus requires at least three unseen holdout applications.");
requireCondition(taskIds.size >= 20, "Representative corpus requires at least 20 frozen tasks.");
requireCondition(effects.has("read") && effects.has("write") && effects.has("commit"), "Corpus must cover read, write, and commit effects.");
requireCondition(architectures.size >= 8, "Corpus architecture mix is too narrow.");
if (corpus.status === "frozen") {
  requireCondition(/^[0-9a-f]{7,40}$/.test(corpus.compilerFreezeSha ?? ""), "A frozen corpus requires a compiler Git SHA.");
}

console.log(JSON.stringify({
  status: corpus.status,
  applications: corpus.applications.length,
  tasks: taskIds.size,
  holdouts: holdouts.length,
  architectures: architectures.size,
  effects: [...effects].sort(),
}, null, 2));
