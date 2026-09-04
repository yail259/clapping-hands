import { createServer } from "node:net";
import { readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localBrowser, Stagehand, type Action, type ModelName } from "@browserbasehq/stagehand";

export type BrowserLaunchRequest = {
  executablePath: string;
  userDataDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
};

export interface BrowserLearnerLease {
  readonly cdpUrl: string;
  readonly provider: string;
  activatePage(url: string): Promise<void>;
  act(instruction: string | BrowserAction): Promise<BrowserActResult>;
  observe(instruction?: string): Promise<{ actions: BrowserAction[]; modelCalls: number }>;
  close(): Promise<void>;
}

export type BrowserAction = {
  selector: string;
  description: string;
  method?: string;
  arguments?: string[];
  opensNewPage?: boolean;
  framePath?: string[];
};

export type BrowserActResult = {
  success: boolean;
  message: string;
  actions: BrowserAction[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export interface BrowserLearner {
  launch(request: BrowserLaunchRequest): Promise<BrowserLearnerLease>;
}

const PROVIDER_KEYS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
};

export function resolveStagehandModel(environment: NodeJS.ProcessEnv = process.env): { modelName: ModelName; apiKey: string } {
  const modelName = environment.CLAPPING_HANDS_MODEL ?? "openai/gpt-5.4-mini";
  const provider = modelName.split("/", 1)[0] ?? "";
  const candidates = PROVIDER_KEYS[provider];
  if (!candidates) {
    throw new Error(`Unsupported Stagehand model provider ${provider || "unknown"}.`);
  }
  const keyName = candidates.find((name) => environment[name]);
  if (!keyName) {
    throw new Error(`Stagehand model ${modelName} requires one of: ${candidates.join(", ")}.`);
  }
  return { modelName: modelName as ModelName, apiKey: environment[keyName]! };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Chrome debugging port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function chromeProcessId(userDataDir: string): Promise<number | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const target = await readlink(resolve(userDataDir, "SingletonLock"));
      const match = target.match(/-(\d+)$/);
      if (match?.[1]) return Number.parseInt(match[1], 10);
    } catch {
      // Chrome may not have created its profile singleton yet.
    }
    await delay(50);
  }
  return null;
}

async function ensureChromeStopped(pid: number | null): Promise<void> {
  if (!pid) return;
  for (let attempt = 0; attempt < 20 && processIsAlive(pid); attempt += 1) await delay(100);
  if (!processIsAlive(pid)) return;

  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && processIsAlive(pid); attempt += 1) await delay(100);
  if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 20 && processIsAlive(pid); attempt += 1) await delay(100);
  if (processIsAlive(pid)) {
    throw new Error(`Dedicated Chrome process ${pid} did not exit; the profile lease remains held.`);
  }
}

export class StagehandBrowserLearner implements BrowserLearner {
  async launch(request: BrowserLaunchRequest): Promise<BrowserLearnerLease> {
    const port = await availablePort();
    const browser = await localBrowser.launch({
      headless: request.headless,
      executablePath: request.executablePath,
      userDataDir: request.userDataDir,
      preserveUserDataDir: true,
      viewport: request.viewport,
      port,
      args: ["--restore-last-session"],
    });
    const browserProcessId = await chromeProcessId(request.userDataDir);

    let stagehand: Stagehand | null = null;
    try {
      stagehand = await Stagehand.create({
        browser,
        model: resolveStagehandModel(),
        selfHeal: true,
        cache: false,
        logging: { level: "off" },
      });
    } catch (error) {
      await browser.close().catch(() => {});
      await ensureChromeStopped(browserProcessId).catch(() => {});
      throw error;
    }

    return {
      cdpUrl: `http://127.0.0.1:${port}`,
      provider: "stagehand-v4-local",
      async activatePage(url) {
        const pages = await browser.context.pages();
        const matches = [];
        for (const page of pages) {
          if (await page.url() === url) matches.push(page);
        }
        if (matches.length !== 1) {
          throw new Error(`Could not select exactly one learner page for the deterministic driver; found ${matches.length}.`);
        }
        await browser.context.setActivePage(matches[0]!);
      },
      async act(instruction) {
        let result;
        if (typeof instruction === "string") {
          result = await stagehand.act(instruction);
        } else {
          const { opensNewPage: _opensNewPage, framePath: _framePath, ...action } = instruction;
          result = await stagehand.act(action as Action);
        }
        return {
          success: result.data.success,
          message: result.data.message,
          actions: result.data.actions,
          modelCalls: result.metadata.usage.inferenceTimeMs > 0 ? 1 : 0,
          inputTokens: result.metadata.usage.inputTokens,
          outputTokens: result.metadata.usage.outputTokens,
        };
      },
      async observe(instruction) {
        const result = await stagehand.observe(instruction);
        return {
          actions: result.data,
          modelCalls: result.metadata.usage.inferenceTimeMs > 0 ? 1 : 0,
        };
      },
      async close() {
        await stagehand?.close().catch(() => {});
        await browser.close().catch(() => {});
        await ensureChromeStopped(browserProcessId);
      },
    };
  }
}
