import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {CallerRecording} from '../src/caller-recording.js';
import type {TaskSession} from '../src/task-session.js';
import type {TaskDefinition} from '../src/task-store.js';
import {loadEvidenceBundle} from '../src/evidence-bundle.js';

const definition:TaskDefinition={action:'caller_search',startUrl:'https://fixture.invalid/',goal:'Return displayed title',effect:'read',
 inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},outputSchema:{type:'string'}};
function fake(){
 let closes=0,windows=0;const context=Object.assign(new EventEmitter(),{pages:()=>[]});
 const recorder={mark:()=>1,withDocumentResponses:async(fn:()=>Promise<unknown>)=>{windows++;try{return await fn();}finally{windows--;}},since:async()=>[],diagnosticSnapshotSince:()=>({})};
 const session={origin:'https://fixture.invalid',cdpUrl:'http://127.0.0.1:1234',network:recorder,evidenceNetwork:recorder,context,
  start:async()=>{},close:async()=>{closes++;context.emit('close');}} as unknown as TaskSession;
 return {session,context,closes:()=>closes,windows:()=>windows};
}
test('caller recording exposes connection only after capture begins and closes exactly once',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'caller-recording-')),f=fake();
 const recording=await CallerRecording.start(definition,{q:'alpha'},directory,'unused',new AbortController().signal,{sessionFactory:()=>f.session});
 assert.equal(f.windows(),2);assert.match(recording.connection().recordingId,/^[a-f0-9-]+$/);
 await assert.rejects(recording.finish({status:'completed',data:12}));assert.equal(f.windows(),2);
 const result=await recording.finish({status:'completed',data:'Alpha'});
 assert.equal(result.evidence.status,'saved');assert.equal(f.closes(),1);assert.equal(f.windows(),0);
 await assert.rejects(recording.finish({status:'completed',data:'Alpha'}));await recording.cancel();assert.equal(f.closes(),1);
 assert.throws(()=>recording.connection());
});
test('abort, deadline and caller browser closure settle recordings and refuse late success',async()=>{
 for(const mode of ['abort','deadline','close']){
  const directory=await mkdtemp(join(tmpdir(),'caller-recording-')),f=fake(),controller=new AbortController();
  const recording=await CallerRecording.start(definition,{q:'alpha'},directory,'unused',controller.signal,{sessionFactory:()=>f.session,timeoutMs:mode==='deadline'?10:1000});
  if(mode==='abort')controller.abort();if(mode==='close')f.context.emit('close');
  if(mode==='deadline')await new Promise(r=>setTimeout(r,30));
  await recording.cancel();assert.equal(f.closes(),1);assert.equal(f.windows(),0);
  await assert.rejects(recording.finish({status:'completed',data:'late'}));
 }
});
test('a separate CDP client drives an owned browser while the shared recorder retains requests',async()=>{
 const server=createServer((req,res)=>{
  const url=new URL(req.url??'/','http://fixture.invalid');
  if(url.pathname==='/search'){res.setHeader('content-type','application/json');res.end(JSON.stringify({title:'Result '+url.searchParams.get('q')}));}
  else {res.setHeader('content-type','text/html');res.end('<button id="go">Search</button><h1 id="result">Empty</h1><script>document.querySelector("button").onclick=async()=>{const r=await fetch("/search?q=alpha");document.querySelector("h1").textContent=(await r.json()).title}</script>');}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const directory=await mkdtemp(join(tmpdir(),'caller-cdp-'));
 let recording:CallerRecording|undefined,client:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
 try{
  recording=await CallerRecording.start({...definition,startUrl:`http://127.0.0.1:${address.port}/`},{q:'alpha'},directory,join(directory,'profile'),new AbortController().signal,{headless:true});
  client=await chromium.connectOverCDP(recording.connection().cdpUrl);
  const page=client.contexts()[0]!.pages()[0]!;
  await page.goto(recording.connection().startUrl);await page.click('#go');
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Result alpha');
  const title=await page.locator('h1').innerText();
  const result=await recording.finish({status:'completed',data:title});
  assert.equal(result.outcome.status,'completed');assert.ok(result.exchanges.some(e=>new URL(e.url).pathname==='/search'));
  assert.equal(result.evidence.status,'saved');if(result.evidence.status!=='saved')throw Error('capture missing');
  const capture=await loadEvidenceBundle(join(directory,'evidence'),result.evidence.id) as any;
  assert.equal(capture.provenance,'caller-baseline');assert.equal(capture.model,null);assert.equal(capture.snapshots.length,1);
 }finally{await recording?.cancel();await client?.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
