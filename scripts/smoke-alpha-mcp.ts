import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixture = createServer((_req, res) => { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><html><body><h1>Verified fixture title</h1></body></html>'); });
await new Promise<void>(r => fixture.listen(0,'127.0.0.1',r));
const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('fixture address');
const root=resolve('.data/release-smokes');await mkdir(root,{recursive:true,mode:0o700});
const data = await mkdtemp(join(root,'model-usage-'));
const report:{passed:boolean;scope:string;stages:unknown[]}={passed:false,scope:'controlled built MCP browser usage, not packaged release signoff',stages:[]};
const checkpoint=()=>writeFile(join(data,'acceptance.json'),JSON.stringify(report,null,2),{mode:0o600});
const entry = process.env.CLAPPING_HANDS_TEST_SERVER ?? resolve('dist-alpha/src/alpha-server.js');
const env = Object.fromEntries(Object.entries({ ...process.env, CLAPPING_HANDS_DATA_DIR: data }).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'pipe' });
  const client = new Client({ name: 'alpha-acceptance', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
let client: Client | undefined;
try {
  client = await connect();
  const learned = await client.callTool({ name:'clapping_hands_learn_read', arguments: {
    action:'fixture_title', startUrl:'http://127.0.0.1:'+address.port+'/', goal:'Return the exact main heading text.',
    inputSchema:{ type:'object',properties:{},required:[],additionalProperties:false }, outputSchema:{ type:'string' }, examples:[{}],
  } }, undefined, { timeout: 240_000 });
  report.stages.push({phase:'learn',result:learned});await checkpoint();
  assert.notEqual(learned.isError,true);
  let tool = (await client.listTools()).tools.find(t=>t.name==='clapping_hands_do_fixture_title');
  assert.ok(tool?.outputSchema);
  const result = await client.callTool({ name:'clapping_hands_do_fixture_title',arguments:{} }, undefined, { timeout:240_000 });
  report.stages.push({phase:'call',result});await checkpoint();
  assert.notEqual(result.isError,true);
  assert.deepEqual((result.structuredContent as any)?.outcome, { status:'completed',data:'Verified fixture title' });
  const measured=result.structuredContent as any;
  assert.ok(measured.modelCalls>0);assert.equal(measured.modelCalls,measured.modelUsage.requestAttempts);
  assert.equal(measured.modelUsage.costUSD,null);
  await client.close(); client=await connect();
  tool=(await client.listTools()).tools.find(t=>t.name==='clapping_hands_do_fixture_title');
  assert.ok(tool?.outputSchema);
  report.passed=true;await checkpoint();
  console.log(JSON.stringify({ passed:true, learnedWithoutRecipe:true, generatedToolCalled:true, schemasRestoredAfterMcpRestart:true,
    modelUsage:measured.modelUsage,report:join(data,'acceptance.json') }));
} catch(error) { report.stages.push({phase:'failure',category:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'});await checkpoint();console.log(JSON.stringify({ passed:false,category:error instanceof Error?error.name:'unknown',report:join(data,'acceptance.json') })); process.exitCode=1; }
finally { await client?.close(); fixture.closeAllConnections(); await new Promise<void>(r=>fixture.close(()=>r())); }
