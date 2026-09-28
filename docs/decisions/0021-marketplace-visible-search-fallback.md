# Visible Marketplace cards after compiled HTML misses them

On 28 September 2026, the restricted CH MCP returned `search-unverified` for
`Canon EOS 1V 50mm 1.4`. A controlled read in the same saved CH profile then
loaded the exact Sydney/100 km/last-24-hours/newest-first search URL with HTTP
200. Its rendered DOM had 24 listing anchors and visible listing cards. This
was not a verified empty search. The saved HTML compiler either missed the
client-rendered cards or rejected their shape; this observation alone does not
distinguish those causes. The browser was closed and profile ownership was
released after the check.

An initial candidate still returned `search-unverified` on the authenticated
query. The document response matched the requested URL exactly, but React
rewrote the page URL without changing its origin, path, query, 100 km radius,
newest sort, or last-24-hours filter. One of 24 visible anchors also failed the
strict location/price parser. Requiring byte-for-byte current URL equality and
all 24 cards to parse therefore rejected a useful, bounded result.

When the compiled search fails or returns no usable cards, CH now opens the
exact search URL in the same session. It requires an exact requested HTTP 200
document response, no redirect, an auth check, and the same five search filter
values in the current page URL. It uses the existing visible-card label parser
but admits only individually verified same-origin item URLs, prices and
locations. If any of the 1–24 anchors is rejected or duplicated, it returns
`status: partial`, with `visibleCount` and `rejectedCount`; it never labels the
subset `complete`. If no card verifies, it retains `search-unverified` or an
access failure. It does not call a zero-card page an empty market. The fallback
is read-only and invokes no model.

The revised candidate must be checked on an authenticated CH profile before
deployment.
An anonymous temporary profile showed zero Marketplace cards for the same URL,
which does not validate authenticated fallback behavior. No latency gain is
claimed; fallback adds a browser navigation only to searches whose compiled
reader failed.
