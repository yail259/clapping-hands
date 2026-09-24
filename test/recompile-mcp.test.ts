import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskStore } from '../src/task-store.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

test('built MCP advertises offline recompilation and reports missing evidence without a model or browser',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'recompile-mcp-'));
  await new TaskStore(join(directory,'tasks')).save({formatVersion:'clapping-hands/task-v2',accelerator:null,
    definition:{action:'read_title',startUrl:'https://fixture.invalid/',goal:'Read title',effect:'read',
      inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},outputSchema:{type:'string'}}});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist-alpha/src/alpha-server.js')],
    env:{PATH:process.env.PATH??'',CLAPPING_HANDS_DATA_DIR:directory,CLAPPING_HANDS_BROWSER_USE_PYTHON:'/does-not-exist',
      CLAPPING_HANDS_CHROME_PATH:'/does-not-exist'},stderr:'pipe'});
  const client=new Client({name:'recompile-fixture',version:'1.0.0'});
  try{
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    assert.ok(tools.some(t=>t.name==='clapping_hands_recompile'));
    assert.ok(tools.find(t=>t.name==='clapping_hands_learn_read')!.inputSchema.properties?.allowedNetworkOrigins);
    const schema=tools.find(t=>t.name==='clapping_hands_do_read_title')!.outputSchema!;
    const validate=new AjvJsonSchemaValidator().getValidator(schema);
    const output={outcome:{status:'completed',data:'Title'},engine:'browser-use',durationMs:1,wallDurationMs:2,
      modelCalls:1,fallback:false,capturedResponses:1,evidence:{status:'saved',id:'fixture'},
      modelUsage:{requestAttempts:1,reportedInvocations:1,promptTokens:100,completionTokens:20,cachedPromptTokens:0,tokenCoverageComplete:true,costUSD:null}};
    assert.equal(validate(output).valid,true);
    assert.equal(validate({...output,modelUsage:{...output.modelUsage,secret:'must-not-pass'}}).valid,false);
    const result=await client.callTool({name:'clapping_hands_recompile',arguments:{action:'read_title'}});
    assert.notEqual(result.isError,true);
    assert.deepEqual(result.structuredContent,{status:'no-saved-compilation-evidence',browserRuns:0,existingTaskPreserved:true});
    const bad=await client.callTool({name:'clapping_hands_recompile',arguments:{action:'../private'}});
    assert.equal(bad.isError,true);
    assert.equal((bad.structuredContent as any).error.code,'invalid-action');
    assert.ok(!JSON.stringify(bad).includes('../private'));
    const missing=await client.callTool({name:'clapping_hands_recompile',arguments:{action:'missing_task'}});
    assert.equal(missing.isError,true);
    assert.equal((missing.structuredContent as any).error.code,'unknown-task');
  }finally{await client.close();await transport.close();}
});
