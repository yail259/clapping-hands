#!/usr/bin/env node
/** Host-owner controls for the dedicated CH sourcing profile. These controls
 * are intentionally absent from the company actor's MCP tool list. */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskRuntime } from '../src/task-runtime.js';

const command = process.argv[2];
if (!['status', 'pause', 'login', 'resume'].includes(command ?? '') || process.argv.length !== 3)
  throw new Error('Use ch-sourcing status|pause|login|resume.');
const profile = process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR;
const dataDirectory = process.env.CLAPPING_HANDS_DATA_DIR;
if (!profile || !dataDirectory || !isAbsolute(profile) || !isAbsolute(dataDirectory))
  throw new Error('Configure the existing absolute CH profile and data paths.');
const profileState = await lstat(resolve(profile, 'Local State'));
if (!profileState.isFile()) throw new Error('The configured CH profile is not an existing Chromium profile.');
const unit = 'clapping-hands-sourcing.service';
const stateDirectory = resolve(homedir(), '.local/state/clapping-hands');
const statePath = resolve(stateDirectory, 'sourcing-control.json');
const run = promisify(execFile);
type ControlState = 'pausing' | 'owner-paused' | 'running-unverified' | 'pause-uncertain' | 'recovery-required';
const ownerState = async (state: ControlState) => {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDirectory);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077))
    throw new Error('The CH control-state directory must be owner-only.');
  const temp = resolve(stateDirectory, `.sourcing-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ formatVersion: 'clapping-hands/sourcing-control-v1', state,
    updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await rename(temp, statePath);
};
const savedState = async (): Promise<ControlState | null> => {
  try {
    const file = await lstat(statePath);
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077)) return null;
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as { formatVersion?: unknown; state?: unknown };
    if (parsed.formatVersion !== 'clapping-hands/sourcing-control-v1' ||
      !['pausing', 'owner-paused', 'running-unverified', 'pause-uncertain', 'recovery-required'].includes(String(parsed.state)))
      return null;
    return parsed.state as ControlState;
  } catch { return null; }
};
const service = async () => {
  try { return (await run('systemctl', ['--user', 'is-active', unit], { timeout: 10_000 })).stdout.trim(); }
  catch (error) {
    const state = String((error as Error & { stdout?: string }).stdout ?? '').trim();
    if (['inactive', 'failed', 'activating', 'deactivating'].includes(state)) return state;
    throw new Error('Could not determine the CH user-service state.');
  }
};
const exists = async (path: string) => {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
const chromeUsingProfile = async () => {
  const processes = await readdir('/proc', { withFileTypes: true });
  for (const process of processes) {
    if (!process.isDirectory() || !/^\d+$/.test(process.name)) continue;
    let args: string[];
    try { args = (await readFile(`/proc/${process.name}/cmdline`)).toString('utf8').split('\0'); }
    catch { continue; }
    if (!/^(?:chrome|chromium|chrome-headless-shell)$/.test(basename(args[0] ?? ''))) continue;
    if (args.includes(`--user-data-dir=${profile}`)) return true;
  }
  return false;
};
const profileClear = async () => !(await exists(resolve(profile, '.clapping-hands.lock'))) &&
  !(await exists(resolve(profile, 'SingletonLock'))) && !await chromeUsingProfile();
const status = async () => {
  const serviceState = await service();
  const clear = await profileClear();
  const receipt = await savedState();
  const state = serviceState === 'active' ? 'running-unverified'
    : !clear ? 'recovery-required'
    : receipt === 'owner-paused' ? 'owner-paused'
    : serviceState === 'inactive' ? 'stopped-unverified' : 'pause-uncertain';
  return { state, service: serviceState, profile: clear ? 'clear' : 'in-use-or-recovery',
    browserOwner: 'CH', auth: 'not-asserted' };
};
const print = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');

if (command === 'status') print(await status());
else if (command === 'pause') {
  if (await service() !== 'active') { print(await status()); process.exitCode = 1; }
  else {
    await ownerState('pausing');
    await run('systemctl', ['--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1', unit], { timeout: 10_000 });
    let inactive = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await service() === 'inactive') { inactive = true; break; }
      await delay(250);
    }
    if (!inactive) { await ownerState('pause-uncertain'); print(await status()); process.exitCode = 1; }
    else if (!await profileClear()) {
      await ownerState('recovery-required'); print(await status()); process.exitCode = 1;
    } else { await ownerState('owner-paused'); print(await status()); }
  }
} else if (command === 'login') {
  if (await service() !== 'inactive' || !await profileClear())
    throw new Error('Pause CH and verify the profile is clear before owner login.');
  const runtime = new TaskRuntime(dataDirectory);
  const cancel = () => { void runtime.close('owner-paused').catch(() => {}); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const handoff = await runtime.authenticate('https://www.facebook.com/marketplace/sydney/');
    print(handoff);
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    await runtime.close('owner-paused');
    if (await profileClear()) await ownerState('owner-paused');
    else await ownerState('recovery-required');
  }
} else if (command === 'resume') {
  if (await service() === 'active') {
    await ownerState('running-unverified'); print(await status());
  } else if (!await profileClear()) {
    await ownerState('recovery-required'); print(await status()); process.exitCode = 1;
  } else {
    if (await service() !== 'active')
      await run('systemctl', ['--user', 'start', unit], { timeout: 30_000 });
    if (await service() !== 'active') {
      await ownerState('pause-uncertain'); print(await status()); process.exitCode = 1;
    } else { await ownerState('running-unverified'); print(await status()); }
  }
}
