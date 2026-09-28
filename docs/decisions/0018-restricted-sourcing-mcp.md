# 0018: Restricted local sourcing MCP

## Decision

Expose a separate Streamable HTTP MCP process for the Sydney Resale company. It
binds only to `127.0.0.1`, requires an owner-only bearer-token file, uses
stateless JSON responses, and advertises five read-only tools: current Facebook
Marketplace cards, exact Facebook listing details, one bounded Marketplace
photo read, and single or batched public Gumtree listing browser fallbacks.
The main Clapping Hands MCP, which can learn, record,
return a browser endpoint, and authenticate, is never registered with Restless.

The Facebook tools use CH's own saved Chromium profile and the already promoted
search and document plans. The browser profile and task store are explicit
configuration paths. Neither cookie values nor CDP endpoints leave CH. Returned
site text is untrusted data. Asking prices do not establish sale value or seller
availability. No seller messaging, offers, or purchase operation exists here.

The company Runtime is in a container and cannot launch a host stdio child or
reach host loopback. Restless therefore authenticates a company/actor/Work/Attempt
request, limits tool names, and forwards it through a narrow host proxy to this
loopback service. CH's bearer token authenticates that proxy as the only caller;
the actor scope is enforced and logged by Restless, not inferred from a CH HTTP
header. The proxy must not expose this service to a general browser tab or LAN.

## Failure and handoff

Every exact listing gets `complete`, `incomplete`, `unavailable`, `blocked`, or
`auth-required`. Missing fields and denied access never become a zero price or
an invented listing. Search login/checkpoint detection returns a fixed failure,
not an empty result set. The Gumtree path reports `browser-fallback` as its
engine; it has no promoted compilation claim.

The restricted service is stopped before the owner starts a visible CH login
window. Existing calls are stopped and their outcomes remain unverified. The
profile lock must be released before that window opens. The owner logs in and
closes the window; CH then restarts and verifies a fresh read. Closing a window
alone is not proof of authentication. Restless Company Computer is a different
browser and does not control this profile.

## Alternatives considered

- Copying cookies or the profile into Restless: duplicate account authority,
  profile corruption risk, and sessions that drift apart.
- Letting Restless call CH's general MCP: unnecessarily exposes recording,
  compiler, authentication, and raw browser capabilities.
- Binding CH directly to Docker bridge or LAN: expands network reach beyond the
  host-side proxy and complicates revocation.
