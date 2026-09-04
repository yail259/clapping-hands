import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ProfileLease {
  private held = false;
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.lockPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        this.held = true;
        await this.writeMetadata();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingPid = Number.parseInt(await readFile(this.lockPath, "utf8").catch(() => "0"), 10);
        if (processIsAlive(existingPid)) {
          throw new ProfileInUseError(`Browser profile is already in use by process ${existingPid}.`);
        }
        await unlink(this.lockPath).catch(() => {});
      }
    }
    throw new ProfileInUseError("Could not acquire the browser profile.");
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await unlink(this.lockPath).catch(() => {});
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
