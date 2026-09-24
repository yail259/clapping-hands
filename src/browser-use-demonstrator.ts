import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DemonstrationProvider } from './demonstration.js';
import { runBrowserUseTask } from './browser-use-task.js';
import { endpointConfiguration, learnerEnvironment } from './learner-model.js';

/** Optional managed worker; core recording does not resolve model credentials. */
export const browserUseDemonstrator:DemonstrationProvider={
  kind:'browser-use',
  async execute(task,options){
    const config=endpointConfiguration(await learnerEnvironment());
    const outcome=await runBrowserUseTask(task,{
      ...options,...config,
      python:process.env.CLAPPING_HANDS_BROWSER_USE_PYTHON??(existsSync(resolve('.venv/bin/python'))?resolve('.venv/bin/python'):'python3'),
      timeoutMs:Number(process.env.CLAPPING_HANDS_TASK_TIMEOUT_MS??180_000),
    });
    return {outcome,model:config.model,secrets:[config.apiKey]};
  },
};
