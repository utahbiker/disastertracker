#!/usr/bin/env node
// disaster-tracker/etl/build-catalog.mjs
//
// Merges two public earthquake catalog sources into the compact columnar
// data files the app ships with:
//
//   1. ComCat M4.5+ 2000-01-01 → 2024-01-08 (USGS ANSS ComCat, public domain)
//      via github.com/nadeeshafdo/SeismicDataWorldwide (query_M4.5+_2000-2024.csv)
//   2. Swiss Re Historical Earthquake Statistics Dataset (GeoJSON) combining
//      - NGDC/WDS Significant Earthquake Database, years 10–1899
//      - ISC-GEM Global Instrumental Catalogue v10, 1900–2020 (CC BY-SA 3.0)
//      - USGS ComCat M5.5+ depth≤70km, 2021 → 2025-06-05
//
// Cutover rules (documented in METHODOLOGY.md § Data):
//   - pre-1900:            Swiss Re NGDC rows   → catalog-historical.json (context only)
//   - 1900 → 1999-12-31:   Swiss Re ISC-GEM rows → catalog-instrumental.json
//   - 2000-01-01 → 2024-01-08: ComCat CSV rows  → catalog-modern.json
//   - 2024-01-09 → 2025-06-05: Swiss Re USGS rows → appended to catalog-modern.json
//     flagged `bridge` (M5.5+ shallow-only window; replaced wholesale by the
//     runtime USGS top-up when the app is online)
//
// Columnar format (all integers, arrays index-aligned, sorted by time):
//   { meta: {...}, n, t: [minutes since 2000-01-01T00:00Z, delta-encoded],
//     lat: [deg*100], lon: [deg*100], dep: [km, -1 = unknown], mag: [Mw*10] }
//
// Usage: node etl/build-catalog.mjs \
//          --comcat  /path/to/query_M4.5+_2000-2024.csv \
//          --swissre /path/to/Historical_Earthquake_Dataset.geojson \
//          --out     disaster-tracker/data

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }),
);
const COMCAT = args.comcat;
const SWISSRE = args.swissre;
const OUT = args.out ?? 'data';
if (!COMCAT || !SWISSRE) {
  console.error('usage: build-catalog.mjs --comcat <csv> --swissre <geojson> [--out <dir>]');
  process.exit(1);
}

const EPOCH_2000 = Date.UTC(2000, 0, 1); // ms
const COMCAT_END = Date.UTC(2024, 0, 8, 23, 59, 59); // last day covered by the CSV
const toMin = (ms) => Math.round((ms - EPOCH_2000) / 60000);

// ─── parse ComCat CSV ────────────────────────────────────────────────────
// RFC-4180-lite: quoted fields may contain commas (the `place` column does).
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const modern = []; // {ms, lat, lon, dep, mag}
{
  const lines = readFileSync(COMCAT, 'utf8').split('\n');
  const header = splitCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[col.type] !== 'earthquake') { dropped++; continue; }
    const mag = parseFloat(f[col.mag]);
    const lat = parseFloat(f[col.latitude]);
    const lon = parseFloat(f[col.longitude]);
    const ms = Date.parse(f[col.time]);
    if (!Number.isFinite(mag) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ms)) { dropped++; continue; }
    if (mag < 4.5) { dropped++; continue; }
    const dep = parseFloat(f[col.depth]);
    modern.push({ ms, lat, lon, dep: Number.isFinite(dep) ? dep : -1, mag });
  }
  console.log(`comcat: kept ${modern.length}, dropped ${dropped} (non-earthquake / unparseable / <4.5)`);
}

// ─── parse Swiss Re GeoJSON ──────────────────────────────────────────────
const sr = JSON.parse(readFileSync(SWISSRE, 'utf8'));
const instrumental = []; // ISC-GEM 1900–1999
const bridge = [];       // USGS 2024-01-09 → 2025-06-05
const historical = [];   // NGDC pre-1900, kept with names for context display
let srSkipped = 0;
for (const feat of sr.features) {
  const p = feat.properties;
  const [lon, lat] = feat.geometry.coordinates;
  const mag = p.magnitude;
  const ms = Date.parse(p.eventDate + 'T00:00:00Z');
  if (!Number.isFinite(ms) || !Number.isFinite(lat) || !Number.isFinite(lon)) { srSkipped++; continue; }
  const dep = Number.isFinite(p.focalDepth) ? p.focalDepth : -1;
  if (p.datasetSrc === 'NGDC') {
    // context catalog keeps unknown-magnitude rows (mag stored as -1)
    historical.push({ ms, lat, lon, dep, mag: Number.isFinite(mag) ? mag : -1, name: p.name ?? '' });
  } else if (p.datasetSrc === 'ISC-GEM') {
    if (!Number.isFinite(mag)) { srSkipped++; continue; }
    if (p.year >= 1900 && p.year <= 1999) instrumental.push({ ms, lat, lon, dep, mag });
    // 2000–2020 ISC-GEM rows are duplicates of ComCat coverage → skipped
  } else if (p.datasetSrc === 'USGS') {
    if (!Number.isFinite(mag)) { srSkipped++; continue; }
    if (ms > COMCAT_END) bridge.push({ ms, lat, lon, dep, mag });
    // 2021 → 2024-01-08 USGS rows are duplicates of ComCat coverage → skipped
  }
}
console.log(`swissre: instrumental ${instrumental.length}, bridge ${bridge.length}, historical ${historical.length}, skipped ${srSkipped}`);

// ─── emit columnar files ─────────────────────────────────────────────────
function columnar(events, meta) {
  events.sort((a, b) => a.ms - b.ms);
  const t = new Array(events.length);
  let prev = 0;
  for (let i = 0; i < events.length; i++) {
    const m = toMin(events[i].ms);
    t[i] = m - prev; // delta encoding; first entry is absolute
    prev = m;
  }
  return {
    meta,
    n: events.length,
    t,
    lat: events.map((e) => Math.round(e.lat * 100)),
    lon: events.map((e) => Math.round(e.lon * 100)),
    dep: events.map((e) => (e.dep < 0 ? -1 : Math.round(e.dep))),
    mag: events.map((e) => (e.mag < 0 ? -1 : Math.round(e.mag * 10))),
  };
}

mkdirSync(OUT, { recursive: true });
const buildDate = new Date().toISOString().slice(0, 10);

const bridgeStartMs = COMCAT_END + 1000;
const bridgeEndMs = bridge.length ? Math.max(...bridge.map((e) => e.ms)) : COMCAT_END;

const modernAll = modern.concat(bridge.map((e) => ({ ...e })));
const modernCol = columnar(modernAll, {
  id: 'modern',
  source: 'USGS ANSS ComCat (M4.5+, all depths) 2000-01-01 → 2024-01-08; Swiss Re/ComCat bridge (M5.5+, depth ≤70 km) → 2025-06-05',
  units: { t: 'minutes since 2000-01-01T00:00Z, delta-encoded', lat: 'deg*100', lon: 'deg*100', dep: 'km (-1 unknown)', mag: 'M*10' },
  coverage: {
    fullStart: '2000-01-01',
    comcatEnd: '2024-01-08',
    bridgeEnd: new Date(bridgeEndMs).toISOString().slice(0, 10),
    bridgeMinMag: 5.5,
    bridgeMaxDepthKm: 70,
    // runtime top-up: the app replaces every event after comcatEnd with a
    // live USGS query when online; `bridgeStartMin` marks the splice point.
    bridgeStartMin: toMin(bridgeStartMs),
  },
  buildDate,
});
writeFileSync(join(OUT, 'catalog-modern.json'), JSON.stringify(modernCol));

const instrCol = columnar(instrumental, {
  id: 'instrumental',
  source: 'ISC-GEM Global Instrumental Earthquake Catalogue (via Swiss Re dataset, CC BY-SA 3.0), 1900-1999, M5.5+ (complete: M7.5+ from 1900, M6.25+ from 1918, M5.5+ from 1964)',
  units: { t: 'minutes since 2000-01-01T00:00Z, delta-encoded', lat: 'deg*100', lon: 'deg*100', dep: 'km (-1 unknown)', mag: 'Mw*10' },
  coverage: { start: '1900-01-01', end: '1999-12-31' },
  buildDate,
});
writeFileSync(join(OUT, 'catalog-instrumental.json'), JSON.stringify(instrCol));

// historical keeps names; date precision is often year-only → context display only
historical.sort((a, b) => a.ms - b.ms);
const histOut = {
  meta: {
    id: 'historical',
    source: 'NGDC/WDS Significant Earthquake Database (via Swiss Re dataset), years 10-1899. Damaging/deadly/M7.5+/tsunamigenic events only — NOT a complete catalog; display context only, never used for rate estimation.',
    buildDate,
  },
  n: historical.length,
  events: historical.map((e) => ({
    y: new Date(e.ms).getUTCFullYear(),
    lat: Math.round(e.lat * 100),
    lon: Math.round(e.lon * 100),
    mag: e.mag < 0 ? -1 : Math.round(e.mag * 10),
    name: e.name.slice(0, 90),
  })),
};
writeFileSync(join(OUT, 'catalog-historical.json'), JSON.stringify(histOut));

// completeness windows — the single place these policy constants live.
// Sources: ISC-GEM catalogue documentation (Storchak et al. 2013) and ComCat
// global completeness ~M4.5 for the modern era.
const completeness = {
  note: 'Per-threshold observation windows used for all rate estimation. A magnitude threshold m uses the longest window in which the merged catalog is complete at m.',
  windows: [
    { minMag: 7.5, start: '1900-01-01' },
    { minMag: 6.5, start: '1918-01-01' },
    { minMag: 5.5, start: '1964-01-01' },
    { minMag: 4.5, start: '2000-01-01' },
  ],
  bandCaps: [
    // magnitude bands not covered after the ComCat CSV end (until the
    // runtime top-up arrives): [4.5, 5.5) ends at comcatEnd.
    { minMag: 4.5, maxMag: 5.5, end: '2024-01-08' },
  ],
  buildDate,
};
writeFileSync(join(OUT, 'completeness.json'), JSON.stringify(completeness, null, 2));

console.log('written:', OUT);
console.log('  catalog-modern.json      ', modernCol.n, 'events');
console.log('  catalog-instrumental.json', instrCol.n, 'events');
console.log('  catalog-historical.json  ', histOut.n, 'events');
