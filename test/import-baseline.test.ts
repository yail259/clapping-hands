import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskRuntime } from '../src/task-runtime.js';
import { saveEvidenceBundle, loadEvidenceBundle } from '../src/evidence-bundle.js';
import { taskDefinitionSchema } from '../src/task-store.js';

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'baseline-import-'));
  const runtime=new TaskRuntime(directory);
  const definition=taskDefinitionSchema.parse({action:'search_fixture',startUrl:'https://fixture.invalid/',goal:'Return the search title',effect:'read',
    inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},outputSchema:{type:'string'}});
  await runtime.store.save({formatVersion:'clapping-hands/task-v2',definition,accelerator:null});
  const capture=(query:string,overrides:Record<string,unknown>={})=>({provenance:'browser-use-baseline',definition,input:{query},
    outcome:{status:'completed',data:'Result '+query},exchanges:[{url:'https://fixture.invalid/search?q='+query,method:'GET',resourceType:'fetch',
      requestHeaders:{accept:'application/json'},requestBody:'',responseStatus:200,responseHeaders:{'content-type':'application/json'},
      responseBody:JSON.stringify({title:'Result '+query})}],...overrides});
  const save=async(value:unknown)=>(await saveEvidenceBundle(join(directory,'evidence'),value)).id;
  const ids=[await save(capture('alpha')),await save(capture('beta'))];
  return {directory,runtime,definition,capture,save,ids};
}

test('saved baseline preparation restores a restartable compiler bundle without browser or inference',async()=>{
  const f=await fixture();
  (f.runtime as any).session=()=>{throw new Error('Browser must not run');};
  (f.runtime as any).compileEvidence=()=>{throw new Error('Model must not run');};
  try{
    const result=await f.runtime.prepareFromCaptures(f.definition.action,f.ids);
    assert.equal(result.status,'prepared');
    assert.equal(result.browserRuns,0);assert.equal(result.modelCalls,0);assert.equal(result.networkRequests,0);
    const saved=await new TaskRuntime(f.directory).store.load(f.definition.action);
    assert.ok(saved?.compilationEvidenceId);
    assert.equal(saved.javascriptAccelerator,undefined);
    assert.equal(saved.pendingJavascriptAccelerator,undefined);
    const prepared=await loadEvidenceBundle(join(f.directory,'evidence'),saved.compilationEvidenceId) as any;
    assert.deepEqual(prepared.inputs,[{query:'alpha'},{query:'beta'}]);
    assert.deepEqual(prepared.outputs,['Result alpha','Result beta']);
  }finally{await f.runtime.close();}
});

test('foreign, incomplete, duplicate and lossy captures cannot replace saved compiler evidence',async()=>{
  const f=await fixture();
  try{
    await f.runtime.prepareFromCaptures(f.definition.action,f.ids);
    const before=await f.runtime.store.load(f.definition.action);
    for(const override of [{definition:{...f.definition,goal:'Other task'}},{outcome:{status:'failed'}},
      {provenance:'known-page-network-capture'},{input:{query:'alpha'}},{outcome:{status:'completed',data:123}}]){
      const id=await f.save(f.capture('beta',override));
      await assert.rejects(f.runtime.prepareFromCaptures(f.definition.action,[f.ids[0]!,id]));
      assert.deepEqual(await f.runtime.store.load(f.definition.action),before);
    }
    await assert.rejects(f.runtime.prepareFromCaptures(f.definition.action,[f.ids[0]!,f.ids[0]!]));
    await assert.rejects(f.runtime.prepareFromCaptures(f.definition.action,['../outside',f.ids[1]!]));
    const lost=await Promise.all(['gamma','delta'].map(async q=>{const c=f.capture(q);c.exchanges[0]!.requestBody='[OMITTED]';return f.save(c);}));
    assert.equal((await f.runtime.prepareFromCaptures(f.definition.action,lost)).status,'no-admitted-resources');
    assert.deepEqual(await f.runtime.store.load(f.definition.action),before);
  }finally{await f.runtime.close();}
});

test('built MCP prepares saved captures with unavailable model and browser configuration',async()=>{
  const f=await fixture();await f.runtime.close();
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist-alpha/src/alpha-server.js')],env:{PATH:process.env.PATH??'',
    CLAPPING_HANDS_DATA_DIR:f.directory,CLAPPING_HANDS_CREDENTIAL_ENV_FILE:'/unavailable-credentials',
    CLAPPING_HANDS_BROWSER_USE_PYTHON:'/unavailable-agent',CLAPPING_HANDS_CHROME_PATH:'/unavailable-browser'},stderr:'pipe'});
  const client=new Client({name:'offline-import',version:'1'});
  try{
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(t=>t.name==='clapping_hands_prepare_from_captures'));
    const result=await client.callTool({name:'clapping_hands_prepare_from_captures',arguments:{action:f.definition.action,evidenceIds:f.ids}});
    assert.notEqual(result.isError,true);
    const data=result.structuredContent as Record<string,unknown>;
    assert.equal(data.status,'prepared');
    assert.equal(data.modelCalls,0);
    const status=await client.callTool({name:'clapping_hands_status',arguments:{}});
    assert.equal(JSON.parse((status.content as any)[0].text)[0].canRecompile,true);
    const contextResult=await client.callTool({name:'clapping_hands_compilation_context',arguments:{action:f.definition.action}});
    assert.notEqual(contextResult.isError,true);
    const context=contextResult.structuredContent as any;
    assert.equal(context.status,'ready');assert.equal(context.modelCalls,0);assert.equal(context.browserRuns,0);
    assert.match(context.instructions,/synchronous generator/);
    const source='function*(input){const r=yield {op:"request",resource:"response_0",parameters:input};return JSON.parse(r.body).title;}';
    const submitted=await client.callTool({name:'clapping_hands_submit_candidate',arguments:{action:f.definition.action,evidenceId:context.evidenceId,source}});
    assert.notEqual(submitted.isError,true);
    assert.equal((submitted.structuredContent as any).requiresHeldOutValidation,true);
    const staged=await f.runtime.store.load(f.definition.action);assert.ok(staged);
    assert.equal(staged.pendingJavascriptAccelerator?.program.status,'candidate');
    assert.equal(staged.javascriptAccelerator,undefined);
    for(const args of [{evidenceId:context.evidenceId,source:'function*(){return "incorrect";}'},{evidenceId:f.ids[0],source}]){
      const rejected=await client.callTool({name:'clapping_hands_submit_candidate',arguments:{action:f.definition.action,...args}});
      assert.equal(rejected.isError,true);
      assert.deepEqual(await f.runtime.store.load(f.definition.action),staged);
    }
  }finally{await client.close();}
});
