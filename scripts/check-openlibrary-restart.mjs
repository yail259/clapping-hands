/** One independent read-only page check; no agent or compiler guidance. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {load} from 'cheerio';
const root=resolve(process.argv[2]);
const report=JSON.parse(await readFile(resolve(root,'acceptance.json'),'utf8'));
const {TaskSession}=await import(pathToFileURL(resolve(report.entry,'../task-session.js')).href);
const session=new TaskSession('https://openlibrary.org',resolve(root,'independent-oracle-profile'));
const check={scope:'Independent fresh browser DOM check after network-only restart; not a Browser Use timing baseline.',passed:false,closed:false};
try{
 await session.start();
 const page=session.context.pages()[0]??await session.context.newPage();
 const start=performance.now();
 await page.goto('https://openlibrary.org/search?q=sherlock+holmes',{waitUntil:'domcontentloaded',timeout:60000});
 await page.locator('li.searchResultItem h3.booktitle a').first().waitFor({timeout:30000});
 const $=load(await page.content());
 const rows=$('li.searchResultItem').filter((i,el)=>!!$(el).find('h3.booktitle a[href]').length).slice(0,5).toArray().map(el=>{
  const r=$(el),a=r.find('h3.booktitle a').first();
  return {title:a.text().trim(),authors:r.find('.bookauthor a').toArray().map(a=>$(a).text().trim()),year:r.find('.resultDetails').text().match(/First published in\s+(\d{4})/)?.[1]??'',url:new URL(a.attr('href'),page.url()).href};
 });
 check.pageWallMs=performance.now()-start;
 check.rows=rows;
 check.passed=isDeepStrictEqual(rows,report.stages.find(s=>s.id==='restart').data.outcome.data);
}catch(e){check.failureCategory=e.name;}
finally{await session.close();check.closed=true;await writeFile(resolve(root,'restart-oracle.json'),JSON.stringify(check,null,2),{mode:0o600});}
console.log(JSON.stringify({passed:check.passed,closed:check.closed,pageWallMs:check.pageWallMs}));
if(!check.passed)process.exitCode=1;
