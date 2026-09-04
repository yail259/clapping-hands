# Benchmark results

These are early smoke results, not proof that Clapping Hands works on “any
website.” The live runner demonstrated a workflow in a real browser, compiled
the observed same-origin HTML forms into direct requests, and compared the
normalized task result against both the browser result and an independent
workflow-specific oracle.

## Live public-site smoke — 2026-09-04

Compiler published as [`7a36d26`](https://github.com/yail259/clapping-hands/commit/7a36d26).
Environment: macOS in Sydney, Chrome 151.0.7922.138. Each timing below is one
paired observation (`n=1`), so it is useful for smoke testing only. It is not a
p50/p95 benchmark and does not support a general speed claim.

| App | Workflow | Effect | Intervention | Steps | Browser baseline | Compiled | Observed ratio | Browser → compiled navigations | Exact result | Verdict |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| GOV.UK | State Pension age | `read` | `guided` | 2 | 3,229 ms | 332 ms | 9.72× | 3 → 0 | yes | smoke pass after fix |
| GOV.UK | Check if you need a UK visa | `read` | `guided` | 3 | 599 ms | 156 ms | 3.85× | 4 → 0 | yes | smoke pass; revalidation due |
| GOV.UK | Calculate holiday entitlement | `read` | `guided` | 4 | 682 ms | 515 ms | 1.32× | 5 → 0 | yes | smoke pass; revalidation due |
| GOV.UK | State Pension age, initial run | `read` | `guided` | 2 | 5,358 ms | 294 ms | 18.21× | 3 → 0 | **no** | **failed and retained** |

All compiled observations made zero model calls. “0 navigations” does not mean
zero traffic: the compiled paths made 3, 4, and 5 fresh HTML requests
respectively. They skipped browser rendering and client-side enhancement. The
holiday observation did not meet the repository's 2× threshold even in this
single noisy pair and therefore cannot be described as faster.

The passing rows are all one domain and one architecture family. They show
that the new guided form compiler works on these production workflows; they do
not establish automatic discovery, authenticated application support, writes,
or cross-site generality. Visa and holiday passed before the later login-shell
and redirect hardening and are explicitly queued for a future rate-limited
revalidation window.

## Four fix-and-rerun cycles

| Cycle | Failure observed | Fix | Rerun evidence |
| ---: | --- | --- | --- |
| 1 | Pension passed its semantic oracle but failed exact comparison because JavaScript expanded unrelated contextual step navigation. The first regression test also exposed missing separators between adjacent block elements. | Scope comparison to the task result, remove contextual furniture, and canonicalize block boundaries. | Regression green; pension exact agreement changed from no to yes. |
| 2 | Form-encoded POST replay collapsed two checked values to the final value (`received 1`, expected 2). | Send the raw `application/x-www-form-urlencoded` body rather than converting it through an object. | Repeated-control POST fixture green. |
| 3 | An HTTP-200 “Sign in / session expired” page was accepted as a plausible final result. | Persist only hashes of demonstrated final headings and require a match at replay. | Login-shell fixture now fails closed. |
| 4 | A cross-origin redirect was rejected only after the unwanted destination had already been contacted. | Disable automatic redirects, validate every `Location`, bound redirect depth, and follow only same-origin redirects. | External fixture received zero requests and replay failed closed. |

That published checkpoint had 21 passing tests. Plans persist form structure,
public option values, paths, and input hashes; they do not persist submitted
answers, hidden field values, cookies, response bodies, or authorization
headers.

## General compiler development gate — 2026-09-04

This is controlled-fixture evidence, not another live-site benchmark and not a
cross-site speed claim. The current suite has 97 passing tests and the built MCP
server advertises ten management/Marketplace tools before any generated
workflow tools are loaded.

The reproducible controlled protocol at compiler commit
[`387ede5`](https://github.com/yail259/clapping-hands/commit/387ede5) ran 20
interleaved warm UI and compiled trials with exact output checks. Chrome
151.0.7922.138 on Apple Silicon produced the following local result:

| Workflow | Engine | n | UI p50 / p95 | Compiled p50 / p95 | Median ratio | Correctness | Requests; navigations |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Controlled JSON search | `json-request-v1` | 20 | 91.88 / 109.69 ms | 0.71 / 0.99 ms | 129.41× | 20/20 + 20/20 | UI 2; 1 → compiled 1; 0 |

This is an architectural ceiling on a loopback fixture: it mostly measures the
cost of a navigation, rendering, locator work, and an extra request that direct
replay avoids. It proves deterministic replay overhead and result equivalence;
it does **not** prove semantic discovery, internet latency, or a typical-site
speedup. The sanitized report is
[`bench/runs/2026-09-04/controlled-general-compiler.json`](../bench/runs/2026-09-04/controlled-general-compiler.json).

New regression coverage includes:

- generic form discovery among unrelated forms, document `<base>` handling,
  browser-default successful controls, and same-document SPA submissions;
- read-only JSON acceleration for GET and output-evidenced POST on the workflow
  origin or exact operator-allowed origins, redaction of auth and CSRF-shaped
  headers, and capture from every attached tab; mutation-shaped methods stay on
  the prepared effectful path;
- same-origin iframe action/output discovery, declared new-page transitions,
  open Shadow DOM, and zero-argument DOM and JSON workflows;
- nested input inference and replay for form-encoded GraphQL variables;
- bounded multi-page JSON replay inferred from repeated traces: opaque cursors,
  omitted-first query or nested-GraphQL cursors, numeric page/offset parameters,
  response-provided next URLs, boolean/next-value/short-page terminal signals,
  allowlisted total-pages response headers, repeated-cursor/URL rejection,
  exact endpoint/query-shape validation, and aggregate response-size limits;
- rejection of input-bound telemetry/config requests unless response values are
  also evidenced in the rendered task output;
- compilation of learned Stagehand actions into redacted selector/argument
  templates and zero-model Playwright replay;
- direct coverage of Stagehand v4's select, percentage/chunk scroll,
  double-click, and drag/drop action vocabulary, plus an unambiguous
  allowlisted-file selection bridge for the method its model cannot emit;
- a persistent per-origin browser profile whose cookie and local-storage state
  survives restart without an LLM configuration;
- two distinct-input shadows before network promotion (or two independent
  shadows for zero-argument tools), schema-drift degradation, and deterministic
  browser fallback;
- atomic workflow versioning and stale-evidence rejection; and
- prepared writes, one-time effect receipts, at-most-once commit, and an
  `uncertain` terminal state after any post-boundary ambiguity;
- browser-idle prepare plus finite action-caused mutation acknowledgement, so
  optimistic SPA output cannot report success while its write is still in
  flight; recurrent POST long polls are separated from finite mutations;
- allowlisted, size-bounded file selection with prepare-time content
  fingerprints, plus one-shot execution of the complete effect suffix; and
- same-origin downloads quarantined into unique directories with filename,
  non-empty/size, and SHA-256 evidence, while changed downloads fail closed;
- full persisted-plan safety validation for DOM, form, and network engines on
  save, load, update, and replay; and
- fail-closed output freshness: a cached DOM path cannot report unchanged,
  pre-action content as a successful fresh result; and
- input-evidenced write validation: when every demonstration echoes a submitted
  field in the result UI, an unseen commit must echo that field too.

The opt-in real-Stagehand local smoke found and fixed a v4 configuration bug:
Stagehand requires an explicit model configuration instead of inferring one
from `OPENAI_API_KEY`. Its rerun reached the provider but could not complete
because the configured account had no API credits. This is retained as a
blocked environment result; it is not counted as compiler success.

## Policy disposition

| Site | Decision | Reason |
| --- | --- | --- |
| GOV.UK | low-volume read smoke run | [Reuse guidance](https://www.gov.uk/help/reuse-govuk-content) permits scraping subject to [robots.txt](https://www.gov.uk/robots.txt); the tested paths were allowed. |
| Get Information about Schools | eligible next live domain | Its [acceptable-use policy](https://www.get-information-schools.service.gov.uk/AcceptableUsePolicy) expressly permits transient, low-volume automation resembling normal browsing and directs bulk users to downloads. |
| Yahoo | not run | [Yahoo's terms](https://legal.yahoo.com/xw/en/yahoo/terms/otos/index.html) prohibit automated access or collection without prior express permission. A benchmark label would not override that restriction. |

Exploratory discovery plus scripted journeys totaled 13 on `www.gov.uk`, three
above the new 10-journey daily-domain cap. That was an accounting mistake, not
an authorization argument. Live testing stopped once reconciled; subsequent
cycles used local controlled fixtures. Future runs must count manual discovery
against the same budget before the runner starts.

The complete sanitized observation log is
[`bench/runs/2026-09-04/govuk-live-smoke.json`](../bench/runs/2026-09-04/govuk-live-smoke.json).
The benchmark protocol and release gates are in
[`docs/BENCHMARK_PLAN.md`](BENCHMARK_PLAN.md).

## Purpose-built live-site capability smoke — 2026-09-04

Compiler checkpoint [`8073759`](https://github.com/yail259/clapping-hands/commit/8073759)
was exercised against [The Internet](https://the-internet.herokuapp.com/),
whose [official repository](https://github.com/saucelabs/the-internet) describes
it as an application for automated acceptance tests. This was a bounded
capability smoke: two guided demonstrations and one compiled run per task, not
a latency benchmark.

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Delayed element removal | asynchronous DOM replacement | read | 0 | yes | pass |
| JavaScript confirm | typed dialog + one-time receipt | prepare/commit | 0 | yes | pass |
| Download `test_file.txt` | same-origin quarantined artifact | read | 0 | yes; 40 bytes + SHA-256 | pass |

The first delayed-element attempt failed closed because the guided benchmark
adapter returned before the AJAX output existed. The adapter was changed to
wait for the declared result region; the rerun then passed. The successful run
used ten page journeys and made no upload to the demo's shared file list; the
failed development attempt used one additional journey. The sanitized report
is [`bench/runs/2026-09-04/the-internet-live-smoke.json`](../bench/runs/2026-09-04/the-internet-live-smoke.json).

This adds a second public domain and three browser mechanisms to the evidence,
but still does not satisfy the frozen-corpus or unseen-holdout gates. In
particular, it supports no “80–90% of websites” claim and no speed ratio.

## Authenticated SPA capability smoke — 2026-09-04

Compiler checkpoint [`2dce968`](https://github.com/yail259/clapping-hands/commit/2dce968)
was exercised against SauceDemo / Swag Labs. [Sauce Labs' own Selenium
documentation](https://docs.saucelabs.com/web-apps/automated-testing/selenium/)
uses this app for its automated login example. The harness read the public
fixture credentials from the login page at runtime and did not persist or
report them.

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Login profile restart | authenticated SPA state | fixture auth handoff | 0 | inventory survived clean restart | pass |
| Inventory sort | client-only select state | read DOM | 0 | independently checked A→Z ordering | pass |
| Add cart item | reversible local cart mutation | prepare/commit | 0 | cart empty at prepare; one item at commit | pass |

The first A→Z replay failed closed because A→Z was already selected after the
fresh navigation, so there was correctly no DOM delta. The runtime now accepts
only a narrow idempotency proof for select/check/uncheck controls whose current
state already equals the requested state; arbitrary clicks still require fresh
output. The successful run used nine page journeys, created no orders, and
removed its test cart item. The failed development attempt used five additional
journeys. The sanitized report is
[`bench/runs/2026-09-04/saucedemo-live-smoke.json`](../bench/runs/2026-09-04/saucedemo-live-smoke.json).

This is the third public domain and the first externally hosted authenticated
SPA in the evidence. It remains guided, `n=1` per task, and outside the unseen
holdout denominator; it supports capability claims, not a speed or 80–90%
generality claim.

## WordPress Playground holdout and regression — 2026-09-04

The 32-task corpus was frozen at compiler checkpoint
[`054bf03`](https://github.com/yail259/clapping-hands/commit/054bf03) before
opening WordPress Playground. The first guided post-search replay failed closed:
the compiled selector was checked before Playground's asynchronous WASM-backed
iframe had mounted. The runtime now waits for a selector to become uniquely
available through its declared same-origin frame path; a controlled regression
and the full regression suite pass.

The corrected workflow then passed on checkpoint
[`9009037`](https://github.com/yail259/clapping-hands/commit/9009037):

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Search posts | asynchronously mounted same-origin iframe | read DOM | 0 | independently checked no-match result | pass after fix |

Three subsequent development attempts also failed closed while the harness was
made honest about WordPress's initial result and inner-frame navigation. Those
were benchmark-driver corrections, not compiler changes. The sanitized report
records all 18 top-level journeys and is
[`bench/runs/2026-09-04/wordpress-playground-holdout.json`](../bench/runs/2026-09-04/wordpress-playground-holdout.json).
Because the holdout caused a compiler fix, this pass is regression evidence and
is excluded from the untouched-holdout success denominator. It is not a speed
result. WordPress Playground also has first-party JavaScript and Blueprint APIs,
so the row tests UI architecture rather than claiming UI compilation is the
preferred integration for WordPress.

## Self-hosted osTicket development holdout — 2026-09-04

The isolated osTicket row used a loopback-only application and database with
synthetic requesters, tickets, and notes. The official osTicket ticket API is a
useful partial-API case: it supports ticket creation but does not expose the
staff-side note/update workflow chosen here. Local fixture credentials were
read from the environment and were not persisted in plans or results.

After several failed-closed development attempts, compiler checkpoint
[`e0e2f0e`](https://github.com/yail259/clapping-hands/commit/e0e2f0e)
passed all three workflows:

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Search tickets | authenticated persistent GET form | two direct HTML requests | 0 | exact unseen fixture only | pass after fixes |
| Create ticket | public dynamic form + rich editor | prepare/commit | 0 | prepare had no effect; one ticket created | pass after fixes |
| Add internal note | authenticated rich editor at input-bound ticket URL | prepare/commit | 0 | prepare had no effect; one note created | pass after fixes |

The holdout found general defects rather than receiving site-specific selector
patches: covered submit buttons now use native `requestSubmit()`, demonstrations
wait through asynchronous page initialization, a no-op type action is recovered
atomically and checked, blur waits for the closest rich-editor source, public
and staff identities use separate persistent profiles, and same-origin start
paths can bind safely URL-encoded tool inputs. The runner also stopped assuming
that old fixture rows remain on the first dashboard page.

The sanitized report is
[`bench/runs/2026-09-04/osticket-local-holdout.json`](../bench/runs/2026-09-04/osticket-local-holdout.json).
It retains the failed-stage history and the one Docker Desktop interruption.
Because the holdout directly drove compiler changes, the 3/3 corrected run is
regression evidence and is excluded from the untouched-holdout denominator. It
is one compiled run per task and is not a latency distribution.

### osTicket warm performance distribution

The same pinned container images were then used for a 20-pair interleaved
performance run, after three warmups. Even samples ran browser first and odd
samples ran compiled first. Both paths made two fresh HTTP requests; the
compiled path skipped browser navigation/rendering and validated the returned
HTML directly.

| Workflow | Engine | n | Browser p50 / p95 | Compiled p50 / p95 | Median speedup | Correctness | Requests; navigations |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Authenticated ticket search | `html-form-v2` | 20 pairs | 626.06 / 643.56 ms | 42.74 / 61.09 ms | **14.65×** | UI 20/20 + compiled 20/20 | UI 2; 2 → compiled 2; 0 |

The query order cycled through three seeded synthetic tickets, and an
independent oracle required only the requested subject to appear. The runner
temporarily rotated the disposable loopback staff credential in memory and
restored its original hash after completion. Compile time was 1,285.26 ms and
is excluded from warm replay timings.

This is the first qualifying distribution on a real application, but it is
still only one version-pinned self-hosted app and one read workflow. It supports
the row above, not “websites are 16× faster.” The report retains every timing
sample in
[`bench/runs/2026-09-04/osticket-local-performance.json`](../bench/runs/2026-09-04/osticket-local-performance.json).

## Self-hosted WordPress warm performance — 2026-09-04

Compiler checkpoint
[`a5d3889`](https://github.com/yail259/clapping-hands/commit/a5d3889)
was exercised against a loopback-only WordPress 7.1 fixture with three
synthetic posts. The application, database, and setup CLI images are recorded
by digest in the report. The runner temporarily rotated the disposable admin
password in memory; no credential, cookie, response body, or submitted search
term was persisted in the plan or report.

The workflow used WordPress's authenticated Posts search form. Demonstrations
searched for `Printer` and `VPN`; timed replay cycled those inputs plus the
unseen `Invoice` input. An independent oracle required the exact expected post
title and rejected unrelated titles.

| Workflow | Engine | n | Browser p50 / p95 | Compiled p50 / p95 | Median speedup | Correctness | Requests; navigations |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Authenticated post search | `html-form-v2` | 20 pairs | 860.74 / 971.67 ms | 122.08 / 144.44 ms | **7.05×** | UI 20/20 + compiled 20/20 | UI 2; 2 → compiled 2; 0 |

Three warmups preceded 20 interleaved pairs; even samples ran browser first and
odd samples ran compiled first. Compile time was 1,739.4 ms and is excluded
from warm replay timings. The compiled plan retained the search field and
browser defaults, but no dynamic result-row checkbox names or post IDs.

The first compiler attempt exposed two general form defects. A read-only POST
button in the Screen Options panel had been classified as effectful from its
method alone, while dynamic `post[]` result checkboxes were being mistaken for
reusable inputs. Read semantics now require an explicit conservative submitter
allowlist, and form signatures/projected steps exclude unanswered result-row
controls. Repeated result-page URLs with a query string are also recognized as
terminal results when an empty form action resolves back to that URL. The full
90-test suite covers these cases.

This supports only the pinned WordPress version and post-search workflow above;
it is not a claim that all WordPress tasks—or websites generally—are 7× faster.
The report retains all samples, image digests, environment metadata, and the
exact code revision in
[`bench/runs/2026-09-04/wordpress-local-performance.json`](../bench/runs/2026-09-04/wordpress-local-performance.json).

### WordPress Redirection plugin capability regression

The same isolated WordPress 7.1 fixture was extended with the official
[Redirection plugin](https://wordpress.org/plugins/redirection/) pinned at
5.10.0. This adds a materially different architecture from core post search:
the plugin owns a React admin screen and communicates through WordPress's
same-origin REST API. The tested task was an actual plugin write, not a core
WordPress form.

Compiler checkpoint
[`6a05aec`](https://github.com/yail259/clapping-hands/commit/6a05aec)
used two isolated synthetic source/target demonstrations, removed each one,
restarted the persistent browser, and committed a never-demonstrated third
redirect:

| Workflow | Mechanism | Effect path | Compiled model calls | Independent result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Create unseen 301 redirect | plugin React SPA over same-origin REST | browser-idle prepare, then one-shot commit | 0 | one exact database row plus public HTTP 301 to the requested target | pass after compiler fix |

Prepare changed neither the page nor the database. Commit created exactly one
enabled 301 in the intended group, the compiled result contained both unseen
inputs, and an unauthenticated public request returned the intended location.
Reusing the receipt was rejected before another site action and left the same
row ID in place. All alpha, beta, and gamma rules were then removed and verified
absent.

The run exposed a general false-success gap. Write plans previously ignored
input evidence even when every demonstration proved that the resulting screen
echoed each submitted value. The compiler now retains that demonstrated
contract for reads and writes; non-echoing write screens continue to use
plausibility/change validation. Three older test demonstrations were also
corrected because they had claimed to echo payloads their fixture never
rendered.

This is one guided capability observation on one pinned plugin version. Its
single replay duration is deliberately not promoted as a speed result. The
sanitized report is
[`bench/runs/2026-09-04/wordpress-redirection-local-capability.json`](../bench/runs/2026-09-04/wordpress-redirection-local-capability.json).

### WordPress REST response-header pagination control

Compiler checkpoint
[`94b7b26`](https://github.com/yail259/clapping-hands/commit/94b7b26)
was frozen before exercising WordPress's documented public posts REST resource.
Two independent three-page traces with `per_page=1` taught the generic compiler
the numeric `page` progression and allowlisted `X-WP-TotalPages` terminal
header. The runner then published one synthetic post through WordPress's own PHP
API, increasing the total from three pages to four.

Compiled replay adapted to the new header, made four fresh requests with zero
navigations/model calls, and returned the unseen post exactly once with no
duplicate IDs. The single replay took 71.41 ms. The application-side oracle
verified the post before replay, and cleanup permanently removed it; a public
REST search then returned zero matches. This is a real response-header protocol
regression and API-first negative control—not a UI-compilation win, paired speed
result, or reason to wrap WordPress's task-complete API. The sanitized report is
[`bench/runs/2026-09-05/wordpress-local-header-pagination-capability.json`](../bench/runs/2026-09-05/wordpress-local-header-pagination-capability.json).

## ATO educational simulator attempt — 2026-09-05

The next distinct production operator was frozen against the ATO online
services simulator. The task selected published mock scenario 1, demonstrated
two read-only Super information destinations, and reserved an unseen third
destination for zero-model replay. No taxpayer credentials or real records are
involved in this simulator.

The first attempt failed during scenario bootstrap, before either demonstration
or compilation. Its Start navigation wait used Playwright's full-load readiness
and timed out. This is a benchmark-harness failure, not a Clapping Hands pass or
failure. The runner now waits for `DOMContentLoaded`, then independently
requires the simulator shell; destination navigation uses the same bounded
readiness rule plus exact path and visible-heading checks.

The traffic ledger had reserved five journeys before launch. That reservation
was retained, so the task was not retried in the same daily window. The
sanitized failure record is
[`bench/runs/2026-09-05/ato-simulator-live-attempt.json`](../bench/runs/2026-09-05/ato-simulator-live-attempt.json).

## Self-hosted InvoicePlane capability regression — 2026-09-05

The first API-poor reserve application was exercised against official
InvoicePlane 1.7.2 source at commit `aaeea1e` in a loopback-only container,
with MariaDB 11.4 and synthetic administrator, client, invoice, and line-item
data. The disposable administrator password was rotated in memory, browser
state was restarted before replay, and no credential or session material was
written to the plan or report.

Two guided demonstrations created and then removed draft invoices for different
clients, quantities, unit prices, and item names. Compiler checkpoint
[`b919e74`](https://github.com/yail259/clapping-hands/commit/b919e74) then replayed
the never-demonstrated third input:

| Workflow | Mechanism | Effect path | Compiled model calls | Independent result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Create unseen draft invoice with one line item | CodeIgniter UI, Select2 AJAX client lookup, jQuery JSON line-item save | browser-idle prepare, then one-shot commit | 0 | one exact invoice/item; quantity 4 × 11.50 produced subtotal, total, and balance 46.00 | pass after compiler fixes |

Prepare created no database row and did not change the page. Commit produced
one draft and one item with the requested client, description, quantity, unit
price, subtotal, total, and balance. The visible editor independently matched
the item fields and rendered total. Reusing the receipt was rejected before a
second site action and left the same invoice and item IDs in place. Cleanup
then removed all synthetic invoices and clients and verified zero matching
rows remained.

The flow found two related but general compiler defects. A one-character input
such as quantity `2` was initially mistaken for evidence inside the stable
selector token `select2`. Boundary-aware replacement fixed that, after which a
later quantity `3` could still rewrite the index inside a placeholder already
created for the unit-price input. Existing compiler sentinels are now immutable
during subsequent input binding, for both DOM strings and input-bound URLs. A
focused regression plus the full 91-test suite covers the cases.

This is a guided `n=1` capability regression, not an untouched holdout or speed
result. No task-complete first-party external invoice CRUD API was identified
in the pinned release documentation; the same-origin AJAX endpoints exercised
here are authenticated UI internals. The sanitized report is
[`bench/runs/2026-09-05/invoiceplane-local-capability.json`](../bench/runs/2026-09-05/invoiceplane-local-capability.json),
and local fixture notes are in
[`bench/fixtures/invoiceplane`](../bench/fixtures/invoiceplane/README.md).

## Discourse official-demo holdout — 2026-09-04

Compiler checkpoint [`2ed9448`](https://github.com/yail259/clapping-hands/commit/2ed9448)
was exercised against [Discourse's official demo](https://try.discourse.org/).
[Discourse Meta](https://meta.discourse.org/t/new-to-discourse-start-here/1)
describes it as a no-setup sandbox for testing and exploring the interface.
The task and unseen input were fixed before compilation: demonstrate category
navigation for `general` and `tech`, then replay `support`.

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Open unseen category | Ember client route + asynchronous outlet replacement | read DOM | 0 | `/c/support/50` plus rendered input evidence | pass |

The three runner journeys and three preceding discovery journeys created no
content. One discovery navigation timed out while waiting for `networkidle`;
Discourse keeps live connections active, so the harness now waits for the
specific rendered outlet instead. That was a discovery-driver correction, not
a compiler failure or rerun. The compiled replay took 2,827 ms in this single
observation and made two counted navigations; `n=1` is deliberately not
reported as a speed ratio.

The sanitized report is
[`bench/runs/2026-09-04/discourse-demo-live-smoke.json`](../bench/runs/2026-09-04/discourse-demo-live-smoke.json).
This is the first untouched corpus-v2 candidate pass, but one task on one
application is far below the release gate for an 80–90% representative-corpus
claim.

### Self-hosted Discourse rich-composer regression

The same application family was exercised against official Discourse source at
commit `4cefc8c` and the pinned `discourse/discourse_dev:20260812-0036` image on
loopback. Compiler checkpoint
[`9e3e7ae`](https://github.com/yail259/clapping-hands/commit/9e3e7ae)
passed all three frozen unseen tasks after a clean browser restart:

| Workflow | Mechanism | Effect path | Compiled model calls | Independent result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Search unseen topic | Ember SPA search | read DOM | 0 | exact query, title, and route | pass |
| Create unseen topic | rich composer with hidden autosave | browser-idle prepare, then one-shot commit | 0 | no draft/topic at prepare; exactly one topic at commit | pass after runtime fixes |
| Edit unseen seeded topic | input-bound route + rich composer | browser-idle prepare, then one-shot commit | 0 | original body at prepare; exact new body once | pass after runtime fixes |

The run found two general defects. First, filling the composer emitted
`POST /drafts.json` before the visible Create Topic action, so replaying a
supposedly harmless prefix during prepare was unsafe. Prepare now performs no
navigation or browser action; the receipt enters `committing` before the whole
workflow begins. Second, the edit UI rendered the new body before PostgreSQL
could observe it. Commit acknowledgement now waits for successful finite
mutation requests caused by the compiled interaction. A renewed POST endpoint
ending in `/poll` is treated as background only after a successful finite
mutation from the final-action window, preventing Discourse's message bus from
blocking forever without allowing a lone slow write to pass.

The runner also exposed bounded SPA start-navigation races (`ERR_ABORTED`,
`ERR_EMPTY_RESPONSE`, and an execution-context replacement). Only the declared
initial navigation may retry; no compiled action or write is replayed. The
PostgreSQL oracle found no mutation during either prepare, one exact mutation
after each commit, no duplicate after rejected receipt reuse, and complete
fixture cleanup. The sanitized report is
[`bench/runs/2026-09-04/discourse-local-capability.json`](../bench/runs/2026-09-04/discourse-local-capability.json).
This is a guided regression on a pinned development deployment, not an
untouched holdout or latency distribution. A configured, task-complete
first-party Discourse API remains preferred.

### Self-hosted Discourse generic pagination regression

Compiler checkpoint
[`8478ea1`](https://github.com/yail259/clapping-hands/commit/8478ea1)
added generic numeric page/offset inference after the cursor strategy was frozen
separately at `97ea445`. The pinned local Discourse application supplied two
independent three-page `/latest.json` traces. Without any Discourse-specific
compiler rule, the plan inferred an omitted first `page` parameter, continuation
values `1` and `2`, a `+1` increment, and `topic_list.more_topics_url` as the
terminal signal.

The runner then deleted all 65 demonstrated synthetic topics and created 65
replacement topics with entirely new IDs. Compiled replay made three fresh JSON
requests, zero navigations, and zero model calls; it returned every replacement
topic exactly once with no duplicate IDs and reported completion only after the
terminal response. The measured replay was 342.67 ms, but `n=1` and no paired UI
baseline make this a capability result, not a speed row. Cleanup independently
verified zero pagination fixture topics remained. The sanitized report is
[`bench/runs/2026-09-05/discourse-local-pagination-capability.json`](../bench/runs/2026-09-05/discourse-local-pagination-capability.json).

## Nextcloud instant-trial holdout — rerun deferred, 2026-09-04

[Nextcloud's instant trial](https://try.nextcloud.com/) created a disposable
test account on an official demo host. The account is automatically removed;
the harness persisted only its browser-managed session and created no files or
folders. The frozen task was to demonstrate opening `Documents` and `Photos`,
restart the browser, then replay the unseen `Templates` folder.

No compiled replay ran. Three first-journey attempts failed closed:

| Stage | Failure | Disposition |
| --- | --- | --- |
| Initial demonstration | The first-run wizard intercepted the folder click. | Treat onboarding as an explicit trial setup precondition, never a generic auto-dismiss rule. |
| Corrected demonstration | The harness sampled hidden carousel controls during the wizard's intro transition. | Use the wizard's documented `Close` action after a bounded wait. |
| Corrected demonstration | The file UI was usable, but the core navigator required the global `load` event and timed out after 30 seconds. | Commit navigation at `DOMContentLoaded`; use bounded `load`/network-idle settling and keep selectors/output as the real readiness gates. |

The navigation fix has a controlled regression for a DOM-ready application
whose global `load` event never completes, but the public rerun is deferred.
Eight of the ten permitted demo-host journeys were actually consumed; the two
remaining journeys cannot fit a clean two-demonstration-plus-replay run. This
row therefore contributes **no pass**, no speed number, and no coverage credit.
The sanitized failure report is
[`bench/runs/2026-09-04/nextcloud-trial-holdout.json`](../bench/runs/2026-09-04/nextcloud-trial-holdout.json).

### Self-hosted Nextcloud capability regression

The same workflow family was exercised independently against the official
Nextcloud 33.0.8 Apache container on loopback, with a synthetic account and
files. The expanded run used compiler checkpoint
[`7edd55a`](https://github.com/yail259/clapping-hands/commit/7edd55a), and is not a
retroactive pass for the capped public holdout.

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Open unseen `Templates` folder | authenticated Vue route with numeric view ID and `dir` query | read DOM after clean restart | 0 | route and rendered folder matched | pass after runner correction |
| Upload allowlisted synthetic file | two competing file inputs, asynchronous upload | prepare/commit | 0 | prepare absent; commit one file; repeat rejected | pass after compiler fix |
| Download unseen synthetic file | input-bound row menu + browser download | read DOM + quarantined artifact | 0 | filename, byte count, and SHA-256 matched | pass after compiler fix |
| Create public share for unseen file | input-bound sharing sidebar + finite OCS mutation | prepare/commit | 0 | prepare absent; one type-3 share; repeat rejected | pass |

The initial upload demonstration failed closed because the page contains both
the Files uploader and a text-editor attachment input. The general learner now
scores semantic element metadata against the explicit `upload` or `attach`
instruction and proceeds only when one candidate wins unambiguously. Anonymous
and tied file inputs still fail closed; one regression test covers both cases.

Two harness assumptions also failed without receiving compiler credit:
Nextcloud 33 uses a numeric file-view path plus a `dir` query, and file-row
accessible labels are generic while the visible stem and extension occupy
separate spans. The rerun used version-tolerant exact oracles for both.

The download demonstrations also exposed a general validation defect. Because
both alpha and beta were visible in the aggregate file list, the two complete
output snapshots were identical. Exact-snapshot validation then rejected the
unseen gamma list despite the requested filename being present. When varied
inputs are explicitly evidenced in output, the compiler now validates that
input evidence plus output plausibility instead of freezing unrelated aggregate
content. The controlled regression still rejects an unseen input that is absent.

The upload plan persisted neither demonstrated filename nor credential. A
WebDAV HEAD proved no file existed after upload prepare, one 47-byte file
existed after commit, and its entity and size were unchanged after a rejected
second commit. The downloaded artifact matched the allowlisted source by size
and SHA-256. An OCS oracle proved no public share existed after prepare, exactly
one public-link share existed after commit, and the share ID was unchanged after
rejected receipt reuse. OCS and WebDAV then removed all shares and files and
verified cleanup. Because those APIs already cover the tested operations, this
row is evidence for browser fallback, artifacts, and effect safety—not a no-API
product win or speed result. The sanitized report is
[`bench/runs/2026-09-04/nextcloud-local-capability.json`](../bench/runs/2026-09-04/nextcloud-local-capability.json).

## Self-hosted Moodle capability regression — expanded 2026-09-05

The official Moodle developer environment was installed on loopback from
Moodle 5.2.2 commit `8ad9354e` and `moodle-docker` commit `f4c2324d`, with a
synthetic teacher, student, three courses, and three manual grade items. The
runner rotated the local credentials, persisted neither credentials nor Moodle
session keys, and restarted separate teacher and student browser profiles before
their unseen replays.

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Open unseen course/tab combination | authenticated server navigation across course and role views | read DOM after clean restart | 0 | exact course, Participants route, and rendered evidence | pass |
| Change unseen course grade | persistent edit-mode state plus form save | prepare/commit | 0 | prepare empty; commit grade 61; repeat rejected | pass |
| Submit unseen student assignment | input-bound activity URL plus online-text form | browser-idle prepare, then one-shot commit | 0 | no response at prepare; exact submitted response at commit; repeat rejected | pass |

Moodle's Edit mode is a persistent toggle. A literal “click Edit mode” plan can
silently do the opposite on a later run, so the demonstrated plan uses the
runtime's idempotent `check` operation to ensure the mode is enabled. That was
a workflow-encoding correction, not a new site-specific compiler branch. The
first formal harness attempt also compared the entered string `72` with
Moodle's formatted `72.00` and failed closed; the corrected assertion compares
numbers and still requires Moodle's server-side gradebook API as the oracle.

The grade demonstrations set grades 72 and 83 on separate courses and were
independently verified and cleared. The unseen commit set grade 61 exactly
once, a second use of the receipt was rejected before another UI action, and
the oracle verified all synthetic grades were empty after cleanup.

The expanded run provisioned three online-text assignments and configured the
synthetic student to use Moodle's plain textarea editor, isolating the
role/session, activity-route, and effect-lifecycle behavior missing from the
row. Two different assignment/response pairs were demonstrated and removed.
After a clean student-profile restart, compiled replay opened the unseen third
activity, entered a new response, and saved it. Moodle's database reported
status `submitted` and the exact response text; the rendered status agreed.
Prepare created no submission and did not change the page, receipt reuse was
rejected with the same submission ID remaining, and all three responses were
deleted and verified absent.

One discovery-only fixture warning and one formal harness assertion failed
closed without compiler changes. Developer debugging refused Moodle's automatic
redirect for `.invalid` fixture email; `example.com` fixture addresses now route
only to local Mailpit. The first plan assertion also demanded an effect boundary
at the read-only “Add submission” click, while the compiler correctly placed it
at the following fill because reactive form fields may autosave. The runner now
requires that conservative index and independently proves browser-idle,
database-idle prepare.

This is development/regression evidence on one pinned application, not a speed
result or untouched-holdout credit. The expanded compiler checkpoint is
[`271a2bd`](https://github.com/yail259/clapping-hands/commit/271a2bd), and its
sanitized report is
[`bench/runs/2026-09-05/moodle-local-expanded-capability.json`](../bench/runs/2026-09-05/moodle-local-expanded-capability.json).
The earlier 2/2 report remains as historical evidence. Fixture sources and
setup notes are in
[`bench/fixtures/moodle`](../bench/fixtures/moodle/README.md).

A separate authenticated course-search distribution ran after three warmups
with 20 interleaved browser/direct pairs. Every browser and compiled result
returned the exact requested fixture course and excluded the other two:

| Engine | n | p50 | p95 | Correctness | Requests; navigations |
| --- | ---: | ---: | ---: | --- | --- |
| Browser form | 20 | 11,072.75 ms | 11,215.91 ms | 20/20 | 2 workflow documents; 2 navigations |
| `html-form-v2` | 20 | 890.41 ms | 1,034.66 ms | 20/20 | 2 workflow documents; 0 navigations |

The median ratio was **12.44×**. This result used Moodle's official local
developer environment with debugging enabled; its absolute latency must not be
presented as representative production Moodle performance. Both paths fetched
fresh authenticated workflow documents. The compiled path skipped browser
navigation, theme/JavaScript boot, and rendering rather than serving cached
course data. The first frozen attempt failed closed because raw Chromium did
not restore Moodle's session-only cookie after a clean process restart. The
corrected runner uses Clapping Hands' production persistent-browser runtime,
which restores first-party session cookies without exposing them. No compiler
change was needed. The passing checkpoint is
[`95b28cb`](https://github.com/yail259/clapping-hands/commit/95b28cb), and the
sanitized samples are in
[`bench/runs/2026-09-05/moodle-local-performance.json`](../bench/runs/2026-09-05/moodle-local-performance.json).

## Self-hosted nopCommerce capability and performance — 2026-09-04/05

nopCommerce 4.90.6 was installed from the vendor's official container on
loopback with PostgreSQL 17, the vendor sample catalogue, and one synthetic
administrator. The public demo was not used: although nopCommerce invites
evaluation and resets it hourly, the storefront returned an explicit
Cloudflare challenge and the benchmark did not attempt to bypass it.

The first cart compilation failed closed before replay because the slug
`nokia-lumia-1020` contains the shorter product ID `20`. The general DOM/URL
template binder had substituted short inputs first. It now binds longer
demonstrated values before shorter overlapping values; equal or otherwise
irreducible bindings still fail closed. A focused regression covers the exact
overlap without adding a nopCommerce-specific branch.

| Workflow | Mechanism | Effect path | Compiled model calls | Exact result | Verdict |
| --- | --- | --- | ---: | --- | --- |
| Search unseen product term | server-rendered GET form | direct fresh HTML requests | 0 | exact query URL and expected product | pass |
| Add unseen product to cart | AJAX product action | prepare/commit | 0 | prepare empty; one database row at commit; repeat rejected | pass after compiler fix |
| Update unseen product description | protected admin form | prepare/commit | 0 | prepare unchanged; PostgreSQL and storefront exact; repeat rejected | pass |

The search distribution used three warmups and 20 interleaved browser/compiled
pairs. Every measured result passed the exact oracle:

| Engine | n | p50 | p95 | Correctness | Requests; navigations |
| --- | ---: | ---: | ---: | --- | --- |
| Browser form | 20 | 1,437.72 ms | 1,901.28 ms | 20/20 | 2; 2 |
| `html-form-v2` | 20 | 68.49 ms | 96.80 ms | 20/20 | 2; 0 |

The median ratio was **20.99×**. Both paths made two fresh requests; the
compiled path removed navigation/rendering rather than caching catalogue data.
The cart database was empty after prepare, contained exactly product 17 with
quantity one after commit, was unchanged after the rejected duplicate, and was
empty after cleanup.

The admin expansion used products 18 and 20 as varied demonstrations and
product 17 as the unseen replay on compiler checkpoint
[`e009794`](https://github.com/yail259/clapping-hands/commit/e009794). The plan
compiled in 3.17 ms and the one observed compiled commit took 1,953.22 ms; that
single observation is capability evidence, not a speed comparison. The
persistent authenticated profile survived a clean browser restart. Prepare did
not change the database, commit wrote the exact requested description, the
public product page exposed the same value, receipt reuse was rejected, and the
runner restored all three descriptions, original update timestamps, and the
prior synthetic credential.

Two preliminary attempts failed before compilation because the harness used a
storefront-style `#content` selector on admin pages; nopCommerce actually uses
`.content-wrapper`. A third attempt completed the unseen write but the outer
gate rejected the run because a guessed `api-backend` spelling also returned
400 through the frontend plugin's versioned token route. Plugin inventory is
now the provider-presence oracle. Every failed attempt ran the same final
cleanup and left no synthetic product value behind. These were benchmark-driver
corrections, not compiler fixes.

nopCommerce documents broad frontend buying APIs, but its official plugin is a
separately licensed product that requires configuration. In this fixture the
frontend plugin and token route were present, the Swagger route was absent, and
no backend/admin plugin provider was installed. The selected protected product
edit was therefore not task-complete through the configured API surface. A
configured, task-complete API must be preferred. These results support only
these workflows on this pinned instance; they are not a general website claim.
The sanitized reports are
[`bench/runs/2026-09-04/nopcommerce-local.json`](../bench/runs/2026-09-04/nopcommerce-local.json),
and
[`bench/runs/2026-09-05/nopcommerce-admin-local-capability.json`](../bench/runs/2026-09-05/nopcommerce-admin-local-capability.json),
with setup notes in
[`bench/fixtures/nopcommerce`](../bench/fixtures/nopcommerce/README.md).

## API-first negative control — 2026-09-04

Public metadata for `yail259/clapping-hands` is fully covered by
[GitHub's documented REST API](https://docs.github.com/en/rest/repos/repos#get-a-repository).
The correct benchmark decision was therefore to decline UI compilation.

| Task | Integration decision | API requests | Browser navigations | UI compiler calls | Model calls | Exact result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Read public repository metadata | official API | 1 | 0 | 0 | 0 | repository identity matched |

The public request needed no API key and took 352 ms in one observation. That
latency is not a speed benchmark; this row tests routing discipline. It prevents
the corpus from rewarding Clapping Hands for automating a UI when a supported,
task-complete first-party API is already available. The sanitized report is
[`bench/runs/2026-09-04/github-api-first-control.json`](../bench/runs/2026-09-04/github-api-first-control.json).
