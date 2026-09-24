# Project guidance

## Product scope

Build a compiler for repeated, user-authorized browser workflows on sites with no
usable API. Preserve the narrow wedge described in `docs/PRODUCT_BRIEF.md`.

Do not casually expand the project into a general browser agent, bulk scraper,
site-owner platform, or anti-bot system. Prefer read-only workflows until effect
classification and confirmation are deliberately designed.

## Architectural constraints

- Browser Use is the managed whole-task navigation adapter. Caller-driven demonstrations are allowed through explicit recorded-session interfaces; do not introduce a custom navigation loop.
- Baseline task contracts must work without a compiled replay recipe.
- Plans may be cached; dynamic output data must be freshly retrieved.
- Promote network candidates only after held-out comparisons; browser fallback remains available.
- Keep browser fallback and evidence for every promoted network operation.
- Never persist or print authentication secrets.

## Working conventions

- Treat `docs/WEBPIPE_SPEC_v0.2.md` as historical input, not current authority.
- Record material architectural choices under `docs/decisions/`.
- Add controlled fixture tests before relying on third-party websites.
- Measure success rate, latency, model calls, and fallback rate for every level.
