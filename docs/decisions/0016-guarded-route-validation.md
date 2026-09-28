# 0016 — Guarded route candidates need a fresh caller seed and visible comparison

Date: 2026-09-25

Status: candidate validation integrated; ordinary task execution still uses the document path.

## Problem

The learned guarded-route request needs account and page session values that cannot be saved in a reusable plan. The browser sometimes emits no route response for a clicked search card. A quick replay result alone cannot prove that the listing fields are complete or current.

## Decision

Add an explicit `validate-route-json` caller recording purpose and a `clapping_hands_replay_route_candidate` MCP tool. The caller opens a **different** listing in the authorized session to supply a fresh route response. The tool checks the response against the saved operation and structural contract, extracts volatile values into a one-use process-local ticket, and replays the candidate for the held-out target in that browser document. It returns a clearly provisional typed result. The caller then opens the target page, makes all four output fields visible, and finishes the recording with those observed values.

The finish step requires visible evidence on the exact target path and equality for every typed field. A successful comparison is saved with the caller baseline evidence. Two distinct held-out matches are required for both the request and projection to become stable. A mismatch or attempted replay failure degrades the candidate; missing seed or missing visible evidence leaves it unpromoted. Browser Use or the already stable document projection remains the normal task fallback. The route plan stores neither request values nor cookies.

## Live smoke

One authenticated caller flow replayed two distinct held-out Marketplace listings. Each candidate result matched all four fields against a fresh document and visible page evidence. Replay operations took **780 ms** and **742 ms** respectively, excluding search, seed acquisition, browser startup and visible verification. The first comparison left the saved candidate provisional; the second changed the saved route status to stable. The flow used the same local MCP-facing runtime methods as the new tool. It did not exercise ordinary generated task execution or a search-to-two-detail benchmark, so no total speedup is claimed.

## Next gate

Expose a caller-seeded batch read path for a stable route plan, with explicit `seed-unavailable` and replay-failed outcomes and automatic document fallback. Measure total search-to-detail time and success rate across varied current listings. Route seed availability is currently the main bottleneck: a bounded training probe obtained usable responses for only two of seven card attempts.

## End-to-end timing check

Two further authenticated `makita impact driver` search-to-two-detail slices used the promoted route candidate and a separately promoted document projection as fallback. These were sequential exploratory runs with different current cards, not a paired benchmark. Each returned four typed fields for both items and matched fresh document reads performed after timing.

| Run | Search | Seed attempts and time | Detail path | Search-to-two-detail | Including browser launch |
| --- | ---: | ---: | --- | ---: | ---: |
| Fresh seed on first card | 2.66 s | 1 / 1.86 s | Route: 6.90 s, 0.85 s | **12.65 s** | 13.41 s |
| No seed from five cards | 3.73 s | 5 / 29.02 s | Document fallback: 3.15 s, 3.23 s | **39.93 s** | 43.82 s |

The earlier 16.84-second reference was a different single observation. Neither new run establishes an end-to-end speedup distribution, and neither approaches 10×. The 6.90-second first route call also shows that subsecond replays are not guaranteed. More importantly, a five-card seed hunt dominates the slow path. For a two-item batch, a future runtime should attempt at most one cheap seed and fall back promptly. The higher-upside engineering experiment is to validate whether the always-observed search request can supply a safe, operation-bound volatile context for the listing route. This must be proven on held-out listings; copying token-shaped fields across operations without a demonstrated contract is not admitted.
