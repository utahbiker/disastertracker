// test/details.test.mjs — the event-detail sidecar: exact correspondence
// with the labeled tier, famous-event ground truth, and field sanity.
// Run: node --test test/details.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const imp = JSON.parse(readFileSync(join(here, '..', 'data', 'impacts.json'), 'utf8'));
const det = JSON.parse(readFileSync(join(here, '..', 'data', 'impact-details.json'), 'utf8')).details;

test('every labeled event has a detail record, and only those', () => {
  for (let i = 0; i < imp.n; i++) {
    const labeled = imp.deaths[i] >= 1000 || imp.dmgK[i] >= 1e7;
    assert.equal(i in det, labeled, `idx ${i}: labeled=${labeled}`);
  }
  assert.ok(Object.keys(det).length > 400, `only ${Object.keys(det).length} detail records`);
});

test('2004 Indian Ocean tsunami: magnitude, multi-country breakdown', () => {
  let idx = -1;
  for (let i = 0; i < imp.n; i++) {
    if (imp.type[i] === 0 && imp.deaths[i] > 220000 && imp.deaths[i] < 235000 && imp.nC[i] >= 10) idx = i;
  }
  assert.ok(idx >= 0, 'tsunami event not found');
  const d = det[idx];
  assert.ok(Math.abs(d.mag - 9.1) < 0.15, `mag ${d.mag}`);
  assert.match(d.ms, /Moment/);
  assert.ok(d.bc.length === 10, `bc rows ${d.bc.length}`); // capped top-10 of 12+
  assert.equal(d.bc[0].c, 'Indonesia');
  assert.ok(d.bc[0].d > 150000);
  assert.equal(d.st, 'Tsunami');
});

test('field sanity across all detail records', () => {
  let withEnd = 0, withCountries = 0;
  for (const [k, d] of Object.entries(det)) {
    const i = Number(k);
    if (d.end !== undefined) { assert.ok(d.end > imp.day[i], `end before start at ${k}`); withEnd++; }
    if (d.loc) assert.ok(d.loc.length <= 180);
    for (const f of ['inj', 'aff', 'hml', 'insK']) {
      if (d[f] !== undefined) assert.ok(Number.isFinite(d[f]) && d[f] >= 0, `${f} at ${k}`);
    }
    // magnitude may be negative (cold waves are measured in °C)
    if (d.mag !== undefined) assert.ok(Number.isFinite(d.mag), `mag at ${k}`);
    if (d.bc) {
      withCountries++;
      assert.ok(d.bc.length >= 1 && d.bc.length <= 10);
      // sorted worst-first by deaths
      for (let j = 1; j < d.bc.length; j++) assert.ok(d.bc[j - 1].d >= d.bc[j].d || d.bc[j - 1].d === d.bc[j].d);
    }
  }
  assert.ok(withEnd > 100, `only ${withEnd} events carry an end date`);
  assert.ok(withCountries > 50, `only ${withCountries} multi-country breakdowns`);
});
