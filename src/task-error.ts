/** Product-owned errors: never carry caller values, upstream messages or causes. */
export class TaskError extends Error {
  constructor(readonly code: 'runtime-closed' | 'runtime-busy' | 'task-exists' | 'unknown-task' | 'invalid-action' | 'incompatible-evidence' | 'demonstration-required') {
    super(code);
  }
}
