#!/usr/bin/env node
// etl/build-impacts.mjs
//
// Builds data/impacts.json — the multi-hazard impact catalog behind the
// master dashboard — from an EM-DAT public-table CSV export (the official
// CRED schema, "DisNo." era).
//
// Source used for the committed build: the full EM-DAT public table
// including historical events, downloaded 2026-08-31 from public.emdat.be
// (registered non-commercial access; xlsx converted to CSV verbatim).
// EM-DAT is © CRED / UCLouvain, free for non-commercial use — see README
// § Data licensing; the raw table is NOT redistributed in this repo, only
// this aggregated derived extract. To refresh: register at
// public.emdat.be, download the public table incl. historical events,
// re-run this ETL with --snapshot and --dataend.
//
// Key transformations:
//   - Natural disasters only; the Biological subgroup (epidemics,
//     infestations) is EXCLUDED — the dashboard models physical hazards.
//   - EM-DAT rows are per-country impacts; one physical event hitting N
//     countries is N rows sharing a "YYYY-NNNN" DisNo prefix. Rows are
//     aggregated to PHYSICAL EVENTS (deaths/damages summed) — required
//     for "an event killing ≥ X" to mean what it says.
//   - Per-event US-only impact components are kept alongside global
//     totals so the dashboard can scope to the United States.
//   - Damages use EM-DAT's CPI-adjusted series ('000 US$).
//
// Usage: node etl/build-impacts.mjs --emdat /path/to/emdat_data.csv
//          [--out data] [--snapshot YYYY-MM-DD] [--dataend YYYY-MM-DD]
//
// --dataend is the statistical truncation date: EM-DAT entry lag leaves the
// trailing months undercounted (verify against the monthly event counts —
// pick the last month whose count is in line with the long-run monthly
// mean). For the 2026-08-31 snapshot, monthly physical-event counts run
// normal (~24-33/mo) through 2026-04 and collapse after (8, 6, 12, 0), so
// the committed build truncates at 2026-04-30.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }),
);
if (!args.emdat) { console.error('usage: build-impacts.mjs --emdat <csv> [--out data]'); process.exit(1); }
const OUT = args.out ?? 'data';

// full CSV parse (quoted fields may contain commas AND newlines)
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
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

const HAZARDS = [
  'Earthquake', 'Storm', 'Flood', 'Drought', 'Extreme temperature',
  'Landslide', 'Wildfire', 'Volcanic activity', 'Other',
];
const TYPE_MAP = {
  'Earthquake': 0, 'Storm': 1, 'Flood': 2, 'Glacial lake outburst flood': 2,
  'Drought': 3, 'Extreme temperature': 4,
  'Mass movement (wet)': 5, 'Mass movement (dry)': 5,
  'Wildfire': 6, 'Volcanic activity': 7,
};

const EPOCH_1900 = Date.UTC(1900, 0, 1);
const dayOf = (y, m, d) => Math.round((Date.UTC(y, (m || 7) - 1, d || 15) - EPOCH_1900) / 86400000);

const rows = parseCsv(readFileSync(args.emdat, 'utf8').replace(/^﻿/, ''));
const header = rows[0];
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const need = (n) => { if (!(n in col)) throw new Error(`missing column: ${n}`); return col[n]; };
const C = {
  disno: need('DisNo.'), group: need('Disaster Group'), subgroup: need('Disaster Subgroup'),
  type: need('Disaster Type'), name: need('Event Name'), iso: need('ISO'), country: need('Country'),
  sy: need('Start Year'), sm: need('Start Month'), sd: need('Start Day'),
  deaths: need('Total Deaths'), dmgAdj: need("Total Damage, Adjusted ('000 US$)"),
};

// "United States" scope includes territories (Hurricane Maria's Puerto Rico
// toll belongs in US mode).
const US_ISO = new Set(['USA', 'PRI', 'VIR', 'GUM', 'ASM', 'MNP']);

const events = new Map();
let skippedBio = 0, skippedTech = 0, skippedOther = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (r.length < header.length - 2) continue;
  if (r[C.group] !== 'Natural') { skippedTech++; continue; }
  if (r[C.subgroup] === 'Biological') { skippedBio++; continue; }
  const type = TYPE_MAP[r[C.type]] ?? (r[C.subgroup] === 'Extra-terrestrial' ? 8 : 8);
  if (r[C.type] === 'Animal incident' || r[C.type] === 'Infestation') { skippedOther++; continue; }
  const key = r[C.disno].split('-').slice(0, 2).join('-');
  const y = parseInt(r[C.sy], 10);
  if (!Number.isFinite(y)) continue;
  let e = events.get(key);
  if (!e) {
    e = {
      day: dayOf(y, parseInt(r[C.sm], 10) || 0, parseInt(r[C.sd], 10) || 0),
      month: parseInt(r[C.sm], 10) || 0, year: y, type,
      deaths: 0, deathsUS: 0, dmgK: 0, dmgUSK: 0, nC: 0,
      name: '', country: '',
    };
    events.set(key, e);
  }
  e.nC++;
  const d = parseFloat(r[C.deaths]) || 0;
  const dmg = parseFloat(r[C.dmgAdj]) || 0;
  e.deaths += d; e.dmgK += dmg;
  if (US_ISO.has(r[C.iso])) { e.deathsUS += d; e.dmgUSK += dmg; }
  if (!e.name && r[C.name]) e.name = r[C.name].slice(0, 60);
  if (!e.country) e.country = r[C.country].slice(0, 40);
  // keep the earliest start date across country rows
  const rowDay = dayOf(y, parseInt(r[C.sm], 10) || 0, parseInt(r[C.sd], 10) || 0);
  if (rowDay < e.day) { e.day = rowDay; e.month = parseInt(r[C.sm], 10) || e.month; }
}

const list = [...events.values()].sort((a, b) => a.day - b.day);
console.log(`physical events: ${list.length} (skipped: ${skippedTech} technological, ${skippedBio} biological, ${skippedOther} other)`);

// snapshot edge: recent months are subject to EM-DAT entry lag, so the
// statistical record is truncated where the monthly counts stop looking
// complete (see header comment).
const SNAPSHOT = args.snapshot ?? '2026-08-31';
const DATA_END = args.dataend ?? '2026-04-30';
const [deY, deM, deD] = DATA_END.split('-').map(Number);
const dataEndDay = dayOf(deY, deM, deD) + 1; // exclusive end: day after DATA_END

// completeness windows chosen from the per-decade rate stabilization
// analysis (see METHODOLOGY.md § Multi-hazard impact model): the window for
// threshold T is the longest span over which the catalog records essentially
// every qualifying event.
const completeness = {
  deaths: [
    { min: 10, start: 2000 },
    { min: 100, start: 1990 },
    { min: 1000, start: 1930 },
    { min: 10000, start: 1900 },
  ],
  damageK: [ // CPI-adjusted '000 US$
    { min: 1e5, start: 2000 },   // ≥ $100M
    { min: 1e6, start: 1990 },   // ≥ $1B
    { min: 1e7, start: 1990 },   // ≥ $10B
  ],
};

const out = {
  meta: {
    source: `EM-DAT, CRED / UCLouvain, Brussels, Belgium — www.emdat.be. Public table incl. historical events, snapshot ${SNAPSHOT} (registered non-commercial download). Non-commercial use.`,
    snapshot: SNAPSHOT,
    scope: 'Natural physical hazards only; Biological subgroup (epidemics, infestations) excluded. Rows aggregated from per-country impacts to physical events by DisNo prefix.',
    hazards: HAZARDS,
    dataStart: '1900-01-01',
    dataEnd: DATA_END,
    dataEndDay,
    units: { day: 'days since 1900-01-01', dmgK: "CPI-adjusted '000 US$", deaths: 'total persons killed' },
    buildDate: new Date().toISOString().slice(0, 10),
  },
  completeness,
  n: list.length,
  day: list.map((e) => e.day),
  month: list.map((e) => e.month),
  type: list.map((e) => e.type),
  deaths: list.map((e) => Math.round(e.deaths)),
  deathsUS: list.map((e) => Math.round(e.deathsUS)),
  dmgK: list.map((e) => Math.round(e.dmgK)),
  dmgUSK: list.map((e) => Math.round(e.dmgUSK)),
  nC: list.map((e) => e.nC),
  // display labels only for events large enough to surface in the UI
  label: list.map((e) => (e.deaths >= 1000 || e.dmgK >= 1e7
    ? (e.name ? `${e.name} (${e.country}${e.nC > 1 ? ` +${e.nC - 1}` : ''})` : `${HAZARDS[e.type]} — ${e.country}${e.nC > 1 ? ` +${e.nC - 1}` : ''}`)
    : '')),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'impacts.json'), JSON.stringify(out));
console.log(`written ${OUT}/impacts.json (${(JSON.stringify(out).length / 1e6).toFixed(2)} MB)`);
const d100 = list.filter((e) => e.deaths >= 100 && e.year >= 1990).length / (2024.16 - 1990);
console.log(`sanity: λ(deaths ≥ 100, 1990+) = ${d100.toFixed(1)}/yr`);
