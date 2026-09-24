import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompiledProgram, compiledProgramSchema, recordCompiledComparison, assertCompiledProgramBinding,
  executeCompiledProgram, programDigest } from '../src/compiled-program.js';

const evidence='1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef';
const source=`function*(input){const r=yield {op:'request',resource:'search',parameters:{q:input.q}};return r.body;}`;
const schema={type:'string' as const};
const contract={action:'read_search',outputSchema:schema};
const resources={search:{origin:'https://fixture.invalid'}};
const candidate=()=>createCompiledProgram(source,contract,resources,[{q:'a'}],[evidence]);
const compare=(p:ReturnType<typeof candidate>,q:string,actual:unknown='fresh',expected:unknown='fresh')=>recordCompiledComparison(p,{q},actual,expected,schema,evidence);

test('promotion needs two distinct held-out inputs, never training repeats',()=>{
  let p=candidate();
  p=compare(p,'a');p=compare(p,'a');assert.equal(p.status,'candidate');
  p=compare(p,'b');p=compare(p,'b');assert.equal(p.status,'candidate');
  p=compare(p,'c');assert.equal(p.status,'stable');
  assert.deepEqual(compiledProgramSchema.parse(JSON.parse(JSON.stringify(p))),p);
  assert.equal(programDigest({q:'a',nested:{a:1,b:2}}),programDigest({nested:{b:2,a:1},q:'a'}));
  assert.notEqual(programDigest([1,2]),programDigest([2,1]));
});
test('shape and semantic mismatches degrade and cannot be revived by later matches',()=>{
  for(const actual of [42,'wrong result']){
    let p=compare(candidate(),'b',actual);assert.equal(p.status,'degraded');
    p=compare(compare(p,'c'),'d');assert.equal(p.status,'degraded');assert.equal(p.failures,1);
  }
});
test('source, contract, resources and forged stable labels are checked after loading',()=>{
  const p=candidate();
  assert.throws(()=>compiledProgramSchema.parse({...p,source:source+' '}));
  assert.throws(()=>compiledProgramSchema.parse({...p,status:'stable'}));
  assert.throws(()=>assertCompiledProgramBinding(p,{...contract,action:'different'},resources));
  assert.throws(()=>assertCompiledProgramBinding(p,contract,{search:{origin:'https://other.invalid'}}));
  assert.throws(()=>compiledProgramSchema.parse({...p,status:'stable',matchedInputHashes:[programDigest({q:'a'}),programDigest({q:'a'})]}));
});
test('only promoted programs return fresh results; shadow and cancellation are explicit',async()=>{
  const p=candidate();let calls=0;
  const broker=async()=>{calls++;return {body:'fresh'};};
  await assert.rejects(executeCompiledProgram(p,contract,resources,{q:'b'},schema,broker));assert.equal(calls,0);
  assert.equal((await executeCompiledProgram(p,contract,resources,{q:'b'},schema,broker,{shadow:true})).value,'fresh');
  const stable=compare(compare(p,'b'),'c');
  assert.equal((await executeCompiledProgram(stable,contract,resources,{q:'d'},schema,broker)).value,'fresh');
  const controller=new AbortController();controller.abort();
  await assert.rejects(executeCompiledProgram(stable,contract,resources,{q:'e'},schema,broker,{signal:controller.signal}));
  assert.equal(calls,2);
  const constant=createCompiledProgram(`function*(){return 'fresh';}`,contract,resources,[{q:'a'}],[evidence]);
  await assert.rejects(executeCompiledProgram(constant,contract,resources,{q:'b'},schema,broker,{shadow:true}));
});
