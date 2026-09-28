import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BrowserContext, Page } from 'playwright-core';
import { assertWorkflowAuth, trackWorkflowAuth } from './workflow-auth.js';
import type { ResponseSchema } from './response-contract.js';

const safeName = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
const privateName = /token|secret|cookie|password|session|authorization|authentication|csrf|xsrf|api.?key|access.?key|^key$/i;
const part = z.union([z.string().max(200), z.object({ input: z.literal(true) }).strict()]);
const selector = z.string().max(500).regex(/^[a-z][a-z0-9]*(?:[.#][A-Za-z_][A-Za-z0-9_-]{0,79})*(?: [a-z][a-z0-9]*(?:[.#][A-Za-z_][A-Za-z0-9_-]{0,79})*)?$/);
const scopeSchema = z.object({selector,index:z.number().int().min(0).max(99),
  anchor:z.object({selector,index:z.number().int().min(0).max(99),depth:z.number().int().min(1).max(12)}).strict().optional()}).strict();
const fieldSelector = z.object({ name: z.string().regex(safeName), selector, index: z.number().int().min(0).max(99),
  scope:scopeSchema.optional(),mode:z.enum(['own-text','label-value']).optional(),label:z.string().max(120).optional(),valueSelector:selector.optional() }).strict()
  .superRefine((field,ctx)=>{
    if(field.mode==='label-value'&&(!field.label||!field.valueSelector))ctx.addIssue({code:'custom',message:'Label-value locator requires a label and value selector.'});
    if(field.mode!=='label-value'&&(field.label!==undefined||field.valueSelector!==undefined))ctx.addIssue({code:'custom',message:'Unexpected label-value locator fields.'});
  });
const click = z.object({ selector, index: z.number().int().min(0).max(99),scope:scopeSchema.optional(),text: z.literal('See more') }).strict();
const common = { origin:z.string().url(),inputName:z.string().regex(safeName),path:z.array(part).min(2).max(20),
  query:z.array(z.object({name:z.string().regex(safeName),value:part}).strict()).max(20),
  status:z.enum(['provisional','stable','degraded']),training:z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(2),
  heldout:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2) };
const legacySchema = z.object({kind:z.literal('page-url-text-v1'),...common,selector,index:z.number().int().min(0).max(99)}).strict();
const structuredSchema = z.object({kind:z.literal('page-url-fields-v1'),...common,fields:z.array(fieldSelector).min(1).max(20),expand:click.optional()}).strict();
export const pageReplaySchema = z.union([legacySchema,structuredSchema]).superRefine((p,ctx)=>{
  const u=new URL(p.origin), names=p.kind==='page-url-fields-v1'?p.fields.map(x=>x.name):[];
  const located=p.kind==='page-url-fields-v1'?[...p.fields,...(p.expand?[p.expand]:[])]:[];
  const selectors=p.kind==='page-url-fields-v1'?[...located.flatMap(x=>[x.selector,...(x.scope?[x.scope.selector,...(x.scope.anchor?[x.scope.anchor.selector]:[])]:[])])]:[p.selector];
  if(!['https:','http:'].includes(u.protocol)||u.origin!==p.origin||privateName.test(p.inputName)
    ||selectors.some(s=>/token|secret|cookie|password|session|csrf|xsrf/i.test(s))
    ||p.path[0]!==''||p.path.some(x=>typeof x==='string'&&(x==='.'||x==='..'||/[/?#\\]/.test(x)))
    ||p.query.some(x=>privateName.test(x.name))||new Set(p.query.map(x=>x.name)).size!==p.query.length
    ||!([...p.path,...p.query.map(x=>x.value)].some(x=>typeof x!=='string'))
    ||new Set(p.training).size!==2||new Set(p.heldout).size!==p.heldout.length||p.heldout.some(x=>p.training.includes(x))
    ||new Set(names).size!==names.length
    ||located.some(x=>x.scope?.anchor&&(x.scope.anchor.selector!=='h1'||x.scope.anchor.index!==0)))ctx.addIssue({code:'custom',message:'Unsafe or unsupported page replay.'});
});
export type PageReplay = z.infer<typeof pageReplaySchema>;
type Scope = {selector:string;index:number;anchor?:{selector:string;index:number;depth:number}};
type Located = {selector:string;index:number;scope?:Scope;mode?:'own-text'|'label-value';label?:string;valueSelector?:string};
export type PageEvidence = {url:string;selectors:Located[];fields?:Record<string,Located[]>;expanders?:Located[]};
const hash=(value:string)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function capturePageEvidence(page:Page,output:unknown):Promise<PageEvidence|null>{
  const outputs:Record<string,string>=typeof output==='string'?{__text:output}:output&&typeof output==='object'&&!Array.isArray(output)?output as Record<string,string>:{};
  const pairs=Object.entries(outputs);
  if(!pairs.length||pairs.length>20||pairs.some(([n,v])=>!safeName.test(n)||privateName.test(n)||typeof v!=='string'||!v||v.length>4000))return null;
  const result=await page.evaluate(String.raw`((outputs) => {
    const safe=/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
    const compound=el=>el.tagName.toLowerCase()+(safe.test(el.id)?'#'+el.id:[...el.classList].filter(x=>safe.test(x)).slice(0,3).map(x=>'.'+x).join(''));
    const same=(a,b)=>a.selector===b.selector&&a.index===b.index&&a.mode===b.mode&&a.label===b.label&&a.valueSelector===b.valueSelector&&a.scope?.selector===b.scope?.selector&&a.scope?.index===b.scope?.index
      &&a.scope?.anchor?.selector===b.scope?.anchor?.selector&&a.scope?.anchor?.index===b.scope?.anchor?.index&&a.scope?.anchor?.depth===b.scope?.anchor?.depth;
    const visible=el=>el instanceof HTMLElement&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const headings=[...document.querySelectorAll('h1')].filter(visible);
    const titleAnchor=headings.length===1?headings[0]:null;
    const anchorAncestors=new Map();if(titleAnchor){let node=titleAnchor.parentElement;for(let depth=1;node&&depth<=12;depth++,node=node.parentElement)anchorAncestors.set(node,depth);}
    const locate=text=>{const found=[];for(const el of [...document.querySelectorAll('h1,h2,h3,h4,h5,a,span,p,div,li,td,dd,dt,output,strong,b')].slice(0,5000)){
      if(!visible(el))continue;
      const ownText=[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent??'').join('').trim();
      const modes=[...(ownText===text?['own-text']:[]),...(el.innerText?.trim()===text?[undefined]:[])];
      if(!modes.length)continue;
      const row=el.closest('p.product-details__column');
      if(row&&el.tagName==='SPAN'&&el.innerText.trim()===text){
        const labels=[...row.querySelectorAll('strong')].filter(visible);
        const values=[...row.querySelectorAll('span')].filter(x=>visible(x)&&x.innerText.trim()===text);
        const label=labels.length===1?labels[0].innerText.trim():'';
        if(label&&values.length===1&&values[0]===el){
          const scopeEntry=[...anchorAncestors.entries()].find(([ancestor])=>ancestor.contains(row));
          if(scopeEntry){
            const [ancestor,depth]=scopeEntry,scopeSelector=compound(ancestor);
            const scopes=[...document.querySelectorAll(scopeSelector)].filter(node=>node.contains(titleAnchor));
            if(scopes.length===1&&scopes[0]===ancestor)found.push({selector:'p.product-details__column',index:0,
              scope:{selector:scopeSelector,index:0,anchor:{selector:'h1',index:0,depth}},mode:'label-value',label,valueSelector:'span'});
          }
        }
      }
      for(const mode of modes){
      const own=compound(el);
      let ancestor=el.parentElement;
      for(let depth=0;ancestor&&depth<12;depth++,ancestor=ancestor.parentElement){
        // Scope only to ancestors with an explicit id/class. Generic tag scopes
        // commonly span the whole page and do not anchor a repeated listing.
        if(!safe.test(ancestor.id)&&![...ancestor.classList].some(x=>safe.test(x)))continue;
        const scopeSelector=compound(ancestor),scopeIndex=[...document.querySelectorAll(scopeSelector)].indexOf(ancestor);
        const childIndex=[...ancestor.querySelectorAll(own)].indexOf(el);
        const candidate={selector:own,index:childIndex,scope:{selector:scopeSelector,index:scopeIndex},...(mode?{mode}:{})};
        if(scopeIndex>=0&&scopeIndex<100&&childIndex>=0&&childIndex<100&&!found.some(x=>same(x,candidate)))found.push(candidate);
        const anchorDepth=anchorAncestors.get(ancestor);
        const anchoredScopes=titleAnchor?[...document.querySelectorAll(scopeSelector)].filter(node=>node.contains(titleAnchor)):[];
        if(anchorDepth&&titleAnchor&&anchoredScopes.length===1&&anchoredScopes[0]===ancestor){
          const semantic={selector:own,index:childIndex,scope:{selector:scopeSelector,index:0,anchor:{selector:'h1',index:0,depth:anchorDepth}},...(mode?{mode}:{})};
          if(childIndex>=0&&childIndex<100&&!found.some(x=>same(x,semantic)))found.push(semantic);
        }
        if(found.length>=63)break;
      }
      const globalIndex=[...document.querySelectorAll(own)].indexOf(el);
      if(globalIndex>=0&&globalIndex<100&&!found.some(x=>x.selector===own&&x.index===globalIndex&&!x.scope&&x.mode===mode))found.push({selector:own,index:globalIndex,...(mode?{mode}:{})});
      if(el.parentElement){const parent=compound(el.parentElement),combined=parent+' '+own,combinedIndex=[...document.querySelectorAll(combined)].indexOf(el);
        if(combinedIndex>=0&&combinedIndex<100&&!found.some(x=>x.selector===combined&&x.index===combinedIndex&&!x.scope&&x.mode===mode))found.push({selector:combined,index:combinedIndex,...(mode?{mode}:{})});}
      if(found.length>=64)return found;
      }
    }return found;};
    const fields={};for(const [name,text] of Object.entries(outputs))fields[name]=locate(text);
    const expanders=window.__clappingHandsSeeMore??[];
    return {fields,expanders};
  })(${JSON.stringify(Object.fromEntries(pairs))})`) as {fields:Record<string,Located[]>;expanders:Located[]};
  const selectors=pairs[0]![0]==='__text'?(result.fields.__text??[]).filter(x=>!x.scope&&!x.mode):[];
  return {url:page.url(),selectors,fields:result.fields,expanders:result.expanders.slice(0,64)};
}

/** Install a tiny passive event observer. It records only a visible, exact-text button-like
 * control and never changes page behaviour or captures arbitrary clicks. */
export function installPageReplayEvidence(context:BrowserContext){
  return context.addInitScript(String.raw`(()=>{window.__clappingHandsSeeMore=[];document.addEventListener('click',event=>{
    const raw=event.target;if(!(raw instanceof Element))return;const el=raw.closest('button,[role="button"]');if(!(el instanceof HTMLElement))return;
    if(el.closest('a')||el.tagName==='A'||(el.tagName==='BUTTON'&&el.type==='submit')||el.innerText.trim()!=='See more'||!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return;
    const safe=/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;const compound=node=>node.tagName.toLowerCase()+(safe.test(node.id)?'#'+node.id:[...node.classList].filter(x=>safe.test(x)).slice(0,3).map(x=>'.'+x).join(''));
    const css=compound(el),index=[...document.querySelectorAll(css)].indexOf(el),candidates=[];
    if(index>=0&&index<100)candidates.push({selector:css,index});let ancestor=el.parentElement;
    const headings=[...document.querySelectorAll('h1')].filter(node=>node instanceof HTMLElement&&node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
    const titleAnchor=headings.length===1?headings[0]:null,anchorAncestors=new Map();if(titleAnchor){let node=titleAnchor.parentElement;for(let depth=1;node&&depth<=12;depth++,node=node.parentElement)anchorAncestors.set(node,depth);}
    for(let depth=0;ancestor&&depth<12;depth++,ancestor=ancestor.parentElement){if(!safe.test(ancestor.id)&&![...ancestor.classList].some(x=>safe.test(x)))continue;
      const scopeSelector=compound(ancestor),scopeIndex=[...document.querySelectorAll(scopeSelector)].indexOf(ancestor),childIndex=[...ancestor.querySelectorAll(css)].indexOf(el);
      if(scopeIndex>=0&&scopeIndex<100&&childIndex>=0&&childIndex<100)candidates.push({selector:css,index:childIndex,scope:{selector:scopeSelector,index:scopeIndex}});
      const anchorDepth=anchorAncestors.get(ancestor),anchoredScopes=titleAnchor?[...document.querySelectorAll(scopeSelector)].filter(node=>node.contains(titleAnchor)):[];
      if(anchorDepth&&titleAnchor&&anchoredScopes.length===1&&anchoredScopes[0]===ancestor&&childIndex>=0&&childIndex<100)
        candidates.push({selector:css,index:childIndex,scope:{selector:scopeSelector,index:0,anchor:{selector:'h1',index:0,depth:anchorDepth}}});
    }
    for(const candidate of [...candidates.filter(x=>x.scope?.anchor),...candidates.filter(x=>x.scope&&!x.scope.anchor),...candidates.filter(x=>!x.scope)])if(!window.__clappingHandsSeeMore.some(x=>JSON.stringify(x)===JSON.stringify(candidate)))window.__clappingHandsSeeMore.push(candidate);
    if(window.__clappingHandsSeeMore.length>128)window.__clappingHandsSeeMore.splice(0,window.__clappingHandsSeeMore.length-128);
  },true);})();`);
}

export function compilePageReplay(origin:string,inputs:unknown[],evidence:PageEvidence[][],outputSchema?:ResponseSchema):PageReplay|null{
  try{
    if(inputs.length!==2||evidence.length!==2)return null;
    const records=inputs as Record<string,unknown>[],names=Object.keys(records[0]!);
    if(names.length!==1||Object.keys(records[1]!).length!==1)return null;
    const name=names[0]!,values=records.map(r=>r[name]);
    if(!values.every(x=>typeof x==='string'&&x.length>0&&x.length<200)||values[0]===values[1])return null;
    const propertyNames=Object.keys(outputSchema?.properties??{});
    const structured=outputSchema?.type==='object'&&!!outputSchema.properties&&outputSchema.required?.length===propertyNames.length
      &&new Set(outputSchema.required).size===outputSchema.required.length&&outputSchema.required?.every(field=>propertyNames.includes(field))
      &&outputSchema.additionalProperties===false&&Object.keys(outputSchema.properties).length>0&&Object.values(outputSchema.properties).every(x=>x.type==='string');
    for(const first of evidence[0]!)for(const second of evidence[1]!){
      const urls=[new URL(first.url),new URL(second.url)];if(urls.some(u=>u.origin!==origin||u.hash||u.username||u.password))continue;
      const paths=urls.map(u=>u.pathname.split('/').map(decodeURIComponent));if(paths[0]!.length!==paths[1]!.length)continue;
      const bind=(a:string,b:string)=>a===values[0]&&b===values[1]?{input:true as const}:a===b?a:null;
      const path=paths[0]!.map((p,i)=>bind(p,paths[1]![i]!)),entries=urls.map(u=>[...u.searchParams]);
      if(entries[0]!.length!==entries[1]!.length||entries[0]!.some(([k],i)=>k!==entries[1]![i]![0]))continue;
      const query=entries[0]!.map(([qname,value],i)=>({name:qname,value:bind(value,entries[1]![i]![1])}));
      if(path.includes(null)||query.some(x=>x.value===null))continue;
      const constants=[...path,...query.map(x=>x.value)].filter((x):x is string=>typeof x==='string');
      if(constants.some(x=>!/^[A-Za-z0-9_. -]{0,80}$/.test(x)||/[A-Za-z0-9_-]{32,}/.test(x)))continue;
      const base={origin,inputName:name,path,query,status:'provisional' as const,training:values.map(x=>hash(x as string)),heldout:[] as string[]};
      if(structured){
        const fields=[] as Array<{name:string;selector:string;index:number}>;let good=true;
        for(const field of Object.keys(outputSchema!.properties!)){
          const a=first.fields?.[field]??[],b=second.fields?.[field]??[];
          // A classless terminal span is common for incidental text nested in
          // product columns. Its ordinal can agree across demonstrations and
          // still move when another listing has a different number of detail
          // spans (for example, accessories). Do not compile that positional
          // guess, even when a parent selector is prepended.
          const usable=(x:Located)=>!/(?:^|\s)span$/.test(x.selector);
          const shared=(x:Located)=>usable(x)&&b.some(y=>usable(y)&&sameLocated(x,y));
          // A wrapper can acquire badges or previous prices on another item.
          // Prefer a text-bearing element when both demos identify one.
          const leaf=(x:Located)=>/^(?:h[1-6]|span|p|li|td|dd|dt|output|strong|b)(?:[.#]|$)/.test(x.selector);
          const match=a.find(x=>x.mode==='label-value'&&shared(x))
            ??a.find(x=>x.scope?.anchor&&x.mode==='own-text'&&leaf(x)&&shared(x))
            ??a.find(x=>x.scope?.anchor&&leaf(x)&&shared(x))
            ??a.find(x=>x.scope?.anchor&&shared(x))
            ??a.find(x=>leaf(x)&&shared(x))??a.find(shared);
          if(!match){good=false;break;}fields.push({name:field,...match});
        }
        if(!good)continue;
        const expandA=first.expanders??[],expandB=second.expanders??[];
        const expand=expandA.find(a=>a.scope?.anchor&&expandB.some(b=>sameLocated(a,b)))
          ??expandA.find(a=>a.scope&&expandB.some(b=>sameLocated(a,b)))
          ??expandA.find(a=>expandB.some(b=>sameLocated(a,b)));
        if(expandA.length&&expandB.length&&!expand)continue;
        // Expansion is optional at execution: another listing may have a short
        // description. Keep only a selector supported by both demonstrations.
        const compiledExpand=expand?{...expand,text:'See more' as const}:undefined;
        const candidate={kind:'page-url-fields-v1' as const,...base,fields,...(compiledExpand?{expand:compiledExpand}:{})};
        return pageReplaySchema.parse(candidate);
      }
      const match=first.selectors.find(a=>second.selectors.some(b=>a.selector===b.selector&&a.index===b.index));if(!match)continue;
      return pageReplaySchema.parse({kind:'page-url-text-v1',...base,...match});
    }
  }catch{/* Unsupported evidence leaves the successful task usable. */}
  return null;
}

function sameLocated(a:Located,b:Located){
  return a.selector===b.selector&&a.index===b.index&&a.mode===b.mode&&a.label===b.label&&a.valueSelector===b.valueSelector&&a.scope?.selector===b.scope?.selector&&a.scope?.index===b.scope?.index
    &&a.scope?.anchor?.selector===b.scope?.anchor?.selector&&a.scope?.anchor?.index===b.scope?.anchor?.index&&a.scope?.anchor?.depth===b.scope?.anchor?.depth;
}

async function resolveScope(page:Page,scope:NonNullable<Located['scope']>){
  if(scope.anchor){
    const anchor=scope.anchor,headings=page.locator('h1:visible');
    await headings.first().waitFor({state:'visible',timeout:10_000});
    if(anchor.selector!=='h1'||anchor.index!==0||await headings.count()!==1)throw new Error('Page replay title anchor is ambiguous.');
    const title=headings.nth(0),area=title.locator(`xpath=ancestor::*[${anchor.depth}]`);
    await area.waitFor({state:'visible',timeout:10_000});
    const valid=await area.count()===1&&await area.evaluate((el,selector)=>{
      if(!el.matches(selector))return false;
      const headings=[...document.querySelectorAll('h1')].filter(node=>node instanceof HTMLElement&&node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
      if(headings.length!==1||!el.contains(headings[0]!))return false;
      const candidates=[...document.querySelectorAll(selector)].filter(candidate=>candidate.contains(headings[0]!));
      return candidates.length===1&&candidates[0]===el;
    },scope.selector);
    if(!valid)throw new Error('Page replay listing scope is ambiguous.');
    return area;
  }
  return page.locator(scope.selector).nth(scope.index);
}

async function located(page:Page,item:Located){
  if(item.mode==='label-value'){
    if(!item.label||!item.valueSelector)throw new Error('Page replay label-value locator is incomplete.');
    const area=item.scope?await resolveScope(page,item.scope):page;
    const rows=await area.locator(item.selector).all(),matches=[] as import('playwright-core').Locator[];
    for(const row of rows){
      const labels=await row.locator('strong').allInnerTexts();
      if(labels.filter(label=>label.trim()===item.label).length===1)matches.push(row);
    }
    if(matches.length!==1)throw new Error('Page replay label is missing or ambiguous.');
    const values=await matches[0]!.locator(item.valueSelector).all();
    if(values.length!==1)throw new Error('Page replay labeled value is missing or ambiguous.');
    return values[0]!;
  }
  return item.scope?(await resolveScope(page,item.scope)).locator(item.selector).nth(item.index)
    :page.locator(item.selector).nth(item.index);
}

export function materializePageUrl(plan:PageReplay,input:unknown):string{
  const p=pageReplaySchema.parse(plan);
  if(!input||typeof input!=='object'||Object.keys(input).length!==1)throw new Error('Page replay input mismatch.');
  const value=(input as Record<string,unknown>)[p.inputName];if(typeof value!=='string'||!value||value.length>=200||value==='.'||value==='..')throw new Error('Page replay input mismatch.');
  const url=new URL(p.origin);url.pathname=p.path.map(x=>encodeURIComponent(typeof x==='string'?x:value)).join('/');
  for(const q of p.query)url.searchParams.append(q.name,typeof q.value==='string'?q.value:value);
  if(url.origin!==p.origin)throw new Error('Page replay origin mismatch.');return url.href;
}
export function stablePageReplay(plan:PageReplay){const p=pageReplaySchema.parse(plan);return p.status==='stable'&&p.heldout.length===2;}
export function recordPageShadow(plan:PageReplay,input:unknown,matches:boolean):PageReplay{
  materializePageUrl(plan,input);const p=pageReplaySchema.parse(plan);if(!matches)p.status='degraded';else if(p.status!=='degraded'){
    const key=hash((input as Record<string,string>)[p.inputName]!);if(!p.training.includes(key)&&!p.heldout.includes(key)&&p.heldout.length<2)p.heldout.push(key);
    if(p.heldout.length===2)p.status='stable';
  }return p;
}
export async function replayPage(context:BrowserContext,plan:PageReplay,input:unknown,signal?:AbortSignal){
  const p=pageReplaySchema.parse(plan),started=performance.now(),url=materializePageUrl(p,input),page=await context.newPage(),stop=trackWorkflowAuth(context);
  const abort=()=>{void page.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)throw new Error('Page replay aborted.');const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30_000});
    if(!response||response.status()!==200||new URL(page.url()).origin!==p.origin)throw new Error('Page replay navigation refused.');
    await assertWorkflowAuth(page,p.origin);
    if(p.kind==='page-url-fields-v1'&&p.expand){
      const target=await located(page,p.expand);
      if(p.expand.scope){
        const area=await resolveScope(page,p.expand.scope);
        const count=await target.count();
        const candidateIsExpected=count===1&&await target.isVisible().catch(()=>false)
          &&(await target.innerText()).trim()==='See more';
        if(candidateIsExpected){
          if(await target.evaluate(el=>el.tagName==='A'||(el instanceof HTMLButtonElement&&el.type==='submit')||el.getAttribute('role')!=='button'&&el.tagName!=='BUTTON'))throw new Error('Page replay expansion refused.');
          await target.click({timeout:5_000});
        }else{
          const alternatives=await area.locator('button,[role="button"]').evaluateAll(els=>els.filter(el=>el instanceof HTMLElement&&el.innerText.trim()==='See more'&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length);
          if(alternatives)throw new Error('Page replay expansion refused.');
        }
      }else{
        const count=await target.count();
        const candidateIsExpected=count===1&&await target.isVisible().catch(()=>false)
          &&(await target.innerText()).trim()==='See more';
        if(candidateIsExpected){
          if(await target.evaluate(el=>el.tagName==='A'||(el instanceof HTMLButtonElement&&el.type==='submit')||el.getAttribute('role')!=='button'&&el.tagName!=='BUTTON'))throw new Error('Page replay expansion refused.');
          await target.click({timeout:5_000});
        }else{
          const alternatives=await page.locator('button,[role="button"]').evaluateAll(els=>els.filter(el=>el instanceof HTMLElement&&el.innerText.trim()==='See more'&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length);
          if(alternatives)throw new Error('Page replay expansion refused.');
        }
      }
    }
    if(p.kind==='page-url-fields-v1'&&!p.expand){
      const anchored=[...p.fields].filter(f=>f.scope?.anchor).sort((a,b)=>(b.scope?.anchor?.depth??0)-(a.scope?.anchor?.depth??0))[0];
      const area=anchored?.scope?await resolveScope(page,anchored.scope):page;
      const unobserved=await area.locator('button,[role="button"]').evaluateAll(els=>els.filter(el=>el instanceof HTMLElement&&el.innerText.trim()==='See more'&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length);
      if(unobserved)throw new Error('Page replay encountered an unobserved expansion.');
    }
    let data:unknown;
    if(p.kind==='page-url-text-v1'){
      const target=page.locator(p.selector).nth(p.index);await target.waitFor({state:'visible',timeout:10_000});data=(await target.innerText({timeout:5_000})).trim();
      if(typeof data!=='string'||!data||data.length>4000)throw new Error('Page replay output unavailable.');
    }else{
      const object:Record<string,string>={};for(const f of p.fields){const target=await located(page,f);await target.waitFor({state:'visible',timeout:10_000});
        const value=f.mode==='own-text'?await target.evaluate(el=>[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent??'').join('').trim())
          :(await target.innerText({timeout:5_000})).trim();
        if(!value||value.length>4000)throw new Error('Page replay output unavailable.');object[f.name]=value;}
      data=object;
    }
    return {data,durationMs:performance.now()-started};
  }finally{signal?.removeEventListener('abort',abort);stop();await page.close();}
}
