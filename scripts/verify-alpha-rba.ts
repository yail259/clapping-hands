/** Independent site-specific oracle only; never imported by the runtime/compiler. */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const reportPath = process.argv[2];
if (!reportPath) throw new Error('Supply the RBA benchmark report path.');
const report = JSON.parse(await readFile(reportPath,'utf8'));
if (report.site !== 'rba') throw new Error('Expected RBA report.');
const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true });
const results = [];
try {
  for (const call of report.calls) {
    const page = await browser.newPage();
    try {
      await page.goto('https://www.rba.gov.au/calculator/',{ waitUntil:'domcontentloaded',timeout:30000 });
      for (const [name,key] of [['annualDollar','amount'],['annualStartYear','start_year'],['annualEndYear','end_year']] as const) {
        await page.locator('input[name="'+name+'"]').fill(String(call.input[key]));
      }
      await Promise.all([page.waitForURL('https://www.rba.gov.au/calculator/annualDecimal.html',{ waitUntil:'domcontentloaded',timeout:30000 }),page.locator('#idACalc').click()]);
      const raw = await page.locator('input[name="calculatedAnnualDollarValue"]').inputValue();
      const expected = Number(raw.replace(/[$,\s]/g,''));
      const actual = call.result.outcome.data?.adjusted_amount;
      results.push({ input:call.input,expected,actual,exact:Number.isFinite(expected)&&actual===expected });
    } catch { results.push({ input:call.input,exact:null,reason:'oracle-unavailable' }); }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
const supplement = { site:'rba',sourceReport:reportPath,kind:'independent-live-ui-oracle',mathematicalCorrectnessClaim:false,results };
await writeFile(reportPath.replace(/\.json$/,'.oracle.json'),JSON.stringify(supplement,null,2),{ flag:'wx',mode:0o600 });
console.log(JSON.stringify(supplement));
