import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request, type BrowserContext } from 'playwright-core';
import { encodedPathInput, pathSignature } from '../src/request-path.js';
import { compileGenericJsonPlan, assertGenericJsonPlanSafety } from '../src/generic-network.js';
import { compileJavaScriptTask, replayJavaScriptTask } from '../src/javascript-task.js';
import { recordCompiledComparison } from '../src/compiled-program.js';
import type { TaskDefinition } from '../src/task-store.js';
const evidenceId='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';

const trace=(origin:string,q:string)=>({input:{q},exchanges:[{url:origin+'/quote/'+encodeURIComponent(q)+'/detail',method:'GET',resourceType:'fetch',
  requestHeaders:{accept:'application/json'},requestBody:'',responseStatus:200,responseHeaders:{'content-type':'application/json'},responseBody:JSON.stringify({title:q})}]});

test('path input discovery preserves route structure and refuses ambiguous or escaping inputs',()=>{
  assert.equal(pathSignature('/quote/AAPL/detail',{q:'AAPL'}),pathSignature('/quote/MSFT/detail',{q:'MSFT'}));
  for(const value of ['','.', '..','a/b','a\\b','%2f','a?b','a#b','a\nb','a b',Infinity,{},null])assert.throws(()=>encodedPathInput(value));
  assert.equal(encodedPathInput('^GSPC'),'%5EGSPC');assert.equal(encodedPathInput('東京'),'%E6%9D%B1%E4%BA%AC');
  assert.throws(()=>pathSignature('/quote/same',{a:'same',b:'same'}));
  const demos=['AAPL','MSFT'].map(q=>{const t=trace('https://fixture.invalid',q);return {input:t.input,exchange:t.exchanges[0]!};});
  assert.throws(()=>compileGenericJsonPlan('quote',demos)); // Legacy callers are unchanged.
  const plan=compileGenericJsonPlan('quote',demos,{allowPathInputs:true});
  assert.deepEqual(plan.request.pathBindings,{q:[2]});assert.deepEqual(plan.request.bindings,{q:[]});
  for(const pathBindings of [{q:[0]},{q:[1]},{q:[99]},{q:[2,2]},{unknown:[2]},{}] as Record<string,number[]>[])assert.throws(()=>assertGenericJsonPlanSafety({...plan,request:{...plan.request,pathBindings}}));
  assert.throws(()=>assertGenericJsonPlanSafety({...plan,request:{...plan.request,method:'POST'}}));
  const changed=structuredClone(demos);changed[1]!.exchange.url='https://fixture.invalid/trade/MSFT/detail';
  assert.throws(()=>compileGenericJsonPlan('quote',changed,{allowPathInputs:true}));
});

test('ordinary JS compilation discovers path resources and fetches exact fresh unseen data after serialization',async()=>{
  let requests=0;
  const server=createServer((req,res)=>{requests++;const parts=new URL(req.url!,'http://fixture.invalid').pathname.split('/');
    assert.equal(parts[1],'quote');assert.equal(parts[3],'detail');assert.equal(parts.length,4);
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({title:decodeURIComponent(parts[2]!)}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port,api=await request.newContext();
  const definition:TaskDefinition={action:'quote',startUrl:origin,goal:'Return quote title',effect:'read',
    inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},
    outputSchema:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}};
  let proposals=0;
  try{
    const compiled=await compileJavaScriptTask(definition,['AAPL','MSFT'].map(q=>trace(origin,q)),['AAPL','MSFT'].map(title=>({title})),[evidenceId,evidenceId],'unused',async()=>{
      proposals++;return {proposal:{supported:true,source:"function*(input){const r=yield {op:'request',resource:'response_0',parameters:input};return JSON.parse(r.body);}",explanation:'Fixture parser'},durationMs:0,requestId:evidenceId,responseId:evidenceId};
    });
    assert.ok(compiled);assert.equal(proposals,1);assert.equal(requests,0);
    const context={request:api} as BrowserContext;
    for(const q of ['GOOG','NVDA']){
      const result=await replayJavaScriptTask(context,definition,compiled,{q});assert.deepEqual(result.value,{title:q});
      compiled.program=recordCompiledComparison(compiled.program,{q},result.value,{title:q},definition.outputSchema,evidenceId);
    }
    assert.equal(compiled.program.status,'stable');
    const restarted=JSON.parse(JSON.stringify(compiled));
    const fresh=await replayJavaScriptTask(context,definition,restarted,{q:'^GSPC'});assert.deepEqual(fresh.value,{title:'^GSPC'});assert.equal(requests,3);
    for(const q of ['..','%2F','a/b','a?b'])await assert.rejects(replayJavaScriptTask(context,definition,restarted,{q}));
    assert.equal(requests,3);assert.equal(proposals,1);
  }finally{await api.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
