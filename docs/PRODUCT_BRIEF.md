# Product brief

## One-line promise

Turn a browser workflow on a site with no usable API into a fast, typed tool.

## Initial user

A developer or technically capable agent user who:

- already has legitimate access to a website;
- needs the same task or outcome repeatedly;
- cannot get it from a suitable public API;
- needs structured, current results or a precisely verified remote effect rather
  than a screenshot or prose answer;
- finds full browser-agent execution too slow, costly, or fragile.

"No usable API" includes sites with private, undocumented endpoints when those
endpoints are only available inside the user's authenticated browser session.

## Acute use cases

- Re-run a saved marketplace search and return newly listed items.
- Monitor a supplier catalogue for inventory or price changes.
- Retrieve invoices or status data from a customer portal.
- Query a legacy CRM or internal administrative application.
- Normalize results from a government or property-search portal.
- Create or update a draft in a portal whose UI is its only supported interface.
- Upload a document, submit a seeded test record, or approve a controlled
  workflow with an explicit commit confirmation.

The first demonstrator may use a read-only marketplace search, subject to the
site's terms and the user's authorization. Product tests should also use a
controlled fixture site so correctness does not depend on a third party.

## Product horizon

The product promise is broader than extraction: compile a demonstrated UI
workflow into a typed action. Actions may read data, make a reversible change,
upload or download a file, or cross an explicitly confirmed commit boundary.

That does not mean arbitrary autonomous execution. Clapping Hands classifies
each action as `read`, `write`, or `commit`. Writes require a prepared intent,
effect journal, independent postcondition, and reset/reconciliation strategy.
Commits such as send, publish, approve, purchase, delete, or final submit require
explicit confirmation and must never retry automatically after an ambiguous
outcome.

The current prototype and first release remain read-first while that safety
model is implemented and tested. Public claims must distinguish the product
direction from capabilities verified today.

## User experience

The smallest coherent flow is:

1. The user opens or attaches an authenticated browser session.
2. The user describes a repeated task and the desired fields.
3. Stagehand performs the task once and gathers evidence.
4. The compiler proposes a typed action with inputs and outputs.
5. The user confirms the action.
6. Later calls return fresh structured results through a CLI, SDK, HTTP, or MCP.
7. When the fast path fails validation, the system falls back and repairs it.

Example:

```text
Create a tool called search_marketplace_cars.
Inputs: make, model, maximum_price, radius_km.
Return: title, price, location, listing_url, image_url, posted_at.
```

## MVP success criteria

- One repeated, authenticated, read-only workflow can be learned from a prompt.
- The resulting action has explicit input and output schemas.
- A warm run avoids model calls when the page has not materially changed.
- Every result is freshly extracted; cached plans never masquerade as cached data.
- Failures produce inspectable evidence and can fall back to semantic execution.
- The action is callable as an MCP tool and from a local TypeScript API.
- An evaluation suite measures success rate, latency, model calls, and fallback rate.

The next milestone adds reversible-write and controlled-commit fixtures before
any effectful network promotion is enabled.

## Non-goals for the first release

- Compiling an entire website automatically
- Anonymous, high-volume crawling
- Defeating CAPTCHAs, rate limits, or access controls
- Autonomous purchases, messages, deletes, or other consequential writes
- Replacing a good first-party API
- Supporting every browser engine or automation backend
- Serving site owners as a separate product category

## Positioning

Avoid: "a wrapper around Stagehand" or "another browser agent."

Use:

> Stagehand learns the browser workflow. Clapping Hands turns it into a durable,
> typed tool and progressively optimizes away the expensive parts.

Potential Show HN title:

> Show HN: Clapping Hands – Compile browser workflows into APIs for sites that don't have one
