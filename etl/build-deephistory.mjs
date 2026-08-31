#!/usr/bin/env node
// etl/build-deephistory.mjs
//
// Builds data/deep-history.json — the documentary/geologic deep-time layer:
//
//   1. NCEI/WDS Global Significant Earthquake Database (NOAA, public domain):
//      destructive earthquakes 2150 BC → present (deaths, magnitude, tsunami
//      flag). Mirror used: github.com/rsizem2/noaa-earthquakes (official TSV,
//      snapshot 2021-03-08).
//   2. Smithsonian GVP Volcanoes of the World: confirmed Holocene eruptions
//      with VEI. Mirror used: the TidyTuesday 2020-05-12 extract of the GVP
//      database (github.com/rfordatascience/tidytuesday).
//
// What this layer is FOR (see METHODOLOGY.md Part III):
//   - Colossal-eruption occurrence rates (VEI≥6 from 1500 CE, VEI≥7 from
//     900 CE) — hazards the instrumental century alone cannot rate.
//   - The documented-catastrophes record across ~4 millennia (display).
//   - The completeness-ramp analysis that JUSTIFIES NOT extending the
//     dashboard's death-toll probability windows before 1900.
//
// Usage: node etl/build-deephistory.mjs --ncei <tsv> --gvp <eruptions.csv> [--out data]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }),
);
if (!args.ncei || !args.gvp) { console.error('usage: build-deephistory.mjs --ncei <tsv> --gvp <eruptions.csv> [--out data]'); process.exit(1); }
const OUT = args.out ?? 'data';

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ─── NCEI significant earthquakes ────────────────────────────────────────
const eqRows = parseDelimited(readFileSync(args.ncei, 'utf8'), '\t');
const eqHeader = eqRows[0].map((h) => h.replaceAll('"', ''));
const ec = Object.fromEntries(eqHeader.map((h, i) => [h, i]));
const quakes = [];
for (let i = 1; i < eqRows.length; i++) {
  const r = eqRows[i].map((v) => v.replaceAll('"', ''));
  const y = parseInt(r[ec['Year']], 10);
  if (!Number.isFinite(y)) continue;
  const mag = parseFloat(r[ec['Mag']]);
  const deaths = parseFloat(r[ec['Total Deaths']] || r[ec['Deaths']]);
  // keep rows that matter to the deep layer: any death toll, or a great quake
  if (!(deaths > 0) && !(mag >= 7.5)) continue;
  quakes.push({
    y,
    mag: Number.isFinite(mag) ? Math.round(mag * 10) / 10 : null,
    deaths: Number.isFinite(deaths) ? Math.round(deaths) : null,
    tsu: r[ec['Tsu']] ? 1 : 0,
    name: (r[ec['Location Name']] || '').replaceAll(/\s+/g, ' ').trim().slice(0, 60),
  });
}
quakes.sort((a, b) => a.y - b.y);
console.log(`NCEI quakes kept: ${quakes.length} (${quakes[0].y} → ${quakes[quakes.length - 1].y})`);

// ─── GVP eruptions ───────────────────────────────────────────────────────
const gvRows = parseDelimited(readFileSync(args.gvp, 'utf8'), ',');
const gvHeader = gvRows[0];
const gc = Object.fromEntries(gvHeader.map((h, i) => [h, i]));
const eruptions = [];
for (let i = 1; i < gvRows.length; i++) {
  const r = gvRows[i];
  if (r[gc['eruption_category']] !== 'Confirmed Eruption') continue;
  const y = parseInt(r[gc['start_year']], 10);
  const vei = parseInt(r[gc['vei']], 10);
  if (!Number.isFinite(y) || !Number.isFinite(vei)) continue;
  eruptions.push({ y, vei, name: r[gc['volcano_name']].slice(0, 40) });
}
eruptions.sort((a, b) => a.y - b.y);
console.log(`GVP confirmed eruptions with VEI: ${eruptions.length} (${eruptions[0].y} → ${eruptions[eruptions.length - 1].y})`);

// completeness windows for OCCURRENCE rates (see METHODOLOGY Part III):
// VEI≥6 documented reliably from ~1500 CE (Brown et al. 2014); VEI≥7 leaves
// unmistakable global traces (ice cores, tephra) — complete over the last
// ~1,100 years. Earthquake M≥8.5 stays instrumental (1900+): the NCEI
// century counts (3→6→7→9→11 from the 1500s) are a documentation ramp, so
// the pre-instrumental record must NOT feed occurrence rates.
const occurrence = {
  vei6: { min: 6, start: 1500 },
  vei7: { min: 7, start: 900 },
  m85: { min: 8.5, start: 1900 },
};

const out = {
  meta: {
    sources: [
      'NCEI/WDS Global Significant Earthquake Database, NOAA (public domain), 2150 BC → 2021-03 snapshot, via github.com/rsizem2/noaa-earthquakes',
      'Smithsonian Institution Global Volcanism Program, Volcanoes of the World — confirmed Holocene eruptions with VEI, via the TidyTuesday 2020-05-12 extract',
    ],
    quakesEnd: 2021, eruptionsEnd: 2020,
    note: 'Display + extreme-occurrence layer. Death tolls before 1900 are documentary estimates and NEVER feed the dashboard probability model.',
    buildDate: new Date().toISOString().slice(0, 10),
  },
  occurrence,
  quakes,
  eruptions,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'deep-history.json'), JSON.stringify(out));
console.log(`written ${OUT}/deep-history.json (${(JSON.stringify(out).length / 1e6).toFixed(2)} MB)`);
