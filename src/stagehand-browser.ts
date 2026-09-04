import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { RawMarketplaceCard } from "./marketplace.js";
import { StagehandBrowserLearner, type BrowserLearner, type BrowserLearnerLease } from "./browser-learner.js";
import { NetworkRecorder } from "./network-recorder.js";
import { configuredProfileDirectory, ProfileLease, type AuthStatus } from "./profile.js";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
  throw lastError instanceof Error
    ? new Error(`Chrome did not expose its debugging endpoint in time: ${lastError.message}`)
    : new Error("Chrome did not expose its debugging endpoint in time.");
}

export type MarketplacePageState = AuthStatus & {
  authenticated: boolean;
  hasLoginForm: boolean;
  currentUrl: string;
};

export class StagehandBrowser {
  private learnerLease: BrowserLearnerLease | null = null;
  private driverBrowser: Browser | null = null;
  private driverContext: BrowserContext | null = null;
  private driverPage: Page | null = null;
  private profileLease: ProfileLease | null = null;
  readonly network = new NetworkRecorder();

  constructor(private readonly learner: BrowserLearner = new StagehandBrowserLearner()) {}

  async start(): Promise<void> {
    if (this.learnerLease) return;

    const userDataDir = configuredProfileDirectory();
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    const profileLease = new ProfileLease(userDataDir);
    await profileLease.acquire();
    this.profileLease = profileLease;

    try {
      const learnerLease = await this.learner.launch({
        headless: process.env.CLAPPING_HANDS_HEADLESS === "true",
        executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? DEFAULT_CHROME,
        userDataDir,
        viewport: { width: 1440, height: 1000 },
      });
      this.learnerLease = learnerLease;
      this.driverBrowser = await connectOverCdpWhenReady(learnerLease.cdpUrl);
      this.driverContext = this.driverBrowser.contexts()[0] ?? null;
      if (!this.driverContext) throw new Error("Chrome did not expose its persistent browser context.");
      const pages = this.driverContext.pages();
      this.driverPage = pages.find((page) => !page.url().startsWith("chrome-extension://")) ?? pages[0] ?? null;
      if (!this.driverPage) this.driverPage = await this.driverContext.newPage();
      this.network.attach(this.driverPage);
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async page(): Promise<Page> {
    await this.start();
    if (!this.driverPage) throw new Error("Browser page is unavailable.");
    return this.driverPage;
  }

  async context(): Promise<BrowserContext> {
    await this.start();
    if (!this.driverContext) throw new Error("Browser context is unavailable.");
    return this.driverContext;
  }

  async goto(url: string, settleMs = 1_000): Promise<void> {
    const page = await this.page();
    const destination = new URL(url);
    if (destination.origin !== "https://www.facebook.com") {
      throw new Error(`Navigation outside the allowed origin was denied: ${destination.origin}`);
    }
    await page.goto(destination.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (settleMs > 0) await page.waitForTimeout(settleMs);
  }

  async openAuthentication(): Promise<MarketplacePageState> {
    await this.goto("https://www.facebook.com/marketplace/", 500);
    await (await this.page()).bringToFront();
    return this.state();
  }

  async state(): Promise<MarketplacePageState> {
    const page = await this.page();
    const context = await this.context();
    const [domState, cookies] = await Promise.all([
      page.evaluate(() => ({
        hasLoginForm: Boolean(document.querySelector(
          'input[name="email"], input[autocomplete="username"], form[action*="login"] input[type="password"]',
        )),
      })),
      context.cookies("https://www.facebook.com"),
    ]);
    const currentUrl = page.url();
    const userCookie = cookies.find((cookie) => cookie.name === "c_user");
    const checkpoint = cookies.some((cookie) => cookie.name === "checkpoint") || /\/checkpoint\//.test(currentUrl);
    const persistent = Boolean(userCookie && userCookie.expires > Date.now() / 1_000 + 60);

    let state: AuthStatus["state"] = "unknown";
    if (userCookie && !checkpoint) state = "authenticated";
    else if (checkpoint) state = "checkpoint";
    else if (domState.hasLoginForm || !userCookie) state = "required";

    const auth: AuthStatus = {
      state,
      persistence: userCookie ? (persistent ? "persistent" : "session") : "none",
      profileId: "facebook-marketplace",
      canRetryWithoutHuman: state === "authenticated",
      challenge: state === "checkpoint" ? "checkpoint" : state === "required" ? "login" : null,
      safeSummary: state === "authenticated"
        ? `Facebook is authenticated with a ${persistent ? "persistent" : "session-only"} browser login.`
        : state === "checkpoint"
          ? "Facebook requires a checkpoint or account challenge in the opened browser."
          : "Facebook login is required in the opened Clapping Hands browser.",
    };
    return { ...auth, authenticated: state === "authenticated", hasLoginForm: domState.hasLoginForm, currentUrl };
  }

  async collectMarketplaceCards(maxScrolls: number): Promise<{
    cards: RawMarketplaceCard[];
    initialCards: RawMarketplaceCard[];
    snapshots: RawMarketplaceCard[][];
    counts: number[];
    stabilized: boolean;
  }> {
    const initialCards = await this.snapshotMarketplaceCards();
    const snapshots = [initialCards];
    const accumulated = new Map(initialCards.map((card) => [card.href, card]));
    const counts: number[] = [accumulated.size];
    let stableRounds = 0;

    for (let index = 0; index < maxScrolls && stableRounds < 3; index += 1) {
      await this.scrollMarketplaceOnce();
      const snapshot = await this.snapshotMarketplaceCards();
      snapshots.push(snapshot);
      for (const card of snapshot) accumulated.set(card.href, card);
      const count = accumulated.size;
      stableRounds = count === counts.at(-1) ? stableRounds + 1 : 0;
      counts.push(count);
    }

    return {
      cards: [...accumulated.values()],
      initialCards,
      snapshots,
      counts,
      stabilized: stableRounds >= 3,
    };
  }

  async snapshotMarketplaceCards(): Promise<RawMarketplaceCard[]> {
    const page = await this.page();
    return page.locator('a[href*="/marketplace/item/"]').evaluateAll((anchors) =>
      anchors.map((element) => {
        const anchor = element as HTMLAnchorElement;
        const image = anchor.querySelector<HTMLImageElement>("img");
        return {
          href: anchor.href,
          ariaLabel: anchor.getAttribute("aria-label"),
          text: (anchor as HTMLElement).innerText,
          imageUrl: image?.src ?? null,
          imageAlt: image?.alt ?? null,
        };
      }),
    );
  }

  async scrollMarketplaceOnce(settleMs = 850): Promise<void> {
    const page = await this.page();
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 1.5, 1_000)));
    if (settleMs > 0) await page.waitForTimeout(settleMs);
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
    // Closing a CDP connection is not sufficient: Chrome may keep the
    // persistent-profile process alive and silently reuse its old debugging
    // port on the next launch. Close the actual browser before releasing the
    // one-writer profile lease.
    // The learner launched and owns Chrome. Its close path terminates the
    // chrome-launcher process group. Calling Playwright Browser.close first can
    // leave macOS Chrome alive without its debugging socket, so only use that
    // path for a non-learner browser.
    if (learnerLease) await learnerLease.close();
    else if (driverBrowser) await driverBrowser.close().catch(() => {});
    if (profileLease) await profileLease.release();
  }
}
