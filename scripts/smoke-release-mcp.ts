/** Paid, explicit release verification on a local controlled fixture. Never
 * imported by npm test. All state/evidence survives failures for inspection. */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let apiRequests=0,documentRequests=0;
const fixture=createServer((req,res)=>{
  const url=new URL(req.url??'/','http://fixture.invalid');
  res.setHeader('cache-control','no-store');
  if(url.pathname==='/search'){
    apiRequests++;const q=url.searchParams.get('q')??'';
    res.setHeader('content-type','application/json');res.end(JSON.stringify({title:'Result for '+q,price:q.length+10}));
  }else{
    documentRequests++;res.setHeader('content-type','text/html;charset=utf-8');
    res.end(`<!doctype html><html><body><h1>Catalog</h1><label>Search <input id="q"></label><button id="search">Search</button><section><h2 id="title">No results yet</h2><p>Current price: <span id="price"></span></p></section><script>document.getElementById('search').onclick=async()=>{const r=await fetch('/search?q='+encodeURIComponent(document.getElementById('q').value));const data=await r.json();document.getElementById('title').textContent=data.title;document.getElementById('price').textContent=data.price;};</script></body></html>`);
  }
});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
const address=fixture.address();assert.ok(address&&typeof address!=='string');
const directory=resolve(process.env.CLAPPING_HANDS_SMOKE_DATA_DIR??'.data/release-smokes/mcp-'+Date.now());
await mkdir(directory,{recursive:true,mode:0o700});
const entry=resolve(process.env.CLAPPING_HANDS_TEST_SERVER??'dist-alpha/src/alpha-server.js');
const baseEnv=Object.fromEntries(Object.entries({...process.env,CLAPPING_HANDS_DATA_DIR:directory}).filter((e):e is [string,string]=>typeof e[1]==='string'));
const stages:unknown[]=[];
let client:Client|undefined;
const report={scope:'controlled packaged MCP, no human login or production-site claim',entry,directory,passed:false,stages};
async function checkpoint(){await writeFile(resolve(directory,'acceptance.json'),JSON.stringify(report,null,2),{mode:0o600});}
async function connect(models=true){
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],env:models?baseEnv:{...baseEnv,
    CLAPPING_HANDS_CREDENTIAL_ENV_FILE:'/unavailable-model-credentials',CLAPPING_HANDS_BROWSER_USE_PYTHON:'/unavailable-browser-agent'},stderr:'pipe'});
  const next=new Client({name:'release-acceptance',version:'1.0.0'});await next.connect(transport);return next;
}
async function call(name:string,args:Record<string,unknown>){
  const started=performance.now();const result=await client!.callTool({name,arguments:args},undefined,{timeout:540_000});
  const wallMs=performance.now()-started;
  const data=result.structuredContent as any;
  stages.push({name,wallMs,isError:result.isError===true,data});await checkpoint();
  assert.notEqual(result.isError,true);return {data,wallMs};
}
const fields={startUrl:'http://127.0.0.1:'+address.port+'/',goal:'Use the Search field and Search button for query. Return the displayed result title and numeric current price. Do not return the initial empty result.',
  inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},
  outputSchema:{type:'object',properties:{title:{type:'string'},price:{type:'number'}},required:['title','price'],additionalProperties:false}};
const expected=(query:string)=>({status:'completed',data:{title:'Result for '+query,price:query.length+10}});
try{
  client=await connect();
  const learned=await call('clapping_hands_learn_read',{...fields,action:'fixture_search',examples:[{query:'alpha'},{query:'beta'}]});
  assert.equal(learned.data.registered,true);assert.equal(learned.data.javascriptCompilation,'candidate');
  console.log(JSON.stringify({phase:'learn',passed:true}));
  for(const query of ['gamma','delta']){
    const result=await call('clapping_hands_do_fixture_search',{query});assert.deepEqual(result.data.outcome,expected(query));
    assert.equal(result.data.shadowMatch,true);console.log(JSON.stringify({phase:'held-out',passed:true}));
  }
  await client.close();client=await connect(false);
  const before={apiRequests,documentRequests};
  const warm=await call('clapping_hands_do_fixture_search',{query:'epsilon'});
  assert.deepEqual(warm.data.outcome,expected('epsilon'));assert.equal(warm.data.engine,'network');assert.equal(warm.data.modelCalls,0);
  assert.equal(apiRequests-before.apiRequests,1);assert.equal(documentRequests,before.documentRequests);
  assert.ok(warm.data.wallDurationMs>=warm.data.durationMs);
  console.log(JSON.stringify({phase:'restart-without-model',passed:true,engineMs:warm.data.durationMs,wallMs:warm.wallMs}));
  await client.close();client=await connect();
  await call('clapping_hands_learn_read',{...fields,action:'fixture_baseline',examples:[{query:'theta'}]});
  for(const query of ['zeta','eta']){
    const baseline=await call('clapping_hands_do_fixture_baseline',{query});
    const fast=await call('clapping_hands_do_fixture_search',{query});
    assert.equal(baseline.data.engine,'browser-use');assert.equal(fast.data.engine,'network');
    assert.deepEqual(baseline.data.outcome,expected(query));assert.deepEqual(fast.data.outcome,baseline.data.outcome);
    stages.push({phase:'matched-comparison',query,exact:true,baselineWallMs:baseline.wallMs,compiledWallMs:fast.wallMs,speedup:baseline.wallMs/fast.wallMs});
    await checkpoint();console.log(JSON.stringify({phase:'matched-comparison',passed:true,speedup:baseline.wallMs/fast.wallMs}));
  }
  report.passed=true;await checkpoint();console.log(JSON.stringify({passed:true,report:resolve(directory,'acceptance.json')}));
}catch(error){
  stages.push({phase:'failure',category:error instanceof Error?error.name:'unknown'});await checkpoint();
  console.log(JSON.stringify({passed:false,report:resolve(directory,'acceptance.json')}));process.exitCode=1;
}finally{await client?.close();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));}
