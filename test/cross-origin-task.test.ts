import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskSession } from '../src/task-session.js';
import { TaskStore, taskDefinitionSchema } from '../src/task-store.js';
import { compileJavaScriptTask, prepareJavaScriptCompilation, replayJavaScriptTask } from '../src/javascript-task.js';
import { recordCompiledComparison, createCompiledProgram } from '../src/compiled-program.js';
import { authorizedNetworkOrigins } from '../src/task-network-scope.js';

const id='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';
const source="function*(input){const r=yield {op:'request',resource:'response_0',parameters:input};return JSON.parse(r.body);}";
async function listen(server:Server,host:string){await new Promise<void>((r,reject)=>{server.once('error',reject);server.listen(0,host,r);});const a=server.address();assert.ok(a&&typeof a!=='string');return 'http://'+host+':'+a.port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}

test('API scope requires exact caller authorization without credentials, wildcards or HTTPS downgrade',()=>{
  const startUrl='https://site.invalid';
  for(const origin of ['https://api.invalid/','https://api.invalid/path','https://api.invalid?x=1','http://api.invalid','https://u:p@api.invalid','*','https://*.api.invalid','file:///tmp']){
    assert.throws(()=>authorizedNetworkOrigins({startUrl,allowedNetworkOrigins:[origin]}));
  }
  assert.throws(()=>authorizedNetworkOrigins({startUrl,allowedNetworkOrigins:['https://api.invalid','https://api.invalid']}));
  assert.deepEqual([...authorizedNetworkOrigins({startUrl,allowedNetworkOrigins:['https://api.invalid']})],[startUrl,'https://api.invalid']);
});

test('authorized browser-observed API compiles, promotes and replays after restart without forwarding site cookies or expanding navigation',async()=>{
  let apiRequests=0;const leaked:string[]=[];
  let siteOrigin='';
  const api=createServer((req,res)=>{
    apiRequests++;if(req.headers.cookie || req.headers.authorization)leaked.push('credential-header');
    res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':siteOrigin,'cache-control':'no-store'});
    res.end(JSON.stringify({title:new URL(req.url!,'http://fixture.invalid').searchParams.get('q')}));
  });
  const site=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html','set-cookie':'private_fixture=value; Path=/; HttpOnly; SameSite=Lax'});res.end('<h1>Catalog</h1>');});
  const apiOrigin=await listen(api,'localhost');siteOrigin=await listen(site,'127.0.0.1');
  const directory=await mkdtemp(join(tmpdir(),'cross-origin-task-'));
  const definition=taskDefinitionSchema.parse({action:'read_catalog',startUrl:siteOrigin,goal:'Read catalog result',effect:'read',allowedNetworkOrigins:[apiOrigin],
    inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},
    outputSchema:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}});
  let session=new TaskSession(siteOrigin,join(directory,'profile'),true,[apiOrigin]);
  const store=new TaskStore(join(directory,'tasks'));
  try{
    await session.start();const page=session.context.pages()[0]!;await page.goto(siteOrigin);
    const traces=[];
    for(const q of ['alpha','beta']){
      const mark=session.network.mark();
      const actual=await page.evaluate(async({origin,q})=>{const r=await fetch(origin+'/search?q='+q);const data=await r.json();document.querySelector('h1')!.textContent=data.title;return data;},{origin:apiOrigin,q});
      assert.deepEqual(actual,{title:q});assert.equal(await page.locator('h1').innerText(),q);
      traces.push({input:{q},exchanges:await session.network.since(mark)});
    }
    const outputs=['alpha','beta'].map(title=>({title}));
    assert.equal(prepareJavaScriptCompilation({...definition,allowedNetworkOrigins:undefined},traces,outputs,[id,id]),null);
    const compiled=await compileJavaScriptTask(definition,traces,outputs,[id,id],'unused',async()=>({proposal:{supported:true,source,explanation:'Fixture parser'},durationMs:0,requestId:id,responseId:id}));
    assert.ok(compiled);assert.equal(compiled.resources[0]!.plan.request.endpointOrigin,apiOrigin);
    for(const q of ['gamma','delta']){
      const result=await replayJavaScriptTask(session.context,definition,compiled,{q});assert.deepEqual(result.value,{title:q});
      compiled.program=recordCompiledComparison(compiled.program,{q},result.value,{title:q},definition.outputSchema,id);
    }
    assert.equal(compiled.program.status,'stable');
    await store.save({formatVersion:'clapping-hands/task-v2',definition,accelerator:null,javascriptAccelerator:compiled});
    const denied={...definition,allowedNetworkOrigins:[]};
    await assert.rejects(store.save({formatVersion:'clapping-hands/task-v2',definition:denied,accelerator:null,javascriptAccelerator:{...compiled,
      program:createCompiledProgram(source,denied,compiled.resources,[{q:'alpha'},{q:'beta'}],[id,id])}}));
    const before=apiRequests;
    await assert.rejects(replayJavaScriptTask(session.context,denied,compiled,{q:'denied'}));assert.equal(apiRequests,before);
    await assert.rejects(page.goto(apiOrigin+'/search?q=navigation'));assert.equal(apiRequests,before);
    await session.close();session=new TaskSession(siteOrigin,join(directory,'profile'),true,[apiOrigin]);await session.start();
    const saved=await new TaskStore(join(directory,'tasks')).load(definition.action);assert.ok(saved?.javascriptAccelerator);
    const fresh=await replayJavaScriptTask(session.context,saved.definition,saved.javascriptAccelerator,{q:'epsilon'});
    assert.deepEqual(fresh.value,{title:'epsilon'});assert.equal(apiRequests,5);assert.deepEqual(leaked,[]);
  }finally{await session.close();await close(site);await close(api);}
});
