import test from 'node:test';
import assert from 'node:assert/strict';
import { executeGeneratedJavaScript as run } from '../src/generated-js.js';

test('generated JS can compose requests, HTML selection, nested lists and URL construction',async()=>{
  const source=`function* (input){const response=yield {op:'request',resource:'search',parameters:{q:input.q}};const rows=yield {op:'select',html:response.body,selector:'article'};const output=[];for(const row of rows){const links=yield {op:'select',html:row.html,selector:'a'};output.push({title:links[0].text.trim(),url:yield {op:'url',base:'https://fixture.invalid',relative:links[0].attributes.href}});}return output;}`;
  const result=await run(source,{q:'new'},{type:'array',items:{type:'object',properties:{title:{type:'string'},url:{type:'string'}},required:['title','url'],additionalProperties:false}},async request=>{
    assert.deepEqual(request.parameters,{q:'new'});return {body:'<article><a href="/new">Fresh book</a></article>'};
  });
  assert.deepEqual(result.value,[{title:'Fresh book',url:'https://fixture.invalid/new'}]);assert.equal(result.requests,1);assert.equal(result.modelCalls,0);
});
test('guest has no Node, environment, fetch or imports',async()=>{
  const result=await run(`function*(){return [typeof process,typeof require,typeof fetch].join(',');}`,{}, {type:'string'},async()=>{throw Error('not called');});
  assert.equal(result.value,'undefined,undefined,undefined');
  await assert.rejects(run(`function*(){return process.env.SECRET;}`,{},{type:'string'},async()=>null));
});
test('infinite loops and excessive outputs are bounded',async()=>{
  await assert.rejects(run(`function*(){while(true){} }`,{},{type:'string'},async()=>null,{timeoutMs:1000}));
  await assert.rejects(run(`function*(){return 'x'.repeat(1100000);}`,{},{type:'string'},async()=>null));
});
test('broker denials, malformed capabilities, budgets and output schemas fail closed',async()=>{
  await assert.rejects(run(`function*(){return yield {op:'request',resource:'forbidden',parameters:{}};}`,{},{type:'string'},async()=>{throw Error('private-secret');}),e=>e instanceof Error&&!e.message.includes('private-secret'));
  await assert.rejects(run(`function*(){return yield {op:'request',resource:'search',parameters:{},url:'https://evil.invalid'};}`,{},{type:'string'},async()=>null));
  await assert.rejects(run(`function*(){yield {op:'request',resource:'search',parameters:{}};return 'x';}`,{},{type:'string'},async()=>null,{maxRequests:0}));
  await assert.rejects(run(`function*(){return 42;}`,{},{type:'string'},async()=>null));
});
test('caller cancellation terminates a pending guest and aborts its broker',async()=>{
  const controller=new AbortController();let brokerAborted=false;
  const running=run(`function*(){return yield {op:'request',resource:'search',parameters:{}};}`,{},{type:'string'},async(_request,signal)=>{
    signal.addEventListener('abort',()=>{brokerAborted=true;},{once:true});
    controller.abort();
    return await new Promise<never>(()=>{});
  },{signal:controller.signal});
  await assert.rejects(running,error=>error instanceof Error&&error.message.includes('cancelled'));
  assert.equal(brokerAborted,true);
});
