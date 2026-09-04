import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  StagehandBrowserLearner,
  type BrowserAction,
  type BrowserActResult,
  type BrowserLearner,
  type BrowserLearnerLease,
} from "./browser-learner.js";
import { NetworkRecorder } from "./network-recorder.js";
import { ProfileLease } from "./profile.js";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type WorkflowBrowserOptions = {
  allowedOrigins: string[];
  profileDirectory?: string;
  headless?: boolean;
  executablePath?: string;
};

function canonicalOrigins(origins: string[]): string[] {
  const result = [...new Set(origins.map((origin) => {
    const parsed = new URL(origin);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`Allowed origin must be an HTTP(S) origin without a path: ${origin}`);
    }
    return parsed.origin;
  }))].sort();
  if (result.length === 0) throw new Error("At least one allowed origin is required.");
  return result;
}

async function connectOverCdpWhenReady(cdpUrl: string): Promise<Browser> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Chrome did not expose its debugging endpoint.");
}

export class WorkflowBrowser {
  readonly network = new NetworkRecorder();
  readonly allowedOrigins: string[];
  private readonly profileDirectory: string;
  private learnerLease: BrowserLearnerLease | null = null;
  private driverBrowser: Browser | null = null;
  private driverContext: BrowserContext | null = null;
  private driverPage: Page | null = null;
  private profileLease: ProfileLease | null = null;

  constructor(
    private readonly options: WorkflowBrowserOptions,
    private readonly learner: BrowserLearner = new StagehandBrowserLearner(),
  ) {
    this.allowedOrigins = canonicalOrigins(options.allowedOrigins);
    const profileId = createHash("sha256").update(this.allowedOrigins.join("\n")).digest("hex").slice(0, 16);
    this.profileDirectory = resolve(options.profileDirectory ?? `.data/profiles/${profileId}`);
  }

  async start(): Promise<void> {
    if (this.learnerLease) return;
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    const profileId = `workflow-${createHash("sha256").update(this.allowedOrigins.join("\n")).digest("hex").slice(0, 12)}`;
    const profileLease = new ProfileLease(this.profileDirectory, profileId, this.allowedOrigins);
    await profileLease.acquire();
    this.profileLease = profileLease;
    try {
      this.learnerLease = await this.learner.launch({
        headless: this.options.headless ?? process.env.CLAPPING_HANDS_HEADLESS === "true",
        executablePath: this.options.executablePath ?? process.env.CLAPPING_HANDS_CHROME_PATH ?? DEFAULT_CHROME,
        userDataDir: this.profileDirectory,
        viewport: { width: 1440, height: 1000 },
      });
      this.driverBrowser = await connectOverCdpWhenReady(this.learnerLease.cdpUrl);
      this.driverContext = this.driverBrowser.contexts()[0] ?? null;
      if (!this.driverContext) throw new Error("Chrome did not expose its persistent browser context.");
      await this.driverContext.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && !request.frame().parentFrame()) {
          try {
            const destination = new URL(request.url());
            if (!this.allowedOrigins.includes(destination.origin)) {
              await route.abort("blockedbyclient");
              return;
            }
          } catch {
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      });
      const attach = (page: Page): void => this.network.attach(page);
      this.driverContext.on("page", attach);
      const pages = this.driverContext.pages();
      pages.forEach(attach);
      this.driverPage = pages.find((page) => {
        if (page.url() === "about:blank") return true;
        try {
          return this.allowedOrigins.includes(new URL(page.url()).origin);
        } catch {
          return false;
        }
      }) ?? null;
      if (!this.driverPage) {
        this.driverPage = await this.driverContext.newPage();
        attach(this.driverPage);
      }
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async page(): Promise<Page> {
    await this.start();
    if (!this.driverPage) throw new Error("Workflow browser page is unavailable.");
    return this.driverPage;
  }

  async context(): Promise<BrowserContext> {
    await this.start();
    if (!this.driverContext) throw new Error("Workflow browser context is unavailable.");
    return this.driverContext;
  }

  async goto(url: string): Promise<Page> {
    const destination = new URL(url);
    if (!this.allowedOrigins.includes(destination.origin)) {
      throw new Error(`Navigation outside the allowed origins was denied: ${destination.origin}`);
    }
    const page = await this.page();
    await page.goto(destination.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return page;
  }

  async act(instruction: string | BrowserAction): Promise<BrowserActResult> {
    await this.start();
    const result = await this.learnerLease!.act(instruction);
    await this.assertPagesStayAllowed();
    return result;
  }

  async observe(instruction?: string): Promise<{ actions: BrowserAction[]; modelCalls: number }> {
    await this.start();
    return this.learnerLease!.observe(instruction);
  }

  private async assertPagesStayAllowed(): Promise<void> {
    const context = await this.context();
    for (const page of context.pages()) {
      const url = page.url();
      if (url === "about:blank" || url.startsWith("chrome-extension://")) continue;
      if (!this.allowedOrigins.includes(new URL(url).origin)) {
        throw new Error(`Workflow opened a page outside the allowed origins: ${new URL(url).origin}`);
      }
    }
  }

  async close(): Promise<void> {
    const learnerLease = this.learnerLease;
    const driverBrowser = this.driverBrowser;
    const profileLease = this.profileLease;
    this.learnerLease = null;
    this.driverBrowser = null;
    this.driverContext = null;
    this.driverPage = null;
    this.profileLease = null;
    if (learnerLease) await learnerLease.close();
    else if (driverBrowser) await driverBrowser.close().catch(() => {});
    if (profileLease) await profileLease.release();
  }
}
