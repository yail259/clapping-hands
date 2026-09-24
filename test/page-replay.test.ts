import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.js';
import { capturePageEvidence, compilePageReplay, materializePageUrl, pageReplaySchema, recordPageShadow, replayPage, stablePageReplay } from '../src/page-replay.js';

const evidence = (url: string) => [{ url, selectors: [{ selector: 'h1', index: 0 }] }];
const plan = () => compilePageReplay('https://fixture.invalid', [{ q: 'desk' }, { q: 'chair' }],
  [evidence('https://fixture.invalid/search?q=desk'), evidence('https://fixture.invalid/search?q=chair')])!;

test('URL compilation binds query/path inputs without cached answers or URL injection', () => {
  const p = plan(); assert.ok(p);
  assert.equal(materializePageUrl(p, { q: 'a&b?#' }), 'https://fixture.invalid/search?q=a%26b%3F%23');
  const paths = compilePageReplay('https://fixture.invalid', [{ q: 'AAPL' }, { q: 'MSFT' }],
    [evidence('https://fixture.invalid/quote/AAPL/'), evidence('https://fixture.invalid/quote/MSFT/')])!;
  assert.equal(materializePageUrl(paths, { q: 'A/B' }), 'https://fixture.invalid/quote/A%2FB/');
  assert.throws(() => materializePageUrl(paths, { q: '..' }));
  assert.throws(() => materializePageUrl(paths, { q: 'x', other: 'y' }));
  assert.ok(compilePageReplay('https://fixture.invalid', [{ q: 'desk' }, { q: 'chair' }],
    [evidence('https://fixture.invalid/search?keywords=desk'), evidence('https://fixture.invalid/search?keywords=chair')]));
});

test('page replay refuses unbound, dynamic, credential and cross-origin URL evidence', () => {
  for (const urls of [ ['https://fixture.invalid/search','https://fixture.invalid/search'],
    ['https://fixture.invalid/search?q=desk&session=private','https://fixture.invalid/search?q=chair&session=private'],
    ['https://fixture.invalid/search?q=desk&n=1','https://fixture.invalid/search?q=chair&n=2'],
    ['https://fixture.invalid/search?q=desk','https://other.invalid/search?q=chair'] ]) {
    assert.equal(compilePageReplay('https://fixture.invalid', [{ q: 'desk' }, { q: 'chair' }], urls.map(evidence)), null);
  }
});

test('promotion requires two distinct unseen matches and cannot revive a degraded plan', () => {
  let p = plan();
  p = recordPageShadow(p, { q: 'desk' }, true); assert.equal(p.heldout.length, 0);
  p = recordPageShadow(p, { q: 'table' }, true);
  p = recordPageShadow(p, { q: 'table' }, true); assert.equal(stablePageReplay(p), false);
  p = recordPageShadow(p, { q: 'sofa' }, true); assert.equal(stablePageReplay(p), true);
  p = recordPageShadow(p, { q: 'lamp' }, false);
  p = recordPageShadow(p, { q: 'bed' }, true); assert.equal(stablePageReplay(p), false);
  assert.throws(() => pageReplaySchema.parse({ ...plan(), heldout: [plan().training[0]] }));
  assert.throws(() => pageReplaySchema.parse({ ...plan(), selector: 'span#session_secret' }));
});

test('page plans survive storage restart and cannot change the task origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'page-plan-store-'));
  const store = new TaskStore(directory);
  const definition = { action: 'page_read', startUrl: 'https://fixture.invalid/', goal: 'Read title', effect: 'read' as const,
    inputSchema: { type: 'object' as const, properties: { q: { type: 'string' as const } }, required: ['q'], additionalProperties: false as const }, outputSchema: { type: 'string' as const } };
  await store.save({ formatVersion: 'clapping-hands/task-v2', definition, accelerator: null, pageAccelerator: plan() });
  assert.deepEqual((await new TaskStore(directory).load('page_read'))?.pageAccelerator, plan());
  await assert.rejects(store.save({ formatVersion: 'clapping-hands/task-v2', definition, accelerator: null, pageAccelerator: { ...plan(), origin: 'https://other.invalid' } }));
});

test('real browser discovers text selector and replays a fresh URL; login/HTTP failure is refused', async () => {
  let denied = false, hang = false;
  const server = createServer((req, res) => {
    if (hang) return;
    res.writeHead(denied ? 403 : 200, { 'content-type': 'text/html' });
    res.end('<!doctype html><h1>'+new URL(req.url!, 'http://fixture').searchParams.get('q')+'</h1>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:'+address.port;
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const observations = [];
    for (const q of ['desk','chair']) {
      await page.goto(origin+'/?q='+q);
      const captured = await capturePageEvidence(page, q); assert.ok(captured); observations.push([captured]);
    }
    const p = compilePageReplay(origin, [{ q: 'desk' }, { q: 'chair' }], observations); assert.ok(p);
    assert.equal((await replayPage(context, p, { q: 'fresh' })).data, 'fresh');
    await page.setContent('<p class="product-title">Product name</p>');
    assert.ok((await capturePageEvidence(page, 'Product name'))?.selectors.some(x => x.selector === 'p.product-title'));
    denied = true;
    await assert.rejects(replayPage(context, p, { q: 'blocked' }));
    denied = false; hang = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try { await assert.rejects(replayPage(context, p, { q: 'interrupted' }, controller.signal)); }
    finally { clearTimeout(timer); }
    assert.equal(context.pages().length, 1, 'interrupted replay closes only its own page');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
