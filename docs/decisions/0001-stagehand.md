# ADR 0001: Use Stagehand behind an adapter

**Status:** accepted for prototype

## Context

The product needs a capable semantic browser learner but differentiates on the
durable action, progressive optimization, validation, and tool publication.
Building semantic browser operation from scratch would delay testing that thesis.

Stagehand is MIT-licensed, can run against local Chrome, supports multiple model
providers, and can be forked if necessary. Its public API and internal cache
formats may continue to change quickly.

## Decision

Use Stagehand for first-run exploration, action execution, and fallback repair.
Access it only through a small `BrowserLearner` adapter.

Pin the exact Stagehand version and commit the lockfile. Do not expose Stagehand
types in the action IR, public SDK, persisted plans, or MCP interface. Treat its
cache as a disposable execution optimization rather than a source of truth.

## Consequences

- The prototype starts with a mature browser-learning layer.
- The product remains able to upgrade, patch, fork, or replace Stagehand.
- We must maintain contract tests around the adapter.
- We must implement our own freshness rules and avoid replaying cached dynamic
  extraction results.
- Browserbase-hosted infrastructure may be offered as an option, not a requirement.

