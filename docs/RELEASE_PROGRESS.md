# Release completion — current work, 2026-09-08

The release goal remains open. Older prototype signoffs do not apply to this
JavaScript integration. See ADR 0010 for its current scope and limitations.

Python dependency security/reproducibility now has direct evidence: pip-audit
2.10.1 checked all 107 installed packages against PyPI advisories with zero known
vulnerabilities and zero skipped packages. A universal version/hash lock was
generated, and both installation instructions and `setup:browser` now require
hash verification. A fresh Python 3.12.7 environment installed all 107 audited
versions exactly; compatibility and Browser Use imports passed. See
[locked-install evidence](../bench/runs/2026-09-08/python-locked-install.json) and
[audit](../bench/runs/2026-09-08/python-vulnerability-audit.json). Additional
platform branches in the universal lock were not installed or audited. No
production runs or model calls were made. Clean TypeScript build passes; the
runtime regression result remains 266/266 from the preceding source change.
Final packaged acceptance must use the new lock/environment; older archives do
not include it.

An offline audit now inventories 186 integrity-checked historical JavaScript
experiment bundles across the ten sites. It separates missing HTML recorder
identity, omitted/form request bodies, separate API scope, request-admission gaps,
and non-success captures instead of calling all of them compiler/model failures.
See [findings and reproducible command](SAVED_EVIDENCE_AUDIT.md). No production
browser or model runs were repeated. The audit found an evidence-loss bug:
empty bodies were encoded as omitted. Future captures preserve the empty string,
while opaque bodies and authentication endpoints remain suppressed. Old evidence
is untouched and no omitted body is guessed empty. Clean build and **266/266**
tests pass, including persisted empty-body regression coverage. This is not
production compilation signoff; the legacy importer and live validation remain
open. The accepted archive below predates this change.

MCP recovery now reports fixed, product-owned categories for missing/invalid
model configuration, busy/recovery-required profiles, uncertain browser shutdown,
unknown/duplicate tasks and closed/busy runtime. Guidance never echoes raw error
messages, causes, caller inputs or provider payloads, and never recommends a
retry loop or deleting profile locks. A real built-MCP test confirms invalid and
unknown actions return structured recovery instructions. Unknown failures remain
generic, and website access outcomes remain separate. Archive onboarding now
distinguishes source-checkout setup from installed-package setup.
Clean build and **265/265** regression tests pass after this change. The prior
accepted archive below predates these runtime changes and is not signoff for them;
the final frozen package still needs verification.

The previously installed archive passes controlled end-to-end MCP acceptance:
real Browser Use demonstrations → real model compilation → two exact unseen
comparisons → restart with model/agent unavailable → one fresh network request.
The restarted call took 513 ms end-to-end with zero model calls. Two matched
fixture comparisons measured 18.96 s → 532 ms (35.6×) and 19.88 s → 527 ms
(37.7×). Learning took 58.37 s; validation costs are additional. These are not
production-site speedups. See [artifact-specific evidence](../bench/runs/2026-09-08/current-package-acceptance.json).
Archive SHA256 `63569bfab9c1bafa07cc6a5ae1697510405902f124f11defdb11df950aa4a8c0`
has 94 shipped files, all byte-identical to the installed copy when checked.
No retired controller, private evidence, Python bytecode or credential-pattern
matches were found in the archive. Node production audit reports zero known
vulnerabilities; all 107 Python dependencies are compatible (not a Python
vulnerability audit). The archive is retained privately under
`.data/release-candidates/clapping-hands-63569bfab9c1bafa.tgz`.
Human authentication, production generalization and final release claims remain
open. Later changes are reported above and do not inherit this artifact's signoff.
Nothing was published or installed
into the user's desktop MCP runtime.

Dependent scalar requests now work through the integrated compiler. A real-model
controlled smoke generated an unedited search → fresh returned ID → details
program. Three unseen inputs matched, including Chrome/task-store restart; each
used two fresh requests and no replay model calls. All ten training/validation
responses, prepared inputs, generated code and comparison evidence are retained.
The final execution took 138 ms excluding browser startup, not a production
speedup claim. See [proof](../bench/runs/2026-09-08/dependent-request-compiler.json).
The model receives resource-specific argument examples rather than being forced
to pass the caller's entire input object to every endpoint. Four resources/calls,
fixed request structure, scalar arguments and all existing scope checks remain.
Production generalization and more complex request translation are still open.
Clean build and **263/263** tests pass. A full-suite run exposed Chrome taking
longer than two seconds to exit under load; its bounded exit grace is now eight
seconds, with profile ownership still retained if shutdown cannot be proven.

Authentication handoff now registers close/cancellation before navigation and
disposes all wait listeners and timers. This fixes shutdown during page loading
being missed and potentially waiting for the five-minute handoff deadline. Three
controlled tests cover all exit paths, interrupted stalled navigation, and a
real isolated Chrome login/cookie surviving restart followed by a 401 after
fixture expiry. Only the headless flag and synthetic credential entry are test
substitutions; no model or external site is used. The returned reason is explicit
but login success remains `not-asserted`. A stale shutdown error referring to the
removed `clapping_hands_close_browsers` tool was also corrected. Human login/MFA
and exact packaged onboarding still need signoff.
Clean build and all **261/261** regression tests pass after the handoff fix.

Saved IKEA evidence now passes integrated request admission without repeating any
browser demonstration. Inspection found its structured JSON request is labelled
`text/plain;charset=UTF-8`; the decoder now accepts strict JSON objects/arrays
under this observed media type, preserves that header, and rejects non-JSON text,
scripts and media-type drift. The normal preparation path discovers one resource
from the two retained JSON captures. Prepared bundle
`1788822167387-e5087f63-bdd4-4062-bd29-75e9da48adf1` is retained under
`.data/integrated-production/ikea-1788822167231/evidence/`.
This proves offline admission only, not model compilation or live correctness.
The live command was rejected by execution approval pending explicit destination
authorization; no live IKEA or model request was made by that command. The user
has been asked to approve the three public searches and independent browser
comparisons. `scripts/verify-integrated-ikea.ts --prepare-only` is offline; the
normal mode additionally performs the paid compiler and live read verification.
Clean build and all **258/258** regression tests pass with the media-type fix.

Explicit cross-origin JSON admission is integrated into normal learning via the
optional MCP `allowedNetworkOrigins` field. Session capture accepts only these
additional origins; task storage, compilation and replay enforce the same saved
scope. Controlled real-Chrome tests observe two API responses, compile with a
substituted model boundary, compare two unseen inputs, promote, restart Chrome
and the task store, and fetch another exact result. The test also rejects missing
or removed permission, keeps a site cookie off the API origin, and blocks browser
navigation to that API. No production Browser Use demonstrations were repeated.
Cross-origin HTML, runtime tokens, arbitrary model-authored request translation
and broader dependent workflows remain open; the scalar case is now supported
above. This is not an IKEA or other
production-site signoff.
Clean build/typecheck and all **257/257** regression tests pass with this change.

Browser model usage now reaches MCP results and private evidence. A real-model
controlled built-MCP smoke learned, called and restored a generated tool; its
call reported 1 HTTP model attempt, 9,281 prompt and 132 completion tokens, with
complete reported coverage. Learning separately used 9,283 prompt / 129 completion
tokens (6,912 cached prompt tokens). Dollar cost remains unknown; these are
browser-only counters, not compiler costs. See
[usage evidence](../bench/runs/2026-09-08/browser-model-usage.json).
The live test caught and fixed a strict-MCP schema mismatch: returned evidence
references were missing from the advertised output schema. A built-server schema
regression now validates a complete result, including evidence and usage. Failed
smoke evidence is retained. Python packaging now excludes bytecode/cache folders.
Clean build and all **255/255** regression tests pass after this fix.
This is not final packaged signoff; the earlier archive predates these changes.

Path-input discovery is now integrated into normal JavaScript resource admission:
two observed `/quote/AAPL/detail` and `/quote/MSFT/detail` requests can learn the
varying whole path segment. Controlled tests exercise actual fresh HTTP replay,
two exact held-out results, promotion, serialization/restoration, and another
fresh result, with traversal/delimiter inputs rejected before dispatch. The model
boundary is substituted in this test; this is not a new production-site signoff.
The first route segment stays fixed; only body-less GETs are supported, without
pagination/runtime context. Path inputs must be nonempty scalars without path,
query, fragment, percent, whitespace or control delimiters; Unicode and encoded
ticker symbols are supported. Clean build/typecheck and all **252/252** regression
tests pass, including the new real-HTTP path tests. Cross-origin JSON admission
was subsequently integrated above; scalar dependent requests were integrated
later as described at the top of this document.
The previously verified package predates this source change and must be
rebuilt and reverified before release.

Fresh Python installation is now verified on macOS arm64 / Python 3.12.7:
Browser Use 0.13.10 and 106 dependencies installed into an empty virtual
environment with a fresh cache, all passed `uv pip check`, and the same installed
Node artifact below passed the complete controlled MCP smoke with that Python.
Two held-out comparisons passed; restart with model/agent unavailable returned a
fresh network result in 517 ms end to end. Same-input browser/network calls were
19.66 s / 0.56 s and 20.78 s / 0.57 s (35.4× and 36.7×), exact in both cases.
Learning took 52.43 s and validation another 39.37 s. These are controlled samples,
not production ratios. Existing host Chrome was reused; human authentication,
other operating systems, Python dependency security auditing, and model costs
remain unverified. No existing Python environment or login profile was modified.
See [fresh-install acceptance](../bench/runs/2026-09-08/fresh-python-mcp-acceptance.json)
and its companion resolved Python dependency manifest. No production Browser Use
demonstration was repeated.

Packaged MCP acceptance now passes on artifact
`sha256:b12642d0db7742d0a7f93de127468a87511750be8fcf876d727595911336ffe8`:
fresh production-only Node installation, real Browser Use demonstrations, real
JavaScript compilation, two exact unseen comparisons, new MCP process, and a
fresh network call with model configuration and the browser-agent executable
made unavailable. One request, no fixture document navigation, zero model calls;
588 ms end to end. Existing Browser Use 0.13.10 Python environment was reused.

Two same-input controlled comparisons returned exact results: 23.58 s → 1.45 s
(16.3×) and 20.70 s → 0.54 s (38.5×), including startup and cleanup. Initial
learning was 54.24 s; the two validation calls cost another 25.66 s and 20.13 s.
These are two local samples, not isolated statistical benchmarks or production
site ratios. Baseline model-call counts and dollar costs remain unmeasured.
Source regression suite: **250/250**. Installed dependency audit: zero reported
vulnerabilities. All 85 shipped files matched source at verification time.
The archive is retained in `.data/release-candidates/`; full private evidence and
public counts are recorded in `bench/runs/2026-09-08/packaged-mcp-acceptance.json`.
This is not final release signoff, human-auth verification, or Python clean-install
verification. Subsequent source changes require a new artifact audit.

Latest HTML integration: **249/249 tests pass**, clean build passes, and a real
configured-model smoke generated an unedited parser for a Chrome-recorded search
document. It returned the exact nested book/author/URL result on one unseen input
using one fresh network request, zero runtime model calls, in 176.64 ms excluding
session startup. This is a controlled fixture, not a production speedup ratio or
release signoff. The private prepared inputs and generated program are retained;
no Browser Use demonstration was repeated. Public counts and source hash are in
`bench/runs/2026-09-08/html-document-compiler-smoke.json`.

Latest verification after saved-evidence recompilation: clean build and
**247/247 regression tests pass**. This includes a built stdio-MCP client check,
offline recompilation with a substituted model boundary, staged replacement
success/failure, and retaining evidence when initial compilation fails. It is not
yet a live-model packaged onboarding signoff.

Cleanup verification: clean TypeScript build passes; the remaining regression
suite passes **240/240**, including local Chrome fixtures. Tests dedicated solely
to the removed DSL and Marketplace parser were retired with those modules;
the lower test count is not a claim of equivalent coverage. New generated-program
and runtime tests cover promotion, wrong-price rejection, restart, cancellation
and fallback. No production Browser Use demonstration was repeated for cleanup.

- Implemented: generated-program integrity/binding, distinct held-out promotion,
  irreversible degradation for a failed generation, cancellation, runtime routing,
  persisted restart and one bounded Browser Use fallback.
- Implemented: removal of superseded projection learning and Marketplace-specific
  source; clean build prevents retired modules shipping from stale output.
- Still required: generalized observed-resource discovery and admission sufficient
  to carry the successful saved-evidence experiments into normal tool learning.
  Ordinary HTML responses now enter the model compiler without a static output
  recipe. Existing request binding, exact-origin, encoding, size and promotion
  checks remain. Whole-segment GET path inputs are now integrated as described
  above. Explicitly authorized cross-origin JSON resources are now integrated;
  scalar dependent query/body requests are also integrated. Broader request
  transformations and production validation still remain.
- Implemented: MCP recompilation from prepared evidence retained before inference,
  pending replacement validation, preservation on compiler failure, conditional
  storage updates and bounded integrity-checked evidence reads. Controlled tests
  prove offline restart and built-MCP exposure without a browser or model key.
  Older raw captures/standalone experiment imports and broader diagnostics remain.
- Still required: matching-input baseline/compiled latency, cost and correctness
  comparisons, including session startup and learning cost, with reproducible data.
  Controlled packaged comparisons above now establish the execution path and
  wall-clock measurements; production comparisons and cost telemetry remain.
- Still required: exact packaged MCP install → authenticate → learn → held-out
  promotion → restart → fresh call, plus auth expiry and interrupted-run checks.
- Still required: shipped-byte secret/dependency review, current README/onboarding
  claims, and final artifact verification. No publication is implied or performed.

Retired source and tests were copied into the ignored local directory
`.data/retired-compiler-20260908/` before removal. Historical benchmark reports and
private experiment bundles are preserved. They are not current-release signoffs.
