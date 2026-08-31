// test/impact.test.mjs — multi-hazard impact engine against the shipped
// EM-DAT-derived data, pinned to published/known benchmarks.
// Run: node --test test/impact.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as I from '../impact.js';

const here = dirname(fileURLToPath(import.meta.url));
const imp = I.decodeImpacts(JSON.parse(readFileSync(join(here, '..', 'data', 'impacts.json'), 'utf8')));
// fixed evaluation instant for reproducibility (seasonal phase only)
const NOW = Date.UTC(2024, 2, 1);

test('catalog decodes with expected shape', () => {
  assert.ok(imp.n > 13000 && imp.n < 15000, `n=${imp.n}`);
  assert.equal(imp.day.length, imp.n);
  assert.equal(imp.meta.hazards.length, 9);
});

test('windowStartYear picks the largest applicable threshold row', () => {
  const t = imp.completeness.deaths;
  assert.equal(I.windowStartYear(10, t), 2000);
  assert.equal(I.windowStartYear(500, t), 1990);
  assert.equal(I.windowStartYear(50000, t), 1900);
  assert.equal(I.windowStartYear(5, t), null); // below modeled range
});

test('global λ(deaths ≥ 100) matches the decade analysis (~18–30/yr)', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 100, windowYears: 1, nowMs: NOW });
  assert.ok(a.lambda > 18 && a.lambda < 30, `λ=${a.lambda}`);
  assert.equal(a.windowStartYear, 1990);
});

test('global λ(deaths ≥ 10,000) ~ 0.3–1.2/yr over the century', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 10000, windowYears: 1, nowMs: NOW });
  assert.ok(a.lambda > 0.3 && a.lambda < 1.2, `λ=${a.lambda}`);
});

test('probability of ≥100-death event within a month is high but not certain', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 100, windowYears: 1 / 12, nowMs: NOW });
  assert.ok(a.prob > 0.6 && a.prob < 0.999, `P=${a.prob}`);
});

test('probability is monotonic in window length and in threshold', () => {
  let prev = 0;
  for (const T of [1 / 365, 1 / 12, 0.5, 1, 5, 10]) {
    const a = I.assessImpact(imp, { metric: 'deaths', threshold: 1000, windowYears: T, nowMs: NOW });
    assert.ok(a.prob >= prev - 1e-12, `T=${T}`);
    prev = a.prob;
  }
  prev = 2;
  for (const X of [10, 100, 1000, 10000, 100000]) {
    const a = I.assessImpact(imp, { metric: 'deaths', threshold: X, windowYears: 1, nowMs: NOW });
    assert.ok(a.prob <= prev + 1e-12, `X=${X}`);
    prev = a.prob;
  }
});

test('per-hazard decomposition sums to the total rate', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 100, windowYears: 1, nowMs: NOW });
  const sum = a.perHazard.reduce((s, p) => s + p.lambda, 0);
  assert.ok(Math.abs(sum - a.lambda) < 1e-9);
  const shares = a.perHazard.reduce((s, p) => s + p.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
});

test('2004 Indian Ocean tsunami aggregated across countries (~226k deaths, Earthquake)', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 200000, windowYears: 1, nowMs: NOW });
  const idx2004 = a.qualifying.find((i) => {
    const y = new Date(I.msOfDay(imp.day[i])).getUTCFullYear();
    return y === 2004 && imp.type[i] === 0;
  });
  assert.ok(idx2004 !== undefined, 'tsunami found');
  assert.ok(imp.deaths[idx2004] > 220000 && imp.deaths[idx2004] < 240000, `deaths=${imp.deaths[idx2004]}`);
  assert.ok(imp.nC[idx2004] >= 5, `countries=${imp.nC[idx2004]}`);
});

test('US scope: Hurricane Katrina 2005 present with EM-DAT death toll (~1,800)', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 1000, windowYears: 1, us: true, nowMs: NOW });
  const kat = a.qualifying.find((i) => {
    const y = new Date(I.msOfDay(imp.day[i])).getUTCFullYear();
    return y === 2005 && imp.type[i] === 1 && imp.deathsUS[i] >= 1000;
  });
  assert.ok(kat !== undefined, 'Katrina found');
  assert.ok(imp.deathsUS[kat] > 1200 && imp.deathsUS[kat] < 2500, `deaths=${imp.deathsUS[kat]}`);
});

test('US λ(deaths ≥ 100) plausible (~0.2–1.5/yr since 1990)', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 100, windowYears: 1, us: true, nowMs: NOW });
  assert.ok(a.lambda > 0.2 && a.lambda < 1.5, `λ=${a.lambda}`);
});

test('storm seasonality: September factor exceeds May (NH hurricane season)', () => {
  const profile = I.monthlyProfile(imp, { metric: 'deaths', type: 1, floor: 10 });
  assert.ok(profile, 'profile exists');
  const mean = profile.reduce((a, b) => a + b, 0) / 12;
  assert.ok(Math.abs(mean - 1) < 0.02, `mean=${mean}`);
  assert.ok(profile[8] > profile[4], `sep=${profile[8]} may=${profile[4]}`);
});

test('seasonal factor: full-year windows are ~1, short windows can deviate', () => {
  const profile = I.monthlyProfile(imp, { metric: 'deaths', type: 1, floor: 10 });
  const sYear = I.seasonalFactor(profile, Date.UTC(2024, 4, 1), 1);
  assert.ok(Math.abs(sYear - 1) < 0.08, `year=${sYear}`);
  const sSep = I.seasonalFactor(profile, Date.UTC(2024, 8, 1), 1 / 12);
  const sMay = I.seasonalFactor(profile, Date.UTC(2024, 4, 1), 1 / 12);
  assert.ok(sSep > sMay, `sep=${sSep} may=${sMay}`);
});

test('damage metric: λ(adjusted damage ≥ $10B) plausible (~1.5–5/yr since 1990)', () => {
  const a = I.assessImpact(imp, { metric: 'damage', threshold: 1e7, windowYears: 1, nowMs: NOW });
  assert.ok(a.lambda > 1.5 && a.lambda < 5, `λ=${a.lambda}`);
});

test('exceedance curve is monotonically non-increasing in threshold', () => {
  const curve = I.exceedanceCurve(imp, { metric: 'deaths' });
  assert.ok(curve.length > 15);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i].lambda <= curve[i - 1].lambda + 1e-9);
  }
});
