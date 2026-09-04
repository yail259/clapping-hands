# Architecture

## System boundary

```text
prompt or demonstration
        |
        v
Stagehand learner ---- browser session
        |
        v
action candidate + evidence
        |
        v
Clapping Hands compiler
  - typed action IR
  - validation contract
  - execution plans
  - repair/version history
        |
        +----------+-----------+
        |          |           |
        v          v           v
 semantic UI   deterministic   authenticated
 fallback      DOM replay      network call
        |          |           |
        +----------+-----------+
                   |
                   v
             fresh result
                   |
          MCP / SDK / local HTTP
```

## Ownership

Stagehand owns exploration, semantic element discovery, first-run execution, and
browser-assisted recovery. It does not define the durable product artifact.

Clapping Hands owns:

- action names and input/output schemas;
- the public intermediate representation;
- plan versions and provenance;
- fresh-data semantics;
- execution validation and evidence;
- DOM and network optimizations;
- policy for reads and consequential effects;
- MCP, SDK, and HTTP publication.

## Progressive execution levels

### L0 — semantic browser execution

Use Stagehand and a model to perform or repair a workflow. This is the slow,
general fallback and the source of new evidence.

### L1 — cached browser plan

Replay known browser operations without model calls. Re-extract current output
data on every run; cache selectors and actions, never dynamic results.

### L2 — hardened DOM plan

Use Webpipe-owned locators, assertions, waits, parsing rules, and alternate
selectors. Validate preconditions and output invariants.

### L3 — promoted network plan

When browser evidence shows a stable authenticated request, create a parameterized
network plan. Reuse the user's browser session credentials without exporting raw
secrets. Validate response shape and preserve L2/L0 fallbacks.

Promotion is per operation, not per website. A single action may mix network and
browser steps.

## Action IR sketch

```json
{
  "name": "search_marketplace_cars",
  "version": 1,
  "origin": "https://example.test",
  "effect": "read",
  "inputSchema": {},
  "outputSchema": {},
  "plans": [
    { "level": "network", "status": "candidate" },
    { "level": "dom", "status": "verified" },
    { "level": "semantic", "status": "fallback" }
  ],
  "freshness": { "mode": "live" },
  "validation": [],
  "evidence": []
}
```

The final schema should remain small, serializable, versioned, and independent
of Stagehand's internal cache representation.

## Safety and trust boundary

- Require a user-controlled or explicitly delegated browser session.
- Default to read-only actions.
- Classify effects and require confirmation before consequential writes.
- Never log cookies, authorization headers, tokens, or sensitive form values.
- Respect site terms, access controls, rate limits, and applicable law.
- Do not market network promotion as a mechanism for bypassing protections.

