import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskSession } from '../src/task-session.js';
import { TaskStore, type TaskDefinition } from '../src/task-store.js';
import { prepareJavaScriptCompilation, compilePreparedJavaScriptTask, replayJavaScriptTask } from '../src/javascript-task.js';
import { recordCompiledComparison } from '../src/compiled-program.js';
import { saveEvidenceBundle, loadEvidenceBundle } from '../src/evidence-bundle.js';
import { compileObservedJsonResources } from '../src/generic-network.js';

const id='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';
test('observed arguments never turn auth fields or GraphQL operation text into generated parameters',()=>{
  for(const key of ['token','session','operationName','url']){
    const traces=['a','b'].map(value=>({input:{q:value},exchanges:[{url:'https://fixture.invalid/search?'+key+'='+value,method:'GET',resourceType:'fetch',requestHeaders:{},requestBody:'',responseStatus:200,responseBody:'{"ok":true}'}]}));
    assert.deepEqual(compileObservedJsonResources('read_search',traces,{workflowOrigin:'https://fixture.invalid'}),[]);
  }
});

test('generated search-to-details workflow uses fresh response IDs, survives stored-evidence recompilation and browser restart',async()=>{
  let requests=0,serial=0;const issued=new Map<string,string>(),responses:unknown[]=[];
  const output=(q:string)=>({title:q,price:q.length});
  const server=createServer((req,res)=>{
    const url=new URL(req.url!,'http://fixture.invalid');res.setHeader('cache-control','no-store');
    if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<h1>Catalog</h1><output></output>');return;}
    requests++;res.setHeader('content-type','application/json');
    const send=(data:unknown)=>{responses.push({url:req.url,status:res.statusCode,data});res.end(JSON.stringify(data));};
    if(url.pathname==='/search'){const q=url.searchParams.get('q')!,key=q+'_'+(++serial);issued.set(key,q);send({selectedId:key});return;}
    const key=url.searchParams.get('id')!,q=issued.get(key);issued.delete(key);
    if(!q){res.writeHead(400);send({error:'unknown-or-used-id'});return;}send(output(q));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  const live=process.env.CLAPPING_HANDS_LIVE_DEPENDENT_SMOKE==='1';
  const directory=live?resolve('.data/release-smokes/dependent-'+Date.now()):await mkdtemp(join(tmpdir(),'dependent-request-'));
  const definition:TaskDefinition={action:'read_detail',startUrl:origin,goal:'Search for q, then return the selected product title and current price from its details',effect:'read',
    inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},
    outputSchema:{type:'object',properties:{title:{type:'string'},price:{type:'number'}},required:['title','price'],additionalProperties:false}};
  let session=new TaskSession(origin,join(directory,'profile'));const store=new TaskStore(join(directory,'tasks'));
  try{
    await session.start();const page=session.context.pages()[0]!;await page.goto(origin);const traces=[];
    for(const q of ['alpha','beta']){
      const mark=session.network.mark();
      await page.evaluate(async(q)=>{const search=await(await fetch('/search?q='+q)).json();const detail=await(await fetch('/details?id='+encodeURIComponent(search.selectedId))).json();document.querySelector('output')!.textContent=JSON.stringify(detail);},q);
      assert.deepEqual(JSON.parse(await page.locator('output').innerText()),output(q));traces.push({input:{q},exchanges:await session.network.since(mark)});
    }
    const observed=await saveEvidenceBundle(join(directory,'evidence'),{kind:'controlled-dependent-observation',definition,traces,outputs:['alpha','beta'].map(output),responses});
    const prepared=prepareJavaScriptCompilation(definition,traces,['alpha','beta'].map(output),[observed.id,observed.id]);assert.ok(prepared);assert.equal(prepared.resources.length,2);
    const evidence=await saveEvidenceBundle(join(directory,'evidence'),prepared),restored=await loadEvidenceBundle(join(directory,'evidence'),evidence.id);
    const source="function*(input){const a=yield {op:'request',resource:'response_0',parameters:input};const id=JSON.parse(a.body).selectedId;const b=yield {op:'request',resource:'response_1',parameters:{argument_0:id}};return JSON.parse(b.body);}";
    const proposal=async()=>({proposal:{supported:true,source,explanation:'Fixture proposal'},durationMs:0,requestId:id,responseId:id});
    const task=await compilePreparedJavaScriptTask(definition,restored,join(directory,'evidence'),live?undefined:proposal);assert.ok(task);
    await assert.rejects(compilePreparedJavaScriptTask(definition,restored,join(directory,'evidence'),async()=>({...await proposal(),proposal:{supported:true,source:source.replace('argument_0:id',"argument_0:'alpha_1'"),explanation:'Incorrect constant identifier'}})));
    for(const q of ['gamma','delta']){
      const result=await replayJavaScriptTask(session.context,definition,task,{q});assert.deepEqual(result.value,output(q));assert.equal(result.requests,2);
      const comparison=await saveEvidenceBundle(join(directory,'evidence'),{kind:'controlled-dependent-comparison',input:{q},actual:result.value,expected:output(q),requests:responses.slice(-2)});
      task.program=recordCompiledComparison(task.program,{q},result.value,output(q),definition.outputSchema,comparison.id);
    }
    assert.equal(task.program.status,'stable');await store.save({formatVersion:'clapping-hands/task-v2',definition,accelerator:null,javascriptAccelerator:task,compilationEvidenceId:evidence.id});
    await session.close();session=new TaskSession(origin,join(directory,'profile'));await session.start();
    const saved=await new TaskStore(join(directory,'tasks')).load(definition.action);assert.ok(saved?.javascriptAccelerator);
    const result=await replayJavaScriptTask(session.context,definition,saved.javascriptAccelerator,{q:'epsilon'});assert.deepEqual(result.value,output('epsilon'));assert.equal(requests,10);
    if(live){const proof=await saveEvidenceBundle(join(directory,'evidence'),{kind:'dependent-request-smoke',passed:true,sourceHash:task.program.sourceHash,preparedEvidenceId:evidence.id,
      unseenMatches:3,restartMatch:true,requestsPerCall:2,modelCallsPerReplay:0,browserUseRuns:0,result,responses});console.log(JSON.stringify({passed:true,directory,evidenceId:proof.id}));}
  }finally{await session.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
