# ADR 0007: Server HTML as an explicit network response source

Date: 2026-09-06

Status: Implemented with controlled and production learning/replay evidence.
Current installed-artifact verification remains open. Revised 2026-09-06 after a
differential test showed the earlier "original response bytes" premise was wrong.

## Decision

Keep the autonomous DOM baseline and caller-defined contract. Extend its optional
network accelerator with the `html-input-values` response codec and a persisted
`server-html-input-values-v1` recipe. The existing `json-request-v1` engine name
is a compatibility identifier; the explicit response codec determines decoding.
Do not migrate autonomous workflows onto the older guided form engine.

During schema-first browser learning, opt in to main-frame document responses.
Admission is bound to request start; unrelated subframes, redirect chains and
compiled replay requests do not become document learning evidence. Existing
origin and exact result-page provenance checks still apply.

### Two response representations, not one

A browser document response is **not** available as original wire bytes. Chromium
decodes the document with its own charset rules, and the client protocol
(`Network.getResponseBody`) returns that text, which Playwright re-encodes as
UTF-8. A differential test against real Chrome measured this directly: a 193-byte
Windows-1252 fixture came back as 198 UTF-8 bytes. Applying the transport charset
to that buffer decodes the document a second time and corrupts every non-ASCII
value. An all-ASCII document is unaffected, which is why this defect was latent
rather than visible in the first production attempt.

Learning therefore retains the browser's decoded **text** in process-private,
unforgeable storage, plus bounded content-type metadata. Fresh replay responses
are genuine transport bytes and keep their own independent decoding. Both
representations are read through one module, never interchanged, and neither
raw bytes nor response bodies are part of a persisted execution plan.

Encoding precedence for transport bytes is the bounded WHATWG subset: BOM, then
transport charset, then one early explicit meta declaration, with no guessed
default and no statistical detection. Supported labels are UTF-8 and Windows-1252
(including the HTML ISO-8859-1 aliases). A transport charset that disagrees with
a meta declaration is not a conflict; the higher-precedence declaration wins, as
it does in Chrome. Multiple meta declarations, unsupported labels and unsupported
BOMs are still refused.

The persisted recipe pins the encoding the *site itself declared* when the
workflow was learned, taken only from evidence that survives browser decoding:
the transport charset, else the document's own early meta declaration. A consumed
BOM is deliberately not reconstructed. Fresh replay decodes its own bytes
independently and refuses the compiled response when the two disagree, so a
charset change causes validated browser fallback rather than silent corruption.

The passive parser extracts only the learned, explicitly selected readonly or
disabled text/number input attributes. It does not execute scripts or fetch
resources. Selector syntax, input metadata, cardinality, byte sizes, AST nodes,
depth and output are bounded. Private/editable/explicitly hidden controls,
recognized login/checkpoint shells, ambiguous markup and unsupported sources
are refused. These controls do not establish a general hostile-page sandbox.

## Meaning and promotion

An HTML `value` attribute is not the browser's live `.value`. Scripts can change
one without changing the other. Therefore every demonstrated HTML source row
must exactly match its independently extracted browser row. A script-only or
stale attribute cannot become a candidate. The existing browser projection then
maps that corroborated source into the caller's typed contract without another
model guess. Storage requires the HTML network projection to equal the browser
projection; substituting a same-typed previous value for the requested current
value is invalid even when the JSON Schema would accept both.

JSON candidates under schema-first learning are no longer shortlisted by display
text overlap. They still require source-bound typed projection and meaning checks.
Legacy string-row learning retains its existing text-evidence filter.

Network promotion now requires two distinct held-out inputs, excluding training
inputs. Input hashes use sorted flat keys, so property ordering cannot manufacture
new evidence. Training and repeated successes remain in history but do not qualify.
The runtime verifies evidence instead of trusting a saved `stable` status label.
Unversioned legacy hashes cannot be safely migrated: their browser baseline stays
available, with explicit relearning guidance before network promotion. Zero-input
workflows cannot satisfy this particular held-out-input gate and remain browser
executed by the generic runtime.

## Bounded initial support

One same-origin, demonstrated read request with ordinary input binding; no HTML
pagination, cross-origin transport, runtime-token refresh or browser-fetch codec.
Captured learning evidence and fresh transport bytes each have exactly one decoder
entry point, shared by learning, context validation and replay respectively.
Compiled replay releases every transport response before the next page and on
every success, refusal or error; a failed release retains a buffer but never
replaces a validated result or the primary typed error. That bounds retention
after a response is read, not the initial body allocation.
Malformed/drifted responses use the existing validated browser fallback; recognized
authentication failures request handoff without silent retry or plan degradation.

Static parsing cannot establish computed CSS visibility, later JavaScript state,
or a general equivalence to frontend execution. Exact demonstrations and held-out
comparisons are evidence for the learned workflow, not proof for arbitrary sites
or future changes. Accepted-data bounds are not hard process-memory/CPU limits.

## Evidence and remaining work

The controlled native-form test runs the actual mocked learner tool loop, two
demonstrations, two distinct held-out browser/network comparisons, then five fresh
network calls across runtime restart. Independent Playwright client observations
record zero warm UI/navigation/evaluation/model attempts. Changing server output
for the same input proves that answers are not cached. A script-updated live
value with a stale serialized attribute correctly retains browser-only execution.

A real-Chrome differential test pins the decoder to the browser for transport/meta
conflicts, BOM overrides and bounded `:has()` selection. A separate real-Chrome
integration test serves one Windows-1252 document whose meta declaration disagrees
with its transport charset, then captures it through the recorder, compiles a
candidate and replays it over real transport bytes: the browser's live input
values, the captured text rows and the freshly decoded wire rows must all agree.
That test fails under the previous byte premise.

Production evidence now exists. A fresh autonomous schema-first run on the RBA
Calendar Year inflation calculator learned the workflow in 142.989 s / 34 reported
model calls, captured four document responses with zero decoding refusals,
accepted an HTML candidate with zero translation model calls, matched two distinct
held-out browser comparisons exactly, and then answered five warm calls — three
after restart — in 494–502 ms of engine time with one outer protocol call and zero
UI actions, navigations, evaluations, new pages or model attempts. Every call
equalled an independent normal-UI calculation.

These local fixtures and this single site are not general website coverage, and
the archival CPI comparison is explicitly not a financial-correctness oracle.
Fresh package installation, human authentication and release signoff remain
separate gates. The original Marketplace investigation cutoff and untouched-profile
boundary are unchanged.
