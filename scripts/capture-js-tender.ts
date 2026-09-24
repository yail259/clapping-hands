import { resolve } from 'node:path';
import { TaskSession } from '../src/task-session.js';
import { saveEvidenceBundle, sanitizeEvidence } from '../src/evidence-bundle.js';
const root=resolve('.data/js-compilation/tender'),session=new TaskSession('https://www.find-tender.service.gov.uk',resolve(root,'experiment-profile'));
await session.start();
try {
  const page=session.context.pages()[0]??await session.context.newPage(),mark=session.evidenceNetwork.mark();
  await session.evidenceNetwork.withDocumentResponses(async()=>{
    await page.goto('https://www.find-tender.service.gov.uk/Search/Results',{waitUntil:'domcontentloaded',timeout:30_000});
    await page.locator('#keywords').fill('software');
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:30_000}),page.getByRole('button',{name:'Update results',exact:true}).click()]);
  });
  const exchanges=await session.evidenceNetwork.since(mark);
  const saved=await saveEvidenceBundle(root,{kind:'actual-search-form-request',input:{query:'software'},exchanges,dom:await page.content()});
  const request=exchanges.find(e=>e.method==='POST'&&new URL(e.url).pathname==='/Search/Results');
  console.log(JSON.stringify({evidenceId:saved.id,request:request?sanitizeEvidence({requestBody:request.requestBody}).data:null}));
}finally{await session.close();}
