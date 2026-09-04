# Project guidance

## Product scope

Build a compiler for repeated, user-authorized browser workflows on sites with no
usable API. Preserve the narrow wedge described in `docs/PRODUCT_BRIEF.md`.

Do not casually expand the project into a general browser agent, bulk scraper,
site-owner platform, or anti-bot system. Prefer read-only workflows until effect
classification and confirmation are deliberately designed.

## Architectural constraints

- Stagehand is a replaceable dependency behind `BrowserLearner`.
- The action IR and persisted plans must not contain Stagehand-specific types.
- Plans may be cached; dynamic output data must be freshly retrieved.
- Optimize progressively: semantic browser, cached UI, hardened DOM, then network.
- Keep browser fallback and evidence for every promoted network operation.
- Never persist or print authentication secrets.

## Working conventions

- Treat `docs/WEBPIPE_SPEC_v0.2.md` as historical input, not current authority.
- Record material architectural choices under `docs/decisions/`.
- Add controlled fixture tests before relying on third-party websites.
- Measure success rate, latency, model calls, and fallback rate for every level.

