import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { parseBrowserTaskOutcome, validateBrowserTask, type BrowserTask, type BrowserTaskOutcome } from './browser-task.js';

export type BrowserUseTaskOptions = {
  python: string;
  workerPath?: string;
  cdpUrl: string;
  allowedOrigins: string[];
  model: string;
  apiKey: string;
  baseURL: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Passive evidence only; callback failures cannot change the task result. */
  onEvidence?: (event: unknown) => void;
};

/** The worker attaches to a host-owned browser; killing it cannot discard auth.
 * This is process supervision, not a second navigation/planning controller. */
export async function runBrowserUseTask(task: BrowserTask, options: BrowserUseTaskOptions): Promise<BrowserTaskOutcome> {
  validateBrowserTask(task);
  if (options.signal?.aborted) return { status: 'failed' };
  const cdp = new URL(options.cdpUrl);
  const endpoint = new URL(options.baseURL);
  if (!['http:', 'ws:'].includes(cdp.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(cdp.hostname) || cdp.username || cdp.password) {
    throw new Error('Browser task requires a local owned browser endpoint.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !options.apiKey) {
    throw new Error('Invalid browser task model configuration.');
  }
  const origins = options.allowedOrigins.map(origin => {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid browser task origin.');
    return url;
  });
  if (!origins.some(url => url.origin === new URL(task.startUrl).origin)) throw new Error('Task origin is not authorized.');
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid browser task deadline.');
  return new Promise(resolve => {
    const sourceWorker = new URL('../python/browser_use_worker.py', import.meta.url);
    const defaultWorker = existsSync(sourceWorker) ? sourceWorker : new URL('../../python/browser_use_worker.py', import.meta.url);
    const child = spawn(options.python, [options.workerPath ?? fileURLToPath(defaultWorker)], {
      stdio: ['pipe', 'ignore', 'ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        GPT_API_KEY: options.apiKey, GPT_BASE_URL: options.baseURL,
        ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_CLOUD_SYNC: 'false' },
    });
    let raw = '', timedOut = false, oversized = false;
    let evidenceRaw = '', evidenceBytes = 0, evidenceStopped = false;
    const deliver = (event: unknown) => { try { options.onEvidence?.(event); } catch { /* Passive observer only. */ } };
    (child.stdio[4] as Readable).setEncoding('utf8').on('data', (chunk: string) => {
      if(evidenceStopped)return;
      evidenceBytes += Buffer.byteLength(chunk);
      if(evidenceBytes > 2_000_000) { evidenceStopped=true;evidenceRaw='';deliver({kind:'evidence-omitted',reason:'worker-evidence-size-limit'});return; }
      evidenceRaw += chunk;
      let index: number;
      while((index=evidenceRaw.indexOf('\n'))>=0) {
        const line=evidenceRaw.slice(0,index);evidenceRaw=evidenceRaw.slice(index+1);
        try {deliver(JSON.parse(line));} catch {deliver({kind:'evidence-omitted',reason:'invalid-worker-event'});}
      }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const abort = () => { child.kill('SIGKILL'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const finish = (outcome: BrowserTaskOutcome) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve(outcome); };
    (child.stdio[3] as Readable).setEncoding('utf8').on('data', (chunk: string) => {
      if (oversized) return;
      if (Buffer.byteLength(raw) + Buffer.byteLength(chunk) > 1_000_000) {
        oversized = true; raw = ''; child.kill('SIGKILL');
      } else raw += chunk;
    });
    child.on('error', () => finish({ status: 'failed' }));
    child.on('close', code => {
      if(evidenceRaw)deliver({kind:'evidence-omitted',reason:'interrupted-worker-event'});
      if (timedOut) return finish({ status: 'timeout' });
      if (code !== 0 || oversized) return finish({ status: 'failed' });
      try { finish(parseBrowserTaskOutcome(JSON.parse(raw), task.outputSchema)); }
      catch { finish({ status: 'failed' }); }
    });
    child.stdin!.on('error', () => { /* Spawn/close events classify the result. */ });
    child.stdin!.end(JSON.stringify({ task, cdpUrl: options.cdpUrl, model: options.model,
      allowedDomains: origins.map(url => url.hostname) })+'\n');
  });
}
