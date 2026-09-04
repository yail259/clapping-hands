# Representative benchmark corpus

The benchmark starts broad, then narrows by workflow architecture, policy,
repeatability, and whether the result teaches us something not already covered.
A benchmark label never grants permission to automate a site.

## Broad candidate inventory

| Family | Candidates considered | What they exercise | Disposition |
| --- | --- | --- | --- |
| Purpose-built browser test apps | SauceDemo, The Internet, UI Testing Playground, DemoQA, Automation Exercise, TodoMVC | dynamic IDs, SPA state, login, AJAX, modals, multiple windows, carts, forms | prefer SauceDemo + The Internet; keep UI Testing Playground as a drift reserve |
| Real public information services | GOV.UK calculators, Get Information about Schools (GIAS), public library/catalogue search, weather and transport planners | server forms, pagination, slow production HTML, real drift | GIAS selected; no more GOV.UK until the daily budget resets; API-first services become controls |
| User-owned hosted workflows | an owned Google Form, an owned WordPress site, an owned Shopify development store | hosted auth, multi-step forms, drafts, submissions | owned Google Form selected; no third-party data or users |
| Isolated full applications | WordPress Playground, self-hosted osTicket, self-hosted InvoicePlane, self-hosted nopCommerce | admin UI, iframes, CRUD, uploads, rich editors, effect lifecycle | WordPress Playground + osTicket selected; InvoicePlane reserve |
| API-first negative controls | Hacker News, MediaWiki/Wikipedia, Open Library, nopCommerce with its Web API plugin, GitHub | prove the product recognizes when an official API is the better answer | nopCommerce selected as the primary control; HN and Open Library are cheap secondary controls |
| High-mindshare consumer sites | Facebook Marketplace, Craigslist, Airbnb, Amazon, LinkedIn, Yahoo, Gumtree | authenticated search, opaque APIs, anti-automation and policy constraints | Marketplace remains an operator-owned dogfood case; do not add the others without explicit permission and policy clearance |

The purpose-built choices are not toy substitutes for the whole corpus. They
give repeatable coverage of browser pathologies without burdening unrelated
production services. The Internet explicitly describes itself as an example
application for automated acceptance tests, and Sauce Labs' own Selenium docs
use SauceDemo/Swag Labs for an automated login example.

## Narrow representative sample

| Site | Ownership / policy basis | Archetype | Representative tasks | Expected compiler path | Role |
| --- | --- | --- | --- | --- | --- |
| Controlled local fixture | repository-owned | SPA + JSON fetch | search with varied inputs; response drift; multi-tab request | learned DOM → shadowed JSON → network; forced fallback | development |
| The Internet | purpose-built automation app | hostile/dynamic DOM | dynamic controls, delayed loading, multiple windows, dropdown/checkbox | learned DOM | development |
| SauceDemo | public test app used in Sauce Labs automation documentation | authenticated SPA commerce | login handoff, filter inventory, add cart, mock checkout | DOM; prepare/commit for checkout | development |
| GIAS | policy allows transient low-volume automation resembling normal browsing; bulk use must use downloads | real production server UI | one bounded establishment search with no pagination crawl | HTML form request | development, strict traffic budget |
| WordPress Playground | official isolated browser sandbox intended for experimenting and testing | iframe + admin CRUD | create draft, edit title, explicitly publish | DOM; prepare/commit | unseen holdout |
| Owned Google Form | form owned by the benchmark operator | hosted multi-step submission | vary answers, prepare, submit once, independently verify response | form/DOM; prepare/commit | unseen holdout |
| Self-hosted osTicket | repository-controlled installation | authenticated legacy app | search ticket; create ticket; add internal test reply | form/DOM; prepare/commit | unseen holdout |
| nopCommerce with Web API | self-hosted and controlled | API-first commerce | product search and cart via UI versus documented API | negative control: recommend/use API | control |

Why these eight: together they cover server-rendered forms, SPAs, AJAX/JSON,
auth persistence, dynamic DOM, multi-window behavior, iframes, reversible edits,
externally visible commits, and the crucial “do not compile the UI when a good
API exists” decision. InvoicePlane is the first reserve if osTicket proves too
similar to the form cohort.

## Claim gates

The denominator is **declared tasks in the representative corpus**, not “all
websites on the internet.” Public copy may say “works on 80–90% of our
representative workflow corpus” only after:

- at least 20 frozen tasks across all eight rows;
- at least 80% end-to-end success on unseen holdout tasks, with the exact task
  result independently checked;
- zero false-success results and zero duplicate commits;
- at least two varied demonstrations and two distinct successful shadows before
  any network plan is called stable;
- failures classified as compiler defects, policy/auth blocks, or explicitly
  unsupported browser capabilities;
- warm timing distributions rather than one-off timings (local/test apps:
  minimum 20 runs; production services: a separately approved low-volume
  budget); and
- every published speed row naming its engine, request/navigation counts,
  sample size, p50, p95, and correctness rate.

Current known unsupported or separately gated cases include CAPTCHA solving,
anti-bot bypass, cross-origin workflows not declared in advance, arbitrary file
uploads, canvas-only controls, downloads, WebAuthn automation, and workflows
whose only success signal cannot be independently observed.

## Source notes

- [The Internet](https://github.com/saucelabs/the-internet) is published as an
  example application for automated acceptance tests.
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
