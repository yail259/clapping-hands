import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  repairDomWorkflow,
  recordDomShadow,
  replayDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "./dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "./effect-journal.js";
import {
  compileFormWorkflow,
  demonstrateFormWorkflow,
  replayFormWorkflow,
  replayFormWorkflowInBrowser,
  type FormWorkflowAnswers,
  type FormWorkflowDemonstration,
} from "./form-workflow.js";
import {
  compileGenericJsonFromTraces,
  jsonResponseSupportsOutput,
  recordGenericJsonShadow,
  replayGenericJsonPlan,
  type GenericNetworkTrace,
  type NetworkInput,
} from "./generic-network.js";
import { WorkflowBrowser } from "./workflow-browser.js";
import { PersistentWorkflowBrowser } from "./persistent-browser.js";
import type { BrowserActResult, BrowserAction } from "./browser-learner.js";
import type { NetworkRecorder } from "./network-recorder.js";
import { assertActionName, type StoredWorkflow, WorkflowStore } from "./workflow-store.js";

export type DomCompilationRequest = {
  action: string;
  startUrl: string;
  outputSelector: string;
  demonstrations: Array<{
    input: DomInput;
    instructions: string[];
  }>;
  effect?: "read" | "write";
  confirmation?: string;
  allowedNetworkOrigins?: string[];
};

export type FormCompilationRequest = {
  action: string;
  startUrl: string;
  demonstrations: FormWorkflowAnswers[];
};

export type WorkflowExecution = {
  action: string;
  version: number;
  engine: "network" | "form-request" | "browser-dom" | "browser-form" | "semantic-browser" | "prepared-write";
  accelerated: boolean;
  fallbackReason?: string;
  shadow?: { matched: boolean; acceleratorStatus: string };
  result: unknown;
};

export interface RuntimeBrowser {
  readonly network: NetworkRecorder;
  page(): Promise<Page>;
  context(): Promise<BrowserContext>;
  goto(url: string): Promise<Page>;
  act(instruction: string | BrowserAction): Promise<BrowserActResult>;
  close(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workflowOrigin(startUrl: string): string {
  const url = new URL(startUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Workflows require an HTTP(S) start URL.");
  return url.origin;
}

function assertRuntimeInput(workflow: StoredWorkflow, input: DomInput | FormWorkflowAnswers): void {
  const expected = workflow.baseline.engine === "stagehand-action-v1"
    ? workflow.baseline.inputNames
    : workflow.baseline.steps.map((step) => step.questionKey);
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...new Set(expected)].sort())) {
    throw new Error(`Compiled input keys must be exactly: ${[...new Set(expected)].sort().join(", ")}.`);
  }
}

function assertAcceleratorOrigin(workflow: StoredWorkflow): void {
  if (!workflow.accelerator) return;
  const endpointOrigin = workflow.accelerator.request.endpointOrigin ?? workflow.accelerator.origin;
  const additional = workflow.baseline.engine === "stagehand-action-v1"
    ? workflow.baseline.allowedNetworkOrigins ?? []
    : [];
  if (!new Set([workflow.origin, ...additional]).has(endpointOrigin)) {
    throw new Error(`Compiled network endpoint is outside the workflow allowlist: ${endpointOrigin}`);
  }
}

function isRepairableDomFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return !/input keys|authentication|access-control|allowed origin|write workflow|action budget/i.test(message);
}

export class WorkflowRuntime {
  readonly store: WorkflowStore;
  readonly journal: EffectJournal;
  private readonly browsers = new Map<string, { browser: RuntimeBrowser; learner: boolean }>();
  private readonly dataDirectory: string;
  private readonly browserFactory: (origin: string, profileDirectory: string) => RuntimeBrowser;
  private readonly learnerBrowserFactory: (origin: string, profileDirectory: string) => RuntimeBrowser;

  constructor(
    dataDirectory = process.env.CLAPPING_HANDS_DATA_DIR ?? resolve(process.cwd(), ".data"),
    browserFactory: (origin: string, profileDirectory: string) => RuntimeBrowser = (origin, profileDirectory) =>
      new PersistentWorkflowBrowser({ allowedOrigins: [origin], profileDirectory }),
    learnerBrowserFactory: (origin: string, profileDirectory: string) => RuntimeBrowser = (origin, profileDirectory) =>
      new WorkflowBrowser({ allowedOrigins: [origin], profileDirectory }),
  ) {
    this.dataDirectory = dataDirectory;
    this.browserFactory = browserFactory;
    this.learnerBrowserFactory = learnerBrowserFactory;
    this.store = new WorkflowStore(resolve(dataDirectory, "workflows"));
    this.journal = new EffectJournal(resolve(dataDirectory, "effect-journal.json"));
  }

  private async browser(origin: string, needsLearner = false): Promise<RuntimeBrowser> {
    let entry = this.browsers.get(origin);
    if (entry && needsLearner && !entry.learner) {
      await entry.browser.close();
      this.browsers.delete(origin);
      entry = undefined;
    }
    if (!entry) {
      const profileId = createHash("sha256").update(origin).digest("hex").slice(0, 16);
      const profileDirectory = resolve(this.dataDirectory, "profiles", profileId);
      const browser = needsLearner
        ? this.learnerBrowserFactory(origin, profileDirectory)
        : this.browserFactory(origin, profileDirectory);
      entry = { browser, learner: needsLearner };
      this.browsers.set(origin, entry);
    }
    return entry.browser;
  }

  async compileDom(request: DomCompilationRequest): Promise<StoredWorkflow> {
    assertActionName(request.action);
    if (request.demonstrations.length < 2) throw new Error("Two distinct DOM demonstrations are required.");
    const origin = workflowOrigin(request.startUrl);
    const allowedNetworkOrigins = [...new Set((request.allowedNetworkOrigins ?? []).map(workflowOrigin))]
      .filter((candidate) => candidate !== origin)
      .sort();
    if (allowedNetworkOrigins.length > 5) throw new Error("At most five additional network origins may be declared.");
    if (new URL(origin).protocol === "https:" && allowedNetworkOrigins.some((candidate) => new URL(candidate).protocol !== "https:")) {
      throw new Error("An HTTPS workflow cannot capture a plaintext network endpoint.");
    }
    const browser = await this.browser(origin, true);
    browser.network.setAllowedOrigins([origin, ...allowedNetworkOrigins]);
    const demonstrations: DomWorkflowDemonstration[] = [];
    const traces: GenericNetworkTrace[] = [];
    for (const requested of request.demonstrations) {
      const page = await browser.page();
      const mark = browser.network.mark();
      const demonstration = await demonstrateDomWorkflow(
        browser,
        page,
        request.startUrl,
        requested.input,
        requested.instructions,
        request.outputSelector,
      );
      demonstrations.push(demonstration);
      traces.push({
        input: requested.input,
        exchanges: await browser.network.since(mark),
        outputText: demonstration.output.text,
      });
    }
    const baseline = compileDomWorkflow(request.action, request.startUrl, demonstrations, {
      effect: request.effect,
      confirmation: request.confirmation,
      allowedNetworkOrigins,
    });
    let accelerator = null;
    if (baseline.effect.level === "read") {
      try {
        accelerator = compileGenericJsonFromTraces(request.action, traces, {
          workflowOrigin: origin,
          allowedNetworkOrigins,
        }).plan;
      } catch {
        // A deterministic DOM plan is the safe general baseline. Network
        // acceleration is optional and must have rendered-output evidence.
      }
    }
    return this.store.save(baseline, accelerator);
  }

  async compileForm(request: FormCompilationRequest): Promise<StoredWorkflow> {
    assertActionName(request.action);
    if (request.demonstrations.length < 2) throw new Error("Two distinct form demonstrations are required.");
    const origin = workflowOrigin(request.startUrl);
    const page = await (await this.browser(origin)).page();
    const demonstrations: FormWorkflowDemonstration[] = [];
    for (const answers of request.demonstrations) {
      demonstrations.push(await demonstrateFormWorkflow(page, request.startUrl, answers));
    }
    return this.store.save(compileFormWorkflow(request.action, request.startUrl, demonstrations));
  }

  async list(): Promise<StoredWorkflow[]> {
    return this.store.list();
  }

  async run(action: string, input: DomInput | FormWorkflowAnswers): Promise<WorkflowExecution> {
    const workflow = await this.store.load(action);
    if (!workflow) throw new Error(`Compiled workflow ${action} was not found.`);
    assertRuntimeInput(workflow, input);
    assertAcceleratorOrigin(workflow);
    const browser = await this.browser(workflow.origin);
    const page = await browser.page();

    if (workflow.baseline.engine === "stagehand-action-v1" && workflow.baseline.effect.level === "write") {
      const receipt = await prepareDomWorkflowWrite(page, this.journal, workflow.baseline, input as DomInput);
      return {
        action,
        version: workflow.version,
        engine: "prepared-write",
        accelerated: false,
        result: receipt,
      };
    }

    if (workflow.accelerator?.status === "stable") {
      try {
        const result = await replayGenericJsonPlan(await browser.context(), workflow.accelerator, input as NetworkInput);
        return { action, version: workflow.version, engine: "network", accelerated: true, result };
      } catch (error) {
        workflow.accelerator = recordGenericJsonShadow(workflow.accelerator, input as NetworkInput, false);
        await this.store.update(workflow);
        const fallback = await this.runBaseline(workflow, browser, page, input);
        return { ...fallback, fallbackReason: errorMessage(error) };
      }
    }

    const baseline = await this.runBaseline(workflow, browser, page, input);
    if (workflow.accelerator?.status === "provisional" || workflow.accelerator?.status === "candidate") {
      try {
        const candidate = await replayGenericJsonPlan(await browser.context(), workflow.accelerator, input as NetworkInput);
        const baselineText = typeof baseline.result === "object" && baseline.result && "text" in baseline.result
          ? String((baseline.result as { text: unknown }).text)
          : typeof baseline.result === "object" && baseline.result && "mainText" in baseline.result
            ? String((baseline.result as { mainText: unknown }).mainText)
            : "";
        const matched = Boolean(baselineText) && jsonResponseSupportsOutput(
          JSON.stringify(candidate.data),
          baselineText,
          input as NetworkInput,
        );
        workflow.accelerator = recordGenericJsonShadow(workflow.accelerator, input as NetworkInput, matched);
        await this.store.update(workflow);
        baseline.shadow = { matched, acceleratorStatus: workflow.accelerator.status };
      } catch (error) {
        workflow.accelerator = recordGenericJsonShadow(workflow.accelerator, input as NetworkInput, false);
        await this.store.update(workflow);
        baseline.shadow = { matched: false, acceleratorStatus: workflow.accelerator.status };
        baseline.fallbackReason = errorMessage(error);
      }
    }
    return baseline;
  }

  private async runBaseline(
    workflow: StoredWorkflow,
    browser: RuntimeBrowser,
    page: Page,
    input: DomInput | FormWorkflowAnswers,
  ): Promise<WorkflowExecution> {
    if (workflow.baseline.engine === "stagehand-action-v1") {
      try {
        const result = await replayDomWorkflow(page, workflow.baseline, input as DomInput);
        workflow.baseline = recordDomShadow(workflow.baseline, input as DomInput, true);
        await this.store.update(workflow);
        return { action: workflow.action, version: workflow.version, engine: "browser-dom", accelerated: false, result };
      } catch (error) {
        if (!isRepairableDomFailure(error)) throw error;
        workflow.baseline = recordDomShadow(workflow.baseline, input as DomInput, false);
        await this.store.update(workflow);
        if (workflow.baseline.repairInstructions.length === 0) throw error;
        try {
          const learner = await this.browser(workflow.origin, true);
          const result = await repairDomWorkflow(learner, await learner.page(), workflow.baseline, input as DomInput);
          return {
            action: workflow.action,
            version: workflow.version,
            engine: "semantic-browser",
            accelerated: false,
            fallbackReason: errorMessage(error),
            result,
          };
        } catch (repairError) {
          throw new Error(`Deterministic replay failed: ${errorMessage(error)} Semantic repair failed: ${errorMessage(repairError)}`);
        }
      }
    }
    try {
      const result = await replayFormWorkflow(await browser.context(), workflow.baseline, input as FormWorkflowAnswers);
      return { action: workflow.action, version: workflow.version, engine: "form-request", accelerated: true, result };
    } catch (error) {
      const result = await replayFormWorkflowInBrowser(page, workflow.baseline, input as FormWorkflowAnswers);
      return {
        action: workflow.action,
        version: workflow.version,
        engine: "browser-form",
        accelerated: false,
        fallbackReason: errorMessage(error),
        result,
      };
    }
  }

  async commit(action: string, receiptId: string, input: DomInput): Promise<WorkflowExecution> {
    const workflow = await this.store.load(action);
    if (!workflow) throw new Error(`Compiled workflow ${action} was not found.`);
    if (workflow.baseline.engine !== "stagehand-action-v1") throw new Error("Only DOM write workflows use effect receipts.");
    const page = await (await this.browser(workflow.origin)).page();
    const result = await commitPreparedDomWorkflowWrite(page, this.journal, receiptId, workflow.baseline, input);
    return { action, version: workflow.version, engine: "browser-dom", accelerated: false, result };
  }

  async openAuthentication(url: string): Promise<{ origin: string; pageUrl: string; firstPartyCookieCount: number }> {
    const origin = workflowOrigin(url);
    const browser = await this.browser(origin);
    const page = await browser.goto(url);
    const cookies = await (await browser.context()).cookies([origin]);
    return { origin, pageUrl: page.url(), firstPartyCookieCount: cookies.length };
  }

  async close(): Promise<void> {
    const browsers = [...this.browsers.values()].map((entry) => entry.browser);
    this.browsers.clear();
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  }
}
