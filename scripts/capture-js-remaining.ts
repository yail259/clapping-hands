import { resolve } from 'node:path';
import { TaskSession } from '../src/task-session.js';
import { saveEvidenceBundle } from '../src/evidence-bundle.js';

// Evidence collection only, never an assertion of task or compilation success.
// Marketplace uses the user's existing local session, never exported cookies.
const cases=[
  {id:'marketplace',origin:'https://www.facebook.com',profile:process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR,
    visits:['sofa bed','double sofa bed'].map(query=>({input:{query},url:'https://www.facebook.com/marketplace/sydney/search/?query='+encodeURIComponent(query),selector:'a[href*="/marketplace/item/"]'}))},
  {id:'transport',origin:'https://transportnsw.info',profile:undefined,
    visits:[{input:{origin:'Redfern Station',destination:'Wynyard Station'},url:'https://transportnsw.info/trip-planner/plan?from=201510&excludedModes=11&to=200080',selector:'body'},
      {input:{origin:'Town Hall Station',destination:'Wynyard Station'},url:'https://transportnsw.info/trip-planner/plan?from=200070&excludedModes=11&to=200080',selector:'body'}]},
  {id:'ebay',origin:'https://www.ebay.com.au',profile:undefined,
    visits:[{input:{},url:'https://www.ebay.com.au/',selector:'body'}]},
  {id:'bom',origin:'https://www.bom.gov.au',profile:undefined,
    visits:[{input:{},url:'https://www.bom.gov.au/',selector:'body'}]},
];
const selected=(process.env.CLAPPING_HANDS_JS_SITES??'transport,ebay,bom').split(',');
if(selected.some(id=>!cases.some(c=>c.id===id)))throw new Error('Unknown site');
for(const c of cases.filter(c=>selected.includes(c.id))) {
  const root=resolve('.data/js-compilation',c.id);
  if(c.id==='marketplace'&&!c.profile)throw new Error('Existing profile must be explicitly selected');
  const session=new TaskSession(c.origin,c.profile??resolve(root,'capture-profile'));
  await session.start();
  try {
    const page=session.context.pages()[0]??await session.context.newPage();
    for(const visit of c.visits) {
      const mark=session.evidenceNetwork.mark();let status='visited',httpStatus:number|undefined;
      const started=performance.now();
      try {
        await session.evidenceNetwork.withDocumentResponses(async()=>{
          const response=await page.goto(visit.url,{waitUntil:'domcontentloaded',timeout:30_000});httpStatus=response?.status();
          if(httpStatus!==200){status='http-non-success';return;}
          await page.locator(visit.selector).first().waitFor({timeout:15_000});
          // Let the already-known route's background requests settle. This is
          // not agent navigation or a success oracle.
          await page.waitForLoadState('networkidle',{timeout:8_000}).catch(()=>{});
        });
      }catch{status='navigation-or-result-unavailable';}
      let exchanges:unknown[]=[],diagnostics:unknown,dom='';
      try{exchanges=await session.evidenceNetwork.since(mark);diagnostics=session.evidenceNetwork.diagnosticSnapshotSince(mark);}catch{diagnostics={status:'incomplete'};}
      try{dom=await page.content();}catch{status='page-closed';}
      const saved=await saveEvidenceBundle(root,{kind:'known-page-network-capture',input:visit.input,url:visit.url,status,httpStatus:httpStatus??null,
        exchanges,diagnostics,dom,provenance:'direct known URL, no Browser Use',taskSuccess:'not-asserted',durationMs:performance.now()-started});
      console.log(JSON.stringify({site:c.id,status,httpStatus,evidenceId:saved.id,responses:exchanges.length}));
    }
  }finally{await session.close();}
}
