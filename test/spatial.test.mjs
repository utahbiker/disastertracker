// test/spatial.test.mjs — kernel-smoothed seismicity: kernel math against
// closed forms, the σ→0 limit, spatial continuity (the property the hard
// circle lacks), weighted-fit consistency, and the pseudo-prospective
// validation verdict as a regression guard.
// Run: node --test test/spatial.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from '../engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));
const cat = E.mergeCatalogs(
  E.decodeCatalog(load('catalog-modern.json')),
  E.decodeCatalog(load('catalog-instrumental.json')),
);
const completeness = load('completeness.json');
const NOW = E.msToMin(Date.UTC(2024, 0, 1));
const DRAPER = { lat: 40.5247, lon: -111.8638 };

test('gaussianCircleMass matches the closed form at d=0 and behaves at limits', () => {
  // centered: mass inside R is 1 − exp(−R²/2σ²) (Rayleigh CDF)
  for (const [R, s] of [[100, 50], [200, 25], [50, 50]]) {
    const exact = 1 - Math.exp(-(R * R) / (2 * s * s));
    assert.ok(Math.abs(E.gaussianCircleMass(0, R, s) - exact) < 1e-9, `R=${R} σ=${s}`);
  }
  // σ→0 recovers the hard indicator
  assert.equal(E.gaussianCircleMass(99, 100, 0), 1);
  assert.equal(E.gaussianCircleMass(101, 100, 0), 0);
  // exactly half the mass sits inside when the epicenter is on the rim
  // (large R/σ: the rim is locally a straight line)
  assert.ok(Math.abs(E.gaussianCircleMass(200, 200, 10) - 0.5) < 0.02);
  // monotone decreasing in distance, bounded [0, 1]
  let prev = 1.1;
  for (let d = 0; d <= 400; d += 10) {
    const m = E.gaussianCircleMass(d, 150, 40);
    assert.ok(m >= 0 && m <= 1 && m <= prev + 1e-12, `d=${d}`);
    prev = m;
  }
});

test('regionWeights: interior events get ~full weight; σ→0 equals regionIndices', () => {
  const R = 200, sig = 50;
  const rw = E.regionWeights(cat, DRAPER.lat, DRAPER.lon, R, sig);
  const hard = new Set(E.regionIndices(cat, DRAPER.lat, DRAPER.lon, R));
  for (let k = 0; k < rw.idx.length; k++) {
    const d = E.haversineKm(DRAPER.lat, DRAPER.lon, cat.lat[rw.idx[k]], cat.lon[rw.idx[k]]);
    if (d < R - 4 * sig) assert.ok(rw.w[k] > 0.999, `interior event d=${d} w=${rw.w[k]}`);
  }
  const rw0 = E.regionWeights(cat, DRAPER.lat, DRAPER.lon, R, 0);
  assert.equal(rw0.idx.length, hard.size);
  assert.ok(rw0.w.every((w) => w === 1));
});

test('smoothed rates change smoothly as the pin moves (hard counts jump)', () => {
  // 20 pin positions 3 km apart: the smoothed effective count must never
  // jump by anything close to a whole event between neighbors
  let prevN = null, maxStep = 0;
  for (let k = 0; k < 20; k++) {
    const lat = DRAPER.lat + (k * 3) / 111.2;
    const model = E.buildModel(cat, completeness, NOW, { lat, lon: DRAPER.lon, radiusKm: 150, sigmaKm: 50 });
    const r = E.empiricalRate(cat, 5.0, completeness, NOW, model.smoothIdx, model.smoothW);
    if (prevN !== null) maxStep = Math.max(maxStep, Math.abs(r.n - prevN));
    prevN = r.n;
  }
  assert.ok(maxStep < 0.35, `max 3-km step in effective count: ${maxStep}`);
});

test('smoothed and hard-circle rates agree to within a factor of 2 at Draper', () => {
  const region = { ...DRAPER, radiusKm: 200 };
  const hard = E.buildModel(cat, completeness, NOW, region);
  const smooth = E.buildModel(cat, completeness, NOW, { ...region, sigmaKm: 50 });
  const rh = E.empiricalRate(cat, 4.5, completeness, NOW, hard.indices);
  const rs = E.empiricalRate(cat, 4.5, completeness, NOW, smooth.smoothIdx, smooth.smoothW);
  assert.ok(rs.n > 0 && rh.n > 0);
  const ratio = rs.lambda / rh.lambda;
  assert.ok(ratio > 0.5 && ratio < 2, `smoothed/hard rate ratio ${ratio}`);
});

test('weighted G-R with unit weights equals the unweighted fit', () => {
  const mags = [5.0, 5.1, 5.3, 5.0, 5.6, 6.1, 5.2, 5.0, 5.4, 5.8, 5.1, 5.0];
  const a = E.fitGutenbergRichter(mags, 5.0, 10);
  const b = E.fitGutenbergRichter(mags, 5.0, 10, 0.1, mags.map(() => 1));
  assert.ok(Math.abs(a.b - b.b) < 1e-12 && Math.abs(a.aAnnual - b.aAnnual) < 1e-12);
  // halving all weights halves the a-value's rate but leaves b untouched
  const c = E.fitGutenbergRichter(mags, 5.0, 10, 0.1, mags.map(() => 0.5));
  assert.ok(Math.abs(c.b - a.b) < 1e-12);
  assert.ok(Math.abs(Math.pow(10, a.aAnnual) / Math.pow(10, c.aAnnual) - 2) < 1e-9);
});

test('pseudo-prospective validation still adopts smoothing (regression guard)', () => {
  const out = execFileSync(process.execPath, [join(here, '..', 'backtest', 'spatial.mjs')], { encoding: 'utf8' });
  assert.match(out, /VERDICT: ADOPT/);
  // the shipped configuration (fixed σ=50 km) must show positive held-out
  // gain over the count baseline in the final-test section
  const finalSection = out.slice(out.indexOf('HELD-OUT TEST'));
  const m = finalSection.match(/fixed σ=50km\s+LL\/event [\d.-]+\s+gain vs M0 \+([\d.]+)/);
  assert.ok(m, 'fixed σ=50km row missing from held-out test');
  assert.ok(Number(m[1]) > 0.03, `held-out gain ${m[1]} nats/event too small`);
});
