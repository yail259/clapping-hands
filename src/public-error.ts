import { LearnerConfigurationError } from './learner-model.js';
import { ProfileInUseError, ProfileRecoveryRequiredError } from './profile.js';
import { BrowserShutdownError } from './browser-lifecycle.js';
import { TaskError } from './task-error.js';
import { BrowserSessionProviderError } from './browser-session-provider.js';
import { WorkflowAccessError } from './workflow-auth.js';

const taskGuidance = {
  'demonstration-required':'No validated fast path completed. Use caller recording to demonstrate or validate this task, or explicitly request delegated execution. No internal agent was invoked.',
  'runtime-closed': 'Restart the MCP server before making another call.',
  'owner-paused': 'The CH browser owner paused sourcing. This read did not complete; wait for owner hand-back and make a fresh read.',
  'runtime-busy': 'Wait for the active browser operation to finish before making another call.',
  'queue-timeout': 'This read did not start before the queue deadline. Submit a fresh read after the queue clears; batch exact listing URLs where possible.',
  'task-exists': 'This action already exists. Call its generated tool, recompile its saved evidence, or choose a different action name.',
  'unknown-task': 'Call clapping_hands_status to list saved actions. Learn the task first if it is not listed.',
  'invalid-action': 'Use an action name of 2–63 lowercase letters, digits or underscores, starting with a letter.',
  'invalid-listing-url': 'Supply 1–8 distinct exact facebook.com Marketplace item URLs. A trailing slash and sharing query parameters are optional; other sites, paths and duplicate items are outside this read.',
  'incompatible-evidence': 'Use two distinct successful baseline capture IDs for this exact saved task. Foreign tasks, changed contracts, missing outputs and unsupported inputs cannot be imported. Preserve the original evidence.',
  'caller-attachment-unsupported': 'This browser provider does not allow handing a browser endpoint to the MCP caller. Use a runtime-mediated browser operation.',
  'search-unverified': 'The current search could not be verified as cards or a known empty state. Do not infer zero listings; try a broader term or use a visible browser check.',
  'saved-plan-changed': 'The saved Marketplace plan differs from the pinned MCP release. The owner must review the plan and reinstall the connection before another read.',
} as const;
const browserSessionGuidance = {
  'owner-control-revoked': 'The browser owner took control. This operation did not complete; wait for the owner hand-back before starting a new operation.',
  'broker-unavailable': 'The company browser broker is unavailable. This operation did not complete; do not launch a replacement browser.',
  'runtime-generation-changed': 'The company Runtime changed during this operation. This operation did not complete; start again in the current Runtime.',
} as const;
const configurationGuidance = {
  'missing-endpoint': 'Set GPT_BASE_URL in the MCP server environment or configured credential file, then restart the server.',
  'missing-api-key': 'Set GPT_API_KEY in the MCP server environment or configured credential file, then restart the server. Never paste credentials into a tool call.',
  'unreadable-env-file': 'Check that CLAPPING_HANDS_CREDENTIAL_ENV_FILE names an accessible credential file. Do not paste its contents into a tool call.',
  'invalid-endpoint': 'Set GPT_BASE_URL to an HTTPS API base URL without credentials, query parameters or a fragment, then restart the server.',
} as const;

/** Only class-identified, fixed product categories cross the MCP boundary.
 * Do not inspect arbitrary error messages, code fields, causes or provider data. */
export function publicFailure(error: unknown) {
  let code = 'task-failed';
  let recovery = 'Check configuration, authentication, profile ownership and saved task integrity. Preserve evidence; do not delete profiles or retry in a loop.';
  if (error instanceof LearnerConfigurationError) {
    code = error.reason;
    recovery = configurationGuidance[error.reason];
  } else if (error instanceof ProfileInUseError) {
    code = 'profile-in-use';
    recovery = 'Wait for the process using this dedicated browser profile to finish. Do not delete its lock or launch a second owner.';
  } else if (error instanceof ProfileRecoveryRequiredError) {
    code = 'profile-recovery-required';
    recovery = 'Profile ownership could not be verified. Preserve the profile and lock; have the operator inspect the owning process before recovery.';
  } else if (error instanceof BrowserShutdownError) {
    code = 'browser-shutdown-uncertain';
    recovery = 'Close the dedicated browser and verify profile ownership before retrying. Do not delete profile locks.';
  } else if (error instanceof BrowserSessionProviderError) {
    code = error.code;
    recovery = browserSessionGuidance[error.code];
  } else if (error instanceof WorkflowAccessError) {
    code = error.reason === 'http-403' ? 'access-restricted' : 'auth-required';
    recovery = error.reason === 'http-403'
      ? 'The site refused this read. Keep the lead unverified and use a visible browser check when access returns.'
      : 'The saved browser session reached a login or verification page. Ask the owner to sign in through the dedicated CH browser, then retry the read.';
  } else if (error instanceof TaskError) {
    code = error.code;
    recovery = taskGuidance[error.code];
  }
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `${code}: ${recovery}` }],
    structuredContent: { error: { code, recovery, automaticRetryRecommended: false } },
  };
}
