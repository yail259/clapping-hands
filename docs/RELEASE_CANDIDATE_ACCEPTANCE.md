# Frozen candidate acceptance — 2026-09-08

## Current runtime candidate

The later archive `8c5eb2edb9c1c26442fad604733795ec8bd144f549a296a4156f7bef628bf0e3`
contains the saved-capture importer and Node 22 charset fix. Its
[clean-install record](../bench/runs/2026-09-08/node22-package-acceptance.json)
and subsequent [Open Library acceptance](../bench/runs/2026-09-08/openlibrary-packaged-acceptance.json)
cover the same exact archive. The latter proves two production demonstrations,
two exact unseen comparisons, and one independently checked network-only restart
with model/agent unavailable. It does not transfer the fixture timing ratios below
to the new archive or prove human-authenticated onboarding.

Documentation changes after that run do not change the tested archive. A future
archive must identify its own bytes; do not reuse an older hash for new packaging.

## Earlier frozen fixture candidate

This record is external to the frozen archive. It does not change the bytes
tested or imply publication, production validation or human-login signoff.

Archive: `.data/release-candidates/clapping-hands-9ba07dce36f0e25d.tgz`

SHA256: `9ba07dce36f0e25d432b4ba9fd040fe57e1b0a2d9b1004b28abda479a14191cd`

The 257,238-byte archive contains 107 files. Every shipped file matched the clean
Node installation; relative documentation links resolved, retired/private/cache
files were absent, and the credential-pattern scan found no matches. The Node
production dependency audit reported zero known vulnerabilities. The locked
Python 3.12.7 environment contains the previously audited 107 package versions.
Pattern scans and advisory audits are bounded checks, not comprehensive security
proof. Linux/Windows and additional platform branches remain unverified.

An actual MCP client completed two Browser Use demonstrations, model-authored
compilation, two exact unseen comparisons, then restart with model credentials
and Browser Use unavailable. The fresh network result took 594 ms end-to-end,
with one request, no document request and zero model calls. Installed invalid/
unknown-task error recovery also passed without browser/model access.

| Same-input local fixture comparison | Browser Use | Compiled | Ratio |
| --- | ---: | ---: | ---: |
| zeta | 19.65 s | 541 ms | 36.4× |
| eta | 35.65 s | 612 ms | 58.3× |

These are two controlled samples, not a production performance guarantee.
Learning took 70.16 s; held-out validation costs are additional and excluded
from the warm ratios. The slower second baseline illustrates timing variability.

[Machine-readable evidence](../bench/runs/2026-09-08/frozen-candidate-acceptance.json)
is public; full retained fixture evidence is private. This acceptance supersedes
older packaged fixture results for these runtime bytes only.

## Still open

- Integrated production generalization and matched production timing; the
  specific live IKEA verification is still awaiting destination approval.
- Human-authentication/MFA onboarding and desktop dogfood of this exact package.
- Older evidence import and complex request-translation gaps documented in
  `SAVED_EVIDENCE_AUDIT.md` and the release progress record.
- Final claim/scope reconciliation against the complete release goal.

No registry publish, repository push or desktop MCP replacement was performed.
