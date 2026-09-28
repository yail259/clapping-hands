# ADR 0012 — Bounded browser document replay

Status: implemented in development, 2026-09-24. Marketplace validation is local
dogfood, not packaged release signoff.

Some sites serve useful search results in a top-level HTML document yet reject
the same URL from Playwright's API request client. The caller-recorded Sydney
Marketplace search exposed this: a roughly 2 MB document returned HTTP 200 in
Chrome and HTTP 400 through `context.request`. A 1 MiB HTML document evidence
limit also prevented the otherwise admissible two-example compilation.

For an already admitted same-origin `html-document` GET, replay now navigates
the exact materialized URL in a fresh owned Chrome page. It disables cache and
service-worker interception, permits only the first matching main-frame GET,
rejects redirects, blocks subresources, checks status and content type, and
closes the page. The document cap is 4 MiB across inference, plan validation,
prepared evidence and replay. The existing `html-input-values` cap stays 1 MiB.
The browser navigation is reported as one navigation and the task execution
engine is `browser-replay`. JSON resources still use their prior transport.

This path removes agent/model navigation, not the browser startup. The generated
program remains inside the bounded QuickJS worker and can only request admitted
resources. Two saved examples must match offline, then two distinct fresh inputs
must match independently observed browser results before promotion. A failure
degrades the candidate. No saved output is reused as current listing data.

Observed Marketplace result: two `lego`/`board games` demonstrations prepared
one HTML document resource. `lego technic` and `jigsaw puzzle` held-out
comparisons both matched, promoting the candidate. Subsequent searches returned
24 cards with zero model calls and about 4–5 seconds wall time on this host.
These measurements do not establish a matched-input speedup over Browser Use.
