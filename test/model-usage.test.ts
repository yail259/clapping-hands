import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserModelUsage } from '../src/model-usage.js';
import { runBrowserUseTask } from '../src/browser-use-task.js';
import { sanitizeEvidence } from '../src/evidence-bundle.js';

const event={kind:'browser-use-usage',requestAttempts:2,reportedInvocations:2,promptTokens:100,completionTokens:20,cachedPromptTokens:10,tokenCoverageComplete:true,costUSD:null};
test('browser usage keeps unknown distinct from zero and rejects incomplete or conflicting telemetry',()=>{
  assert.equal(browserModelUsage([]),undefined);assert.equal(browserModelUsage([event,event]),undefined);
  assert.equal(browserModelUsage([event])?.requestAttempts,2);
  for(const patch of [{requestAttempts:-1},{promptTokens:Infinity},{costUSD:0},{secret:'not-allowed'},
    {promptTokens:null},{reportedInvocations:1},{requestAttempts:1.5}])assert.equal(browserModelUsage([{...event,...patch}]),undefined);
  const partial=browserModelUsage([{...event,reportedInvocations:1,tokenCoverageComplete:false}]);
  assert.equal(partial?.requestAttempts,2);assert.equal(partial?.tokenCoverageComplete,false);assert.equal(partial?.costUSD,null);
  assert.deepEqual((sanitizeEvidence({usage:{unit:'tokens',prompt:100,completion:20,cachedPrompt:10,coverageComplete:true}}).data as any).usage,
    {unit:'tokens',prompt:100,completion:20,cachedPrompt:10,coverageComplete:true});
});
test('Python telemetry exporter is numeric-only, marks missing usage and does not invent pricing',()=>{
  execFileSync(process.env.CLAPPING_HANDS_BROWSER_USE_PYTHON??'python3',[fileURLToPath(new URL('./model-usage.py',import.meta.url))],{stdio:'pipe'});
});
test('numeric usage arrives over the separate worker evidence pipe without changing result data',async()=>{
  const events:unknown[]=[];
  const result=await runBrowserUseTask({startUrl:'https://example.com/',goal:'usage',effect:'read',input:{},
    inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},outputSchema:{type:'string'}},
    {python:process.execPath,workerPath:fileURLToPath(new URL('./fixtures/browser-task-worker.mjs',import.meta.url)),cdpUrl:'http://127.0.0.1:9222',
      allowedOrigins:['https://example.com'],model:'fixture',apiKey:'fixture',baseURL:'https://example.com/v1',onEvidence:e=>events.push(e)});
  assert.deepEqual(result,{status:'completed',data:'Title'});assert.equal(browserModelUsage(events)?.requestAttempts,2);
});
