# Disaster Tracker — Project Instructions

Statistical natural-disaster probability tracker. Live at **tracker.goinwardout.com**
(Cloudflare Pages, auto-deploys from `main`, no build step — the repo root IS the site).
Earthquakes are the first hazard; hurricanes/tornadoes/floods/volcanoes are stubbed.

This is its OWN product — split out of the go-inward-out repo 2026-08-30. GIO's
governance system (its ADRs, checklists, gate scripts) does not apply here.

## Read first

- `README.md` — layout, deploy, data-refresh commands, roadmap.
- `METHODOLOGY.md` — **the contract.** Every number the app shows must be produced by a
  method documented there, with citations. If you change the statistics, change the doc
  in the same commit. No invented precision, no "overdue meters" the data don't support.

## Architecture in one breath

`etl/build-catalog.mjs` merges two public catalog datasets into columnar JSON under
`data/` (checked in, ~4 MB). `engine.js` is ALL the statistics — pure ESM, zero deps,
runs identically in browser and Node. `app.js` is UI + hand-rolled canvas charts + a
browser-side live USGS top-up (M5+, cached in localStorage). `index.html` + `style.css`
round out the site. `db/` is an optional, unused-by-the-app Supabase mirror.

## Rules

- **Run `node --test test/engine.test.mjs` before every push** (CI runs it too). The
  suite pins special functions to table values and the shipped data to published
  seismological benchmarks — if a data rebuild or engine change moves a benchmark,
  understand why before touching the test.
- **Never hand-edit files under `data/`** — they are build artifacts of the ETL over the
  source datasets. No hand-injected events, even "obviously real" ones; currency comes
  from the runtime USGS top-up.
- **Honest degradation**: offline/preview builds evaluate statistics at the bundled data
  edge and say so. Never let missing catalog months count as quiet time.
- **Keep it dependency-free and build-free.** That property is why deploys are trivial
  and the preview artifact works. A library needs a strong reason.
- Canvas sizing gotcha: design heights are cached via `data-design-h` (`designHeight()`
  in app.js) because assigning `canvas.height` overwrites the attribute it was read
  from — re-reading it compounds by devicePixelRatio every frame (real shipped bug).
- Magnitude comparisons use `EPS_MAG` (engine.js) — magnitudes are Float32 and 5.7 is
  not representable; `>= m - 1e-9` drops boundary events (real shipped bug).

## Git identity

Jake Garrett / jakegarrett@gmail.com / GitHub: utahbiker
