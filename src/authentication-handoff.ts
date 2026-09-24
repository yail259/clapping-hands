import type { BrowserContext } from 'playwright-core';
export type AuthenticationHandoffReason='window-closed'|'cancelled'|'expired';

/** Own and dispose all three wait sources. Register before navigation so closing
 * or cancelling during page load cannot be lost. No login-success inference. */
export function authenticationHandoff(context:Pick<BrowserContext,'on'|'off'>,signal:AbortSignal,timeoutMs=300_000){
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>300_000)throw new Error('Invalid authentication deadline.');
  let timer:ReturnType<typeof setTimeout>|undefined,settled=false;
  let resolve!:(reason:AuthenticationHandoffReason)=>void;
  const done=new Promise<AuthenticationHandoffReason>(r=>{resolve=r;});
  const dispose=()=>{if(timer)clearTimeout(timer);context.off('close',closed);signal.removeEventListener('abort',cancelled);};
  const finish=(reason:AuthenticationHandoffReason)=>{if(settled)return;settled=true;dispose();resolve(reason);};
  const closed=()=>finish('window-closed');
  const cancelled=()=>finish('cancelled');
  context.on('close',closed);signal.addEventListener('abort',cancelled,{once:true});
  timer=setTimeout(()=>finish('expired'),timeoutMs);timer.unref();
  if(signal.aborted)cancelled();
  return {done,dispose};
}
