# Release completion audit — 2026-09-08

## Experimental-alpha release decision

The user accepted a finite experimental-alpha release bar on 2026-09-08:
feature freeze, one proven end-to-end production workflow, controlled failure
safety, and a final installable package with accurate documentation. Fresh human
authentication, another production site, full ten-site compilation and rigorous
matched production timing are explicitly deferred, not retroactively passed.
Final packaging verification passed for archive
`fbd917effea3512e9396ef15bc8cdcb171e9ed166daff59b8cb35f7f0b18c02c`:
clean Node 22.18 installation, 117 exact installed files, unchanged 90 runtime
files versus the Open Library candidate, MCP startup/status/error checks, no
broken documentation links, no credential-pattern matches and zero known Node
production advisories. This entry is external to that frozen archive. The
experimental alpha is ready for distribution; publication remains separate.
The broader v1 audit
below is retained as history and a roadmap, not an expanding alpha checklist.

## Earlier broader v1 verdict

Verdict: **not complete for the broader v1 scope**. This audit preserves the
original read-first scope and the later Browser Use/generated-JavaScript rewrite;
historical prototype signoffs do not transfer to the rewrite.

## Approved Open Library production validation

The packaged candidate with SHA-256
`8c5eb2edb9c1c26442fad604733795ec8bd144f549a296a4156f7bef628bf0e3`
now passes a real rich Open Library workflow through normal MCP learning, without
hand-authored compiler resources or program edits. Two demonstrations produced a
candidate; Dune and Moby Dick matched exactly on unseen inputs. After MCP restart
with model credentials and Browser Use unavailable, Sherlock Holmes completed
through the network engine in **6.56 seconds overall**, with zero model calls and
no fallback. One fresh independent browser DOM check matched that result exactly.
All four baseline outputs also matched independently parsed saved page snapshots.
The program is stable and all baseline/prepared/compiler evidence remains saved.

Learning took 207.42 seconds; held-out validation calls took 134.55 and 95.66
seconds. These are different queries and validation includes comparison work, so
they do not establish a matched-input speedup ratio. Chrome still starts for the
network session. This closes the single-workflow integrated production proof gap,
not ten-site generalization, authenticated onboarding, or the overall release.
The initial sandbox launch failed before any demonstration and is preserved.
See [packaged production result](../bench/runs/2026-09-08/openlibrary-packaged-acceptance.json).
README and candidate acceptance now distinguish this result from earlier fixture
and prototype evidence. A package dry-run includes both current acceptance reports
and resolves every relative documentation link. All 90 shipped runtime/Python
files are byte-identical to the accepted installation; only documentation/package
inclusion changed. This is not a new archive acceptance or publication.

Minimum-runtime verification found and fixed a real Node 22.18.0/ICU 77.1
encoding incompatibility. Three tests failed because its Windows-1252 decoder
returned control characters where Chrome returned euro/quotation characters.
The supported legacy encoding now uses the explicit browser-standard mapping;
one differential test also stopped deriving its expected text from that faulty
host decoder. Clean build and **273/273 tests pass on Node 22.18.0**, plus 20/20
affected tests on Node 25. Failed and passing outputs are retained. See
[compatibility evidence](../bench/runs/2026-09-08/node22-compatibility.json).
The frozen archive predates this fix and must not be presented as minimum-Node
signoff. Production re-recording remains awaiting the user's approval.

MCP import integration now exists for two saved successful Browser Use baseline
captures belonging to the exact current task. `clapping_hands_prepare_from_captures`
uses only IDs in the runtime's evidence directory; it cannot widen API scope or
take arbitrary file paths. It validates task identity, outcomes, distinct inputs
and bundle integrity, then prepares JSON resources without browser/network/model
calls. It preserves existing accelerators and conditionally saves the new evidence
reference. `recompile` remains a separate paid step followed by held-out validation.
Foreign/failed/duplicate/lossy captures have tested refusals and leave the prior
task intact. A real built-MCP test passes with unavailable model and browser
configuration. Clean build and **272/272** tests pass. Standalone historical
experiments lacking task identity and form/HTML reconstruction remain unsupported;
the production gate is still open. This runtime change postdates the frozen
archive and requires package verification when the remaining integration is ready.

Subsequent importer progress: the generic saved-JSON loader now checks bundle
integrity, restores structured JSON/frame semantics, strips credential headers,
and refuses omitted/form requests and HTML reconstruction. The IKEA offline
verifier uses it instead of bespoke decoding and prepares one resource from two
retained captures, without browser/model/network calls. Three targeted tests and
clean TypeScript build passed at that milestone. The MCP baseline importer above
was subsequently added; neither closes the production gate. See
[offline proof](../bench/runs/2026-09-08/saved-json-import.json). The new helper and
verifier change postdate the frozen archive; its existing runtime acceptance is
not a claim that the helper shipped there.

Frozen candidate: `9ba07dce36f0e25d432b4ba9fd040fe57e1b0a2d9b1004b28abda479a14191cd`.
This document and subsequent evidence are external to that archive. They do not
change its accepted bytes or imply a registry publish or desktop installation.

| Requirement | Evidence inspected | Status and remaining work |
| --- | --- | --- |
| Browser Use is the sole navigation agent; compilation optional | Current runtime, package dependencies, baseline/fallback tests and frozen MCP learning | Implemented and controlled-tested. No universal-site guarantee. |
| Typed goal → learn → generated tool → fresh calls → restart | Frozen real-model MCP acceptance, explicit schemas, two unseen comparisons and restart with model/agent unavailable | Passes the unauthenticated controlled workflow. Exact human-authenticated MCP onboarding remains open. |
| Persistent user authentication | Frozen package opened the previously authenticated Marketplace profile, passed auth checks, loaded a visible listing and closed cleanly | Real session reuse now proven once. Fresh manual-login/MFA handoff, expiry and complete authenticated generated-tool flow are not proven by this check. |
| Network acceleration on production workflows | Packaged Open Library learning, two exact held-out comparisons, model-free restart and fresh browser oracle | One rich production workflow passes. Matched production timing and wider coverage remain open; older ten-site experiments are separate evidence. |
| Independent production generalization without hand-authored runtime glue | Open Library packaged MCP result and independent restart oracle | Actual product path proven for one site without authored compiler resources. Preserve the named ten-site cohort; this is not universal or cohort-wide acceptance. |
| Retain evidence and recompile without demonstrations | Prepared-bundle persistence, offline MCP recompilation, 186-bundle historical audit | Current prepared bundles work. Older raw formats need a faithful importer; sanitized HTML must not be relabelled original browser bytes. Empty-body loss is fixed for future captures, not repaired historically. |
| Failure safety | 266-test suite, auth fixtures, wrong-value rejection, corrupt-plan rejection, bounded fallback, cancellation, installed error recovery | Controlled coverage passes. Unknown failures remain generic; operator recovery of uncertain ownership is not a no-manual-maintenance experience. |
| Installation and dependency/security evidence | Frozen clean Node install, shipped-byte/link scans, locked 107-package Python install and advisory audits | Passes on the tested macOS/Python 3.12 environment. Pattern/advisory checks are not a comprehensive security proof; other platforms are unverified. |
| Claims accurately match evidence | Reconciled README, dated candidate acceptance and Open Library report | Current production proof is prominent and historical results labelled. Final release signoff still depends on the remaining gates; no all-sites or matched production ratio claim. |

## Concrete next actions

1. Complete the faithful saved-evidence importer/request-translation work needed
   to move successful standalone experiments into normal compilation. Do not
   repeat Browser Use demonstrations as an automatic substitute for missing data.
2. Run the pending scoped IKEA validation only after its requested destination
   authorization arrives. Preserve the earlier failed/blocked reports. This is
   an explicit approval block, not a failed compiler experiment.
3. Verify the full authenticated MCP workflow and desktop onboarding with the user;
   the successful saved-profile check is one component, not full acceptance.
4. Reconcile final documentation against the exact accepted runtime/artifact.
   Publish/push/runtime replacement remain separate actions, not inferred here.

References: [frozen acceptance](RELEASE_CANDIDATE_ACCEPTANCE.md),
[real session reuse](../bench/runs/2026-09-08/frozen-marketplace-session.json),
[saved evidence audit](SAVED_EVIDENCE_AUDIT.md), and
[implementation progress](RELEASE_PROGRESS.md).
