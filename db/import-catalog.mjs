#!/usr/bin/env node
// disaster-tracker/db/import-catalog.mjs
//
// Loads the bundled catalog data files into the optional Supabase mirror
// (table from 0001_earthquake_catalog.sql). Idempotent: rows are upserted on
// the (occurred_at, latitude, longitude, source) unique key.
//
// Usage:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node disaster-tracker/db/import-catalog.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));
const EPOCH_2000 = Date.UTC(2000, 0, 1);

function decodeRows(col, sourceFor) {
  const rows = [];
  let accMin = 0;
  for (let i = 0; i < col.n; i++) {
    accMin += col.t[i];
    rows.push({
      occurred_at: new Date(accMin * 60000 + EPOCH_2000).toISOString(),
      latitude: col.lat[i] / 100,
      longitude: col.lon[i] / 100,
      depth_km: col.dep[i] < 0 ? null : col.dep[i],
      magnitude: col.mag[i] < 0 ? null : col.mag[i] / 10,
      source: sourceFor(accMin, i),
      event_name: null,
    });
  }
  return rows;
}

const modern = load('catalog-modern.json');
const bridgeStartMin = modern.meta.coverage.bridgeStartMin;
const rows = [
  ...decodeRows(modern, (min) => (min >= bridgeStartMin ? 'bridge' : 'comcat')),
  ...decodeRows(load('catalog-instrumental.json'), () => 'iscgem'),
  ...load('catalog-historical.json').events.map((e) => ({
    occurred_at: new Date(Date.UTC(e.y, 0, 1)).toISOString(),
    latitude: e.lat / 100,
    longitude: e.lon / 100,
    depth_km: null,
    magnitude: e.mag < 0 ? null : e.mag / 10,
    source: 'ngdc',
    event_name: e.name || null,
  })),
];
console.log(`importing ${rows.length} rows…`);

const CHUNK = 2000;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const res = await fetch(`${URL_BASE}/rest/v1/earthquake_events?on_conflict=occurred_at,latitude,longitude,source`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(chunk),
  });
  if (!res.ok) {
    console.error(`chunk ${i / CHUNK}: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  if ((i / CHUNK) % 10 === 0) console.log(`  ${i + chunk.length}/${rows.length}`);
}
console.log('done.');
