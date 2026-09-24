import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { generateText } from "ai";
import { createLearnerModel, endpointConfiguration, learnerEnvironment, LearnerConfigurationError, type LearnerConfigurationReason } from "../src/learner-model.js";

function configurationFailure(reason: LearnerConfigurationReason, privateValues: string[] = []) {
  return (error: unknown) => {
    assert.ok(error instanceof LearnerConfigurationError); assert.equal(error.reason, reason);
    assert.equal(error.code, "LEARNER_CONFIGURATION_REQUIRED");
    assert.equal(Object.hasOwn(error, "cause"), false);
    const visible = String(error) + JSON.stringify(error) + inspect(error);
    for (const value of privateValues) assert.equal(visible.includes(value), false, "Configuration error must not retain private input.");
    return true;
  };
}

test("Astra uses Responses with low reasoning and no server-side storage", async (t) => {
  let target = "";
  let body: Record<string, any> = {};
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    target = String(input); body = JSON.parse(String(init?.body));
    throw new Error("Fixture stops before network access");
  });
  const model = await createLearnerModel({ GPT_BASE_URL: "https://fixture.invalid/v1", GPT_API_KEY: "fixture-only" });
  await assert.rejects(generateText({ model, prompt: "fixture", maxRetries: 0 }));
  assert.equal(target, "https://fixture.invalid/v1/responses");
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.store, false);
  assert.equal(body.temperature, undefined);
});

test("custom endpoint normalization keeps credentials out of URLs", () => {
  const config = endpointConfiguration({ GPT_BASE_URL: "https://fixture.invalid/", GPT_API_KEY: "test-only" });
  assert.equal(config.baseURL, "https://fixture.invalid/v1");
  assert.equal(config.apiKey, "test-only");
  for (const base of ["http://fixture.invalid", "https://user:pass@fixture.invalid", "https://fixture.invalid/?token=secret"]) {
    assert.throws(() => endpointConfiguration({ GPT_BASE_URL: base, GPT_API_KEY: "test-only" }), configurationFailure("invalid-endpoint", [base, "test-only"]));
  }
});

test("missing and whitespace-only endpoint/key produce stable setup categories", () => {
  for (const base of [undefined, "", " \t "]) {
    assert.throws(() => endpointConfiguration({ GPT_BASE_URL: base, GPT_API_KEY: "fixture-private-key" }), configurationFailure("missing-endpoint", ["fixture-private-key"]));
  }
  for (const key of [undefined, "", " \t "]) {
    assert.throws(() => endpointConfiguration({ GPT_BASE_URL: "https://fixture.invalid", GPT_API_KEY: key }), configurationFailure("missing-api-key"));
  }
});

test("malformed, non-HTTPS and credential-bearing endpoint errors never retain URL/parser inputs", () => {
  const key = "fixture-private-api-key";
  const inputs = ["fixture-private-not-a-url", "http://fixture.invalid/private", "file:///fixture-private-path",
    "https://fixture-private-user:fixture-private-password@fixture.invalid/v1", "https://fixture.invalid/v1?fixture-private-key=secret",
    "https://fixture.invalid/v1#fixture-private-fragment", "https://[fixture-private-host"];
  for (const base of inputs) assert.throws(() => endpointConfiguration({ GPT_BASE_URL: base, GPT_API_KEY: key }), configurationFailure("invalid-endpoint", [base, key, "fixture-private"]));
});

test("unreadable configured files produce typed errors without private paths or filesystem causes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-private-config-"));
  try {
    for (const path of [resolve(directory, "fixture-private-missing.env"), directory]) {
      await assert.rejects(learnerEnvironment({ CLAPPING_HANDS_CREDENTIAL_ENV_FILE: path }), configurationFailure("unreadable-env-file", [path, directory, "fixture-private"]));
      await assert.rejects(createLearnerModel({ CLAPPING_HANDS_CREDENTIAL_ENV_FILE: path }), configurationFailure("unreadable-env-file", [path, directory, "fixture-private"]));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("controlled environment files and explicit overrides preserve provider/model configuration", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-config-fixture-"));
  const path = resolve(directory, "fixture-only.env");
  try {
    await writeFile(path, "GPT_BASE_URL=https://fixture.invalid/custom/v1/\nGPT_API_KEY=fixture-only-file-key\nCLAPPING_HANDS_ENDPOINT_MODEL=fixture-model\n", { mode: 0o600 });
    const merged = await learnerEnvironment({ CLAPPING_HANDS_CREDENTIAL_ENV_FILE: path, GPT_API_KEY: "fixture-only-override-key" });
    const config = endpointConfiguration(merged);
    assert.equal(config.baseURL, "https://fixture.invalid/custom/v1"); assert.equal(config.apiKey, "fixture-only-override-key"); assert.equal(config.model, "fixture-model");
    assert.equal(endpointConfiguration({ GPT_BASE_URL: "https://fixture.invalid", GPT_API_KEY: "fixture-only" }).model, "gpt-6-astra");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("typed configuration checks fail before any provider request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Fixture forbids provider requests."); });
  await assert.rejects(createLearnerModel({}), configurationFailure("missing-endpoint"));
  await assert.rejects(createLearnerModel({ GPT_BASE_URL: "https://fixture.invalid" }), configurationFailure("missing-api-key"));
  await assert.rejects(createLearnerModel({ GPT_BASE_URL: "fixture-private-invalid", GPT_API_KEY: "fixture-private-key" }), configurationFailure("invalid-endpoint", ["fixture-private"]));
  assert.equal(requests, 0);
});
