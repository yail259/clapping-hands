# Rich-workflow release validation — 7 September 2026

## Outcome

Three richer read workflows have independently checked outputs. Transport NSW
completed every requested agent run but is only partially verified: its answers
were repeatable, not independently validated end-to-end. None of these four
workflows earned a compiled accelerator. Do not merge this result with the earlier
six accelerated **single-value** workflows or claim general structured compilation.

| Workflow | Agent outcomes | Independent accuracy | Restart-repeat latency, seconds | Acceleration |
| --- | --- | --- | --- | --- |
| Open Library: five books, authors, year and URL | 2/2 learning + 5/5 calls completed | All five outputs match three independently obtained query references; later fresh checks became unavailable | 91.34 / 120.27 / 137.75; median 120.27 | None |
| Find a Tender: five notices, buyers, deadlines and URLs | 2/2 learning + 5/5 calls completed | 5/5 exact live-browser comparisons | 111.22 / 112.12 / 138.88; median 112.12 | None |
| Marketplace: five listings, **current asking price**, canonical URL | 2/2 learning + 5/5 calls completed, after a labelled contract clarification | 5/5 exact against three fresh search references; repeated inputs share one reference | 75.32 / 75.97 / 85.85; median 75.97 | None |
| Transport NSW: origin, destination, departure time, expanded journey legs | 2/2 learning + 5/5 calls completed | No completed independent end-to-end oracle; three repeats returned the same 9-minute Redfern–Wynyard journey and platforms | 117.03 / 129.48 / 139.38; median 129.48 | None |

Timings are complete calls including session setup/cleanup, three samples of the
same input with a new runtime each time, sorted above. These are small-sample
measurements under concurrent benchmark load, not latency distributions or speedup
ratios. Every measured call used Browser Use and the existing Astra endpoint.
Browser model-call counts remain unavailable (`null`), not zero. No task result
data was served from a cache.

## Fixed protocol and cohorts

The first cohort used two learning examples, two distinct held-out inputs, and
three further calls on one repeated input. The second held-out call and every
repeat started a new runtime/browser. The saved task/profile was retained.
Each task was capped at 300 seconds and Browser Use's existing 20-step limit.
All activity was read-only; no messages, bids, purchases, saved listings or account
record changes were requested. The user manually authenticated Marketplace.

This is not four additional sites: Open Library, Marketplace and Transport were
deeper workflows on previously tested sites; Find a Tender was the new site.
These are engineering controls, not evidence that the sites lack official APIs.
Open Library explicitly has a public API; Find a Tender also exposes a Data and
API link. No per-site adapter was added to the product runtime. Independent
checkers are deliberately hand-authored benchmark code and must not be counted
as automatically learned plans.

### Marketplace: genuine ambiguity, followed by a checker bug

The original goal requested "price text." On the same discounted listing, one
repeat returned `AU$149` and two returned `AU$149 AU$349`. That is not a strict
repeatability pass. Its results remain in the original cohort.

A separate follow-up specified **current asking price only**, excluding crossed-out
prices, and canonical URLs without tracking parameters. Its schema required exactly
five items. It passed two learning runs, both held-outs and all three repeats.

The first independent checker then misread a `Just listed` badge as the title for
three cards. The returned listing IDs and prices matched. The checker was corrected
to use the observed card layout's title immediately before its location; its failed
report is retained. The corrected oracle matched all five complete outputs. This
checker correction is not a runtime/compiler improvement. Search ordering and
listing availability can change, so future mismatches still require investigation.

The new dedicated profile survived all benchmark restarts. The original profile
was untouched. The initial benchmark attempt while the login window still owned
the profile failed safely; it was retried after that window released the profile.
The fresh benchmark profile is not silently substituted into existing MCP config.

### Open Library oracle availability

The independently retrieved `dune`, `moby dick` and `sherlock holmes` references
matched exactly. Later duplicate fresh oracle attempts were unavailable; a follow-up
also failed to retrieve them. All five recorded outputs nevertheless match those
three previously retrieved references exactly, including all repeated Sherlock
Holmes outputs. This is five comparisons to three references, not five successful
fresh fetches. Both the unavailable-check report and reference comparison are kept.

### Transport verification limit

The agent completed station selection, departure-time changes and journey expansion
in every run. The benchmark's independent checker reached a manually selected
Redfern–Wynyard journey, but did not complete setting 20:00 and independently
extracting the expanded legs. Initial controls appeared before client startup;
later departure-picker attempts timed out. These checker failures do not establish
a Browser Use failure, nor does agent completion establish full correctness.

Both learning examples retained Central as origin while changing destination and
time. Consequently this cohort does not establish origin-input compilation even
if useful response evidence were admitted: the current network learner requires
each compiled input to vary. The held-outs did change origin. Future compilation
experiments should vary all input fields in their learning examples.

## What prevents acceleration

1. **Structured browser replay is missing.** The alpha.3 URL/text accelerator only
   supports one string output. Arrays, nested author lists and journey legs do not
   enter that backend. Browser success is preserved; compilation is optional.
2. **Open Library found a network candidate but could not project it.** Model-assisted
   projection reported `caller-contract-unsafe-evidence`. The current model-evidence
   policy strips URL query strings, so query-bearing book edition URLs cannot pass
   unchanged into that inference branch. This is a conservative implementation
   restriction, not evidence that a public book URL contains a credential. The
   current projection language also cannot freely construct arbitrary URLs or
   express every list-selection transformation. No guard was weakened for the test.
3. **Tender returned HTML outside the supported decoder.** Twelve captured responses
   were rejected by the initial response-evidence filter. The existing HTML route
   handles proven native input values, not general notice cards. No candidate reached
   projection. A public search form also uses POST/session state; an assumed URL
   query parameter was not a valid independent search.
4. **Marketplace needs live session-header context.** The clarified follow-up found
   two shared request groups, both rejected as `runtime-context-required`.
   Independently observed searches reproduced that category. Authentication works;
   this task runtime does not refresh/bind the session context required to replay
   those requests. Secret values were not written into a plan.
5. **Transport produced no eligible shared request candidate.** Its filters reported
   28 response-evidence and 16 input-binding rejections. Stop IDs, time encodings,
   multi-step state and structured outputs need additional supported evidence and
   validation; this result does not prove the workflow cannot be accelerated.

The acceleration opportunity is plausible, not measured. The next compiler sprint
should target one of these explicit missing capabilities with fixtures and held-out
proof, rather than collect more single-heading successes.

## Failure safety and code changes

- Added a real-browser runtime fixture proving a failed accelerator falls back once,
  returns fresh data, persists `degraded`, and is skipped after restart.
- Deliberately broke **a copy** of the previously validated Yahoo selector. Real
  Browser Use returned `Alphabet Inc. (GOOG)` successfully, then did so again after
  restart without retrying the degraded plan. The original Yahoo plan was untouched.
- None of the four rich workflows had a promoted plan to break. The live fallback
  test is a separate existing-plan control, not four per-site fallback successes.
- Replaced an unhelpful `other` diagnostic for session-header requirements with the
  count-only `runtime-context-required` category. Added a test that no header name
  or value leaks into that audit. No replay safety policy changed.
- Final full regression suite: **280 passed, zero failed**. TypeScript build passed.
- Added reproducible benchmark/oracle scripts and `npm run benchmark:rich`.
  This validation did not publish a release or change installed MCP configuration.

## Evidence

Files under `bench/runs/2026-09-07/`:

- `alpha-rich-1788758126922-{openlibrary,tender,transport}.json`: original public cohort.
- `alpha-rich-1788758126922-tender.oracle.json`: five exact independent checks.
- `alpha-rich-1788758126922-openlibrary.oracle.json`: three exact references and two unavailable fresh checks.
- `alpha-rich-1788758126922-openlibrary.oracle-1788759059040.json`: unavailable follow-up.
- `alpha-rich-1788758126922-openlibrary.reference-comparison.json`: all five outputs against the three obtained references.
- `alpha-rich-1788758176194-marketplace.json`: profile still owned by login window.
- `alpha-rich-1788758390389-marketplace.json`: original ambiguous-price cohort.
- `alpha-rich-1788759242905-marketplace.json`: clarified current-price cohort and precise compiler diagnosis.
- `alpha-rich-1788759242905-marketplace.oracle-1788759866571.json`: checker badge/title false negatives.
- `alpha-rich-1788759242905-marketplace.oracle-1788759950551.json`: corrected five exact comparisons.
- `alpha-live-fallback-1788758598530.json`: deliberately broken Yahoo plan and restart control.

Raw network bodies, cookies, session-header values and model-provider exceptions
are not persisted in these benchmark reports. Public returned result data is.

## Release interpretation

Publishable only as an honestly scoped experimental alpha: reusable typed browser
tools, with demonstrated acceleration for the earlier narrow workflows and safe
fallback for known replay failures. These new results do **not** support "compile
any website into APIs," reliable arbitrary structured compilation, or production
readiness. The next milestone is richer compilation, not another broad site count.
