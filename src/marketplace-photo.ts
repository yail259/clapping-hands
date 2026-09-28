import type { BrowserContext, Page } from 'playwright-core';
import { WorkflowAccessError, assertWorkflowAuth } from './workflow-auth.js';

export type MarketplacePhotoPosition = number | 'last';
export type MarketplacePhotoOutcome =
  | { status:'complete'; itemId:string; url:string; requestedPosition:MarketplacePhotoPosition;
      photoIndex:number; photoCount:number; captureScope:'product-photo'; image:Buffer }
  | { status:'incomplete'|'unavailable'|'blocked'|'auth-required'; itemId:string; url:string;
      requestedPosition:MarketplacePhotoPosition; reason:string };

const origin = 'https://www.facebook.com';
const maxPhotos = 12;
// The Core broker limits the complete serialized MCP result to 1 MiB. One
// JPEG below this binary cap leaves room for base64 and response metadata.
const maxImageBytes = 450_000;
const photoScreenshotStyle = '[aria-label="View previous image"], [aria-label="View next image"] { visibility: hidden !important; }';

class PhotoIncomplete extends Error {
  constructor(readonly reason:string) { super(reason); }
}

async function activeProductPhoto(page:Page, title:string) {
  const expectedAlt = `Product photo of ${title}`.replace(/\s+/g,' ').trim();
  const candidates = page.locator('img[alt^="Product photo of "]:visible');
  const matches = await candidates.evaluateAll((images,expected) => images.flatMap((node,index) => {
    if (!(node instanceof HTMLImageElement) || node.alt.replace(/\s+/g,' ').trim() !== expected)
      return [];
    const rect=node.getBoundingClientRect();
    return rect.width >= 300 && rect.height >= 300 ? [index] : [];
  }),expectedAlt);
  if (matches.length !== 1) throw new PhotoIncomplete('product-photo-ambiguous');
  return candidates.nth(matches[0]!);
}

async function backdropSource(page:Page):Promise<string> {
  const sources=await page.locator('img:visible').evaluateAll(images=>images.flatMap(node=>{
    if(!(node instanceof HTMLImageElement)||node.alt!=='')return [];
    const rect=node.getBoundingClientRect();
    return rect.width>=600&&rect.height>=600&&node.complete&&node.naturalWidth>=400
      ? [node.currentSrc] : [];
  }));
  if(sources.length!==1||!sources[0])throw new PhotoIncomplete('initial-photo-unverified');
  return sources[0];
}

async function photoButtons(page:Page):Promise<number[]> {
  const labels = await page.locator('[role="button"][aria-label^="View photo "]:visible').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('aria-label') ?? ''));
  const numbers = labels.map(label => /^View photo (\d+)$/.exec(label)?.[1]).map(value => Number(value));
  const unique = [...new Set(numbers)].sort((a,b)=>a-b);
  if (!unique.length || unique.length > maxPhotos ||
    unique.some((value,index)=>!Number.isSafeInteger(value)||value!==index+1) ||
    unique.length !== numbers.length) throw new PhotoIncomplete('photo-count-unverified');
  return unique;
}

/** Read one visible product photo through the same leased browser profile as
 * the text reader. Browser/CDN URLs never become part of this result. */
export async function readMarketplacePhoto(context:BrowserContext,url:string,itemId:string,
  requestedPosition:MarketplacePhotoPosition,signal?:AbortSignal):Promise<MarketplacePhotoOutcome> {
  const page=await context.newPage();
  const onAbort=()=>{void page.close().catch(()=>{});};
  signal?.addEventListener('abort',onAbort,{once:true});
  try {
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25_000});
    if (!response) throw new PhotoIncomplete('document-unverified');
    if (response.status()===403) return {status:'blocked',itemId,url,requestedPosition,reason:'http-403'};
    if (response.status()===401) return {status:'auth-required',itemId,url,requestedPosition,reason:'http-401'};
    if (response.status()===404||response.status()===410)
      return {status:'unavailable',itemId,url,requestedPosition,reason:'http-unavailable'};
    if (response.status()!==200) throw new PhotoIncomplete('document-unverified');
    await assertWorkflowAuth(page,origin);
    if (page.url()!==url) throw new PhotoIncomplete('item-url-changed');
    const headings=page.locator('h1:visible');
    await headings.first().waitFor({timeout:8_000});
    if (await headings.count()!==1) throw new PhotoIncomplete('item-heading-ambiguous');
    const title=(await headings.first().innerText()).replace(/\s+/g,' ').trim();
    if (!title) throw new PhotoIncomplete('item-heading-missing');
    const positions=await photoButtons(page);
    const photoIndex=requestedPosition==='last'?positions.length:requestedPosition;
    if (!positions.includes(photoIndex)) throw new PhotoIncomplete('photo-position-unverified');
    const previousSource=photoIndex>1?await backdropSource(page):undefined;
    try { await page.getByRole('button',{name:`View photo ${photoIndex}`,exact:true}).click({timeout:5_000}); }
    catch {
      await assertWorkflowAuth(page,origin);
      throw new PhotoIncomplete('photo-control-unavailable');
    }
    const expectedAlt=`Product photo of ${title}`.replace(/\s+/g,' ').trim();
    await page.waitForFunction(({alt,before,requireChange})=>{
      const visible=(node:HTMLImageElement)=>{
        const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
        return rect.width>=300&&rect.height>=300&&style.display!=='none'&&style.visibility==='visible';
      };
      if(requireChange){
        const backdrops=[...document.querySelectorAll('img')].filter((node):node is HTMLImageElement=>
          node instanceof HTMLImageElement&&node.alt===''&&visible(node)&&
          node.getBoundingClientRect().width>=600&&node.getBoundingClientRect().height>=600);
        if(backdrops.length!==1||backdrops[0]!.currentSrc===before)return false;
      }
      const photos=[...document.querySelectorAll('img')].filter((node):node is HTMLImageElement=>
        node instanceof HTMLImageElement&&node.alt.replace(/\s+/g,' ').trim()===alt&&visible(node));
      if(photos.length!==1)return false;
      const image=photos[0]!,style=getComputedStyle(image);
      return image.complete&&image.naturalWidth>=400&&image.naturalHeight>=400&&style.filter==='none';
    },{alt:expectedAlt,before:previousSource,requireChange:photoIndex>1},{timeout:9_000});
    const image=await activeProductPhoto(page,title);
    await image.evaluate(async node=>{if(node instanceof HTMLImageElement)await node.decode();},undefined,{timeout:3_000});
    const unobscured=await image.evaluate(node=>{
      const rect=node.getBoundingClientRect();
      const top=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      return top===node;
    });
    if(!unobscured)throw new PhotoIncomplete('product-photo-obscured');
    // Element capture excludes Facebook chrome, account controls and seller
    // panel. Re-encoding as JPEG also strips source-image metadata.
    let imageBytes=await image.screenshot({type:'jpeg',quality:72,timeout:8_000,animations:'disabled',
      style:photoScreenshotStyle});
    if (imageBytes.length>maxImageBytes)
      imageBytes=await image.screenshot({type:'jpeg',quality:45,timeout:8_000,animations:'disabled',
        style:photoScreenshotStyle});
    if (imageBytes.length>maxImageBytes) throw new PhotoIncomplete('photo-too-large');
    return {status:'complete',itemId,url,requestedPosition,photoIndex,photoCount:positions.length,
      captureScope:'product-photo',image:imageBytes};
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof WorkflowAccessError)
      return {status:error.reason==='http-403'?'blocked':'auth-required',itemId,url,requestedPosition,
        reason:error.reason};
    return {status:'incomplete',itemId,url,requestedPosition,
      reason:error instanceof PhotoIncomplete?error.reason:'photo-read-failed'};
  } finally {
    signal?.removeEventListener('abort',onAbort);
    await page.close().catch(()=>{});
  }
}
