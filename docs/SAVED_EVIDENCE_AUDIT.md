# Saved production evidence compatibility — 2026-09-08

This offline audit checks the 186 bundles in the historical JavaScript experiment
directories for the original ten sites. Every bundle passed its integrity check.
It does not inventory every earlier benchmark directory, run a model, revisit a
site, or contradict the standalone experiments' previous results.

Run `node --import ./node_modules/tsx/dist/loader.mjs scripts/audit-saved-production-evidence.ts`
from a source checkout with its private evidence present. The count-only
[report](../bench/runs/2026-09-08/saved-production-evidence-audit.json) is public;
the underlying captured content remains private.

| Saved experiments | What the audit found | What this means |
| --- | --- | --- |
| Open Library, Yahoo, GOV.UK, RBA, Bunnings | Sanitized direct-response HTML snapshots, without the current recorder's in-process identity | Useful parser evidence, but not drop-in inputs for today's browser-recorded HTML admission. Do not synthesize recorder identity. |
| IKEA | Two structurally restorable JSON exchanges use a separate API origin | Same-origin-only audit admits none. The separately scoped IKEA preparation test already passed; live validation still awaits destination approval. |
| Transport NSW | Eleven structurally restorable JSON exchanges; no same-origin candidate across the two captured inputs | Request translation/admission remains a gap. This is not a test of model intelligence or a new live-site failure. |
| Marketplace | JSON responses exist, but request bodies are form-encoded or omitted rather than directly restorable JSON | Needs a faithful form/session evidence adapter; this audit deliberately does not invent stripped state. |
| eBay, BOM | One non-success page capture each | No pair of successful examples to compile. These are historical observations, not claims about current access. |

## Evidence-loss bug found and fixed

The sanitizer treated an empty body as opaque and stored `[OMITTED]`. That loses
the distinction between an observed empty request and a removed request body.
Future non-authentication captures now retain the exact empty string. Persistence
tests distinguish it from opaque bodies and confirm authentication-endpoint
suppression still applies. Existing bundles are immutable and remain unchanged;
their omitted bodies are not guessed empty, even for GET.

## Next integration boundary

Do not equate parser evidence with a promoted executable tool. A legacy importer
must preserve the observed request contract, source provenance and omissions;
respect the caller's explicit API scope; validate generated output on new inputs;
and keep browser fallback. It must not relabel sanitized HTML as original browser
or wire bytes. Current prepared compiler bundles already support offline
recompilation; this gap concerns the older experiment formats.
