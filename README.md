# Disaster Probability Tracker

A static, dependency-free web app that answers questions like:

> *"What's the probability of an M 7+ earthquake within 200 km of Draper, Utah in the next
> 30 years?"* — with a defensible number, an honest uncertainty band, and the receipts.

Pick a magnitude, pick anywhere on Earth (or a local disc around any point — click the map,
choose a preset, or use device geolocation), and scrub forward in time to watch the cumulative
probability grow. Every number comes from real merged earthquake catalogs (193k+ events,
1900→today) through estimators documented at a scrutinize-me level in
[METHODOLOGY.md](METHODOLOGY.md) and pinned by a 24-test suite.

Earthquakes are the first hazard; the architecture (complete historical catalog → explicit
completeness windows → empirical rates with exact uncertainty → Poisson + renewal probability
models) is the template for the rest (see Roadmap).

## Run it

It's a fully static site — any static host works, no build step, no server code, no keys.

```bash
cd disaster-tracker
python3 -m http.server 8080     # or any static file server
# open http://localhost:8080
```

Deploy = copy this directory to any static hosting. The app must be *served* (not opened via
`file://`) because it fetches its data files and uses ES modules.

### Production: tracker.goinwardout.com (Cloudflare Pages)

The goinwardout.com zone is on Cloudflare (same setup as the retreat site). One-time setup in
the Cloudflare dashboard — no build step, so the config is minimal:

1. **Workers & Pages → Create → Pages → Connect to Git** → select `utahbiker/go-inward-out`.
2. Production branch: `main` · Build command: *(leave empty)* · Build output directory:
   `disaster-tracker`.
3. After the first deploy: **Custom domains → Set up a custom domain** →
   `tracker.goinwardout.com`. The zone is already on Cloudflare, so it creates the CNAME
   record automatically and issues the cert.

Every push to `main` redeploys automatically (a copy of static files — seconds, no minutes
burned). `_headers` in this directory sets edge/browser caching: catalog data 1 day, app code
1 hour.

Alternative without the dashboard: `npx wrangler pages deploy disaster-tracker
--project-name gio-tracker` after `npx wrangler login` on any machine.

**Live data:** on load the app fetches all M5+ events since the bundled catalog's end straight
from the USGS public API (browser-side, CORS-enabled, no key) and caches them in
`localStorage`. Offline it degrades honestly: statistics are evaluated as of the bundled data
edge and a red banner says so.

## Layout

```
disaster-tracker/
  index.html            the app shell
  app.js                UI, canvas charts, live USGS top-up
  engine.js             ALL statistics — pure ESM, browser + Node, no dependencies
  style.css
  data/
    catalog-modern.json        ComCat M4.5+ 2000→2024 + bridge (columnar, delta-encoded)
    catalog-instrumental.json  ISC-GEM Mw 1900–1999
    catalog-historical.json    NGDC significant events 10 AD–1899 (context display only)
    completeness.json          per-threshold completeness windows (the policy file)
  etl/build-catalog.mjs  rebuilds data/ from the two public source datasets
  test/engine.test.mjs   24 tests: special functions, estimator recovery, published benchmarks
  db/                    OPTIONAL Supabase mirror of the catalog (schema + importer)
  METHODOLOGY.md         full statistical methodology + citations + limitations
```

## Tests

```bash
node --test disaster-tracker/test/engine.test.mjs
```

Pins χ²/Γ/digamma special functions to table values, recovers known parameters from synthetic
data, and checks the shipped catalog against published benchmarks (global b-value, USGS
long-term M7+/M8+ rates, the M9 count since 1900, tapered-G-R corner magnitude, and consistency
with the Utah Working Group's Wasatch Front numbers). See METHODOLOGY.md § 4.

## Refreshing the bundled data

The bundled catalog is a build artifact of `etl/build-catalog.mjs` over two public datasets:

```bash
git clone --depth 1 https://github.com/SwissRe/Historical-Earthquake-Statistics-Dataset
git clone --depth 1 https://github.com/nadeeshafdo/SeismicDataWorldwide
node disaster-tracker/etl/build-catalog.mjs \
  --comcat  SeismicDataWorldwide/query_M4.5+_2000-2024.csv \
  --swissre Historical-Earthquake-Statistics-Dataset/Historical_Earthquake_Dataset.geojson \
  --out     disaster-tracker/data
node --test disaster-tracker/test/engine.test.mjs   # always re-verify after a rebuild
```

This is rarely needed — the runtime USGS top-up keeps the app current on its own. Rebuild when a
better long-run source appears (e.g., a newer ISC-GEM release) or to fold the top-up era into
the bundle.

Licensing: ComCat/NGDC data are US-government public domain; the ISC-GEM-derived portion is
CC BY-SA 3.0 (attributed in-app and in METHODOLOGY.md).

## Optional: mirror the catalog into Supabase

The app is intentionally database-free (the catalog is small, immutable, and ships as static
files — that's the whole database for v1). If/when server-side features need it (per-user saved
locations, cross-hazard queries, larger catalogs), `db/` contains:

- `db/0001_earthquake_catalog.sql` — table schema with explicit role grants + RLS
  (public read-only), following the ADR-010 grant discipline
- `db/import-catalog.mjs` — loads `data/*.json` into that table via the service-role key

Apply the SQL through your project's migration tooling, then:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node disaster-tracker/db/import-catalog.mjs
```

## Roadmap — other hazards

Same discipline per hazard, each with its own completeness story:

| Hazard | Planned source | Statistical object |
|---|---|---|
| Hurricanes / tropical cyclones | NOAA HURDAT2 (1851→) + IBTrACS | Saffir–Simpson exceedance per coastal segment |
| Tornadoes | NOAA/SPC severe weather DB (1950→) | EF-scale exceedance per region (big reporting-completeness correction needed) |
| Floods | USGS streamgauge annual peaks + NOAA Storm Events | annual exceedance probability per basin |
| Volcanoes | Smithsonian Global Volcanism Program | per-volcano VEI exceedance from Holocene records |

## What this is not

Not a prediction system (none exists), not a site-specific shaking model (no ground-motion —
occurrence only, not PSHA), and not a substitute for USGS NSHM / Utah Working Group numbers
where paleoseismic data dominate (the app tells you when that's the case). Details:
[METHODOLOGY.md § 5](METHODOLOGY.md).
