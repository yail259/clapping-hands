# ADR 0002: Marketplace network promotion and authentication gates

**Status:** accepted for the prototype

## Context

The first Marketplace implementation used deterministic navigation, scrolling,
and DOM extraction. It made zero model calls, but it did not compile UI work into
network requests. Stagehand's action cache is not involved in that path and is
not available for a local-browser session.

The original Webpipe specification is historical input rather than current
authority. Its conservative promotion rules are retained here: read-only only,
multiple demonstrations, shadow validation, no persisted authentication
material, and a browser fallback.

## Decision

Use Playwright Core as the deterministic browser/network driver attached to the
same dedicated Chrome session that Stagehand can use for learning. Stagehand
remains behind a replaceable `BrowserLearner` boundary and does not define the
persisted action format.

For `facebook_marketplace_search`, record GraphQL/fetch exchanges during DOM
demonstrations and compile only safe structure:

- origin, method, endpoint path, and operation identity;
- JSON variable paths for query, cursor, and optional radius inputs;
- response paths and listing-field mappings;
- version, validation rules, and hashed evidence identifiers.

Cookies, authorization headers, CSRF values, request bodies, response bodies,
account identifiers, and dynamic data are never written to a plan or normal log.
At runtime, the browser context supplies cookies and an in-memory request
captured from the current page supplies rotating request fields.

Promotion requires two distinct demonstrated inputs and two successful
read-only shadow comparisons. A promoted plan keeps the DOM implementation as a
fallback. Validation failure records degradation and never returns a network
result as successful.

Authentication is an explicit state (`authenticated`, `required`,
`checkpoint`, or `unknown`). A dedicated profile has one writer, strict local
permissions, a deterministic auth probe, a headed human handoff, and a restart
test. Clapping Hands does not accept a Facebook password or attempt to solve a
challenge.

## Acceptance criteria

### Controlled fixture

- A persistent profile remains authenticated after a clean browser restart.
- A second process cannot concurrently acquire the same profile.
- Two different UI searches produce a portable candidate plan.
- Two shadow replays meet the configured typed-listing ID overlap threshold.
  A pagination cap may leave the replay incomplete without invalidating the
  observed-window equivalence; the result must still report `complete: false`.
- The promoted warm path performs no navigation, scrolling, or model call.
- Rotating CSRF data is taken from a fresh in-memory request, not the plan.
- Intentional response-shape drift fails validation and invokes the DOM fallback.
- Serialized plans and logs contain none of the fixture's cookie, CSRF, or
  authorization values.

### Facebook Marketplace dogfood

- Manual login is detected as a structured auth state.
- A clean close/relaunch preserves login; otherwise setup fails visibly.
- Two distinct authenticated DOM demonstrations and shadow calls are required
  before promotion.
- A warm promoted search returns fresh typed results with zero model calls.
- Three warm runs, each with an explicit three-page result budget, have a median
  latency below 3 seconds and are at least twice as fast as the median
  demonstrated DOM path. If Facebook latency prevents this threshold, the
  measured result is reported rather than relaxed.
- Completeness reflects server pagination and configured caps; it is never
  inferred from a plausible-looking result count.
- Restart bootstrap, execution level, latency, plan version, validation,
  fallback reason, and model-call count are present in dogfood evidence.
- No cookie, authorization header, CSRF token, or raw request body appears in
  persisted plans, reports, MCP output, or stdout/stderr.

## Consequences

The controlled fixture proves a fully network-native warm path when the first
request accepts a null cursor. Facebook does not: it server-renders the first
page and exposes an opaque cursor only after pagination begins. Its promoted
path therefore retains one deterministic navigation and one scroll, then
compiles away the remaining repeated UI scrolling while staying bound to the
user's browser identity. Facebook can expire or challenge sessions, so
occasional human reauthentication remains an explicit product state rather
than a bug hidden by retries.
