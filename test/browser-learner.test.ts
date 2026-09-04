import assert from "node:assert/strict";
import test from "node:test";
import { resolveStagehandModel } from "../src/browser-learner.js";

test("resolves the explicit Stagehand model without exposing or persisting its API key", () => {
  const resolved = resolveStagehandModel({
    CLAPPING_HANDS_MODEL: "anthropic/claude-haiku-4-5",
    ANTHROPIC_API_KEY: "test-only-secret",
  });
  assert.equal(resolved.modelName, "anthropic/claude-haiku-4-5");
  assert.equal(resolved.apiKey, "test-only-secret");
  assert.throws(
    () => resolveStagehandModel({ CLAPPING_HANDS_MODEL: "google/gemini-2.5-flash" }),
    /requires one of: GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY/,
  );
});
