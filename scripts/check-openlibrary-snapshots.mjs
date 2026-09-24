/** Independent, offline result oracle. Never supplied to the compiler. */
import { load } from 'cheerio';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const root=resolve(process.argv[2]);
const checks=[];
for(const id of await readdir(resolve(root,'evidence'))){
 const e=JSON.parse(await readFile(resolve(root,'evidence',id,'evidence.json'),'utf8'));
 if(e.provenance!=='browser-use-baseline'||e.outcome?.status!=='completed')continue;
 const snapshot=e.snapshots?.find(s=>s.dom?.format==='html');
 if(!snapshot){checks.push({id,input:e.input,exact:false,reason:'missing-html-snapshot'});continue;}
 const $=load(snapshot.dom.data);
 const rows=$('li.searchResultItem').filter((i,el)=>!!$(el).find('h3.booktitle a[href]').length).slice(0,5).toArray().map(el=>{
  const r=$(el),a=r.find('h3.booktitle a').first();
  return {title:a.text().trim(),authors:r.find('.bookauthor a').toArray().map(a=>$(a).text().trim()),year:r.find('.resultDetails').text().match(/First published in\s+(\d{4})/)?.[1]??'',url:new URL(a.attr('href'),snapshot.url).href};
 });
 checks.push({id,input:e.input,exact:isDeepStrictEqual(rows,e.outcome.data),rowCount:rows.length});
}
const report={scope:'Independent deterministic parser of saved same-run browser snapshots; not an independent fresh visit.',checks};
await writeFile(resolve(root,'snapshot-oracle.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report));
