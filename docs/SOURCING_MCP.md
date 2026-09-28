# Sydney Resale sourcing MCP

This dedicated server gives Restless five read-only CH tools. Facebook search
uses the saved CH login and retrieves current Sydney listings within 100 km,
newest first by default. Callers can choose seven days, no listing-age filter,
or Facebook relevance ordering. Exact Facebook detail reads use the
promoted document plan. Gumtree uses a public browser fallback and reports
access refusal explicitly. Text from listings is untrusted; listed asks and
seller availability are not verified transactions.

## Host setup

Build with `npm run build` using Node 22.18+. A packed release must include
`dist-alpha/src/sourcing-server.js`, `dist-alpha/scripts/sourcing-operator.js`,
`npm-shrinkwrap.json`, and the systemd templates; the runtime hashes the
included lockfile and built code to identify the installed release. The
owner-local Marketplace plans and browser profile are never packaged. Point
the service at the existing
CH data directory (`.data/alpha` in the original checkout) and the separately
saved, authenticated browser profile (`.data/browser-profile` in that checkout).
Use absolute paths. Do not point it at `.data/alpha/profiles/...` unless that is
the profile actually authenticated by the owner.

Set these environment variables for the host process:

```text
CLAPPING_HANDS_DATA_DIR=/absolute/path/to/original/clapping-hands/.data/alpha
CLAPPING_HANDS_AUTH_PROFILE_DIR=/absolute/path/to/original/clapping-hands/.data/browser-profile
CLAPPING_HANDS_CHROME_PATH=/absolute/path/to/chrome
CLAPPING_HANDS_SOURCING_TOKEN_FILE=/absolute/path/to/owner-only-token-file
CLAPPING_HANDS_SOURCING_PORT=8799
```

The token file must be a regular file owned by the process user, mode `0600`,
containing 32 random bytes as 64 lowercase hexadecimal characters. Do not put
its contents in a tool call, company document, log, or Git. Start
`dist-alpha/src/sourcing-server.js` with Node. The process binds only to
`127.0.0.1:<port>` and rejects requests with an `Origin` header or a different
`Host` header. `GET /health` and `POST /mcp` both require `Authorization: Bearer
<token>`. MCP is stateless Streamable HTTP with JSON responses. There is no
general CH tool registration on this endpoint.

`/health.status: "ready"` has `readinessScope: "service"` and means the MCP listener is running. Its `browser`
field separately reports the saved profile's lease and availability; an idle
profile is `start-unverified` until an actual browser read succeeds, and health
never asserts that Facebook authentication is valid. `toolCount` includes all
five restricted sourcing tools.

The MCP `initialize` response identifies the actual release as the package
version plus SHA-256 digests of its compiled source, dependency lockfiles, and
the two saved Marketplace plans loaded at startup. A later change to either
saved plan makes Facebook reads fail as `saved-plan-changed` until the owner
reviews the plan and restarts the service.
Restless pins that `serverInfo.version` together with the allowed tool schemas
at owner installation. A CH code, locked dependency, or saved-plan update
changes the advertised version and requires a deliberate Restless reinstall
before an actor can use the new release. Stage releases in distinct directories
instead of editing the running release in place.

For a persistent local installation, fill in the two checked-in examples under
`deploy/systemd/`, install the service under
`~/.config/systemd/user/clapping-hands-sourcing.service`, and save the filled
environment file as `~/.config/clapping-hands/sourcing.env` with mode `0600`.
Run `systemctl --user daemon-reload` and
`systemctl --user enable --now clapping-hands-sourcing.service`. The service
must point to a stable CH install with its Node dependencies present. Check
`systemctl --user is-active clapping-hands-sourcing.service` and make one
authenticated listing read after a restart; health alone checks only the MCP
listener and compiled plan files.

Install the checked-in `deploy/systemd/ch-sourcing.example` wrapper as the
owner-only `~/.local/bin/ch-sourcing`, with its Node and immutable release paths
filled in. It sources the same owner-only environment file as the service and
offers `ch-sourcing status|pause|login|resume`. `pause` signals only the Node
service main process, waits for it to exit, and checks the exact CH lease,
Chromium singleton, and profile-using Chrome process. It never deletes a lock.
An active read is cancelled as `owner-paused` or ends uncertain; make a fresh
read after hand-back. If the browser does not release its profile, the CLI
reports `recovery-required` or `pause-uncertain` and does not start another
browser. `resume` reports `running-unverified`; only a fresh listing read can
establish that Facebook authentication still works.

Restless must authenticate and scope each request to company, actor, Work, and
Attempt before proxying it from the container to host loopback. Keep the bearer
token in the host proxy's secret configuration; expose only an actor-scoped MCP
endpoint to the company runtime. Allow only the five tool names returned by
`tools/list`. Do not bind CH to Docker bridge or the LAN.

## Owner login and recovery

When Facebook says `auth-required`, the host owner runs `ch-sourcing pause`,
then `ch-sourcing login`. The owner signs in only in that visible CH window and
closes it. `ch-sourcing resume` restarts the service; call one exact listing read
to confirm login. The login helper reports only that the window closed, never
that authentication succeeded. Do not start a second Chromium against the
profile while the sourcing service owns it. A stale or ambiguous lock needs
guarded operator diagnosis; do not delete it by age. The Restless Company
Computer remains a separate profile and is not part of this handoff.

## Tool contracts

- `clapping_hands_marketplace_search({query, limit?, fastSearch?, age?, sort?})` returns up to
  24 current cards by default, their source and observation time, the listed asking-price
  basis, the search engine, the requested scope, and `status: complete` for
  a verified card read. `age` defaults to `1d` and `sort` to `newest`.
  `age=any, sort=relevance` can surface older negotiable listings. Every
  non-default scope uses a freshly checked visible browser page because the
  saved compiled plan proves only the one-day newest scope. `fastSearch`
  applies only to that default scope with `limit<=24` and defaults to `false` for the stable
  browser replay path. If compiled HTML misses current cards, CH checks strict
  cards on the rendered search page and labels that engine `visible-browser`.
  If some visible cards cannot be verified, it returns `partial` with
  `visibleCount` and `rejectedCount` rather than claiming complete coverage.
  A blocked/login read is an error, never a successful empty list. A failed or
  unproved empty read returns `search-unverified`.

  `limit=25–48` opts into a checked continuation on the exact search page in
  CH's saved browser. It collects distinct listing cards across at most four
  UI scrolls. This is a browser read, not a promoted network recipe; it can
  take longer than the 24-card path. The response includes `continuation` with
  `requestedLimit`, `scrollRounds`, `distinctObserved`, and `state`.
  `limit-reached` means the requested count was observed; `scroll-budget-reached`
  means the finite scroll budget ended with fewer verified cards and sets the
  top-level status to `partial`. `partial` does not mean no other listings
  exist. Invalid visible anchors also set `partial`; navigation, filter,
  authentication, or document failures remain typed errors. The default
  24-card compiled route and its fallback are unchanged.
- `clapping_hands_marketplace_details({urls, streamDetails?})` accepts 1–8
  `https://www.facebook.com/marketplace/item/<id>` URLs. A trailing slash is
  optional, and copied sharing query parameters or fragments are discarded;
  the exact item ID and Facebook origin remain required. Redirect aliases and
  other paths are rejected. Rows keep input order and have `complete`, `incomplete`,
  `unavailable`, `blocked`, or `auth-required` status. Only complete rows have
  title, displayed price, condition, and full description. `streamDetails`
  defaults to `false`.
- `clapping_hands_marketplace_photo({url, position})` reads one product-photo
  crop from an exact Marketplace item in the CH-owned browser. `position` is
  1–12 or `last`. It accepts the same canonical item URL variants as the
  details tool and returns bounded JPEG content plus an exact position when
  complete. It does not expose a signed image URL or prove condition.
- `clapping_hands_gumtree_public_listing({url})` accepts one exact public
  `https://www.gumtree.com.au/web/listing/<category>/<id>` URL. It returns a
  complete title, asking price, location, condition, and description only when
  all fields are available. Otherwise it returns a typed failure status. Its
  engine is `browser-fallback`; no Gumtree compilation speedup is claimed.
- `clapping_hands_gumtree_public_listings({urls})` accepts 1–8 distinct exact
  Gumtree listing URLs. It opens one browser session, reads the pages in input
  order, and returns one typed row per URL with `id`, `url`, `status`,
  `durationMs`, and complete fields only for `complete` rows. A site 403 remains
  `blocked`; one failed page does not erase the other rows. The batch includes
  `wallDurationMs` and the same source, engine, price-basis and observation
  labels as the single-read tool. A signed-in Facebook profile does not
  authenticate this separate public Gumtree browser. Page reads stop within a
  bounded time budget; unattempted URLs become `incomplete` with reason
  `batch-deadline-exceeded`. Failure to start or retain the browser session is
  a whole-tool error because no page was safely opened.

CH admits at most 16 reads at a time, including one active read, and starts them
in FIFO order. A waiting read that has not started within 60 seconds returns
`queue-timeout`; further arrivals at capacity return `runtime-busy`. Neither
failure starts a browser operation. Owner pause rejects waiting reads with
`owner-paused`. Batch up to eight exact detail URLs per call when practical:
queueing removes immediate burst failures but does not make the one saved
Facebook browser run requests in parallel. The server never returns cookies,
raw HTML, scripts, browser-control addresses, or seller contact actions.
