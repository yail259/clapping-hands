import {resolve} from 'node:path';
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

type Example={input:JsonValue;observed:RecordedDemonstration};
type Active={recording:CallerRecording;previous:SavedTask|null;purpose:'learn'|'validate';actual?:JsonValue;executionFailed:boolean};

/** Model-free orchestration. Runtime serializes public calls; a recording reserves
 * its owned profile across MCP requests. Caller outputs are observations, not
 * authority to promote or to change a persisted contract. */
export class CallerLearning{
 private active:Active|undefined;
 private recent:{action:string;example:Example}|undefined;
 constructor(private readonly store:TaskStore,private readonly directory:string,
   private readonly profile:(origin:string)=>string,private readonly signal:AbortSignal){}
 get hasRecording(){return !!this.active;}
 async start(definitionInput:TaskDefinition,input:JsonValue,purpose:'learn'|'validate',headless=false){
  if(this.active)throw new TaskError('runtime-busy');
  const definition=taskDefinitionSchema.parse(definitionInput);
  assertResponseValue(definition.inputSchema,input);
  const previous=await this.store.load(definition.action);
  if(previous&&!isDeepStrictEqual(previous.definition,definition))throw new TaskError('incompatible-evidence');
  if(purpose==='learn'&&previous?.callerEvidenceIds?.length===2)throw new TaskError('task-exists');
  const candidate=previous?.pendingJavascriptAccelerator??previous?.javascriptAccelerator;
  if(purpose==='validate'&&(!candidate||candidate.program.status!=='candidate'))throw new TaskError('incompatible-evidence');
  const recording=await CallerRecording.start(definition,input,this.directory,this.profile(new URL(definition.startUrl).origin),this.signal,{headless});
  const active:Active={recording,previous,purpose,executionFailed:false};this.active=active;
  try{
   if(purpose==='validate'){
    try{active.actual=(await recording.session.network.withoutReplayEvidence(()=>replayJavaScriptTask(recording.session.context,definition,candidate!,input,this.signal))).value;}
    catch{active.executionFailed=true;}
   }
   return {...recording.connection(),purpose,modelCalls:0};
  }catch(error){await this.cancel(recording.id);throw error;}
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
      first={input:raw.input,observed:{outcome:raw.outcome,exchanges:restored.exchanges,html:[],pages:[],evidence:{status:'saved',id:ids[0]!},modelUsage:undefined,durationMs:0}};
    }catch{/* Keep evidence; never manufacture lost HTML provenance. */}
   }
   preparation='no-admitted-resources';
   if(first){
    const examples=[first,{input,observed}];
    const traces=examples.map(e=>({input:e.input,exchanges:e.observed.exchanges})) as GenericNetworkTrace[];
    const outputs=examples.map(e=>e.observed.outcome.status==='completed'?e.observed.outcome.data:null);
    const prepared=prepareJavaScriptCompilation(definition,traces,outputs,ids,examples.map(e=>e.observed.html));
    if(prepared){const bundle=await saveEvidenceBundle(resolve(this.directory,'evidence'),prepared);saved.compilationEvidenceId=bundle.id;preparation='ready';}
   }
  }
  await this.store.save(saved,previous);
  this.recent=ids.length===1?{action:definition.action,example:{input,observed}}:undefined;
  return {status:'registered' as const,action:definition.action,outcome:observed.outcome,evidence:observed.evidence,preparation,modelCalls:0};
 }
}
