import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright-core';

const file=process.argv[2];if(!file)throw new Error('Supply rich benchmark report');
const report=JSON.parse(await readFile(file,'utf8'));
if(!['openlibrary','tender'].includes(report.site))throw new Error('Unsupported oracle');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const checks=[];
const references=new Map<string,unknown>();
try {
  for(const call of report.calls) {
    if(call.result.outcome.status!=='completed') {checks.push({input:call.input,exact:false,reason:'incomplete'});continue;}
    const context=await browser.newContext(); const page=await context.newPage();
    try {
      let expected=references.get(call.input.query);
      if(expected===undefined && report.site==='openlibrary') {
        const response=await page.goto('https://openlibrary.org/search?q='+encodeURIComponent(call.input.query),{waitUntil:'domcontentloaded',timeout:30000});
        if(response?.status()!==200)throw new Error('Oracle access failed');
        await page.locator('h3.booktitle').first().waitFor();
        expected=await page.evaluate(String.raw`[...document.querySelectorAll('li.searchResultItem')].slice(0,5).map(row=>({title:row.querySelector('h3.booktitle a').innerText.trim(),authors:[...row.querySelectorAll('.bookauthor a')].map(a=>a.innerText.trim()),year:row.querySelector('.resultDetails')?.innerText.match(/First published in (\d+)/)?.[1]??'',url:row.querySelector('h3.booktitle a').href}))`);
      } else if(expected===undefined) {
        const response=await page.goto('https://www.find-tender.service.gov.uk/Search/Results',{waitUntil:'domcontentloaded',timeout:30000});
        if(response?.status()!==200)throw new Error('Oracle access failed');
        await page.locator('#keywords').fill(call.input.query);
        await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:30000}),page.getByRole('button',{name:'Update results',exact:true}).click()]);
        await page.locator('.search-result h2 a').first().waitFor();
        expected=await page.evaluate(String.raw`[...document.querySelectorAll('.search-result')].slice(0,5).map(row=>({title:row.querySelector('h2 a').innerText.trim(),buyer:row.querySelector('.search-result-sub-header').innerText.trim(),closingDate:[...row.querySelectorAll('.search-result-entry')].find(n=>/^(Closing date|Submission deadline)$/.test(n.querySelector('dt')?.innerText.trim()??''))?.querySelector('dd')?.innerText.trim()??'',url:row.querySelector('h2 a').href}))`);
      }
      references.set(call.input.query,expected);
      checks.push({input:call.input,phase:call.phase,exact:isDeepStrictEqual(expected,call.result.outcome.data),expected,actual:call.result.outcome.data});
    } catch {checks.push({input:call.input,exact:null,reason:'independent-oracle-unavailable'});}
    finally{await context.close();}
  }
} finally{await browser.close();}
await writeFile(file.replace(/\.json$/,`.oracle-${Date.now()}.json`),JSON.stringify({site:report.site,kind:'independent-public-browser-oracle',referencePolicy:'One fresh reference per distinct query; repeated calls compare against that reference',checks},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({site:report.site,total:checks.length,exact:checks.filter(c=>c.exact===true).length,unavailable:checks.filter(c=>c.exact===null).length}));
