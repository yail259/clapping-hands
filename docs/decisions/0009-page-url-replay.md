# 0009 — Learn narrow page URL/text replay independently of the agent

Status: accepted for read-only alpha.3.

Browser Use remains responsible for first-use task completion. After a successful
run, the host may passively observe the final page URL and visible text matching
the caller's string output. Two varied examples may produce a bounded URL path
or query binding and stable selector/position. This is a compiled executor, not
another navigation controller. It covers one string input and string output;
unsupported evidence leaves a working baseline tool intact.

Page replay must pass two distinct non-training inputs against Browser Use before
promotion. Inputs are hashed in evidence; outputs are not cached. Persisted plans
are checked for their task origin and contract. Navigation is fresh, exact-origin,
read-only and bounded. Auth/HTTP failures, absent output and interrupted execution
do not yield a successful answer. A failed plan is degraded rather than retried in
a loop. No claim is made that selector drift always produces a detectable error.

Prefer a validated network plan when available; otherwise a validated page plan
can avoid agent/model work while still using Chrome. Report `browser-replay`
separately from `network` and from `browser-use`. Do not restore the prototype's
custom agent/controller to obtain this optimization.
