/** Whole-segment inputs only. Encoding must not change route structure, including
 * through a second server-side decode. Keep the route's first segment fixed. */
export function encodedPathInput(value: unknown): string {
  if (!['string','number','boolean'].includes(typeof value) ||
      (typeof value==='number' && !Number.isFinite(value))) throw new Error('Invalid path input.');
  const text=String(value);
  if (!text || text.length>512 || text==='.' || text==='..' || /[\\/%?#\u0000-\u0020\u007f]/.test(text)) {
    throw new Error('Path input cannot change route structure.');
  }
  return encodeURIComponent(text);
}

export function observedPathBindings(path: string, input: Record<string,unknown>): Record<string,number[]> {
  const bindings:Record<string,number[]>={};
  for(const [name,value] of Object.entries(input)) {
    let encoded:string;try{encoded=encodedPathInput(value);}catch{continue;}
    const indices=path.split('/').flatMap((segment,i)=>i>=2 && segment===encoded?[i]:[]);
    if(indices.length)bindings[name]=indices;
  }
  return bindings;
}

export function pathSignature(path:string,input:Record<string,unknown>):string {
  const segments=path.split('/'),used=new Set<number>();
  for(const [name,indices] of Object.entries(observedPathBindings(path,input)))for(const i of indices){
    if(used.has(i))throw new Error('Ambiguous path input.');
    used.add(i);segments[i]='{'+JSON.stringify(name)+'}';
  }
  return JSON.stringify(segments);
}

export function materializeRequestPath(path:string,bindings:Record<string,number[]>|undefined,input:Record<string,unknown>):string {
  const segments=path.split('/');
  for(const [name,indices] of Object.entries(bindings??{}))for(const i of indices)segments[i]=encodedPathInput(input[name]);
  return segments.join('/');
}
