import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { load } from 'cheerio';

// Trusted worker code. Generated source is evaluated only inside QuickJS/WASM.
// No host object, Node function, environment or module loader enters the guest.
const port=parentPort!;
const LIMIT=1_000_000;
let pending:((value:unknown)=>void)|undefined;
port.on('message',message=>{const resolve=pending;pending=undefined;resolve?.(message);});
async function main(){
  const engine=await getQuickJS(),runtime=engine.newRuntime();
  runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(256*1024);
  let interrupts=0;runtime.setInterruptHandler(()=>++interrupts>10_000);
  runtime.removeModuleLoader();
  const vm=runtime.newContext();
  let advance;
  try {
    const initialized=vm.evalCode(`(()=>{const stringify=JSON.stringify,parse=JSON.parse;const iterator=(${workerData.source})(${JSON.stringify(workerData.input)});if(!iterator||typeof iterator.next!=='function')throw Error('Expected generator');return json=>{const result=iterator.next(parse(json));return stringify({done:result.done,value:result.value});};})()`);
    if(initialized.error){initialized.error.dispose();throw Error('invalid-program');}
    advance=initialized.value;
    let reply:unknown=null;
    for(let steps=0;steps<128;steps++){
      const argument=vm.newString(JSON.stringify(reply));
      const result=vm.callFunction(advance,vm.undefined,argument);argument.dispose();
      if(result.error){result.error.dispose();throw Error('guest-failed');}
      let encoded:string;
      try{encoded=vm.getString(result.value);}finally{result.value.dispose();}
      if(encoded.length>LIMIT)throw Error('output-limit');
      const step=JSON.parse(encoded);
      if(typeof step.done!=='boolean')throw Error('invalid-protocol');
      if(step.done){port.postMessage({kind:'result',value:step.value});return;}
      const operation=step.value;
      if(operation?.op==='select'){
        if(typeof operation.html!=='string'||operation.html.length>LIMIT||typeof operation.selector!=='string'||operation.selector.length>500)throw Error('invalid-selection');
        const $=load(operation.html);
        const nodes=$(operation.selector).slice(0,100);
        reply=nodes.toArray().map(node=>({text:$(node).text(),html:$.html(node),attributes:{...(node as any).attribs}}));
      }else if(operation?.op==='url'){
        if(typeof operation.base!=='string'||typeof operation.relative!=='string'||operation.base.length>4000||operation.relative.length>4000)throw Error('invalid-url');
        const url=new URL(operation.relative,operation.base);
        if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('invalid-url');
        reply=url.href;
      }else if(operation?.op==='request'){
        reply=await new Promise(resolve=>{pending=resolve;port.postMessage({kind:'request',operation});});
        if((reply as any)?.denied)throw Error('request-denied');
      }else throw Error('unsupported-capability');
      if(JSON.stringify(reply).length>LIMIT)throw Error('response-limit');
    }
    throw Error('step-limit');
  }finally{advance?.dispose();vm.dispose();runtime.dispose();}
}
main().catch(()=>port.postMessage({kind:'failure'})).finally(()=>port.close());
