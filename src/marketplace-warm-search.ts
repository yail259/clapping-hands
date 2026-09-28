import type { BrowserContext, Page, Request } from 'playwright-core';
import { WorkflowAccessError, assertWorkflowAuth } from './workflow-auth.js';

export type MarketplaceCard = { title:string; priceAud:number; previousPriceAud:number|null; location:string; url:string };
export type MarketplaceSearchAge = '1d' | '7d' | 'any';
export type MarketplaceSearchSort = 'newest' | 'relevance';
export type MarketplaceSearchContinuation = {requestedLimit:number;scrollRounds:number;distinctObserved:number;
  state:'limit-reached'|'scroll-budget-reached'};
type Listing = { id?:unknown; marketplace_listing_title?:unknown;
  listing_price?:{formatted_amount?:unknown}; strikethrough_price?:{formatted_amount?:unknown}|null;
  location?:{reverse_geocode?:{city?:unknown;state?:unknown}} };
const bootstrapQuery='playstation 5 console';
const origin='https://www.facebook.com';
const price=(value:unknown):number|null=>{
  if(value==='Free')return 0;
  if(typeof value!=='string')return null;
  const match=/^(?:AU)?\$([\d,.]+)$/.exec(value);
  return match?Number(match[1]!.replace(/,/g,'')):null;
};
const fromListing=(listing:Listing):MarketplaceCard|null=>{
  const amount=price(listing.listing_price?.formatted_amount);
  const previous=listing.strikethrough_price?price(listing.strikethrough_price.formatted_amount):null;
  const city=listing.location?.reverse_geocode?.city,state=listing.location?.reverse_geocode?.state;
  if(typeof listing.id!=='string'||!/^\d+$/.test(listing.id)||
    typeof listing.marketplace_listing_title!=='string'||!listing.marketplace_listing_title.trim()||
    amount===null||!Number.isFinite(amount)||previous!==null&&!Number.isFinite(previous)||
    typeof city!=='string'||typeof state!=='string')return null;
  return {title:listing.marketplace_listing_title.replace(/\s+/g,' ').trim(),priceAud:amount,
    previousPriceAud:previous,location:`${city}, ${state}`,url:`${origin}/marketplace/item/${listing.id}/`};
};
const fromLabel=(label:string,href:string):MarketplaceCard|null=>{
  const id=/\/marketplace\/item\/(\d+)/.exec(href)?.[1];if(!id)return null;
  let stem=label.replace(/, listing \d+$/,'');if(stem===label)return null;
  const locationMatch=/, ([^,]+), (NSW|ACT|VIC|QLD)$/.exec(stem);if(!locationMatch)return null;
  const location=`${locationMatch[1]}, ${locationMatch[2]}`;stem=stem.slice(0,locationMatch.index);
  const previousMatch=/, reduced from AU\$([\d,.]+)$/.exec(stem);
  const previousPriceAud=previousMatch?Number(previousMatch[1]!.replace(/,/g,'')):null;
  if(previousMatch)stem=stem.slice(0,previousMatch.index);
  const amountMatch=/, (AU\$[\d,.]+|Free)$/.exec(stem);if(!amountMatch)return null;
  const priceAud=amountMatch[1]==='Free'?0:Number(amountMatch[1]!.slice(3).replace(/,/g,''));
  const title=stem.slice(0,amountMatch.index).replace(/\s+/g,' ').trim();
  return title&&Number.isFinite(priceAud)?{title,priceAud,previousPriceAud,location,
    url:`${origin}/marketplace/item/${id}/`}:null;
};
const urlFor=(query:string,age:MarketplaceSearchAge='1d',sort:MarketplaceSearchSort='newest')=>{
  const url=new URL('/marketplace/sydney/search',origin);
  if(age!=='any')url.searchParams.set('daysSinceListed',age==='1d'?'1':'7');
  if(sort==='newest')url.searchParams.set('sortBy','creation_time_descend');
  url.searchParams.set('query',query);url.searchParams.set('exact','false');url.searchParams.set('radius','100');
  return url.href;
};
const visibleCards=async(page:Page):Promise<MarketplaceCard[]>=>{
  await page.locator('a[aria-label][href*="/marketplace/item/"]').first().waitFor({timeout:12000});
  const rows=await page.locator('a[aria-label][href*="/marketplace/item/"]').evaluateAll(anchors=>
    anchors.map(anchor=>({label:anchor.getAttribute('aria-label')??'',href:anchor.getAttribute('href')??''})));
  const cards=rows.map(row=>fromLabel(row.label,row.href));
  if(!cards.length||cards.length>24||cards.some(card=>!card))throw new Error('Visible search cards changed.');
  return cards as MarketplaceCard[];
};

/** When the compiled HTML search misses a client-rendered result page, read
 * the exact visible card contract in the same authenticated browser context.
 * No network recipe or saved listing data is substituted for current UI. */
export async function readMarketplaceVisibleCards(context:BrowserContext,query:string,signal?:AbortSignal,
  age:MarketplaceSearchAge='1d',sort:MarketplaceSearchSort='newest',limit=24){
  if(!Number.isInteger(limit)||limit<1||limit>48)throw new Error('Visible search limit outside 1–48.');
  signal?.throwIfAborted();
  const page=await context.newPage();
  const cancel=()=>{void page.close().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  try{
    const url=urlFor(query,age,sort);
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:15_000});
    if(response?.status()===401||response?.status()===403)
      throw new WorkflowAccessError(response.status()===401?'http-401':'http-403',origin);
    await assertWorkflowAuth(page,origin);
    if(!response||response.status()!==200||response.url()!==url||response.request().redirectedFrom())
      throw new Error('Visible Marketplace search navigation refused.');
    await page.locator('a[aria-label][href*="/marketplace/item/"]').first().waitFor({timeout:12000});
    const requested=new URL(url);
    const filterKeys=[...(age==='any'?[]:['daysSinceListed']),
      ...(sort==='newest'?['sortBy']:[]),'query','exact','radius'];
    const verifyFilters=()=>{
      const current=new URL(page.url());
      if(current.origin!==requested.origin||current.pathname!==requested.pathname||current.hash||
        [...current.searchParams.keys()].length!==filterKeys.length||
        filterKeys.some(key=>current.searchParams.getAll(key).length!==1||
          current.searchParams.get(key)!==requested.searchParams.get(key)))
        throw new Error('Visible Marketplace search filters changed.');
    };
    const readRows=()=>page.locator('a[aria-label][href*="/marketplace/item/"]').evaluateAll(anchors=>
      anchors.map(anchor=>({label:anchor.getAttribute('aria-label')??'',href:anchor.getAttribute('href')??''})));
    verifyFilters();
    if(limit<=24){
      // Preserve the existing single-tranche contract and failure behavior.
      const rows=await readRows();
      if(!rows.length||rows.length>24)throw new Error('Visible Marketplace search cards changed.');
      const cards:MarketplaceCard[]=[];
      const seen=new Set<string>();
      let rejectedCount=0;
      for(const row of rows){
        let href:URL;
        try{href=new URL(row.href,origin);}catch{rejectedCount++;continue;}
        const card=href.origin===origin&&!href.username&&!href.password&&
          /^\/marketplace\/item\/\d{8,20}\/?$/.test(href.pathname)
          ?fromLabel(row.label,row.href):null;
        if(!card||seen.has(card.url)){rejectedCount++;continue;}
        seen.add(card.url);cards.push(card);
      }
      if(!cards.length)throw new Error('Visible Marketplace search yielded no verified cards.');
      signal?.throwIfAborted();
      return {cards,visibleCount:rows.length,rejectedCount};
    }
    // A single checked page may reveal further cards only after multiple UI
    // scrolls. Keep a bounded union because the page can virtualize old rows.
    const cards:MarketplaceCard[]=[];
    const seen=new Set<string>();
    const rejected=new Set<string>();
    let visibleCount=0;
    for(let round=0;round<=4;round++){
      signal?.throwIfAborted();
      if(round){await assertWorkflowAuth(page,origin);verifyFilters();}
      const rows=await readRows();
      if(!rows.length||rows.length>96)throw new Error('Visible Marketplace continuation cards changed.');
      visibleCount=rows.length;
      for(const row of rows){
        let href:URL;
        try{href=new URL(row.href,origin);}catch{rejected.add(`${row.href}\u0000${row.label}`);continue;}
        const id=/^\/marketplace\/item\/(\d{8,20})\/?$/.exec(href.pathname)?.[1];
        const card=href.origin===origin&&!href.username&&!href.password&&
          id&&row.label.endsWith(`, listing ${id}`)?fromLabel(row.label,row.href):null;
        if(!card){rejected.add(`${row.href}\u0000${row.label}`);continue;}
        if(seen.has(card.url))continue;
        seen.add(card.url);
        if(cards.length<limit)cards.push(card);
      }
      if(cards.length===limit||round===4){
        if(!cards.length)throw new Error('Visible Marketplace search yielded no verified cards.');
        signal?.throwIfAborted();
        return {cards,visibleCount,rejectedCount:rejected.size,
          continuation:{requestedLimit:limit,scrollRounds:round,distinctObserved:seen.size,
            state:cards.length===limit?'limit-reached' as const:'scroll-budget-reached' as const}};
      }
      await page.locator('a[href*="/marketplace/item/"]').last().scrollIntoViewIfNeeded().catch(()=>{});
      await page.mouse.wheel(0,4000);
      // Marketplace may add one card first, then a larger second tranche. Wait
      // only until the next visible batch grows, with a finite timeout for a
      // stalled or virtualized page before trying one more UI scroll.
      await page.waitForFunction(previous=>
        document.querySelectorAll('a[aria-label][href*="/marketplace/item/"]').length>previous,
      visibleCount,{timeout:2000,polling:200}).catch(()=>{});
    }
    throw new Error('Visible Marketplace continuation stopped unexpectedly.');
  }finally{
    signal?.removeEventListener('abort',cancel);
    await page.close().catch(()=>{});
  }
}
const exactCards=(a:MarketplaceCard[],b:MarketplaceCard[])=>a.length===b.length&&a.every((card,index)=>
  card.title===b[index]!.title&&card.priceAud===b[index]!.priceAud&&
  card.previousPriceAud===b[index]!.previousPriceAud&&card.location===b[index]!.location&&card.url===b[index]!.url);

/** Owns one browser page and a captured, page/session-bound search request.
 * It is discarded after 30 seconds or whenever the browser session changes. */
export class MarketplaceWarmSearch {
  readonly expiresAt=performance.now()+30_000;
  private timer?:ReturnType<typeof setTimeout>;
  private constructor(readonly context:BrowserContext,private readonly page:Page,
    private request:Request|undefined,private form:URLSearchParams|undefined,
    private variables:Record<string,unknown>|undefined) {
    this.timer=setTimeout(()=>{void this.close();},30_000);this.timer.unref();
  }
  get usable(){return performance.now()<this.expiresAt&&!!this.request&&!!this.form&&!!this.variables&&
    !this.page.isClosed()&&this.page.context()===this.context;}
  async close(){if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    this.request=undefined;this.form=undefined;this.variables=undefined;await this.page.close().catch(()=>{});}
  async search(query:string,signal?:AbortSignal):Promise<{cards:MarketplaceCard[];durationMs:number}>{
    signal?.throwIfAborted();
    if(!this.usable||!query.trim()||query.length>100)throw new Error('Warm search context unavailable.');
    const request=this.request!,form=this.form!;
    const changed=new URLSearchParams(form);
    const variables=structuredClone(this.variables!) as {cursor?:string|null;params?:{bqf?:{query?:string}}};
    if(!variables.params?.bqf)throw new Error('Warm search variables changed.');
    variables.cursor=null;variables.params.bqf.query=query;
    changed.set('variables',JSON.stringify(variables));
    const started=performance.now();
    const cancel=()=>{void this.close();};
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    let response:{status:number;text:string};
    try{response=await this.page.evaluate(async({url,body,lsd})=>{
      const result=await fetch(url,{method:'POST',credentials:'include',
        headers:{'content-type':'application/x-www-form-urlencoded','x-fb-lsd':lsd},body});
      return {status:result.status,text:await result.text()};
    },{url:request.url(),body:changed.toString(),lsd:form.get('lsd')!});}
    finally{signal?.removeEventListener('abort',cancel);}
    signal?.throwIfAborted();
    if(response.status!==200||response.text.length>1_000_000)throw new Error('Warm search response refused.');
    const start=response.text.indexOf('{');if(start<0)throw new Error('Warm search response codec changed.');
    const payload=JSON.parse(response.text.slice(start)) as {data?:{marketplace_search?:{feed_units?:{
      edges?:Array<{node?:{listing?:Listing}}>}}}};
    const edges=payload.data?.marketplace_search?.feed_units?.edges;
    if(!Array.isArray(edges)||edges.length>24)throw new Error('Warm search response shape changed.');
    const cards=edges.map(edge=>edge.node?.listing?fromListing(edge.node.listing):null);
    if(cards.some(card=>!card))throw new Error('Warm search card fields changed.');
    const valid=cards as MarketplaceCard[];
    if(new Set(valid.map(card=>card.url)).size!==valid.length)throw new Error('Warm search repeated a card.');
    return {cards:valid,durationMs:performance.now()-started};
  }
  static async bootstrap(context:BrowserContext,signal?:AbortSignal):Promise<MarketplaceWarmSearch>{
    signal?.throwIfAborted();
    const page=await context.newPage();
    const cancel=()=>{void page.close().catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    try{
      let captured:Request|undefined;
      page.on('request',request=>{
        if(captured||request.method()!=='POST'||new URL(request.url()).origin!==origin||
          new URL(request.url()).pathname!=='/api/graphql/')return;
        const form=new URLSearchParams(request.postData()??'');
        if(form.get('fb_api_req_friendly_name')==='CometMarketplaceSearchContentPaginationQuery')captured=request;
      });
      const url=urlFor(bootstrapQuery);
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25_000});
      if(!response||response.status()!==200||new URL(page.url()).origin!==origin||
        new URL(page.url()).pathname!=='/marketplace/sydney/search')throw new Error('Bootstrap search navigation refused.');
      const visible=await visibleCards(page);
      for(let index=0;index<6&&!captured;index++){
        await page.locator('a[href*="/marketplace/item/"]').last().scrollIntoViewIfNeeded().catch(()=>{});
        await page.mouse.wheel(0,4500);await page.waitForTimeout(700);
      }
      if(!captured)throw new Error('Search pagination context unavailable.');
      const request=captured as Request,form=new URLSearchParams(request.postData()??'');
      if(!form.get('lsd')||!form.get('doc_id')||!form.get('variables'))throw new Error('Search context incomplete.');
      const variables=JSON.parse(form.get('variables')!) as Record<string,unknown>;
      signal?.throwIfAborted();
      const lease=new MarketplaceWarmSearch(context,page,request,form,variables);
      try{
        const network=await lease.search(bootstrapQuery,signal);
        if(!exactCards(visible,network.cards))throw new Error('Warm search bootstrap differs from visible cards.');
        return lease;
      }catch(error){await lease.close();throw error;}
    }catch(error){await page.close().catch(()=>{});throw error;}
    finally{signal?.removeEventListener('abort',cancel);}
  }
}
