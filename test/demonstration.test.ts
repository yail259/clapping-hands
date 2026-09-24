import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureDemonstration,type DemonstrationProvider} from '../src/demonstration.js';
import {loadEvidenceBundle} from '../src/evidence-bundle.js';
import type {TaskSession} from '../src/task-session.js';
import type {TaskDefinition} from '../src/task-store.js';

const definition:TaskDefinition={action:'read_fixture',startUrl:'https://fixture.invalid/',goal:'Read title',effect:'read',
 inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false},outputSchema:{type:'string'}};
function session(failCapture=false){
 let recording=0;
 const recorder={mark:()=>1,withDocumentResponses:async(fn:()=>Promise<unknown>)=>{recording++;try{return await fn();}finally{recording--;}},
  since:async()=>{if(failCapture)throw Error('capture fault');return [];},diagnosticSnapshotSince:()=>({count:0})};
 return {value:{origin:'https://fixture.invalid',cdpUrl:'http://127.0.0.1:1234',network:recorder,evidenceNetwork:recorder,context:{pages:()=>[]}} as unknown as TaskSession,
  recording:()=>recording};
}
test('caller demonstration records under both recorders with no model configuration and redacts known secrets',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'demonstration-'));const s=session();
 const provider:DemonstrationProvider={kind:'caller',execute:async(task,options)=>{
  assert.equal(s.recording(),2);assert.deepEqual(task.input,{q:'alpha'});
  assert.deepEqual(options.allowedOrigins,['https://fixture.invalid']);
  options.onEvidence({note:'private-fixture-value'});
  return {outcome:{status:'completed',data:'Result'},secrets:['private-fixture-value']};
 }};
 const result=await captureDemonstration(s.value,definition,{q:'alpha'},directory,provider,new AbortController().signal);
 assert.equal(s.recording(),0);assert.deepEqual(result.outcome,{status:'completed',data:'Result'});
 assert.equal(result.modelUsage,undefined);assert.equal(result.evidence.status,'saved');
 if(result.evidence.status!=='saved')throw Error('missing evidence');
 const saved=await loadEvidenceBundle(join(directory,'evidence'),result.evidence.id) as any;
 assert.equal(saved.provenance,'caller-baseline');assert.equal(saved.passiveEvidenceGrantsExecutionAuthority,false);
 assert.equal(JSON.stringify(saved).includes('private-fixture-value'),false);
});
test('capture faults preserve successful outcomes while malformed providers and cancellation cannot supply success',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'demonstration-'));const s=session(true);
 let calls=0;const provider:DemonstrationProvider={kind:'caller',execute:async()=>{calls++;return {outcome:{status:'completed',data:'Result'}};}};
 const result=await captureDemonstration(s.value,definition,{q:'alpha'},directory,provider,new AbortController().signal);
 assert.equal(result.outcome.status,'completed');assert.equal(result.evidence.status,'saved');
 await assert.rejects(captureDemonstration(s.value,definition,{q:'alpha'},directory,provider,AbortSignal.abort()));
 assert.equal(calls,1);
 await assert.rejects(captureDemonstration(s.value,definition,{q:'alpha'},directory,{kind:'caller',execute:async()=>({outcome:{status:'completed',data:123}})},new AbortController().signal));
 assert.equal(s.recording(),0);
});
