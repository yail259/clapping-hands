import { chromium } from 'playwright-core';
import { TaskRuntime } from '../src/task-runtime.js';
import { assertWorkflowAuth } from '../src/workflow-auth.js';

// Held-out caller observation: all fields come from visible DOM, never from
// the inline document JSON used by the candidate. A collapsed description is
// incomplete and cannot promote the plan.
const ids = process.argv.slice(2);
if (!ids.length || ids.length > 3 || ids.some(id => !/^\d{8,20}$/.test(id)) || new Set(ids).size !== ids.length)
  throw new Error('Pass one to three distinct held-out Marketplace item IDs.');
const runtime = new TaskRuntime();
try {
  const rows = [];
  for (const item of ids) {
    let started: Awaited<ReturnType<TaskRuntime['startCallerRecording']>>;
    try { started = await runtime.startCallerRecording('marketplace_listing_details_v7', 'validate-inline-json', { item }); }
    catch (error) { rows.push({ item, error: error instanceof Error ? error.message : String(error) }); break; }
    const browser = await chromium.connectOverCDP(started.cdpUrl);
    try {
      const page = await browser.contexts()[0]!.newPage();
      const url = `https://www.facebook.com/marketplace/item/${item}/`;
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!response || response.status() !== 200 || page.url() !== url) throw new Error('Listing navigation refused.');
      await assertWorkflowAuth(page, 'https://www.facebook.com');
      const heading = page.locator('h1:visible');
      await heading.first().waitFor({ state: 'visible', timeout: 20_000 });
      const pane = page.locator('div.xb57i2i').filter({ has: heading });
      if (await pane.count() !== 1) throw new Error('Listing panel ambiguous.');
      const description = pane.locator('div.xz9dl7a').first();
      await description.waitFor({ state: 'visible', timeout: 15_000 });
      let text = (await description.innerText()).trim();
      if (/\bSee more\b/.test(text)) {
        const control = pane.getByText('See more', { exact: true });
        if (await control.count() === 1) await control.click({ timeout: 5_000 });
        await page.waitForFunction(() => {
          const pane = [...document.querySelectorAll('div.xb57i2i')].find(node => node.querySelector('h1'));
          const text = (pane?.querySelector('div.xz9dl7a') as HTMLElement | null)?.innerText ?? '';
          return !!text && !/\bSee more\b/.test(text);
        }, undefined, { timeout: 5_000 }).catch(() => {});
        text = (await description.innerText()).trim();
      }
      if (!text || /\bSee more\b/.test(text)) throw new Error('Full description not visible in caller page.');
      const fields = await page.evaluate(() => {
        const pane = [...document.querySelectorAll('div.xb57i2i')].find(node =>
          !!node.querySelector('h1') && [...node.querySelectorAll('li')].some(li => (li as HTMLElement).innerText.startsWith('Condition\n')));
        if (!pane) return null;
        const title = pane.querySelector('h1')?.textContent?.trim() ?? '';
        const header = pane.querySelector('h1')?.parentElement;
        const price = [...(header?.querySelectorAll('span') ?? [])].map(el => [...el.childNodes]
          .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim())
          .find(value => /^AU\$[\d,]+$/.test(value)) ?? '';
        const condition = [...pane.querySelectorAll('li')].map(li => (li as HTMLElement).innerText.trim())
          .find(value => value.startsWith('Condition\n'))?.replace(/^Condition\n/, '').trim() ?? '';
        const description = (pane.querySelector('div.xz9dl7a') as HTMLElement | null)?.innerText.trim() ?? '';
        return { title, price, condition, description };
      });
      if (!fields || Object.values(fields).some(value => !value) || /\bSee more\b/.test(fields.description))
        throw new Error('Visible listing fields incomplete.');
      const collapseControl = pane.getByText('See less', { exact: true });
      if (await collapseControl.count() === 1) {
        if (!/\bSee less\s*$/.test(fields.description)) throw new Error('Expanded description control was ambiguous.');
        fields.description = fields.description.replace(/\s*See less\s*$/, '').trim();
      }
      const result = await runtime.finishCallerRecording(started.recordingId, { status: 'completed', data: fields });
      rows.push({ item, status: result.status, match: 'match' in result ? result.match : undefined,
        reason: 'reason' in result ? result.reason : undefined,
        programStatus: 'programStatus' in result ? result.programStatus : undefined });
    } catch (error) {
      await runtime.cancelCallerRecording(started.recordingId).catch(() => {});
      rows.push({ item, error: error instanceof Error ? error.message : String(error) });
    } finally { await browser.close(); }
  }
  process.stdout.write(JSON.stringify({ rows }) + '\n');
} finally { await runtime.close(); }
