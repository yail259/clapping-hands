import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileJavaScriptTask, prepareJavaScriptCompilation, compilePreparedJavaScriptTask, compilationContext, validateJavaScriptCandidate } from '../src/javascript-task.js';
import { saveEvidenceBundle } from '../src/evidence-bundle.js';
import { createCompiledProgram, recordCompiledComparison } from '../src/compiled-program.js';
import { TaskRuntime } from '../src/task-runtime.js';
import type { TaskDefinition } from '../src/task-store.js';
import type { GenericNetworkTrace } from '../src/generic-network.js';

const origin='https://fixture.invalid';
const id='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';
const definition:TaskDefinition={action:'read_search',startUrl:origin+'/',goal:'Return the current price, not the previous price',effect:'read',
  inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},
  outputSchema:{type:'object',properties:{title:{type:'string'},price:{type:'number'}},required:['title','price'],additionalProperties:false}};
const source=`function*(input){const r=yield {op:'request',resource:'response_0',parameters:input};if(r.status!==200)throw Error();const item=JSON.parse(r.body).items[0];return {title:item.title,price:item.currentCents/100};}`;
const payload=(q:string)=>({items:[{title:q,currentCents:q.length*100,previousCents:99999}]});
const output=(q:string)=>({title:q,price:q.length});
const traces:GenericNetworkTrace[]=['one','four'].map(q=>({input:{q},exchanges:[{url:origin+'/api/search?q='+q,method:'GET',resourceType:'fetch',
  requestHeaders:{accept:'application/json'},requestBody:'',responseStatus:200,responseHeaders:{'content-type':'application/json'},responseBody:JSON.stringify(payload(q))}]}));
const proposal=async()=>({proposal:{supported:true,source,explanation:'Fixture model boundary'},durationMs:0,requestId:id,responseId:id});

test('caller and delegated compiler share exact candidate checks without caller model invocation',async()=>{
  const prepared=prepareJavaScriptCompilation(definition,traces,['one','four'].map(output),[id,id]);assert.ok(prepared);
  const context=compilationContext(definition,prepared);
  assert.equal(context.resources.length,1);
  assert.deepEqual(context.resources[0]!.parameters,['q']);
  assert.equal('plan' in context.resources[0]!,false);
  const caller=await validateJavaScriptCandidate(definition,prepared,source,id);
  const delegated=await compilePreparedJavaScriptTask(definition,prepared,'unused-fixture',proposal);
  assert.deepEqual(caller,delegated);
  assert.equal(caller.program.status,'candidate');
  assert.deepEqual(caller.program.matchedInputHashes,[]);
  for(const bad of [source.replace('item.currentCents','item.previousCents'),source.replace('response_0','response_9')]){
    await assert.rejects(validateJavaScriptCandidate(definition,prepared,bad,id));
  }
  await assert.rejects(validateJavaScriptCandidate({...definition,goal:'Changed contract'},prepared,source,id));
  await assert.rejects(validateJavaScriptCandidate(definition,prepared,source,id,AbortSignal.abort()));
});

test('JS compiler replaces projection DSL and refuses incorrect current-price semantics',async()=>{
  const task=await compileJavaScriptTask(definition,traces,['one','four'].map(output),[id,id],'unused-fixture',proposal);
  assert.ok(task);assert.equal(task.program.status,'candidate');
  assert.equal(task.resources.length,1);
  await assert.rejects(compileJavaScriptTask(definition,traces,['one','four'].map(output),[id,id],'unused-fixture',
    async()=>({...await proposal(),proposal:{supported:true,source:source.replace('item.currentCents','item.previousCents'),explanation:'Wrong semantic source'}})));
});

test('runtime persists JS promotion, uses fresh data after restart, and degrades on failure before one fallback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'javascript-runtime-'));
  const task=await compileJavaScriptTask(definition,traces,['one','four'].map(output),[id,id],'unused-fixture',proposal);assert.ok(task);
  let runtime=new TaskRuntime(directory),baselineCalls=0,requests=0,status=200;
  const attach=()=>{
    // Fixture substitutes browser/model boundaries, not runtime routing, store,
    // request materialization, generated-code execution or promotion decisions.
    (runtime as any).session=async(_definition:unknown,fn:(s:any)=>Promise<unknown>)=>fn({network:{withoutReplayEvidence:(f:()=>unknown)=>f()},
      context:{request:{fetch:async(url:string)=>{requests++;const q=new URL(url).searchParams.get('q')!;
        return {status:()=>status,ok:()=>status===200,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify(payload(q)))};}}}});
    (runtime as any).baseline=async(_session:unknown,_definition:unknown,input:{q:string})=>{
      baselineCalls++;return {outcome:{status:'completed',data:output(input.q)},exchanges:[],durationMs:0,evidence:{status:'saved',id}};
    };
  };
  try{
    await runtime.store.save({formatVersion:'clapping-hands/task-v2',definition,accelerator:null,javascriptAccelerator:task});attach();
    for(const q of ['heldout','another']){
      const result=await runtime.run(definition.action,{q});assert.equal(result.engine,'browser-use');assert.equal(result.shadowMatch,true);
    }
    assert.equal((await runtime.store.load(definition.action))?.javascriptAccelerator?.program.status,'stable');
    assert.equal(baselineCalls,2);assert.equal(requests,2);
    await runtime.close();runtime=new TaskRuntime(directory);attach();
    const warm=await runtime.run(definition.action,{q:'restart'});
    assert.deepEqual(warm.outcome,{status:'completed',data:output('restart')});assert.equal(warm.engine,'network');assert.equal(warm.modelCalls,0);
    assert.equal(baselineCalls,2);assert.equal(requests,3);
    // A bad replacement cannot erase the already working generation.
    const stable=await runtime.store.load(definition.action);assert.ok(stable);
    const replacement={resources:task.resources,program:createCompiledProgram(source.replace('item.currentCents','item.previousCents'),definition,
      task.resources,traces.map(t=>t.input),[id])};
    await runtime.store.save({...stable,pendingJavascriptAccelerator:replacement});
    const compared=await runtime.run(definition.action,{q:'replacement'});
    assert.equal(compared.engine,'browser-use');assert.equal(compared.shadowMatch,false);
    assert.deepEqual(compared.outcome,{status:'completed',data:output('replacement')});
    assert.deepEqual((await runtime.store.load(definition.action))?.javascriptAccelerator,stable.javascriptAccelerator);
    assert.equal((await runtime.store.load(definition.action))?.pendingJavascriptAccelerator,undefined);
    const goodReplacement={resources:task.resources,program:createCompiledProgram(source+' /* validated replacement */',definition,
      task.resources,traces.map(t=>t.input),[id])};
    await runtime.store.save({...stable,pendingJavascriptAccelerator:goodReplacement});
    await runtime.run(definition.action,{q:'new_check_one'});
    assert.equal((await runtime.store.load(definition.action))?.javascriptAccelerator?.program.sourceHash,stable.javascriptAccelerator?.program.sourceHash);
    await runtime.run(definition.action,{q:'new_check_two'});
    assert.equal((await runtime.store.load(definition.action))?.javascriptAccelerator?.program.sourceHash,goodReplacement.program.sourceHash);
    assert.equal((await runtime.store.load(definition.action))?.pendingJavascriptAccelerator,undefined);
    status=403;
    const fallback=await runtime.run(definition.action,{q:'access'});
    assert.equal(fallback.fallback,true);assert.equal(fallback.engine,'browser-use');assert.equal(baselineCalls,6);
    assert.equal((await runtime.store.load(definition.action))?.javascriptAccelerator?.program.status,'degraded');
    await runtime.close();runtime=new TaskRuntime(directory);attach();
    await runtime.run(definition.action,{q:'again'});assert.equal(requests,7);assert.equal(baselineCalls,7);
  }finally{await runtime.close();}
});

test('saved prepared evidence recompiles after restart with no browser and stages a candidate',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'recompile-offline-'));
  const prepared=prepareJavaScriptCompilation(definition,traces,['one','four'].map(output),[id,id]);assert.ok(prepared);
  const bundle=await saveEvidenceBundle(join(directory,'evidence'),prepared);
  let runtime=new TaskRuntime(directory);
  const existing=await compilePreparedJavaScriptTask(definition,prepared,'unused-fixture',proposal);assert.ok(existing);
  existing.program=recordCompiledComparison(recordCompiledComparison(existing.program,{q:'other'},output('other'),output('other'),definition.outputSchema,id),
    {q:'second'},output('second'),output('second'),definition.outputSchema,id);
  await runtime.store.save({formatVersion:'clapping-hands/task-v2',definition,accelerator:null,
    javascriptAccelerator:existing,compilationEvidenceId:bundle.id});
  await runtime.close();runtime=new TaskRuntime(directory);
  let modelCalls=0,browserCalls=0;
  (runtime as any).session=async()=>{browserCalls++;throw new Error('No browser should be started.');};
  (runtime as any).compileEvidence=(d:TaskDefinition,e:unknown)=>compilePreparedJavaScriptTask(d,e,'unused-fixture',async()=>{
    modelCalls++;return {...await proposal(),proposal:{supported:true,source:source+' /* new generation */',explanation:'Fixture replacement'}};
  });
  try{
    const result=await runtime.recompile(definition.action);
    assert.equal(result.status,'candidate');assert.equal(result.browserRuns,0);assert.equal(result.existingTaskPreserved,true);
    assert.equal(browserCalls,0);assert.equal(modelCalls,1);
    const saved=await runtime.store.load(definition.action);assert.ok(saved);
    assert.deepEqual(saved.javascriptAccelerator,existing);
    assert.equal(saved.pendingJavascriptAccelerator?.program.status,'candidate');
    assert.notEqual(saved.pendingJavascriptAccelerator?.program.sourceHash,existing.program.sourceHash);
    assert.deepEqual(saved.pendingJavascriptAccelerator?.program.matchedInputHashes,[]);
    (runtime as any).compileEvidence=async()=>{throw new Error('Provider unavailable');};
    await assert.rejects(runtime.recompile(definition.action));
    assert.deepEqual(await runtime.store.load(definition.action),saved);
  }finally{await runtime.close();}
});

test('offline compilation rejects mismatched or unsupported evidence before the model',async()=>{
  const prepared=prepareJavaScriptCompilation(definition,traces,['one','four'].map(output),[id,id]);assert.ok(prepared);
  let modelCalls=0;const model=async()=>{modelCalls++;return proposal();};
  await assert.rejects(compilePreparedJavaScriptTask({...definition,goal:'Different meaning'},prepared,'unused-fixture',model));
  await assert.rejects(compilePreparedJavaScriptTask(definition,{...prepared,bodies:[]},'unused-fixture',model));
  await assert.rejects(compilePreparedJavaScriptTask(definition,{...prepared,inputs:[{q:'same'},{q:'same'}]},'unused-fixture',model));
  const controller=new AbortController();controller.abort();
  await assert.rejects(compilePreparedJavaScriptTask(definition,prepared,'unused-fixture',model,controller.signal));
  assert.equal(modelCalls,0);
});

test('learning keeps prepared evidence and the browser task when compilation fails',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'failed-compiler-evidence-'));
  const runtime=new TaskRuntime(directory);
  (runtime as any).session=async(_d:unknown,fn:(s:unknown)=>Promise<unknown>)=>fn({origin});
  (runtime as any).baseline=async(_s:unknown,_d:unknown,input:{q:string})=>({outcome:{status:'completed',data:output(input.q)},
    exchanges:traces.find(t=>t.input.q===input.q)!.exchanges,html:[],pages:[],durationMs:0,evidence:{status:'saved',id}});
  (runtime as any).compileEvidence=async()=>{throw new Error('Fixture provider down');};
  try{
    const result=await runtime.learn(definition,traces.map(t=>t.input));
    assert.equal(result.registered,true);assert.equal(result.javascriptCompilation,'failed');
    const saved=await runtime.store.load(definition.action);assert.ok(saved?.compilationEvidenceId);
    assert.equal(saved.javascriptAccelerator,undefined);
  }finally{await runtime.close();}
});
