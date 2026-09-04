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
speed claim. The current suite has 45 passing tests and the built MCP server
advertises ten management/Marketplace tools before any generated workflow tools
are loaded.

New regression coverage includes:

- generic form discovery among unrelated forms, document `<base>` handling,
  browser-default successful controls, and same-document SPA submissions;
- same-origin JSON capture for GET/POST/PUT/PATCH/DELETE, redaction of auth and
  CSRF-shaped headers, and capture from every attached tab;
- rejection of input-bound telemetry/config requests unless response values are
  also evidenced in the rendered task output;
- compilation of learned Stagehand actions into redacted selector/argument
  templates and zero-model Playwright replay;
- a persistent per-origin browser profile whose cookie and local-storage state
  survives restart without an LLM configuration;
- two distinct shadows before network promotion, schema-drift degradation, and
  deterministic browser fallback;
- atomic workflow versioning and stale-evidence rejection; and
- prepared writes, one-time effect receipts, at-most-once commit, and an
  `uncertain` terminal state after any post-click ambiguity; and
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
