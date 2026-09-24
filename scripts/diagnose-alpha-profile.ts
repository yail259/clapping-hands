import { TaskSession } from '../src/task-session.js';
import { assertWorkflowAuth } from '../src/workflow-auth.js';
const profile = process.env.CLAPPING_HANDS_AUTH_PROFILE_DIR;
if (!profile) throw new Error('Set the authorized profile directory.');
const session = new TaskSession('https://www.facebook.com',profile,true);
let started=false,phase='launch';
try {
  console.log(JSON.stringify({ phase }));
  await session.start(); started=true; phase='navigation'; console.log(JSON.stringify({ phase }));
  const page=session.context.pages()[0] ?? await session.context.newPage();
  const response=await page.goto('https://www.facebook.com/marketplace/sydney/',{ waitUntil:'domcontentloaded',timeout:30000 });
  phase='auth-check'; console.log(JSON.stringify({ phase,http:response?.status() }));
  await assertWorkflowAuth(page,'https://www.facebook.com');
  console.log(JSON.stringify({ phase,authGatePassed:true,listingAccessProven:false }));
} catch(error) {
  const value=error as {name?:string;code?:string;reason?:string};
  console.log(JSON.stringify({ phase,failed:true,category:value.name,code:/^[A-Z0-9_-]{1,60}$/.test(value.code??'')?value.code:null }));
} finally {
  if(started) {try {await session.close();console.log(JSON.stringify({cleanup:true}));}catch{console.log(JSON.stringify({cleanup:false}));}}
}
