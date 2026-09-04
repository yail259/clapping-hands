import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { BrowserAction, BrowserActResult } from "./browser-learner.js";
import { NetworkRecorder } from "./network-recorder.js";
import { ProfileLease } from "./profile.js";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type PersistentBrowserOptions = {
  allowedOrigins: string[];
  profileDirectory: string;
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

export class PersistentWorkflowBrowser {
  readonly network = new NetworkRecorder();
  readonly allowedOrigins: string[];
  private readonly profileDirectory: string;
  private contextLease: BrowserContext | null = null;
  private activePage: Page | null = null;
  private profileLease: ProfileLease | null = null;

  constructor(private readonly options: PersistentBrowserOptions) {
    this.allowedOrigins = canonicalOrigins(options.allowedOrigins);
    this.profileDirectory = resolve(options.profileDirectory);
  }

  async start(): Promise<void> {
    if (this.contextLease) return;
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    const lease = new ProfileLease(this.profileDirectory, "workflow-runtime", this.allowedOrigins);
    await lease.acquire();
    this.profileLease = lease;
    try {
      const context = await chromium.launchPersistentContext(this.profileDirectory, {
        executablePath: this.options.executablePath ?? process.env.CLAPPING_HANDS_CHROME_PATH ?? DEFAULT_CHROME,
        headless: this.options.headless ?? process.env.CLAPPING_HANDS_HEADLESS === "true",
        viewport: { width: 1440, height: 1000 },
        args: ["--restore-last-session"],
      });
      this.contextLease = context;
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && !request.frame().parentFrame()) {
          try {
            if (!this.allowedOrigins.includes(new URL(request.url()).origin)) {
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
      context.on("page", attach);
      const pages = context.pages();
      pages.forEach(attach);
      this.activePage = pages.find((page) => page.url() === "about:blank" || this.isAllowedPage(page)) ?? null;
      if (!this.activePage) {
        this.activePage = await context.newPage();
        attach(this.activePage);
      }
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  private isAllowedPage(page: Page): boolean {
    try {
      return this.allowedOrigins.includes(new URL(page.url()).origin);
    } catch {
      return false;
    }
  }

  async page(): Promise<Page> {
    await this.start();
    if (!this.activePage) throw new Error("Persistent workflow page is unavailable.");
    return this.activePage;
  }

  async context(): Promise<BrowserContext> {
    await this.start();
    if (!this.contextLease) throw new Error("Persistent workflow context is unavailable.");
    return this.contextLease;
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

  async act(_instruction: string | BrowserAction): Promise<BrowserActResult> {
    throw new Error("This deterministic browser does not have an LLM learner. Start a compilation session first.");
  }

  async close(): Promise<void> {
    const context = this.contextLease;
    const profileLease = this.profileLease;
    this.contextLease = null;
    this.activePage = null;
    this.profileLease = null;
    await context?.close().catch(() => {});
    await profileLease?.release();
  }
}
