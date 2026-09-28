# ADR 0013 — Structured page replay anchored to visible content

Status: implemented in development, 2026-09-24. Facebook Marketplace is local
dogfood rather than a general reliability claim.

Repeated listing reads need several fresh values from one page, including text
revealed by a safe “See more” click. A global CSS selector and element index
matched two training listings but read sidebar text on an unseen listing when
Facebook changed preceding content. A wrapping price element matched training
prices but included the crossed-out price on a discounted listing.

Structured page replay now records a flat object of required string fields. It
can bind one string input into the observed same-origin URL. Field and expansion
selectors may be scoped to a unique visible `h1` and its observed ancestor;
replay resolves that scope again rather than trusting a global index. A field
can read its element's direct text nodes when both demonstrations support that
mode. This extracts the current price while excluding nested previous-price and
stock labels. An observed exact “See more” button-like control can be clicked;
short listings with no matching expansion proceed only when no visible exact
“See more” control remains in the bound scope. Link and submit controls remain
refused.

The compiler keeps the earlier single-string page plan readable. New plans
remain provisional until two distinct unseen caller comparisons match exactly;
any mismatch degrades the plan. Dynamic data is read from a fresh browser page
on each call. This is model-free browser replay, not browserless HTTP replay.

Marketplace dogfood: two corrected listing demonstrations compiled a plan. A
first held-out attempt exposed an error in the independent caller price reader;
after correcting that reader, two distinct held-out comparisons matched and
the plan became stable. Fresh board-game and LEGO Bookshop reads returned the
full descriptions with zero model calls and no fallback. The workflow still
depends on the page's visible heading and CSS structure; any future drift must
degrade or fall back rather than silently claim a bargain.
