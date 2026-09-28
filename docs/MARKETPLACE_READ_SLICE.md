# Marketplace read pilot

This source branch adds a narrow, read-only Sydney Marketplace pilot to the
Clapping Hands alpha. Its general additions are caller-recorded demonstrations,
structured page replay, and learned inline JSON projections. The Marketplace
adapter uses two independently validated saved plans to return fresh search
cards and listing text. It also offers checked visible-page fallback, bounded
scroll continuation, and one product-photo read. The adapter runs in the
owner-authorized Clapping Hands browser; it does not export cookies or browser
control to a sourcing agent.

This branch does not include the separate restricted sourcing MCP service,
Gumtree reader, local service operator, Sydney resale inventory, or any saved
browser profile. Those are separate integration and owner-local concerns.

## Owner-local plans

The Marketplace methods require two stable tasks in the configured
`CLAPPING_HANDS_DATA_DIR`:

| Task | Purpose | Stable plan |
| --- | --- | --- |
| `marketplace_fresh_search_cards_v1` | First 24 Sydney cards, last 24 hours, newest first, within 100 km | JavaScript browser replay |
| `marketplace_listing_details_v7` | Exact item title, displayed price, condition, full description | Learned inline document JSON projection |

The saved tasks are not in Git, and a fresh checkout has no plans or Facebook
login. Existing owner-local plans can be used only with the matching profile
and explicit configuration. The source-level scripts below show how this pilot
was trained; they do not promise that a future Facebook page layout will pass.
Do not copy account profiles or captured response bodies into this repository.

With a dedicated owner-authorized profile and data directory configured, the
search demonstration sequence is:

```sh
pnpm exec tsx scripts/dogfood-marketplace-fresh-caller.ts
pnpm exec tsx scripts/dogfood-marketplace-fresh-submit.ts
pnpm exec tsx scripts/dogfood-marketplace-fresh-caller.ts --validate
```

The first step records two varied caller observations, the second submits the
bounded candidate in `scripts/dogfood-marketplace-candidate.js`, and the last
checks two different unseen searches before promoting it. Each step can refuse
the current page or plan state. Use a new data directory for a new training run;
the scripts intentionally refuse to replace an existing plan silently.

For listing text, use two distinct item IDs for training and two different
held-out IDs for the visible-page comparison:

```sh
pnpm exec tsx scripts/dogfood-marketplace-document-record.ts ITEM_1 ITEM_2
pnpm exec tsx scripts/dogfood-marketplace-document-validate.ts ITEM_3 ITEM_4
```

`ITEM_1` through `ITEM_4` are numeric Marketplace item IDs from current,
owner-authorized listings. The validation script reads the full description in
the visible page; agreement with another parser of the same JSON is not an
independent check. A failed comparison must leave the candidate unpromoted.

## Current read contract

- `TaskRuntime.marketplaceSearchCards(query, limit, fastSearch, age, sort)`
  returns current cards. The stable compiled route covers at most 24 cards with
  the one-day/newest/100 km scope. Other age or sort requests, and limits 25–48,
  use a freshly checked visible page. The larger limit uses at most four UI
  scrolls and may return `partial`; it does not prove inventory exhaustion.
- `TaskRuntime.marketplaceReadDetails(urls, streamDetails)` accepts one to eight
  exact Facebook item URLs. A copied item URL may omit the trailing slash or
  contain sharing query parameters; it is canonicalized by item ID. Each row
  returns `complete`, `incomplete`, `unavailable`, `blocked`, or
  `auth-required`. `complete` covers four text fields, not photos, tested
  condition, seller availability, or a transaction price.
- `TaskRuntime.marketplaceReadPhoto(url, position)` inspects one bounded
  product-photo crop within the same authenticated browser. The image is
  seller-provided evidence; model identification and condition still need
  review.

No 10× end-to-end speedup or general Facebook coverage has been established.
Previously observed warmed searches varied with page state, and the detail
path still needs Chrome navigation. The guarded route-response candidate is
not promoted for ordinary reads. Keep browser fallback and an independent
visible comparison before promoting any new network path.
