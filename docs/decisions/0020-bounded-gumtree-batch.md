# Bounded Gumtree browser batch

The Sydney sourcing MCP originally exposed one public Gumtree URL per call.
Each call launched and closed a separate Chromium session. The Facebook detail
tool already accepts up to eight exact URLs and keeps independent row outcomes.

The new `clapping_hands_gumtree_public_listings` tool accepts one to eight
distinct exact listing URLs. It validates the full batch before launching a
browser, then uses one `TaskSession` and a fresh page per URL. Pages run in input
order. One listing's access refusal or missing fields becomes a typed row and
does not erase other rows. The original single-read tool remains available and
uses the same reader for its one URL.

The Core call limit is 90 seconds. The batch stops starting page reads 50
seconds after entry. When given 2–8 URLs it closes each opened page after at
most ten seconds. A one-URL call keeps a 45-second page allowance so the
existing singular tool does not lose slower reads that used to succeed.
Remaining URLs receive `incomplete/batch-deadline-exceeded` rows in input order.
The rest of the time is reserved for browser shutdown, whose verified profile
release takes precedence over a latency promise. A browser startup or page
creation failure is a whole-tool error because session ownership is uncertain;
per-row outcomes begin only after a page opens.

This only reduces browser startup overhead and makes multi-listing results
easier for agents to handle. It does not compile Gumtree, bypass its access
controls, or make the public browser authenticated. A live Gumtree page returned
HTTP 403 through the existing CH MCP on 28 September 2026. That row must remain
`blocked`, and no listing fields may be inferred from older search cards or
saved reports. The owner-facing Facebook login helper and saved Facebook
profile do not apply to the separate Gumtree public profile. Whether a Gumtree
sign-in would change the site edge's 403 is unverified.
