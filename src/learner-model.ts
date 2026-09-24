import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

export type LearnerConfigurationReason = "missing-endpoint" | "missing-api-key" | "unreadable-env-file" | "invalid-endpoint";

/** Product-owned setup failures contain categories only, never supplied values or upstream causes. */
export class LearnerConfigurationError extends Error {
  readonly code = "LEARNER_CONFIGURATION_REQUIRED";
  readonly #reason: LearnerConfigurationReason;
  constructor(reason: LearnerConfigurationReason) {
    super("Learner configuration is incomplete or invalid.");
    this.name = "LearnerConfigurationError";
    this.#reason = reason;
  }
  get reason(): LearnerConfigurationReason { return this.#reason; }
}

export async function learnerEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const file = environment.CLAPPING_HANDS_CREDENTIAL_ENV_FILE;
  if (!file) return environment;
  try { return { ...parseEnv(await readFile(file, "utf8")), ...environment }; }
  catch { throw new LearnerConfigurationError("unreadable-env-file"); }
}

export function endpointConfiguration(environment: NodeJS.ProcessEnv) {
  const key = environment.GPT_API_KEY;
  const base = environment.GPT_BASE_URL;
  if (!base || !base.trim()) throw new LearnerConfigurationError("missing-endpoint");
  if (!key || !key.trim()) throw new LearnerConfigurationError("missing-api-key");
  let url: URL;
  try { url = new URL(base); }
  catch { throw new LearnerConfigurationError("invalid-endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new LearnerConfigurationError("invalid-endpoint");
  }
  url.pathname = url.pathname.replace(/\/$/, "") || "/v1";
  return { apiKey: key, baseURL: url.href.replace(/\/$/, ""), model: environment.CLAPPING_HANDS_ENDPOINT_MODEL ?? "gpt-6-astra" };
}

export async function createLearnerModel(environment: NodeJS.ProcessEnv = process.env) {
  const config = endpointConfiguration(await learnerEnvironment(environment));
  const provider = createOpenAI({
    apiKey: config.apiKey, baseURL: config.baseURL,
    // Never redirect a credential-bearing request to another endpoint.
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  // Astra tool calling requires Responses; keep explicit legacy-model overrides compatible.
  if (config.model === "gpt-6-astra") return wrapLanguageModel({
    model: provider.responses(config.model),
    middleware: defaultSettingsMiddleware({ settings: {
      providerOptions: { openai: { reasoningEffort: "low", forceReasoning: true, store: false } },
    } }),
  });
  return provider.chat(config.model);
}
