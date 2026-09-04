# Local Discourse fixture

The Discourse capability regression uses a loopback-only instance built from
the official Discourse source tree and official multi-architecture development
image. It creates one synthetic administrator, three synthetic categories, and
three synthetic topics. All benchmark-created topics and drafts are removed or
reset after each run.

The pagination regression temporarily adds 65 synthetic topics, captures three
real `/latest.json` pages twice, replaces every demonstrated topic identifier,
and checks that generic compiled replay returns each replacement topic exactly
once. Those extra topics are always removed after the run.

The pinned 2026-09-04 fixture is:

- Discourse source commit `4cefc8c471e4fb40aa1ce5710198bed2f1706474`
- `discourse/discourse_dev:20260812-0036`
- image digest `sha256:ed44e808f7430432712745da7245d6e256c0c4171d4c874772ca5b1b3d311242`
- loopback origin `http://127.0.0.1:18121`

The benchmark runner copies `clapping_hands_fixture.rb` into the container for
seeding and independent database oracles. Pass the rotated synthetic password
only through `CLAPPING_HANDS_DISCOURSE_PASSWORD`; credentials, cookies, and
draft bodies must not appear in committed reports.

Run the development server with `CI=1`,
`DISCOURSE_SKIP_CSS_WATCHER=1`, `LOAD_PLUGINS=0`, `UNICORN_WORKERS=1`, and
`UNICORN_SIDEKIQS=0`. Those settings retain the production UI exercised by the
benchmark while disabling development hot-reload watchers and background jobs
that are irrelevant to this synthetic fixture. The official image otherwise
exceeds an 8 GiB Docker Desktop VM during repeated watcher rebuilds.

The fixture deliberately reports draft counts. Discourse's rich composer can
autosave before the visible publish action, so “no topic was published during
prepare” and “prepare caused no remote mutation” are evaluated separately.
