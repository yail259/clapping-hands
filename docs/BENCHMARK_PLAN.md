# Clapping Hands benchmark and claim-verification plan

**Status:** proposed benchmark contract

**Date:** 2026-09-04

**Scope:** user-authorized read, reversible-write, and consequential-commit
workflows on production software where the chosen task has no suitable public
API

This plan is intentionally harder to pass than a product demo. It separates
three questions that are easy to blur together:

1. Can Clapping Hands produce the right fresh result or remote effect?
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
| Action alpha | Three user-controlled deployments of real production applications, covering read, reversible write, upload, and one explicitly approved commit | “Clapping Hands compiled several UI workflows—including writes—into validated tools on production software we controlled.” |
| Generalizing compiler | Six eligible applications across four architecture families and all three effect classes, including at least three frozen-core holdouts | “Clapping Hands can often compile repeated UI workflows into validated tools when no suitable API exists.” |
| “Any website/action” | Not a responsible claim | Never use this without prominent qualification; some actions have no promotable request, already have a good API, prohibit automation, or require human judgment. |

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
| Reversible mutation + rotating CSRF | Prepare/commit separation, effect journaling, postcondition proof, rollback |
| Ambiguous commit response | `outcome_unknown`, reconciliation, and no automatic retry |
| Duplicate submit/retry | Idempotency key or duplicate detection; no duplicated remote effect |
| File upload and download | Multipart capture, file boundaries, checksums, and safe artifact handling |
| Multi-step wizard | State transition capture, validation errors, and final-review confirmation |
| Consequential mutation candidate | Correct effect classification and rejection unless the commit gate is enabled |
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

### B. Real production software and permission-gated live sites

The primary corpus uses real, maintained production applications rather than
toy scraping targets. The safest strong evidence comes from installing those
applications in isolated, user-controlled tenants with seeded synthetic data.
They retain production UI, auth, CSRF, validation, uploads, notifications, and
state transitions while making writes repeatable and independently observable.

Eligible environments, in priority order, are:

1. an isolated deployment of real production software controlled by the
   benchmark operator;
2. an official developer tenant or sandbox whose rules permit the tested
   automation;
3. a consenting organization's staging or production tenant with written
   permission and synthetic or specifically approved records;
4. an existing third-party account, only for low-rate workflows that the
   service explicitly permits to be automated.

Tests against public services answer whether the compiler survives production
mess: hydration, analytics noise, experiments, auth expiry, dynamic ranking,
and latency. They are useful, but are not more credible merely because someone
else operates the server.

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

For a write or commit, also record:

- the test record and account boundary, rollback/reset procedure, and any
  notification or payment sink;
- the action's effect class and the evidence shown before confirmation;
- the idempotency or duplicate-detection strategy;
- an independent postcondition/reconciliation query;
- the expected behavior for an ambiguous response.

No benchmark run attempts to defeat a CAPTCHA, challenge, rate limit, access
control, or bot defense. Stop immediately on 401, 403, 429, checkpoint, CAPTCHA,
or an explicit automation warning. A disclaimer in this repository does not
turn an otherwise unauthorized action into an authorized benchmark.

### C. Frozen-core holdouts

Development sites can accidentally train the implementation. To test the word
“compiler”:

1. Build support using the fixture suite and no more than three development
   domains.
2. Commit the compiler and record its Git SHA.
3. Select at least three previously unseen, permission-eligible applications
   spanning different architecture and effect families.
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

Every workflow declares one effect class before compilation:

| Effect class | Meaning | Benchmark rule |
| --- | --- | --- |
| `read` | No persistent remote state change | May use paired shadow runs within the request budget |
| `write` | Persistent but deliberately reversible or contained change, such as a draft, label, cart item, or test-record edit | Run only on seeded records; require prepare/commit, journal, proof, and reset |
| `commit` | Externally consequential or difficult-to-reverse action, such as send, publish, approve, purchase, delete, or final submit | Explicit human confirmation; isolated sink or sandbox; at-most-once execution and success proof; never automatic retry |

The current prototype implements only `read` network promotion. Write and commit
rows remain ineligible until the effect-safety ADR and fixture gates are
implemented. This keeps the broader product vision distinct from the feature
set shipped today.

### 1. Preflight

- Complete the API/policy/robots review.
- Freeze the task contract: inputs, output fields, freshness, ordering, and page
  budget.
- Choose five input cases for reads. For writes, seed independent target records
  spanning valid, validation-error, duplicate, stale-state, and Unicode/file
  inputs. For commits, use only resettable test records and controlled sinks.
- Define an independent oracle. The compiler's response paths must not grade
  themselves.
- Set a maximum of one workflow at a time, three logical result pages, and no
  request rate more aggressive than the equivalent UI path.

### 2. Smoke gate

- One cold semantic/browser run.
- Two demonstrations with distinct inputs.
- Two immediate shadow comparisons for reads, or two prepared-intent comparisons
  that stop before commit for writes.
- Three warm calls, including one no-result/validation-error case.
- For a reversible write, one confirmed mutation, independent postcondition
  check, rollback, and rollback proof.
- For a commit, one confirmed action against an isolated sink plus at-most-once
  execution and reconciliation proof. Never perform a live duplicate shadow
  commit.
- One clean browser/runtime restart and warm call.
- One persisted-artifact and output redaction scan.

A failure stops promotion but remains a published result.

### 3. Verification run

For workflows that pass smoke:

- Reads: 20 warm executions spanning all five inputs.
- Reversible writes on isolated tenants: 20 executions on independent seeded
  records, each followed by a postcondition check and reset.
- Commits on isolated tenants or official sandboxes: 10 executions to controlled
  sinks. A third-party production commit is limited to one explicitly approved
  action and is reported as a smoke result, not reliability evidence.
- At least 10 paired baseline/compiled trials, interleaved to reduce network-time
  bias. For effectful actions, each pair uses different but equivalent seeded
  records; the baseline and compiled path never act on the same record.
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
- Every write/commit is classified correctly before execution and has a
  human-readable prepared intent naming the target and material parameters.
- Every effectful run has a durable journal entry and an independent observed
  postcondition; an HTTP success response alone is not proof.
- Every write is reset and the reset is verified.
- A successful commit has one proven effect and never produces a duplicate.
  Ambiguous transport or response state returns `outcome_unknown`, reconciles
  before any further action, and is never retried automatically.
- Write and commit network promotion are separately gated; proving reads does
  not silently enable mutation replay.

Use paired timings on the same machine, browser version, location, page budget,
and time window. Report cold compile time separately; never amortize it into a
single warm run.

## Outcome buckets

Every attempted workflow lands in exactly one bucket:

- `network`: pure promoted request path;
- `network-bootstrap`: small declared UI bootstrap followed by promoted requests;
- `dom`: correct deterministic browser path with no promotable network plan;
- `semantic-fallback`: model/browser repair was required;
- `prepared`: an effectful intent was compiled and validated but not committed;
- `effect-verified`: one intended remote effect was independently proven, with
  no duplicate effect observed;
- `outcome-unknown`: the system could not prove whether an effect occurred and
  safely stopped without retrying;
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

## Initial production-application corpus

“No usable API” is task-specific. Partner feeds or posting APIs do not satisfy a
consumer search workflow, and a product-level API may still omit a particular
admin action. Conversely, if an official API does cover the requested action,
Clapping Hands should use or recommend it instead of compiling private browser
traffic. API selection is part of the product, not a benchmark inconvenience.

| Application/environment | Candidate workflows and effects | API status for chosen task | Permission status | Corpus decision |
| --- | --- | --- | --- | --- |
| **osTicket, self-hosted** | Search/filter queue (`read`); add note or reassign (`write`); close/reply to a seeded ticket (`commit`) | Official API currently supports ticket creation only, not modification or deletion | Operator-owned deployment and synthetic tickets | **First choice:** unusually clear public-API gap with rich authenticated UI actions |
| **InvoicePlane, self-hosted** | Find clients/invoices (`read`); create/edit a draft (`write`); email an invoice to a local mail sink (`commit`) | No suitable first-party automation API has yet been confirmed; must recheck before the run | Operator-owned deployment, synthetic clients, Mailpit sink | **Second choice after API preflight:** real invoicing workflow and multipart/PDF/email boundaries |
| **OpenCart, self-hosted** | Search catalog/orders (`read`); edit stock or a draft product (`write`); publish a seeded product/update test order status (`commit`) | Task-specific preflight required; extensions or direct APIs may cover some actions | Operator-owned store with fake products/orders and payments disabled | **Third choice:** production ecommerce state machine; use an API-covered task only as a negative control |
| **OrangeHRM, self-hosted** | Employee/leave lookup (`read`); create test leave request (`write`); approve it with a second test role (`commit`) | Internal REST endpoints exist; confirm whether a supported external API covers each chosen workflow | Operator-owned deployment with synthetic people | Strong role/auth holdout; do **not** automate the public demo |
| **WordPress + a UI-only plugin, self-hosted** | Inspect settings (`read`); save draft/config (`write`); publish or trigger a test-only plugin action (`commit`) | Core REST API is broad, so select a plugin-specific workflow it does not expose | Operator-owned site and test plugin data | Strong extension/ecosystem holdout; also proves task-level API selection |
| **Odoo Standard test database** | Find records (`read`); create a draft lead/quote (`write`); confirm a seeded workflow (`commit`) | Odoo documents that its external API is unavailable on Standard/One App Free plans | Use only an operator-owned trial/test database after terms review | Valuable plan-gated API case; candidate, not pre-authorized |
| **nopCommerce, self-hosted** | Representative catalog and order actions | Official Web API covers frontend and backend platform functions | Operator-owned deployment | **Negative control:** Clapping Hands should select the official API, not claim a UI-compilation win |
| **Facebook Marketplace, existing account** | Search listings (`read`) | No suitable general buyer-search API identified | Existing personal dogfood only; Meta warns about unauthorized automated collection | Keep as pre-protocol evidence; not an effectful or high-volume benchmark |
| **Consenting customer portal** | Retrieve a document (`read`); upload/update a draft (`write`); submit to a controlled queue (`commit`) | No customer-facing API | Written operator and account-holder permission | Highest-value genuinely live row once a partner is recruited |

This review is dated 2026-09-04 and must be repeated before each live run. Terms,
APIs, and robots instructions change.

Source notes for the initial review:

- osTicket documents that its HTTP API currently creates tickets only and
  cannot modify or delete existing tickets:
  [osTicket API documentation](https://docs.osticket.com/en/latest/Developer%20Documentation/API/Tickets.html).
- InvoicePlane describes itself as a self-hosted application for quotes,
  invoices, clients, and payments, and documents draft creation and email flows:
  [InvoicePlane](https://www.invoiceplane.com/),
  [InvoicePlane quickstart](https://wiki.invoiceplane.com/en/1.6/getting-started/quickstart).
- OpenCart is an open-source production ecommerce platform with a Docker-based
  local environment:
  [OpenCart repository](https://github.com/opencart/opencart).
- OrangeHRM provides open-source and Docker/development deployments, while its
  published vulnerability policy explicitly excludes testing its hosted demo;
  the corpus therefore uses only a self-hosted instance:
  [OrangeHRM repository](https://github.com/orangehrm/orangehrm),
  [OrangeHRM policy](https://orangehrm.com/security/opensource/OrangeHRM-Vulnerability-Disclosure-Policy-Opensource.pdf).
- Odoo documents that external API access is unavailable on Standard and One
  App Free plans:
  [Odoo external API](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html).
- WordPress exposes broad core content APIs; the benchmark must therefore choose
  a genuinely plugin-specific gap rather than pretending WordPress has no API:
  [WordPress REST API](https://developer.wordpress.org/rest-api/reference/).
- nopCommerce documents full frontend and backend API coverage. It is valuable
  precisely as an API-first negative control:
  [nopCommerce Web API](https://docs.nopcommerce.com/en/developer/web-api/index.html).
- Meta's help center distinguishes authorized and unauthorized automated
  collection and describes enforcement against unauthorized scraping:
  [Meta scraping guidance](https://www.facebook.com/help/463983701520800).

The practical route to a credible multi-action table is therefore to start with
osTicket, InvoicePlane, and OpenCart on isolated deployments, then freeze the
compiler and add OrangeHRM and a WordPress plugin workflow as holdouts. A
permissioned real customer portal is the strongest later row. Hostile consumer
sites are neither necessary nor especially probative.

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
- environment class, effect class, target/sink, confirmation mode, and reset
  procedure;
- intervention class, hints supplied, hands-on minutes, and site-specific lines;
- cold compile latency and model calls/tokens;
- baseline and warm p50/p95/max latency and paired speedup;
- execution level, navigations, scrolls, direct pages, fallbacks, and repairs;
- identity recall, field agreement, ranking overlap, completeness, and success
  counts;
- restart/auth result, redaction result, and any stop/failure reason;
- prepared-intent hash, journal state, idempotency/duplicate strategy,
  postcondition evidence, reset proof, and final effect outcome.

The public summary table should remain compact:

| App | Workflow | Effect | Environment | API decision | Intervention | Best path | Success | Warm p50/p95 | Duplicate-safe | Reset/proof | Verdict |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Facebook Marketplace | Search listings | `read` | existing account | no suitable public API found | `adapter` (current prototype) | `network-bootstrap` | 3/3 warm* | 5.3 s* / pending | n/a | 100% shadow* | Pre-protocol evidence |

`*` Existing dogfood evidence, not yet rerun under this protocol. It must not be
mixed into aggregate post-protocol statistics.

Publish negative rows. A site that stays DOM-only, needs guidance, cannot be run
for policy reasons, or fails compilation teaches more than a table containing
only winners.

## Implementation sequence

1. Write and accept the effect-safety ADR: effect classes, prepared intent,
   journal, confirmation, idempotency, reconciliation, and `outcome_unknown`.
2. Generalize `MarketplaceNetworkPlan` into a site-independent action/network IR.
3. Replace the Marketplace-only recorder filter with relevance scoring across
   requests while retaining strict secret redaction and origin constraints.
4. Add response codecs for JSON, anti-XSSI JSON, HTML fragments, form posts, and
   multipart requests.
5. Add generic offset, page-number, cursor, and state-transition strategies.
6. Build the machine-readable corpus, runner, independent oracle/effect-proof
   interface, reset hooks, and Markdown table generator.
7. Complete the controlled fixture matrix, including ambiguous commits and
   duplicate delivery, before enabling any write promotion.
8. Run osTicket, InvoicePlane, and OpenCart as the development applications.
9. Freeze the compiler, select OrangeHRM, WordPress/plugin, and one further
   eligible application as holdouts, and run without code
   changes.
10. Add one permissioned customer staging/production portal.
11. Publish all rows and choose launch wording from the claim ladder rather than
    deciding the claim in advance.

## Release/Show HN gate

Before making a multi-site compiler claim on Hacker News:

- the fixture matrix is green, including silent-wrong and secret-canary tests;
- at least three real production applications have verified rows, including one
  read, one reversible write, and one explicitly approved commit;
- at least one real workflow is reproducible by an HN reader on a local
  container or public automation-permitted sandbox;
- at least one row is a frozen-core `automatic` holdout;
- every effectful row has confirmation, journal, at-most-once/reconciliation,
  and reset/postcondition evidence;
- every failure and policy exclusion remains visible;
- the benchmark corpus, runner, sanitized results, and exact git SHA are public;
- the README says “can often compile” or names the demonstrated workflows, never
  “compile any website” or “perform any action” without qualification.

The benchmark is the product contract: optimize the implementation, not the
definition of a pass.
