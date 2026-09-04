import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileDomWorkflow, type DomWorkflowDemonstration } from "../src/dom-workflow.js";
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
