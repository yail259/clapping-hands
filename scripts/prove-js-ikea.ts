import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { proposeJavaScript } from '../src/javascript-compiler.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from '../src/generated-js.js';
import { saveEvidenceBundle, loadEvidenceBundle, sanitizeEvidence } from '../src/evidence-bundle.js';
import { TaskSession } from '../src/task-session.js';

const root=resolve('.data/js-compilation/ikea');
const captures=[];
for(const id of ['1788788005876-9e5a8774-9a5e-44a1-8887-a606f51ef35e','1788788007069-91c93bb6-4d6d-4371-8692-aa9a51847d0b']) {
  const evidence=await loadEvidenceBundle(root,id) as any;
  const exchange=evidence.exchanges.find((e:any)=>e.method==='POST'&&new URL(e.url).pathname==='/au/en/search');
  if(!exchange||exchange.requestBody.format!=='json'||exchange.responseBody.format!=='json')throw new Error('Missing saved JSON search evidence');
  const $=load(evidence.dom.data),expected=$('a[href*="/p/"] .plp-price-module__product-name').first().text().trim();
  if(!expected)throw new Error('Missing saved displayed result');
  captures.push({id,evidence,exchange,expected});
}
const template=captures[0]!.exchange.requestBody.data;
const endpoint=captures[0]!.exchange.url;
if(endpoint!=='https://sik.search.blue.cdtapps.com/au/en/search?c=sr&v=20250507')throw new Error('Unexpected observed resource');
const definition=JSON.parse(await readFile(resolve('bench/runs/2026-09-07/alpha-ten-1788750873697-ikea.json'),'utf8')).definition;
let proposalId=process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,source:string;
if(proposalId)source=(await loadEvidenceBundle(root,proposalId) as any).proposal.source;
else {
  const result=await proposeJavaScript({goal:definition.goal,inputSchema:definition.inputSchema,outputSchema:definition.outputSchema,
    resources:[{id:'search',method:'POST',url:endpoint,parameters:['payload'],parameterContract:'payload is JSON string. Preserve the observed body structure and constants; only searchParameters.input may vary with the caller query. Body max 4000 characters. Response body is already parsed JSON.'}],
    examples:captures.map(({id,evidence,exchange,expected})=>({input:evidence.input,request:{resource:'search',parameters:{payload:JSON.stringify(exchange.requestBody.data)}},
      response:{url:exchange.url,status:exchange.responseStatus,body:exchange.responseBody.data},expected,evidenceId:id}))},root);
  proposalId=result.responseId;console.log(JSON.stringify({phase:'compiled',site:'ikea',proposalId,supported:result.proposal.supported,durationMs:result.durationMs}));
  if(!result.proposal.supported)throw new Error('Compiler declined');source=result.proposal.source;
}
// Browser is used solely as an independent post-execution oracle, never by the
// generated function. Its timing is excluded and recorded separately.
const session=new TaskSession('https://www.ikea.com',resolve(root,'oracle-profile'));await session.start();
const results=[];
try {
  for(const query of ['bookcase','chair','lamp']) {
    const broker:GeneratedBroker=async(request,signal)=>{
      if(request.resource!=='search'||Object.keys(request.parameters).join(',')!=='payload'||typeof request.parameters.payload!=='string')throw new Error('Invalid request');
      const body=JSON.parse(request.parameters.payload),expectedBody=structuredClone(template);
      expectedBody.searchParameters.input=query;
      if(!isDeepStrictEqual(body,expectedBody))throw new Error('Request outside observed read-only shape');
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal,redirect:'error'});
      const text=await response.text();
      const safe=sanitizeEvidence({responseBody:text});const data=(safe.data as any).responseBody;
      await saveEvidenceBundle(root,{kind:'generated-request-response',proposalId,input:{query},url:endpoint,responseStatus:response.status,responseBody:text});
      if(response.status!==200||data.format!=='json')throw new Error('Search response unavailable');
      return {url:endpoint,status:response.status,body:data.data};
    };
    try {
      const result=await executeGeneratedJavaScript(source,{query},definition.outputSchema,broker);
      const oracleStart=performance.now(),page=session.context.pages()[0]??await session.context.newPage();
      await page.goto('https://www.ikea.com/au/en/search/?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded',timeout:30_000});
      const expected=(await page.locator('a[href*="/p/"] .plp-price-module__product-name').first().innerText({timeout:20_000})).trim();
      const record={kind:'held-out-browser-validation',site:'ikea',proposalId,input:{query},restarted:!!process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,
        result,expected,exact:result.value===expected,oracleMs:performance.now()-oracleStart,dom:await page.content()};
      await saveEvidenceBundle(root,record);results.push({query,exact:record.exact,durationMs:result.durationMs,requests:result.requests});
    }catch(error){const failure={query,exact:false,category:error instanceof Error?error.name:'unknown'};results.push(failure);await saveEvidenceBundle(root,{kind:'held-out-failure',site:'ikea',proposalId,...failure});}
    console.log(JSON.stringify({site:'ikea',phase:'held-out',...results.at(-1)}));
  }
}finally{await session.close();}
await saveEvidenceBundle(root,{kind:'compilation-summary',site:'ikea',proposalId,results});
