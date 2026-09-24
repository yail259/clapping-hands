# ClappingHands 👏

Turn a user-authorized browser task into a reusable, typed MCP tool. Browser Use
handles navigation; ClappingHands records network evidence and accelerates repeats
when validation proves the compiled request matches the requested output.

**0.1.0-alpha.3 — read-only, experimental.** A rewrite of the original prototype,
not a beta or a claim to automate every website. The single navigation engine is
Browser Use. Stagehand and the custom navigation loop are no longer dependencies.

The experimental-alpha bar is deliberately finite: a verified production workflow,
safe controlled failure tests, and a checked installable package. Broader site
coverage, fresh human-authentication onboarding and matched production speed
benchmarks are next-milestone work, not claims made by this release.

**Current packaged production proof:** an Open Library search returning five
books with titles, authors, publication years and links learned from two browser
demonstrations, passed two exact unseen-input comparisons, and ran after restart
in **6.56 seconds with zero model calls**. A fresh independent browser check
matched the result. No site-specific compiler resources or program edits were
supplied. This is one workflow, not a ten-site success rate or a matched-input
speedup claim. See the [dated result](bench/runs/2026-09-08/openlibrary-packaged-acceptance.json)
for the exact tested archive and limitations. Chrome still starts for the session.

### Earlier experiments

[Model-written JavaScript experiment](docs/JAVASCRIPT_COMPILATION_EXPERIMENT.md):
seven of the ten workflows passed network-backed compilation checks; Marketplace
passed a browser-backed generated parser; eBay and BOM returned HTTP 403. Saved
programs were tested on unseen inputs and after restart, without rerunning Browser
Use. **Development integration now supports JavaScript compilation, promotion and
runtime dispatch for admitted resources; the full experiment coverage is not yet
available through that path.** Packaged fixture checks are reported against exact
archive hashes; they are not production-coverage signoff.
The report distinguishes independent browser checks from same-response parser
checks and retains failed attempts.

See [current completion audit](docs/RELEASE_COMPLETION_AUDIT.md) for remaining gates
and the scope of dated package verification.

[Latest ten-site results](docs/TEN_SITE_RESULTS_2026-09-07.md): six workflows have
verified acceleration and independent checks, one completed browser-only without
an independent oracle, and three were blocked or unreliable in this environment.
Five speedups use agent-free browser URL replay; one uses network execution.
These are selected read workflows, not a general-web success rate.

[Richer-workflow validation](docs/RICH_WORKFLOW_RESULTS_2026-09-07.md): Open Library
book lists, Find a Tender notices, and authenticated Marketplace current-price
listings have independently checked outputs. Transport's multi-input journeys
completed and repeated consistently but lack a completed independent oracle.
**None of these four richer workflows compiled in that earlier run.** The new
Open Library result above supersedes that limitation for its tested workflow only.
Structured browser replay and live session context remain gaps; neither the older
single-value speedups nor one new HTML workflow prove universal extraction.

[Earlier compiler restoration](docs/COMPILER_RESTORATION.md): the RBA regression
passed two unseen comparisons and a restarted network-only call (497 ms, zero
model calls; excludes session startup). An independent browser check matched all
three outputs. This repairs HTML network compilation, not the missing saved
general DOM-step backend or fresh-token support. See the latest report for the
subsequent ten-site run and explicit optimization follow-ups.

## How it works

1. Authenticate manually in a dedicated persistent browser when necessary.
2. Supply a goal, input/output JSON schemas and one or two input examples.
3. One successful run registers a tool, even if nothing can be compiled.
4. Two varied successful runs can produce a model-written JavaScript candidate
   from captured requests and response bodies. No site-specific navigation code
   is supplied. Request admission still limits which workflows can compile.
5. Two distinct, unseen calls compare that candidate against Browser Use before
   promotion. Only an evidence-backed stable candidate runs without the agent.
   A learned page URL/text plan can also accelerate supported searches without
   model calls; it still uses Chrome and is reported separately from network replay.
6. A failed compiled read degrades the candidate and falls back once to Browser
   Use. It does not enter a repair/retry loop. Current output is fetched each time.

Saved tools contain the goal, schemas and optional accelerator—not cached answers,
credentials or captured response bodies. Session cookies remain in the local
Chrome profile. Corrupt plans and uncertain profile ownership fail closed.

## Setup

Requires Node 22.18+, Python 3.12+, uv and Chrome. The default Chrome path targets
macOS; override it with CLAPPING_HANDS_CHROME_PATH on other installations.

From a source checkout:

```sh
npm ci
npm run setup:browser
npm run build
```

For a provided release archive, install it into your chosen runtime directory
instead. Replace `/path/to/release.tgz` with the actual archive path:

```sh
npm install /path/to/release.tgz --omit=dev --ignore-scripts
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python --require-hashes -r node_modules/clapping-hands/python/requirements-lock.txt
```

The archive contains built JavaScript, so do not run source build/test commands
inside the installed package. Use `node_modules/.bin/clapping-hands` as the MCP
command (an absolute path in your MCP client's configuration). This project is
still an unpublished alpha; these instructions do not imply registry availability.

Configure an authorized OpenAI-compatible model endpoint using GPT_BASE_URL and
GPT_API_KEY, or point CLAPPING_HANDS_CREDENTIAL_ENV_FILE at an existing local env
file containing those names. Never put the key in a goal or a checked-in file.
CLAPPING_HANDS_ENDPOINT_MODEL defaults to the Astra model already used in our
experiments. The Browser Use adapter uses structured Chat Completions; compiler
inference uses the existing AI SDK adapter. Not every compatible endpoint/model
has been tested.

Set CLAPPING_HANDS_BROWSER_USE_PYTHON to the absolute virtual-environment Python
path when launching outside the project directory. Set CLAPPING_HANDS_DATA_DIR to
an absolute persistent directory. Otherwise data lives under .data/alpha in cwd.

Launch the MCP server with:

```sh
node dist-alpha/src/alpha-server.js
```

MCP tools: clapping_hands_authenticate, clapping_hands_learn_read,
clapping_hands_prepare_from_captures, clapping_hands_recompile, clapping_hands_status,
and generated clapping_hands_do_<action> tools. Generated
tools advertise the caller's input and output schemas and are restored on restart.
Close the dedicated authentication window when finished; closing it is not itself
proof that the site accepted authentication. Stored profiles are reused without
exporting cookies.

`clapping_hands_status` reports `canRecompile`. When true,
`clapping_hands_recompile({action: "your_saved_action"})` uses retained compiler
evidence and the configured model without opening Chrome or repeating Browser
Use. The replacement is staged for two unseen comparisons; the existing program
is retained until those pass. Compiler failure does not erase the working task.
Older tasks without prepared compiler evidence report that limitation explicitly.

To reuse a pre-existing ClappingHands profile, set CLAPPING_HANDS_AUTH_PROFILE_DIR
and CLAPPING_HANDS_AUTH_PROFILE_ORIGIN (default origin: Facebook). Do not point
this at a Chrome profile currently in use. The runtime owns one operation at a time.

## Verification and limitations

### Reproduce the production example

After configuring the MCP server, call `clapping_hands_learn_read` with:

```json
{
  "action": "openlibrary_rich",
  "startUrl": "https://openlibrary.org/",
  "goal": "Search the catalog for query using the website. Return the first five books in default order, with exact displayed title, authors as an array of names, first publication year as displayed (empty string if missing), and absolute book URL. Do not borrow books or use an API instead of the website.",
  "inputSchema": {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "authors": {"type": "array", "items": {"type": "string"}},
        "year": {"type": "string"},
        "url": {"type": "string"}
      },
      "required": ["title", "authors", "year", "url"],
      "additionalProperties": false
    }
  },
  "examples": [{"query": "tolkien"}, {"query": "jane austen"}]
}
```

Call the generated `clapping_hands_do_openlibrary_rich` tool with
`{"query":"dune"}` and then `{"query":"moby dick"}`. Each must return
`outcome.status: completed`; a compiled candidate needs `shadowMatch: true` on
both calls to become stable. Restart the MCP server using the **same data
directory**, then call `{"query":"sherlock holmes"}`. Successful acceleration
reports `engine: network`, `modelCalls: 0` and `fallback: false`.

This example uses the configured paid model and visits the live website; results
and timing can change. If compilation is unavailable, the generated browser tool
can still work. Inspect its reported status instead of repeating demonstrations
automatically. Reuse saved compiler evidence when available.

### Maintainer checks

```sh
npm test
npm run smoke:alpha
npm run benchmark:ten
```

The smoke and benchmark commands use the configured paid model endpoint; the
benchmark visits live sites. Tests include local browser fixtures.

The controlled fixture has verified two Browser Use demonstrations, network
capture, automatic compilation, two held-out comparisons, persisted-plan reload
and model-free network execution after restart. This is not a production-site
success-rate claim. Live benchmark reports are under bench/runs; distinguish
agent-reported completion, independently checked output and compiled execution.
Unknown browser model-call counts are reported as null, never zero. The packaged
Open Library result above also verifies this sequence on a production read task;
authenticated end-to-end onboarding and broader current-package coverage remain
deferred validation, not completed checks or experimental-alpha launch blockers.

Current limits:

- Read-only tasks only. The prototype's write/commit tools are not exposed.
- Browser navigation stays on the task's origin. The caller can authorize exact
  additional API origins with `allowedNetworkOrigins` for observed JSON request
  compilation; passive capture alone does not grant access. Cross-origin auth or
  navigation transitions remain unsupported.
- Fresh-token/runtime-context network candidates are not promoted in this alpha;
  their working Browser Use task remains available.
- Model-free DOM replay and automatic plan repair are not active backends.
- A schema-valid result is not proof of factual correctness. Independent oracles
  are currently available for only part of the live benchmark cohort.
- Interrupted processes can leave a profile lock requiring inspection. Do not
  delete locks or reset profiles automatically.

## Responsible use

Use only accounts, workflows and data you are authorized to access. This is for
low-volume personal/workflow automation, not bulk harvesting. Respect site terms,
rate limits, privacy and access controls. Do not bypass CAPTCHA or access denial,
send messages, purchase, or change records through read-only tools. Low traffic
alone does not establish permission. These restrictions are not a legal immunity
or guarantee against misuse.

## Prototype history

The previous implementation remains recoverable from Git history. It is excluded
from the active build and npm package. Old plans are not silently migrated:
relearn them using the new baseline contract. Historical benchmark results remain
evidence about the prototype, not this release.
