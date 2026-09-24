# ADR 0010 — Generated JavaScript owns new output compilation

Status: implementation in progress, 2026-09-08. Not release signoff.

Browser Use remains the only task-navigation agent. Successful browser results
do not depend on compilation. New network output compilation uses model-authored
JavaScript rather than the former learned projection language.

The program runs in the existing bounded QuickJS worker. The host owns allowed
requests and credentials. The program, contract and resources have integrity
digests. Two distinct non-training inputs must match independently obtained
baseline outputs before warm execution can omit Browser Use. A mismatch or
execution failure degrades that program; later matches cannot revive it. Runtime
shutdown cancels the guest and signals its request broker.

The old projection learner, candidate-selection pipeline and Marketplace-specific
compiler/parser were removed from active source. The generic request-admission
and decoding code remains because the runtime uses it. Previously saved task-v2
projection plans retain execution compatibility; new learning does not create
them. The existing page-text replay remains a working browser-backed accelerator,
not a second navigation agent. Removing it before a replacement would regress
supported tasks and is not part of this cleanup.

Current integration limitations:

- Resource discovery still uses existing request admission. It does not yet
  reproduce arbitrary request construction. Observed varying scalar query/body
  arguments can now be exposed per resource, including arguments obtained from
  a previous response. The model authors that dataflow; offline execution checks
  each request against its resource-specific training arguments. Saved prepared
  bundles carry `resourceInputs`; older bundles default to their caller inputs.
- Ordinary captured HTML documents can now be response resources without a
  pre-authored selector recipe. The model supplies selectors and transformations.
  Documents retain recorder provenance, a pinned supported encoding, a 1 MiB
  bound, and all existing request-scope checks. Working calculator resources keep
  their live-value checks. Rendered Marketplace programs still need integration.
- Observed JSON requests on caller-authorized exact API origins are now admitted
  through `allowedNetworkOrigins`. The permission is part of the saved contract
  and checked during compilation, store validation and replay. Browser navigation
  remains site-origin-only. Cross-origin HTML, fresh-token context and pagination
  remain unsupported by this adapter; the browser baseline remains available.
- Controlled tests substitute the model at its proposal boundary. They prove
  routing, generated execution, persistence and fallback, not live model quality.
- Prepared compilation evidence is retained before inference. MCP recompilation
  stages a replacement without opening a browser; two unseen comparisons are
  required before replacing the previous generation. Imports of older raw
  captures and packaged MCP end-to-end verification remain incomplete.

Checksums detect accidental corruption, not malicious local rewriting. A request
count above zero rules out a purely constant program but is not, by itself, proof
that every output field depends on fresh response data. Independent comparisons
and held-out data changes remain necessary.
