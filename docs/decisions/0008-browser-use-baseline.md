# Browser Use as the browser-task baseline

Status: implemented single-controller alpha; live benchmark limitations remain explicit.

## Implementation checkpoint

The alpha now includes a provider-neutral whole-task contract and Browser Use
worker attaching to a host-owned CDP browser. Host process supervision provides
a hard worker deadline; structured failure statuses are separate from data.
Nine focused tests pass, including malformed responses and a hung worker.

A local fixture passed two Browser Use demonstrations with the existing network
recorder, automatic request compilation and caller-output projection selection.
An unseen gamma query replayed as one network request with zero navigations and
no browser-agent invocation (about 8 ms locally; not a production benchmark).

The active runtime, task store and MCP entry point now use this boundary.
Stagehand and the custom controller were removed from the active source and
dependency manifest; the previous implementation remains in Git history.
The controlled runtime passed two held-out shadows followed by model-free network
replay after restart. The built and clean-installed MCP server passed recipe-free
learning, generated-tool execution and schema restoration after server restart.
This is still an alpha, not a beta or proof of broad live-site network acceleration.

Browser Use will own whole-task browser navigation. ClappingHands will not keep
a second planning loop around its individual actions. Stagehand and the custom
navigation controller are migration targets, not permanent fallback providers.

ClappingHands retains caller-defined schemas, session ownership, network capture,
compilation, evidence validation, plan storage, MCP and effect protections.
Browser Use's completion flag alone is not proof of a successful user outcome.

## Evidence

The first ten-site experiment returned candidate answers on six sites. Three
reported access restrictions and clean-profile Marketplace required login.
Independent result checks and compilation integration remain unverified. The
saved-profile Marketplace experiment failed to finish within its intended bound.
These results justify migration work, not a validated success-rate claim.

## Execution contract

The baseline accepts a goal, input, output schema, authorized session and deadline.
Outcomes distinguish completion, authentication, access restriction, timeout and
failure. Schema-valid error prose is not successful task data.

Capture network evidence before navigation and across page changes. Keep secrets
out of persisted plans and public reports. Observe traffic without adding another
navigation controller.

A baseline result remains usable when compilation cannot infer a replay recipe.
Persist the goal/input/output contract independently of compiled DOM/network plans.
Read-only compiled failures permit one baseline fallback in the same session.
Unknown write outcomes must not be retried. Validate repairs before promotion.

## Migration gates

1. Whole-task Browser Use interface, not act/observe emulation.
2. Verified process deadlines, shutdown and exclusive profile ownership.
3. Controlled-fixture network capture, including navigation.
4. Typed first-run result and compiled unseen-input/restart replay.
5. Bounded baseline fallback and explicit failure classification.
6. Runtime and MCP use the single replacement baseline.
7. Remove Stagehand and obsolete controller code after replacement tests pass.

Retain independent compiler, effect, auth, storage and network tests. Preserve
historical benchmark evidence, but do not keep hidden legacy runtime switches.
