import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { TaskSession } from './task-session.js';
import { WorkflowAccessError, assertWorkflowAuth } from './workflow-auth.js';

const origin='https://www.gumtree.com.au';
// Leave room below the Core's 90-second call limit for browser startup and
// verified shutdown; page reads stop 50 seconds after entering this function.
const readBudgetMs=50_000;
const batchPageBudgetMs=10_000;
const singlePageBudgetMs=45_000;

function exactListing(inputUrl:string){
  const url=new URL(inputUrl);
  if(url.origin!==origin||url.search||url.hash||url.username||url.password||
    !/^\/web\/listing\/[a-z0-9-]+\/\d+\/?$/.test(url.pathname))
    throw new Error('Gumtree URL outside exact public-listing scope.');
  return {url,id:url.pathname.split('/').filter(Boolean).at(-1)!,canonicalPath:url.pathname.replace(/\/$/,'')};
}

async function readPage(page:Page,url:URL){
  let mainDocumentStatus:number|undefined;
  page.on('response',response=>{
    try{
      const request=response.request();
      if(request.isNavigationRequest()&&request.frame()===page.mainFrame())
        mainDocumentStatus=response.status();
    }catch{/* Detached frame is not a document-status signal. */}
  });
  try{
    const response=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30_000});
    const status=response?.status();
    if(status===401)return {status:'auth-required' as const,url:url.href};
    if(status===403)return {status:'blocked' as const,url:url.href};
    if(status===404||status===410)return {status:'unavailable' as const,url:url.href};
    if(status!==200)return {status:'incomplete' as const,reason:'unexpected-http-status' as const,url:url.href};
    try{await assertWorkflowAuth(page,origin);}
    catch(error){if(error instanceof WorkflowAccessError)
      return {status:error.reason==='http-403'?'blocked' as const:'auth-required' as const,url:url.href};
      throw error;}
    if(page.url()!==url.href)return {status:'incomplete' as const,reason:'redirected' as const,url:url.href};
    const title=(await page.locator('h1').first().innerText({timeout:8_000}).catch(()=>''))
      .replace(/\s+/g,' ').trim();
    if(title==='Access Denied')return {status:'blocked' as const,url:url.href};
    if(/^(?:listing not found|this ad is no longer available)$/i.test(title))
      return {status:'unavailable' as const,url:url.href};
    const lines=(await page.locator('body').innerText({timeout:8_000}))
      .slice(0,50_000).split('\n').map(line=>line.trim()).filter(Boolean);
    if(lines[0]==='Access Denied')return {status:'blocked' as const,url:url.href};
    const askingPrice=lines.find(line=>/^\$[\d,]+(?:\.\d{2})?(?:\s+(?:firm|negotiable))?$/i.test(line));
    const location=lines.find(line=>/^[^,]{2,80},\s*(?:NSW|VIC|QLD|SA|WA|TAS|ACT|NT)$/.test(line));
    const conditionAt=lines.findIndex(line=>/^Condition$/i.test(line));
    const condition=conditionAt>=0?lines[conditionAt+1]:undefined;
    const descriptionAt=lines.findIndex(line=>/^Description$/i.test(line));
    const end=lines.findIndex((line,index)=>index>descriptionAt&&/^(?:Get in touch|More from this seller|Similar ads)$/i.test(line));
    const description=descriptionAt>=0
      ?lines.slice(descriptionAt+1,end>=0?end:descriptionAt+30).join(' ').slice(0,4_000)
      :undefined;
    if(!title||!askingPrice||!location||!condition||!description)
      return {status:'incomplete' as const,reason:'missing-required-fields' as const,url:url.href};
    return {status:'complete' as const,url:url.href,
      data:{title,askingPrice,location,condition,description}};
  }catch(error){
    if(mainDocumentStatus===403)return {status:'blocked' as const,reason:'http-403' as const,url:url.href};
    if(mainDocumentStatus===401)return {status:'auth-required' as const,reason:'http-401' as const,url:url.href};
    if(mainDocumentStatus===404||mainDocumentStatus===410)
      return {status:'unavailable' as const,reason:'http-not-found' as const,url:url.href};
    if(error instanceof WorkflowAccessError)
      return {status:error.reason==='http-403'?'blocked' as const:'auth-required' as const,url:url.href};
    // A page read can time out or drift after navigation. Do not claim that
    // the listing is absent or return partial price fields as a complete read.
    return {status:'incomplete' as const,reason:'page-read-failed' as const,url:url.href};
  }
}

/** Explicit browser fallback for exact public pages. A batch shares one
 * browser context but each URL has its own page and typed outcome. There is no
 * compiled replay claim and no authenticated Gumtree profile. */
export async function readGumtreePublicListings(inputUrls:string[],dataDirectory:string){
  if(inputUrls.length<1||inputUrls.length>8)throw new Error('Gumtree batch must contain 1–8 URLs.');
  const listings=inputUrls.map(exactListing);
  if(new Set(listings.map(item=>item.canonicalPath)).size!==listings.length)
    throw new Error('Gumtree batch contains duplicate URLs.');
  const pageBudgetMs=listings.length===1?singlePageBudgetMs:batchPageBudgetMs;
  const started=performance.now();
  const session=new TaskSession(origin,resolve(dataDirectory,'profiles','gumtree-public'),true);
  await session.start();
  try{
    const rows=[];
    for(const listing of listings){
      const remainingMs=readBudgetMs-(performance.now()-started);
      if(remainingMs<=0){
        rows.push({id:listing.id,url:listing.url.href,status:'incomplete' as const,
          reason:'batch-deadline-exceeded' as const,durationMs:0});
        continue;
      }
      const began=performance.now();
      const page=await session.context.newPage();
      const timer=setTimeout(()=>{void page.close().catch(()=>{});},Math.min(pageBudgetMs,remainingMs));
      try{
        rows.push({id:listing.id,...await readPage(page,listing.url),durationMs:performance.now()-began});
      }finally{clearTimeout(timer);await page.close().catch(()=>{});}
    }
    return {rows,wallDurationMs:performance.now()-started};
  }finally{await session.close();}
}

export async function readGumtreePublicListing(inputUrl:string,dataDirectory:string){
  const result=await readGumtreePublicListings([inputUrl],dataDirectory);
  const {id:_id,durationMs:_durationMs,...row}=result.rows[0]!;
  return row;
}
