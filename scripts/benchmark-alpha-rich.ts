import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskRuntime } from '../src/task-runtime.js';
import type { TaskDefinition } from '../src/task-store.js';
import type { JsonValue } from '../src/response-contract.js';

const string = { type: 'string' as const };
const object = (properties: Record<string, any>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false as const });
const list = (properties: Record<string, any>) => ({ type: 'array' as const, items: object(properties) });
const cases: {id:string; url:string; goal:string; output:any; inputs:JsonValue[]}[] = [
  { id:'openlibrary', url:'https://openlibrary.org/', goal:'Search the catalog for query using the website. Return the first five books in default order, with exact displayed title, authors as an array of names, first publication year as displayed (empty string if missing), and absolute book URL. Do not borrow books or use an API instead of the website.', output:list({title:string,authors:{type:'array',items:string},year:string,url:string}), inputs:['tolkien','jane austen','dune','moby dick','sherlock holmes'].map(query=>({query})) },
  { id:'tender', url:'https://www.find-tender.service.gov.uk/Search', goal:'Search notices for query. Return the first five results in the default order with exact title, buyer name, closing date as displayed (empty string when absent), and absolute notice URL. Do not register, submit, or contact anyone.', output:list({title:string,buyer:string,closingDate:string,url:string}), inputs:['software','cleaning','catering','construction','transport'].map(query=>({query})) },
  { id:'marketplace', url:'https://www.facebook.com/marketplace/sydney/', goal:'Search Sydney Marketplace for query using existing login. Return the first five non-sponsored listings with exact displayed title, current asking price only (exclude every crossed-out or previous price; preserve the displayed currency prefix; use Free when displayed), and canonical absolute listing URL without tracking query parameters. Do not message, save, buy or contact sellers. If login is required report authentication required.', output:{...list({title:string,price:string,url:string}),minItems:5,maxItems:5}, inputs:['sofa bed','double sofa bed','fold out sofa bed','single sofa bed','futon sofa bed'].map(query=>({query})) },
  { id:'transport', url:'https://transportnsw.info/trip', goal:'Plan a public transport journey between the supplied Sydney stations, departing today at departureTime (Sydney local time). Select matching station suggestions and set the departure time. Open the first suggested journey. Return its displayed total duration and each leg in order with mode, origin and destination exactly as displayed. Do not use an external planner.', output:object({duration:string,legs:list({mode:string,origin:string,destination:string})}), inputs:[{origin:'Central Station',destination:'Town Hall Station',departureTime:'18:00'},{origin:'Central Station',destination:'Redfern Station',departureTime:'18:30'},{origin:'Wynyard Station',destination:'Circular Quay Station',departureTime:'19:00'},{origin:'Town Hall Station',destination:'North Sydney Station',departureTime:'19:30'},{origin:'Redfern Station',destination:'Wynyard Station',departureTime:'20:00'}] },
];
const selected = (process.env.CLAPPING_HANDS_BENCH_SITES ?? 'openlibrary,tender,transport').split(',');
if(selected.some(id=>!cases.some(c=>c.id===id))) throw new Error('Unknown site');
const root=await mkdtemp(join(tmpdir(),'clappinghands-rich-'));
const reports=resolve('bench/runs',new Date().toISOString().slice(0,10)); await mkdir(reports,{recursive:true});
const runId=Date.now();
console.log(JSON.stringify({runId,root,selected}));
async function run(c:typeof cases[number]) {
  const directory=join(root,c.id); let runtime=new TaskRuntime(directory);
  const definition:TaskDefinition={action:c.id+'_rich',startUrl:c.url,goal:c.goal,effect:'read',inputSchema:object(Object.fromEntries(Object.keys(c.inputs[0] as object).map(k=>[k,string]))),outputSchema:c.output};
  const row:any={site:c.id,directory,definition,inputs:c.inputs,learning:null,calls:[],phase:'learning',version:'0.1.0-alpha.3'};
  const file=join(reports,`alpha-rich-${runId}-${c.id}.json`);
  const save=()=>writeFile(file,JSON.stringify(row,null,2),{mode:0o600});
  try {
    const start=performance.now(); const learned=await runtime.learn(definition,c.inputs.slice(0,2));
    row.learning={executions:learned.executions,registered:learned.registered,compilation:learned.compilation,pageDiagnostics:learned.pageDiagnostics,wallMs:performance.now()-start};
    await save(); console.log(JSON.stringify({site:c.id,phase:'learning',registered:learned.registered,statuses:learned.executions.map(e=>e.outcome.status),diagnostics:learned.compilation,page:learned.pageDiagnostics}));
    if(learned.registered) for(const index of [2,3,4,4,4]) {
      if(index===3 || index===4) {await runtime.close(); runtime=new TaskRuntime(directory);}
      row.phase=index<4?'held-out':'restart-repeat'; const start=performance.now();
      const result=await runtime.run(definition.action,c.inputs[index]!);
      row.calls.push({input:c.inputs[index],phase:row.phase,result,wallMs:performance.now()-start});
      await save(); console.log(JSON.stringify({site:c.id,phase:row.phase,status:result.outcome.status,engine:result.engine,shadow:result.shadowMatch}));
      if(result.outcome.status!=='completed') break;
    }
    const saved=await runtime.store.load(definition.action);
    row.finalCompilation=saved?.accelerator?.plan.status??'unavailable'; row.finalPageCompilation=saved?.pageAccelerator?.status??'unavailable'; row.finished=true;
  } catch(e) {row.error={phase:row.phase,category:e instanceof Error?e.name:'unknown'};}
  finally {await runtime.close(); await save();}
  console.log(JSON.stringify({site:c.id,report:file,finished:row.finished,compilation:row.finalCompilation}));
}
const pending=cases.filter(c=>selected.includes(c.id));
await Promise.all([0,1].map(async()=>{for(;;){const c=pending.shift();if(!c)return;await run(c);}}));
