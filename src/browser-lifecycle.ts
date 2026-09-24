/** Fixed public category: never retain upstream errors, URLs or process details. */
export class BrowserShutdownError extends Error {
  readonly code = "BROWSER_SHUTDOWN_UNCERTAIN";
  constructor() {
    super("Browser shutdown is incomplete. Close the dedicated browser and verify profile ownership before retrying; do not delete profile locks.");
  }
}

const pendingCleanup = new WeakMap<BrowserShutdownError, () => Promise<void>>();

/** A partially failed launch may still own a browser. Transfer only its exact
 * cleanup closure, process-privately; it must never enter persisted/public data. */
export function browserShutdownWithCleanup(cleanup: () => Promise<void>): BrowserShutdownError {
  const error = new BrowserShutdownError();
  pendingCleanup.set(error, cleanup);
  return error;
}

export function browserShutdownCleanup(error: unknown): (() => Promise<void>) | undefined {
  return typeof error === "object" && error !== null ? pendingCleanup.get(error as BrowserShutdownError) : undefined;
}

/** Serialize startup/shutdown, and never equate a rejected close with release. */
export class BrowserLifecycle {
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private blocked = false;

  assertAvailable(): void { if (this.blocked) throw new BrowserShutdownError(); }
  markUncertain(): void { this.blocked = true; }

  start(ready: boolean, work: () => Promise<void>): Promise<void> {
    this.assertAvailable();
    if (this.starting) return this.starting;
    if (ready) return Promise.resolve();
    this.starting = Promise.resolve().then(work).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  close(work: () => Promise<void>): Promise<void> {
    if (this.closing) return this.closing;
    this.blocked = true;
    this.closing = Promise.resolve().then(async () => {
      // A launch already in progress may acquire resources after close begins.
      await this.starting?.catch(() => {});
      await work();
      this.blocked = false;
    }).catch(() => { throw new BrowserShutdownError(); })
      .finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
