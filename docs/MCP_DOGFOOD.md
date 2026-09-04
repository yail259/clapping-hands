# Marketplace MCP dogfood

The first Clapping Hands action is a deliberately narrow, read-only Facebook
Marketplace search. It validates the product's central claim with an awkward,
authenticated site that has no suitable buyer-search API.

## Tool

`facebook_marketplace_search` accepts a query, Marketplace location slug,
radius, and result-work budget. It launches local Chrome through Stagehand using
a dedicated, git-ignored profile and returns fresh structured listing cards.

The response includes authentication, completeness, execution level, plan
status, latency, model-call count, fallback evidence, and
`countsWhileScrolling` when the DOM path is used.
It must not describe the result as complete when Facebook has capped logged-out
results or the configured scroll limit is reached.

## Authentication

Run `npm run auth:marketplace` to open the dedicated profile, complete Facebook
login manually, and verify that the login survives a clean browser restart.
Clapping Hands does not accept a Facebook password and does not persist or print
cookies, authorization headers, CSRF values, or raw request bodies.

For the repository dogfood loop, run `npm run build` and then
`npm run dogfood:marketplace`. It performs distinct authenticated DOM
demonstrations, read-only shadow validation, promotion, warm network replay, and
a restart check. Evidence is stored under the git-ignored `.data` directory.

The network plan is portable and contains only safe request/response structure.
Dynamic credentials and anti-replay values are supplied from the current
browser session in memory. On drift, Clapping Hands records the failure and
falls back to fresh DOM extraction.

Facebook's first search page is server-rendered and its pagination operation
rejects a null cursor. The promoted path therefore uses one navigation and one
scroll to collect fresh initial cards and a valid cursor, then fetches the
remaining configured pages directly inside the authenticated page. Execution
evidence labels this honestly as `network-bootstrap`.

## Scope

This dogfood action may search and read listings. It must not message sellers,
save listings, make offers, purchase items, solve CAPTCHAs, bypass access controls,
or conceal automation. Use remains subject to Facebook's terms and enforcement.
