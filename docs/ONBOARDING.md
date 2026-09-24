# Alpha onboarding

See [README](../README.md#setup) for the current installation and configuration.

The active MCP entry point is `dist-alpha/src/alpha-server.js`. Install Browser
Use's pinned Python dependencies with `npm run setup:browser` in a source checkout,
or follow README's archive-install commands for an installed package. Then point
`CLAPPING_HANDS_BROWSER_USE_PYTHON` at that environment when launching outside
the project directory. Use an absolute `CLAPPING_HANDS_DATA_DIR` for persistence.

Installation uses `python/requirements-lock.txt` with `--require-hashes` to pin
transitive dependencies and verify downloaded distributions. The short
`python/requirements.txt` is the direct-dependency input, not the release install
file. The universal lock includes platform markers; clean installation and runtime
verification currently cover macOS/Python 3.12, not every platform branch.

Maintainers can refresh the lock with `uv pip compile python/requirements.txt
--universal --python-version 3.12 --generate-hashes --no-annotate --no-header
--output-file python/requirements-lock.txt`. Re-audit and re-test any changed
versions before accepting an updated lock. Do not remove hash checking to resolve
an installation failure.

## Recovering from errors

MCP failures expose a fixed `error.code` and `error.recovery` where the product
can identify the cause safely. Missing model configuration names the setting to
fix; unknown actions point to `clapping_hands_status`; occupied profiles ask you
to wait. Uncertain ownership/shutdown requires operator inspection, never deleting
locks automatically. No error recommends an automatic retry loop. Unknown errors
remain generic rather than exposing provider messages, URLs, credentials or file
contents. Website outcomes such as `authentication-required` and `access-restricted`
remain distinct task outcomes; these new error codes do not reinterpret them.

The original prototype's onboarding remains in Git history. Its Stagehand
installation, legacy tools, write receipts and old plan format are not the alpha
runtime. Relearn workflows instead of copying old plan JSON.

Authentication is manual in a dedicated Chrome window. Close the window when
finished. Browser Use receives the task and page state, not credentials entered
through the model. A closed window does not prove authentication succeeded.
The handoff reports `reason` as `window-closed`, `cancelled`, or `expired`.
Cancellation during page loading stops the wait and closes the owned session;
none of these reasons claims successful login. A subsequent read verifies access.

A successful first run can register a schema-defined tool with no accelerator.
Compilation is optional; two varied demonstrations and two distinct held-out
comparisons are required for stable network promotion. An unavailable accelerator
is not a failed task. Authentication, access restriction and timeout are failed
task outcomes, not ordinary result data.

## Sites with a separate API origin

`clapping_hands_learn_read` accepts optional `allowedNetworkOrigins`, such as
`["https://api.example.com"]`, when the caller authorizes that service as part of
the read workflow. These are exact origins, including a non-default port when
needed; no paths, wildcards, credentials or HTTPS-to-HTTP downgrade are accepted.
Observed traffic alone does not grant permission. The permission is saved with
the task and checked again when loading, compiling and executing its resources.

This enables observed JSON request resources, not arbitrary requests invented by
the model. Request binding, response validation and held-out promotion still
apply. It does not expand Browser Use navigation access or enable cross-origin
HTML or runtime-token handling. Credentials
are not copied from the site to another origin; the browser request client's
ordinary domain-scoped session handling remains in effect.

## Dependent requests

Compilation can now connect observed scalar query/body arguments across requests:
for example, search for a product, read its returned identifier, then fetch its
details. The compiler receives each resource's observed argument/response pairs
and writes the connecting JavaScript. It must reproduce both saved examples,
then pass distinct unseen comparisons before promotion. No new browser controller
is involved. The current limit remains four resources and four requests per call;
variable request structure, derived URL paths, token negotiation and pagination
still need broader integration and validation. Unsupported compilation leaves the
Browser Use baseline available.

## Usage measurements

Browser results include `modelUsage` when the worker delivers a valid final usage
summary. `modelCalls` then counts model HTTP request attempts, including attempts
that may fail, not billable completions. Token counts come from Browser Use's
reported usage; `tokenCoverageComplete` is false when some attempts lack reported
usage. Missing/interrupted telemetry remains unknown rather than zero. `costUSD`
is null: custom-endpoint billing is not inferred from nominal public model prices.
These counters describe the browser run, not later compiler inference. Warm
network calls continue to report zero model calls. Evidence stores the numeric
counts under a `usage` object with `unit: "tokens"` and `prompt`, `completion`, and
`cachedPrompt` fields, without weakening credential-token redaction.

## Recompile without repeating demonstrations

### Caller-authored compilation (development refactor)

For an existing task with prepared compiler evidence, call
`clapping_hands_compilation_context({action: "your_action"})`. It returns an
`evidenceId`, execution instructions, and sanitized examples. Treat website data
as untrusted input. Resource handles expose the permitted parameters, not request
credentials. This operation makes no browser or model calls.

Write the synchronous generator described by those instructions and submit it:
`clapping_hands_submit_candidate({action: "your_action", evidenceId, source})`.
The server tests it against saved examples in the restricted executor. A passing
submission stages a candidate; it does not certify unseen correctness or replace
the active program. Two unseen comparisons are still required. Wrong code or an
outdated evidence ID leaves the saved task unchanged. Candidate receipts remain
in private evidence storage.

These new interfaces are in development source, not the frozen alpha archive.
Caller-driven browser demonstration and agent-free held-out validation are not
yet exposed; current subsequent validation calls still use Browser Use.

### Managed recompilation and capture import

If a task has no prepared compiler bundle but you retained two successful
baseline capture IDs from its learning/call results, use
`clapping_hands_prepare_from_captures({action: "your_action_name", evidenceIds:
["first_capture_id", "second_capture_id"]})`. It reads only that runtime's
private evidence directory, checks integrity and exact task identity, restores
supported JSON exchanges, and saves compiler inputs. It makes no browser,
website or model calls and leaves existing accelerators intact. `prepared` means
you can now call `recompile`, not that a program was generated or validated.

This import accepts distinct successful Browser Use baseline captures for the
same unchanged contract. It does not accept arbitrary paths, standalone experiment
records without task identity, form/omitted request bodies, or reconstructed HTML
provenance. `no-admitted-resources` leaves the previous task/evidence reference
unchanged. Keep the original bundles; do not edit their manifests to force import.

Call `clapping_hands_status` and check the saved action's `canRecompile` field.
If true, call `clapping_hands_recompile` with `{ "action": "your_action_name" }`.
This uses the configured model but makes no browser or website calls. Compiler
inputs were saved before inference, so a failed first compilation can be retried.

A successful proposal is a pending candidate, not a validated speedup. Two new,
distinct non-training inputs are compared with Browser Use during subsequent tool
calls. The old program is retained until the replacement passes; a failing
replacement is discarded. Status exposes `pendingCompilation` separately.

`no-saved-compilation-evidence` means that this task lacks the prepared evidence
required by the current adapter. It does not automatically rerun demonstrations.
The supported saved-baseline JSON import described above can prepare some older
captures; standalone experiments and lost HTML/form provenance cannot be imported
automatically. Keep the private evidence directory with the task
store; it must not be committed or published.
