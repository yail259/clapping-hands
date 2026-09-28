# 0019 — Finish the checked document before navigating again

Date: 2026-09-28

Status: implemented on `fix/streamed-fallback-same-response`; not deployed. The
production detail tool continues to default `streamDetails` to false.

## Problem

A paired read of four current Marketplace IDs on the existing production release
returned complete, identical fields in both modes, but early streaming succeeded
for only one. Three `projection-not-early` results opened a second page for the
full-document fallback. Median per-item time was 5.80 seconds for ordinary
document replay and 7.74 seconds with the streaming option. This small run
showed a real tail cost, not a reliable speed advantage.

## Decision

When early extraction misses, finish the **same** main-document response if its
navigation has already passed exact URL, HTTP 200, no-redirect, authentication,
and CDP network checks. Apply the existing learned full-document projection to
`response.text()`. Keep `engine: document-replay` and
`streamFallbackReason: projection-not-early`. If the body or projection fails,
close the page and use the existing fresh full-document fallback. Cached,
service-worker, and prefetch responses remain ineligible for same-response use.

## Verification and limit

The TypeScript check and clean build passed. A controlled local HTTP response
delayed the target JSON until after the five-second early-stream window; real
Chromium returned all four exact fields with `projection-not-early`,
`document-replay`, and **one** matching document request.

A second paired run on the same four live IDs after the patch returned complete,
identical title, ask, condition, and description in both modes. All four streamed
reads finished early. Its median per-item time was 2.63 seconds streamed versus
7.08 seconds ordinary replay. Because no live read entered the changed fallback
branch, this run does **not** measure the patch's latency gain or establish a
default-mode speedup. Keep streaming opt-in pending real fallback latency and
failure-rate evidence across varied listings.
