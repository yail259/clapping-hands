/** Explicitly approved live test. Never automatically repeat a started phase. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory=resolve(process.env.CLAPPING_HANDS_SMOKE_DATA_DIR);
const entry=resolve(process.env.CLAPPING_HANDS_TEST_SERVER);
await mkdir(directory,{recursive:true,mode:0o700});
const file=resolve(directory,'acceptance.json');
let report;
try { report=JSON.parse(await readFile(file,'utf8')); }
catch(e) { if(e.code!=='ENOENT')throw e; report={site:'openlibrary',entry,directory,stages:[],passed:false}; }
const save=()=>writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
let client;
async function connect(models=true){
 const env=Object.fromEntries(Object.entries({...process.env,CLAPPING_HANDS_DATA_DIR:directory,...(!models?{CLAPPING_HANDS_CREDENTIAL_ENV_FILE:'/unavailable',CLAPPING_HANDS_BROWSER_USE_PYTHON:'/unavailable'}:{})}).filter(([,v])=>typeof v==='string'));
 client=new Client({name:'openlibrary-release-verification',version:'1.0.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[entry],env,stderr:'pipe'}));
}
async function phase(id,name,args){
 const old=report.stages.find(s=>s.id===id);
 if(old){if(old.state!=='returned')throw Error('Uncertain prior phase; inspect retained evidence');return old.data;}
 const stage={id,name,state:'started',startedAt:new Date().toISOString()}; report.stages.push(stage);await save();
 const start=performance.now();const result=await client.callTool({name,arguments:args},undefined,{timeout:540000});
 Object.assign(stage,{state:'returned',wallMs:performance.now()-start,isError:result.isError===true,data:result.structuredContent});await save();
 console.log(JSON.stringify({phase:id,isError:stage.isError,wallMs:stage.wallMs,registered:stage.data?.registered,compilation:stage.data?.javascriptCompilation,engine:stage.data?.engine,status:stage.data?.outcome?.status,shadowMatch:stage.data?.shadowMatch}));
 return stage.data;
}
const action='openlibrary_rich';
const str={type:'string'};
try{
 await connect();
 const learned=await phase('learn','clapping_hands_learn_read',{action,startUrl:'https://openlibrary.org/',goal:'Search the catalog for query using the website. Return the first five books in default order, with exact displayed title, authors as an array of names, first publication year as displayed (empty string if missing), and absolute book URL. Do not borrow books or use an API instead of the website.',inputSchema:{type:'object',properties:{query:str},required:['query'],additionalProperties:false},outputSchema:{type:'array',items:{type:'object',properties:{title:str,authors:{type:'array',items:str},year:str,url:str},required:['title','authors','year','url'],additionalProperties:false}},examples:[{query:'tolkien'},{query:'jane austen'}]});
 if(!learned?.registered)throw Error('Learning did not register');
 for(const query of ['dune','moby dick']){
  const r=await phase(query,'clapping_hands_do_'+action,{query});
  if(r?.outcome?.status!=='completed')throw Error('Held-out task failed');
 }
 await client.close();await connect(false);
 const r=await phase('restart','clapping_hands_do_'+action,{query:'sherlock holmes'});
 report.passed=r?.outcome?.status==='completed'&&r.engine==='network'&&r.modelCalls===0&&report.stages.filter(s=>['dune','moby dick'].includes(s.id)).every(s=>s.data?.shadowMatch===true);
 await save();
}catch(e){report.failureCategory=e.name;await save();process.exitCode=1;}
finally{await client?.close();console.log(JSON.stringify({passed:report.passed,report:file}));}
