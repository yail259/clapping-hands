import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { proposeJavaScript } from '../src/javascript-compiler.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from '../src/generated-js.js';
import { saveEvidenceBundle, loadEvidenceBundle, sanitizeEvidence } from '../src/evidence-bundle.js';
import { TaskSession } from '../src/task-session.js';

const root=resolve('.data/js-compilation/transport'),endpoint='https://transportnsw.info/api/graphql';
const observations=[];
for(const id of ['1788788437161-e5cfe21b-b07f-444f-b6c0-f837eb2932b2','1788788445575-3c371209-c0a2-4903-bf6d-6a3b1fa60d88']) {
  const saved=await loadEvidenceBundle(root,id) as any;
  const exchanges=saved.exchanges.filter((e:any)=>e.requestBody?.format==='json'&&['StopSearch','TripOptions'].includes(e.requestBody.data.operationName));
  observations.push({input:saved.input,exchanges,renderedText:load(saved.dom.data)('body').text(),evidenceId:id});
}
const stopTemplate=observations[0]!.exchanges.find((e:any)=>e.requestBody.data.operationName==='StopSearch').requestBody.data;
const tripTemplate=observations[0]!.exchanges.find((e:any)=>e.requestBody.data.operationName==='TripOptions').requestBody.data;
const definition=JSON.parse(await readFile(resolve('bench/runs/2026-09-07/alpha-ten-1788749688021-transport.json'),'utf8')).definition;
let proposalId=process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,source:string;
if(proposalId)source=(await loadEvidenceBundle(root,proposalId) as any).proposal.source;
else {
  const generated=await proposeJavaScript({goal:definition.goal,inputSchema:definition.inputSchema,outputSchema:definition.outputSchema,
    resources:[{id:'stop_search',method:'POST',url:endpoint,parameters:['name'],description:'Executes the observed StopSearch GraphQL operation with variables.name supplied and type=any; returns parsed JSON in body. A name or station ID can be searched.'},
      {id:'trips',method:'POST',url:endpoint,parameters:['from','to'],description:'Executes the observed TripOptions operation with input.from and input.to station IDs. Keeps all other observed settings, including departing now. Returns parsed JSON in body.'}],
    observations,observationScope:'These are supporting route observations, not demonstrations of the target Central-to-query task. Infer station resolution and duration display from them; do not hardcode observed station IDs or durations.'},root);
  proposalId=generated.responseId;console.log(JSON.stringify({site:'transport',phase:'compiled',proposalId,supported:generated.proposal.supported,durationMs:generated.durationMs}));
  if(!generated.proposal.supported)throw new Error('Compiler declined');source=generated.proposal.source;
}
const session=new TaskSession('https://transportnsw.info',resolve(root,'oracle-profile'));await session.start();
const results=[];
try {
  for(const query of ['Wynyard Station','Circular Quay Station','North Sydney Station']) {
    const resolutions=new Map<string,any[]>();let route:{from:string;to:string}|undefined;
    const broker:GeneratedBroker=async(request,signal)=>{
      let body:any;
      if(request.resource==='stop_search') {
        if(Object.keys(request.parameters).join(',')!=='name'||![query,'Central Station'].includes(String(request.parameters.name)))throw new Error('Unexpected station search');
        body=structuredClone(stopTemplate);body.variables.name=request.parameters.name;
      }else if(request.resource==='trips') {
        if(Object.keys(request.parameters).sort().join(',')!=='from,to')throw new Error('Unexpected trip parameters');
        const from=String(request.parameters.from),to=String(request.parameters.to);
        const origin=(resolutions.get('Central Station')??[]).find(s=>s.id===from),destination=(resolutions.get(query)??[]).find(s=>s.id===to);
        if(!origin?.name?.startsWith('Central Station')||!destination?.name?.startsWith(query))throw new Error('Selected stations do not satisfy task');
        body=structuredClone(tripTemplate);body.variables.input.from=from;body.variables.input.to=to;route={from,to};
      }else throw new Error('Unknown read resource');
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal,redirect:'error'});
      const raw=await response.text();const safe=sanitizeEvidence({responseBody:raw}),parsed=(safe.data as any).responseBody;
      await saveEvidenceBundle(root,{kind:'generated-request-response',proposalId,input:{query},resource:request.resource,parameters:request.parameters,url:endpoint,responseStatus:response.status,responseBody:raw});
      if(response.status!==200||parsed.format!=='json')throw new Error('GraphQL response unavailable');
      if(request.resource==='stop_search')resolutions.set(String(request.parameters.name),parsed.data?.data?.widgets?.stopSearch??[]);
      return {url:endpoint,status:response.status,body:parsed.data};
    };
    try {
      const result=await executeGeneratedJavaScript(source,{query},definition.outputSchema,broker);
      if(!route)throw new Error('No validated route');
      const page=session.context.pages()[0]??await session.context.newPage(),oracleStart=performance.now();
      const url=new URL('https://transportnsw.info/trip-planner/plan');url.searchParams.set('from',route.from);url.searchParams.set('to',route.to);url.searchParams.set('excludedModes','11');
      await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30_000});
      const target=page.locator('[aria-label^="Departing at"][aria-label*="Duration is"] .rounded-full').first();
      const expected=(await target.innerText({timeout:20_000})).trim();
      const record={kind:'held-out-browser-validation',site:'transport',proposalId,input:{query},restarted:!!process.env.CLAPPING_HANDS_JS_PROPOSAL_ID,result,expected,route,
        exact:result.value===expected,oracleMs:performance.now()-oracleStart,dom:await page.content(),limitation:'Departing-now requests may change between network and browser checks.'};
      await saveEvidenceBundle(root,record);results.push({query,exact:record.exact,durationMs:result.durationMs,requests:result.requests});
    }catch(error){const failure={query,exact:false,category:error instanceof Error?error.name:'unknown',code:(error as any)?.code??null};results.push(failure);await saveEvidenceBundle(root,{kind:'held-out-failure',site:'transport',proposalId,...failure});}
    console.log(JSON.stringify({site:'transport',phase:'held-out',...results.at(-1)}));
  }
}finally{await session.close();}
await saveEvidenceBundle(root,{kind:'compilation-summary',site:'transport',proposalId,results});
