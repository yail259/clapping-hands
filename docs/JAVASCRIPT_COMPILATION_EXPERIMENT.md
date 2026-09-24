# Model-authored JavaScript compilation — 2026-09-07

## Scope and current evidence

Machine-checked counts and source hashes:
[`js-compilation-1788790180562.json`](../bench/runs/2026-09-07/js-compilation-1788790180562.json).
The cohort began September 7; follow-ups continued September 8 in Sydney.

This is a compilation-only experiment, not another Browser Use benchmark and
not a completed migration of the production MCP runtime. Browser Use was not
invoked for these experiments. Previously observed URLs/request shapes and task
contracts were reused. Where old raw traffic was missing, direct HTTP requests
or deterministic visits to known URLs collected new response evidence.

The model authors an ordinary JavaScript generator: input bindings, selectors,
JSON parsing, loops, nested output construction, URL resolution and validation.
The host supplies explicitly scoped read resources. Resource discovery and
effect classification are **not** proved automatic by this experiment. Test
oracles are independently authored and are not included in compiler prompts;
training outputs are included, held-out outputs are not. Generated source was
not manually edited.

| Workflow | First held-out pass | New-process reuse | Observed successful call range |
| --- | --- | --- | --- |
| Open Library: five books, author arrays, years, URLs | 3/3 exact | 3/3 exact | 1.71–8.41 s |
| Yahoo: company heading | 3/3 exact | 3/3 exact | 1.19–2.27 s |
| GOV.UK: first search title | 3/3 exact | 3/3 exact | 0.11–2.56 s |
| RBA: calculated amount, three inputs | 3/3 exact | 3/3 exact | 0.13–1.28 s |
| Bunnings: first product title | 2/3 exact; one response capture failed | 3/3 exact | 1.53–1.89 s |
| IKEA: first product name from JSON search | 3/3 exact against plain Chrome | 3/3 exact against plain Chrome | 0.33–0.80 s |
| Transport NSW: Central-to-station duration | 3/3 exact against plain Chrome | 3/3 exact against plain Chrome | 1.00–1.21 s |
| Facebook Marketplace: five current-price listings | Network paths: 0/6; browser-document path: 3/3 exact | Browser-document: 3/3 exact | 9.98–10.99 s, browser-backed |
| eBay | Plain Chrome entry page returns 403; no successful response to compile | Not applicable | — |
| BOM | Plain Chrome entry page returns 403; no successful response to compile | Not applicable | — |

The ten-site scope is now assessed: **seven network-backed candidates, one
browser-backed candidate, and two access-restricted sites**. Across the selected
generated programs there were **47 exact matches in 54 held-out execution
attempts**, including restart repeats. The seven failures were one Bunnings
capture failure and six Marketplace network-tier failures. Compilation declines
and pre-compilation evidence failures are separate and described below; they are
not hidden inside that execution denominator.

All successful executions avoided model calls. The first six rows made one
network request each. Transport made three: resolve the origin station, resolve
the destination, request the journey. Marketplace's successful tier navigated
Chrome and parsed rendered HTML: one **resource invocation**, not one network
request, and definitely not network-only execution. The independent
checker for the first five rows parsed the same fresh response using separate
code; those rows do not yet establish agreement with a fresh rendered-browser
oracle. IKEA, Transport and Marketplace checks used separate plain-Chrome page
visits after execution.
Its generated code builds the nested JSON POST body and selects the first
product name from the JSON response. Network fetch,
sanitization and evidence persistence are included in execution timings. These
small timing samples are not distributions or same-input speedup ratios against
the old Browser Use benchmark. The new processes used saved programs without
model credentials; they fetched new response data rather than cached answers.

## Failures retained, not hidden

- The first Open Library proposal was declined because the test oracle treated
  an author-suggestion card as a book and generated an `/undefined` link. The
  checker was corrected to select real books, then the model was called again
  with the **saved HTML**, without re-fetching training pages.
- Bunnings initially exceeded the prompt budget. Removing CSS and SVG from the
  prompt view, while retaining the full sanitized capture, resolved that limit.
  The model then caught another oracle error: a navigation `Shop Now` paragraph
  was counted as a product. The checker was restricted to the main results area;
  the model was rerun from saved evidence, not browser navigation.
- One Bunnings held-out request failed during capture before extraction. The
  original failure remains recorded; the same generated source passed that
  input after restart. This is not a clean 100% first-pass execution result.
- IKEA revealed that same-origin evidence filtering discarded its actual search
  service response. Passive all-origin capture is now separate from the existing
  restricted execution recorder. Recording a response does not grant permission
  to replay it. Explicit experimental read-resource admission is still required.
- Marketplace initially declined because examples did not contain every failure
  state. The prompt was clarified to propose a candidate and throw on missing or
  uncertain results; it must not claim exhaustive reliability or put auth status
  inside successful output. Exact held-out validation was not relaxed. Direct
  request-context HTTP returned 400; native browser fetch returned a 200 shell
  without listing links. Both were refused. The same generated source then
  passed against rendered HTML, including a second process/profile restart.
  Persistent login worked on that tier; network-only Marketplace is unresolved.
- Transport compiled from supporting route observations rather than fresh agent
  demonstrations of the target task. The model sequenced station lookup and trip
  calls; the broker restricted GraphQL to observed read operations and verified
  that the selected IDs belonged to the requested station-name resolutions.
  Departing-now results can change between checks; exact agreement here is a
  small-sample result, not a guarantee against that race.

## Supplemental Find a Tender case

The earlier rich-output cohort also included Find a Tender. The initial generated
parser returned five correctly shaped notices but failed all three independent
browser comparisons: the experimental form broker omitted the clicked submit
button, and the server returned the **previous query's results with HTTP 200**.
An observed real form submission identified the missing submitter. The generic
form helper now retains the single named submitter and refuses ambiguous forms.
The unchanged generated parser then passed all three comparisons and all three
checks after another process restart, in 3.30–4.70 seconds including two network
requests per call. The original three mismatches remain in the public summary.
This is a
transport correction, not a manually rewritten generated parser. The case is
supplemental and is not counted as one of the original ten sites.

## Durable artifacts and safety boundaries

Private local artifacts live under `.data/js-compilation/`, not in public
benchmark reports. Each bundle has an immutable payload, checksum manifest,
creation time, private permissions and explicit omissions. Compiler system text,
prompts, proposals, captures, oracle results, failures and timing results are
retained. Loading rejects incomplete or modified bundles. Auth credentials are
not replay artifacts: known secrets, sensitive fields, authentication endpoint
bodies and credential-bearing URLs are redacted or omitted. Form bodies are
decoded before redaction, including repeated and nested fields.

Baseline execution now also persists passive network evidence, final HTML,
inputs, contracts, outputs, diagnostics and optional agent action events. Action
events travel on a separate bounded pipe; observer errors do not invalidate a
successful task. The worker callback is checked against installed Browser Use
source and protocol fixtures; a live agent-history capture has not been rerun.
Screenshots, per-step DOM snapshots and external client JavaScript bundles are
still missing. Size limits, unsupported payloads and incomplete captures remain
explicit limitations. Historical unsaved traffic cannot be recovered.

Generated JavaScript executes inside QuickJS/WASM in a terminable worker, not
Node's main realm. It has no Node environment, filesystem or unrestricted fetch.
The host owns request capabilities and validates their parameters. CPU deadline,
memory, steps, request counts and output schemas are bounded. This is a local
experimental isolation boundary, not an audited hostile-code hosting service.
Static type/schema validity is not treated as proof of semantic correctness.

The TypeScript build and 293 regression tests passed after the evidence and form changes,
including private bundle integrity, generated-code denial/budget tests, worker
protocol isolation, cross-origin recorder separation and existing browser/session
fallback tests.

## Reproduction entry points

- `scripts/prove-js-compilation.ts`: Open Library rich output. Set
  `CLAPPING_HANDS_JS_REQUEST_ID` to regenerate from a saved compiler request, or
  `CLAPPING_HANDS_JS_PROPOSAL_ID` to execute saved source without the model.
- `scripts/prove-js-public.ts`: Yahoo, GOV.UK, IKEA initial HTML, Bunnings and RBA.
  `CLAPPING_HANDS_JS_SITES` selects sites. Saved request/proposal IDs are scoped to
  each site's evidence subdirectory; `CLAPPING_HANDS_JS_CAPTURE_IDS` can reuse two
  training captures. No hand edits to generated source are needed.
- `scripts/capture-js-ikea.ts`: deterministic known-URL response capture.
- `scripts/prove-js-ikea.ts`: saved IKEA JSON compilation and a plain-browser
  held-out oracle. This is separate from the initial HTML attempt.
- `scripts/capture-js-remaining.ts`: passive captures for the remaining sites;
  visiting a page is explicitly not reported as task completion.
- `scripts/prove-js-marketplace.ts`: saved rich HTML compilation with explicit
  `request-context`, `browser-native` or `browser-document` transport cohorts.
- `scripts/prove-js-transport.ts`: model-authored station lookup plus trip calls.
- `scripts/prove-js-tender.ts`: supplemental form-backed rich output and browser
  comparison. `scripts/capture-js-tender.ts` records the actual submitter behavior.
- `scripts/summarize-js-proof.ts`: checksum-verifies private evidence and emits a
  public counts/timings/source-hash report without private page or output data.

These scripts currently reference this experiment's saved reports/capture IDs;
they are not a clean-install user experience. The compiler is not yet wired into
task promotion, MCP dispatch or automatic fallback. This completes a bounded
compilation experiment, not production integration or a general-site guarantee.
