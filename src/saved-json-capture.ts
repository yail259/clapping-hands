import { z } from 'zod';
import type { CapturedExchange } from './captured-exchange.js';
import { loadEvidenceBundle } from './evidence-bundle.js';

const envelope = z.object({
  url: z.string().max(8192), method: z.enum(['GET', 'POST']), resourceType: z.string().max(100),
  requestHeaders: z.record(z.string(), z.string()), requestBody: z.unknown(),
  responseStatus: z.number().int().min(200).max(299),
  responseHeaders: z.record(z.string(), z.string()).optional(), responseBody: z.unknown(),
});
const jsonBody = z.object({format:z.literal('json'),data:z.json()}).strict();
const framesBody = z.object({format:z.literal('json-lines'),data:z.array(z.json()).min(2).max(128)}).strict();
const removed = /\[(?:OMITTED|REDACTED)\]/;
type Refusal = 'invalid-exchange' | 'request-unavailable' | 'response-unavailable' | 'body-limit';

/** Restore sanitized JSON semantics only, not original bytes or browser HTML
 * identity. This neither authorizes an origin nor creates a runnable plan. */
export function restoreSavedJsonExchange(value: unknown):
  { restored:true; exchange:CapturedExchange } | { restored:false; reason:Refusal } {
  const parsed=envelope.safeParse(value);
  if(!parsed.success)return {restored:false,reason:'invalid-exchange'};
  const e=parsed.data;
  try {
    const url=new URL(e.url);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||removed.test(decodeURIComponent(e.url)))
      return {restored:false,reason:'invalid-exchange'};
  }catch{return {restored:false,reason:'invalid-exchange'};}
  // Never assume an old omitted GET body was empty. Form sanitization loses
  // scalar/string distinctions and encoding, so it is not reversible here.
  const request=jsonBody.safeParse(e.requestBody);
  if(e.requestBody!==''&&!request.success)return {restored:false,reason:'request-unavailable'};
  const requestBody=e.requestBody===''?'':JSON.stringify(request.data!.data);
  if(removed.test(requestBody))return {restored:false,reason:'request-unavailable'};
  const json=jsonBody.safeParse(e.responseBody),frames=framesBody.safeParse(e.responseBody);
  if(!json.success&&!frames.success)return {restored:false,reason:'response-unavailable'};
  const responseBody=json.success?JSON.stringify(json.data.data):frames.data!.data.map(frame=>JSON.stringify(frame)).join('\n');
  if(Buffer.byteLength(requestBody)>1_000_000||Buffer.byteLength(responseBody)>1_000_000)
    return {restored:false,reason:'body-limit'};
  const headers=(source:Record<string,string>|undefined,allowed:string[])=>Object.fromEntries(Object.entries(source??{})
    .filter(([key,value])=>allowed.includes(key.toLowerCase())&&!removed.test(value))
    .map(([key,value])=>[key.toLowerCase(),value]));
  return {restored:true,exchange:{url:e.url,method:e.method,resourceType:e.resourceType,
    requestHeaders:headers(e.requestHeaders,['accept','content-type','x-requested-with']),requestBody,
    responseStatus:e.responseStatus,responseHeaders:headers(e.responseHeaders,['content-type']),responseBody}};
}

/** The file loader verifies the bundle hash before any restoration occurs. */
export async function loadSavedJsonCapture(directory:string,id:string) {
  const capture=await loadEvidenceBundle(directory,id) as {exchanges?:unknown[]};
  if(!capture||!Array.isArray(capture.exchanges)||capture.exchanges.length>1000)
    throw new Error('Saved capture has no bounded exchange collection.');
  const exchanges:CapturedExchange[]=[];
  const refused:Partial<Record<Refusal,number>>={};
  for(const value of capture.exchanges){
    const result=restoreSavedJsonExchange(value);
    if(result.restored)exchanges.push(result.exchange);
    else refused[result.reason]=(refused[result.reason]??0)+1;
  }
  return {capture,exchanges,refused,representation:'sanitized-json-semantics' as const};
}
