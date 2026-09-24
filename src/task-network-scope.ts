type Scope={startUrl:string;allowedNetworkOrigins?:string[]};
/** Explicit caller authority, never inferred from page text or passive traffic. */
export function authorizedNetworkOrigins(scope:Scope):Set<string>{
  const site=new URL(scope.startUrl),extra=scope.allowedNetworkOrigins??[];
  if(!Array.isArray(extra) || extra.length>8 || new Set(extra).size!==extra.length)throw new Error('Invalid API origin authorization.');
  for(const value of extra){
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol) || url.origin!==value || url.hostname.includes('*') || url.username || url.password ||
      (site.protocol==='https:' && url.protocol!=='https:'))throw new Error('API origins must be exact HTTP(S) origins without credentials or HTTPS downgrade.');
  }
  return new Set([site.origin,...extra]);
}
export function assertTaskResourceScope(scope:Scope & {action:string},plan:{origin:string;action:string;request:{endpointOrigin?:string}}):void{
  if(plan.origin!==new URL(scope.startUrl).origin || plan.action!==scope.action ||
    !authorizedNetworkOrigins(scope).has(plan.request.endpointOrigin??plan.origin))throw new Error('Generated resource scope mismatch.');
}
