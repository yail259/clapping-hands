import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { assertResponseValue, type JsonValue, type ResponseSchema } from './response-contract.js';

export const generatedRequestSchema=z.object({op:z.literal('request'),resource:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),parameters:z.record(z.string().max(100),z.union([z.string().max(4000),z.number().finite(),z.boolean()]))}).strict();
export type GeneratedRequest=z.infer<typeof generatedRequestSchema>;
export type GeneratedBroker=(request:GeneratedRequest,signal:AbortSignal)=>Promise<JsonValue>;
export class GeneratedExecutionError extends Error {constructor(readonly code:string){super('Generated program execution failed: '+code);this.name='GeneratedExecutionError';}}

/** JavaScript is expressive; authority belongs exclusively to the supplied broker.
 * Guest failures never serialize source, inputs, provider errors or response data. */
export async function executeGeneratedJavaScript(source:string,input:JsonValue,outputSchema:ResponseSchema,broker:GeneratedBroker,
  options:{timeoutMs?:number;maxRequests?:number;signal?:AbortSignal}={}){
  if(options.signal?.aborted)throw new GeneratedExecutionError('cancelled');
  if(typeof source!=='string'||source.length>64000||JSON.stringify(input).length>1_000_000)throw new GeneratedExecutionError('input-limit');
  const timeoutMs=options.timeoutMs??30000,maxRequests=options.maxRequests??4;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(maxRequests)||maxRequests<0||maxRequests>10)throw new GeneratedExecutionError('invalid-limits');
  const started=performance.now(),controller=new AbortController();let requests=0;
  let removeAbortListener=()=>{};
  const worker=new Worker(new URL(import.meta.url.endsWith('.ts')?'./generated-js-worker.ts':'./generated-js-worker.js',import.meta.url),{
    workerData:{source,input},env:{},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4},
  });
  try {
    const value=await new Promise<JsonValue>((resolve,reject)=>{
      let finished=false;
      const finish=(error?:string,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);controller.abort();if(error)reject(new GeneratedExecutionError(error));else{try{resolve(assertResponseValue(outputSchema,value));}catch{reject(new GeneratedExecutionError('output-contract'));}}};
      const timer=setTimeout(()=>finish('timeout'),timeoutMs);
      const abort=()=>finish('cancelled');
      options.signal?.addEventListener('abort',abort,{once:true});
      removeAbortListener=()=>options.signal?.removeEventListener('abort',abort);
      if(options.signal?.aborted){abort();return;}
      worker.once('error',()=>finish('worker-failed'));worker.once('exit',()=>finish('worker-exited'));
      worker.on('message',async message=>{
        if(finished)return;
        if(message?.kind==='result')return finish(undefined,message.value);
        if(message?.kind!=='request')return finish('guest-failed');
        if(++requests>maxRequests)return finish('request-limit');
        try{
          const request=generatedRequestSchema.parse(message.operation);
          const reply=await broker(request,controller.signal);
          if(JSON.stringify(reply).length>1_000_000)return finish('response-limit');
          if(!finished)worker.postMessage(reply);
        }catch{finish('request-denied');}
      });
    });
    return {value,requests,modelCalls:0 as const,durationMs:performance.now()-started};
  } finally {removeAbortListener();controller.abort();await worker.terminate();}
}
