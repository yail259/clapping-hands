import { chromium } from 'playwright-core';
import { TaskRuntime } from '../src/task-runtime.js';
import { assertWorkflowAuth } from '../src/workflow-auth.js';
import type { TaskDefinition } from '../src/task-store.js';
import { extractMarketplaceListing, marketplaceFields } from './marketplace-document-fields.js';

// Two examples in one runtime retain first-run document provenance in memory.
// The resulting plan is a candidate only: description comes from the document.
const ids = process.argv.slice(2);
if (ids.length !== 2 || ids.some(id => !/^\d{8,20}$/.test(id)) || ids[0] === ids[1])
  throw new Error('Pass two distinct Marketplace item IDs.');
const action = 'marketplace_listing_details_v7';
const definition: TaskDefinition = {
  action, startUrl: 'https://www.facebook.com/marketplace/sydney/', effect: 'read',
  goal: 'Read the requested Marketplace listing title, displayed price, condition, and full description. Read only.',
  inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'], additionalProperties: false },
  outputSchema: { type: 'object', properties: {
    title: { type: 'string' }, price: { type: 'string' }, condition: { type: 'string' }, description: { type: 'string' },
  }, required: ['title', 'price', 'condition', 'description'], additionalProperties: false },
};
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
const runtime = new TaskRuntime();
try {
  const statuses = [];
  for (const item of ids) {
    const started = await runtime.startCallerRecording(action, 'learn', { item }, definition);
    const browser = await chromium.connectOverCDP(started.cdpUrl);
    try {
      const page = await browser.contexts()[0]!.newPage();
      const url = `https://www.facebook.com/marketplace/item/${item}/`;
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!response || response.status() !== 200 || page.url() !== url) throw new Error('Listing navigation refused.');
      await assertWorkflowAuth(page, 'https://www.facebook.com');
      const fields = marketplaceFields(extractMarketplaceListing(await response.text(), item));
      const heading = page.locator('h1:visible');
      await heading.first().waitFor({ state: 'visible', timeout: 20_000 });
      if (await heading.count() !== 1 || normalized(await heading.first().innerText()) !== normalized(fields.title))
        throw new Error('Visible title did not corroborate the document.');
      const pane = page.locator('div.xb57i2i').filter({ has: heading });
      if (await pane.count() !== 1) throw new Error('Listing panel ambiguous.');
      const visible = normalized(await pane.innerText());
      if (!visible.includes(normalized(fields.price)) || !visible.includes(normalized(fields.condition)))
        throw new Error('Visible price or condition did not corroborate the document.');
      const result = await runtime.finishCallerRecording(started.recordingId, { status: 'completed', data: fields });
      statuses.push({ item, status: result.status,
        inlineJsonCompilation: 'inlineJsonCompilation' in result ? result.inlineJsonCompilation : undefined });
    } catch (error) {
      await runtime.cancelCallerRecording(started.recordingId).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }
  const saved = await runtime.store.load(action);
  process.stdout.write(JSON.stringify({ statuses, candidate: saved?.inlineJsonAccelerator ?? null }) + '\n');
} finally { await runtime.close(); }
