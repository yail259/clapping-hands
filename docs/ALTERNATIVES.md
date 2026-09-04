# Alternatives and competitive boundary

Clapping Hands is not the first project to notice that repeated browser work can
be replaced by cached deterministic operations. The honest product question is
whether it can compile a broader workflow safely, privately, and reproducibly—not
whether it invented internal API replay.

| Project / approach | Strong at | Relationship to Clapping Hands |
| --- | --- | --- |
| [Unbrowse](https://github.com/unbrowse-ai/unbrowse) | Discovering first-party routes, cached direct execution, local credentials, shared route metadata, CLI/MCP/SDK | Direct competitor for network-backed read workflows |
| [Stagehand](https://github.com/browserbase/stagehand) | Semantic browser actions, self-healing, complex DOM support, browser-agent primitives | Replaceable learning and repair dependency, not the persisted plan format |
| [Browser Use](https://github.com/browser-use/browser-use) | Autonomous prompt-to-task browser execution and hosted/local sessions | General browser-agent alternative; Clapping Hands aims to amortize repeated tasks into fixed tools |
| WebMCP / site-authored tools | Sites explicitly expose typed capabilities to agents | Complementary; prefer the site-owned tool when one exists |
| Public first-party APIs | Stable documented contracts, policy clarity, support | Preferred negative control; do not compile the UI when the API is suitable |

## The direct comparison: Unbrowse

Unbrowse's public repository describes the same central optimization: learn a
site's first-party routes from browsing, replay them directly, retain browser
fallback, keep credentials local, and expose the result through MCP and an SDK.
Its [paper](https://arxiv.org/abs/2604.00694) reports 3.6× mean and 5.4× median
warmed-cache speedups across 94 domains. Its
[current benchmark notes](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/benchmarks.md)
also report a newer, harder 19-probe product corpus at 50% coverage. Those are
different evaluations and should not be combined into one comparison.

The [open-source notice](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/OPEN-SOURCE-NOTICE.md)
says its local runtime, CLI bridge, SDK/adapters, and auth/signing layer are MIT,
while the backend route graph, ranking, settlement, and recursive compilation
remain private.

Clapping Hands therefore needs to win on evidence, not phrasing:

- compile complete demonstrated workflows when there is no reusable JSON route,
  retaining deterministic DOM/form execution and semantic repair;
- keep plans private and local by default, with no shared route marketplace in
  the trust boundary;
- make output freshness, false-success rejection, fallback, and plan drift
  visible;
- put reversible writes and consequential commits behind prepared intent,
  durable journaling, explicit confirmation, and at-most-once behavior; and
- publish a frozen representative corpus with exact correctness and negative
  rows, plus a same-machine head-to-head where licenses and setup permit it.

These are differentiation goals, not all verified production capabilities. The
benchmark gate remains the source of truth.
