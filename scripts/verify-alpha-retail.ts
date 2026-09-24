/** Independent site-specific oracles; never imported by the compiler/runtime. */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const path = process.argv[2];
if (!path) throw new Error('Supply a retail benchmark report.');
const report = JSON.parse(await readFile(path, 'utf8'));
if (!['ikea','bunnings'].includes(report.site)) throw new Error('Unsupported retail oracle.');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
try {
  for (const call of report.calls) {
    const page = await browser.newPage();
    try {
      const url = report.site === 'ikea' ? 'https://www.ikea.com/au/en/search/?q=' : 'https://www.bunnings.com.au/search/products?q=';
      const response = await page.goto(url+encodeURIComponent(call.input.query), { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (response?.status() !== 200) throw new Error('Oracle access refused.');
      // These were independently inspected in public product-result links,
      // not obtained from any learned plan's selector or output value.
      const target = page.locator(report.site === 'ikea' ? 'a[href*="/p/"] .plp-price-module__product-name' : 'a[href*="_p"] p').first();
      await target.waitFor({ state: 'visible', timeout: 10000 });
      const expected = (await target.innerText()).trim();
      const actual = call.result.outcome.status === 'completed' ? call.result.outcome.data : null;
      results.push({ input: call.input, expected, actual, exact: expected === actual });
    } catch { results.push({ input: call.input, exact: null, reason: 'oracle-unavailable' }); }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
const supplement = { site: report.site, sourceReport: path, kind: 'independent-live-ui-oracle', results };
await writeFile(path.replace(/\.json$/, '.oracle.json'), JSON.stringify(supplement,null,2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(supplement));
