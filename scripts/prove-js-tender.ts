import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { TaskSession } from '../src/task-session.js';
import { proposeJavaScript } from '../src/javascript-compiler.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from '../src/generated-js.js';
import { saveEvidenceBundle, sanitizeEvidence, loadEvidenceBundle } from '../src/evidence-bundle.js';
import { observedFormFields } from '../src/observed-form.js';

// Supplemental rich-HTML case from the earlier validation cohort. Anonymous
// form/session bootstrap remains in the trusted host, not model-authored code.
const root=resolve('.data/js-compilation/tender'),endpoint='https://www.find-tender.service.gov.uk/Search/Results';
const definition=JSON.parse(await readFile(resolve('bench/runs/2026-09-07/alpha-rich-1788758126922-tender.json'),'utf8')).definition;
const session=new TaskSession(new URL(endpoint).origin,resolve(root,'experiment-profile'));await session.start();
let proposalId=process.env.CLAPPING_HANDS_JS_PROPOSAL_ID;
const results=[];
try {
  async function search(query:string) {
    const initial=await session.context.request.get(endpoint,{maxRedirects:0,timeout:20_000}),html=await initial.text();
    await saveEvidenceBundle(root,{kind:'form-bootstrap',url:endpoint,responseStatus:initial.status(),responseBody:html});
    if(initial.status()!==200)throw new Error('Form unavailable');
    // FormData includes the clicked submitter. Omitting it can produce HTTP 200
    // with the previous search, so status/schema checks alone are insufficient.
    const fields=observedFormFields(html,endpoint,'#keywords',{keywords:query});
    const response=await session.context.request.post(endpoint,{form:fields,maxRedirects:0,timeout:20_000}),raw=await response.text();
    const safe=sanitizeEvidence({responseBody:raw}),body=(safe.data as any).responseBody;
    const evidence=await saveEvidenceBundle(root,{kind:'direct-response-capture',input:{query},url:endpoint,responseStatus:response.status(),responseBody:raw,
      transport:'anonymous session-aware form POST; two network requests including bootstrap'});
    if(response.status()!==200||body.format!=='html')throw new Error('Search unavailable');
    return {snapshot:{url:endpoint,status:response.status(),body:body.data as string},evidenceId:evidence.id};
  }
  const oracle=(html:string)=>{
    const $=load(html),norm=(text:string)=>text.replace(/\s+/g,' ').trim();
    return $('.search-result').slice(0,5).toArray().map(el=>{
      const row=$(el),link=row.find('h2 a').first(),date=row.find('.search-result-entry').filter((_i,e)=>/^(Closing date|Submission deadline)$/.test($(e).find('dt').text().trim())).first().find('dd');
      return {title:norm(link.text()),buyer:norm(row.find('.search-result-sub-header').text()),closingDate:norm(date.text()),url:new URL(link.attr('href')!,endpoint).href};
    });
  };
  let source:string;
  if(proposalId)source=(await loadEvidenceBundle(root,proposalId) as any).proposal.source;
  else {
    const requestId=process.env.CLAPPING_HANDS_JS_REQUEST_ID;let evidence:unknown;
    if(requestId)evidence=JSON.parse((await loadEvidenceBundle(root,requestId) as any).prompt);
    else {
      const examples=[];
      for(const query of ['software','cleaning']){const observed=await search(query),expected=oracle(observed.snapshot.body);if(expected.length!==5)throw new Error('Insufficient training results');examples.push({input:{query},request:{resource:'search',parameters:{keywords:query}},response:observed.snapshot,expected,evidenceId:observed.evidenceId});}
      evidence={goal:definition.goal,inputSchema:definition.inputSchema,outputSchema:definition.outputSchema,resources:[{id:'search',method:'POST',url:endpoint,parameters:['keywords'],description:'Trusted host bootstraps anonymous form CSRF/session and submits the existing read-only search form. Two network requests per resource invocation. Returns final HTML body.'}],examples};
    }
    const generated=await proposeJavaScript(evidence,root);proposalId=generated.responseId;
    console.log(JSON.stringify({site:'tender',phase:'compiled',proposalId,supported:generated.proposal.supported,durationMs:generated.durationMs}));
    if(!generated.proposal.supported)throw new Error('Compiler declined');source=generated.proposal.source;
  }
  for(const query of ['catering','construction','transport']) {
    const broker:GeneratedBroker=async(request,signal)=>{if(signal.aborted||request.resource!=='search'||!isDeepStrictEqual(request.parameters,{keywords:query}))throw new Error('Unexpected request');return (await search(query)).snapshot;};
    try {
      const result=await executeGeneratedJavaScript(source,{query},definition.outputSchema,broker,{timeoutMs:60_000});
      const page=session.context.pages()[0]??await session.context.newPage();
      await page.goto(endpoint,{waitUntil:'domcontentloaded',timeout:30_000});await page.locator('#keywords').fill(query);
      await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:30_000}),page.getByRole('button',{name:'Update results',exact:true}).click()]);
      const expected=await page.evaluate(String.raw`[...document.querySelectorAll('.search-result')].slice(0,5).map(row=>({title:row.querySelector('h2 a').innerText.trim(),buyer:row.querySelector('.search-result-sub-header').innerText.trim(),closingDate:[...row.querySelectorAll('.search-result-entry')].find(n=>/^(Closing date|Submission deadline)$/.test(n.querySelector('dt')?.innerText.trim()??''))?.querySelector('dd')?.innerText.trim()??'',url:row.querySelector('h2 a').href}))`);
      const record={kind:'held-out-browser-validation',site:'tender',proposalId,input:{query},restarted:!!process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,result,expected,exact:isDeepStrictEqual(result.value,expected),networkRequests:2,dom:await page.content()};
      await saveEvidenceBundle(root,record);results.push({query,exact:record.exact,durationMs:result.durationMs,networkRequests:2});
    }catch(error){const failure={query,exact:false,category:error instanceof Error?error.name:'unknown',code:(error as any)?.code??null};results.push(failure);await saveEvidenceBundle(root,{kind:'held-out-failure',site:'tender',proposalId,...failure});}
    console.log(JSON.stringify({site:'tender',phase:'held-out',...results.at(-1)}));
  }
}catch(error){await saveEvidenceBundle(root,{kind:'experiment-failure',site:'tender',proposalId:proposalId??null,category:error instanceof Error?error.message:'unknown'});console.log(JSON.stringify({site:'tender',phase:'failed',category:error instanceof Error?error.name:'unknown'}));}
finally{await session.close();}
await saveEvidenceBundle(root,{kind:'compilation-summary',site:'tender',proposalId:proposalId??null,results});
