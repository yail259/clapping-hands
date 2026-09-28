# Marketplace photo evidence stays separate from compiled text details

## Context

The exact-page audit of Marketplace item `4493014300952048` found correct
title, ask, condition, and description in both detail readers, but its last
photo showed the hardware specification that ruled out the lead. A `complete`
text row therefore does not mean a listing is fully assessed.

## Decision

Keep the fast, saved text reader. Label every detail row as
`dataScope: listing-text-only` and `media.status: not-inspected`. Add a separate
read-only photo tool for one exact item URL and one bounded photo position.
The tool opens the same CH-owned, leased browser profile, verifies the exact
item page and numbered photo control, waits for the selected product image to
load, and returns one JPEG image block of that image element. It returns typed
non-success when the page, position, image, or unobscured crop is uncertain.

The tool does not return a browser endpoint, cookie, profile path, or image
source URL. It caps the JPEG at 450,000 bytes because the Restless MCP broker
limits the full serialized response to 1 MiB. The image remains seller-posted
evidence, not proof that the item currently has the photographed components.

## Integration and limits

Restless must explicitly allowlist and validate the new tool, then install a
new connection pin for a future Attempt. Its native MCP image path needs a
live actor smoke; the JSON CLI facade is unsuitable for visual review. Photo
pixels intentionally become visible to that agent and may be sent to its model.
The CH browser, authentication material, and signed CDN URLs remain local.
Carousel controls and image loading can change on Facebook; a live signed-in
smoke on an exact item is required before relying on the new result.
