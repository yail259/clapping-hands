import { readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserShutdownError } from "./browser-lifecycle.js";

/** Read once at the successful owned launch boundary, never again on retry.
 * This is local Chrome's profile singleton convention, not portable discovery. */
export async function captureOwnedChromePid(profileDirectory: string): Promise<number | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const target = await readlink(resolve(profileDirectory, "SingletonLock"));
      const match = target.length <= 1_024 ? /^.+-([1-9][0-9]*)$/.exec(target) : null;
      const pid = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch { /* A just-launched Chrome may not have written its singleton yet. */ }
    await delay(50);
  }
  return null;
}

function positivelyExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new BrowserShutdownError();
  }
}

/** A close event/disconnected socket is not process-exit evidence. Poll only;
 * never send a nonzero signal to a captured PID, which may since be reused. */
export async function waitForOwnedChromeExit(pid: number | null): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid === null || pid <= 0) throw new BrowserShutdownError();
  // Chrome's close notification can precede OS process exit, especially when
  // multiple isolated fixtures finish together. Keep a bounded grace period,
  // still shorter than MCP shutdown's deadline; never release on timeout.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (positivelyExited(pid)) return;
    await delay(100);
  }
  if (!positivelyExited(pid)) throw new BrowserShutdownError();
}
