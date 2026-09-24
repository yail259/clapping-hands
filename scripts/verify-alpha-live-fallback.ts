import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { TaskRuntime } from '../src/task-runtime.js';
import { TaskStore } from '../src/task-store.js';

const source=process.argv[2]; if(!source) throw new Error('Supply existing validated Yahoo task directory');
const original=await new TaskStore(join(source,'tasks')).load('yahoo_read');
assert.equal(original?.pageAccelerator?.status,'stable');
const directory=await mkdtemp(join(tmpdir(),'clappinghands-live-fallback-'));
let runtime=new TaskRuntime(directory);
const task=structuredClone(original!);
task.accelerator=null;task.pageAccelerator!.selector='h1.clappinghands_intentionally_missing';
const calls=[];
try {
  await runtime.store.save(task);
  for(let i=0;i<2;i++) {
    if(i){await runtime.close();runtime=new TaskRuntime(directory);}
    const started=performance.now(), result=await runtime.run('yahoo_read',{query:'GOOG'});
    calls.push({result,wallMs:performance.now()-started,restarted:!!i});
    assert.deepEqual(result.outcome,{status:'completed',data:'Alphabet Inc. (GOOG)'});
    assert.equal(result.engine,'browser-use');assert.equal(result.fallback,i===0);
    assert.equal((await runtime.store.load('yahoo_read'))?.pageAccelerator?.status,'degraded');
    console.log(JSON.stringify({phase:i?'restart-skips-degraded':'broken-plan-fallback',passed:true}));
  }
} finally {
  await runtime.close(); const reports=resolve('bench/runs',new Date().toISOString().slice(0,10));await mkdir(reports,{recursive:true});
  await writeFile(join(reports,`alpha-live-fallback-${Date.now()}.json`),JSON.stringify({site:'yahoo',originalUntouched:true,directory,calls},null,2),{mode:0o600,flag:'wx'});
}
