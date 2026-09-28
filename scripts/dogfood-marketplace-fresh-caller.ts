import { chromium } from 'playwright-core';
import { TaskRuntime } from '../src/task-runtime.js';
import type { TaskDefinition } from '../src/task-store.js';

const definition: TaskDefinition = {
  action: 'marketplace_fresh_search_cards_v1',
  startUrl: 'https://www.facebook.com/marketplace/sydney/',
  goal: 'Search Sydney Facebook Marketplace within 100 km, last 24 hours and newest first, for the given term and return the first visible listing cards with title, current and previous AUD prices, location, and link. Read only.',
  effect: 'read',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  outputSchema: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, priceAud: { type: 'number' }, previousPriceAud: { type: ['number', 'null'] },
    location: { type: 'string' }, url: { type: 'string' },
  }, required: ['title', 'priceAud', 'previousPriceAud', 'location', 'url'], additionalProperties: false }, maxItems: 24 },
};

function parseCard(label: string, href: string) {
  let stem = label.replace(/, listing \d+$/, '');
  if (stem === label) return null;
  const locationMatch = /, ([^,]+), (NSW|ACT|VIC|QLD)$/.exec(stem);
  if (!locationMatch) return null;
  const location = locationMatch[1] + ', ' + locationMatch[2];
  stem = stem.slice(0, locationMatch.index);
  const previousMatch = /, reduced from AU\$([\d,.]+)$/.exec(stem);
  const previousPriceAud = previousMatch ? Number(previousMatch[1]!.replace(/,/g, '')) : null;
  if (previousMatch) stem = stem.slice(0, previousMatch.index);
  const priceMatch = /, (AU\$[\d,.]+|Free)$/.exec(stem);
  if (!priceMatch) return null;
  const priceAud = priceMatch[1] === 'Free' ? 0 : Number(priceMatch[1]!.slice(3).replace(/,/g, ''));
  const title = stem.slice(0, priceMatch.index).replace(/\s+/g, ' ').trim();
  if (!title || !Number.isFinite(priceAud) || (previousPriceAud !== null && !Number.isFinite(previousPriceAud))) return null;
  return { title, priceAud, previousPriceAud, location, url: new URL(href, 'https://www.facebook.com').origin + new URL(href, 'https://www.facebook.com').pathname };
}

const runtime = new TaskRuntime();
const purpose = process.argv.includes('--validate') ? 'validate' : 'learn';
const queries = purpose === 'validate' ? ['lego technic', 'board games'] : ['lego', 'guitar pedal'];
try {
  const prior = await runtime.store.load(definition.action);
  if (purpose === 'learn' && prior) throw new Error('This manual dogfood action already exists; use a fresh CLAPPING_HANDS_DATA_DIR.');
  if (purpose === 'validate' && !prior?.pendingJavascriptAccelerator) throw new Error('No staged candidate awaits validation.');
  for (const query of queries) {
    const started = await runtime.startCallerRecording(definition.action, purpose, { query }, purpose === 'learn' ? definition : undefined);
    const browser = await chromium.connectOverCDP(started.cdpUrl);
    try {
      const context = browser.contexts()[0]!;
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto('https://www.facebook.com/marketplace/sydney/search?daysSinceListed=1&sortBy=creation_time_descend&query=' + encodeURIComponent(query) + '&exact=false&radius=100', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.locator('a[href*="/marketplace/item/"]').first().waitFor({ timeout: 20_000 });
      const raw = await page.locator('a[href*="/marketplace/item/"]').evaluateAll(anchors => anchors.slice(0, 24).map(anchor => ({
        label: anchor.getAttribute('aria-label') ?? '', href: anchor.getAttribute('href') ?? '',
      })));
      const cards = raw.map(card => parseCard(card.label, card.href)).filter(card => card !== null);
      if (cards.length !== raw.length) throw new Error('Marketplace card shape changed; declining partial result.');
      const result = await runtime.finishCallerRecording(started.recordingId, { status: 'completed', data: cards });
      process.stdout.write(JSON.stringify({ query, count: cards.length, sample: cards.slice(0, 3), result: {
        status: result.status, preparation: 'preparation' in result ? result.preparation : undefined,
        match: 'match' in result ? result.match : undefined,
        programStatus: 'programStatus' in result ? result.programStatus : undefined,
        evidence: 'evidence' in result ? result.evidence : undefined,
      } }) + '\n');
    } catch (error) {
      await runtime.cancelCallerRecording(started.recordingId).catch(() => {});
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await runtime.close();
}
