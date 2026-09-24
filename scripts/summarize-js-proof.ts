import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadEvidenceBundle } from '../src/evidence-bundle.js';

// Public summary contains counts/timings/source hashes, never raw authenticated
// responses, model prompts, output values, cookies or user profile information.
const base=resolve('.data/js-compilation');
const selected=[
  ['openlibrary','', '1788787198885-ed9d4e07-e23c-46d8-ae9c-6da3f7375578'],
  ['yahoo','yahoo','1788787363741-a3830872-8383-4ec5-8d09-dd58a86eb4bb'],
  ['govuk','govuk','1788787363742-47b22bc4-1f46-4df4-90d2-78e9d8c8adde'],
  ['rba','rba','1788787389120-ad365111-402a-4a8e-8bd1-a1ca28d44acf'],
  ['bunnings','bunnings','1788787576328-d6049435-d1ac-4b7f-87be-9b3923dc7a38'],
  ['ikea','ikea','1788788156757-6b70906e-4335-4a97-b5d8-aa41405f8ebe'],
  ['transport','transport','1788789230058-a18e4417-fb6a-446c-9093-688ce26a9e62'],
  ['marketplace','marketplace','1788788997083-23d225da-9fc8-4b47-8456-a9dbb4c0f1ef'],
];
if(process.env.CLAPPING_HANDS_JS_TENDER_PROPOSAL_ID)selected.push(['tender','tender',process.env.CLAPPING_HANDS_JS_TENDER_PROPOSAL_ID]);
const rows=[];
for(const [site,directory,proposalId] of selected) {
  const root=join(base,directory!),proposal=await loadEvidenceBundle(root,proposalId!) as any;
  const events:any[]=[];
  for(const id of await readdir(root)) {
    if(!/^\d+-[a-f0-9-]+$/.test(id))continue;
    const value=await loadEvidenceBundle(root,id) as any;
    if(value.proposalId===proposalId)events.push({...value,evidenceId:id});
  }
  const checks=events.filter(e=>['held-out-validation','held-out-browser-validation'].includes(e.kind));
  const failures=events.filter(e=>e.kind==='held-out-failure');
  const durations=checks.filter(c=>c.exact===true).map(c=>c.result.durationMs).sort((a,b)=>a-b);
  const summaries=events.filter(e=>e.kind==='compilation-summary');
  rows.push({site,proposalId,sourceSha256:createHash('sha256').update(proposal.proposal.source).digest('hex'),compileMs:proposal.durationMs,
    exact:checks.filter(e=>e.exact===true).length,comparisonMismatches:checks.filter(e=>e.exact===false).length,executionFailures:failures.length,
    restartExact:checks.filter(e=>e.restarted&&e.exact===true).length,
    independentBrowserChecks:checks.filter(e=>e.kind==='held-out-browser-validation').length,
    sameResponseParserChecks:checks.filter(e=>e.kind==='held-out-validation').length,
    executionModelCalls:checks.reduce((sum,e)=>sum+e.result.modelCalls,0),
    successfulCallMs:durations.length?{min:durations[0],median:durations[Math.floor(durations.length/2)],max:durations.at(-1)}:null,
    cohorts:summaries.map(s=>({evidenceId:s.evidenceId,transport:s.transport??(site==='marketplace'?'request-context':'network'),exact:s.results.filter((r:any)=>r.exact===true).length,attempts:s.results.length})),
    tier:site==='marketplace'?'browser-document; network attempts failed':'network',
    networkRequestsPerSuccessfulCall:site==='marketplace'?null:site==='transport'?3:site==='tender'?2:1,
  });
}
const blocked=[];
for(const [site,id] of [['ebay','1788788446177-a7fd4199-16d2-4c85-99da-d2a6f45726f3'],['bom','1788788447686-bbca406f-4450-4b3c-87bd-fa52404e3b0c']]) {
  const evidence=await loadEvidenceBundle(join(base,site!),id!) as any;
  if(evidence.httpStatus!==403)throw new Error('Blocked-site evidence changed');
  blocked.push({site,status:'access-restricted',httpStatus:403,evidenceId:id,compilation:'not-attempted-without-successful-response'});
}
const report={kind:'model-authored-js-compilation-experiment',createdAt:new Date().toISOString(),browserUseInvocations:0,rows,blocked,
  limitations:['Explicitly supplied, previously observed read resources; not automatic request discovery or MCP integration.',
    'First five sites use independent parsers of the same fresh response; later sites use independent plain-browser checks.',
    'Browser-backed Marketplace makes multiple page requests; its resource-call count is not a network-request count.',
    'Private evidence is required to reproduce saved captures; this is not a portable clean-install benchmark.',
    'Finite tests do not establish all-input reliability or general website support.']};
const directory=resolve('bench/runs/2026-09-07');await mkdir(directory,{recursive:true});
const file=join(directory,`js-compilation-${Date.now()}.json`);await writeFile(file,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({file,rows:rows.map(r=>({site:r.site,exact:r.exact,failures:r.executionFailures,restartExact:r.restartExact})),blocked}));
