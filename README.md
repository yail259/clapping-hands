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
the rendered result. Experimental write workflows use a separate prepare/commit
lifecycle: the first potentially effectful action and every action after it are
withheld behind an expiring receipt, journaled before execution, and never
retried after an ambiguous outcome. File selection is supported only for
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

The self-hosted osTicket holdout also failed closed during development and then
passed 3/3 on compiler checkpoint
[`e0e2f0e`](https://github.com/yail259/clapping-hands/commit/e0e2f0e):
authenticated search compiled to two validated HTML requests, while public
ticket creation and an authenticated internal note each committed exactly once
with zero compiled model calls. The failures produced general fixes for native
form submission, rich-editor synchronization, role-separated profiles, and
input-bound same-origin start URLs. This is regression evidence, not an
untouched holdout or speed result.

Three pinned, self-hosted application workflows now have qualifying warm
distributions. Each result uses 20 interleaved browser/compiled pairs after
three warmups and requires an exact result on every run:

| Application workflow | Browser p50 / p95 | Compiled p50 / p95 | Median speedup | Correctness | Browser → compiled navigations |
| --- | ---: | ---: | ---: | --- | ---: |
| **WordPress 7.1 post search** | 860.74 / 971.67 ms | 122.08 / 144.44 ms | **7.05×** | 20/20 + 20/20 | 2 → 0 |
| osTicket ticket search | 626.06 / 643.56 ms | 42.74 / 61.09 ms | **14.65×** | 20/20 + 20/20 | 2 → 0 |
| nopCommerce 4.90.6 product search | 1,437.72 / 1,901.28 ms | 68.49 / 96.80 ms | **20.99×** | 20/20 + 20/20 | 2 → 0 |

Both paths made two fresh requests per run; compilation removed browser
navigation and rendering, not network freshness. These are three real
applications and one read workflow per application—not a general website speed
claim. Raw sanitized samples are in
[`wordpress-local-performance.json`](bench/runs/2026-09-04/wordpress-local-performance.json),
[`osticket-local-performance.json`](bench/runs/2026-09-04/osticket-local-performance.json),
and [`nopcommerce-local.json`](bench/runs/2026-09-04/nopcommerce-local.json).

An untouched read-only smoke on Discourse's official demo then passed 1/1:
after demonstrations on the `general` and `tech` categories, the compiled tool
opened the unseen `support` category through Ember client routing, reached the
exact `/c/support/50` path, and used zero model calls. No shared content was
created. This is a corpus-v2 candidate capability result (`n=1`), not a speed
or 80–90% coverage claim.

A pinned, loopback-only Nextcloud 33.0.8 regression then passed 2/2: it opened
an unseen folder after a clean browser restart and uploaded one allowlisted
synthetic file through prepare/commit. Prepare created no file, commit created
exactly one, a repeated commit was rejected, and all three demonstration/test
files were removed and independently verified absent. The run exposed and
fixed a general multiple-file-input ambiguity: the compiler may now choose a
uniquely named `upload` versus `attachment` input, while anonymous or tied
candidates still fail closed. Nextcloud's documented WebDAV remains the right
integration for API-covered file tasks; this row is browser/effect-safety
evidence, not an argument to ignore it.

A pinned, loopback-only Moodle 5.2.2 regression also passed 2/2 after a clean
browser restart. A compiled read opened an unseen course/tab combination; a
compiled teacher workflow changed one synthetic student's grade through the
prepare/commit boundary. Prepare left the grade empty, commit set it exactly
once according to Moodle's server-side gradebook API, a repeated commit was
rejected, and cleanup restored all three synthetic grades to empty. Moodle's
persistent Edit mode exposed a state-machine pitfall: the plan uses an
idempotent `check` operation rather than a literal toggle click. This is
capability regression evidence, not an untouched holdout or speed result.

A pinned, loopback-only nopCommerce 4.90.6 run passed 2/2. Product search
compiled from a server-rendered form, and an add-to-cart workflow used
prepare/commit plus a PostgreSQL oracle: prepare left the cart empty, commit
created exactly one row for the unseen product, the repeated receipt was
rejected, and cleanup removed it. The run found and fixed a general input
binding bug where a short numeric ID inside a longer slug could corrupt the URL
template; longer demonstrated values are now bound first, while irreducible
ambiguity still fails closed. nopCommerce's official Web API is separately
licensed; Clapping Hands should use it whenever it is configured and
task-complete.

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
