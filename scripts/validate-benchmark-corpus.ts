import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Effect = "read" | "write" | "commit";
type Role = "development" | "holdout" | "control";
type AuthoringMode = "automatic" | "demonstrated";

type Task = {
  id: string;
  effect: Effect;
  expectedPath: string;
  authoringMode?: AuthoringMode;
  oracle?: string;
  reset?: string;
};

type Corpus = {
  schemaVersion: 1 | 2;
  status: "candidate" | "frozen";
  compilerFreezeSha: string | null;
  frozenAt?: string;
  claimDenominator?: "application-workflow-pairs";
  applications: Array<{
    id: string;
    name: string;
    role: Role;
    architecture: string[];
    policy: string;
    trafficBudget: string;
    tasks: Task[];
  }>;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const corpusArgument = process.argv[2] ?? "bench/corpus-v1.json";
const path = resolve(process.cwd(), corpusArgument);
const corpus = JSON.parse(await readFile(path, "utf8")) as Corpus;
requireCondition(corpus.schemaVersion === 1 || corpus.schemaVersion === 2, "Unsupported benchmark corpus schema.");
requireCondition(corpus.applications.length >= 8, "Representative corpus requires at least eight applications.");

const applicationIds = new Set<string>();
const taskIds = new Set<string>();
const effects = new Set<Effect>();
const architectures = new Set<string>();
let automaticTasks = 0;
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
    if (corpus.schemaVersion === 2) {
      requireCondition(task.authoringMode === "automatic" || task.authoringMode === "demonstrated", `${qualifiedId} is missing its authoring mode.`);
      requireCondition((task.oracle ?? "").trim().length > 0, `${qualifiedId} is missing its independent oracle.`);
      requireCondition((task.reset ?? "").trim().length > 0, `${qualifiedId} is missing its reset contract.`);
      if (task.authoringMode === "automatic") automaticTasks += 1;
    }
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
if (corpus.schemaVersion === 2) {
  requireCondition(corpus.status === "frozen", "Corpus v2 is a prospective holdout and must be frozen.");
  requireCondition(/^\d{4}-\d{2}-\d{2}$/.test(corpus.frozenAt ?? ""), "Corpus v2 requires an ISO freeze date.");
  requireCondition(corpus.claimDenominator === "application-workflow-pairs", "Corpus v2 requires an explicit task-level claim denominator.");
  requireCondition(corpus.applications.length === 8, "Corpus v2 must contain exactly the eight preselected application rows.");
  requireCondition(corpus.applications.every((application) => application.role === "holdout"), "Every corpus v2 application row must remain a holdout.");
  requireCondition(corpus.applications.every((application) => application.tasks.length >= 3), "Every corpus v2 row requires at least three frozen tasks.");
  requireCondition(automaticTasks >= corpus.applications.length, "Corpus v2 requires at least one automatic-authoring task per application row.");
}

console.log(JSON.stringify({
  path: corpusArgument,
  schemaVersion: corpus.schemaVersion,
  status: corpus.status,
  applications: corpus.applications.length,
  tasks: taskIds.size,
  holdouts: holdouts.length,
  architectures: architectures.size,
  effects: [...effects].sort(),
  ...(corpus.schemaVersion === 2 ? { automaticTasks } : {}),
}, null, 2));
