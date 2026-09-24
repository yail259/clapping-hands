import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { proposeJavaScript } from '../src/javascript-compiler.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from '../src/generated-js.js';
import { saveEvidenceBundle, loadEvidenceBundle, sanitizeEvidence } from '../src/evidence-bundle.js';
import { TaskSession } from '../src/task-session.js';
import { browserNetworkFetch, captureBrowserNetworkDocument, disposeBrowserNetworkDocument } from '../src/browser-network-transport.js';

const root=resolve('.data/js-compilation/marketplace');
const profile=process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR;
if(!profile)throw new Error('Select the existing authenticated profile explicitly');
const report=JSON.parse(await readFile(resolve('bench/runs/2026-09-07/alpha-rich-1788759242905-marketplace.json'),'utf8'));
const definition=report.definition;
const endpoint='https://www.facebook.com/marketplace/sydney/search/';
function savedDomOracle(html:string) {
  const $=load(html),output=[];
  for(const el of $('a[href*="/marketplace/item/"]').toArray()) {
    const a=$(el);if(/Sponsored/.test(a.parent().text()))continue;
    const spans=a.find('span').filter((_i,e)=>!$(e).find('span').length).toArray().map(e=>$(e).text().trim()).filter(Boolean);
    const title=spans.at(-2),price=spans.find(s=>/^(?:AU)?\$/.test(s)||s==='Free');
    if(!title||!price)throw new Error('Saved oracle missing fields');
    const url=new URL(a.attr('href')!,endpoint);
    output.push({title,price,url:url.origin+url.pathname});if(output.length===5)break;
  }
  if(output.length!==5)throw new Error('Saved DOM lacks five listings');return output;
}
let proposalId=process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,source:string;
if(proposalId)source=(await loadEvidenceBundle(root,proposalId) as any).proposal.source;
else {
  const examples=[];
  for(const id of ['1788788447123-69e09b98-d305-4e9f-b4da-605cbb0a5dff','1788788457298-aba64f33-ffb6-43fe-98de-bc1ebeb2a482']) {
    const saved=await loadEvidenceBundle(root,id) as any;
    const exchange=saved.exchanges.find((e:any)=>e.resourceType==='document'&&new URL(e.url).pathname==='/marketplace/sydney/search/');
    if(exchange?.responseBody?.format!=='html')throw new Error('Missing saved document');
    const $=load(exchange.responseBody.data);$('style,svg').remove();
    examples.push({input:saved.input,request:{resource:'search',parameters:{query:saved.input.query}},response:{url:exchange.url,status:exchange.responseStatus,body:$.html()},
      expected:savedDomOracle(saved.dom.data),evidenceId:id,promptView:'Styles and SVG omitted from prompt only; full sanitized HTML remains saved.'});
  }
  const generated=await proposeJavaScript({goal:definition.goal,inputSchema:definition.inputSchema,outputSchema:definition.outputSchema,
    resources:[{id:'search',method:'GET',url:endpoint,parameters:['query'],parameterLocation:'query',authentication:'host-owned existing session; never include credentials'}],examples},root);
  proposalId=generated.responseId;console.log(JSON.stringify({site:'marketplace',phase:'compiled',proposalId,supported:generated.proposal.supported,durationMs:generated.durationMs}));
  if(!generated.proposal.supported)throw new Error('Compiler declined');source=generated.proposal.source;
}
const session=new TaskSession('https://www.facebook.com',profile);await session.start();
const transport=process.env.CLAPPING_HANDS_JS_TRANSPORT??'request-context';
if(!['request-context','browser-native','browser-document'].includes(transport))throw new Error('Invalid transport');
const results=[];
try {
  if(transport==='browser-native') {
    const page=session.context.pages()[0]??await session.context.newPage();
    await page.goto(endpoint+'?query=sofa%20bed',{waitUntil:'domcontentloaded',timeout:30_000});
    await page.locator('a[href*="/marketplace/item/"]').first().waitFor({timeout:15_000});
  }
  for(const query of ['fold out sofa bed','single sofa bed','futon sofa bed']) {
    const broker:GeneratedBroker=async(request,signal)=>{
      if(signal.aborted||request.resource!=='search'||!isDeepStrictEqual(request.parameters,{query}))throw new Error('Invalid read request');
      const url=new URL(endpoint);url.searchParams.set('query',query);
      // APIRequestContext reads the existing browser cookie jar. No cookie or
      // credential is exported to generated code or evidence.
      let raw:string,status:number;
      try {
        if(transport==='browser-document') {
          const page=session.context.pages()[0]??await session.context.newPage();
          const response=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:20_000});
          await page.waitForLoadState('networkidle',{timeout:8_000}).catch(()=>{});
          raw=await page.content();status=response?.status()??0;
        }else if(transport==='browser-native') {
          const page=session.context.pages()[0]!,lease=await captureBrowserNetworkDocument(session.context,page);
          try {const response=await browserNetworkFetch(session.context,page,lease,{url:url.href,method:'GET',headers:{},nativeReceipt:true,timeoutMs:20_000});raw=response.body;status=response.status;}
          finally {await disposeBrowserNetworkDocument(lease);}
        }else {
          const response=await session.context.request.get(url.href,{maxRedirects:0,timeout:20_000});raw=await response.text();status=response.status();
        }
      }catch(error){await saveEvidenceBundle(root,{kind:'broker-failure',proposalId,input:{query},transport,category:error instanceof Error?error.name:'unknown',code:(error as any)?.code??null});throw new Error('Broker transport failed');}
      const safe=sanitizeEvidence({responseBody:raw});const body=(safe.data as any).responseBody;
      await saveEvidenceBundle(root,{kind:'generated-request-response',proposalId,input:{query},transport,url:url.href,responseStatus:status,responseBody:raw});
      if(status!==200||body.format!=='html')throw new Error('Search response unavailable');
      return {url:url.href,status,body:body.data};
    };
    try {
      const result=await executeGeneratedJavaScript(source,{query},definition.outputSchema,broker);
      const page=session.context.pages()[0]??await session.context.newPage(),oracleStart=performance.now();
      await page.goto(endpoint+'?query='+encodeURIComponent(query),{waitUntil:'domcontentloaded',timeout:30_000});
      await page.locator('a[href*="/marketplace/item/"]').first().waitFor({timeout:15_000});
      const expected=await page.evaluate(String.raw`(()=>{const out=[];for(const a of document.querySelectorAll('a[href*="/marketplace/item/"]')){if(/Sponsored/.test(a.parentElement?.innerText??''))continue;const lines=a.innerText.split('\n').map(s=>s.trim()).filter(Boolean),title=lines.at(-2),price=lines.find(s=>/^(?:AU)?\$/.test(s)||s==='Free');if(!title||!price)throw Error('Missing listing fields');const u=new URL(a.href);out.push({title,price,url:u.origin+u.pathname});if(out.length===5)break;}return out;})()`);
      const record={kind:'held-out-browser-validation',site:'marketplace',proposalId,input:{query},transport,restarted:!!process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,result,expected,
        exact:isDeepStrictEqual(result.value,expected),oracleMs:performance.now()-oracleStart,dom:await page.content(),
        executionTier:transport==='browser-document'?'browser-navigation-plus-generated-parser':'network',
        requestCountMeaning:transport==='browser-document'?'one resource call; page may issue multiple network requests':'network request'};
      await saveEvidenceBundle(root,record);results.push({query,exact:record.exact,durationMs:result.durationMs,requests:result.requests});
    }catch(error){const failure={query,exact:false,category:error instanceof Error?error.name:'unknown',code:(error as any)?.code??null};results.push(failure);await saveEvidenceBundle(root,{kind:'held-out-failure',site:'marketplace',proposalId,...failure});}
    console.log(JSON.stringify({site:'marketplace',phase:'held-out',...results.at(-1)}));
  }
}finally{await session.close();}
await saveEvidenceBundle(root,{kind:'compilation-summary',site:'marketplace',proposalId,transport,results});
