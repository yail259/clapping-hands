import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { BrowserContext } from 'playwright-core';
import { authenticationHandoff } from '../src/authentication-handoff.js';
import { TaskRuntime } from '../src/task-runtime.js';
import { TaskSession } from '../src/task-session.js';

test('authentication wait removes close/abort listeners on every exit, including already-aborted signals',async()=>{
  for(const reason of ['window-closed','cancelled','expired','already-aborted'] as const){
    const context=new EventEmitter(),abort=new AbortController();
    if(reason==='already-aborted')abort.abort();
    const wait=authenticationHandoff(context as unknown as BrowserContext,abort.signal,10);
    if(reason==='window-closed')context.emit('close');
    if(reason==='cancelled')abort.abort();
    // Keep the test process alive for the intentionally unreferenced deadline.
    const keepAlive=setTimeout(()=>{},100);
    try{assert.equal(await wait.done,reason==='already-aborted'?'cancelled':reason);}finally{clearTimeout(keepAlive);}
    assert.equal(context.listenerCount('close'),0);assert.equal(getEventListeners(abort.signal,'abort').length,0);wait.dispose();
  }
  const context=new EventEmitter(),abort=new AbortController();
  const wait=authenticationHandoff(context as unknown as BrowserContext,abort.signal);wait.dispose();
  assert.equal(context.listenerCount('close'),0);assert.equal(getEventListeners(abort.signal,'abort').length,0);
});

test('runtime interruption during a stalled login navigation finishes without waiting for page timeout',async()=>{
  const runtime=new TaskRuntime(await mkdtemp(join(tmpdir(),'auth-cancel-'))),context=new EventEmitter();
  let started!:()=>void;const navigating=new Promise<void>(r=>{started=r;});let closed=false;
  (context as any).pages=()=>[{goto:()=>{started();return new Promise(()=>{});}}];
  (runtime as any).session=async(_definition:unknown,fn:(s:unknown)=>Promise<unknown>)=>{
    try{return await fn({context});}finally{closed=true;context.emit('close');}
  };
  const auth=runtime.authenticate('https://fixture.invalid/login');await navigating;
  await runtime.close();const result=await auth;
  assert.equal(result.reason,'cancelled');assert.equal(result.authenticated,'not-asserted');assert.equal(closed,true);
  assert.equal(context.listenerCount('close'),0);
});

test('runtime login handoff preserves the isolated session across restart and detects fixture expiry',async()=>{
  const server=createServer(async(req,res)=>{
    if(req.method==='POST' && req.url==='/login'){
      let body='';for await(const chunk of req)body+=chunk;
      const values=new URLSearchParams(body);
      if(values.get('email')!=='fixture@example.invalid' || values.get('password')!=='fixture-only') {res.writeHead(400);res.end();return;}
      res.writeHead(303,{'set-cookie':'fixture_login=yes; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',location:'/protected'});res.end();return;
    }
    if(req.url==='/protected'){
      const allowed=req.headers.cookie?.includes('fixture_login=yes');res.writeHead(allowed?200:401,{'content-type':'text/html'});
      res.end(allowed?'<h1>Member content</h1>':'<h1>Login required</h1>');return;
    }
    res.writeHead(200,{'content-type':'text/html'});res.end('<form action="/login" method="post"><input name="email" type="email"><input name="password" type="password"><button>Sign in</button></form>');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  const runtime=new TaskRuntime(await mkdtemp(join(tmpdir(),'auth-handoff-')));
  let ready!:(session:TaskSession)=>void;const sessionReady=new Promise<TaskSession>(r=>{ready=r;});
  const original=(runtime as any).session.bind(runtime);
  // Only the headless flag and fixture operator are substituted. Runtime handoff,
  // browser, profile ownership, navigation, cookies and restart are real.
  (runtime as any).session=(definition:unknown,fn:(session:TaskSession)=>Promise<unknown>)=>original(definition,async(session:TaskSession)=>{ready(session);return fn(session);},true);
  let restarted:TaskSession|undefined;
  try{
    const auth=runtime.authenticate(origin+'/login');void auth.catch(()=>{}); // Observe immediately while the fixture operator signs in.
    const session=await sessionReady,page=session.context.pages()[0]!;
    await page.locator('input[name=email]').fill('fixture@example.invalid');await page.locator('input[name=password]').fill('fixture-only');
    await page.getByRole('button',{name:'Sign in'}).click();await page.waitForURL(origin+'/protected');
    assert.equal(await page.locator('h1').innerText(),'Member content');await session.context.close();
    assert.deepEqual(await auth,{status:'manual-auth-window-closed-or-expired',authenticated:'not-asserted',reason:'window-closed'});
    await runtime.close();restarted=new TaskSession(origin,runtime.profile(origin));await restarted.start();
    const p=restarted.context.pages()[0]!;assert.equal((await p.goto(origin+'/protected'))?.status(),200);
    assert.equal(await p.locator('h1').innerText(),'Member content');await restarted.context.clearCookies();
    assert.equal((await p.goto(origin+'/protected'))?.status(),401);
  }finally{await runtime.close();await restarted?.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
