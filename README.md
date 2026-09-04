# Clapping Hands

**Product:** Clapping Hands 👏  
**Status:** working local MCP prototype

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
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — proposed system boundaries
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — staged path to a convincing prototype
- [`docs/decisions/0001-stagehand.md`](docs/decisions/0001-stagehand.md) — why Stagehand is a replaceable dependency
- [`docs/decisions/0002-marketplace-network-promotion.md`](docs/decisions/0002-marketplace-network-promotion.md) — auth, promotion gates, and measurable acceptance criteria
- [`docs/WEBPIPE_SPEC_v0.2.md`](docs/WEBPIPE_SPEC_v0.2.md) — preserved original proposal

## Naming

"Clapping Hands" is the internal and public product name. Use the full name in
public; do not shorten it to `CLAP`, which is crowded in software. The preferred
project, package, and domain stem is `clapping-hands` or `clappinghands` as the
context requires. No trademark or domain clearance has been completed.

## Local prototype

```sh
npm install
npm test
npm run build
npm run auth:marketplace
npm run dogfood:marketplace
codex mcp add clapping-hands \
  --env CLAPPING_HANDS_PROFILE_DIR="$PWD/.data/browser-profile" \
  --env CLAPPING_HANDS_HEADLESS=false \
  -- "$(command -v node)" "$PWD/dist/src/server.js"
```

`auth:marketplace` opens the dedicated profile for a manual Facebook login,
closes it, and proves the authenticated state survives a clean restart.
`dogfood:marketplace` then performs two DOM demonstrations, two read-only
network shadows, three warm runs, and a restart run. Its sanitized report is
written under `.data/`.

Restart Codex after adding the server so these tools are discovered:

- `facebook_marketplace_auth_open`
- `facebook_marketplace_auth_status`
- `facebook_marketplace_compilation_status`
- `facebook_marketplace_search`

Authentication happens manually inside the dedicated Chrome profile. Clapping
Hands never accepts a Facebook password or persists/exports session cookies,
CSRF values, request bodies, or response bodies in compiled plans and reports.

The network path is promoted only after two distinct demonstrations and two
successful shadow comparisons. Facebook server-renders the first search page
and exposes an opaque cursor only when pagination begins, so its stable path
performs one deterministic navigation and one scroll to obtain fresh first-page
results and a current cursor, then compiles the remaining pagination into
authenticated network calls. This removes repeated UI scrolling and all model
calls while reporting the bootstrap explicitly. Sites whose network operation
accepts a null initial cursor can use the zero-navigation warm path proven by
the controlled fixture.
