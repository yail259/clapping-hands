/** Production verification using retained demonstrations. Site selectors below
 * belong only to the independent oracle, never request discovery or compilation. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { saveEvidenceBundle } from '../src/evidence-bundle.js';
import { loadSavedJsonCapture } from '../src/saved-json-capture.js';
import { prepareJavaScriptCompilation, compilePreparedJavaScriptTask, replayJavaScriptTask } from '../src/javascript-task.js';
import { TaskStore, taskDefinitionSchema } from '../src/task-store.js';
import { TaskSession } from '../src/task-session.js';
import { recordCompiledComparison, degradeCompiledProgram } from '../src/compiled-program.js';

const apiOrigin='https://sik.search.blue.cdtapps.com',origin='https://www.ikea.com';
const directory=resolve(process.env.CLAPPING_HANDS_IKEA_VERIFY_DIR??'.data/integrated-production/ikea-'+Date.now());
await mkdir(directory,{recursive:true,mode:0o700});
const store=new TaskStore(resolve(directory,'tasks'));
const definition=taskDefinitionSchema.parse({...JSON.parse(await readFile('bench/runs/2026-09-07/alpha-ten-1788750873697-ikea.json','utf8')).definition,
  allowedNetworkOrigins:[apiOrigin]});
const ids=['1788788005876-9e5a8774-9a5e-44a1-8887-a606f51ef35e','1788788007069-91c93bb6-4d6d-4371-8692-aa9a51847d0b'];
const results:unknown[]=[];
const report={scope:'integrated JavaScript compiler from retained sanitized JSON evidence; deterministic browser oracle; no Browser Use demonstrations',
  passed:false,offlinePrepared:false,trainingCaptureIds:ids,results};
const checkpoint=()=>writeFile(resolve(directory,'acceptance.json'),JSON.stringify(report,null,2),{mode:0o600});
let session:TaskSession|undefined;
async function verify(){
try{
  let saved=await store.load(definition.action);
  if(saved && !isDeepStrictEqual(saved.definition,definition))throw new Error('Saved contract mismatch');
  if(saved && process.argv.includes('--prepare-only')){report.offlinePrepared=true;await checkpoint();return;}
  if(!saved){
    const traces=[],outputs=[];
    for(const id of ids){
      const restored=await loadSavedJsonCapture('.data/js-compilation/ikea',id);
      const capture=restored.capture as any;
      const exchanges=restored.exchanges;
      results.push({phase:'restored',captureId:id,exchanges:exchanges.length,refused:restored.refused,representation:restored.representation});
      const expected=load(capture.dom.data)('a[href*="/p/"] .plp-price-module__product-name').first().text().trim();
      if(!expected)throw new Error('Saved browser output unavailable');
      traces.push({input:capture.input,exchanges});outputs.push(expected);
    }
    const prepared=prepareJavaScriptCompilation(definition,traces,outputs,ids);if(!prepared)throw new Error('No admitted production resource');
    const evidence=await saveEvidenceBundle(resolve(directory,'evidence'),prepared);
    results.push({phase:'prepared',evidenceId:evidence.id,resources:prepared.resources.length});await checkpoint();
    report.offlinePrepared=true;
    if(process.argv.includes('--prepare-only')){await checkpoint();return;}
    const start=performance.now();
    const compiled=await compilePreparedJavaScriptTask(definition,prepared,resolve(directory,'evidence'));
    if(!compiled)throw new Error('Compiler declined');
    saved={formatVersion:'clapping-hands/task-v2',definition,accelerator:null,javascriptAccelerator:compiled,compilationEvidenceId:evidence.id};
    await store.save(saved);results.push({phase:'compiled',durationMs:performance.now()-start,sourceHash:compiled.program.sourceHash});await checkpoint();
    console.log(JSON.stringify({phase:'compiled',directory}));
  }
  for(const [index,query] of ['bookcase','chair','lamp'].entries()){
    if(!session || index===2){await session?.close();session=new TaskSession(origin,resolve(directory,'profile'),true,[apiOrigin]);await session.start();
      const request=session.context.request,fetch=request.fetch.bind(request);
      request.fetch=async(url,options)=>{
        const response=await fetch(url,options);
        const captured=await saveEvidenceBundle(resolve(directory,'evidence'),{kind:'integrated-network-response',url:response.url(),
          method:options?.method,requestBody:options?.data,responseStatus:response.status(),responseBody:(await response.body()).toString('utf8')});
        results.push({phase:'network-capture',evidenceId:captured.id});await checkpoint();return response;
      };
      saved=(await new TaskStore(resolve(directory,'tasks')).load(definition.action))!;}
    const task=saved.javascriptAccelerator!;
    try{
      const generated=await replayJavaScriptTask(session.context,definition,task,{query});
      const page=session.context.pages()[0]??await session.context.newPage(),oracleStart=performance.now();
      await page.goto(origin+'/au/en/search/?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded',timeout:30_000});
      const expected=(await page.locator('a[href*="/p/"] .plp-price-module__product-name').first().innerText({timeout:20_000})).trim();
      const exact=generated.value===expected;
      const evidence=await saveEvidenceBundle(resolve(directory,'evidence'),{kind:'integrated-production-comparison',input:{query},generated,expected,exact,dom:await page.content(),oracleMs:performance.now()-oracleStart});
      task.program=recordCompiledComparison(task.program,{query},generated.value,expected,definition.outputSchema,evidence.id);
      results.push({phase:'comparison',query,restarted:index===2,exact,engineMs:generated.durationMs,requests:generated.requests,modelCalls:0,status:task.program.status,evidenceId:evidence.id});
    }catch(error){task.program=degradeCompiledProgram(task.program);results.push({phase:'comparison',query,restarted:index===2,exact:false,category:error instanceof Error?error.name:'unknown'});}
    await store.save(saved);await checkpoint();console.log(JSON.stringify(results.at(-1)));
  }
  report.passed=results.filter((r:any)=>r.phase==='comparison').every((r:any)=>r.exact===true);
  await checkpoint();if(!report.passed)process.exitCode=1;
}catch(error){results.push({phase:'failure',category:error instanceof Error?error.name:'unknown'});await checkpoint();process.exitCode=1;}
finally{await session?.close();console.log(JSON.stringify({passed:report.passed,offlinePrepared:report.offlinePrepared,report:resolve(directory,'acceptance.json')}));}
}
await verify();
