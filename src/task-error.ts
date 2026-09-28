/** Product-owned errors: never carry caller values, upstream messages or causes. */
export class TaskError extends Error {
  constructor(readonly code: 'runtime-closed' | 'owner-paused' | 'runtime-busy' | 'queue-timeout' | 'task-exists' | 'unknown-task' | 'invalid-action' | 'invalid-listing-url' | 'incompatible-evidence' | 'demonstration-required' | 'caller-attachment-unsupported' | 'search-unverified' | 'saved-plan-changed') {
    super(code);
  }
}
