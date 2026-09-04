# Prototype roadmap

Implementation snapshot: Milestone 0 is complete. The controlled-fixture parts
of Milestones 1–3 are implemented (versioned product-owned plans, zero-model DOM
and form replay, same-origin frames and new-page transitions, zero-argument
tools, explicitly allowlisted API origins, form-encoded GraphQL variables,
response-linked JSON promotion, drift degradation, and browser fallback). The
representative-corpus and live evidence gates are still open;
see [`BENCHMARK_CORPUS.md`](BENCHMARK_CORPUS.md).

## Milestone 0 — contract

- Define the minimal action IR.
- Define fresh-result and validation semantics.
- Introduce a `BrowserLearner` interface and Stagehand adapter boundary.
- Build a controlled fixture site with a dynamic, authenticated search workflow.

Exit condition: an action can be serialized without importing a Stagehand type.

## Milestone 1 — learn and replay

- Learn one read-only workflow with Stagehand.
- Infer and confirm input/output schemas.
- Replay it without model calls.
- Re-extract live data on every execution.
- Publish the action as a local MCP tool.

Exit condition: ten warm runs succeed against fixture variations with zero model
calls and no stale outputs.

## Milestone 2 — validate and repair

- Store execution evidence and failure diagnostics.
- Add output invariants and drift detection.
- Fall back to semantic execution on a replay failure.
- Generate a new plan version rather than silently mutating the old one.

Exit condition: an intentional fixture UI change triggers fallback, repair, and a
subsequent deterministic run.

## Milestone 3 — network promotion

- Capture request/response candidates during successful browser runs.
- Detect inputs, pagination, and response fields.
- Create a parameterized authenticated network plan.
- Validate it against the browser-derived result.
- Retain the DOM and semantic plans as fallbacks.

Exit condition: the fixture search runs through the network plan with materially
lower latency while returning equivalent fresh results.

## Milestone 4 — real-world demonstrator

- Select one user-authorized, read-only site with no usable public API.
- Confirm site terms and constrain rate and scope.
- Measure cold compile time, warm latency, model calls, success, and fallback rate.
- Record a short demo showing learning, tool creation, fast execution, and repair.

Exit condition: the demonstration proves the compiler thesis rather than merely
showing a browser agent.
