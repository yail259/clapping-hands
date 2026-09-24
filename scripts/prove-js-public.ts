import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { proposeJavaScript } from '../src/javascript-compiler.js';
import { executeGeneratedJavaScript, type GeneratedBroker } from '../src/generated-js.js';
import { saveEvidenceBundle, sanitizeEvidence, loadEvidenceBundle } from '../src/evidence-bundle.js';
import type { JsonValue, ResponseSchema } from '../src/response-contract.js';

// Explicit experimental authority comes from previously validated request/page
// plans. No new Browser Use tasks. These oracles never enter compiler evidence.
const cases = [
  {id:'yahoo', report:'alpha-ten-1788749353343-yahoo.json', url:'https://finance.yahoo.com/quote/{symbol}/', method:'GET', parameters:['symbol'], location:'path', queries:['AAPL','MSFT','AMZN','NVDA','GOOG'], selector:'h1'},
  {id:'govuk', report:'alpha-ten-1788749688021-govuk.json', url:'https://www.gov.uk/search/all', method:'GET', parameters:['keywords'], location:'query', queries:['tax','pension','passport','driving licence','benefits'], selector:'.gem-c-document-list__item-title a'},
  {id:'ikea', report:'alpha-ten-1788750873697-ikea.json', url:'https://www.ikea.com/au/en/search/', method:'GET', parameters:['q'], location:'query', queries:['sofa bed','desk','bookcase','chair','lamp'], selector:'a[href*="/p/"] .plp-price-module__product-name'},
  {id:'bunnings', report:'alpha-ten-1788750751670-bunnings.json', url:'https://www.bunnings.com.au/search/products', method:'GET', parameters:['q'], location:'query', queries:['cordless drill','garden hose','hammer','paint brush','ladder'], selector:'main a[href*="_p"] p'},
  {id:'rba', report:'alpha-ten-1788749023107-rba.json', url:'https://www.rba.gov.au/calculator/annualDecimal.html', method:'POST', parameters:['annualDollar','annualStartYear','annualEndYear'], location:'form', queries:[], selector:'input[name="calculatedAnnualDollarValue"]'},
];
const selected = (process.env.CLAPPING_HANDS_JS_SITES ?? 'yahoo,govuk,ikea,bunnings,rba').split(',');
if (selected.some(id=>!cases.some(c=>c.id===id))) throw new Error('Unknown site');
const base = resolve(process.env.CLAPPING_HANDS_JS_EVIDENCE_DIR ?? '.data/js-compilation');
async function run(c: typeof cases[number]) {
  const root = resolve(base,c.id);
  const report = JSON.parse(await readFile(resolve('bench/runs/2026-09-07',c.report),'utf8'));
  const definition = report.definition;
  const inputs: Record<string, string|number>[] = c.id === 'rba'
    ? [{amount:100,start_year:2000,end_year:2015},{amount:250.5,start_year:2001,end_year:2016},{amount:75.25,start_year:2000,end_year:2016},{amount:125.5,start_year:2001,end_year:2015},{amount:325,start_year:2000,end_year:2015}]
    : c.queries.map(query=>({query}));
  const resource = {id:'read', url:c.url, method:c.method, parameters:c.parameters, parameterLocation:c.location,
    fixedFields:(c.id==='rba'?{calculatedAnnualDollarValue:'',idACalc:''}:{}) as Record<string,string>};
  const parametersFor = (input: Record<string,string|number>) => c.id==='rba'
    ? {annualDollar:input.amount!,annualStartYear:input.start_year!,annualEndYear:input.end_year!}
    : {[c.parameters[0]!]:input.query!};
  function oracle(html:string,input:Record<string,string|number>):JsonValue {
    const $=load(html);
    const target=c.id==='yahoo'?$(c.selector).filter((_i,el)=>$(el).text().includes('('+input.query+')')).first():$(c.selector).first();
    if(!target.length)throw new Error('No independently identifiable result');
    if(c.id==='rba') {
      const value=target.attr('value');if(!value)throw new Error('No calculator result');
      const n=Number(value.replace(/[$,\s]/g,''));if(!Number.isFinite(n))throw new Error('Invalid calculator value');
      return {adjusted_amount:n};
    }
    const text=target.text().trim();if(!text)throw new Error('Empty result');return text;
  }
  async function capture(parameters: Record<string,string|number|boolean>, signal = AbortSignal.timeout(30_000)) {
    if (!isDeepStrictEqual(Object.keys(parameters).sort(),[...c.parameters].sort())) throw new Error('Invalid resource parameters');
    const url=new URL(c.location==='path'?c.url.replace('{symbol}',encodeURIComponent(String(parameters.symbol))):c.url);
    const form=new URLSearchParams(resource.fixedFields);
    for(const [key,value]of Object.entries(parameters)) {
      if(c.location==='query')url.searchParams.set(key,String(value));
      if(c.location==='form')form.set(key,String(value));
    }
    const start=performance.now();
    try {
      const response=await fetch(url,{method:c.method,redirect:'error',signal,
        ...(c.location==='form'?{headers:{'content-type':'application/x-www-form-urlencoded'},body:form.toString()}:{})});
      const raw=await response.text();
      const safe=sanitizeEvidence({responseBody:raw});
      const parsed=(safe.data as any).responseBody;
      const snapshot={url:url.href,status:response.status,body:parsed.format==='html'?parsed.data as string:''};
      const evidence=await saveEvidenceBundle(root,{kind:'direct-response-capture',site:c.id,resource,parameters,response:snapshot,omissions:safe.omissions,
        provenance:'previously observed endpoint; no Browser Use rerun',durationMs:performance.now()-start});
      if(response.status!==200||!snapshot.body)throw new Error('Response unavailable');
      return {snapshot,evidenceId:evidence.id};
    } catch {
      await saveEvidenceBundle(root,{kind:'capture-failure',site:c.id,resource,parameters,category:'capture-unavailable',durationMs:performance.now()-start});
      throw new Error('Capture unavailable');
    }
  }
  const results:any[]=[];let proposalId:string|undefined;
  try {
    const restore=process.env.CLAPPING_HANDS_JS_PROPOSAL_ID;
    let source:string;
    if(restore) {const data=await loadEvidenceBundle(root,restore) as any;source=data.proposal.source;proposalId=restore;}
    else {
      const requestId=process.env.CLAPPING_HANDS_JS_REQUEST_ID;
      let evidence:any;
      if(requestId)evidence=JSON.parse((await loadEvidenceBundle(root,requestId) as any).prompt);
      else {
        const examples=[];
        const captureIds=process.env.CLAPPING_HANDS_JS_CAPTURE_IDS?.split(',');
        if(captureIds && (selected.length!==1 || captureIds.length!==2))throw new Error('Supply exactly two captures for one site');
        for(const [index,input] of inputs.slice(0,2).entries()) {
          const parameters=parametersFor(input);
          const previous=captureIds?await loadEvidenceBundle(root,captureIds[index]!) as any:undefined;
          if(previous && (previous.site!==c.id || !isDeepStrictEqual(previous.parameters,parameters)))throw new Error('Saved input mismatch');
          const observed=previous?{snapshot:previous.response,evidenceId:captureIds![index]!}:await capture(parameters);
          const expected=oracle(observed.snapshot.body,input);
          examples.push({input,request:{resource:'read',parameters},response:observed.snapshot,expected,evidenceId:observed.evidenceId});
        }
        evidence={goal:definition.goal,inputSchema:definition.inputSchema,outputSchema:definition.outputSchema,resources:[resource],examples};
      }
      for(const example of evidence.examples) {
        example.expected=oracle(example.response.body,example.input);
        const $=load(example.response.body);$('style,svg').remove();
        example.response.body=$.html();
        example.promptView='Styles and SVG omitted from prompt only; full sanitized capture retained by evidenceId.';
      }
      const generated=await proposeJavaScript(evidence,root);proposalId=generated.responseId;
      console.log(JSON.stringify({site:c.id,phase:'compiled',supported:generated.proposal.supported,proposalId,durationMs:generated.durationMs}));
      if(!generated.proposal.supported)throw new Error('Compiler declined');source=generated.proposal.source;
    }
    for(const input of inputs.slice(2)) {
      let observed:Awaited<ReturnType<typeof capture>>|undefined;
      const broker:GeneratedBroker=async(request,signal)=>{
        if(request.resource!=='read'||!isDeepStrictEqual(request.parameters,parametersFor(input)))throw new Error('Request violates test contract');
        observed=await capture(request.parameters,signal);return observed.snapshot;
      };
      try {
        const result=await executeGeneratedJavaScript(source,input,definition.outputSchema as ResponseSchema,broker);
        const expected=oracle(observed!.snapshot.body,input);
        const record={kind:'held-out-validation',site:c.id,proposalId,input,restarted:!!restore,result,expected,
          exact:isDeepStrictEqual(result.value,expected),evidenceId:observed!.evidenceId,oracle:'independent parser of same fresh response; no fresh browser oracle'};
        await saveEvidenceBundle(root,record);results.push({input,exact:record.exact,durationMs:result.durationMs,requests:result.requests});
      } catch {results.push({input,exact:false,category:'execution-or-oracle-failed'});await saveEvidenceBundle(root,{kind:'held-out-failure',site:c.id,proposalId,...results.at(-1)});}
      console.log(JSON.stringify({site:c.id,phase:'held-out',...results.at(-1)}));
    }
  }catch(error){results.push({phase:'compilation',category:error instanceof Error?error.message:'unknown'});}
  await saveEvidenceBundle(root,{kind:'compilation-summary',site:c.id,proposalId:proposalId??null,results});
  console.log(JSON.stringify({site:c.id,phase:'finished',proposalId,results}));
}
const pending=cases.filter(c=>selected.includes(c.id));
await Promise.all([0,1].map(async()=>{for(;;){const c=pending.shift();if(!c)return;await run(c);}}));
