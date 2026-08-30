// disaster-tracker/test/engine.test.mjs
// Run: node --test disaster-tracker/test/
//
// Two layers:
//   1. Special functions + estimators pinned against textbook values.
//   2. The full pipeline on the real shipped data files, pinned against
//      published seismological benchmarks (global b ≈ 1, USGS long-term
//      average rates: ~15 M7+/yr, ~1 M8+/yr, M9 ≈ 5 events since 1900).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from '../engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));

// ─── special functions ───────────────────────────────────────────────────

test('logGamma matches factorials', () => {
  assert.ok(Math.abs(E.logGamma(5) - Math.log(24)) < 1e-10);
  assert.ok(Math.abs(E.logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-10);
});

test('gammaP known values', () => {
  // P(1, x) = 1 - e^-x
  assert.ok(Math.abs(E.gammaP(1, 2) - (1 - Math.exp(-2))) < 1e-12);
  // chi-square CDF with 2 dof at x: P(1, x/2)
  assert.ok(Math.abs(E.gammaP(1, 5.991 / 2) - 0.95) < 1e-3);
});

test('chi2inv matches standard table', () => {
  assert.ok(Math.abs(E.chi2inv(0.95, 1) - 3.841) < 5e-3);
  assert.ok(Math.abs(E.chi2inv(0.95, 10) - 18.307) < 5e-3);
  assert.ok(Math.abs(E.chi2inv(0.025, 4) - 0.4844) < 5e-3);
});

test('digamma known values', () => {
  const EULER = 0.5772156649015329;
  assert.ok(Math.abs(E.digamma(1) + EULER) < 1e-10);
  assert.ok(Math.abs(E.digamma(2) - (1 - EULER)) < 1e-10);
});

test('poissonRateCI exact (Garwood) values', () => {
  // n=0, T=1: upper 95% bound = 3.689 (chi2inv(0.975,2)/2)
  const c0 = E.poissonRateCI(0, 1, 0.95);
  assert.equal(c0.lo, 0);
  assert.ok(Math.abs(c0.hi - 3.689) < 5e-3);
  // n=10, T=1: [4.795, 18.39] (standard exact Poisson CI table)
  const c10 = E.poissonRateCI(10, 1, 0.95);
  assert.ok(Math.abs(c10.lo - 4.795) < 0.01);
  assert.ok(Math.abs(c10.hi - 18.39) < 0.01);
});

test('fitGammaMLE recovers known parameters', () => {
  // deterministic pseudo-random gamma(k=2, theta=3) via sum of two exponentials
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const xs = [];
  for (let i = 0; i < 20000; i++) {
    xs.push(-3 * Math.log(1 - rnd()) - 3 * Math.log(1 - rnd()));
  }
  const fit = E.fitGammaMLE(xs);
  assert.ok(Math.abs(fit.k - 2) < 0.08, `k=${fit.k}`);
  assert.ok(Math.abs(fit.theta - 3) < 0.15, `theta=${fit.theta}`);
});

test('renewal conditional prob: exponential case is memoryless', () => {
  // k=1 gamma = exponential; conditional prob must equal unconditional
  const fit = { k: 1, theta: 2 }; // mean 2 years
  const p0 = E.renewalConditionalProb(fit, 0, 1);
  const p5 = E.renewalConditionalProb(fit, 5, 1);
  assert.ok(Math.abs(p0 - p5) < 1e-9);
  assert.ok(Math.abs(p0 - (1 - Math.exp(-0.5))) < 1e-9);
});

test('quasi-periodic renewal probability rises with elapsed time', () => {
  const fit = { k: 4, theta: 0.5 }; // mean 2 yr, CV 0.5
  const early = E.renewalConditionalProb(fit, 0.5, 1);
  const late = E.renewalConditionalProb(fit, 3, 1);
  assert.ok(late > early);
});

test('haversine: known distance', () => {
  // SLC airport → Denver ≈ 600 km
  const d = E.haversineKm(40.788, -111.978, 39.856, -104.673);
  assert.ok(d > 590 && d < 640, `d=${d}`);
});

test('fitGutenbergRichter on synthetic G-R sample', () => {
  // inverse-CDF sample of exponential magnitudes, b=1, mc=5, binned to 0.1
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const beta = Math.log(10) * 1.0;
  const mags = [];
  for (let i = 0; i < 50000; i++) {
    // generate from the lower bin EDGE (4.95) so that after 0.1-rounding the
    // 5.0 bin spans [4.95, 5.05) — the assumption behind Tinti–Mulargia
    const m = 4.95 - Math.log(1 - rnd()) / beta;
    mags.push(Math.round(m * 10) / 10);
  }
  const fit = E.fitGutenbergRichter(mags.filter((m) => m >= 5), 5, 10);
  assert.ok(Math.abs(fit.b - 1.0) < 0.02, `b=${fit.b}`);
});

// ─── the shipped data ────────────────────────────────────────────────────

const modern = E.decodeCatalog(load('catalog-modern.json'));
const instrumental = E.decodeCatalog(load('catalog-instrumental.json'));
const completeness = load('completeness.json');
const cat = E.mergeCatalogs(instrumental, modern);
// evaluate "now" at the bridge end so tests are reproducible
const nowMin = E.yearToMin('2025-06-05');

test('catalog merge is time-sorted and sized right', () => {
  assert.equal(cat.n, modern.n + instrumental.n);
  for (let i = 1; i < cat.n; i += 997) assert.ok(cat.t[i] >= cat.t[i - 1]);
});

test('global b-value ≈ 1 (published global average 0.9–1.1)', () => {
  const model = E.buildModel(cat, completeness, nowMin);
  assert.ok(model.gr, 'G-R fit exists');
  assert.ok(model.gr.b > 0.85 && model.gr.b < 1.2, `b=${model.gr.b}`);
  assert.ok(model.gr.sigmaB < 0.02, `sigma=${model.gr.sigmaB}`);
});

test('global M7+ rate matches USGS long-term average (~12–18/yr)', () => {
  const r = E.empiricalRate(cat, 7.0, completeness, nowMin);
  assert.ok(r.lambda > 10 && r.lambda < 20, `λ(M7+)=${r.lambda}`);
});

test('global M8+ rate matches long-term average (~0.5–1.5/yr)', () => {
  const r = E.empiricalRate(cat, 8.0, completeness, nowMin);
  assert.ok(r.lambda > 0.4 && r.lambda < 1.6, `λ(M8+)=${r.lambda}`);
});

test('M9 events since 1900: the known giants', () => {
  // 1960 Chile (9.6), 1964 Alaska (9.3), 2004 Sumatra (9.1), 2011 Tohoku (9.1);
  // 1952 Kamchatka is Mw 8.8 in this ISC-GEM edition so it sits below the 9.0 bar
  const r = E.empiricalRate(cat, 9.0, completeness, nowMin);
  assert.ok(r.n >= 4 && r.n <= 7, `n(M≥9)=${r.n}`);
});

test('annual probability of M9 anywhere ≈ 3–6%', () => {
  const model = E.buildModel(cat, completeness, nowMin);
  const a = E.assessThreshold(cat, completeness, nowMin, model, 9.0, 1);
  assert.ok(a.pPoisson > 0.02 && a.pPoisson < 0.08, `P=${a.pPoisson}`);
});

test('annual probability of M5 anywhere ≈ 1 (certainty)', () => {
  const model = E.buildModel(cat, completeness, nowMin);
  const a = E.assessThreshold(cat, completeness, nowMin, model, 5.0, 1);
  assert.ok(a.pPoisson > 0.9999, `P=${a.pPoisson}`);
});

test('probability increases monotonically as the window scrubs forward', () => {
  const model = E.buildModel(cat, completeness, nowMin);
  let prev = 0;
  for (const yrs of [0.1, 0.5, 1, 2, 5, 10, 25, 50]) {
    const a = E.assessThreshold(cat, completeness, nowMin, model, 8.5, yrs);
    assert.ok(a.pPoisson > prev);
    prev = a.pPoisson;
  }
});

test('probability decreases monotonically with magnitude threshold', () => {
  const model = E.buildModel(cat, completeness, nowMin);
  let prev = 2;
  for (const m of [5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0]) {
    const a = E.assessThreshold(cat, completeness, nowMin, model, m, 1);
    assert.ok(a.pPoisson < prev + 1e-12, `m=${m} P=${a.pPoisson} prev=${prev}`);
    prev = a.pPoisson;
  }
});

test('tapered G-R fits a plausible global corner magnitude (8.0–9.6)', () => {
  const model = E.buildModel(cat, completeness, nowMin);
  assert.ok(model.tgr, 'TGR fit exists');
  assert.ok(model.tgr.cornerMag > 8.0 && model.tgr.cornerMag < 9.7, `corner=${model.tgr.cornerMag}`);
});

test('global renewal fit for M8+ is near-Poisson or clustered (CV ≥ ~0.8)', () => {
  const iet = E.interEventTimes(cat, 8.0, completeness, nowMin);
  assert.ok(iet.gaps.length >= 30);
  const fit = E.fitGammaMLE(iet.gaps);
  // global seismicity is not quasi-periodic; CV should not look strongly periodic
  assert.ok(fit.cv > 0.7, `cv=${fit.cv}`);
});

test('regional model: Wasatch/Draper region returns finite sane numbers', () => {
  const model = E.buildModel(cat, completeness, nowMin, { lat: 40.52, lon: -111.86, radiusKm: 200 });
  assert.ok(model.nEvents > 0, 'region has events');
  const globalModel = E.buildModel(cat, completeness, nowMin);
  const a = E.assessThreshold(cat, completeness, nowMin, model, 5.0, 1, globalModel.gr);
  assert.ok(Number.isFinite(a.pPoisson) && a.pPoisson > 0 && a.pPoisson < 0.5, `P(M5,1yr)=${a.pPoisson}`);
  const a7 = E.assessThreshold(cat, completeness, nowMin, model, 7.0, 50, globalModel.gr);
  assert.ok(Number.isFinite(a7.pPoisson) && a7.pPoisson > 0 && a7.pPoisson < 1, `P(M7,50yr)=${a7.pPoisson}`);
  assert.ok(a7.extrapolated, 'M7 in Draper region is flagged as beyond observed max');
});

test('regional model: Japan region is far more active than Utah', () => {
  const utah = E.buildModel(cat, completeness, nowMin, { lat: 40.52, lon: -111.86, radiusKm: 300 });
  const japan = E.buildModel(cat, completeness, nowMin, { lat: 38.3, lon: 142.4, radiusKm: 300 });
  const gm = E.buildModel(cat, completeness, nowMin);
  const pu = E.assessThreshold(cat, completeness, nowMin, utah, 6.0, 10, gm.gr);
  const pj = E.assessThreshold(cat, completeness, nowMin, japan, 6.0, 10, gm.gr);
  assert.ok(pj.pPoisson > pu.pPoisson * 3, `japan=${pj.pPoisson} utah=${pu.pPoisson}`);
});

test('splice: top-up replaces the bridge window', () => {
  const spliceMin = load('catalog-modern.json').meta.coverage.bridgeStartMin;
  const before = cat.n;
  const spliced = E.spliceCatalog(cat, spliceMin, [
    { tMin: spliceMin + 1000, lat: 52.5, lon: 160.1, mag: 8.8, dep: 20 },
  ]);
  assert.ok(spliced.n < before, 'bridge events dropped');
  assert.equal(spliced.mag[spliced.n - 1], Math.fround(8.8));
  for (let i = 1; i < spliced.n; i += 991) assert.ok(spliced.t[i] >= spliced.t[i - 1]);
});
