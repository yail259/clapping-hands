import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import type { TaskDefinition } from './task-store.js';
import { assertGenericJsonPlanSafety, compileGenericJsonCandidatesFromTraces, compileGenericJsonPlan, replayGenericJsonPlan, compileObservedJsonResources,
  type GenericJsonPlan, type GenericNetworkTrace } from './generic-network.js';
import { decodeGenericCapturedResponse } from './network-response.js';
import { compiledProgramSchema, createCompiledProgram, executeCompiledProgram, programDigest } from './compiled-program.js';
import { proposeJavaScript } from './javascript-compiler.js';
import { sanitizeEvidence } from './evidence-bundle.js';
import { assertResponseValue, type JsonValue } from './response-contract.js';
import { isDeepStrictEqual } from 'node:util';
import type { HtmlEvidence } from './html-evidence.js';
import { materializeRequestPath } from './request-path.js';
import { authorizedNetworkOrigins, assertTaskResourceScope } from './task-network-scope.js';

const planSchema=z.custom<GenericJsonPlan>(value=>{try{assertGenericJsonPlanSafety(value as GenericJsonPlan);return true;}catch{return false;}});
export const javascriptTaskSchema=z.object({
  program:compiledProgramSchema,
  resources:z.array(z.object({id:z.string().regex(/^response_[0-3]$/),plan:planSchema}).strict()).min(1).max(4),
}).strict().superRefine((task,ctx)=>{
  if(new Set(task.resources.map(r=>r.id)).size!==task.resources.length)ctx.addIssue({code:'custom',message:'Duplicate generated resource.'});
  for(const {plan} of task.resources) if(plan.request.runtimeFields?.length || plan.request.runtimeHeaders?.length || plan.request.pagination)
    ctx.addIssue({code:'custom',message:'Generated resource requires unsupported session or pagination handling.'});
});
export type JavaScriptTask=z.infer<typeof javascriptTaskSchema>;
export const preparedCompilationSchema=z.object({
  kind:z.literal('javascript-task-evidence'),contractHash:z.string().regex(/^[a-f0-9]{64}$/),
  resources:javascriptTaskSchema.shape.resources,
  inputs:z.array(z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean()]))).length(2),
  resourceInputs:z.array(z.array(z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean()]))).length(2)).min(1).max(4).optional(),
  outputs:z.array(z.json()).length(2),
  bodies:z.array(z.array(z.string().max(1_000_000)).length(2)).min(1).max(4),
  evidenceIds:z.array(z.string()).length(2),
}).strict();
export type PreparedCompilation=z.infer<typeof preparedCompilationSchema>;

function compilerBody(plan:GenericJsonPlan,value:unknown):string{
  if(plan.response.codec!=='html-document')return JSON.stringify(sanitizeEvidence(value).data);
  const sanitized=sanitizeEvidence({dom:value}).data as {dom?:{format?:string;data?:unknown}};
  if(sanitized.dom?.format!=='html' || typeof sanitized.dom.data!=='string')throw new Error('HTML document cannot be sanitized.');
  return sanitized.dom.data;
}

/** Adapter to the existing request-admission boundary, not a new controller.
 * Removing restrictions on resource discovery is a separate, still-open gate.
 * Output transformations no longer have to fit the old projection language. */
export async function compileJavaScriptTask(definition:TaskDefinition,traces:GenericNetworkTrace[],outputs:JsonValue[],
  evidenceIds:string[],directory:string,propose:typeof proposeJavaScript=proposeJavaScript,html:HtmlEvidence[][]=[]):Promise<JavaScriptTask|null>{
  const prepared=prepareJavaScriptCompilation(definition,traces,outputs,evidenceIds,html);
  return prepared?compilePreparedJavaScriptTask(definition,prepared,directory,propose):null;
}

/** Preserve these admitted resources and training responses before inference.
 * Recompilation must never need to recreate browser provenance from lossy HTML. */
export function prepareJavaScriptCompilation(definition:TaskDefinition,traces:GenericNetworkTrace[],outputs:JsonValue[],
  evidenceIds:string[],html:HtmlEvidence[][]=[]):PreparedCompilation|null{
  if(traces.length!==2 || outputs.length!==2 || evidenceIds.length!==2)return null;
  // Do not require response values to resemble browser prose. The model receives
  // the actual contract and outputs, and must pass exact training comparisons.
  const discovered:ReturnType<typeof compileGenericJsonCandidatesFromTraces>=[];
  const documentCandidates:typeof discovered=[];
  const origin=new URL(definition.startUrl).origin;
  const allowed=authorizedNetworkOrigins(definition);
  // Raw HTML is a response resource, not a pre-authored output recipe. Keep the
  // original request proof and private recorder provenance; only remove the old
  // requirement that static analysis find the caller's output fields first.
  const documents=traces.map(t=>t.exchanges.filter(e=>e.responseStatus===200 && /^text\/html(?:\s*;|\s*$)/i.test(e.responseHeaders?.['content-type']??'')).slice(0,8));
  for(const first of documents[0]??[])for(const second of documents[1]??[]){
    try{
      const demonstrations=[first,second].map((exchange,i)=>({input:traces[i]!.input,exchange}));
      const plan=compileGenericJsonPlan(definition.action,demonstrations,{workflowOrigin:origin,allowHtmlDocument:true,allowPathInputs:true});
      documentCandidates.push({plan,demonstrations});
    }catch{/* Different operations, unsafe bindings or missing capture provenance are not resources. */}
  }
  try{discovered.push(...compileGenericJsonCandidatesFromTraces(definition.action,traces.map(({input,exchanges})=>({input,exchanges})),{workflowOrigin:origin,allowPathInputs:true,allowedNetworkOrigins:[...allowed]}));}catch{/* No JSON resources. */}
  for(const first of html[0]??[]){
    const second=html[1]?.find(e=>isDeepStrictEqual(e.recipe,first.recipe));
    if(!second)continue;
    try{discovered.push(...compileGenericJsonCandidatesFromTraces(definition.action,traces.map((t,i)=>({...t,
      exchanges:t.exchanges.filter(e=>/^text\/html(?:\s*;|\s*$)/i.test(e.responseHeaders?.['content-type']??'')),
      outputRows:(i===0?first:second).rows})),{workflowOrigin:origin,htmlOutputRecipe:first.recipe}));}catch{/* Browser/server disagreement is not admitted. */}
  }
  discovered.push(...documentCandidates);
  const seen=new Set(discovered.map(c=>JSON.stringify(c.demonstrations.map(d=>[d.exchange.url,d.exchange.requestBody]))));
  for(const candidate of compileObservedJsonResources(definition.action,traces,{workflowOrigin:origin,allowedNetworkOrigins:[...allowed]})){
    const key=JSON.stringify(candidate.demonstrations.map(d=>[d.exchange.url,d.exchange.requestBody]));
    if(!seen.has(key)){discovered.push(candidate);seen.add(key);}
  }
  const candidates=discovered.filter(c=>!c.plan.request.runtimeFields?.length && !c.plan.request.runtimeHeaders?.length
      && !c.plan.request.pagination && allowed.has(c.plan.request.endpointOrigin??origin)).slice(0,4);
  if(!candidates.length)return null;
  const resources=candidates.map((c,i)=>({id:'response_'+i,plan:c.plan}));
  const bodies=candidates.map(c=>c.demonstrations.map(d=>compilerBody(c.plan,decodeGenericCapturedResponse(c.plan.response,d.exchange))));
  return preparedCompilationSchema.parse({kind:'javascript-task-evidence',contractHash:programDigest(definition),
    resources,inputs:traces.map(t=>t.input),resourceInputs:candidates.map(c=>c.demonstrations.map(d=>d.input)),outputs,bodies,evidenceIds});
}

/** No browser session or website request occurs here. Persisted bundles must be
 * integrity-checked by the caller before entering this compiler boundary. */
export async function compilePreparedJavaScriptTask(definition:TaskDefinition,evidence:unknown,directory:string,
  propose:typeof proposeJavaScript=proposeJavaScript,signal?:AbortSignal):Promise<JavaScriptTask|null>{
  if(signal?.aborted)throw new Error('Compilation cancelled.');
  const context=compilationContext(definition,evidence);
  const proposal=await propose(context,directory,{signal});
  if(!proposal.proposal.supported)return null;
  return validateJavaScriptCandidate(definition,evidence,proposal.proposal.source,proposal.responseId,signal);
}

/** Shared admission checks. Neither callers nor delegated models may widen resources. */
function checkedCompilation(definition:TaskDefinition,evidence:unknown){
  const prepared=preparedCompilationSchema.parse(evidence);
  const {resources,inputs,outputs,bodies,evidenceIds}=prepared;
  const resourceInputs=prepared.resourceInputs??resources.map(()=>inputs);
  if(prepared.contractHash!==programDigest(definition) || resources.length!==bodies.length || resourceInputs.length!==resources.length
    || isDeepStrictEqual(inputs[0],inputs[1]))throw new Error('Saved compilation evidence does not match the task.');
  for(const {plan} of resources){
    assertTaskResourceScope(definition,plan);
  }
  for(const [index,resource] of resources.entries())for(const parameters of resourceInputs[index]!){
    if(!isDeepStrictEqual(Object.keys(parameters).sort(),Object.keys(resource.plan.request.bindings).sort()))throw new Error('Saved resource arguments do not match request bindings.');
  }
  for(const input of inputs)assertResponseValue(definition.inputSchema,input);
  for(const output of outputs)assertResponseValue(definition.outputSchema,output);
  // Reuse the full resource safety checks before making a paid proposal call.
  javascriptTaskSchema.parse({resources,program:createCompiledProgram('function*(){}',definition,resources,inputs,evidenceIds)});
  return {...prepared,resourceInputs};
}

/** Agent-neutral compiler input; request credentials remain behind resource handles. */
export function compilationContext(definition:TaskDefinition,evidence:unknown){
  const {resources,inputs,outputs,bodies,resourceInputs}=checkedCompilation(definition,evidence);
  return {contract:definition,
    resources:resources.map(r=>({id:r.id,parameters:Object.keys(r.plan.request.bindings),response:r.plan.response.codec==='html-document'?'{url,status,body}; body is sanitized HTML text':'{url,status,body}; body is JSON text',
      method:r.plan.request.method,path:r.plan.request.endpointPath})),
    examples:inputs.map((input,i)=>({input,output:outputs[i],responses:resources.map((r,j)=>({resource:r.id,parameters:resourceInputs[j]![i],status:200,body:bodies[j]![i]}))}))};
}

/** Offline candidate validation only. No model calls, browser, promotion or task writes. */
export async function validateJavaScriptCandidate(definition:TaskDefinition,evidence:unknown,source:string,
  sourceEvidenceId:string,signal?:AbortSignal):Promise<JavaScriptTask>{
  if(signal?.aborted)throw new Error('Compilation cancelled.');
  const {resources,inputs,outputs,bodies,evidenceIds,resourceInputs}=checkedCompilation(definition,evidence);
  const program=createCompiledProgram(source,definition,resources,inputs,[...evidenceIds,sourceEvidenceId]);
  const task=javascriptTaskSchema.parse({program,resources});
  for(let i=0;i<inputs.length;i++){
    const result=await executeCompiledProgram(program,definition,resources,inputs[i]!,definition.outputSchema,async request=>{
      const index=resources.findIndex(r=>r.id===request.resource);
      if(index<0 || !isDeepStrictEqual(request.parameters,resourceInputs[index]![i]))throw new Error('Training request does not match observed evidence.');
      const plan=resources[index]!.plan;
      return {url:new URL(materializeRequestPath(plan.request.endpointPath,plan.request.pathBindings,request.parameters),plan.request.endpointOrigin??plan.origin).href,status:200,body:bodies[index]![i]!};
    },{shadow:true,signal});
    if(!isDeepStrictEqual(result.value,outputs[i]))throw new Error('Generated program disagrees with training output.');
  }
  return task;
}

export async function replayJavaScriptTask(context:BrowserContext,definition:TaskDefinition,task:JavaScriptTask,input:JsonValue,signal?:AbortSignal){
  javascriptTaskSchema.parse(task);
  assertResponseValue(definition.inputSchema,input);
  return executeCompiledProgram(task.program,definition,task.resources,input,definition.outputSchema,async(request,requestSignal)=>{
    const resource=task.resources.find(r=>r.id===request.resource);
    if(!resource || requestSignal.aborted)throw new Error('Generated resource unavailable.');
    // A generated program cannot redirect an admitted request to another task.
    assertTaskResourceScope(definition,resource.plan);
    const result=await replayGenericJsonPlan(context,resource.plan,request.parameters);
    if(requestSignal.aborted)throw new Error('Generated resource cancelled.');
    return {url:new URL(materializeRequestPath(resource.plan.request.endpointPath,resource.plan.request.pathBindings,request.parameters),resource.plan.request.endpointOrigin??resource.plan.origin).href,status:result.status,
      body:compilerBody(resource.plan,result.data)};
  },{signal,shadow:task.program.status==='candidate'});
}
