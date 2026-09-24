# Compiler restoration after the Browser Use cutover

## Regression and repair

The alpha navigation cutover retained the network compiler but did not supply
its server-HTML evidence adapter. RBA's formerly supported calculator therefore
could not produce an accelerator. A JSON-only fixture did not catch this.

The active runtime now passively captures safe, visible readonly/disabled native
input results after Browser Use completes. It discovers bounded selectors from
public field IDs, preserves their field roles, and passes independently read
browser rows and recipes into the existing compiler. Captured server attributes
must exactly equal those browser rows. Legacy encoding and native-input safety
checks are unchanged. No site-specific selector is embedded in the runtime.

Plain decimal-string to number projections can be constructed mechanically with
scale 1 and no inferred rounding, currency or locale. They still require semantic
review and exact demonstration agreement. This avoids model-authored arithmetic
for native input values without making numeric equality proof of field meaning.

Candidate discovery is not promotion. Two distinct held-out inputs must agree
with Browser Use before a network plan becomes stable. A failed read accelerator
degrades and returns to the existing bounded Browser Use fallback.

Learning now returns count-only compilation audits and fixed projection-failure
categories through MCP and benchmark reports. Requests, response bodies,
credentials and provider exception text do not enter these diagnostics.

## Coverage and limits

### Live RBA regression, 2026-09-07

The repaired runtime learned an HTML request automatically, then matched two
distinct held-out inputs exactly (114.83 and 181.12). A restarted network-only
call returned 489.66 in 496.8 ms, with zero model calls and no fallback.
The two browser shadow calls took 38.51 s and 34.88 s, including network shadow
time. These are different inputs, not a controlled same-input speed ratio.
The network measurement excludes browser/session startup and cleanup.

Evidence: `bench/runs/2026-09-07/alpha-ten-1788748150004-rba.json`.
The accompanying `.oracle.json` independently verified all three outputs against
fresh calculator submissions, including the restarted network-only result.
The benchmark was run before the packaging-only version bump to alpha.2.
The full suite passed 273 tests; built MCP learning/call/restart also passed.
Installed alpha.2 MCP learning/call/restart passed as well. Loading the proven
RBA plan from the installed package, with no model configuration supplied,
returned the independently checked 489.66 result: 425.6 ms network execution,
1,165.0 ms for the complete call including session setup/cleanup, zero model
calls, no fallback. This is a subsequent call, not the original benchmark timing.

Earlier diagnostic attempts are retained: `alpha-ten-1788747636337-rba.json`
and `alpha-ten-1788747893344-rba.json`. They found the HTML candidate but failed
projection. They must not be counted as acceleration successes.

- The actual adapter has a real-Chrome form/HTML capture and fresh-replay test,
  including Windows-1252, plus missing/stale evidence and projection-error tests.
- RBA remains the live regression gate. Live results are recorded separately;
  fixture success alone is not a claim of restored real-site acceleration.
- This repairs the server-HTML network route. The old GOV.UK saved DOM-step
  acceleration is a separate, still-unported backend; Browser Use remains its
  baseline. It is not restored by this change.
- Fresh-token runtime-context plans remain experimental and are not enabled in
  the alpha task store. No claim of Marketplace acceleration is made.
- HTML discovery is deliberately limited to supported native output controls
  with simple public IDs. Arbitrary rendered HTML/text and complex layouts are
  not newly supported.
- Previously registered baseline-only tasks need relearning under a new action
  name. Existing saved outputs are not sufficient to reconstruct private capture
  provenance; old plans are not silently promoted.

## Reproduction

Use the supported Node runtime and installed Python Browser Use environment:

```
npm test
CLAPPING_HANDS_BENCH_SITES=rba npm run benchmark:ten
```

Use the existing authorized endpoint environment configuration. Do not place
credentials in goals, examples, plans or reports. The benchmark's site-specific
RBA oracle is validation-only and is never imported by the compiler.
