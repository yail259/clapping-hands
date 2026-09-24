# ADR 0006: Caller-defined input and output contracts

Date: 2026-09-06

Status: Implemented with initial controlled-install and two-production-site
browser validation; release verification remains incomplete.

The subsequent [11:10 integration](../../bench/runs/2026-09-06/schema-v1-verification-1110.json)
passes 517/517 tests and the schema-first RBA browser trial: six exact typed
UI/input-state checks across restart, with a learned native input-value source.
RBA joins Moneysmart as the second production browser workflow. Neither site has
a validated network accelerator. RBA's historical arithmetic discrepancy is
explicitly not a passing mathematical oracle. The installed artifact below
predates this increment; it is retained as dated evidence, not current signoff.

Prior [2026-09-06 10:32 verification](../../bench/runs/2026-09-06/schema-v1-verification-1032.json)
passes 487/487 tests and a fresh 90-file installed package after lifecycle/privacy
hardening. Five typed results match across restart, including three network calls.
Two warm network calls have independent client/provider-dispatch observations;
all-driver/all-model coverage and production acceleration are still unproved.
The older snapshots below retain their original scope and counts.

## Decision

The caller describes a read-only workflow and supplies input/output JSON Schemas,
including field meanings. The output contract, not website display strings, is
the compiler target. Schemas are fixed for one learned workflow version; changing
them requires learning and validation again.

The browser learner produces a bounded DOM extraction recipe and a declarative
projection from `{rows: [...]}` into the caller's JSON value. The network learner
independently proposes a projection from the decoded network response into that
same value. It does not first reproduce UI display strings. Neither projection
contains executable JavaScript or a Stagehand-specific type.

The current projection vocabulary constructs objects/arrays, reads literal
paths and applies explicit text/number/boolean/URL conversions. Learned and
persisted caller contracts require source paths even for enum and nullable
values; unbound literals are refused. Seeing a constant elsewhere in the same
listing is not evidence that it represents the requested field. Paths, traversal, output sizes,
types and supported schema keywords are bounded and validated. Unsupported
JSON Schema features fail explicitly rather than being silently ignored.

Generated tools publish the declared types and field descriptions. Execution
returns the caller value in `result.data`, plus execution/completeness metadata.
Raw network payloads and intermediate DOM fields remain internal. Existing
string-row workflows keep their original contract and validation rules.

## Meaning and evidence

A schema-valid number may still be the wrong price. Field descriptions and page
evidence guide the learner: asking price is not old price, dollars are not cents,
and a currency symbol alone may be ambiguous. Browser preview shows both observed
source fields and the projected typed output for model review. Matching JSON
shape alone is never claimed as semantic proof.

Both varied learning demonstrations must validate the same browser recipe and
projection. Network projections must match the independent browser contract
outputs, preserving scalar types and array order while ignoring object key order.
Network candidates still require independent runtime comparisons before promotion.
Learning evidence and raw response branches sent to the model are bounded and
filtered. Proposals must validate against original responses, not just pruning.

### Exact structural proposals still need meaning checks

Network projection admission now distinguishes three paths:

- A whole response or unique source subtree already matching the entire caller
  output exactly across all examples keeps the existing zero-model fast path.
- A unique exact construction using renamed fields, nested objects or arrays is
  a **proposal**, not an automatically accepted mapping. One bounded model review
  checks field roles and units against the caller goal, schema and corresponding
  verified browser evidence. It returns only `approved` and a fixed reason, not a
  replacement AST. Only explicit `semantics-supported` approval admits that
  proposal; uncertainty or refusal does not silently fall through to another
  model-generated mapping in the same attempt.
- Conversions not covered by exact construction retain the existing bounded
  model-generated projection path and its evidence checks.

Every proposed value remains source-bound. Original/pruned evidence, scalar
types, every demonstrated array row and array order must still validate exactly;
model approval cannot waive those checks. Duplicate exact branches are refused.
Each deterministic search is limited to 200,000 charged logical operations, not
a guaranteed wall-time or allocation cap. Each semantic review has no provider
retry and a 60-second deadline. This is not a total workflow provider-call budget.

The extra review addresses a concrete counterexample: a quantity may coincide
with a dollar price across the demonstrations while the actual source price is
in cents. A unique numeric match does not establish that the field means price.
The temporary 5 ms, zero-model reshaping prototype was therefore withdrawn before
acceptance; its retained report is not a current capability or speed claim.

The [revised numeric probe](../../bench/runs/2026-09-06/schema-projection-reviewed-numeric-v2.json)
used one review call (656 input/18 output tokens), completed in 1.872 seconds,
and matched four held-out rows with zero projection-replay model calls. The
[revised adversarial probe](../../bench/runs/2026-09-06/schema-projection-reviewed-refusal-v2.json)
correctly refused quantity-as-price with one call in 1.947 seconds. These are
synthetic translation probes, not a reliability rate, browser learning or network
execution proof. Earlier invalid proposals and a numeric false refusal remain
in the release audit.

The subsequent [clean installed package](../../bench/runs/2026-09-06/schema-package-smoke-1788687063773.json)
and [built-MCP onboarding report](../../bench/runs/2026-09-06/schema-packaged-onboarding-1788687063773.json)
pass five independent synthetic-oracle comparisons: two browser shadows, then
three fresh network calls, including two after restart. Learning took 83.185
seconds with 22 reported calls: 10 and 11 for the demonstrations plus one semantic
review (684 input/74 output tokens). All replay calls report zero models; child
browser/model activity was not independently instrumented. This verifies the
controlled installed path, not production network performance, human login/MFA
or desktop-host setup. The subsequent integrated snapshot passes 452/452 tests
in 112.184 seconds, plus typecheck and package prepack build for the same
production source. A later Marketplace harness change is outside that snapshot;
no fresh schema-first Marketplace trial is included.

A later [fresh Marketplace attempt](../../bench/runs/2026-09-06/schema-profile-startup-comparison.json)
failed before unseen execution. Browser-only controls point to an existing-profile
initial-navigation problem; its precise cause is not established. No new
schema-first Marketplace or production-network success is inferred. Subsequent
lifecycle safety changes require separate verification from the snapshot above.

All replay paths, including semantic repair and browser fallback, validate the
same caller contract before returning success. Failed network validation degrades
the accelerator and reports fallback. Authentication failures remain distinct.

## Scope and remaining evidence

### Native input results and readiness (2026-09-06)

The generic DOM recipe now supports `source: "value"`, with `line: null`,
for visible native readonly or disabled text/number inputs. It reads the native
live string, not a stale HTML attribute, without trimming or implicit numeric
coercion. Existing explicit projections still define the caller's typed value.
Every read rechecks admission: editability, type, hidden/inert ancestry,
autocomplete, sensitive metadata/associated labels, cardinality and value bounds.
Rejected values do not enter field diagnostics. This conservative policy is not
a sandbox against arbitrary hostile page code or proof that all private data can
be recognized from labels. Other form-control types remain unsupported.

The model sees a value only after explicitly targeting an admitted input with
inspection; enclosing/body inspection does not enumerate form values. The results
region still requires nonempty visible text (such as a label). Saved plans contain
the declarative source/selector, not a captured result value.

For recipes containing value fields, compiled and semantic-repair readiness
observe the projected caller result. Static labels and changes to unprojected
helper fields cannot satisfy this check. A final already-selected control no
longer bypasses it. The result must change after the final action and remain
stable through the existing bounded stability window; unchanged results are
conservatively refused. This is not a general proof that arbitrary asynchronous
sites have finished every computation. Independent held-out result checks remain
required; no network or production-site pass follows from this primitive alone.

The v1 goal is read-only workflows on sites without a usable public API. Flat,
required scalar input properties match the present browser action IR; nested
output objects and arrays are supported. This is not support for every JSON
Schema dialect, arbitrary computation, pagination, or write actions.
Although schema validation supports nullable values, the current DOM extractor
requires visible nonempty string fields. Missing-value-to-null learning and
genuine empty-result states remain incomplete; schema acceptance alone is not
evidence that those cases can be learned.

The previous Marketplace and Moneysmart results belong to the legacy string-row
contract. They do not prove this schema-first implementation, and the old
whitespace mismatch must not become a passing benchmark by relabeling it.

Fresh evidence is now separate: the [schema-first Moneysmart trial](../../bench/runs/2026-09-06/schema-moneysmart-1788685268412.json)
learned numeric repayment output without site glue and passed six independent
unseen/restart UI and arithmetic checks, using browser execution with zero
reported replay model calls. It is the **first**, not second, production site for
this contract. No network candidate was accepted. Learning took 217.447 seconds
and 49 reported calls; browser engine time was 4.081–4.865 seconds.

The earlier [84-file clean-package trial](../../bench/runs/2026-09-06/schema-package-smoke-1788685083801.json)
passed model-led learning, explicit generated schemas and five exact browser
calls across restart with synthetic authentication. It did not accept a network
accelerator; its translation counts are unavailable. This controlled install is
not human login/MFA or installed desktop-host verification. The prior integrated
source snapshot passed 424/424 tests, typecheck and build; it predates the exact
proposal/semantic-review change above. Earlier provider/learning failures remain
in the release audit; these passes do not establish a success rate.

The [fresh RBA trial](../../bench/runs/2026-09-06/schema-rba-1788692736540.json)
now supplies the second production browser site: two varied demonstrations,
five distinct held-out inputs over six calls and a runtime/browser restart,
without supplying site-specific selectors or projections to the learner.
Learning took 168.903 seconds / 44 reported calls; replay took 3.772–3.982 seconds
engine time and reports zero models. Its exact independent UI/input-state gate
passes; archived CPI arithmetic differs on five calls, so mathematical correctness
is not claimed. Its server-backed HTML calculation has no accepted JSON network
candidate. This is architecture coverage, not a Marketplace substitute.

Fresh Marketplace schema-first learning, independent
warm/restart network proof, human authentication/host verification and final
release-hardening signoff remain required. Browser results cannot close network
acceptance gates.

Keep the original network investigation cutoff: 2026-09-08 01:31 UTC, or earlier
after two focused investigation days. If unresolved, document the limitation;
do not move the cutoff or claim unverified network acceleration.
