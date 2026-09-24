import { randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises";

export type WorkflowLockStatus = "none" | "active" | "stale" | "unverifiable";
export type WorkflowLockRecord = {
  formatVersion: "clapping-hands.dev/workflow-lock-v1";
  pid: number;
  nonce: string;
  createdAt: string;
};

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function regularFileContents(path: string, maximumBytes?: number): Promise<string | null> {
  let handle: FileHandle;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("Workflow maintenance refuses a non-regular file.");
    // Recovery never follows a symlink. O_NOFOLLOW is supported on the release target.
    const { constants } = await import("node:fs");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    if (maximumBytes !== undefined && (await handle.stat()).size > maximumBytes) throw new Error("Workflow lock metadata exceeds its size bound.");
    return await handle.readFile("utf8");
  }
  finally { await handle.close(); }
}

export async function inspectWorkflowLock(path: string): Promise<{ status: WorkflowLockStatus; record?: WorkflowLockRecord }> {
  let raw: string | null;
  try { raw = await regularFileContents(path, 8_192); }
  catch { return { status: "unverifiable" }; }
  if (raw === null) return { status: "none" };
  let record: WorkflowLockRecord;
  try { record = JSON.parse(raw) as WorkflowLockRecord; }
  catch { return { status: "unverifiable" }; }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
    Object.keys(record).some((key) => !["formatVersion", "pid", "nonce", "createdAt"].includes(key)) ||
    record.formatVersion !== "clapping-hands.dev/workflow-lock-v1" || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
    typeof record.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.nonce) ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) return { status: "unverifiable" };
  try { process.kill(record.pid, 0); return { status: "active", record }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ESRCH" ? "stale" : code === "EPERM" ? "active" : "unverifiable", record };
  }
}

/** Cooperating writers must own this exact inode/nonce and respect the maintenance guard. */
export async function acquireWorkflowFileLock(path: string, blockedBy?: string): Promise<{ assertOwned(): Promise<void>; release(): Promise<void>; abandon(): Promise<void> }> {
  if (blockedBy && await pathExists(blockedBy)) throw new Error("Workflow recovery is in progress; no update was started.");
  let handle: FileHandle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Workflow is being updated concurrently or requires storage recovery.");
    throw error;
  }
  const identity = await handle.stat();
  const record: WorkflowLockRecord = { formatVersion: "clapping-hands.dev/workflow-lock-v1", pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close();
    try {
      const current = await lstat(path);
      if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const assertOwned = async () => {
    if (released || blockedBy && await pathExists(blockedBy)) throw new Error("Workflow recovery interrupted acquisition; no update was started.");
    const current = await inspectWorkflowLock(path);
    if (current.status !== "active" || current.record?.pid !== record.pid || current.record?.nonce !== record.nonce) {
      throw new Error("Workflow writer no longer owns its storage lock.");
    }
  };
  try {
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
    await assertOwned();
    return { assertOwned, release, abandon: async () => {
      if (!released) { released = true; await handle.close(); }
    } };
  } catch (error) { await release(); throw error; }
}
