import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { TaskSession } from '../src/task-session.js';
import { compileGenericJsonCandidatesFromTraces, type GenericNetworkTrace, type CandidateCompilationAudit } from '../src/generic-network.js';

const file=process.argv[2],profile=process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR;
if(!file||!profile)throw new Error('Supply report and authenticated profile');
const report=JSON.parse(await readFile(file,'utf8'));if(report.site!=='marketplace')throw new Error('Wrong site');
const session=new TaskSession('https://www.facebook.com',profile);
const checks:any[]=[],references=new Map<string,unknown>(),traces:GenericNetworkTrace[]=[],audits:CandidateCompilationAudit[]=[];
try {
  await session.start();
  for(const call of report.calls) {
    if(call.result.outcome.status!=='completed'){checks.push({input:call.input,exact:false,reason:'incomplete'});continue;}
    try {
      let expected=references.get(call.input.query);
      if(!expected) {
        const page=session.context.pages()[0]??await session.context.newPage(),mark=session.network.mark();
        const response=await page.goto('https://www.facebook.com/marketplace/sydney/search/?query='+encodeURIComponent(call.input.query),{waitUntil:'domcontentloaded',timeout:30000});
        if(response?.status()!==200)throw new Error('Oracle access failed');
        await page.waitForFunction(`document.querySelectorAll('a[href*="/marketplace/item/"]').length>=5`,{},{timeout:20000});
        // Public card layout ends with title then location; badges precede prices.
        expected=await page.evaluate(String.raw`(()=>{const seen=new Set();return [...document.querySelectorAll('a[href*="/marketplace/item/"]')].filter(a=>a.checkVisibility()&&!/Sponsored/.test(a.parentElement.innerText)).map(a=>{const u=new URL(a.href);const lines=a.innerText.split('\n').map(x=>x.trim()).filter(Boolean);const prices=lines.filter(x=>/^(?:AU\$|\$|Free$)/.test(x));const title=lines.at(-2);return {title,price:prices[0],url:u.origin+u.pathname};}).filter(row=>{if(seen.has(row.url))return false;seen.add(row.url);return true;}).slice(0,5)})()`);
        if(!Array.isArray(expected)||expected.length!==5||expected.some(x=>!x.title||!x.price))throw new Error('Incomplete reference');
        references.set(call.input.query,expected);
        await session.network.flush();
        if(traces.length<2) traces.push({input:call.input,exchanges:await session.network.since(mark),outputText:JSON.stringify(expected)});
      }
      checks.push({input:call.input,phase:call.phase,exact:isDeepStrictEqual(expected,call.result.outcome.data),expected,actual:call.result.outcome.data});
    } catch {checks.push({input:call.input,exact:null,reason:'independent-oracle-unavailable'});}
  }
  if(traces.length===2)try{compileGenericJsonCandidatesFromTraces('marketplace_diagnostic',traces,{workflowOrigin:session.origin,onAudit:a=>audits.push(a)});}catch{/* Count-only diagnostic; no captured data persisted. */}
} finally {await session.close();}
await writeFile(file.replace(/\.json$/,`.oracle-${Date.now()}.json`),JSON.stringify({site:report.site,kind:'independent-current-price-card-oracle',referencePolicy:'One fresh search per distinct query; same-input repeats share the reference. Ranking may change between runs.',checks,manualObservationCompilerAudits:audits},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({site:report.site,total:checks.length,exact:checks.filter(c=>c.exact===true).length,unavailable:checks.filter(c=>c.exact===null).length,audits}));
