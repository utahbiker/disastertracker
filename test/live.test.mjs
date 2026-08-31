// test/live.test.mjs — "Happening now" layer: the pulse verdict statistics,
// the catalog-pinned rate constant, and defensive feed parsing (fixtures —
// the live endpoints are exercised only in the browser).
// Run: node --test test/live.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from '../engine.js';
import * as L from '../live.js';

const here = dirname(fileURLToPath(import.meta.url));

test('M5_ANNUAL_RATE is pinned to the shipped catalog (drift guard)', () => {
  const cat = E.decodeCatalog(JSON.parse(readFileSync(join(here, '..', 'data', 'catalog-modern.json'), 'utf8')));
  const a = E.yearToMin('2000-01-01'), b = E.yearToMin('2024-01-08');
  let n = 0;
  for (let i = 0; i < cat.n; i++) {
    if (cat.mag[i] >= 5.0 - E.EPS_MAG && cat.t[i] >= a && cat.t[i] < b) n++;
  }
  const lambda = n / ((b - a) / E.MIN_PER_YEAR);
  assert.ok(Math.abs(lambda - L.M5_ANNUAL_RATE) / lambda < 0.01,
    `live.js M5_ANNUAL_RATE=${L.M5_ANNUAL_RATE} vs catalog ${lambda.toFixed(1)} — update the constant`);
});

test('seismicPulseVerdict: exact central band, sane verdicts', () => {
  const v = L.seismicPulseVerdict(146);
  assert.ok(Math.abs(v.mu - 146) < 1.5, `mu=${v.mu}`);
  assert.ok(v.lo < v.mu && v.mu < v.hi);
  assert.equal(v.verdict, 'normal');
  assert.equal(L.seismicPulseVerdict(v.hi + 1).verdict, 'elevated');
  assert.equal(L.seismicPulseVerdict(v.lo - 1).verdict, 'quiet');
  // the band must actually cover ≥ 95% of the Poisson mass
  let mass = 0, pmf = Math.exp(-v.mu);
  for (let k = 0; k <= v.hi + 50; k++) {
    if (k >= v.lo && k <= v.hi) mass += pmf;
    pmf *= v.mu / (k + 1);
  }
  assert.ok(mass >= 0.95, `band mass ${mass}`);
  // band should be tight-ish, not degenerate (±~2.5σ of √mu)
  assert.ok(v.hi - v.lo < 6 * Math.sqrt(v.mu), `band width ${v.hi - v.lo}`);
});

test('parseGdacs: levels, ordering, defensive handling', () => {
  const gj = {
    features: [
      { properties: { eventtype: 'TC', alertlevel: 'Orange', eventname: 'Cyclone Test', country: 'Fiji', fromdate: '2026-08-28T00:00:00' } },
      { properties: { eventtype: 'EQ', alertlevel: 'Green', country: 'Chile' } },
      { properties: { eventtype: 'FL', alertlevel: 'Red', name: 'Flood Test', country: 'India', url: { report: 'https://gdacs.org/x' } } },
      { properties: {} },              // no alert level → skipped
      { junk: true },                  // malformed → skipped
      { properties: { eventtype: 'XX', alertlevel: 'orange', name: 'Unknown hazard' } },
    ],
  };
  const r = L.parseGdacs(gj);
  assert.equal(r.greens, 1);
  assert.equal(r.alerts.length, 3);
  assert.equal(r.alerts[0].level, 'red');       // red sorts first
  assert.equal(r.alerts[0].name, 'Flood Test');
  assert.equal(r.alerts[0].url, 'https://gdacs.org/x');
  assert.equal(r.alerts[1].level, 'orange');
  assert.equal(L.parseGdacs(null).alerts.length, 0);
  assert.equal(L.parseGdacs({}).alerts.length, 0);
});

test('parseReliefWeb: statuses map to rows, others skipped', () => {
  const rw = {
    data: [
      { fields: { name: 'Cyclone Something', status: 'alert', primary_type: { name: 'Tropical Cyclone' }, primary_country: { name: 'Madagascar' }, date: { created: '2026-08-20T00:00:00' } } },
      { fields: { name: 'Old Drought', status: 'past' } },
      { fields: { name: 'Flood Now', status: 'ongoing', primary_country: { name: 'Pakistan' } }, href: 'https://api.reliefweb.int/x' },
    ],
  };
  const r = L.parseReliefWeb(rw);
  assert.equal(r.alerts.length, 2);
  assert.equal(r.alerts[0].name, 'Cyclone Something');
  assert.equal(r.alerts[0].level, 'orange');
  assert.equal(r.alerts[1].level, 'ongoing');
  assert.equal(r.alerts[1].url, 'https://api.reliefweb.int/x');
  assert.equal(L.parseReliefWeb(null).alerts.length, 0);
});
