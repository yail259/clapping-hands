import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TaskStore, taskDefinitionSchema, type TaskDefinition, type SavedTask } from './task-store.js';
import { TaskSession } from './task-session.js';
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

export type TaskExecution = { outcome: BrowserTaskOutcome; engine: 'browser-use' | 'network' | 'browser-replay'; durationMs: number;
  wallDurationMs?:number;
  modelCalls: number | null; fallback: boolean; shadowMatch?: boolean; capturedResponses: number;
  modelUsage?:BrowserModelUsage;
  evidence?: { status: 'saved'; id: string } | { status: 'failed' } };
export class TaskRuntime {
  readonly store: TaskStore;
  private busy = false;
  private readonly shutdown = new AbortController();
  private active: Promise<unknown> | undefined;
  constructor(readonly directory = resolve(process.env.CLAPPING_HANDS_DATA_DIR ?? '.data/alpha')) {
    this.store = new TaskStore(resolve(directory, 'tasks'));
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.shutdown.signal.aborted) throw new TaskError('runtime-closed');
    if (this.busy) throw new TaskError('runtime-busy');
    this.busy = true;
    const active = fn(); this.active = active;
    try { return await active; } finally { this.busy = false; this.active = undefined; }
  }
  async close() { this.shutdown.abort(); await this.active?.catch(() => {}); }
  private compileEvidence(definition:TaskDefinition,evidence:unknown){
    return compilePreparedJavaScriptTask(definition,evidence,resolve(this.directory,'evidence'),undefined,this.shutdown.signal);
  }
  profile(origin: string) {
    return process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR && origin === (process.env.CLAPPING_HANDS_AUTH_PROFILE_ORIGIN ?? 'https://www.facebook.com')
      ? resolve(process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR)
      : resolve(this.directory, 'profiles', createHash('sha256').update(origin).digest('hex').slice(0, 16));
  }
  private async session<T>(definition: TaskDefinition, fn: (session: TaskSession) => Promise<T>, headless = true): Promise<T> {
    const origin = new URL(definition.startUrl).origin;
    const session = new TaskSession(origin, this.profile(origin), headless,definition.allowedNetworkOrigins);
    await session.start();
    try { return await fn(session); } finally { await session.close(); }
  }
  private async baseline(session: TaskSession, definition: TaskDefinition, input: JsonValue) {
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
        if (outputs.length === 2 && definition.outputSchema.type === 'string') {
          try {
            const pagePlan = compilePageReplay(session.origin, examples, pages);
            pageCompilation = pagePlan ? 'candidate' : 'no-shared-url-selector-binding';
            if (pagePlan) { saved.pageAccelerator = pagePlan; await this.store.save(saved); }
          } catch { delete saved.pageAccelerator; pageCompilation = 'failed'; }
        }
        else if (definition.outputSchema.type !== 'string') pageCompilation = 'unsupported-output-shape';
        return { registered: outputs.length > 0, task: outputs.length ? saved : null, executions, compilation:{status:javascriptCompilation},
          javascriptCompilation,
          pageDiagnostics: { status: pageCompilation, evidenceCounts: pages.map(p => p.length) } };
      });
    });
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
  async run(action: string, input: JsonValue): Promise<TaskExecution> {
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
        let accelerated: JsonValue | undefined, networkMs = 0, failed = false;
        let generatedData: JsonValue | undefined;
        const pending=!!saved.pendingJavascriptAccelerator;
        const javascript=saved.pendingJavascriptAccelerator??saved.javascriptAccelerator;
        if(javascript && javascript.program.status!=='degraded'){
          const started=performance.now();
          try{
            const result=await session.network.withoutReplayEvidence(()=>replayJavaScriptTask(session.context,saved.definition,javascript,input,this.shutdown.signal));
            generatedData=result.value;networkMs+=performance.now()-started;
            if(javascript.program.status==='stable')return {outcome:{status:'completed',data:generatedData},engine:'network',durationMs:networkMs,modelCalls:0,fallback:false,capturedResponses:0};
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
        let pageData: string | undefined;
        if (generatedData===undefined && accelerated === undefined && saved.pageAccelerator && saved.pageAccelerator.status !== 'degraded') {
          try {
            const result = await session.network.withoutReplayEvidence(() => replayPage(session.context, saved.pageAccelerator!, input, this.shutdown.signal));
            assertResponseValue(saved.definition.outputSchema, result.data);
            pageData = result.data; networkMs += result.durationMs;
            if (stablePageReplay(saved.pageAccelerator)) return { outcome: { status: 'completed', data: pageData }, engine: 'browser-replay',
              durationMs: networkMs, modelCalls: 0, fallback: failed, capturedResponses: 0 };
          } catch { failed = true; saved.pageAccelerator.status = 'degraded'; await this.store.save(saved); }
        }
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
      });
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
