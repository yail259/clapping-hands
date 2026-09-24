/** Explicit human login handoff through an installed MCP candidate. No secrets logged. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const directory=resolve(process.env.CLAPPING_HANDS_SMOKE_DATA_DIR);
const entry=resolve(process.env.CLAPPING_HANDS_TEST_SERVER);
await mkdir(directory,{recursive:true,mode:0o700});
const env=Object.fromEntries(Object.entries({...process.env,CLAPPING_HANDS_DATA_DIR:directory}).filter(([,v])=>typeof v==='string'));
delete env.CLAPPING_HANDS_AUTH_PROFILE_DIR;
delete env.CLAPPING_HANDS_AUTH_PROFILE_ORIGIN;
const client=new Client({name:'release-authentication',version:'1.0.0'});
const report={entry,directory,startedAt:new Date().toISOString(),state:'started',authenticated:'not-asserted'};
const file=resolve(directory,'authentication.json');
const save=()=>writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
await save();
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[entry],env,stderr:'pipe'}));
 console.log(JSON.stringify({phase:'opening-manual-login',directory}));
 const result=await client.callTool({name:'clapping_hands_authenticate',arguments:{startUrl:'https://www.facebook.com/marketplace/sydney/'}},undefined,{timeout:360000});
 report.state='returned';report.isError=result.isError===true;
 report.result=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
 console.log(JSON.stringify({phase:'handoff-returned',isError:report.isError,result:report.result}));
}catch(e){report.state='failed';report.failureCategory=e.name;process.exitCode=1;}
finally{await client.close();await save();}
