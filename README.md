# Clapping Hands

**Product:** Clapping Hands 👏  
**Status:** working local MCP compiler prototype

> Compile browser workflows into APIs for sites that do not have one.

Clapping Hands turns a repeated, user-authorized browser task into a typed,
callable tool. It uses Stagehand to learn and repair browser interactions, then
progressively replaces model-driven UI work with deterministic DOM operations
or authenticated network requests. The browser remains the fallback.

## Product boundary

This project is for people who repeatedly use a site that has **no usable API**.
The first release is deliberately narrower than "compile any website."

Good initial workflows are:

- user-authorized and run through the user's own browser session;
- repeated often enough that model and browser costs matter;
- read-heavy, such as search, monitoring, retrieval, comparison, or export;
- expected to return fresh, structured data;
- blocked by the absence of a suitable public API.

The first release is not a bulk scraper, an anti-bot bypass, a general RPA
suite, or a system for autonomous purchases, messages, and destructive actions.

The scope is not limited to scraping or retrieval. The prototype compiles
zero-argument and parameterized DOM interactions, same-origin frames and new
tabs, select/scroll/double-click/drag actions, and same-origin HTML forms. It can learn authenticated JSON and
form-encoded GraphQL request accelerators on the workflow origin or an exact
additional origin declared by the operator when that response is evidenced in
the rendered result. Multi-page JSON reads can infer opaque cursors, numeric
page/offset increments, or response-provided next URLs from repeated traces,
including an omitted first `page` parameter or initial cursor. Replay stops only
on a demonstrated terminal signal within strict page and aggregate-size limits;
next URLs must retain the exact endpoint, user inputs, stable query values, and
demonstrated mutable-query shape. Numeric pagination can also terminate from a
small allowlist of total-page response headers, while response-driven traversal
can read an RFC `Link` header under the same URL guards. Experimental write workflows use a separate prepare/commit
lifecycle. Preparation validates and journals an expiring intent without
navigating or touching the browser; after confirmation, the receipt enters its
one-shot `committing` state before any navigation or UI action. This protects
against reactive controls that autosave before the visible submit button, and
the complete attempt is never retried after an ambiguous outcome. File
selection is supported only for
regular files of at most 25 MiB beneath `CLAPPING_HANDS_UPLOAD_ROOT`; file
contents are fingerprinted during prepare and must be unchanged at commit.
Because Stagehand's model action vocabulary does not include file selection,
Clapping Hands handles the unambiguous single-file-input case directly when the
instruction names exactly one compiled input; ambiguous pages fail closed.
Same-origin downloads are quarantined beneath `CLAPPING_HANDS_ARTIFACT_ROOT`,
size-bounded to 50 MiB, hashed, and never auto-opened. Cross-origin file
transfers, frames, and commits remain separately gated.

## Responsible use

Clapping Hands is experimental, local developer software for low-volume,
user-directed automation of workflows the operator is authorized to perform.
It does not grant permission to access a service, use an undocumented endpoint,
copy third-party content, or automate an account. A workflow remaining within
the traffic volume of one ordinary user reduces load, but does not by itself
make automated access authorized.

Operators are responsible for reviewing and complying with applicable service
terms, machine-readable instructions, account permissions, privacy obligations,
rate limits, and laws. Do not use Clapping Hands to:

- bulk scrape, continuously crawl, build shadow datasets, or redistribute
  third-party content;
- evade CAPTCHAs, bot defenses, checkpoints, rate limits, or access controls;
- export credentials, share authenticated sessions, or access another person's
  account or non-public data without explicit authorization;
- collect sensitive or personal information unrelated to the user's immediate
  task;
- send unsolicited messages, manipulate engagement, transact, or perform other
  consequential actions without an explicit safety design and confirmation.

Clapping Hands should stop visibly when a service refuses automation. The
authors and contributors cannot determine whether a particular workflow is
permitted by a third-party service. The software is provided under the MIT
License without warranty; see [`LICENSE`](LICENSE) for the governing license
and limitation-of-liability text.

## Core thesis

1. Stagehand gets the workflow working.
2. Clapping Hands captures it as a product-owned, versioned action.
3. Repeated runs compile away model calls.
4. Proven operations compile away UI interactions where safe.
5. Validation detects drift and falls back to the browser when necessary.

In short: **first compile away the model; then compile away the UI.**

## Repository map

- [`docs/PRODUCT_BRIEF.md`](docs/PRODUCT_BRIEF.md) — wedge, user, promise, and MVP
- [`docs/MCP_DOGFOOD.md`](docs/MCP_DOGFOOD.md) — Marketplace tool, authentication, and safety boundary
- [`docs/BENCHMARK_PLAN.md`](docs/BENCHMARK_PLAN.md) — multi-site corpus, verification protocol, and claim gates
- [`docs/BENCHMARK_CORPUS.md`](docs/BENCHMARK_CORPUS.md) — broad site inventory and narrowed representative sample
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — live smoke results, failed rows, and iteration evidence
- [`docs/ALTERNATIVES.md`](docs/ALTERNATIVES.md) — direct competitors and the honest differentiation target
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — proposed system boundaries
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — staged path to a convincing prototype
- [`docs/decisions/0001-stagehand.md`](docs/decisions/0001-stagehand.md) — why Stagehand is a replaceable dependency
- [`docs/decisions/0002-marketplace-network-promotion.md`](docs/decisions/0002-marketplace-network-promotion.md) — auth, promotion gates, and measurable acceptance criteria
- [`docs/decisions/0003-effectful-actions.md`](docs/decisions/0003-effectful-actions.md) — proposed safety contract for reversible writes and commits
- [`docs/WEBPIPE_SPEC_v0.2.md`](docs/WEBPIPE_SPEC_v0.2.md) — preserved original proposal

## Naming

"Clapping Hands" is the internal and public product name. Use the full name in
public; do not shorten it to `CLAP`, which is crowded in software. The preferred
project, package, and domain stem is `clapping-hands` or `clappinghands` as the
context requires. No trademark or domain clearance has been completed.

## Local prototype

```sh
npm install
mkdir -p .data/uploads .data/artifacts
npm test
npm run build
npm run benchmark:corpus
npm run benchmark:corpus:v2
npm run benchmark:result -- bench/runs/2026-09-05/nopcommerce-v2-order-status.json
npm run benchmark:controlled
npm run benchmark:wordpress-playground -- --live
npm run smoke:general
npm run auth:marketplace
npm run dogfood:marketplace
codex mcp add clapping-hands \
  --env CLAPPING_HANDS_PROFILE_DIR="$PWD/.data/browser-profile" \
  --env CLAPPING_HANDS_UPLOAD_ROOT="$PWD/.data/uploads" \
  --env CLAPPING_HANDS_ARTIFACT_ROOT="$PWD/.data/artifacts" \
  --env CLAPPING_HANDS_HEADLESS=false \
  -- "$(command -v node)" "$PWD/dist/src/server.js"
```

The result validator accepts both frozen, claim-eligible outcomes and explicitly
excluded post-fix regressions. Excluded results must set `claimEligible: false`
and explain the exclusion; they never enter the frozen success denominator.

`smoke:general` is an opt-in local Stagehand smoke. First-time semantic
compilation needs an LLM provider key. The default is
`openai/gpt-5.4-mini` via `OPENAI_API_KEY`; select another Stagehand-supported
model with `CLAPPING_HANDS_MODEL` and provide its provider key. Authentication,
compiled DOM/form replay, and promoted network replay do **not** call the model
and do not require a funded model account.

`auth:marketplace` opens the dedicated profile for a manual Facebook login,
closes it, and proves the authenticated state survives a clean restart.
`dogfood:marketplace` then performs two DOM demonstrations, two read-only
network shadows, three warm runs, and a restart run. Its sanitized report is
written under `.data/`.

The repository also contains an experimental, site-independent compiler for
same-origin HTML form workflows. Its low-volume live runner is disabled unless
the operator explicitly supplies `--live` after reviewing the policy and
traffic budget:

```sh
npm run benchmark:live -- --live --external-journeys-today=0
```

The external-journey count is mandatory and includes manual discovery in other
browsers. The runner keeps a local scripted-traffic ledger and refuses a run
that would exceed the public-site daily cap.

The prospective v2 generality cohort is frozen in
[`bench/corpus-v2.json`](bench/corpus-v2.json) at compiler commit `3e3d239`:
24 previously unrun application-workflow pairs across eight application rows,
with an independent oracle and reset contract for every task. Ten reads require
automatic authoring. Existing successes are regressions and do not count toward
this denominator. No 80–90% claim is made until at least 80% pass end to end
with zero false successes and zero duplicate commits.

The first public smoke covered three GOV.UK calculators with exact browser vs
compiled result agreement after one recorded fix. These are `guided`, `n=1`
observations on one domain—not evidence for “any website” or a general latency
claim. See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

A second bounded smoke on The Internet acceptance-test app passed 3/3 guided
capability probes—delayed DOM output, JavaScript confirmation, and a quarantined
download—with exact results and zero compiled model calls. It is `n=1` per task
and is not presented as a speed benchmark or a cross-site success-rate claim.

A third bounded smoke on SauceDemo passed 3/3 guided probes: authenticated
profile restart, independently checked client-side sorting, and a reversible
cart write whose prepare phase left the cart empty. The test created no order
and removed its cart item. This is also capability evidence, not a speed ratio.

The frozen compiler's first WordPress Playground holdout failed closed while
its WASM-backed iframe was still mounting. A general action-readiness fix then
passed the same guided post-search workflow with an exact unseen result and zero
compiled model calls. Because the holdout caused the fix, that pass is retained
as regression evidence and excluded from the untouched-holdout success rate.

A separate pinned WordPress 7.1 +
[Redirection 5.10.0](https://wordpress.org/plugins/redirection/) regression
passed 1/1 on a plugin-owned React write: two synthetic 301 demonstrations
compiled into a plan that created an unseen third redirect after a clean browser
restart. Prepare left the database and browser untouched; commit created one
exact row and a real public 301, receipt reuse was rejected, and cleanup removed
every synthetic rule. The run also produced a general validation fix: when a
write result demonstrably echoes its inputs, unseen replay must contain those
inputs instead of accepting any plausible changed screen. This is capability
evidence, not a speed row or a claim about all WordPress plugins. Compiler
checkpoint [`6a05aec`](https://github.com/yail259/clapping-hands/commit/6a05aec).

The self-hosted osTicket holdout also failed closed during development and then
passed 3/3 on compiler checkpoint
[`e0e2f0e`](https://github.com/yail259/clapping-hands/commit/e0e2f0e):
authenticated search compiled to two validated HTML requests, while public
ticket creation and an authenticated internal note each committed exactly once
with zero compiled model calls. The failures produced general fixes for native
form submission, rich-editor synchronization, role-separated profiles, and
input-bound same-origin start URLs. This is regression evidence, not an
untouched holdout or speed result.

Four pinned, self-hosted application workflows now have qualifying warm
distributions. Each result uses 20 interleaved browser/compiled pairs after
three warmups and requires an exact result on every run:

| Application workflow | Browser p50 / p95 | Compiled p50 / p95 | Median speedup | Correctness | Browser → compiled navigations |
| --- | ---: | ---: | ---: | --- | ---: |
| **WordPress 7.1 post search** | 860.74 / 971.67 ms | 122.08 / 144.44 ms | **7.05×** | 20/20 + 20/20 | 2 → 0 |
| **Moodle 5.2.2 course search** | 11,072.75 / 11,215.91 ms | 890.41 / 1,034.66 ms | **12.44×** | 20/20 + 20/20 | 2 → 0 |
| osTicket ticket search | 626.06 / 643.56 ms | 42.74 / 61.09 ms | **14.65×** | 20/20 + 20/20 | 2 → 0 |
| nopCommerce 4.90.6 product search | 1,437.72 / 1,901.28 ms | 68.49 / 96.80 ms | **20.99×** | 20/20 + 20/20 | 2 → 0 |

Both paths made two fresh workflow-document requests per run; compilation
removed browser navigation and rendering, not network freshness. These are four
real applications and one read workflow per application—not a general website
speed claim. Moodle ran in the official developer environment with debugging
enabled, so its absolute latency is not representative of a tuned production deployment.
Raw sanitized samples are in
[`wordpress-local-performance.json`](bench/runs/2026-09-04/wordpress-local-performance.json),
[`moodle-local-performance.json`](bench/runs/2026-09-05/moodle-local-performance.json),
[`osticket-local-performance.json`](bench/runs/2026-09-04/osticket-local-performance.json),
and [`nopcommerce-local.json`](bench/runs/2026-09-04/nopcommerce-local.json).

An untouched read-only smoke on Discourse's official demo then passed 1/1:
after demonstrations on the `general` and `tech` categories, the compiled tool
opened the unseen `support` category through Ember client routing, reached the
exact `/c/support/50` path, and used zero model calls. No shared content was
created. This is a corpus-v2 candidate capability result (`n=1`), not a speed
or 80–90% coverage claim.

The corresponding pinned, loopback-only Discourse regression passed 3/3 on
compiler checkpoint
[`9e3e7ae`](https://github.com/yail259/clapping-hands/commit/9e3e7ae): search
an unseen topic, create one synthetic topic, and edit an unseen seeded topic.
Both writes prepared with zero browser activity and no topic, draft, or content
mutation; each commit produced the exact database state once, rejected a repeat,
survived a clean browser restart, and was fully cleaned up. The rich composer
exposed two general safety defects: fills can autosave before the visible publish
button, and Ember can render an optimistic success before its finite POST/PATCH
has finished. Prepare is now browser-idle, the complete replay is one-shot, and
commit acknowledgement waits for action-caused mutation traffic while excluding
renewed long-poll subscriptions. This is capability evidence, not a speed row;
use Discourse's first-party API whenever it is configured and task-complete. The
sanitized report is
[`discourse-local-capability.json`](bench/runs/2026-09-04/discourse-local-capability.json).

A pinned, loopback-only Odoo Community 19.0 regression adds a dense enterprise
OWL application to the evidence. It passed 3/3 on an unseen customer search, a
relational line-quantity edit, and an exactly-once quotation confirmation. Both
writes prepared without a database effect, committed once with zero model
calls, rejected receipt reuse, survived clean browser restarts, and were fully
removed. Odoo exposed two general asynchronous-UI defects: controlled inputs
can lag their DOM value, and a transient re-render is not necessarily the final
result. The runtime now gives text entry a bounded settle window and requires a
changed final output to remain stable before reporting success. This is
post-fix capability evidence—not untouched holdout credit or a speed claim.
Compiler checkpoint
[`f5c3b8c`](https://github.com/yail259/clapping-hands/commit/f5c3b8c); sanitized
report:
[`odoo-local-capability.json`](bench/runs/2026-09-05/odoo-local-capability.json).

A pinned, loopback-only PrestaShop 9.1.5 regression adds a hybrid commerce
back office: Vue stock management plus server-rendered, tokenized order routes.
It passed 3/3 on an unseen product filter, exact stock adjustment, and one-time
order-state transition. Both writes prepared without effect, committed once,
rejected receipt reuse, survived two clean browser restarts, and were restored
exactly. No route token or credential was compiled or persisted: replay followed
fresh live DOM links. The stock flow exposed a general readiness defect where a
selector can temporarily match every row while an SPA filter is resolving. The
runtime now waits for bounded, stable uniqueness and still fails closed when
ambiguity persists. This is post-fix capability evidence, not untouched holdout
credit or a speed claim. Compiler checkpoint
[`509907f`](https://github.com/yail259/clapping-hands/commit/509907f); sanitized
report:
[`prestashop-local-capability.json`](bench/runs/2026-09-05/prestashop-local-capability.json).

The generic JSON compiler also passed a real Discourse numbered-pagination
regression at checkpoint
[`8478ea1`](https://github.com/yail259/clapping-hands/commit/8478ea1): two
three-page demonstrations inferred the initially omitted `page` parameter, its
`+1` progression, and the application's `more_topics_url` terminal signal.
After compilation, all 65 demonstrated synthetic topic IDs were replaced; a
zero-navigation, zero-model replay fetched three pages in 342.67 ms and returned
all 65 unseen replacement topics exactly once, with no duplicate IDs. Cleanup
removed every pagination fixture topic. This is capability evidence on one
pinned self-hosted application, not a general speed claim. The sanitized report
is [`discourse-local-pagination-capability.json`](bench/runs/2026-09-05/discourse-local-pagination-capability.json).

A separate WordPress 7.1 protocol control passed at checkpoint
[`94b7b26`](https://github.com/yail259/clapping-hands/commit/94b7b26): the
generic recorder retained only the allowlisted `X-WP-TotalPages` header, the
compiler learned three documented REST pages, and replay adapted to four pages
after one unseen synthetic post was published. Four fresh requests returned the
post exactly once in 71.41 ms with zero navigations/model calls; cleanup removed
it. Because WordPress already documents this API, this is response-header and
API-routing evidence—not a UI-compilation win or speed row. The report is
[`wordpress-local-header-pagination-capability.json`](bench/runs/2026-09-05/wordpress-local-header-pagination-capability.json).

A pinned, loopback-only Nextcloud 33.0.8 regression then passed 4/4: it opened
an unseen folder, uploaded and downloaded an allowlisted synthetic file, and
created one public share after a clean browser restart. The download matched
filename, byte count, and SHA-256. Both writes prepared without effect, committed
exactly once, rejected receipt reuse, and were removed with all synthetic files.
The run exposed two general compiler defects: competing file inputs now require
one semantic winner, and identical aggregate demonstration pages now use varied
input evidence instead of freezing unrelated surrounding content. Anonymous or
tied candidates and unseen outputs without their requested input still fail
closed. Nextcloud's WebDAV and OCS APIs remain the right integrations for tasks
they cover; this row is browser/artifact/effect-safety evidence, not an argument
to ignore them. The expanded compiler checkpoint is
[`7edd55a`](https://github.com/yail259/clapping-hands/commit/7edd55a).

A pinned, loopback-only InvoicePlane 1.7.2 regression passed 1/1 on a stateful
finance workflow: create an unseen draft invoice for a selected client, add a
line item, and let the application calculate the totals. Prepare left both the
browser and database untouched; commit created one exact invoice and item,
receipt reuse was rejected, authentication survived a clean browser restart,
and cleanup removed every synthetic client and invoice. The nine-action flow
crosses a Select2 AJAX lookup and a jQuery JSON save, yet compiled replay used
zero model calls. It exposed two general short-input binding bugs: a quantity
such as `2` must not bind inside a stable token such as `select2`, and a later
input must not rewrite an earlier compiler placeholder. This is one capability
regression, not a timing distribution or general coverage claim. Compiler
checkpoint [`b919e74`](https://github.com/yail259/clapping-hands/commit/b919e74).

A pinned, loopback-only Moodle 5.2.2 regression now passes 3/3 across separate
teacher and student profiles. A compiled read opened an unseen course/tab
combination; a teacher workflow changed one synthetic student's grade; and an
unseen student workflow submitted an exact online-text assignment response.
Both roles survived clean browser restarts. Each prepare left the browser and
server state untouched, each commit wrote exactly once, repeated receipts were
rejected, and cleanup restored every synthetic grade and submission to empty.
Moodle's persistent Edit mode uses an idempotent `check` rather than a literal
toggle, while the assignment plan treats opening its form as passive and the
following fill as the conservative effect boundary. This remains capability
regression evidence rather than untouched-holdout credit. A separate 20-pair
authenticated course-search distribution passed 40/40 exact checks at a
12.44× median speedup; its developer-mode scope is stated in the table above.
Expanded capability checkpoint
[`271a2bd`](https://github.com/yail259/clapping-hands/commit/271a2bd).

A pinned, loopback-only nopCommerce 4.90.6 regression now passes 3/3 across
storefront and protected admin workflows. Product search compiled from a
server-rendered form; add-to-cart committed one exact database row; and a new
admin plan learned two varied product-description edits, survived a browser
restart, then updated an unseen third product exactly once. The admin prepare
phase changed nothing, PostgreSQL and the public product page agreed after
commit, receipt reuse was rejected, and every product value, timestamp, and
credential was restored. Compiled replay used zero model calls. The earlier
cart run fixed a general short-ID/slug binding bug; the admin expansion required
only benchmark-layout and API-gate corrections, not a compiler change. The
installed frontend API was visible, but no backend/admin API provider was
installed, so this specific edit was not task-complete through the configured
API surface. The admin capability report is
[`nopcommerce-admin-local-capability.json`](bench/runs/2026-09-05/nopcommerce-admin-local-capability.json);
use a first-party API whenever it is configured and task-complete.

The API-first negative control also passed: for public repository metadata on
GitHub, the benchmark selected the documented REST endpoint and invoked the UI
compiler zero times. Clapping Hands is the fallback for a missing or
task-incomplete API, not a reason to ignore a good first-party integration.

Restart Codex after adding the server so these tools are discovered:

- `clapping_hands_compile_dom`
- `clapping_hands_compile_form`
- `clapping_hands_list`
- `clapping_hands_run`
- `clapping_hands_auth_open`
- `clapping_hands_commit`
- generated `clapping_hands_do_<action>` tools with plan-specific input schemas
- `facebook_marketplace_auth_open`
- `facebook_marketplace_auth_status`
- `facebook_marketplace_compilation_status`
- `facebook_marketplace_search`

Authentication happens manually inside the dedicated Chrome profile. Clapping
Hands never accepts a Facebook password or persists/exports session cookies,
CSRF values, request bodies, or response bodies in compiled plans and reports.

The network path is promoted only after two demonstrations and two successful
shadow comparisons. Inputs must vary when the workflow has inputs; a
zero-argument workflow instead requires two independent successful shadows.
Facebook server-renders the first search page
and exposes an opaque cursor only when pagination begins, so its stable path
performs one deterministic navigation and one scroll to obtain fresh first-page
results and a current cursor, then compiles the remaining pagination into
authenticated network calls. This removes repeated UI scrolling and all model
calls while reporting the bootstrap explicitly. Sites whose network operation
accepts a null initial cursor can use the zero-navigation warm path proven by
the controlled fixture.
