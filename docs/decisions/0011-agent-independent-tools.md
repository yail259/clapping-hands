# ADR 0011 — Agent-independent learning and compilation

Status: implementation in progress. Existing alpha artifact is unchanged.

ClappingHands owns evidence, contracts, candidate checks, promotion, execution
and persistence. Demonstration and code generation are separate optional providers.
The calling agent may supply either; Browser Use and the configured compiler
model remain managed adapters. No new internal navigation controller is required.

## Acceptance gates

- Caller demonstration through one supported explicitly shared browser session.
- Captures, inputs and outputs bound to the same contract and learning session.
- Caller-visible sanitized compiler context and submitted JavaScript candidates.
- Identical bounded offline validation for submitted and delegated code.
- Two distinct unseen comparisons before promotion; caller cannot self-promote.
- Generated MCP tool survives restart and runs with no internal model credentials.
- Default caller-driven failure returns control, not an unexpected paid agent call.
- Managed demonstration/compilation remain available and regression-tested.
- Session cleanup, cancellation, invalid candidates, corrupted evidence and
  unauthorized request scope have tested refusals without losing working tools.
- End-to-end fixture tests, full suite, build and package smoke cover new interfaces.

## First checkpoint

`compilationContext` and `validateJavaScriptCandidate` are shared agent-neutral
boundaries. The existing delegated compiler uses them. Offline submission checks
do not call a model, browser or website, do not write a task, and do not promote
the result. They enforce resource scope, exact observed arguments, schema and
training-output comparisons in the existing bounded executor.

## MCP candidate checkpoint

`clapping_hands_compilation_context` loads the integrity-checked current compiler
bundle and returns the shared execution instructions, contract, resource handles
and sanitized examples. `clapping_hands_submit_candidate` requires that evidence
ID, records candidate provenance, applies the shared offline validator, then uses
a conditional task save to stage a replacement. It neither promotes code nor
overwrites the active generation. Context and submission make no model calls.

Nine focused tests pass, including a built MCP client with unavailable model,
Python agent and browser paths. It obtains context, stages correct caller code,
rejects wrong outputs and mismatched evidence IDs, and preserves prior state.
Build and whitespace checks pass. This is not yet caller-driven demonstration or
unseen validation: subsequent execution still uses the existing baseline path.

## Demonstration provider checkpoint

`demonstration.ts` owns capture windows, outcome validation, passive page evidence,
usage accounting and redacted persistence. It accepts an explicit provider and
does not resolve model configuration. `browser-use-demonstrator.ts` is the managed
adapter; the existing runtime baseline delegates through the same capture module.
Caller provenance is distinct from Browser Use provenance, never silently relabelled.
Focused tests cover recorder windows, redaction, malformed outcomes, cancellation,
optional capture failure and the prior baseline/compiler behavior (21 passing).
The subsequent complete local regression suite passes **276/276**, with a clean
build. This checks the combined refactor so far, including controlled Chrome
fixtures; no paid model or production-site run was used for this checkpoint.

## Shared-browser recording checkpoint

`CallerRecording` owns one dedicated local session and exposes its CDP connection
only after both recorders surround the caller wait. The caller submits a typed
outcome; malformed outcomes leave recording open for correction, while completed,
cancelled and expired recordings reject further submissions. Closing is shared
and idempotent. The caller's CDP access is privileged local browser access, not a
sandbox; it must be explicitly authorized and used only for the scoped workflow.

Three tests pass: capture-before-connection and duplicate-finish handling;
abort/deadline/browser-close cleanup; and a separate real Playwright CDP client
driving an owned Chrome fixture while the recorder captures its search request
and final HTML. No model configuration or production site is used. This proves
the browser-sharing primitive, not compatibility with every third-party browser MCP.

## Caller MCP and live dogfood checkpoint (2026-09-24)

The MCP server now exposes start, finish and cancel for caller recordings, the
saved task can be called without a model, and caller-learned tasks return control
on a failed fast path unless the separate delegate tool is invoked. Two unseen
caller-driven comparisons can promote a submitted candidate. A built MCP smoke
completed two local CDP demonstrations and confirmed generated tools register
once. An authenticated Sydney Marketplace search matched two varied training
examples and two unseen browser observations; the stable browser-document path
then returned fresh cards with zero model calls. See the Marketplace read slice and
ADR 0012 for scope and limits. Packaged release acceptance remains open.
