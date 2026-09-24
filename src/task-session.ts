import { createServer } from 'node:net';
import { chromium, type BrowserContext } from 'playwright-core';
import { NetworkRecorder } from './network-recorder.js';
import { ProfileLease } from './profile.js';
import { captureOwnedChromePid, waitForOwnedChromeExit } from './owned-browser-process.js';
import { authorizedNetworkOrigins } from './task-network-scope.js';

export class TaskSession {
  readonly network = new NetworkRecorder();
  /** Passive evidence only. Cross-origin responses received by the page do not
   * grant the compiler or replay transport cross-origin execution authority. */
  readonly evidenceNetwork = new NetworkRecorder({ passiveCrossOriginEvidence: true });
  private lease: ProfileLease;
  context!: BrowserContext;
  cdpUrl = '';
  private pid: number | null = null;
  constructor(readonly origin: string, readonly profile: string, readonly headless = true, readonly allowedNetworkOrigins:string[] = []) {
    this.lease = new ProfileLease(profile, 'browser-use', [origin]);
  }
  async start() {
    await this.lease.acquire();
    const allocator = createServer();
    let launchAttempted = false;
    try {
      await new Promise<void>((resolve, reject) => { allocator.once('error', reject); allocator.listen(0, '127.0.0.1', resolve); });
      const address = allocator.address();
      if (!address || typeof address === 'string') throw new Error('No browser port.');
      await new Promise<void>(resolve => allocator.close(() => resolve()));
      this.cdpUrl = 'http://127.0.0.1:'+address.port;
      launchAttempted = true;
      this.context = await chromium.launchPersistentContext(this.profile, {
        executablePath: process.env.CLAPPING_HANDS_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: this.headless, viewport: { width: 1440, height: 1000 },
        args: ['--remote-debugging-port='+address.port],
      });
      this.pid = await captureOwnedChromePid(this.profile);
      this.network.setAllowedOrigins([...authorizedNetworkOrigins({startUrl:this.origin,allowedNetworkOrigins:this.allowedNetworkOrigins})]);
      // Exact-origin policy stays at the host, including popups and redirects.
      await this.context.route('**/*', async route => {
        const req = route.request();
        if (req.isNavigationRequest() && !req.frame().parentFrame() && new URL(req.url()).origin !== this.origin) {
          await route.abort(); return;
        }
        await route.continue();
      });
      const attach = (page: import('playwright-core').Page) => { this.network.attach(page); this.evidenceNetwork.attach(page); };
      this.context.on('page', attach);
      this.context.pages().forEach(attach);
    } catch (error) {
      allocator.close();
      if (this.context) await this.close();
      else {
        // Launcher may have created Chrome before rejecting. Release only after
        // positively checking for an owned process; otherwise retain the lease.
        if (launchAttempted) throw new Error('Browser startup requires cleanup; profile ownership remains reserved.');
        await this.lease.release();
      }
      throw error;
    }
  }
  async close() {
    await this.context?.close();
    await waitForOwnedChromeExit(this.pid);
    await this.lease.release();
  }
}
