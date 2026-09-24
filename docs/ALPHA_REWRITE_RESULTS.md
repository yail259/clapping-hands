# Browser Use alpha rewrite and ten-site benchmark

Date: 7 September 2026. Package: **0.1.0-alpha.1**. Not beta-ready.

## What changed

- Browser Use is the only navigation agent. Stagehand and the custom tool loop
  are absent from active source, package dependencies and the installed package.
- The runtime persists a goal and caller schemas independently of compilation.
  One successful example registers a reusable tool; two can produce a candidate.
- Network recording is attached before agent navigation. Existing request
  compilation, projection validation and held-out promotion checks are reused.
- Two distinct held-out comparisons are required for network promotion. A failed
  compiled read degrades the plan and invokes the baseline at most once.
- MCP advertises generated schemas and restores saved tools after restart.
- Python workers have host-enforced deadlines. Browser/profile ownership stays
  with ClappingHands, including when a worker times out.
- The previous implementation remains recoverable from Git history and is
  excluded from the active build/package. Old plans are not silently imported.

This is a deliberately read-only alpha. Legacy write/commit tools, DOM replay and
fresh-token network compilation are not active backends. The server-HTML compiler
remains in the core, but its recipe-dependent discovery is not connected to the
new recipe-free learner. That is a real capability gap, not a proven site limit.

## Verification

- 264 retained regression tests passed sequentially; four new task-store tests
  also passed. Parallel Chrome-heavy execution initially produced timing failures.
- TypeScript build passed.
- Controlled runtime: two Browser Use demonstrations → recorded responses →
  automatic compilation → two held-out exact comparisons → saved-plan reload →
  network execution with zero model calls. Local network engine time was about
  3 ms; this is not a production performance claim.
- Built, clean-installed and final durable-installed MCP packages passed:
  recipe-free learning, advertised schemas, generated-tool execution and schema
  restoration after server restart.
- The npm tarball contains no prototype or Stagehand/controller files. A clean
  install contains no Stagehand dependency. Pinned Browser Use: 0.13.10.
- The final durable install was exercised with Node 25.8.1 and Python 3.12.7.
  An earlier npm invocation warned about the machine's older default Node; final
  installation and acceptance explicitly used the supported Node executable.

## Ten production sites

Same site cohort as the prototype. Astra with low reasoning, local Chrome, two
sites at a time, read-only tasks and a 180-second agent deadline. Successful tools
received an unseen input and another unseen input through a new runtime instance.
Each call opens/closes its persistent profile, so browser restart is also exercised.

Times below are recorded browser execution durations for the unseen/restart calls,
not warm network times or full installation/startup time. The raw call wall timer
also includes the subsequent independent oracle and should not be used as a pure
runtime latency measurement. Browser model-call counts are unavailable, not zero.

| Site | Result | Independent check | Unseen/restart browser time | Network acceleration |
|---|---|---|---|---|
| Yahoo Finance | Returned results, including after restart | 2/2 exact headings | 44–44 s | Unavailable |
| Open Library | Returned results, including after restart | 2/2 exact first titles | 43–47 s | Unavailable |
| GOV.UK | Returned results, including after restart | 2/2 exact first titles | 32–46 s | Unavailable |
| RBA calculator | Returned results, including after restart | 2/2 exact live-UI amounts, supplementary oracle | 30–32 s | Unavailable |
| eBay Australia | Returned results, including after restart | Not independently verified | 75–98 s | Unavailable |
| Transport for NSW | Learning timed out | No result | 180 s deadline | Not reached |
| IKEA Australia | Agent reported access restriction | No result | 15 s first attempt | Not reached |
| Bunnings | Agent reported access restriction | No result | 45 s first attempt | Not reached |
| Bureau of Meteorology | Agent reported access restriction | No result | 13 s first attempt | Not reached |
| Facebook Marketplace | Failed before returning a task result with the saved profile | Inconclusive | Not a valid latency sample | Not reached |

Summary: **5/10 returned results across unseen inputs and restart; 4/10 have
independently verified results; 0/10 demonstrated live network acceleration.**
This small heterogeneous cohort is not a general-web success rate. Access statuses
come from the agent, not an independent claim about the cause of a site's block.

A separate Marketplace diagnostic launched the saved profile successfully, then
timed out navigating to Marketplace; cleanup completed. It did not establish
whether authentication is valid. No cookie export, profile reset or bypass was used.

## What this means relative to the prototype

Yahoo and Open Library now complete unseen and restart calls where the earlier
prototype attempts failed. eBay also returns results, but needs an oracle.

**Acceleration has regressed on the prior successes.** The prototype's GOV.UK
DOM calls took roughly 3–4 seconds, and its RBA network calls about half a second.
The alpha currently spends tens of seconds using Browser Use on both. Removing
the navigation controller was justified; claiming a speed improvement is not.

The next compiler work is connecting recipe-free task evidence to safe network
output discovery, particularly server-HTML responses, without rebuilding a browser
controller. Transport and Marketplace also need controlled diagnostics; neither
failure has been proven to be solely an upstream Browser Use limitation.

## Evidence and installation

- [Full ten-site raw report](../bench/runs/2026-09-07/alpha-ten-1788745698645.json)
- [RBA independent UI checks](../bench/runs/2026-09-07/alpha-ten-1788745698645-rba.oracle.json)
- [Architecture decision](decisions/0008-browser-use-baseline.md)

The live cohort ran the rewritten runtime during this turn; final packaging also
includes shutdown, input-admission and stale-plan-read hardening. Final-package
MCP acceptance was repeated after that hardening. It was not a second full ten-site
run on the final tarball.

Final tarball SHA-256:
`1214c41edaddc15c11044895305feac125cec923d00f4a66ecc0458b3a9d6f21`.

The durable runtime and Python environment are installed under the user's local
ClappingHands application directory. Codex's existing MCP configuration now points
there, with persistent task storage and the authorized saved Facebook profile.
The already-connected tool catalog still belongs to the prototype; reconnect the
MCP server or restart Codex to load the three management tools and generated tools.
No repository push, public release or Hacker News submission was made.
