import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskRuntime } from '../src/task-runtime.js';
import { compilePageReplay, recordPageShadow } from '../src/page-replay.js';

test('runtime degrades a broken accelerator, falls back once, and remembers after restart', async () => {
  const server=createServer((req,res)=>{res.writeHead(req.url?.startsWith('/broken')?403:200,{'content-type':'text/html'});res.end('<h1>Fresh result</h1>');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  const directory=await mkdtemp(join(tmpdir(),'runtime-fallback-'));
  const evidence=(q:string)=>[{url:origin+'/broken?q='+q,selectors:[{selector:'h1',index:0}]}];
  let plan=compilePageReplay(origin,[{q:'a'},{q:'b'}],[evidence('a'),evidence('b')])!;
  plan=recordPageShadow(recordPageShadow(plan,{q:'c'},true),{q:'d'},true);
  let runtime=new TaskRuntime(directory), calls=0;
  const attachFixtureBaseline=()=>{
    // Test-only boundary substitution: routing and real browser replay remain real.
    (runtime as any).baseline=async(session:any)=>{calls++;const page=await session.context.newPage();await page.goto(origin+'/working');return {outcome:{status:'completed',data:await page.locator('h1').innerText()},exchanges:[],durationMs:0};};
  };
  try {
    await runtime.store.save({formatVersion:'clapping-hands/task-v2',definition:{action:'fallback_read',startUrl:origin+'/',goal:'Read fresh result',effect:'read',inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},outputSchema:{type:'string'}},accelerator:null,pageAccelerator:plan});
    attachFixtureBaseline();
    const first=await runtime.run('fallback_read',{q:'e'});
    assert.equal(first.fallback,true);assert.equal(first.engine,'browser-use');assert.equal(calls,1);
    assert.deepEqual(first.outcome,{status:'completed',data:'Fresh result'});
    assert.equal((await runtime.store.load('fallback_read'))?.pageAccelerator?.status,'degraded');
    await runtime.close();runtime=new TaskRuntime(directory);attachFixtureBaseline();
    const second=await runtime.run('fallback_read',{q:'f'});
    assert.equal(second.fallback,false);assert.equal(calls,2);
    assert.deepEqual(second.outcome,first.outcome);
  } finally {await runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('reported wall time includes session acquisition and cleanup, not only execution',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'runtime-wall-time-'));
  const runtime=new TaskRuntime(directory);
  (runtime as any).session=async(_definition:unknown,fn:(session:unknown)=>Promise<unknown>)=>{
    await new Promise(r=>setTimeout(r,20));
    try{return await fn({});}finally{await new Promise(r=>setTimeout(r,20));}
  };
  (runtime as any).baseline=async()=>({outcome:{status:'completed',data:'fresh'},exchanges:[],durationMs:1});
  try{
    await runtime.store.save({formatVersion:'clapping-hands/task-v2',accelerator:null,
      definition:{action:'read_timing',startUrl:'https://fixture.invalid/',goal:'Read fresh text',effect:'read',
        inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},outputSchema:{type:'string'}}});
    const result=await runtime.run('read_timing',{});
    assert.equal(result.durationMs,1);assert.ok(result.wallDurationMs!>=35);
  }finally{await runtime.close();}
});
