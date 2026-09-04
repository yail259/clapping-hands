import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DomWorkflowPlan } from "./dom-workflow.js";
import type { FormWorkflowPlan } from "./form-workflow.js";
import { assertGenericJsonPlanSafety, type GenericJsonPlan } from "./generic-network.js";

export type BaselineWorkflowPlan = DomWorkflowPlan | FormWorkflowPlan;

export type StoredWorkflow = {
  formatVersion: "clapping-hands.dev/workflow-v1";
  action: string;
  version: number;
  revision: number;
  origin: string;
  baseline: BaselineWorkflowPlan;
  accelerator: GenericJsonPlan | null;
  createdAt: string;
  updatedAt: string;
};

export function assertActionName(action: string): void {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(action)) {
    throw new Error("Action names must be 2-63 lowercase letters, numbers, or underscores and start with a letter.");
  }
}

function isBaselinePlan(value: unknown): value is BaselineWorkflowPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return plan.formatVersion === "clapping-hands.dev/v1alpha2" &&
    (plan.engine === "stagehand-action-v1" || plan.engine === "html-form-v2") &&
    typeof plan.action === "string" && typeof plan.origin === "string";
}

function isAccelerator(value: unknown): value is GenericJsonPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return plan.formatVersion === "clapping-hands.dev/v1alpha2" && plan.engine === "json-request-v1";
}

function parseWorkflow(serialized: string): StoredWorkflow {
  const value = JSON.parse(serialized) as Partial<StoredWorkflow>;
  if (
    value.formatVersion !== "clapping-hands.dev/workflow-v1" ||
    typeof value.action !== "string" ||
    typeof value.version !== "number" ||
    typeof value.revision !== "number" ||
    typeof value.origin !== "string" ||
    !isBaselinePlan(value.baseline) ||
    (value.accelerator !== null && !isAccelerator(value.accelerator)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) throw new Error("Invalid stored workflow format.");
  assertActionName(value.action);
  if (value.action !== value.baseline.action || value.origin !== value.baseline.origin) {
    throw new Error("Stored workflow identity does not match its baseline plan.");
  }
  if (value.accelerator && (value.action !== value.accelerator.action || value.origin !== value.accelerator.origin)) {
    throw new Error("Stored workflow accelerator identity does not match its baseline plan.");
  }
  if (value.accelerator) assertGenericJsonPlanSafety(value.accelerator);
  return value as StoredWorkflow;
}

export class WorkflowStore {
  constructor(private readonly directory: string) {}

  private path(action: string): string {
    assertActionName(action);
    return resolve(this.directory, `${action}.json`);
  }

  private async withActionLock<T>(action: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.path(action)}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Workflow ${action} is being updated concurrently.`);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  private async loadUnlocked(action: string): Promise<StoredWorkflow | null> {
    try {
      return parseWorkflow(await readFile(this.path(action), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async load(action: string): Promise<StoredWorkflow | null> {
    return this.loadUnlocked(action);
  }

  async list(): Promise<StoredWorkflow[]> {
    try {
      const files = (await readdir(this.directory)).filter((file) => /^[a-z][a-z0-9_]{1,62}\.json$/.test(file)).sort();
      return await Promise.all(files.map(async (file) => parseWorkflow(await readFile(resolve(this.directory, file), "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(
    baseline: BaselineWorkflowPlan,
    accelerator: GenericJsonPlan | null = null,
  ): Promise<StoredWorkflow> {
    assertActionName(baseline.action);
    if (accelerator && (accelerator.action !== baseline.action || accelerator.origin !== baseline.origin)) {
      throw new Error("Workflow accelerator does not match the baseline identity.");
    }
    return this.withActionLock(baseline.action, async () => {
      const existing = await this.loadUnlocked(baseline.action);
      const now = new Date().toISOString();
      const version = (existing?.version ?? 0) + 1;
      baseline.version = version;
      if (accelerator) accelerator.version = version;
      const workflow: StoredWorkflow = {
        formatVersion: "clapping-hands.dev/workflow-v1",
        action: baseline.action,
        version,
        revision: 0,
        origin: baseline.origin,
        baseline,
        accelerator,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const target = this.path(workflow.action);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, target);
      return workflow;
    });
  }

  async update(workflow: StoredWorkflow): Promise<void> {
    await this.withActionLock(workflow.action, async () => {
      const existing = await this.loadUnlocked(workflow.action);
      if (!existing || existing.version !== workflow.version || existing.revision !== workflow.revision) {
        throw new Error("Workflow changed while its runtime evidence was being updated.");
      }
      workflow.revision += 1;
      workflow.updatedAt = new Date().toISOString();
      const target = this.path(workflow.action);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    });
  }
}
