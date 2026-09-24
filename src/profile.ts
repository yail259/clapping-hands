import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { regularFileContents } from "./workflow-file-lock.js";

export type AuthState = "authenticated" | "required" | "checkpoint" | "unknown";
export type AuthPersistence = "persistent" | "session" | "none";

export type AuthStatus = {
  state: AuthState;
  persistence: AuthPersistence;
  profileId: string;
  canRetryWithoutHuman: boolean;
  challenge: "login" | "checkpoint" | null;
  safeSummary: string;
};

export class ProfileInUseError extends Error {
  readonly code = "PROFILE_IN_USE";
}

export class ProfileRecoveryRequiredError extends Error {
  readonly code = "PROFILE_RECOVERY_REQUIRED";
  constructor() { super("The browser profile lock requires explicit recovery; no profile data was changed."); }
}

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  constructor(readonly auth: AuthStatus) {
    super(auth.safeSummary);
  }
}

export function configuredProfileDirectory(): string {
  const configured = process.env.CLAPPING_HANDS_PROFILE_DIR ?? ".data/browser-profile";
  return resolve(process.cwd(), configured);
}

function processState(pid: number): "active" | "stale" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" ? "active" : code === "ESRCH" ? "stale" : "unknown";
  }
}

async function existingProfileOwner(path: string): Promise<"active" | "recovery"> {
  try {
    const raw = await regularFileContents(path, 8_192);
    if (raw === null) return "recovery";
    // Recognize complete legacy PID records, never partial parseInt prefixes.
    if (/^[1-9][0-9]*\n?$/.test(raw)) return processState(Number(raw.trim())) === "active" ? "active" : "recovery";
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["formatVersion", "pid", "nonce", "createdAt"].includes(key)) ||
      value.formatVersion !== "clapping-hands.dev/profile-lock-v1" || typeof value.pid !== "number" ||
      typeof value.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.nonce) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return "recovery";
    return processState(value.pid) === "active" ? "active" : "recovery";
  } catch { return "recovery"; }
}

export class ProfileLease {
  private ownership: { handle: FileHandle; dev: number; ino: number; contents: string } | undefined;
  private releasing: Promise<void> | undefined;
  private readonly lockPath: string;

  constructor(
    readonly directory: string,
    readonly profileId = "facebook-marketplace",
    private readonly allowedOrigins: string[] = ["https://www.facebook.com"],
  ) {
    this.lockPath = resolve(directory, ".clapping-hands.lock");
  }

  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    let handle: FileHandle;
    try { handle = await open(this.lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await existingProfileOwner(this.lockPath) === "active") throw new ProfileInUseError("The browser profile is already in use.");
      // Dead, malformed and unknown owners need explicit guarded maintenance. Never unlink by age or PID alone.
      throw new ProfileRecoveryRequiredError();
    }
    const contents = JSON.stringify({ formatVersion: "clapping-hands.dev/profile-lock-v1", pid: process.pid,
      nonce: randomUUID(), createdAt: new Date().toISOString() }) + "\n";
    try {
      const identity = await handle.stat();
      this.ownership = { handle, dev: identity.dev, ino: identity.ino, contents };
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await this.writeMetadata();
    } catch (error) {
      if (this.ownership) await this.release();
      else await handle.close();
      throw error;
    }
  }

  release(): Promise<void> {
    this.releasing ??= this.releaseOwned().finally(() => { this.releasing = undefined; });
    return this.releasing;
  }

  private async releaseOwned(): Promise<void> {
    const owned = this.ownership;
    if (!owned) return;
    let completed = false;
    try {
      const current = await lstat(this.lockPath);
      if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) { completed = true; return; }
      // Preserve replacement contents even when another actor reused the same inode.
      if (await regularFileContents(this.lockPath, 8_192) !== owned.contents) { completed = true; return; }
      const rechecked = await lstat(this.lockPath);
      if (rechecked.isFile() && rechecked.dev === owned.dev && rechecked.ino === owned.ino) await unlink(this.lockPath);
      completed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      completed = true;
    } finally {
      // Keep the exact ownership handle after I/O failure, so an explicit retry
      // rechecks the original inode/contents rather than falsely succeeding.
      if (completed) { await owned.handle.close(); if (this.ownership === owned) this.ownership = undefined; }
    }
  }

  private async writeMetadata(): Promise<void> {
    const path = resolve(this.directory, "clapping-hands-profile.json");
    let createdAt = new Date().toISOString();
    try {
      const previous = JSON.parse(await readFile(path, "utf8")) as { createdAt?: string };
      createdAt = previous.createdAt ?? createdAt;
    } catch {
      // First launch or invalid old metadata: write a clean, non-secret record.
    }
    const metadata = {
      formatVersion: "clapping-hands.dev/profile-v1",
      id: this.profileId,
      createdAt,
      updatedAt: new Date().toISOString(),
      allowedOrigins: this.allowedOrigins,
      browserIdentity: {
        channel: "Google Chrome stable",
        locale: "en-AU",
        timezone: "Australia/Sydney",
        viewport: { width: 1440, height: 1000 },
      },
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
