# ADR 0003: Gate effectful action compilation with prepared intent and proof

**Status:** accepted; controlled-fixture implementation

**Date:** 2026-09-04

## Context

Clapping Hands is intended to compile UI interactions into typed API/MCP tools,
not merely extract page data. Useful workflows include editing a draft,
uploading a file, changing a status, sending a message, publishing, approving,
or submitting a transaction.

The first Marketplace path promoted only a read workflow. Applying the same
capture, shadow, retry, and repair behavior to mutations would risk duplicated
or misdirected effects. A successful HTTP response is also insufficient
evidence that the intended remote state exists.

## Decision

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
5. Execute the effectful suffix at most once, beginning at the earliest known
   effect boundary.
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

## Implemented subset

The controlled DOM compiler now supports a conservative subset of this ADR:

- every compiled DOM plan is explicitly declared `read` or `write`;
- a write requires a plain-language confirmation description and treats its
  first non-passive interaction as the conservative effect boundary (scroll
  and hover may remain in the prepared prefix);
- prepare executes only the deterministic prefix and creates an expiring
  receipt containing plan/input hashes, not raw inputs;
- commit atomically moves the receipt to `committing` before executing every
  action from that boundary through postcondition proof;
- uploads accept only regular files of at most 25 MiB beneath an explicit local
  root, persist no path or contents, and require the prepared content hash to
  match at commit;
- same-origin downloads are quarantined beneath an artifact root, capped at 50
  MiB, hashed, and returned without being opened;
- a successful postcondition marks it `committed`; any error after the boundary
  marks it `uncertain`; and
- committed, expired, and uncertain receipts cannot be replayed.

The production gate remains closed. Independent remote-ID reconciliation,
target/account rendering, explicit `write` versus `commit` policy classes,
verified reset for reversible writes, cross-origin artifact policy, and
target-native idempotency keys are not implemented yet. Until those exist, effect tests stay
on controlled fixtures, operator-owned forms, and isolated sandboxes.

## Consequences

- The benchmark can cover arbitrary UI action shapes without treating all
  actions as equally safe.
- Commit throughput is not the primary metric; correctness, at-most-once
  execution, and proof dominate latency.
- Some workflows will remain browser-only or require confirmation forever.
- The current prototype can demonstrate an at-most-once UI effect suffix on
  controlled targets, but cannot yet support an unqualified public claim that
  arbitrary consequential actions are production-ready.
