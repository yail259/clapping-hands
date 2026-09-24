import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFailure } from '../src/public-error.js';
import { LearnerConfigurationError } from '../src/learner-model.js';
import { ProfileInUseError, ProfileRecoveryRequiredError } from '../src/profile.js';
import { BrowserShutdownError } from '../src/browser-lifecycle.js';
import { TaskError } from '../src/task-error.js';

test('public errors identify product categories without forwarding messages or causes', () => {
  for (const error of [new LearnerConfigurationError('missing-api-key'), new ProfileInUseError('secret'),
    new ProfileRecoveryRequiredError(), new BrowserShutdownError(), new TaskError('unknown-task')]) {
    error.message = 'secret';
    error.cause = { apiKey: 'secret' };
    const result = publicFailure(error);
    assert.equal(result.isError, true);
    assert.notEqual(result.structuredContent.error.code, 'task-failed');
    assert.equal(result.structuredContent.error.automaticRetryRecommended, false);
    assert.ok(result.structuredContent.error.recovery.length > 20);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('provider errors and forged category objects get only generic recovery guidance', () => {
  for (const error of [new Error('secret'), { name:'LearnerConfigurationError', reason:'missing-api-key', code:'PROFILE_IN_USE', apiKey:'secret' }, null]) {
    const result = publicFailure(error);
    assert.equal(result.structuredContent.error.code, 'task-failed');
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
