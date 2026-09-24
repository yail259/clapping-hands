import { resolve } from 'node:path';
import { TaskSession } from '../src/task-session.js';
import { saveEvidenceBundle } from '../src/evidence-bundle.js';

// Deterministic visits to the already proven search URL; no Browser Use, LLM or
// re-learning of navigation. Preserve the background responses missing in HTML.
const root=resolve('.data/js-compilation/ikea');
const session=new TaskSession('https://www.ikea.com',resolve(root,'capture-profile'));
await session.start();
try {
  const page=session.context.pages()[0]??await session.context.newPage();
  for(const query of ['sofa bed','desk']) {
    const mark=session.evidenceNetwork.mark();const started=performance.now();let status='captured';
    try {
      await session.evidenceNetwork.withDocumentResponses(async()=>{
        await page.goto('https://www.ikea.com/au/en/search/?q='+encodeURIComponent(query),{waitUntil:'domcontentloaded',timeout:30_000});
        await page.locator('a[href*="/p/"] .plp-price-module__product-name').first().waitFor({timeout:20_000});
      });
    } catch {status='page-or-results-unavailable';}
    let exchanges:unknown[]=[],diagnostics:unknown,dom='';
    try {exchanges=await session.evidenceNetwork.since(mark);diagnostics=session.evidenceNetwork.diagnosticSnapshotSince(mark);}catch{diagnostics={status:'incomplete'};}
    try {dom=await page.content();}catch{status='page-closed';}
    const evidence=await saveEvidenceBundle(root,{kind:'known-page-network-capture',input:{query},status,exchanges,diagnostics,dom,
      provenance:'direct known URL, no browser agent',durationMs:performance.now()-started});
    console.log(JSON.stringify({query,status,evidenceId:evidence.id,responses:exchanges.length,diagnostics}));
  }
}finally{await session.close();}
