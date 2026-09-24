import { writeSync } from 'node:fs';
let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const { task } = JSON.parse(raw);
  if (task.goal === 'hang') { setInterval(() => {}, 1000); return; }
  if (task.goal === 'malformed') { writeSync(3, 'not json'); return; }
  if (task.goal === 'evidence') writeSync(4, JSON.stringify({kind:'browser-use-step',step:1,actions:[{navigate:{url:'https://example.com/'}}]})+'\n');
  if (task.goal === 'bad evidence') writeSync(4, 'not json\n');
  if (task.goal === 'usage') writeSync(4, JSON.stringify({kind:'browser-use-usage',requestAttempts:2,reportedInvocations:2,promptTokens:100,completionTokens:20,cachedPromptTokens:10,tokenCoverageComplete:true,costUSD:null})+'\n');
  console.log('Third-party logging is not the protocol.');
  writeSync(3, JSON.stringify({ status: 'completed', data: 'Title' }));
});
