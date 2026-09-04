# Representative benchmark corpus

The benchmark starts broad, then narrows by workflow architecture, policy,
repeatability, and whether the result teaches us something not already covered.
A benchmark label never grants permission to automate a site.

## Broad candidate inventory

| Family | Candidates considered | What they exercise | Disposition |
| --- | --- | --- | --- |
| Purpose-built browser test apps | SauceDemo, The Internet, UI Testing Playground, DemoQA, Automation Exercise, TodoMVC | dynamic IDs, open Shadow DOM, SPA state, login, AJAX, dialogs, multiple windows, files, carts, forms | prefer SauceDemo + The Internet; keep UI Testing Playground and TodoMVC as drift reserves |
| Real public information services | GOV.UK calculators, Get Information about Schools (GIAS), public library/catalogue search, weather and transport planners | server forms, pagination, slow production HTML, real drift | GIAS selected; no more GOV.UK until the daily budget resets; API-first services become controls |
| User-owned hosted workflows | an owned Google Form, an owned WordPress site, an owned Shopify development store | hosted auth, multi-step forms, drafts, submissions | owned Google Form selected; no third-party data or users |
| Isolated full applications | WordPress Playground, self-hosted osTicket, self-hosted InvoicePlane, self-hosted nopCommerce, self-hosted OrangeHRM, self-hosted OWASP Juice Shop | admin UI, iframes, CRUD, uploads, rich editors, effect lifecycle, modern Angular/Vue SPAs | WordPress Playground + osTicket selected; OrangeHRM and InvoicePlane are reserves; Juice Shop is local-only |
| API-first negative controls | Hacker News, MediaWiki/Wikipedia, Open Library, nopCommerce with its Web API plugin, GitHub | prove the product recognizes when an official API is the better answer | nopCommerce selected as the primary control; HN and Open Library are cheap secondary controls |
| High-mindshare consumer sites | Facebook Marketplace, Craigslist, Airbnb, Amazon, LinkedIn, Yahoo, Gumtree | authenticated search, opaque APIs, anti-automation and policy constraints | Marketplace remains an operator-owned dogfood case; do not add the others without explicit permission and policy clearance |

The purpose-built choices are not toy substitutes for the whole corpus. They
give repeatable coverage of browser pathologies without burdening unrelated
production services. The Internet explicitly describes itself as an example
application for automated acceptance tests and includes file transfer, Shadow
DOM, infinite scroll, dialogs, and multiple windows. UI Testing Playground is
an explicit automation-practice site covering dynamic IDs, AJAX, client delay,
and Shadow DOM. Sauce Labs' own Selenium docs use SauceDemo/Swag Labs for an
automated login example. TodoMVC is useful as a framework-parity reserve, not as
a realistic application row.

## Narrow representative sample

The machine-readable corpus is
[`bench/corpus-v1.json`](../bench/corpus-v1.json). It declares 32 tasks up
front; `npm run benchmark:corpus` verifies the minimum application, holdout,
architecture, effect, policy, and traffic-budget coverage. It was frozen on
2026-09-04 to compiler Git SHA
`054bf03d80bf5401e26267e2a7c6d59931670876`, before any holdout task was run.

| Site | Ownership / policy basis | Archetype | Representative tasks | Expected compiler path | Role |
| --- | --- | --- | --- | --- | --- |
| Controlled local fixture | repository-owned | SPA + JSON fetch | search with varied inputs; response drift; multi-tab request | learned DOM → shadowed JSON → network; forced fallback | development |
| The Internet | purpose-built automation app | hostile/dynamic DOM | dynamic controls, delayed loading, multiple windows, open Shadow DOM, bounded infinite scroll, file upload/download, browser confirm | learned DOM; artifact boundary; prepare/commit | development |
| SauceDemo | public test app used in Sauce Labs automation documentation | authenticated SPA commerce | login handoff, filter inventory, add cart, mock checkout | DOM; prepare/commit for checkout | development |
| GIAS | policy allows transient low-volume automation resembling normal browsing; bulk use must use downloads | real production hybrid UI | one bounded establishment search with no pagination crawl | learned DOM → captured request candidate → DOM fallback | development, strict traffic budget |
| WordPress Playground | official isolated browser sandbox intended for experimenting and testing | iframe + admin CRUD | create draft, edit title, explicitly publish | DOM; prepare/commit | unseen holdout |
| Owned Google Form | form owned by the benchmark operator | hosted multi-step submission | vary answers, prepare, submit once, independently verify response | form/DOM; prepare/commit | unseen holdout |
| Self-hosted osTicket | repository-controlled installation | authenticated legacy app | search ticket; create ticket; add internal test reply | form/DOM; prepare/commit | unseen holdout |
| nopCommerce with Web API | self-hosted and controlled | API-first commerce | product search and cart via UI versus documented API | negative control: recommend/use API | control |

Why these eight: together they cover server-rendered forms, SPAs, AJAX/JSON,
auth persistence, dynamic DOM, open Shadow DOM, multi-window behavior, iframes,
bounded infinite scroll, file transfer, browser dialogs, reversible edits,
externally visible commits, and the crucial “do not compile the UI when a good
API exists” decision. InvoicePlane is the first reserve if osTicket proves too
similar to the form cohort; UI Testing Playground is the first reserve for an
independent browser-pathology implementation.

The initial read-only inspection changed the GIAS classification: choosing a
search mode reveals a JavaScript-controlled ARIA combobox and autocomplete, so
it is a hybrid DOM/network task rather than the plain HTML-form case originally
assumed. SauceDemo's inventory sort is client-only and therefore provides a
useful DOM-only result rather than a forced network-speedup win. The Internet's
delayed element appears about five seconds after the final click, which is now
an explicit stale-output regression case for the runtime.

## Claim gates

The denominator is **declared tasks in the representative corpus**, not “all
websites on the internet.” Public copy may say “works on 80–90% of our
representative workflow corpus” only after:

- at least 20 frozen tasks across all eight rows;
- at least 80% end-to-end success on unseen holdout tasks, with the exact task
  result independently checked;
- zero false-success results and zero duplicate commits;
- at least two varied demonstrations and two distinct-input successful shadows
  before any parameterized network plan is called stable; zero-argument tools
  require two independent successful shadows;
- failures classified as compiler defects, policy/auth blocks, or explicitly
  unsupported browser capabilities;
- warm timing distributions rather than one-off timings (local/test apps:
  minimum 20 runs; production services: a separately approved low-volume
  budget); and
- every published speed row naming its engine, request/navigation counts,
  sample size, p50, p95, and correctness rate.

Current known unsupported or separately gated cases include CAPTCHA solving,
anti-bot bypass, cross-origin workflows not declared in advance, arbitrary file
access outside an operator-allowlisted upload directory, canvas-only controls,
cross-origin downloads, WebAuthn automation, and workflows whose only success
signal cannot be independently observed. Controlled upload replay now exists
behind prepare/commit; same-origin downloads are returned as quarantined,
size-bounded, hashed artifacts.

## Competitive baseline

[Unbrowse](https://github.com/unbrowse-ai/unbrowse) is the direct comparison,
not another site row. It already learns first-party routes, replays cached calls,
keeps local credentials, and exposes CLI/MCP/SDK interfaces. Its paper reports a
94-domain warmed-route benchmark; its current public benchmark notes separately
report a 50% result on a harder 19-probe product corpus. We should reproduce a
small common corpus against both products rather than compare those unlike
numbers. Clapping Hands does not get novelty credit for route caching; the
comparison should focus on private/local compilation, UI-only workflows,
effect boundaries, validation, and fallback behavior.

## Source notes

- [The Internet](https://github.com/saucelabs/the-internet) is published as an
  example application for automated acceptance tests.
- [UI Testing Playground](https://www.uitestingplayground.com/) explicitly
  exists for practicing automation against modern UI pitfalls.
- [TodoMVC](https://github.com/tastejs/todomvc) supplies the same interaction
  contract across current React, Vue, Angular, Svelte, Preact, Lit, and Redux
  implementations.
- [OWASP Juice Shop](https://github.com/juice-shop/juice-shop) is a realistic
  Angular/Express/SQLite application that can be run locally; its public demo is
  only a deployment-test instance and is not our benchmark target.
- [OrangeHRM](https://github.com/orangehrm/orangehrm) is a self-hostable
  PHP/Vue HR application; use a local seeded instance, not security testing of
  its hosted demo.
- [Sauce Labs' Selenium documentation](https://docs.saucelabs.com/web-apps/automated-testing/selenium/)
  automates login to its Swag Labs demo.
- [GIAS acceptable use](https://www.get-information-schools.service.gov.uk/AcceptableUsePolicy)
  permits only transient, low-volume automation resembling normal browsing and
  directs bulk/frequent access to downloads or approved APIs.
- [WordPress Playground](https://developer.wordpress.org/playground/) is an
  isolated in-browser WordPress environment intended for building,
  experimenting, and testing.
- The [Google Forms REST reference](https://developers.google.com/workspace/forms/api/reference/rest)
  exposes response `get` and `list`, but no REST method to submit a new response;
  the test form must be owned by the operator.
- The [osTicket ticket API](https://docs.osticket.com/en/latest/Developer%20Documentation/API/Tickets.html)
  supports creation only, not modification or deletion, making controlled UI
  actions a useful partial-API case.
- [nopCommerce documents](https://docs.nopcommerce.com/en/developer/web-api/index.html)
  broad frontend and backend APIs plus a developer test mode. It should be a
  negative control, not a UI-compilation victory.
- [Hacker News](https://github.com/HackerNews/API),
  [MediaWiki](https://www.mediawiki.org/wiki/API%3AREST_API/en), and
  [Open Library](https://openlibrary.org/developers/api) all publish APIs and
  remain secondary API-first controls.
- [Unbrowse's repository](https://github.com/unbrowse-ai/unbrowse),
  [paper](https://arxiv.org/abs/2604.00694), and
  [current benchmark notes](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/benchmarks.md)
  define the competitor baseline and explain why its 94-domain and current
  19-probe numbers must not be conflated.
