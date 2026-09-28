import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CallerRecording,type RecordedDemonstration} from './caller-recording.js';
import {TaskStore,taskDefinitionSchema,type TaskDefinition,type SavedTask} from './task-store.js';
import {TaskError} from './task-error.js';
import {assertResponseValue,type JsonValue} from './response-contract.js';
import {prepareJavaScriptCompilation,replayJavaScriptTask} from './javascript-task.js';
import {saveEvidenceBundle} from './evidence-bundle.js';
import {recordCompiledComparison,degradeCompiledProgram} from './compiled-program.js';
import {loadSavedJsonCapture} from './saved-json-capture.js';
import type {GenericNetworkTrace} from './generic-network.js';
import {compilePageReplay,replayPage,recordPageShadow,stablePageReplay} from './page-replay.js';
import {standaloneBrowserSessionProvider,type BrowserSessionProvider} from './browser-session-provider.js';
import { compileInlineJsonFromDemonstrations } from './inline-json-learning.js';
import { recordInlineJsonComparison, replayInlineJsonDocument } from './inline-json-projection.js';
import { compileRouteJsonFromDemonstrations } from './route-json-learning.js';
import {captureGenericRequestContext,replayGenericJsonPlan,recordGenericJsonShadow,isStableGenericJsonPlan,type GenericReplayStage} from './generic-network.js';
import {RequestContextVault} from './request-context.js';
import {captureBrowserNetworkDocument,disposeBrowserNetworkDocument} from './browser-network-transport.js';
import {jsonRecordsAsInlineDocument} from './guarded-json-sequence.js';
import {replayInlineJsonProjection,materializeInlineJsonUrl} from './inline-json-projection.js';
import {randomUUID} from 'node:crypto';

type Example={input:JsonValue;observed:RecordedDemonstration};
type Purpose='learn'|'validate'|'validate-page'|'validate-inline-json'|'validate-route-json';
type Active={recording:CallerRecording;previous:SavedTask|null;purpose:Purpose;actual?:JsonValue;executionFailed:boolean;seedInput?:JsonValue};

/** Model-free orchestration. Runtime serializes public calls; a recording reserves
 * its owned profile across MCP requests. Caller outputs are observations, not
 * authority to promote or to change a persisted contract. */
export class CallerLearning{
 private active:Active|undefined;
 private recent:{action:string;example:Example}|undefined;
 constructor(private readonly store:TaskStore,private readonly directory:string,
   private readonly profile:(origin:string)=>string,private readonly signal:AbortSignal,
   private readonly browserSessions:BrowserSessionProvider=standaloneBrowserSessionProvider){}
 get hasRecording(){return !!this.active;}
 async start(definitionInput:TaskDefinition,input:JsonValue,purpose:Purpose,headless=false){
  if(this.active){
   try{this.active.recording.connection();throw new TaskError('runtime-busy');}
   catch(error){
    if(error instanceof TaskError)throw error;
    await this.active.recording.cancel();this.active=undefined;
   }
  }
  const definition=taskDefinitionSchema.parse(definitionInput);
  if(this.browserSessions.callerAttachment!=='cdp')throw new TaskError('caller-attachment-unsupported');
  assertResponseValue(definition.inputSchema,input);
  const previous=await this.store.load(definition.action);
  if(previous&&!isDeepStrictEqual(previous.definition,definition))throw new TaskError('incompatible-evidence');
  if(purpose==='learn'&&previous?.callerEvidenceIds?.length===2)throw new TaskError('task-exists');
  const candidate=previous?.pendingJavascriptAccelerator??previous?.javascriptAccelerator;
  if(purpose==='validate'&&(!candidate||candidate.program.status!=='candidate'))throw new TaskError('incompatible-evidence');
  if(purpose==='validate-page'&&(!previous?.pageAccelerator||previous.pageAccelerator.status==='degraded'||stablePageReplay(previous.pageAccelerator)))throw new TaskError('incompatible-evidence');
  if(purpose==='validate-inline-json'&&(!previous?.inlineJsonAccelerator||previous.inlineJsonAccelerator.status!=='candidate'))throw new TaskError('incompatible-evidence');
  if(purpose==='validate-route-json'&&(!previous?.routeJsonAccelerator||previous.routeJsonAccelerator.status!=='candidate'))throw new TaskError('incompatible-evidence');
  const recording=await CallerRecording.start(definition,input,this.directory,this.profile(new URL(definition.startUrl).origin),this.signal,{headless,
   sessionFactory:(_definition,profile,requestedHeadless)=>this.browserSessions.createSession({definition,profile,headless:requestedHeadless})});
  const active:Active={recording,previous,purpose,executionFailed:false};this.active=active;
  try{
   if(purpose==='validate'){
    try{active.actual=(await recording.session.network.withoutReplayEvidence(()=>replayJavaScriptTask(recording.session.context,definition,candidate!,input,this.signal))).value;}
    catch{active.executionFailed=true;}
   }else if(purpose==='validate-page'){
    try{active.actual=(await recording.session.network.withoutReplayEvidence(()=>replayPage(recording.session.context,previous!.pageAccelerator!,input,this.signal))).data as JsonValue;}
    catch{active.executionFailed=true;}
   }else if(purpose==='validate-inline-json'){
    try{active.actual=(await recording.session.network.withoutReplayEvidence(()=>replayInlineJsonDocument(
     recording.session.context,previous!.inlineJsonAccelerator!,input as Record<string,unknown>,this.signal))).data;}
    catch{active.executionFailed=true;}
   }
   return {...recording.connection(),purpose,modelCalls:0};
  }catch(error){await this.cancel(recording.id);throw error;}
 }
 /** The caller has navigated normally and supplies the input of a different,
  * freshly observed seed request. No request values leave this process. */
 async replayRouteCandidate(id:string,seedInput:JsonValue){
  const active=this.active;
  if(!active||active.recording.id!==id||active.purpose!=='validate-route-json'||active.actual!==undefined)
   throw new TaskError('incompatible-evidence');
  active.recording.connection();
  const {recording,previous}=active,plan=previous!.routeJsonAccelerator!;
  assertResponseValue(recording.definition.inputSchema,seedInput);
  if(isDeepStrictEqual(seedInput,recording.input))throw new TaskError('incompatible-evidence');
  const session=recording.session;
  await session.network.flush(5000).catch(()=>{});
  const endpoint=plan.request.request.endpointPath;
  const sources=session.network.latest().slice().reverse().flatMap(exchange=>{
   if(exchange.method!==plan.request.request.method||new URL(exchange.url).pathname!==endpoint)return [];
   const provenance=session.network.sourceSince(exchange,recording.networkMark);
   return provenance&&performance.now()-provenance.startedAt<=30_000?[{exchange,page:provenance.page}]:[];
  });
  let source:(typeof sources)[number]|undefined,context:ReturnType<typeof captureGenericRequestContext>|undefined;
  const vault=new RequestContextVault();let lease:Awaited<ReturnType<typeof captureBrowserNetworkDocument>>|undefined;
  for(const candidate of sources){
   try{
    const document=await captureBrowserNetworkDocument(session.context,candidate.page);
    try{context=captureGenericRequestContext(session.context,plan.request,candidate.exchange,
      seedInput as Record<string,string|number|boolean>,randomUUID(),vault);source=candidate;lease=document;break}
    catch{await disposeBrowserNetworkDocument(document)}
   }catch{/* A detached or changed page cannot seed replay. */}
  }
  if(!source||!context||!lease)return {status:'seed-unavailable' as const,modelCalls:0};
  let stage:GenericReplayStage|'projection'='plan-validation';
  try{
   context.browserTransport={page:source.page,document:lease};
   const result=await session.network.withoutReplayEvidence(()=>replayGenericJsonPlan(session.context,plan.request,
    recording.input as Record<string,string|number|boolean>,context,step=>{stage=step}));
   stage='projection';
   const name=plan.projection.inputName,value=(recording.input as Record<string,unknown>)[name];
   if(typeof value!=='string')throw new Error('Route candidate input refused.');
   const projected=replayInlineJsonProjection(jsonRecordsAsInlineDocument(result.data),value,plan.projection);
   assertResponseValue(recording.definition.outputSchema,projected);
   active.actual=projected;
   active.executionFailed=false;
   active.seedInput=structuredClone(seedInput);
   return {status:'candidate-replay' as const,outcome:{status:'completed' as const,data:projected},durationMs:result.durationMs,modelCalls:0};
  }catch{active.executionFailed=true;return {status:'candidate-replay-failed' as const,stage,modelCalls:0};}
  finally{await disposeBrowserNetworkDocument(lease);vault.clear()}
 }
 async cancel(id?:string){
  if(!this.active){if(id)throw new TaskError('incompatible-evidence');return;}
  if(id&&this.active.recording.id!==id)throw new TaskError('incompatible-evidence');
  const active=this.active;
  await active.recording.cancel();this.active=undefined;
 }
 async finish(id:string,outcome:unknown){
  const active=this.active;if(!active||active.recording.id!==id)throw new TaskError('incompatible-evidence');
  const {recording,previous,purpose}=active;
  // Invalid submissions leave the recording available for correction.
  const observed=await recording.finish(outcome);this.active=undefined;
  const definition=recording.definition,input=recording.input;
  if(observed.evidence.status!=='saved')return {status:'evidence-unavailable' as const,action:definition.action,outcome:observed.outcome,modelCalls:0};
  if(purpose==='validate-page'){
   const saved=structuredClone(previous!);let match=false;
   if(saved.pageAccelerator){
    match=!active.executionFailed&&observed.outcome.status==='completed'&&isDeepStrictEqual(active.actual,observed.outcome.data);
    saved.pageAccelerator=recordPageShadow(saved.pageAccelerator,input,match);
   }
   await this.store.save(saved,previous);
   return {status:'page-comparison' as const,action:definition.action,outcome:observed.outcome,match,
    pageStatus:saved.pageAccelerator?.status??'unavailable',evidence:observed.evidence,modelCalls:0};
  }
  if(purpose==='validate-inline-json'){
   const saved=structuredClone(previous!),plan=saved.inlineJsonAccelerator!;
   const inputValue=(input as Record<string,unknown>)[plan.inputName] as string;
   let match:boolean|null=null,reason:string|undefined;
   if(active.executionFailed){saved.inlineJsonAccelerator=recordInlineJsonComparison(plan,inputValue,false);reason='candidate-replay-failed';}
   else if(observed.outcome.status!=='completed')reason='caller-observation-incomplete';
   else{
    const fields=Object.keys(plan.fields);
    const visibleEvidence=observed.pages.some(page=>fields.every(field=>Array.isArray(page.fields?.[field])&&page.fields[field]!.length>0));
    if(!visibleEvidence)reason='full-output-not-visible-in-caller-page';
    else{
     const actual=active.actual as Record<string,string>,expected=observed.outcome.data as Record<string,string>;
     const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();
     match=fields.every(field=>normalized(actual[field]??'')===normalized(expected[field]??''));
     if(match){
      try{
       await saveEvidenceBundle(resolve(this.directory,'evidence'),{kind:'inline-json-comparison',action:definition.action,
        inputHash:createHash('sha256').update(inputValue).digest('hex'),
        actual,expected,baselineEvidenceId:observed.evidence.id,match:true});
       saved.inlineJsonAccelerator=recordInlineJsonComparison(plan,inputValue,true);
      }catch{match=null;reason='comparison-evidence-unavailable';}
     }else saved.inlineJsonAccelerator=recordInlineJsonComparison(plan,inputValue,false);
    }
   }
   await this.store.save(saved,previous);
   return {status:'inline-json-comparison' as const,action:definition.action,outcome:observed.outcome,match,
    reason,programStatus:saved.inlineJsonAccelerator?.status??'unavailable',evidence:observed.evidence,modelCalls:0};
  }
  if(purpose==='validate-route-json'){
   const saved=structuredClone(previous!),plan=saved.routeJsonAccelerator!;
   const inputValue=(input as Record<string,unknown>)[plan.projection.inputName] as string;
   let match:boolean|null=null,reason:string|undefined;
   if(active.executionFailed){
    plan.request=recordGenericJsonShadow(plan.request,input as Record<string,string|number|boolean>,false);
    plan.projection=recordInlineJsonComparison(plan.projection,inputValue,false);
    plan.status='degraded';reason='candidate-replay-failed';
   }else if(active.actual===undefined)reason='candidate-not-replayed';
   else if(observed.outcome.status!=='completed')reason='caller-observation-incomplete';
   else{
    const fields=Object.keys(plan.projection.fields),expectedUrl=materializeInlineJsonUrl(plan.projection,inputValue);
    const visibleEvidence=observed.pages.some(page=>{
     try{return new URL(page.url).origin===new URL(expectedUrl).origin&&new URL(page.url).pathname===new URL(expectedUrl).pathname&&
       fields.every(field=>Array.isArray(page.fields?.[field])&&page.fields[field]!.length>0)}catch{return false}
    });
    if(!visibleEvidence)reason='full-output-not-visible-in-caller-page';
    else{
     const actual=active.actual as Record<string,string>,expected=observed.outcome.data as Record<string,string>;
     const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();
     match=fields.every(field=>normalized(actual[field]??'')===normalized(expected[field]??''));
     if(match){
      try{await saveEvidenceBundle(resolve(this.directory,'evidence'),{kind:'route-json-comparison',action:definition.action,
       inputHash:createHash('sha256').update(inputValue).digest('hex'),seedInputHash:createHash('sha256').update(JSON.stringify(active.seedInput)).digest('hex'),
       actual,expected,baselineEvidenceId:observed.evidence.id,match:true});
       plan.projection=recordInlineJsonComparison(plan.projection,inputValue,true);
       plan.request=recordGenericJsonShadow(plan.request,input as Record<string,string|number|boolean>,true);
       plan.status=plan.projection.status==='stable'&&isStableGenericJsonPlan(plan.request)?'stable':'candidate';
      }catch{match=null;reason='comparison-evidence-unavailable'}
     }else{
      plan.projection=recordInlineJsonComparison(plan.projection,inputValue,false);
      plan.request=recordGenericJsonShadow(plan.request,input as Record<string,string|number|boolean>,false);
      plan.status='degraded';
     }
    }
   }
   saved.routeJsonAccelerator=plan;
   await this.store.save(saved,previous);
   return {status:'route-json-comparison' as const,action:definition.action,outcome:observed.outcome,match,reason,
    programStatus:plan.status,evidence:observed.evidence,modelCalls:0};
  }
  if(purpose==='validate'){
   const saved=structuredClone(previous!);
   const pending=!!saved.pendingJavascriptAccelerator;
   const candidate=saved.pendingJavascriptAccelerator??saved.javascriptAccelerator!;
   let match=false;
   if(active.executionFailed)candidate.program=degradeCompiledProgram(candidate.program);
   else if(observed.outcome.status==='completed'){
    match=isDeepStrictEqual(active.actual,observed.outcome.data);
    const comparison=await saveEvidenceBundle(resolve(this.directory,'evidence'),{kind:'javascript-comparison',
      sourceHash:candidate.program.sourceHash,input,actual:active.actual,expected:observed.outcome.data,
      baselineEvidenceId:observed.evidence.id,match,baselineProvider:'caller'});
    candidate.program=recordCompiledComparison(candidate.program,input,active.actual,observed.outcome.data,definition.outputSchema,comparison.id);
   }
   if(pending&&candidate.program.status==='stable'){saved.javascriptAccelerator=candidate;delete saved.pendingJavascriptAccelerator;}
   else if(pending&&candidate.program.status==='degraded')delete saved.pendingJavascriptAccelerator;
   await this.store.save(saved,previous);
   return {status:'comparison' as const,action:definition.action,outcome:observed.outcome,match,programStatus:candidate.program.status,evidence:observed.evidence,modelCalls:0};
  }
  if(observed.outcome.status!=='completed')return {status:'not-completed' as const,action:definition.action,outcome:observed.outcome,evidence:observed.evidence,modelCalls:0};
  const saved:SavedTask=previous?structuredClone(previous):{formatVersion:'clapping-hands/task-v2',definition,accelerator:null,executionPolicy:'return-control'};
  const ids=[...(saved.callerEvidenceIds??[]),observed.evidence.id];
  saved.callerEvidenceIds=ids;
  let preparation='one-demonstration';
  if(ids.length===2){
   let first:Example|undefined=this.recent?.action===definition.action?this.recent.example:undefined;
   if(!first){
    try{
     const restored=await loadSavedJsonCapture(resolve(this.directory,'evidence'),ids[0]!);
     const raw=restored.capture as any;
     if(raw.provenance==='caller-baseline'&&isDeepStrictEqual(raw.definition,definition)&&raw.outcome?.status==='completed')
      first={input:raw.input,observed:{outcome:raw.outcome,exchanges:restored.exchanges,html:[],pages:Array.isArray(raw.pages)?raw.pages:[],evidence:{status:'saved',id:ids[0]!},modelUsage:undefined,durationMs:0}};
    }catch{/* Keep evidence; never manufacture lost HTML provenance. */}
   }
   preparation='no-admitted-resources';
   if(first){
    const examples=[first,{input,observed}];
    const traces=examples.map(e=>({input:e.input,exchanges:e.observed.exchanges})) as GenericNetworkTrace[];
    const outputs=examples.map(e=>e.observed.outcome.status==='completed'?e.observed.outcome.data:null);
    const prepared=prepareJavaScriptCompilation(definition,traces,outputs,ids,examples.map(e=>e.observed.html));
    if(prepared){const bundle=await saveEvidenceBundle(resolve(this.directory,'evidence'),prepared);saved.compilationEvidenceId=bundle.id;preparation='ready';}
    const inputSchema=definition.inputSchema;
    const onlyInput=inputSchema.type==='object'?Object.keys(inputSchema.properties??{})[0]:undefined;
    const inputSupported=inputSchema.type==='object'&&!!onlyInput&&Object.keys(inputSchema.properties??{}).length===1
     &&inputSchema.properties?.[onlyInput]?.type==='string'&&inputSchema.required?.length===1&&inputSchema.required[0]===onlyInput;
    const pagePlan=inputSupported?compilePageReplay(new URL(definition.startUrl).origin,examples.map(e=>e.input),examples.map(e=>e.observed.pages),definition.outputSchema):null;
    if(pagePlan)saved.pageAccelerator=pagePlan;
    const inlinePlan=compileInlineJsonFromDemonstrations(definition,examples.map(e=>({input:e.input,
     outcome:e.observed.outcome,exchanges:e.observed.exchanges})) as [
       {input:JsonValue;outcome:RecordedDemonstration['outcome'];exchanges:RecordedDemonstration['exchanges']},
       {input:JsonValue;outcome:RecordedDemonstration['outcome'];exchanges:RecordedDemonstration['exchanges']},
     ]);
    if(inlinePlan)saved.inlineJsonAccelerator=inlinePlan;
    const routePlan=compileRouteJsonFromDemonstrations(definition,examples.map(e=>({input:e.input,
     outcome:e.observed.outcome,exchanges:e.observed.exchanges})) as [
       {input:JsonValue;outcome:RecordedDemonstration['outcome'];exchanges:RecordedDemonstration['exchanges']},
       {input:JsonValue;outcome:RecordedDemonstration['outcome'];exchanges:RecordedDemonstration['exchanges']},
     ], process.env.CLAPPING_HANDS_DEBUG_ROUTE === '1' ? stage => process.stderr.write(`[route audit] ${stage}\n`) : undefined);
    if(routePlan)saved.routeJsonAccelerator=routePlan;
   }
  }
  await this.store.save(saved,previous);
  this.recent=ids.length===1?{action:definition.action,example:{input,observed}}:undefined;
  return {status:'registered' as const,action:definition.action,outcome:observed.outcome,evidence:observed.evidence,preparation,
   pageCompilation:saved.pageAccelerator?.status??'unavailable',inlineJsonCompilation:saved.inlineJsonAccelerator?.status??'unavailable',
   routeJsonCompilation:saved.routeJsonAccelerator?.status??'unavailable',modelCalls:0};
 }
}
