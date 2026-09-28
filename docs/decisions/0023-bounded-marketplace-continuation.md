# 0023: Bounded visible Marketplace continuation

## Decision

Keep the default one-day, newest-first search at 24 cards and keep its current
compiled route. A caller can opt into 25–48 cards through the same search tool.
That request opens the exact search URL in CH's authenticated browser, verifies
the page and filters, and collects distinct, checked card labels over at most
four UI scrolls with a bounded wait for newly rendered anchors. It does not compile a pagination request or expose a browser
controller to the caller. A continuation that returns fewer cards than
requested is `partial` with `scroll-budget-reached`; it never claims that the
site has no more listings. Login, navigation and filter failures remain errors.

## Evidence and tradeoff

One bounded live probe saw 24
verified cards initially and 49 distinct cards after three scrolls for a
Sydney film-camera query. Several relevant film kits appeared only in the
later tranche. The existing search contract rejects more than 24 visible
anchors, so a second tranche was unreachable through the MCP tool.

The extra browser work may cost several seconds; the observed probe took
8.63 seconds total. The site can reorder or virtualize results, so the tool
deduplicates by exact item URL and describes only observed cards. It does not
promise exhaustive search, listing availability, seller identity, condition,
or a stable page cursor. Direct network pagination remains a candidate only
after separate held-out visible-page comparisons for that exact operation.

## Rollout gate

Build and type-check the isolated source, then smoke one opt-in 48-card call
against the existing CH profile while no other process owns it. Check that a
newly exposed exact URL can be read with the detail tool. A new release and
Restless MCP tool-schema pin are required before a Sydney Resale actor can use
the new limit. Keep the previous release installed until the brokered actor
call and owner handoff are verified.
