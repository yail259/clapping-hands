import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const [directory, action, encodedInput, encodedExpected] = process.argv.slice(2);
if (!directory || !action || !encodedInput || !encodedExpected) throw new Error('Supply benchmark task directory, action, input and expected JSON.');
const entry = process.env.CLAPPING_HANDS_TEST_SERVER ?? resolve('dist-alpha/src/alpha-server.js');
for (let restart = 0; restart < 2; restart++) {
  const client = new Client({ name: 'page-replay-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry],
    env: { PATH: process.env.PATH ?? '', CLAPPING_HANDS_DATA_DIR: directory }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(t => t.name === 'clapping_hands_do_'+action);
    assert.ok(tool?.outputSchema);
    const result = await client.callTool({ name: tool.name, arguments: JSON.parse(encodedInput) }, undefined, { timeout: 60000 });
    assert.notEqual(result.isError, true);
    const data = result.structuredContent as any;
    assert.equal(data.engine, 'browser-replay'); assert.equal(data.modelCalls, 0);
    assert.deepEqual(data.outcome, { status: 'completed', data: JSON.parse(encodedExpected) });
    console.log(JSON.stringify({ passed: true, restart, engine: data.engine, durationMs: data.durationMs, modelCredentialsSupplied: false }));
  } finally { await client.close(); }
}
