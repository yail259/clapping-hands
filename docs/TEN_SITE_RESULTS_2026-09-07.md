# Ten-site read-workflow validation — 2026-09-07

## Outcome

All ten sites were attempted. Six workflows have verified acceleration, one
completed in Browser Use without acceleration, and three were unreliable or
blocked in this environment. This is a small, selected workflow sample, not a
general-web success rate, permission statement, or claim that these sites lack
official APIs. Only read operations were tested.

| Site / task | Final observed outcome | Fast execution | Complete fast call | Independent result checks |
| --- | --- | --- | --- | --- |
| RBA / inflation calculator | Accelerated | Network, 0.087 s | 0.745 s | 3/3 exact |
| Yahoo / quote heading | Accelerated | Browser URL replay, 4.48 s | 5.05 s | 3/3 exact |
| Open Library / first title | Accelerated | Browser URL replay, 6.42 s | 7.04 s | 3/3 exact |
| GOV.UK / first search title | Accelerated | Browser URL replay, 2.26 s | 2.88 s | 3/3 exact |
| IKEA / literal first product name | Accelerated after clarifying contract | Browser URL replay, 1.37 s | 1.97 s | 3/3 exact |
| Bunnings / first product title | Accelerated after paragraph extraction fix | Browser URL replay, 2.39 s | 3.18 s | 3/3 exact |
| Transport NSW / trip duration | Browser-only; longer deadline needed | Not compiled | Restart browser call 176 s | No independent oracle; agent-reported result |
| eBay / first non-sponsored title | Unreliable; failed unseen input and timed out on follow-up | Not promoted | — | Direct independent search also returned HTTP 403 |
| BOM / forecast | Access-restricted in this environment | Not attempted after failed baseline | — | Plain Chrome without wrapper also returned HTTP 403 |
| Facebook Marketplace / first listing title | Saved-session navigation failed | Not attempted after failed baseline | — | Clean Chrome reaches login; saved profile also times out without wrapper |

All six accelerated workflows matched two distinct held-out inputs, then loaded
their persisted plan in a new runtime and served a further input without an
agent/model call. Independent browser oracles matched all 18 outputs. Five use a
real browser to navigate a learned URL and read a learned selector; only RBA is
network-only execution. None caches the returned result data.

The fast timings above are single calls on different inputs. They must not be
turned into same-input ratios. A separate same-input Yahoo trial returned exactly
the same GOOG heading in 102.52 s with Browser Use versus 4.31 s with page replay
(23.77x end-to-end). This is one sequential trial, not a latency distribution.

## What changed, and what did not

- Restored an agent-free browser execution option alongside network compilation.
  It learns one string input bound into observed URL path/query components and
  a matching visible text selector/position. No per-site runtime glue was added.
- Browser Use remains the only first-use navigation agent. Unsupported workflows
  can still register a baseline-only typed tool. No second controller was added.
- Added paragraph and other ordinary text elements after Bunnings returned valid
  titles outside the initial heading/span shortlist.
- IKEA's original loose request produced `BILLY Bookcase` while its page exposed
  `BILLY`. That candidate failed its shadow and remained degraded. A new run
  explicitly requested the literal displayed product name; exact validation was
  not weakened and the original failed run is retained.
- Transport timed out at 180 s. One follow-up allowed 300 s per task and completed
  learning plus unseen/restart calls. Its evidence did not yield a safe shared
  URL/selector binding or supported network result. Its answer accuracy has not
  been independently established.
- eBay was not rescued by repeated unbounded attempts: the baseline failed an
  unseen query, and one follow-up timed out. No accelerator was promoted.
- Marketplace's saved profile failed in both the wrapper and plain Chrome. A
  clean browser reached its login page, and unauthenticated HTTP returned 200.
  Copying the saved profile also stalled on local file access. The temporary
  partial copy was removed; the original profile and credentials were preserved.
  This does not prove that the saved session is logged out or that Facebook is
  generally inaccessible. A fresh usable authenticated session is needed.

The full old DOM action-replay backend, multi-input page replay, token-dependent
network workflows, arbitrary rendered-HTML network extraction, and write actions
remain outside this result. Browser URL replay can fail on layout/position drift;
known failures degrade the plan and retain bounded Browser Use fallback.

## Evidence and experimental cohorts

The implementation evolved during the experiment. These are explicit follow-ups,
not one untouched release-wide cohort. Reports carry the pre-packaging alpha.2
label; the tested implementation is packaged as alpha.3. The initial ten-site run
did not include the later page replay backend. Failed attempts are retained.

All files below are under `bench/runs/2026-09-07/`:

- Initial complete ten-site cohort: `alpha-ten-1788749023107.json` and per-site files.
- Yahoo/Open Library page replay: `alpha-ten-1788749353343.json`.
- GOV.UK and longer Transport retry: `alpha-ten-1788749688021.json`.
- First IKEA/eBay follow-up, including rejected IKEA candidate: `alpha-ten-1788750108243.json`.
- First Bunnings follow-up, before paragraph fix: `alpha-ten-1788750252864.json`.
- Successful Bunnings: `alpha-ten-1788750751670-bunnings.json` and `.oracle.json`.
- Successful literal-name IKEA: `alpha-ten-1788750873697-ikea.json` and `.oracle.json`.
- RBA independent oracle: `alpha-ten-1788749023107-rba.oracle.json`.
- Same-input Yahoo timing: `same-input-1788749952656-yahoo_read.json`.

Browser model-call counts remain unavailable (`null`), never reported as zero.
Accelerated calls report zero because the agent is not invoked. Complete-call
timings include session setup/cleanup and exclude independent oracle work.
Public answers are stored in benchmark reports; cookies, raw captured requests,
response bodies and provider exception text are not.

## Verification and reproduction

278 tests passed, including URL injection refusal, missing/duplicate held-out
evidence, degraded-plan non-revival, persisted origin validation, interrupted
page cleanup, and existing network/HTML/session regressions. TypeScript build
passed. The live benchmark uses Astra low and Browser Use 0.13.10 in local Chrome.

```
npm test
npm run build
npm run benchmark:ten
CLAPPING_HANDS_BENCH_SITES=yahoo,openlibrary npm run benchmark:ten
```

Configure the authorized endpoint and Python environment as described in
ONBOARDING. Marketplace needs an explicit usable profile; do not copy credentials
into goals or benchmark input JSON. `verify-alpha-rba.ts` and
`verify-alpha-retail.ts` are independent benchmark-only oracles, never runtime
site adapters. Timing and output can change with geography, sessions, live data,
model latency and site changes.
