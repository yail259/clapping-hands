import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TaskStore, taskDefinitionSchema, type TaskDefinition, type SavedTask } from './task-store.js';
import { standaloneBrowserSessionProvider, type BrowserSession, type BrowserSessionProvider } from './browser-session-provider.js';
import { captureDemonstration } from './demonstration.js';
import { browserUseDemonstrator } from './browser-use-demonstrator.js';
import { assertResponseValue, projectContractValue, type JsonValue } from './response-contract.js';
import { replayGenericJsonPlan, recordGenericJsonShadow, isStableGenericJsonPlan, type GenericNetworkTrace, type NetworkInput } from './generic-network.js';
import type { HtmlEvidence } from './html-evidence.js';
import type { BrowserTaskOutcome } from './browser-task.js';
import { compilePageReplay, replayPage, stablePageReplay, recordPageShadow, type PageEvidence } from './page-replay.js';
import { saveEvidenceBundle, loadEvidenceBundle } from './evidence-bundle.js';
import { prepareJavaScriptCompilation, compilePreparedJavaScriptTask, replayJavaScriptTask, compilationContext, validateJavaScriptCandidate } from './javascript-task.js';
import { degradeCompiledProgram, recordCompiledComparison } from './compiled-program.js';
import type { BrowserModelUsage } from './model-usage.js';
import { authenticationHandoff } from './authentication-handoff.js';
import { TaskError } from './task-error.js';
import { loadSavedJsonCapture } from './saved-json-capture.js';
import { compilerInstructions } from './javascript-compiler.js';
import { CallerLearning } from './caller-learning.js';
import { DocumentUnavailableError, replayInlineJsonDocument } from './inline-json-projection.js';
import { replayStreamedInlineJsonDocument } from './streamed-inline-json-document.js';
import { MarketplaceWarmSearch, readMarketplaceVisibleCards, type MarketplaceSearchAge,
  type MarketplaceSearchSort, type MarketplaceSearchContinuation } from './marketplace-warm-search.js';
import { WorkflowAccessError, assertWorkflowAuth } from './workflow-auth.js';
import { compileInlineJsonFromDemonstrations } from './inline-json-learning.js';
import { compileRouteJsonFromDemonstrations } from './route-json-learning.js';
import { readMarketplacePhoto, type MarketplacePhotoPosition } from './marketplace-photo.js';

export type TaskExecution = { outcome: BrowserTaskOutcome; engine: 'browser-use' | 'network' | 'browser-replay' | 'document-replay'; durationMs: number;
  wallDurationMs?:number;
  modelCalls: number | null; fallback: boolean; shadowMatch?: boolean; capturedResponses: number;
  modelUsage?:BrowserModelUsage;
  evidence?: { status: 'saved'; id: string } | { status: 'failed' } };

function marketplaceItemId(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.origin !== 'https://www.facebook.com' || url.username || url.password) return undefined;
    return /^\/marketplace\/item\/(\d{8,20})\/?$/.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

export class TaskRuntime {
  readonly store: TaskStore;
  private busy = false;
  private readonly shutdown = new AbortController();
  private shutdownCode: 'runtime-closed' | 'owner-paused' = 'runtime-closed';
  private active: Promise<unknown> | undefined;
  private warm: { origin: string; profile: string; session: BrowserSession; timer?: ReturnType<typeof setTimeout> } | undefined;
  private warmClosing: Promise<void> | undefined;
  private marketplaceWarmSearch: MarketplaceWarmSearch | undefined;
  private readonly callerLearning: CallerLearning;
  constructor(readonly directory = resolve(process.env.CLAPPING_HANDS_DATA_DIR ?? '.data/alpha'),
    private readonly browserSessions: BrowserSessionProvider = standaloneBrowserSessionProvider) {
    this.store = new TaskStore(resolve(directory, 'tasks'));
    this.callerLearning = new CallerLearning(this.store, directory, origin => this.profile(origin), this.shutdown.signal,
      this.browserSessions);
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.shutdown.signal.aborted) throw new TaskError(this.shutdownCode);
    if (this.busy) throw new TaskError('runtime-busy');
    this.busy = true;
    const active = fn(); this.active = active;
    try { return await active; } finally { this.busy = false; this.active = undefined; }
  }
  async close(reason: 'runtime-closed' | 'owner-paused' = 'runtime-closed') {
    this.shutdownCode = reason;
    this.shutdown.abort();
    // An opt-in in-page search can be waiting inside page.evaluate. Closing its
    // page now lets owner pause release the profile without waiting for fetch.
    await this.marketplaceWarmSearch?.close().catch(() => {});
    await this.callerLearning.cancel().catch(() => {});
    await this.active?.catch(() => {});
    await this.closeWarmSession();
  }
  private compileEvidence(definition:TaskDefinition,evidence:unknown){
    return compilePreparedJavaScriptTask(definition,evidence,resolve(this.directory,'evidence'),undefined,this.shutdown.signal);
  }
  profile(origin: string) {
    return process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR && origin === (process.env.CLAPPING_HANDS_AUTH_PROFILE_ORIGIN ?? 'https://www.facebook.com')
      ? resolve(process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR)
      : resolve(this.directory, 'profiles', createHash('sha256').update(origin).digest('hex').slice(0, 16));
  }
  /** Process-local facts only; the sourcing health endpoint also inspects the
   * profile lock before describing browser readiness. */
  sourcingBrowserState() {
    return { warm: !!this.warm, closing: !!this.warmClosing, activeOperation: this.busy };
  }
  private async closeWarmSession() {
    if (this.warmClosing) return this.warmClosing;
    const warm = this.warm;
    const search = this.marketplaceWarmSearch;
    // Detach synchronously. A timeout and a new request can otherwise overlap
    // while MarketplaceWarmSearch.close() is awaiting page shutdown.
    this.warm = undefined;
    this.marketplaceWarmSearch = undefined;
    if (warm?.timer) clearTimeout(warm.timer);
    if (!warm && !search) return;
    const closing = Promise.resolve().then(async () => {
      try { await search?.close(); }
      finally { await warm?.session.close(); }
    });
    this.warmClosing = closing;
    try { await closing; } finally { if (this.warmClosing === closing) this.warmClosing = undefined; }
  }
  private async session<T>(definition: TaskDefinition, fn: (session: BrowserSession) => Promise<T>, headless = true,
    retain = false): Promise<T> {
    const origin = new URL(definition.startUrl).origin;
    const profile = this.profile(origin);
    if (!retain || !headless || this.browserSessions !== standaloneBrowserSessionProvider) {
      await this.closeWarmSession();
      const session = this.browserSessions.createSession({ definition, profile, headless });
      await session.start();
      try { return await fn(session); } finally { await session.close(); }
    }
    if (this.warm && (this.warm.origin !== origin || this.warm.profile !== profile)) await this.closeWarmSession();
    if (this.warmClosing) await this.warmClosing;
    if (!this.warm) {
      const session = this.browserSessions.createSession({ definition, profile, headless });
      await session.start();
      this.warm = { origin, profile, session };
    }
    const warm = this.warm;
    if (warm.timer) { clearTimeout(warm.timer); warm.timer = undefined; }
    try { return await fn(warm.session); }
    catch (error) { await this.closeWarmSession(); throw error; }
    finally {
      if (this.warm === warm) {
        warm.timer = setTimeout(() => { void this.closeWarmSession().catch(() => {}); }, 60_000);
        warm.timer.unref();
      }
    }
  }
  private async baseline(session: BrowserSession, definition: TaskDefinition, input: JsonValue) {
    return captureDemonstration(session,definition,input,this.directory,browserUseDemonstrator,this.shutdown.signal);
  }
  async learn(definitionInput: TaskDefinition, examples: JsonValue[]) {
    return this.exclusive(async () => {
      const definition = taskDefinitionSchema.parse(definitionInput);
      if (examples.length < 1 || examples.length > 2) throw new Error('Supply one or two examples.');
      examples.forEach(input => assertResponseValue(definition.inputSchema, input));
      if (await this.store.load(definition.action)) throw new TaskError('task-exists');
      return this.session(definition, async session => {
        const traces: GenericNetworkTrace[] = [], outputs: JsonValue[] = [], executions: TaskExecution[] = [];
        const html: HtmlEvidence[][] = [];
        const pages: PageEvidence[][] = [];
        let pageCompilation = 'insufficient-evidence';
        let javascriptCompilation = 'insufficient-evidence';
        const saved: SavedTask = { formatVersion: 'clapping-hands/task-v2', definition, accelerator: null };
        for (const input of examples) {
          const observed = await this.baseline(session, definition, input);
          executions.push({ outcome: observed.outcome, engine: 'browser-use', durationMs: observed.durationMs,
            modelCalls: observed.modelUsage?.requestAttempts??null, modelUsage:observed.modelUsage, fallback: false, capturedResponses: observed.exchanges.length, evidence: observed.evidence });
          if (observed.outcome.status !== 'completed') break;
          // First successful result is enough for a reusable baseline tool.
          if (outputs.length === 0) await this.store.save(saved);
          outputs.push(observed.outcome.data);
          html.push(observed.html);
          pages.push(observed.pages);
          if (input && typeof input === 'object' && !Array.isArray(input) && Object.values(input).every(v => ['string','number','boolean'].includes(typeof v))) {
            traces.push({ input: input as NetworkInput, exchanges: observed.exchanges, outputText: typeof observed.outcome.data === 'string' ? observed.outcome.data : JSON.stringify(observed.outcome.data) });
          }
        }
        if (traces.length === 2 && !isDeepStrictEqual(examples[0], examples[1])) {
          try {
            const ids=executions.flatMap(e=>e.evidence?.status==='saved'?[e.evidence.id]:[]);
            const prepared=prepareJavaScriptCompilation(definition,traces,outputs,ids,html);
            if(prepared){
              const bundle=await saveEvidenceBundle(resolve(this.directory,'evidence'),prepared);
              saved.compilationEvidenceId=bundle.id;
              await this.store.save(saved);
            }
            const candidate=prepared?await this.compileEvidence(definition,prepared):null;
            javascriptCompilation=candidate?'candidate':'unavailable';
            if(candidate){saved.javascriptAccelerator=candidate;await this.store.save(saved);}
          } catch { javascriptCompilation='failed';delete saved.javascriptAccelerator; }
        }
        if (outputs.length === 2) {
          try {
            const inputSchema=definition.inputSchema;
            const onlyInput=examples[0]&&typeof examples[0]==='object'&&!Array.isArray(examples[0])?Object.keys(examples[0] as object)[0]:undefined;
            const inputSupported=inputSchema.type==='object'&&!!onlyInput&&Object.keys(inputSchema.properties??{}).length===1
              &&inputSchema.properties?.[onlyInput]?.type==='string'&&inputSchema.required?.length===1&&inputSchema.required[0]===onlyInput;
            const pagePlan = inputSupported?compilePageReplay(session.origin, examples, pages, definition.outputSchema):null;
            pageCompilation = pagePlan ? 'candidate' : 'no-shared-url-selector-binding';
            if (pagePlan) { saved.pageAccelerator = pagePlan; await this.store.save(saved); }
          } catch { delete saved.pageAccelerator; pageCompilation = 'failed'; }
        }
        if (outputs.length === 2) {
          const inlinePlan=compileInlineJsonFromDemonstrations(definition,[
            {input:examples[0]!,outcome:executions[0]!.outcome,exchanges:traces[0]?.exchanges??[]},
            {input:examples[1]!,outcome:executions[1]!.outcome,exchanges:traces[1]?.exchanges??[]},
          ]);
          if(inlinePlan){saved.inlineJsonAccelerator=inlinePlan;await this.store.save(saved);}
          const routePlan=compileRouteJsonFromDemonstrations(definition,[
            {input:examples[0]!,outcome:executions[0]!.outcome,exchanges:traces[0]?.exchanges??[]},
            {input:examples[1]!,outcome:executions[1]!.outcome,exchanges:traces[1]?.exchanges??[]},
          ]);
          if(routePlan){saved.routeJsonAccelerator=routePlan;await this.store.save(saved);}
        }
        else if (definition.outputSchema.type !== 'string' && definition.outputSchema.type !== 'object') pageCompilation = 'unsupported-output-shape';
        return { registered: outputs.length > 0, task: outputs.length ? saved : null, executions, compilation:{status:javascriptCompilation},
          javascriptCompilation,
          pageDiagnostics: { status: pageCompilation, evidenceCounts: pages.map(p => p.length) } };
      });
    });
  }
  async startCallerRecording(action:string,purpose:'learn'|'validate'|'validate-page'|'validate-inline-json'|'validate-route-json',input:JsonValue,definitionInput?:TaskDefinition){
    return this.exclusive(async()=>{
      await this.closeWarmSession();
      let definition:TaskDefinition;
      if(purpose==='learn'){
        if(!definitionInput)throw new TaskError('incompatible-evidence');
        definition=taskDefinitionSchema.parse(definitionInput);
      }else{
        const saved=await this.store.load(action);
        if(!saved)throw new TaskError('unknown-task');
        definition=saved.definition;
      }
      if(definition.action!==action)throw new TaskError('incompatible-evidence');
      return this.callerLearning.start(definition,input,purpose,false);
    });
  }
  async finishCallerRecording(recordingId:string,outcome:unknown){
    return this.exclusive(()=>this.callerLearning.finish(recordingId,outcome));
  }
  async replayCallerRouteCandidate(recordingId:string,seedInput:JsonValue){
    return this.exclusive(()=>this.callerLearning.replayRouteCandidate(recordingId,seedInput));
  }
  private async marketplaceAccessFailure(session:BrowserSession):Promise<WorkflowAccessError|undefined>{
    const page=await session.context.newPage();
    try{
      const response=await page.goto('https://www.facebook.com/marketplace/sydney/',
        {waitUntil:'domcontentloaded',timeout:10_000});
      if(response?.status()===401||response?.status()===403)
        return new WorkflowAccessError(response.status()===401?'http-401':'http-403','https://www.facebook.com');
      try{await assertWorkflowAuth(page,'https://www.facebook.com');}
      catch(error){if(error instanceof WorkflowAccessError)return error;}
    }catch{/* The original search failure remains authoritative. */}
    finally{await page.close().catch(()=>{});}
  }
  /** Current search cards are fetched on every call. Only the compiled plan is
   * cached; the returned listings are never read from a saved result set. */
  async marketplaceSearchCards(query:string,limit=24,fastSearch=false,age:MarketplaceSearchAge='1d',
    sort:MarketplaceSearchSort='newest'){
    return this.exclusive(async()=>{
      if(!query.trim()||query.length>100||!Number.isInteger(limit)||limit<1||limit>48)
        throw new TaskError('incompatible-evidence');
      if(age!=='1d'&&age!=='7d'&&age!=='any')throw new TaskError('incompatible-evidence');
      if(sort!=='newest'&&sort!=='relevance')throw new TaskError('incompatible-evidence');
      const search=await this.store.load('marketplace_fresh_search_cards_v1');
      if(search?.javascriptAccelerator?.program.status!=='stable'||
        new URL(search.definition.startUrl).origin!=='https://www.facebook.com')throw new TaskError('unknown-task');
      return this.session(search.definition,async session=>{
        const started=performance.now();
        let found:JsonValue;
        let searchEngine:'browser-replay'|'in-page-network'|'visible-browser'='browser-replay';
        let networkOperationMs:number|undefined;
        let warmContextReused=false;
        let triedVisible=false;
        let visibleCount:number|undefined,rejectedCount:number|undefined;
        let continuation:MarketplaceSearchContinuation|undefined;
        const visible=async()=>{
          try{
            triedVisible=true;
            const result=await readMarketplaceVisibleCards(session.context,query,this.shutdown.signal,age,sort,limit);
            searchEngine='visible-browser';
            networkOperationMs=undefined;
            warmContextReused=false;
            visibleCount=result.visibleCount;
            rejectedCount=result.rejectedCount;
            if('continuation' in result)continuation=result.continuation;
            return result.cards;
          }catch(error){
            if(this.shutdown.signal.aborted)throw new TaskError(this.shutdownCode);
            if(error instanceof WorkflowAccessError)throw error;
            throw await this.marketplaceAccessFailure(session)??new TaskError('search-unverified');
          }
        };
        try{if(age!=='1d'||sort!=='newest'||limit>24){
          // The saved compiler and captured in-page request prove only the
          // one-day newest first tranche. Other scopes and deeper reads need
          // a fresh, checked page.
          found=await visible();
        }else if(fastSearch){
          try{
            warmContextReused=!!this.marketplaceWarmSearch?.usable&&this.marketplaceWarmSearch.context===session.context;
            if(!warmContextReused){
              await this.marketplaceWarmSearch?.close();
              this.marketplaceWarmSearch=await MarketplaceWarmSearch.bootstrap(session.context,this.shutdown.signal);
            }
            const result=await this.marketplaceWarmSearch!.search(query,this.shutdown.signal);
            if(!result.cards.length)throw new Error('Warm search returned no cards.');
            found=result.cards;networkOperationMs=result.durationMs;searchEngine='in-page-network';
          }catch{
            if(this.shutdown.signal.aborted)throw new TaskError(this.shutdownCode);
            await this.marketplaceWarmSearch?.close();this.marketplaceWarmSearch=undefined;
            found=(await replayJavaScriptTask(session.context,search.definition,search.javascriptAccelerator!,{query},this.shutdown.signal)).value;
            warmContextReused=false;
          }
        }else found=(await replayJavaScriptTask(session.context,search.definition,search.javascriptAccelerator!,{query},this.shutdown.signal)).value;
        }catch(error){
          if(this.shutdown.signal.aborted)throw new TaskError(this.shutdownCode);
          if(triedVisible)throw error;
          found=await visible();
        }
        if(!Array.isArray(found))throw new TaskError('incompatible-evidence');
        const select=(rows:JsonValue[]):JsonValue[]=>{
          const seen=new Set<string>(),cards:JsonValue[]=[];
          for(const card of rows){
            if(!card||typeof card!=='object'||Array.isArray(card)||typeof card.url!=='string')continue;
            const id=marketplaceItemId(card.url);
            if(id&&!seen.has(id)){
              seen.add(id);
              cards.push({...card,url:`https://www.facebook.com/marketplace/item/${id}/`});
            }
            if(cards.length===limit)break;
          }
          return cards;
        };
        let cards=select(found);
        if(!cards.length&&!triedVisible)cards=select(await visible());
        if(this.shutdown.signal.aborted)throw new TaskError(this.shutdownCode);
        if(!cards.length)throw await this.marketplaceAccessFailure(session)??new TaskError('search-unverified');
        return {status:rejectedCount||continuation?.state==='scroll-budget-reached'
          ?'partial' as const:'complete' as const,query,age,sort,cards,
          ...(visibleCount===undefined?{}:{visibleCount,rejectedCount}),
          ...(continuation?{continuation}:{}),
          searchMs:performance.now()-started,searchEngine,networkOperationMs,warmContextReused,modelCalls:0 as const};
      },true,true);
    });
  }
  /** Read only exact Marketplace item URLs supplied by the caller. Each item
   * has its own outcome; a failed document never becomes a plausible listing. */
  async marketplaceReadDetails(urls:string[],streamDetails=false){
    return this.exclusive(async()=>{
      if(urls.length<1||urls.length>8)throw new TaskError('invalid-listing-url');
      const ids=urls.map(marketplaceItemId);
      if(ids.some(id=>!id)||new Set(ids).size!==ids.length)
        throw new TaskError('invalid-listing-url');
      const detail=await this.store.load('marketplace_listing_details_v7');
      if(detail?.inlineJsonAccelerator?.status!=='stable'||
        new URL(detail.definition.startUrl).origin!=='https://www.facebook.com')throw new TaskError('unknown-task');
      return this.session(detail.definition,async session=>{
        const started=performance.now();
        const rows=[];
        for(let offset=0;offset<ids.length;offset+=2){
          const chunk=await Promise.all(ids.slice(offset,offset+2).map(async id=>{
            const began=performance.now();
            try{
              const result=streamDetails
                ? await replayStreamedInlineJsonDocument(session.context,detail.inlineJsonAccelerator!,{item:id!},this.shutdown.signal)
                : await replayInlineJsonDocument(session.context,detail.inlineJsonAccelerator!,{item:id!},this.shutdown.signal);
              assertResponseValue(detail.definition.outputSchema,result.data);
              return {id:id!,url:`https://www.facebook.com/marketplace/item/${id}/`,status:'complete' as const,
                engine:'engine' in result?result.engine:'document-replay' as const,data:result.data,
                dataScope:'listing-text-only' as const,media:{status:'not-inspected' as const},
                ...('streamFallbackReason' in result?{streamFallbackReason:result.streamFallbackReason}:{}),
                durationMs:performance.now()-began};
            }catch(error){
              if(this.shutdown.signal.aborted)throw new TaskError(this.shutdownCode);
              const status=error instanceof WorkflowAccessError
                ? error.reason==='http-403'?'blocked' as const:'auth-required' as const
                : error instanceof DocumentUnavailableError?'unavailable' as const:'incomplete' as const;
              return {id:id!,url:`https://www.facebook.com/marketplace/item/${id}/`,status,
                dataScope:'listing-text-only' as const,media:{status:'not-inspected' as const},
                durationMs:performance.now()-began};
            }
          }));
          rows.push(...chunk);
        }
        return {rows,wallDurationMs:performance.now()-started,modelCalls:0 as const};
      },true,true);
    });
  }
  /** Return one verified product-photo crop. The leased browser keeps all
   * authenticated state and signed image URLs inside the CH process. */
  async marketplaceReadPhoto(url:string,position:MarketplacePhotoPosition){
    return this.exclusive(async()=>{
      const id=marketplaceItemId(url);
      if(!id)throw new TaskError('invalid-listing-url');
      if(!(position==='last'||(Number.isSafeInteger(position)&&position>=1&&position<=12)))
        throw new TaskError('incompatible-evidence');
      const detail=await this.store.load('marketplace_listing_details_v7');
      if(detail?.inlineJsonAccelerator?.status!=='stable'||
        new URL(detail.definition.startUrl).origin!=='https://www.facebook.com')throw new TaskError('unknown-task');
      const result=await this.session(detail.definition,session=>
        readMarketplacePhoto(session.context,`https://www.facebook.com/marketplace/item/${id}/`,id,position,this.shutdown.signal),true,true);
      if(this.shutdown.signal.aborted)throw new TaskError(this.shutdownCode);
      return result;
    });
  }
  /** Narrow read-only Marketplace batch over two independently stable plans.
   * A transient detail failure is returned per item; it never degrades a saved
   * plan or invents a field value. The caller may retry or review that item. */
  async marketplaceSearchTwoDetails(query:string,streamDetails=false,fastSearch=false){
    return this.exclusive(async()=>{
      if(!query.trim()||query.length>100)throw new TaskError('incompatible-evidence');
      const search=await this.store.load('marketplace_fresh_search_cards_v1');
      const detail=await this.store.load('marketplace_listing_details_v7');
      if(search?.javascriptAccelerator?.program.status!=='stable'||detail?.inlineJsonAccelerator?.status!=='stable'
        ||new URL(search.definition.startUrl).origin!=='https://www.facebook.com'
        ||new URL(detail.definition.startUrl).origin!=='https://www.facebook.com')throw new TaskError('unknown-task');
      return this.session(search.definition,async session=>{
        const started=performance.now();
        let found:JsonValue;
        let searchEngine:'browser-replay'|'in-page-network'='browser-replay';
        let networkOperationMs:number|undefined;
        let warmContextReused=false;
        if(fastSearch){
          try{
            warmContextReused=!!this.marketplaceWarmSearch?.usable&&this.marketplaceWarmSearch.context===session.context;
            if(!warmContextReused){
              await this.marketplaceWarmSearch?.close();
              this.marketplaceWarmSearch=await MarketplaceWarmSearch.bootstrap(session.context);
            }
            const result=await this.marketplaceWarmSearch!.search(query);
            if(result.cards.length<2)throw new Error('Warm search returned fewer than two cards.');
            found=result.cards;networkOperationMs=result.durationMs;searchEngine='in-page-network';
          }catch{
            await this.marketplaceWarmSearch?.close();this.marketplaceWarmSearch=undefined;
            found=(await replayJavaScriptTask(session.context,search.definition,search.javascriptAccelerator!,{query})).value;
            warmContextReused=false;
          }
        }else found=(await replayJavaScriptTask(session.context,search.definition,search.javascriptAccelerator!,{query})).value;
        const searchMs=performance.now()-started;
        if(!Array.isArray(found))throw new TaskError('incompatible-evidence');
        const selected:{id:string;card:JsonValue}[]=[];
        for(const card of found){
          if(!card||typeof card!=='object'||Array.isArray(card)||typeof card.url!=='string')continue;
          const match=/^https:\/\/www\.facebook\.com\/marketplace\/item\/(\d{8,20})\/$/.exec(card.url);
          if(match&&!selected.some(row=>row.id===match[1]))selected.push({id:match[1]!,card});
          if(selected.length===2)break;
        }
        const ids=selected.map(row=>row.id);
        if(ids.length<2)throw new TaskError('incompatible-evidence');
        const detailStarted=performance.now();
        const rows=await Promise.all(ids.map(async id=>{
          const began=performance.now();
          try{
            const result=streamDetails
              ? await replayStreamedInlineJsonDocument(session.context,detail.inlineJsonAccelerator!,{item:id},this.shutdown.signal)
              : await replayInlineJsonDocument(session.context,detail.inlineJsonAccelerator!,{item:id},this.shutdown.signal);
            assertResponseValue(detail.definition.outputSchema,result.data);
            return {id,status:'completed' as const,engine:'engine' in result?result.engine:'document-replay' as const,data:result.data,
              ...('streamFallbackReason' in result?{streamFallbackReason:result.streamFallbackReason}:{}),
              durationMs:performance.now()-began};
          }catch{return {id,status:'failed' as const,error:'document-replay-failed' as const,
            durationMs:performance.now()-began};}
        }));
        return {query,cards:selected.map(row=>row.card),searchMs,searchEngine,networkOperationMs,warmContextReused,
          detailMs:performance.now()-detailStarted,
          wallDurationMs:performance.now()-started,modelCalls:0 as const,rows};
      },true,true);
    });
  }
  async cancelCallerRecording(recordingId:string){
    return this.exclusive(async()=>{await this.callerLearning.cancel(recordingId);return {status:'cancelled' as const,recordingId,modelCalls:0};});
  }
  async prepareFromCaptures(action:string,evidenceIds:string[]){
    return this.exclusive(async()=>{
      const current=await this.store.load(action);
      if(!current)throw new TaskError('unknown-task');
      if(evidenceIds.length!==2||new Set(evidenceIds).size!==2)throw new TaskError('incompatible-evidence');
      const traces:GenericNetworkTrace[]=[],outputs:JsonValue[]=[],restoration=[];
      for(const id of evidenceIds){
        const restored=await loadSavedJsonCapture(resolve(this.directory,'evidence'),id);
        const capture=restored.capture as Record<string,unknown>;
        const outcome=capture.outcome as {status?:unknown;data?:JsonValue}|undefined;
        if(capture.provenance!=='browser-use-baseline'||!isDeepStrictEqual(capture.definition,current.definition)||outcome?.status!=='completed')
          throw new TaskError('incompatible-evidence');
        assertResponseValue(current.definition.inputSchema,capture.input);
        assertResponseValue(current.definition.outputSchema,outcome.data);
        if(!capture.input||typeof capture.input!=='object'||Array.isArray(capture.input)
          ||!Object.values(capture.input).every(v=>typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))))
          throw new TaskError('incompatible-evidence');
        traces.push({input:capture.input as NetworkInput,exchanges:restored.exchanges});
        outputs.push(outcome.data!);
        restoration.push({restored:restored.exchanges.length,refused:restored.refused});
      }
      if(isDeepStrictEqual(traces[0]!.input,traces[1]!.input))throw new TaskError('incompatible-evidence');
      const prepared=prepareJavaScriptCompilation(current.definition,traces,outputs,evidenceIds);
      const accounting={browserRuns:0 as const,modelCalls:0 as const,networkRequests:0 as const,existingTaskPreserved:true,restoration};
      if(!prepared)return {status:'no-admitted-resources' as const,...accounting};
      const bundle=await saveEvidenceBundle(resolve(this.directory,'evidence'),prepared);
      if(this.shutdown.signal.aborted)throw new TaskError('runtime-closed');
      await this.store.save({...current,compilationEvidenceId:bundle.id},current);
      return {status:'prepared' as const,evidenceId:bundle.id,resources:prepared.resources.length,...accounting};
    });
  }
  async recompile(action:string){
    return this.exclusive(async()=>{
      const current=await this.store.load(action);
      if(!current)throw new TaskError('unknown-task');
      if(!current.compilationEvidenceId)return {status:'no-saved-compilation-evidence' as const,browserRuns:0 as const,existingTaskPreserved:true};
      const evidence=await loadEvidenceBundle(resolve(this.directory,'evidence'),current.compilationEvidenceId);
      const candidate=await this.compileEvidence(current.definition,evidence);
      if(!candidate)return {status:'unavailable' as const,browserRuns:0 as const,existingTaskPreserved:true};
      if(this.shutdown.signal.aborted)throw new Error('Runtime cancelled.');
      await this.store.save({...current,pendingJavascriptAccelerator:candidate},current);
      return {status:'candidate' as const,browserRuns:0 as const,existingTaskPreserved:true,requiresHeldOutValidation:true};
    });
  }
  async getCompilationContext(action:string){
    return this.exclusive(async()=>{
      const current=await this.store.load(action);
      if(!current)throw new TaskError('unknown-task');
      if(!current.compilationEvidenceId)return {status:'no-saved-compilation-evidence' as const};
      const evidence=await loadEvidenceBundle(resolve(this.directory,'evidence'),current.compilationEvidenceId);
      return {status:'ready' as const,evidenceId:current.compilationEvidenceId,
        instructions:compilerInstructions,context:compilationContext(current.definition,evidence),modelCalls:0,browserRuns:0};
    });
  }
  async submitCandidate(action:string,evidenceId:string,source:string){
    return this.exclusive(async()=>{
      const current=await this.store.load(action);
      if(!current)throw new TaskError('unknown-task');
      if(!current.compilationEvidenceId || evidenceId!==current.compilationEvidenceId)throw new TaskError('incompatible-evidence');
      if(typeof source!=='string'||Buffer.byteLength(source,'utf8')>64_000||!source.length)throw new Error('Invalid candidate source.');
      const evidence=await loadEvidenceBundle(resolve(this.directory,'evidence'),evidenceId);
      const receipt=await saveEvidenceBundle(resolve(this.directory,'evidence'),{
        kind:'caller-candidate',action,evidenceId,source,
      });
      const candidate=await validateJavaScriptCandidate(current.definition,evidence,source,receipt.id,this.shutdown.signal);
      if(this.shutdown.signal.aborted)throw new Error('Runtime cancelled.');
      await this.store.save({...current,pendingJavascriptAccelerator:candidate},current);
      return {status:'candidate' as const,sourceEvidenceId:receipt.id,modelCalls:0,browserRuns:0,
        existingTaskPreserved:true,requiresHeldOutValidation:true};
    });
  }
  async run(action: string, input: JsonValue, fallbackPolicy?:'return-control'|'delegate'): Promise<TaskExecution> {
    const started=performance.now();
    const result=await this.exclusive<TaskExecution>(async () => {
      const initial = await this.store.load(action);
      if (!initial) throw new TaskError('unknown-task');
      assertResponseValue(initial.definition.inputSchema, input);
      return this.session(initial.definition, async session => {
        // Another process may have updated evidence between our initial read
        // and acquiring the exclusive profile lease. Never revive stale plans.
        const current = await this.store.load(action);
        if (!current || !isDeepStrictEqual(current.definition, initial.definition)) throw new Error('Task changed during session acquisition.');
        const saved = current;
        const fallback=saved.executionPolicy??'delegate';
        const effectiveFallback=fallbackPolicy??fallback;
        let accelerated: JsonValue | undefined, networkMs = 0, failed = false;
        let generatedData: JsonValue | undefined;
        const pending=!!saved.pendingJavascriptAccelerator;
        const javascript=saved.pendingJavascriptAccelerator??saved.javascriptAccelerator;
        if(javascript && javascript.program.status!=='degraded'){
          const started=performance.now();
          try{
            const result=await session.network.withoutReplayEvidence(()=>replayJavaScriptTask(session.context,saved.definition,javascript,input,this.shutdown.signal));
            generatedData=result.value;networkMs+=performance.now()-started;
            if(javascript.program.status==='stable')return {outcome:{status:'completed',data:generatedData},
              engine:javascript.resources.some(resource=>resource.plan.response.codec==='html-document')?'browser-replay':'network',
              durationMs:networkMs,modelCalls:0,fallback:false,capturedResponses:0};
          }catch{
            networkMs+=performance.now()-started;
            if(this.shutdown.signal.aborted)throw new Error('Runtime cancelled.');
            failed=true;
            if(pending)delete saved.pendingJavascriptAccelerator;
            else javascript.program=degradeCompiledProgram(javascript.program);
            await this.store.save(saved);
          }
        }
        if (generatedData===undefined && saved.accelerator && saved.accelerator.plan.status !== 'degraded') {
          try {
            const result = await session.network.withoutReplayEvidence(() => replayGenericJsonPlan(session.context, saved.accelerator!.plan, input as NetworkInput));
            accelerated = projectContractValue(result.data, saved.accelerator.projection, saved.definition.outputSchema);
            networkMs = result.durationMs;
            if (isStableGenericJsonPlan(saved.accelerator.plan)) {
              return { outcome: { status: 'completed', data: accelerated }, engine: 'network', durationMs: networkMs, modelCalls: 0, fallback: false, capturedResponses: 0 };
            }
          } catch { failed = true; saved.accelerator.plan.status = 'degraded'; await this.store.save(saved); }
        }
        let pageData: JsonValue | undefined;
        if (generatedData===undefined && accelerated===undefined && saved.inlineJsonAccelerator?.status==='stable') {
          try {
            const result=await session.network.withoutReplayEvidence(()=>replayInlineJsonDocument(
              session.context,saved.inlineJsonAccelerator!,input as Record<string,unknown>,this.shutdown.signal));
            const data=assertResponseValue(saved.definition.outputSchema,result.data);
            return {outcome:{status:'completed',data},engine:'document-replay',durationMs:networkMs+result.durationMs,
              modelCalls:0,fallback:failed,capturedResponses:0};
          } catch {
            failed=true;saved.inlineJsonAccelerator.status='degraded';await this.store.save(saved);
          }
        }
        if (generatedData===undefined && accelerated === undefined && saved.pageAccelerator && saved.pageAccelerator.status !== 'degraded') {
          try {
            const result = await session.network.withoutReplayEvidence(() => replayPage(session.context, saved.pageAccelerator!, input, this.shutdown.signal));
            pageData = assertResponseValue(saved.definition.outputSchema, result.data); networkMs += result.durationMs;
            if (stablePageReplay(saved.pageAccelerator)) return { outcome: { status: 'completed', data: pageData }, engine: 'browser-replay',
              durationMs: networkMs, modelCalls: 0, fallback: failed, capturedResponses: 0 };
          } catch { failed = true; saved.pageAccelerator.status = 'degraded'; await this.store.save(saved); }
        }
        if(effectiveFallback==='return-control')throw new TaskError('demonstration-required');
        const observed = await this.baseline(session, saved.definition, input);
        let shadowMatch: boolean | undefined;
        if(generatedData!==undefined && javascript && observed.outcome.status==='completed'){
          shadowMatch=isDeepStrictEqual(generatedData,observed.outcome.data);
          // An incomplete evidence write cannot promote a program. The browser
          // result remains usable, and the candidate can be compared next call.
          try { if(observed.evidence?.status==='saved'){
            const comparison=await saveEvidenceBundle(resolve(this.directory,'evidence'),{kind:'javascript-comparison',
              sourceHash:javascript.program.sourceHash,input,actual:generatedData,expected:observed.outcome.data,
              baselineEvidenceId:observed.evidence.id,match:shadowMatch});
            javascript.program=recordCompiledComparison(javascript.program,input,generatedData,
              observed.outcome.data,saved.definition.outputSchema,comparison.id);
          }else if(!shadowMatch)javascript.program=degradeCompiledProgram(javascript.program);
          if(pending && javascript.program.status==='stable'){
            saved.javascriptAccelerator=javascript;delete saved.pendingJavascriptAccelerator;
          }else if(pending && javascript.program.status==='degraded')delete saved.pendingJavascriptAccelerator;
          await this.store.save(saved);
          } catch {
            // Optional compiler bookkeeping must not discard a successful
            // browser result. No newly promoted state is returned or assumed.
          }
        }
        if (accelerated !== undefined && saved.accelerator && observed.outcome.status === 'completed') {
          shadowMatch = isDeepStrictEqual(accelerated, observed.outcome.data);
          saved.accelerator.plan = recordGenericJsonShadow(saved.accelerator.plan, input as NetworkInput, shadowMatch);
          await this.store.save(saved);
        }
        if (pageData !== undefined && saved.pageAccelerator && observed.outcome.status === 'completed') {
          shadowMatch = isDeepStrictEqual(pageData, observed.outcome.data);
          saved.pageAccelerator = recordPageShadow(saved.pageAccelerator, input, shadowMatch);
          await this.store.save(saved);
        }
        return { outcome: observed.outcome, engine: 'browser-use', durationMs: observed.durationMs+networkMs,
          modelCalls: observed.modelUsage?.requestAttempts??null, modelUsage:observed.modelUsage, fallback: failed, shadowMatch, capturedResponses: observed.exchanges.length, evidence: observed.evidence };
      },true,initial.inlineJsonAccelerator?.status==='stable'||initial.javascriptAccelerator?.program.status==='stable');
    });
    return {...result,wallDurationMs:performance.now()-started};
  }
  async authenticate(startUrl: string) {
    return this.exclusive(async () => {
      const definition = taskDefinitionSchema.parse({ action: 'manual_auth', startUrl, goal: 'Manual login', effect: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] }, outputSchema: { type: 'string' } });
      return this.session(definition, async session => {
        const handoff=authenticationHandoff(session.context,this.shutdown.signal);
        try{
          const page = session.context.pages()[0] ?? await session.context.newPage();
          const reason=this.shutdown.signal.aborted?'cancelled':await Promise.race([
            page.goto(startUrl,{waitUntil:'domcontentloaded',timeout:30_000}).then(()=>handoff.done),handoff.done]);
          // A closed login window is not proof that the site accepted login.
          return { status: 'manual-auth-window-closed-or-expired', authenticated: 'not-asserted',reason };
        }finally{handoff.dispose();}
      }, false);
    });
  }
}
