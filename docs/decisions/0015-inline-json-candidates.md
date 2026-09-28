# 0015 — Inline document JSON as a provisional compiled source

Date: 2026-09-25

Status: integrated as an opt-in learned read path, with held-out promotion and drift degradation.

## Observation

An authenticated Facebook Marketplace listing document contains a typed listing object in an `application/json` script. The object held title, formatted price, condition attribute, full description and live/sold flags. A direct out-of-browser request, even with the browser navigation's request headers, returned HTTP 400 in a bounded probe. Browser navigation remained necessary for that document in the observed session.

The initial read-only adapter navigates in an authorized headless browser, parses the fresh main document, binds the listing object by exact item ID, and verifies title, price and condition against the visible page. It succeeded for three directly selected listings and two listings from one saved search. It is a useful dogfood path, but its Facebook-specific field names are not the general compiler design.

## Decision

Introduce a site-neutral *provisional* projection learner in `src/inline-json-projection.ts`. Given two different typed inputs, two document responses, and two independently observed string-field outputs, it:

1. Searches bounded inline JSON for an object whose scalar property equals the input in both examples.
2. Intersects field paths whose values match each demonstrated output.
3. Replaces array positions with a unique, invariant semantic selector where possible (for example, an attribute whose `attribute_name` is `Condition`). If no such selector exists, it declines that field path.
4. Emits a value-free, credential-free candidate plan. Replay locates the requested object in a fresh document and refuses missing, ambiguous or incomplete results.

This is a candidate only. Equal output from a second parser over the same inline JSON is a structural smoke check, **not independent semantic validation**. The candidate must not be advertised as stable or returned as a verified result until caller/agent observations on two held-out listings corroborate all fields, including the full description. The browser fallback and current exact typed contract remain authoritative.

## Live evidence and performance limit

Two current Marketplace documents produced a plan for `title`, `price`, `condition` and `description` without hardcoded output paths. The condition field learned a semantic array selector. Replay on a third document matched the existing document reader for all four fields. The reproducible CLI is `dogfood-marketplace-document-read.ts --infer <id1> <id2> <id3>`; it keeps HTML in memory, prints a candidate plan and structural-match flag, and does not save raw HTML or session material. Its three-detail live run took **30.24 seconds** wall time, illustrating that inference correctness alone does not improve navigation speed.

The earlier two saved caller examples cannot restore document bodies (`loadSavedJsonCapture` returned zero document exchanges for each). New in-memory demonstrations are required before wiring this compiler into the saved task lifecycle; we must not infer a source from missing evidence.

The lightweight document-only navigation returned a full document in about 2.1–3.0 seconds on two individual attempts. A two-page parallel attempt took about 8.3 seconds and was **slower** than those individual attempts; this is too small and order-sensitive to establish a concurrency effect. Browser startup and Facebook response time varied substantially. The earlier 16.8-second search-plus-two-details measurement remains the comparison baseline. No 10× speedup has been measured.

## Next gate

Wire candidate inference into caller/Browser Use evidence capture without storing raw account-bearing documents in a compiled plan; gather genuinely independent full-description outputs; shadow two new listings; then promote or degrade. Configure a working agent fallback in the authenticated session before claiming end-to-end reliability. A persistent browser session and cheaper navigation may improve warm latency, but require a paired correctness-and-time benchmark before adoption.

## 25 September follow-up

The generic plan is now compiled from two live caller demonstrations and stored on the typed task. It learns the listing URL binding and field paths without saving HTML or cookies. A new `validate-inline-json` recording first replays the candidate, then requires the caller to observe every output field on the visible page. Two different held-out item IDs must match before the plan becomes stable; replay errors and mismatches degrade it. The ordinary generated MCP tool uses a stable plan, returns `document-replay`, and retains the authorized browser session briefly for subsequent reads.

The first candidate, `marketplace_listing_details_v6`, correctly degraded when a caller observation included Facebook's trailing **See less** control in the description. We corrected the independent observer and trained `marketplace_listing_details_v7` afresh. Held-out IDs `1586546736285074` and `2733959997019280` matched all four fields, promoting v7. A live generated MCP tool read returned title, price, condition and full description on two further items in 7.24 seconds cold and 3.45 seconds warm, with zero model calls. A direct runtime search plus two details took 9.98 seconds wall time, versus the prior single 16.84-second observation. This is roughly 1.7× on unpaired small samples, not 10× evidence.

The saved search still uses browser replay. The detail plan still needs a real browser navigation; an out-of-browser direct request returned HTTP 400 in the earlier probe. A configured Browser Use learner endpoint is still absent, so compiled-path failure currently returns a classified caller-demonstration request instead of an autonomous browser recovery. Cold startup and variable Marketplace latency remain material. No reliability rate or repeatable 10× claim is established.

### Route-response probe: tempting but unverified

A card opened from search sometimes triggered `POST /ajax/route-definition/` with a roughly 133 KB response. A same-session request with its `route_url` changed returned HTTP 200 in one approximately 0.96-second attempt. That was only a transport observation: the response contained both the target ID and a description key, but those substrings were not proven to belong to one target listing. Parsing the response as newline-delimited JSON missed a large non-JSON-prefixed segment, and subsequent card opens sometimes omitted the route request entirely. A later independently checked attempt found no unique target object with all four fields. Thus there is **no validated route API acceleration** yet, and the 0.96-second figure is not a listing-read benchmark. A future candidate must parse the full response framing, bind the exact target object, prove all four fields against a fresh document/UI observation on two held-out items, and acquire per-session request state without saving tokens.

### Route framing and exact binding follow-up

The skipped segment was a pretty-printed JSON record preceded by the same `for (;;);` guard. `src/guarded-json-sequence.ts` now parses bounded guarded records by balanced JSON structure, without evaluating page code or storing response bodies. One live card-open response contained one exact target object with all four fields and matched a fresh full document. In the same authorized browser session, a browser-generated request body with only `route_url` changed returned a second exact target object; all four fields again matched its fresh document. The request body includes per-session values such as CSRF fields and must never be saved as a reusable plan.

The existing structural learner compiled four fields from those two route responses, and two further route responses matched fresh full documents. Replay times for the three subsequent requests in that run were approximately 0.58, 1.29 and 0.73 seconds; they exclude search, browser startup, seed capture, and independent verification. **This does not promote the route path.** A later independent UI check refused a held-out page whose description still displayed **See more**, and some search-card clicks produced no route request at all. The route plan needs two current full-description UI comparisons, a reliable browser-acquired seed or document fallback, and an integrated saved-task lifecycle before it can serve generated MCP reads.

The response codec now accepts these guarded JSON records in the existing generic network decoder and sanitized evidence path. The existing generic request compiler also has a process-private, single-use, five-second vault for volatile request context, but generated task resources currently reject such plans. The next implementation step is to connect a caller/Browser Use observed seed to that vault within the authorized browser session and bind the exact listing URL. Stored plans must contain placeholders rather than CSRF or session values. If the browser supplies no matching seed, the current stable document read remains the fallback. Current UI validation remains incomplete; document-to-route agreement alone cannot activate the candidate.

### Generic request plan probe

The generic compiler now discovers a whole-segment input inside a form field containing a relative URL. The saved template replaces that segment with a placeholder; it also marks observed account/session metadata as volatile context rather than constants. In a live probe, two in-browser route responses produced a `guarded-json-sequence` POST plan with one nested item binding, 22 short-lived context fields, and no retained sampled request values. The plan consumed a single-use context ticket acquired from the same authorized browser session. A direct `APIRequestContext` replay returned an HTTP 200 error payload (293 bytes) and failed structural validation. The same plan through the browser transport returned one exact, complete target object in **0.68 seconds**; its four typed fields matched a fresh full document. This measures only the replay operation, excluding browser/search setup and validation.

This is still a probe, not a promoted generated tool. The request seed was obtained by an explicit UI action, and some card opens yielded no seed. The two training route requests were programmatic replays within an authenticated browser, so they are insufficient as independent caller demonstrations. The held-out route output has document corroboration but not a current full-description visible-page comparison. Production integration must preserve those distinctions, acquire fresh context on every use, and fall back to the stable document path when any gate fails.

### Saved candidate admission

`src/route-json-learning.ts` now searches two live, in-memory caller or Browser Use recordings for a unique pair of safe guarded-route responses. It compiles the generic request with a nested item binding and short-lived context placeholders, then learns the four output paths from the demonstrated typed results. `SavedTask` can hold this **candidate** and MCP status reports it; ordinary execution still ignores it. A live in-memory smoke produced a candidate with `title`, `price`, `condition`, and `description`, 22 volatile context fields, and no sampled request values in the plan. That smoke used programmatic training outputs and proves the compiler wiring only. The next gate is recording real visible-page demonstrations and two independent held-out UI comparisons, then enabling replay with a fresh seed and document fallback.

### Caller-recording follow-up

The caller recorder now keeps completed response captures when unrelated background requests exceed the settle deadline, while recording an explicit partial-capture diagnostic. A bounded authenticated Marketplace pass captured two complete caller outputs and their matching route responses. The candidate learner originally considered only the first eight guarded responses per demonstration, which could exclude the listing route amid background traffic. It now selects responses whose request contains the demonstrated input in a whole URL path segment, and compares only the same endpoint path.

The resulting pair exposed a generic safety-rule mistake: the parser represents a relative URL as `{pathname, query}`, but the runtime-context validator treated its `query` container as an operation-changing query. The exception now applies only to that observed relative-URL container; operation identity fields inside it remain forbidden. Recompiling a **sanitized reconstruction** of the two saved caller responses yielded one candidate with four typed fields, one nested item binding, and 23 volatile context fields. This is a structural diagnostic, not live replay proof: saved evidence omits session values and cannot itself run the request. A subsequent live pass did not obtain two complete matching route responses from its current cards. Route replay is still inactive, with no new speed or reliability claim.

### Fresh caller candidate and held-out replay

A revised bounded probe discovered a current search card immediately before each recording. It obtained two complete, distinct caller demonstrations with matching route responses after seven card attempts; five produced no usable route response. The saved route candidate was inferred from those **real caller recordings**, with one listing-path binding and four typed fields. This establishes candidate admission but also shows that the route response is an unreliable seed source from card clicks in the observed session.

In a separate authorized browser session, a fresh card-open route response supplied short-lived request context. The saved candidate replayed two **different held-out listings**, each through a new in-browser request. Replay took **682 ms** and **538 ms** respectively, excluding seed acquisition, search, browser startup and verification. For each listing, title, price, condition and full description matched a fresh full document; all four values were then found in the rendered page after description expansion. A prior diagnostic replay took **649 ms** and matched the document for the first of these listings, but did not check visible fields. These checks show the candidate can work on two held-outs, yet they do not constitute persisted promotion evidence or an integrated MCP route workflow. The production path still uses document replay; total search-to-detail speed and fallback rate have not been remeasured for route replay.
