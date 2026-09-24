import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ProfileInUseError, ProfileLease, ProfileRecoveryRequiredError } from "../src/profile.js";

const lockName = ".clapping-hands.lock";
function record(pid: number) { return JSON.stringify({ formatVersion: "clapping-hands.dev/profile-lock-v1", pid, nonce: randomUUID(), createdAt: new Date().toISOString() }) + "\n"; }
async function temporary() { return mkdtemp(resolve(tmpdir(), "clapping-hands-profile-lock-")); }
async function exitedPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  await new Promise<void>((done, reject) => { child.once("exit", (code) => code === 0 ? done() : reject(new Error("Fixture child failed."))); child.once("error", reject); });
  return child.pid;
}

test("modern profile lease has private permissions, active exclusion and ordinary clean restart", async () => {
  const directory = await temporary(); const first = new ProfileLease(directory, "fixture", ["https://fixture.invalid"]);
  const second = new ProfileLease(directory, "fixture", ["https://fixture.invalid"]);
  try {
    await first.acquire();
    const raw = await readFile(resolve(directory, lockName), "utf8"); const metadata = JSON.parse(raw);
    assert.equal(metadata.formatVersion, "clapping-hands.dev/profile-lock-v1"); assert.equal(metadata.pid, process.pid);
    assert.match(metadata.nonce, /^[0-9a-f-]{36}$/);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(resolve(directory, lockName))).mode & 0o777, 0o600);
    await assert.rejects(second.acquire(), ProfileInUseError);
    assert.equal(await readFile(resolve(directory, lockName), "utf8"), raw);
    await first.release(); await first.release(); await second.acquire(); await second.release();
    await assert.rejects(lstat(resolve(directory, lockName)), { code: "ENOENT" });
  } finally { await first.release(); await second.release(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy active PID is recognized but malformed, partial, oversized and dead locks are preserved", async () => {
  const directory = await temporary(); const lockPath = resolve(directory, lockName); const dead = await exitedPid();
  try {
    await writeFile(lockPath, process.pid + "\n");
    await assert.rejects(new ProfileLease(directory).acquire(), ProfileInUseError);
    assert.equal(await readFile(lockPath, "utf8"), process.pid + "\n");
    for (const raw of ["", "0\n", "-1\n", process.pid + "garbage", "{", "fixture-private-lock-data", "1".repeat(8_193), dead + "\n", record(dead), record(Number.MAX_SAFE_INTEGER)]) {
      await writeFile(lockPath, raw);
      await assert.rejects(new ProfileLease(directory).acquire(), (error: unknown) => {
        assert.ok(error instanceof ProfileRecoveryRequiredError);
        assert.equal(error.code, "PROFILE_RECOVERY_REQUIRED"); assert.doesNotMatch(error.message, /fixture-private/); return true;
      });
      assert.equal(await readFile(lockPath, "utf8"), raw);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown process liveness fails closed; permission denial still means active", async (t) => {
  const directory = await temporary(); const lockPath = resolve(directory, lockName); const raw = record(process.pid);
  try {
    await writeFile(lockPath, raw);
    const kill = t.mock.method(process, "kill", () => { throw Object.assign(new Error("fixture-private-liveness"), { code: "EIO" }); });
    await assert.rejects(new ProfileLease(directory).acquire(), ProfileRecoveryRequiredError);
    assert.equal(await readFile(lockPath, "utf8"), raw);
    kill.mock.mockImplementation(() => { throw Object.assign(new Error("fixture-private-permission"), { code: "EPERM" }); });
    await assert.rejects(new ProfileLease(directory).acquire(), ProfileInUseError);
    assert.equal(await readFile(lockPath, "utf8"), raw);
  } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
});

test("release preserves replacement inode and same-inode changed ownership", async () => {
  const directory = await temporary(); const lockPath = resolve(directory, lockName);
  let lease = new ProfileLease(directory);
  try {
    await lease.acquire(); const original = await readFile(lockPath, "utf8");
    await rename(lockPath, resolve(directory, "original-lock"));
    const replacement = record(process.pid); await writeFile(lockPath, replacement);
    await lease.release(); assert.equal(await readFile(lockPath, "utf8"), replacement);
    assert.equal(await readFile(resolve(directory, "original-lock"), "utf8"), original);
    await rename(lockPath, resolve(directory, "replacement-lock"));
    lease = new ProfileLease(directory); await lease.acquire();
    const changed = record(process.pid); await writeFile(lockPath, changed);
    await lease.release(); assert.equal(await readFile(lockPath, "utf8"), changed);
  } finally { await lease.release(); await rm(directory, { recursive: true, force: true }); }
});

test("symlink locks remain untouched and metadata failure releases only a fully owned lock", async () => {
  const directory = await temporary(); const lockPath = resolve(directory, lockName); const target = resolve(directory, "fixture-original");
  const lease = new ProfileLease(directory);
  try {
    await writeFile(target, "fixture-private-original"); await symlink(target, lockPath);
    await assert.rejects(lease.acquire(), ProfileRecoveryRequiredError);
    assert.equal((await lstat(lockPath)).isSymbolicLink(), true); assert.equal(await readFile(target, "utf8"), "fixture-private-original");
    await rename(lockPath, resolve(directory, "preserved-link"));
    await mkdir(resolve(directory, "clapping-hands-profile.json"));
    await assert.rejects(lease.acquire(), { code: "EISDIR" });
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  } finally { await lease.release(); await rm(directory, { recursive: true, force: true }); }
});
