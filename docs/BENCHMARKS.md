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
cross-site speed claim. The current suite has 81 passing tests and the built MCP server
advertises ten management/Marketplace tools before any generated workflow tools
are loaded.

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
- allowlisted, size-bounded file selection with prepare-time content
  fingerprints, plus one-shot execution of the complete effect suffix; and
- same-origin downloads quarantined into unique directories with filename,
  non-empty/size, and SHA-256 evidence, while changed downloads fail closed;
- full persisted-plan safety validation for DOM, form, and network engines on
  save, load, update, and replay; and
- fail-closed output freshness: a cached DOM path cannot report unchanged,
  pre-action content as a successful fresh result.

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
81-test suite covers these cases.

This supports only the pinned WordPress version and post-search workflow above;
it is not a claim that all WordPress tasks—or websites generally—are 7× faster.
The report retains all samples, image digests, environment metadata, and the
exact code revision in
[`bench/runs/2026-09-04/wordpress-local-performance.json`](../bench/runs/2026-09-04/wordpress-local-performance.json).

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
