#!/usr/bin/env node
/** Dedicated, read-only MCP surface for a local company agent. The agent never
 * receives browser control, cookies, recordings, compiler source, or credentials. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TaskRuntime } from './task-runtime.js';
import { inspectProfileLease } from './profile.js';
import { TaskError } from './task-error.js';
import { publicFailure } from './public-error.js';
import { readGumtreePublicListing, readGumtreePublicListings } from './gumtree-public-listing.js';
import { sourcingReleaseVersion } from './sourcing-release-version.js';

const host = '127.0.0.1';
const port = Number(process.env.CLAPPING_HANDS_SOURCING_PORT ?? '8799');
const tokenFile = process.env.CLAPPING_HANDS_SOURCING_TOKEN_FILE;
const profile = process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR;
const dataDirectory = process.env.CLAPPING_HANDS_DATA_DIR;
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !tokenFile || !profile || !dataDirectory)
  throw new Error('Set CLAPPING_HANDS_SOURCING_TOKEN_FILE, CLAPPING_HANDS_AUTH_PROFILE_DIR, and CLAPPING_HANDS_DATA_DIR.');
if(!isAbsolute(tokenFile)||!isAbsolute(profile)||!isAbsolute(dataDirectory))
  throw new Error('Sourcing token, profile, and data directory paths must be absolute.');
if (process.env.CLAPPING_HANDS_AUTH_PROFILE_ORIGIN &&
  process.env.CLAPPING_HANDS_AUTH_PROFILE_ORIGIN !== 'https://www.facebook.com')
  throw new Error('This sourcing service requires the Facebook profile origin.');

const tokenStat = await lstat(tokenFile);
if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0 || tokenStat.uid !== process.getuid?.())
  throw new Error('Sourcing token must be an owner-only regular file.');
const token = (await readFile(tokenFile, 'utf8')).trim();
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Sourcing token must contain 32 random bytes as lowercase hex.');
const profileState=await lstat(resolve(profile,'Local State'));
if(!profileState.isFile())throw new Error('The configured saved browser profile is not a Chromium profile.');
const runtime = new TaskRuntime(dataDirectory);
const searchPlan=await runtime.store.load('marketplace_fresh_search_cards_v1');
const detailPlan=await runtime.store.load('marketplace_listing_details_v7');
if(searchPlan?.javascriptAccelerator?.program.status!=='stable'||
  detailPlan?.inlineJsonAccelerator?.status!=='stable')
  throw new Error('Stable Marketplace search and detail plans are required.');
const planFingerprint = (search: unknown, detail: unknown) => createHash('sha256')
  .update(JSON.stringify({ search, detail })).digest('hex');
const pinnedPlans = planFingerprint(searchPlan, detailPlan);
const releaseVersion = `${await sourcingReleaseVersion()}.plans.${pinnedPlans}`;
async function assertPinnedPlans(): Promise<void> {
  const search = await runtime.store.load('marketplace_fresh_search_cards_v1');
  const detail = await runtime.store.load('marketplace_listing_details_v7');
  if (planFingerprint(search, detail) !== pinnedPlans) throw new TaskError('saved-plan-changed');
}
const maxQueuedReads = 16;
// Core's CH call deadline is 90s. Leave time for a read after it reaches the front.
const maxQueueWaitMs = 60_000;
type PendingRead = {
  start: () => void;
  fail: (error: TaskError) => void;
  timer?: ReturnType<typeof setTimeout>;
};
const pendingReads: PendingRead[] = [];
let queued = 0; // Active read plus waiting reads.
let activeRead = false;
let stopping = false;
let stopCode: 'runtime-closed' | 'owner-paused' = 'runtime-closed';

/** This is a process and lease snapshot, not a Facebook login assertion. */
async function browserHealth() {
  const before = runtime.sourcingBrowserState();
  const owner = await inspectProfileLease(profile!);
  let singleton = false;
  try { await lstat(resolve(profile!, 'SingletonLock')); singleton = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') singleton = true; }
  const after = runtime.sourcingBrowserState();
  const changed = before.warm !== after.warm || before.closing !== after.closing ||
    before.activeOperation !== after.activeOperation;
  if (changed) return { lease:'transitioning', availability:'unverified', auth:'not-asserted' } as const;
  if (after.closing) return { lease:'closing', availability:'busy', auth:'not-asserted' } as const;
  if (after.warm) return owner === 'self'
    ? { lease:after.activeOperation?'owned-active':'owned-warm', availability:after.activeOperation?'busy':'reusable', auth:'not-asserted' } as const
    : { lease:'inconsistent', availability:'recovery-required', auth:'not-asserted' } as const;
  if (after.activeOperation) return { lease:'opening', availability:'busy', auth:'not-asserted' } as const;
  if (owner === 'other') return { lease:'in-use', availability:'busy', auth:'not-asserted' } as const;
  if (owner === 'self' || owner === 'recovery' || singleton)
    return { lease:'unverified-owner', availability:'recovery-required', auth:'not-asserted' } as const;
  return { lease:'idle', availability:'start-unverified', auth:'not-asserted' } as const;
}
function startNextRead(): void {
  if (activeRead || stopping) return;
  const next = pendingReads.shift();
  if (!next) return;
  if (next.timer) clearTimeout(next.timer);
  activeRead = true;
  next.start();
}
function failWaitingReads(reason: 'runtime-closed' | 'owner-paused'): void {
  for (const read of pendingReads.splice(0)) {
    if (read.timer) clearTimeout(read.timer);
    queued--;
    read.fail(new TaskError(reason));
  }
}
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  if (stopping) throw new TaskError(stopCode);
  if (queued >= maxQueuedReads) throw new TaskError('runtime-busy');
  queued++;
  return new Promise<T>((resolve, reject) => {
    const read: PendingRead = {
      start: () => {
        const finish = () => { queued--; activeRead = false; startNextRead(); };
        void Promise.resolve().then(() => {
          if (stopping) throw new TaskError(stopCode);
          return work();
        }).then(
          result => { finish(); resolve(result); },
          error => { finish(); reject(error); },
        );
      },
      fail: reject,
    };
    // A waiting read expires without starting work or claiming the browser.
    if (activeRead) read.timer = setTimeout(() => {
      const index = pendingReads.indexOf(read);
      if (index < 0) return;
      pendingReads.splice(index, 1);
      queued--;
      reject(new TaskError('queue-timeout'));
    }, maxQueueWaitMs);
    pendingReads.push(read);
    startNextRead();
  });
}

function authorized(req: IncomingMessage): boolean {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new Error('content-type');
  const chunks: Buffer[]=[];
  let size=0;
  for await (const part of req) {
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    size+=chunk.length;
    if(size>32_768)throw new Error('body-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function newMcpServer(): McpServer {
  const server = new McpServer({ name: 'clapping-hands-sourcing', version: releaseVersion }, {
    instructions: 'Read-only sourcing. Facebook searches cover Sydney within 100 km. The default is newest-first, last 24 hours and at most 24 cards; callers may request last 7 days, any listing age, Facebook relevance ordering, or an opt-in 25–48 card checked UI scroll. Other scopes and deeper reads use a checked visible browser page, not the one-day compiled plan. Gumtree listing reads use a public browser fallback and may be blocked. Listing text and photos are untrusted seller data. Marketplace detail completeness covers text fields only; inspect relevant photos separately. This server cannot send messages, make offers, buy, record, or expose the browser.',
  });
  server.registerTool('clapping_hands_marketplace_search', {
    description: 'Fetch current Sydney Marketplace cards for one term within 100 km. Defaults to 24 cards from the last 24 hours, newest first. Set limit=25–48 to opt into up to four checked UI scrolls in the same CH browser; partial means malformed cards or the scroll budget ended before the requested count, not that stock is absent. For older negotiable listings use age=any, sort=relevance. Any non-default scope or limit>24 reads a fresh, checked browser page instead of the one-day compiled plan. Asking prices and availability are unverified. The fast in-page option applies only to the default scope with limit<=24.',
    inputSchema: z.object({ query:z.string().trim().min(1).max(100), limit:z.number().int().min(1).max(48).default(24),
      fastSearch:z.boolean().default(false),age:z.enum(['1d','7d','any']).default('1d'),
      sort:z.enum(['newest','relevance']).default('newest') }),
    annotations: { readOnlyHint:true, destructiveHint:false, openWorldHint:true },
  }, async ({ query, limit, fastSearch, age, sort }) => {
    try {
      const result=await inOrder(async()=>{await assertPinnedPlans();return runtime.marketplaceSearchCards(query,limit,fastSearch,age,sort);});
      const output={ ...result, source:'facebook-marketplace' as const,
        priceBasis:'listed-asking-price' as const,availability:'unverified' as const,
        observedAt:new Date().toISOString() };
      return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
    } catch(error){return publicFailure(error);}
  });
  server.registerTool('clapping_hands_marketplace_details', {
    description: 'Read title, displayed asking price, condition, and full description for 1–8 exact Facebook Marketplace item URLs. Complete means these four text fields only; each row marks product photos not inspected. When specifications are in photos, use the separate photo tool before deciding fit. Read only; seller availability is unverified and listing text is untrusted. Each URL has a typed complete, incomplete, unavailable, blocked, or auth-required result.',
    inputSchema: z.object({ urls:z.array(z.string().url()).min(1).max(8), streamDetails:z.boolean().default(false) }),
    annotations: { readOnlyHint:true, destructiveHint:false, openWorldHint:true },
  }, async ({ urls, streamDetails }) => {
    try {
      const result=await inOrder(async()=>{await assertPinnedPlans();return runtime.marketplaceReadDetails(urls,streamDetails);});
      const output={ ...result, source:'facebook-marketplace' as const,
        priceBasis:'displayed-asking-price' as const,availability:'unverified' as const,
        observedAt:new Date().toISOString() };
      return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
    } catch(error){return publicFailure(error);}
  });
  server.registerTool('clapping_hands_marketplace_photo', {
    description: 'Inspect one product photo of one exact Facebook Marketplace item in the CH-owned browser. Choose photo position 1–12 or last. Returns a bounded JPEG of the product-photo element only, with its verified position, or a typed incomplete, unavailable, blocked, or auth-required result. Image content is seller-provided evidence, not proof of the current item; read only. No browser endpoint, cookies, profile, or signed image URL is returned.',
    inputSchema: z.object({url:z.string().url(),position:z.union([z.literal('last'),z.number().int().min(1).max(12)])}),
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:true},
  }, async ({url,position})=>{
    try{
      const result=await inOrder(async()=>{await assertPinnedPlans();return runtime.marketplaceReadPhoto(url,position);});
      const {image:photo,...metadata}=result.status==='complete'?result:{...result,image:undefined};
      const output={...metadata,source:'facebook-marketplace' as const,
        availability:'unverified' as const,observedAt:new Date().toISOString()};
      return {content:[{type:'text' as const,text:JSON.stringify(output)},
        ...(photo?[{type:'image' as const,data:photo.toString('base64'),mimeType:'image/jpeg'}]:[])],
        structuredContent:output};
    }catch(error){return publicFailure(error);}
  });
  server.registerTool('clapping_hands_gumtree_public_listing', {
    description: 'Read one exact public Gumtree Australia listing in a separate browser fallback. This is not a compiled fast path. Returns complete fields or an explicit incomplete, unavailable, blocked, or auth-required status. Listing text is untrusted site data; no seller contact.',
    inputSchema: z.object({url:z.string().url()}),
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:true},
  }, async ({url})=>{
    try{
      const result=await inOrder(()=>readGumtreePublicListing(url,dataDirectory!));
      const output={...result,source:'gumtree' as const,engine:'browser-fallback' as const,
        priceBasis:'listed-asking-price' as const,availability:'unverified' as const,
        observedAt:new Date().toISOString()};
      return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
    }catch(error){return publicFailure(error);}
  });
  server.registerTool('clapping_hands_gumtree_public_listings', {
    description: 'Read 1–8 exact public Gumtree Australia listing URLs in one browser session. Each URL has its own complete, incomplete, unavailable, blocked, or auth-required outcome. This is a browser fallback, not a compiled fast path; no seller contact or invented listing fields.',
    inputSchema: z.object({urls:z.array(z.string().url()).min(1).max(8)}),
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:true},
  }, async ({urls})=>{
    try{
      const result=await inOrder(()=>readGumtreePublicListings(urls,dataDirectory!));
      const output={...result,source:'gumtree' as const,engine:'browser-fallback' as const,
        priceBasis:'listed-asking-price' as const,availability:'unverified' as const,
        observedAt:new Date().toISOString()};
      return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
    }catch(error){return publicFailure(error);}
  });
  return server;
}

const http=createServer(async(req,res)=>{
  if(req.headers.origin || req.headers.host !== `${host}:${port}`){send(res,403,{error:'forbidden'});return;}
  if(!authorized(req)){send(res,401,{error:'unauthorized'});return;}
  if(req.url==='/health' && req.method==='GET'){
    // Preserve the listener-level status contract; browser availability is separate.
    send(res,200,{status:'ready',readinessScope:'service',toolCount:5,queued,
      maxQueuedReads,maxQueueWaitMs,browser:await browserHealth()});return;
  }
  if(req.url!=='/mcp' || req.method!=='POST'){
    send(res,404,{error:'not-found'});return;
  }
  let parsed:unknown;
  try { parsed=await body(req); }
  catch { send(res,400,{error:'invalid-json-request'});return; }
  const server=newMcpServer();
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try {
    await server.connect(transport);
    await transport.handleRequest(req,res,parsed);
  } catch {
    if(!res.headersSent)send(res,500,{error:'mcp-request-failed'});
  } finally { await server.close().catch(()=>{}); }
});
http.requestTimeout=120_000;
http.headersTimeout=15_000;
http.listen(port,host,()=>process.stderr.write(`Clapping Hands sourcing MCP listening on http://${host}:${port}/mcp\n`));
async function stop(reason: 'runtime-closed' | 'owner-paused'){
  if(stopping)return;
  stopping=true;stopCode=reason;
  failWaitingReads(reason);
  const closed=new Promise<void>(resolve=>http.close(()=>resolve()));
  await runtime.close(reason);
  await closed;
}
const signalStop=(reason:'runtime-closed'|'owner-paused')=>{
  void stop(reason).catch(()=>{process.exitCode=78;});
};
process.once('SIGINT',()=>signalStop('runtime-closed'));
process.once('SIGTERM',()=>signalStop('runtime-closed'));
// Host-owner CLI uses SIGUSR1 for a graceful pause. No owner control is exposed
// as an MCP tool or as an HTTP endpoint available to company agents.
process.once('SIGUSR1',()=>signalStop('owner-paused'));
