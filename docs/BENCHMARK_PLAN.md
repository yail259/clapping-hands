# Clapping Hands benchmark and claim-verification plan

**Status:** proposed benchmark contract

**Date:** 2026-09-04

**Scope:** read-only browser workflows on sites with no suitable public API

This plan is intentionally harder to pass than a product demo. It separates
three questions that are easy to blur together:

1. Can Clapping Hands return the right fresh result?
2. Can it make a repeated workflow materially cheaper or faster?
3. Did the compiler discover the optimization, or did a developer write a
   site-specific adapter?

A site returning HTTP 200, a tool returning non-empty JSON, or a one-off fast
run is not a pass.

## Claim ladder

Claims must be no broader than the evidence level reached.

| Evidence level | Minimum evidence | Allowed public claim |
| --- | --- | --- |
| Current prototype | Controlled fixture plus the existing Marketplace dogfood | “We compiled one authenticated Facebook Marketplace search workflow and measured an approximately 8.5x median speedup.” |
| Multi-site alpha | Three eligible real domains, at least one no-login domain, two protocol families, and the per-site gates below | “Clapping Hands works on several real read-only search workflows.” |
| Generalizing compiler | Six eligible real domains across four architecture families, including at least three frozen-core holdouts | “Clapping Hands can often compile repeated read-only browser workflows into validated tools.” |
| “Any website” | Not a responsible claim | Never use this without prominent qualification; some sites have no promotable request, prohibit automation, or require human interaction. |

Passing a DOM fallback proves task robustness, not network compilation. Passing
with a hand-written adapter proves product usefulness, not general compiler
behavior.

## Benchmark structure

The benchmark has three layers. They are reported separately.

### A. Controlled protocol fixtures

Run these locally and heavily. Each fixture has an independent ground-truth
oracle and seeded canary secrets.

| Fixture | Capability under test |
| --- | --- |
| REST JSON + offset paging | Input inference, pure zero-navigation warm replay, page caps |
| REST JSON + cursor paging | Cursor discovery, repeat-cursor detection, completeness |
| GraphQL + SSR first page | Hybrid bootstrap, operation selection, opaque cursor handling |
| Form-encoded/XSSI JSON | Dynamic form fields, anti-XSSI prefix parsing, multi-line payloads |
| HTML fragment endpoint | Network promotion when the response is fresh HTML rather than JSON |
| Session-authenticated search | Persistent profile, rotating CSRF fields, one-writer enforcement |
| Schema A/B variants | Candidate agreement, versioning, non-silent degradation |
| Login/checkpoint returned as HTTP 200 | Content-aware failure detection; never count a login shell as data |
| Response-shape drift | Validation failure, browser fallback, repair into a new plan version |
| Consequential mutation candidate | Effect classification and rejection from the read-only benchmark |
| Cross-origin redirect/SSRF candidate | Origin restriction and safe rejection |

Local fixtures carry the destructive testing load: hundreds of iterations,
fault injection, malformed bodies, timeouts, token rotation, restarts, and
intentional drift. Third-party sites do not.

Two public, automation-friendly suites extend the fixture coverage without
targeting an unwilling service:

- [ToScrape](https://sites.toscrape.com/) provides pagination, infinite scroll,
  JavaScript, delay, CSRF login, and AJAX/ViewState exercises.
- [web-scraping.dev](https://web-scraping.dev/) explicitly provides realistic
  pagination, authentication, GraphQL, and CSRF scenarios for testing.

These prove protocol handling, not real-world product demand, so they never
count as real domains in the public claim ladder.

### B. Permission-gated live-site smoke tests

Live tests answer whether the compiler survives production mess: hydration,
analytics noise, experiments, auth expiry, dynamic ranking, and latency. They
remain low-rate, read-only, and user-authorized.

Human-scale traffic is a required load-control measure, but it is not itself
authorization and does not cancel an explicit restriction on automated access.
Benchmark purpose and low volume are recorded as risk controls, not as a reason
to relabel a prohibited run as permitted.

Before a site enters this corpus, record:

- the exact user workflow and why the available official API is unsuitable;
- terms, robots instructions, and any written permission;
- authentication and personal-data exposure;
- a request/page budget and stop conditions;
- whether a compiled plan or result sample may be published.

No benchmark run attempts to defeat a CAPTCHA, challenge, rate limit, access
control, or bot defense. Stop immediately on 401, 403, 429, checkpoint, CAPTCHA,
or an explicit automation warning.

### C. Frozen-core holdouts

Development sites can accidentally train the implementation. To test the word
“compiler”:

1. Build support using the fixture suite and no more than three development
   domains.
2. Commit the compiler and record its Git SHA.
3. Select at least three previously unseen, permission-eligible domains spanning
   different architecture families.
4. Do not change core or site-specific source code during the holdout run.
5. Record every prompt, click, field label, retry, and minute of human help.
6. If a fix is needed, version the compiler and rerun the full corpus. Do not
   silently replace the failed row.

## Intervention classes

Every row receives one of these labels:

| Class | Definition | Counts as compiler evidence? |
| --- | --- | --- |
| `automatic` | Prompt/demonstrations and output schema only; no endpoint, path, or field hints | Yes |
| `guided` | Human selects a candidate operation or labels fields, but writes no site code | Partial; report separately |
| `adapter` | Site-specific parser, endpoint rule, or pagination code was added | No |
| `dom-only` | Correct browser/DOM execution, but no network plan can be promoted | No; counts as graceful fallback |
| `unsupported` | No correct execution within the budget | No |

The table also reports site-specific lines changed and hands-on minutes. Zero
lines and zero endpoint hints are the strongest result.

## Per-site protocol

### 1. Preflight

- Complete the API/policy/robots review.
- Freeze the task contract: inputs, output fields, freshness, ordering, and page
  budget.
- Choose five input cases: common/many results, rare/few results, no result,
  punctuation or Unicode, and one meaningful filter/location change.
- Define an independent oracle. The compiler's response paths must not grade
  themselves.
- Set a maximum of one workflow at a time, three logical result pages, and no
  request rate more aggressive than the equivalent UI path.

### 2. Smoke gate

- One cold semantic/browser run.
- Two demonstrations with distinct inputs.
- Two immediate shadow comparisons.
- Three warm calls, including one no-result or sparse-result query.
- One clean browser/runtime restart and warm call.
- One persisted-artifact and output redaction scan.

A failure stops promotion but remains a published result.

### 3. Verification run

For sites that pass smoke:

- 20 warm executions spanning all five inputs.
- At least 10 paired baseline/compiled trials, interleaved to reduce network-time
  bias rather than running all slow trials first.
- Runs split across at least two clean browser sessions and two time windows.
- Two forced clean restarts.
- One auth-expiry observation when authentication is required; do not induce a
  site checkpoint.
- Manual review of at least 10% of returned items against the visible page.

Pause between trials and lower the count if the site's published policy is more
restrictive. Disclose the smaller sample rather than increasing load.

### 4. Controlled drift run

Drift is injected only into owned fixtures:

- rename and move response fields;
- rotate CSRF data;
- change cursor shape;
- return a login page with HTTP 200;
- insert ads/non-result units;
- return an empty but valid result;
- repeat a pagination cursor;
- delay or truncate a response.

The required behavior is either validated success or an explicit fallback/error.
A plausible but wrong success is a release blocker.

## Correctness and performance gates

A live-site row is `verified` only when all applicable gates pass:

- Two distinct demonstrations and two successful independent shadows.
- At least 19 of 20 warm tasks return a correct result or an explicitly declared
  safe fallback.
- No silent false success, including HTTP-200 login/CAPTCHA shells.
- Stable-field agreement is at least 99% on manually/oracle-checked items.
- Result identity recall in the time-aligned observed window is at least 95%.
  Ranking overlap is reported separately because live rankings can move.
- Completeness is correct on every run: a page/result cap must produce
  `complete: false`.
- Warm deterministic/compiled runs make zero model calls unless the result is
  explicitly labeled as a repair/fallback.
- A “faster” claim requires paired median speedup of at least 2x. Report p50,
  p95, sample size, and the slowest run; do not hide warm-up failures.
- Authentication survives two clean restarts or returns structured
  `auth_required`/`checkpoint` state.
- Persisted plans, reports, MCP output, stdout/stderr, and git-visible files leak
  zero seeded or real secrets.

Use paired timings on the same machine, browser version, location, page budget,
and time window. Report cold compile time separately; never amortize it into a
single warm run.

## Outcome buckets

Every attempted workflow lands in exactly one bucket:

- `network`: pure promoted request path;
- `network-bootstrap`: small declared UI bootstrap followed by promoted requests;
- `dom`: correct deterministic browser path with no promotable network plan;
- `semantic-fallback`: model/browser repair was required;
- `auth-required` or `checkpoint`;
- `policy-blocked`: terms, robots instructions, or missing permission prevented a run;
- `antibot-stop`: the site presented a challenge and the run stopped;
- `product-fail`: eligible task produced no correct result;
- `silent-wrong`: output looked successful but failed the oracle. This is always
  a release blocker.

Report both:

- **task success:** correct network, DOM, or declared semantic fallback / eligible
  executed tasks;
- **automatic compile yield:** `automatic` network or network-bootstrap plans /
  eligible executed workflows.

Keeping those denominators separate prevents browser fallback from inflating the
compiler claim.

## Initial live-site corpus review

“No usable API” is task-specific. Partner feeds or posting APIs do not satisfy a
consumer search workflow, but their existence must still be disclosed.

| Site/workflow | API gap | Architecture value | Policy status for this project | Corpus decision |
| --- | --- | --- | --- | --- |
| Facebook Marketplace search | No suitable general buyer-search API identified | Authenticated GraphQL, SSR first page, opaque cursor | Meta warns that unauthorized automated collection can violate its terms; existing personal dogfood only | Keep the existing result, do not run a high-volume corpus or publish reusable route details without permission |
| Consenting independent catalogue | Usually no public API | Target REST/JSON or Next.js data with no login | Obtain written owner permission | Highest-priority real second domain |
| Consenting authenticated customer portal | No customer-facing API | Session auth, CSRF, private user-owned data | Test only with owner/operator and account-holder permission | High-value third domain; publish metrics only |
| Google Flights search | Partner onboarding is for airlines/OTAs rather than a general consumer query API | Batched/RPC responses and volatile search | Google robots rules disallow Flights search paths | Exclude without written permission |
| Airbnb stay search | API programs are partner/host-service scoped | Public SSR/GraphQL search | Airbnb explicitly prohibits bots/scrapers and use of undocumented APIs | Exclude without written permission |
| Letterboxd search/lists | API access is request-only and explicitly unavailable for LLM/private projects | Public HTML/fragment search | Terms prohibit automated gathering/extraction | Exclude without written permission |
| Goodreads book search | New public developer keys have not been issued since 2020 | Public search and pagination | Terms prohibit robots/data-extraction tools | Exclude without written permission |
| LinkedIn job search | Open API permissions do not include general job search; Talent APIs are partner-gated | Auth, GraphQL, pagination | User Agreement explicitly prohibits scraping and unauthorized automation | Exclude without written permission |
| Rightmove property search | Feeds/APIs serve approved industry workflows, not general consumer search | Search filters, mapping, pagination | Terms prohibit bots, scraping, and non-human technical access | Exclude without written permission |
| IKEA/Bunnings product search | No suitable consumer search API confirmed | Retail inventory, store/location context | Current robots files disallow search/API paths | Exclude pending explicit permission |

This review is dated 2026-09-04 and must be repeated before each live run. Terms,
APIs, and robots instructions change.

Source notes for the initial review:

- Meta's help center distinguishes authorized and unauthorized automated
  collection and describes enforcement against unauthorized scraping:
  [Meta scraping guidance](https://www.facebook.com/help/463983701520800).
- Google describes Flights integration as partner onboarding for airlines and
  OTAs, while its machine-readable rules disallow Flights search paths:
  [Google Flights partner documentation](https://developers.google.com/travel/flights),
  [google.com robots.txt](https://www.google.com/robots.txt).
- Airbnb limits APIs to approved programs and expressly prohibits bots,
  scrapers, and undocumented API use:
  [Airbnb API terms](https://www.airbnb.com/help/article/3418),
  [Airbnb terms](https://www.airbnb.com/help/article/2857).
- Letterboxd says API access is request-only and currently unavailable for
  LLM/private projects; its terms prohibit automated extraction:
  [Letterboxd API access](https://letterboxd.com/api-beta/),
  [Letterboxd terms](https://letterboxd.com/legal/terms-of-use/).
- Goodreads no longer issues new public developer keys and its terms exclude
  robots and similar extraction tools:
  [Goodreads developer notice](https://www.goodreads.com/group/show/8095-goodreads-developers),
  [Goodreads terms](https://www.goodreads.com/about/terms).
- LinkedIn's open permissions are narrow and its agreement prohibits scraping
  and unauthorized automation:
  [LinkedIn API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access),
  [LinkedIn user agreement](https://www.linkedin.com/legal/user-agreement).
- Rightmove publishes approved feeds/APIs, while its consumer terms prohibit
  automated collection and non-human technical access:
  [Rightmove feeds](https://www.rightmove.co.uk/adf.html),
  [Rightmove terms](https://www.rightmove.co.uk/c/terms-of-use/).
- The current retailer exclusions come directly from their machine-readable
  rules:
  [IKEA robots.txt](https://www.ikea.com/robots.txt),
  [Bunnings robots.txt](https://www.bunnings.com.au/robots.txt).

The practical route to a credible multi-site table is therefore not to ignore
these restrictions. Recruit two or three independent site owners with painful
internal or public catalog workflows and obtain explicit permission. That is
also closer to the intended customer than demonstrating against a list of
hostile consumer platforms.

## Public result artifacts

Add these once the generalized harness exists:

```text
bench/
  corpus-v1.yaml            # task contracts and eligibility metadata
  result.schema.json        # stable machine-readable result format
  fixtures/                 # owned protocol fixtures
  runs/<date>/<site>.json   # sanitized evidence rows
docs/
  BENCHMARKS.md              # generated human-readable table
```

Each result records:

- timestamp, git SHA, OS, Chrome, Node, Stagehand, and Clapping Hands versions;
- site, workflow, API/policy review date, auth class, and page budget;
- intervention class, hints supplied, hands-on minutes, and site-specific lines;
- cold compile latency and model calls/tokens;
- baseline and warm p50/p95/max latency and paired speedup;
- execution level, navigations, scrolls, direct pages, fallbacks, and repairs;
- identity recall, field agreement, ranking overlap, completeness, and success
  counts;
- restart/auth result, redaction result, and any stop/failure reason.

The public summary table should remain compact:

| Site | Workflow | Intervention | Best path | Success | Browser p50 | Warm p50/p95 | Speedup | Models | Recall | Fallbacks | Verdict |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Facebook Marketplace | Search listings | `adapter` (current prototype) | `network-bootstrap` | 3/3 warm* | 44.9 s* | 5.3 s* / pending | 8.5x* | 0* | 100% shadow* | 0* | Pre-protocol evidence |

`*` Existing dogfood evidence, not yet rerun under this protocol. It must not be
mixed into aggregate post-protocol statistics.

Publish negative rows. A site that stays DOM-only, needs guidance, cannot be run
for policy reasons, or fails compilation teaches more than a table containing
only winners.

## Implementation sequence

1. Generalize `MarketplaceNetworkPlan` into a site-independent action/network IR.
2. Replace the Marketplace-only recorder filter with relevance scoring across
   requests while retaining strict secret redaction and origin constraints.
3. Add response codecs for JSON, anti-XSSI JSON, and HTML fragments.
4. Add generic offset, page-number, and cursor pagination strategies.
5. Build the machine-readable corpus, runner, independent oracle interface, and
   Markdown table generator.
6. Complete the controlled fixture matrix and security/fault suite.
7. Recruit and obtain permission from a no-login catalogue owner; use it as the
   second development domain.
8. Add one permissioned authenticated portal as the third development domain.
9. Freeze the compiler, select three eligible holdouts, and run without code
   changes.
10. Publish all rows and choose launch wording from the claim ladder rather than
    deciding the claim in advance.

## Release/Show HN gate

Before making a multi-site compiler claim on Hacker News:

- the fixture matrix is green, including silent-wrong and secret-canary tests;
- at least three eligible real domains have verified rows;
- at least one real workflow is no-login and reproducible by an HN reader;
- at least one row is a frozen-core `automatic` holdout;
- every failure and policy exclusion remains visible;
- the benchmark corpus, runner, sanitized results, and exact git SHA are public;
- the README says “can often compile” or names the demonstrated workflows, never
  “compile any website.”

The benchmark is the product contract: optimize the implementation, not the
definition of a pass.
