import type { BrowserContext } from 'playwright-core';
import { assertWorkflowAuth } from './workflow-auth.js';
import { materializeInlineJsonUrl, replayInlineJsonDocument, replayInlineJsonProjection, type InlineJsonPlan } from './inline-json-projection.js';

/** Experimental read of one exact main-document response. Only a complete
 * learned inline JSON projection can finish early. Otherwise, finish that
 * same checked response when possible, then use the stable document fallback.
 * No response bytes escape. */
export async function replayStreamedInlineJsonDocument(context: BrowserContext, plan: InlineJsonPlan,
  input: Record<string, unknown>, signal?: AbortSignal) {
  if (Object.keys(input).length !== 1 || typeof input[plan.inputName] !== 'string')
    throw new Error('Inline JSON input shape refused.');
  const item = input[plan.inputName] as string;
  const url = materializeInlineJsonUrl(plan, item);
  const started = performance.now();
  const page = await context.newPage();
  let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
  let fallbackReason: 'cdp-unavailable' | 'navigation-refused' | 'projection-not-early' = 'cdp-unavailable';
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable', { maxTotalBufferSize: 5_000_000, maxResourceBufferSize: 5_000_000 });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    let requestId: string | undefined;
    let prefix: Buffer | undefined;
    let status: number | undefined;
    let finished = false;
    let unavailable = false;
    const chunks: Buffer[] = [];
    let data: Record<string,string> | undefined;
    let wake: (() => void) | undefined;
    let parseScheduled = false;
    const early = new Promise<void>(resolve => { wake = resolve; });
    const inspect = () => {
      if (data || unavailable || !prefix || status !== 200 || parseScheduled) return;
      parseScheduled = true;
      queueMicrotask(() => {
        parseScheduled = false;
        if (data || unavailable || !prefix) return;
        const html = Buffer.concat([prefix, ...chunks]).toString('utf8');
        if (!html.includes(item) || !html.includes('</script>')) return;
        try { data = replayInlineJsonProjection(html, item, plan); wake?.(); }
        catch { /* The target script may not be complete yet. */ }
      });
    };
    cdp.on('Network.requestWillBeSent', event => {
      if (requestId || event.type !== 'Document' || event.request.url !== url || event.request.method !== 'GET') return;
      requestId = event.requestId;
      void cdp!.send('Network.streamResourceContent', { requestId }).then(result => {
        prefix = Buffer.from(result.bufferedData, 'base64'); inspect();
      }).catch(() => { unavailable = true; wake?.(); });
    });
    cdp.on('Network.responseReceived', event => {
      if (event.requestId !== requestId) return;
      status = event.response.status;
      if (status !== 200 || event.response.fromDiskCache || event.response.fromServiceWorker ||
        event.response.fromPrefetchCache) { unavailable = true; wake?.(); }
      else inspect();
    });
    cdp.on('Network.dataReceived', event => {
      if (event.requestId !== requestId) return;
      // CDP can report a chunk before streamResourceContent activates. Its
      // bufferedData contains that prefix; missing event.data alone is not a
      // stream failure.
      if (typeof event.data !== 'string') return;
      chunks.push(Buffer.from(event.data, 'base64'));
      if (chunks.reduce((sum, chunk) => sum + chunk.length, prefix?.length ?? 0) > 5_000_000) {
        unavailable = true; wake?.(); return;
      }
      inspect();
    });
    cdp.on('Network.loadingFinished', event => {
      if (event.requestId === requestId) { finished = true; inspect(); wake?.(); }
    });
    cdp.on('Network.loadingFailed', event => {
      if (event.requestId === requestId) { unavailable = true; wake?.(); }
    });
    const navigation = page.goto(url, { waitUntil: 'commit', timeout: 10_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([early, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]); }
    finally { clearTimeout(timer); }
    const response = await navigation;
    if (!response || response.status() !== 200 || page.url() !== url || response.request().redirectedFrom()) {
      fallbackReason = 'navigation-refused';
      throw new Error('Streaming document navigation refused.');
    }
    await assertWorkflowAuth(page, plan.url.origin);
    if (!data || unavailable || status !== 200 || finished) {
      fallbackReason = unavailable ? 'cdp-unavailable' : 'projection-not-early';
      if (!unavailable && status === 200) {
        // The exact, authenticated 200 document is already open. Finish this
        // response instead of fetching the same listing in a second page.
        try {
          const html = await response.text();
          return { data: replayInlineJsonProjection(html, item, plan),
            engine: 'document-replay' as const, durationMs: performance.now() - started,
            streamFallbackReason: fallbackReason };
        } catch { /* The stable full-document reader remains the final fallback. */ }
      }
      throw new Error('Early stream unavailable.');
    }
    return { data, engine: 'streamed-document' as const, durationMs: performance.now() - started };
  } catch {
    // One stable fallback only. A timeout never mutates the learned projection.
  } finally {
    await cdp?.detach().catch(() => {});
    await page.close().catch(() => {});
  }
  const full = await replayInlineJsonDocument(context, plan, input, signal);
  return { data: full.data, engine: 'document-replay' as const, durationMs: performance.now() - started,
    streamFallbackReason: fallbackReason };
}
