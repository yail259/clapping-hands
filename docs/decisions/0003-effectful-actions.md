# ADR 0003: Gate effectful action compilation with prepared intent and proof

**Status:** proposed

**Date:** 2026-09-04

## Context

Clapping Hands is intended to compile UI interactions into typed API/MCP tools,
not merely extract page data. Useful workflows include editing a draft,
uploading a file, changing a status, sending a message, publishing, approving,
or submitting a transaction.

The current prototype promotes only a read workflow. Applying the same capture,
shadow, retry, and repair behavior to mutations would risk duplicated or
misdirected effects. A successful HTTP response is also insufficient evidence
that the intended remote state exists.

## Proposed decision

Every operation and action declares one of three effect classes:

- `read`: no persistent remote state change;
- `write`: persistent but deliberately reversible or contained change;
- `commit`: externally consequential or difficult-to-reverse effect, including
  send, publish, approve, purchase, delete, transfer, and final submit.

Effectful execution uses a prepare/commit protocol:

1. Bind and validate typed inputs without crossing the effect boundary.
2. Render a deterministic prepared intent naming the account, target, action,
   and material parameters.
3. Append a durable effect record before asking for confirmation.
4. Require confirmation according to policy: at least first-run confirmation
   for `write`, and confirmation for every `commit` by default.
5. Execute the final effect at most once.
6. Collect independent postcondition evidence and any remote identifier.
7. Mark success only when the intended effect is proven.

A `write` must have a reset or reconciliation strategy. A `commit` must have an
idempotency key or target-specific duplicate detection where available. If the
connection or browser fails after the final interaction and before proof, return
`outcome_unknown`, do not retry automatically, and run a separate read-only
reconciliation action.

Network promotion is gated independently for `read`, `write`, and `commit`.
Evidence that a read path is safe never enables a mutation path. Model-driven
repair may approach an effect boundary but cannot silently change or cross it.

## Benchmark gate

No effectful production benchmark is eligible until controlled fixtures prove:

- correct effect classification and refusal when the effect is understated;
- deterministic prepared intent and explicit confirmation;
- append-only journal recovery across process restarts;
- no duplicate remote effect under duplicate delivery and timeout injection,
  with success reported only when one intended effect is independently proven;
- `outcome_unknown` plus reconciliation after an ambiguous response;
- independent postcondition checks and verified reset for reversible writes;
- no credentials, tokens, request bodies, personal data, or confirmation secrets
  in persisted plans or public reports.

After the fixture gate, benchmark only seeded data on operator-owned deployments,
official sandboxes that permit automation, or expressly permissioned tenants.
Never shadow a consequential action by performing it twice.

## Consequences

- The benchmark can cover arbitrary UI action shapes without treating all
  actions as equally safe.
- Commit throughput is not the primary metric; correctness, at-most-once
  execution, and proof dominate latency.
- Some workflows will remain browser-only or require confirmation forever.
- The current read-only prototype cannot yet support a public claim that
  arbitrary actions are implemented.
