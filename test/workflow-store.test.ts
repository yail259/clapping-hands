import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileDomWorkflow, type DomWorkflowDemonstration } from "../src/dom-workflow.js";
import { assertFormWorkflowPlanSafety, type FormWorkflowPlan } from "../src/form-workflow.js";
import { WorkflowStore } from "../src/workflow-store.js";

function demonstration(input: string): DomWorkflowDemonstration {
  return {
    input: { query: input },
    actions: [{ selector: "#query", description: `Fill ${input}`, method: "fill", arguments: [input] }],
    output: {
      selector: "main",
      tagName: "main",
      text: `Results ${input}`,
      textHash: `hash-${input}`,
      url: `https://example.test/results?q=${input}`,
    },
    modelCalls: 1,
  };
}

test("workflow store versions atomic redacted plans and rejects stale evidence updates", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-store-"));
  try {
    const store = new WorkflowStore(directory);
    const firstPlan = compileDomWorkflow("search_site", "https://example.test", [
      demonstration("sofa"),
      demonstration("chair"),
    ]);
    const first = await store.save(firstPlan);
    assert.equal(first.version, 1);
    assert.doesNotMatch(await readFile(resolve(directory, "search_site.json"), "utf8"), /sofa|chair|Fill/);
    assert.deepEqual((await store.list()).map((workflow) => workflow.action), ["search_site"]);

    const secondPlan = compileDomWorkflow("search_site", "https://example.test", [
      demonstration("desk"),
      demonstration("lamp"),
    ]);
    const second = await store.save(secondPlan);
    assert.equal(second.version, 2);
    await assert.rejects(() => store.update(first), /changed while its runtime evidence/);
    const copyA = await store.load("search_site");
    const copyB = await store.load("search_site");
    assert.ok(copyA && copyB);
    copyA.baseline.status = "stable";
    await store.update(copyA);
    copyB.baseline.status = "degraded";
    await assert.rejects(() => store.update(copyB), /changed while its runtime evidence/);
    assert.equal((await store.load("search_site"))?.version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow store rejects unsafe action names", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-store-name-"));
  try {
    const store = new WorkflowStore(directory);
    await assert.rejects(() => store.load("../escape"), /Action names/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow store revalidates effect boundaries in persisted DOM plans", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-store-tamper-"));
  try {
    const store = new WorkflowStore(directory);
    const plan = compileDomWorkflow("search_site", "https://example.test", [
      demonstration("sofa"),
      demonstration("chair"),
    ]);
    await store.save(plan);
    const path = resolve(directory, "search_site.json");
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      baseline: { actions: Array<Record<string, unknown>> };
    };
    persisted.baseline.actions[0]!.method = "setInputFiles";
    persisted.baseline.actions[0]!.arguments = [[{ $clappingHandsInput: "query" }]];
    await writeFile(path, `${JSON.stringify(persisted)}\n`);
    await assert.rejects(() => store.load("search_site"), /read DOM workflow cannot contain/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted form plans reject cross-origin and mutation-shaped actions", () => {
  const plan: FormWorkflowPlan = {
    formatVersion: "clapping-hands.dev/v1alpha2",
    engine: "html-form-v2",
    action: "search_form",
    version: 1,
    effect: "read",
    origin: "https://example.test",
    startPath: "/search",
    status: "provisional",
    steps: [{
      questionKey: "search",
      formIndex: 0,
      formSignature: "fixture",
      pagePath: "/search",
      method: "GET",
      actionPath: "/results",
      encoding: "application/x-www-form-urlencoded",
      submitter: { index: 0, name: null, value: null },
      transition: "navigation",
      controls: [{ name: "query", kind: "text", required: true, multiple: false, optionValues: [] }],
    }],
    validation: {
      maximumSteps: 10,
      finalContentSelector: "main",
      finalHeadingMode: "one-of",
      finalHeadingHashes: ["fixture"],
    },
    evidence: {
      demonstrationInputHashes: ["fixture"],
      successfulShadowInputHashes: [],
      failedShadowCount: 0,
      lastValidatedAt: null,
    },
  };
  assert.doesNotThrow(() => assertFormWorkflowPlanSafety(plan));
  plan.steps[0]!.actionPath = "https://outside.test/delete";
  assert.throws(() => assertFormWorkflowPlanSafety(plan), /same-origin absolute path/);
  plan.steps[0]!.actionPath = "/delete";
  plan.steps[0]!.method = "POST";
  assert.throws(() => assertFormWorkflowPlanSafety(plan), /mutation-shaped path/);
});
