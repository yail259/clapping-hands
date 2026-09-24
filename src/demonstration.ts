import { resolve } from 'node:path';
import type { TaskSession } from './task-session.js';
import type { TaskDefinition } from './task-store.js';
import type { JsonValue } from './response-contract.js';
import { parseBrowserTaskOutcome, validateBrowserTask, type BrowserTask, type BrowserTaskOutcome } from './browser-task.js';
import type { CapturedExchange } from './captured-exchange.js';
import { captureHtmlEvidence, type HtmlEvidence } from './html-evidence.js';
import { capturePageEvidence, type PageEvidence } from './page-replay.js';
import { browserModelUsage } from './model-usage.js';
import { saveEvidenceBundle } from './evidence-bundle.js';

export type DemonstrationProvider={
  kind:'browser-use'|'caller';
  execute:(task:BrowserTask,options:{cdpUrl:string;allowedOrigins:string[];signal:AbortSignal;onEvidence:(event:unknown)=>void})=>
    Promise<{outcome:BrowserTaskOutcome;model?:string;secrets?:string[]}>;
};

/** One capture pipeline for managed and caller-driven demonstrations.
 * Provider events and results are untrusted; they do not confer replay authority.
 * Secrets are redaction inputs only, never fields in persisted evidence. */
export async function captureDemonstration(session:TaskSession,definition:TaskDefinition,input:JsonValue,
  directory:string,provider:DemonstrationProvider,signal:AbortSignal){
    validateBrowserTask({...definition,input});
    if(signal.aborted)throw new Error('Demonstration cancelled.');
    const mark=session.network.mark(),evidenceMark=session.evidenceNetwork.mark();
    const started=performance.now(),actions:unknown[]=[];
    const result=await session.evidenceNetwork.withDocumentResponses(()=>session.network.withDocumentResponses(()=>
      provider.execute({...definition,input},{cdpUrl:session.cdpUrl,allowedOrigins:[session.origin],signal,onEvidence:event=>actions.push(event)})));
    const outcome=parseBrowserTaskOutcome(result.outcome,definition.outputSchema);
    let exchanges: CapturedExchange[] = [];
    let captureDiagnostics: unknown;
    try {
      exchanges = await session.network.since(mark);
      captureDiagnostics = session.network.diagnosticSnapshotSince(mark);
    } catch { captureDiagnostics = {status:'incomplete',reason:'capture-did-not-settle-or-window-expired'}; }
    let passiveExchanges: CapturedExchange[] = [], passiveDiagnostics: unknown;
    try { passiveExchanges = await session.evidenceNetwork.since(evidenceMark); passiveDiagnostics = session.evidenceNetwork.diagnosticSnapshotSince(evidenceMark); }
    catch { passiveDiagnostics = {status:'incomplete',reason:'capture-did-not-settle-or-window-expired'}; }
    const html: HtmlEvidence[] = [];
    const pages: PageEvidence[] = [];
    const snapshots: { url: string; dom: string }[] = [];
    if (outcome.status === 'completed') {
      for (const page of session.context.pages()) {
        if (new URL(page.url()).origin !== session.origin) continue;
        try { snapshots.push({ url: page.url(), dom: await page.content() }); } catch { /* Capture is optional for task success. */ }
        try { html.push(...await captureHtmlEvidence(page)); } catch { /* Optional passive evidence. */ }
        try { const evidence = await capturePageEvidence(page, outcome.data); if (evidence) pages.push(evidence); } catch { /* Optional evidence only. */ }
      }
    }
    const modelUsage=browserModelUsage(actions);
    let evidence: {status:'saved';id:string}|{status:'failed'};
    try {
      evidence = await saveEvidenceBundle(resolve(directory, 'evidence'), {
        provenance: provider.kind==='browser-use'?'browser-use-baseline':'caller-baseline', definition, input, outcome, exchanges, passiveExchanges, passiveDiagnostics,
        passiveEvidenceGrantsExecutionAuthority: false, html, pages, snapshots, actions, captureDiagnostics,
        model: result.model??null, durationMs: performance.now()-started,
        // Generic evidence redaction removes credential-like "token" keys.
        // Keep numeric accounting under unit-labelled fields, not a secret-name exemption.
        usage: modelUsage?{unit:'tokens',requestAttempts:modelUsage.requestAttempts,reportedInvocations:modelUsage.reportedInvocations,
          prompt:modelUsage.promptTokens,completion:modelUsage.completionTokens,cachedPrompt:modelUsage.cachedPromptTokens,
          coverageComplete:modelUsage.tokenCoverageComplete,costUSD:null}:null,
      }, result.secrets??[]);
    } catch { evidence = { status: 'failed' }; }
    return { outcome, exchanges, html, pages, evidence, modelUsage, durationMs: performance.now()-started };
}
