import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { NetworkRecorder } from '../src/network-recorder.js';
import { compileJavaScriptTask, compilePreparedJavaScriptTask, prepareJavaScriptCompilation, replayJavaScriptTask } from '../src/javascript-task.js';
import { saveEvidenceBundle } from '../src/evidence-bundle.js';
import { assertGenericJsonPlanSafety, compileGenericJsonPlan } from '../src/generic-network.js';
import { decodeGenericResponseBytes } from '../src/network-response.js';
import { rememberBrowserDecodedResponse } from '../src/captured-response.js';
import type { TaskDefinition } from '../src/task-store.js';
import type { CapturedExchange } from '../src/captured-exchange.js';

const html=(q:string)=>`<!doctype html><html><head><meta charset="utf-8"></head><body><main><article><h2>${q} book</h2><a href="/books/${q}">Details</a><p class="author">Alice</p><p class="author">Bob</p></article></main></body></html>`;
const source=`function*(input){const response=yield {op:'request',resource:'response_0',parameters:input};if(response.status!==200)throw Error();const rows=yield {op:'select',html:response.body,selector:'article'};if(!rows.length)throw Error();const result=[];for(const row of rows){const titles=yield {op:'select',html:row.html,selector:'h2'};const links=yield {op:'select',html:row.html,selector:'a'};const authors=yield {op:'select',html:row.html,selector:'.author'};result.push({title:titles[0].text,authors:authors.map(a=>a.text),url:yield {op:'url',base:response.url,relative:links[0].attributes.href}});}return result;}`;
const id='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';
const samples=['alpha','beta'].map(q=>{
  const exchange:CapturedExchange={url:'https://fixture.invalid/search?q='+q,method:'GET',requestHeaders:{accept:'text/html'},requestBody:'',
    resourceType:'document',responseStatus:200,responseHeaders:{'content-type':'text/html;charset=utf-8'},responseBody:html(q)};
  rememberBrowserDecodedResponse(exchange,exchange.responseBody);return {input:{q},exchange};
});

test('HTML document admission is explicit, provenance-bound and encoding-pinned without output recipes',()=>{
  assert.throws(()=>compileGenericJsonPlan('read_books',samples));
  const plan=compileGenericJsonPlan('read_books',samples,{allowHtmlDocument:true});
  assert.equal(plan.response.codec,'html-document');assert.equal(plan.response.documentEncoding,'utf-8');
  assert.equal(decodeGenericResponseBytes(plan.response,Buffer.from(html('new')),'text/html;charset=utf-8'),html('new'));
  assert.throws(()=>compileGenericJsonPlan('read_books',structuredClone(samples),{allowHtmlDocument:true}));
  for(const patch of [{documentEncoding:'utf-16'},{documentEncoding:undefined},{maximumBytes:2_000_000},{codec:'json'}]){
    assert.throws(()=>assertGenericJsonPlanSafety({...plan,response:{...plan.response,...patch} as typeof plan.response}));
  }
  assert.throws(()=>decodeGenericResponseBytes(plan.response,Buffer.from(html('new')),'text/html;charset=windows-1252'));
  assert.throws(()=>decodeGenericResponseBytes(plan.response,Buffer.from('<meta http-equiv="refresh" content="0;url=/login">'),'text/html;charset=utf-8'));
});

test('browser-recorded search HTML compiles into fresh nested results without a static extraction recipe',async()=>{
  let requests=0,status=200;
  const server=createServer((req,res)=>{requests++;const q=new URL(req.url??'/','http://fixture.invalid').searchParams.get('q')??'home';
    res.writeHead(status,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(html(q));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CLAPPING_HANDS_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{
    const context=await browser.newContext(),page=await context.newPage(),recorder=new NetworkRecorder();
    recorder.setAllowedOrigins([origin]);recorder.attach(page);
    const definition:TaskDefinition={action:'read_books',startUrl:origin+'/',goal:'Return book titles, all authors and detail URLs',effect:'read',
      inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},
      outputSchema:{type:'array',items:{type:'object',properties:{title:{type:'string'},authors:{type:'array',items:{type:'string'}},url:{type:'string'}},required:['title','authors','url'],additionalProperties:false}}};
    const traces=[];const outputs=[];
    for(const q of ['alpha','beta']){
      const mark=recorder.mark();await recorder.withDocumentResponses(()=>page.goto(origin+'/search?q='+q));
      traces.push({input:{q},exchanges:await recorder.since(mark)});
      outputs.push([{title:await page.locator('h2').innerText(),authors:await page.locator('.author').allTextContents(),url:origin+await page.locator('article a').getAttribute('href')}]);
    }
    let modelCalls=0;
    // Explicit opt-in only; ordinary regression runs never contact a model.
    const live=process.env.CLAPPING_HANDS_LIVE_HTML_COMPILER_SMOKE==='1';
    const directory=resolve('.data/release-smokes/generated-html');
    let compiled;
    if(live){
      const captured=await saveEvidenceBundle(directory,{kind:'controlled-html-observation',definition,traces,outputs});
      const prepared=prepareJavaScriptCompilation(definition,traces,outputs,[captured.id,captured.id]);assert.ok(prepared);
      const saved=await saveEvidenceBundle(directory,prepared);
      console.log(JSON.stringify({kind:'live-html-compiler-evidence',id:saved.id,browserUseRuns:0}));
      compiled=await compilePreparedJavaScriptTask(definition,prepared,directory);
    }else compiled=await compileJavaScriptTask(definition,traces,outputs,[id,id],'unused-fixture',async evidence=>{
      modelCalls++;assert.match(JSON.stringify(evidence),/sanitized HTML text/);
      return {proposal:{supported:true,source,explanation:'Fixture compiler boundary'},durationMs:0,requestId:id,responseId:id};
    });
    assert.ok(compiled);assert.equal(compiled.resources[0]!.plan.response.codec,'html-document');
    const before=requests;
    const result=await replayJavaScriptTask(context,definition,compiled,{q:'unseen'});
    assert.deepEqual(result.value,[{title:'unseen book',authors:['Alice','Bob'],url:origin+'/books/unseen'}]);
    assert.equal(requests,before+1);assert.equal(result.modelCalls,0);if(!live)assert.equal(modelCalls,1);assert.equal(context.pages().length,1);
    // Independent rendered check happens after the network-only invocation.
    await page.goto(origin+'/search?q=unseen');assert.equal(await page.locator('h2').innerText(),(result.value as any)[0].title);
    if(live){
      const saved=await saveEvidenceBundle(directory,{kind:'live-html-compiler-result',program:compiled.program,
        input:{q:'unseen'},actual:result.value,expected:[{title:await page.locator('h2').innerText(),authors:await page.locator('.author').allTextContents(),url:origin+await page.locator('article a').getAttribute('href')}],
        durationMs:result.durationMs,requests:result.requests,runtimeModelCalls:result.modelCalls,browserUseRuns:0});
      console.log(JSON.stringify({kind:'live-html-compiler-result',id:saved.id,requests:result.requests,durationMs:result.durationMs,runtimeModelCalls:0}));
    }
    status=403;await assert.rejects(replayJavaScriptTask(context,definition,compiled,{q:'blocked'}));
  }finally{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
