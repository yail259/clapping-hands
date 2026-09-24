import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("rewritten runtime has no Stagehand dependency", () => {
  const script = `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    let attempts=0;
    registerHooks({resolve(specifier,context,next){
      if(specifier==='@browserbasehq/stagehand'){attempts++;throw new Error('controlled-dependency-unavailable');}
      return next(specifier,context);
    }});
    const {TaskRuntime}=await import('./src/task-runtime.ts');
    assert.equal(typeof TaskRuntime,'function');
    assert.equal(attempts,0);
    console.log('stagehand-free');
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "stagehand-free");
});
