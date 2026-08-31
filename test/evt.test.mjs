// test/evt.test.mjs — EVT severity tail (generalized Pareto): estimator
// recovery on synthetic data, real-data fit sanity, the empirical→tail
// hand-off, a full monotonicity grid, and a walk-forward hold-out check.
// Run: node --test test/evt.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fitGPD, gpdSurvival } from '../engine.js';
import * as I from '../impact.js';

const here = dirname(fileURLToPath(import.meta.url));
const imp = I.decodeImpacts(JSON.parse(readFileSync(join(here, '..', 'data', 'impacts.json'), 'utf8')));
const NOW = Date.UTC(2024, 2, 1);

// deterministic PRNG so the synthetic-recovery test never flakes
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// GPD inverse transform: X = (β/ξ)((1−U)^(−ξ) − 1)
function gpdSample(rng, xi, beta, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((beta / xi) * (Math.pow(1 - rng(), -xi) - 1));
  return out;
}

test('gpdSurvival: S(0)=1, strictly decreasing, matches closed form', () => {
  assert.equal(gpdSurvival(0, 0.8, 100), 1);
  let prev = 1;
  for (const z of [10, 50, 200, 1000, 10000]) {
    const s = gpdSurvival(z, 0.8, 100);
    assert.ok(s < prev && s > 0, `z=${z}`);
    assert.ok(Math.abs(s - Math.pow(1 + 0.8 * z / 100, -1 / 0.8)) < 1e-12);
    prev = s;
  }
});

test('fitGPD recovers the survival function from synthetic samples', () => {
  // ξ and β are strongly negatively correlated in the GPD likelihood, so raw
  // parameter recovery is a poor invariant. What the model consumes is the
  // survival function — assert THAT matches truth at deep quantiles.
  for (const [xi, beta] of [[0.4, 50], [0.9, 500], [1.4, 1500]]) {
    const rng = mulberry32(42);
    const fit = fitGPD(gpdSample(rng, xi, beta, 2000));
    assert.ok(fit, `no fit for ξ=${xi}`);
    assert.ok(Math.abs(fit.xi - xi) < 0.25, `ξ: fitted ${fit.xi} vs true ${xi}`);
    for (const q of [0.9, 0.99, 0.999]) {
      const z = (beta / xi) * (Math.pow(1 - q, -xi) - 1); // true quantile
      const sTrue = 1 - q;
      const sFit = gpdSurvival(z, fit.xi, fit.beta);
      const ratio = sFit / sTrue;
      assert.ok(ratio > 0.5 && ratio < 2, `S at q=${q}, ξ=${xi}: fitted/true = ${ratio.toFixed(3)}`);
    }
  }
});

test('fitGPD refuses fewer than 40 exceedances', () => {
  const rng = mulberry32(7);
  assert.equal(fitGPD(gpdSample(rng, 0.5, 100, 39)), null);
});

test('real-data anchor fits: heavy tails, US deaths honestly refused', () => {
  const d = I.tailModel(imp, { metric: 'deaths', us: false });
  assert.ok(d && d.nAnchor > 250, `deaths anchor n=${d && d.nAnchor}`);
  assert.ok(d.xi > 0.5 && d.xi < 2.5, `deaths ξ=${d.xi}`); // death tolls are famously heavy-tailed
  const g = I.tailModel(imp, { metric: 'damage', us: false });
  assert.ok(g && g.xi > 0.3 && g.xi < 1.5, `damage ξ=${g && g.xi}`);
  assert.equal(I.tailModel(imp, { metric: 'deaths', us: true }), null); // too few exceedances
});

test('empirical→tail hand-off is continuous at the switch point x*', () => {
  const a = I.assessImpact(imp, { metric: 'deaths', threshold: 500000, windowYears: 1, nowMs: NOW });
  assert.equal(a.method, 'evt-tail');
  const xStar = a.tail.u;
  const below = I.assessImpact(imp, { metric: 'deaths', threshold: xStar - 1, windowYears: 1, nowMs: NOW });
  const at = I.assessImpact(imp, { metric: 'deaths', threshold: xStar, windowYears: 1, nowMs: NOW });
  // at x* the tail level IS the empirical rate n*/T, so the step across the
  // switch can be at most one staircase step (one event / window length)
  assert.ok(below.prob >= at.prob - 1e-12, `P(${xStar - 1})=${below.prob} < P(${xStar})=${at.prob}`);
  assert.ok(below.prob - at.prob < 0.05, `discontinuity ${below.prob - at.prob}`);
});

test('tail engages beyond the record and keeps decaying (no zero-count cliff)', () => {
  const beyond = I.assessImpact(imp, { metric: 'damage', threshold: 5e8, windowYears: 1, nowMs: NOW }); // $500B > max recorded
  assert.equal(beyond.n, 0);
  assert.equal(beyond.method, 'evt-tail');
  assert.ok(beyond.prob > 0 && beyond.prob < 0.05, `P=${beyond.prob}`);
  const further = I.assessImpact(imp, { metric: 'damage', threshold: 1e9, windowYears: 1, nowMs: NOW });
  assert.ok(further.prob < beyond.prob);
});

test('exceedance probability is monotone in threshold across every seam', () => {
  // full grid over both metrics and scopes — crosses every completeness-
  // window boundary and the empirical→tail switch
  for (const [metric, lo, hi] of [['deaths', 10, 5e6], ['damage', 1e5, 5e9]]) {
    for (const us of [false, true]) {
      let prev = Infinity;
      for (let k = 0; k <= 400; k++) {
        const x = lo * Math.pow(hi / lo, k / 400);
        const a = I.assessImpact(imp, { metric, threshold: x, windowYears: 1, us, nowMs: NOW });
        if (!a) continue;
        assert.ok(a.prob <= prev + 1e-12, `${metric} ${us ? 'US' : 'global'} P rises at ${Math.round(x)}: ${prev} → ${a.prob}`);
        prev = a.prob;
      }
    }
  }
});

test('hold-out: tail fitted on 1930–1999 does not wildly mispredict 2000–2024 extremes', () => {
  // Rebuild the deaths tail using ONLY pre-2000 events, then check the
  // predicted count of ≥500k-death events in 2000–2024 against what
  // actually happened (none — the largest were ~220–230k).
  const day2000 = Math.round((Date.UTC(2000, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000);
  const day1930 = Math.round((Date.UTC(1930, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000);
  const trainVals = [];
  let observed = 0;
  for (let i = 0; i < imp.n; i++) {
    const v = imp.deaths[i];
    if (imp.day[i] >= day1930 && imp.day[i] < day2000 && v >= 1000) trainVals.push(v);
    if (imp.day[i] >= day2000 && imp.day[i] < imp.meta.dataEndDay && v >= 500000) observed++;
  }
  const fit = fitGPD(trainVals.map((v) => v - 1000));
  assert.ok(fit, 'training fit failed');
  const sorted = [...trainVals].sort((a, b) => b - a);
  const xStar = sorted[9];
  const nStar = sorted.filter((v) => v >= xStar).length;
  const Ttrain = (day2000 - day1930) / 365.25;
  const betaStar = fit.beta + fit.xi * (xStar - 1000);
  const lambdaPred = (nStar / Ttrain) * gpdSurvival(Math.max(0, 500000 - xStar), fit.xi, betaStar);
  const Ttest = (imp.meta.dataEndDay - day2000) / 365.25;
  const expected = lambdaPred * Ttest;
  // observed count must be statistically consistent with the prediction:
  // P(X ≤ observed) and P(X ≥ observed) both above 0.5% under Poisson(expected)
  assert.equal(observed, 0, `unexpected ≥500k-death events post-2000: ${observed}`);
  assert.ok(Math.exp(-expected) > 0.005, `tail over-predicts: expected ${expected.toFixed(2)} events, saw 0 (P=${Math.exp(-expected).toExponential(2)})`);
  assert.ok(expected > 0.05, `tail degenerately low: expected ${expected}`);
});

test('coherence floor: sub-window-base thresholds never dip below the next base', () => {
  const at694 = I.assessImpact(imp, { metric: 'deaths', threshold: 694, windowYears: 1, nowMs: NOW });
  const at1000 = I.assessImpact(imp, { metric: 'deaths', threshold: 1000, windowYears: 1, nowMs: NOW });
  assert.ok(at694.prob >= at1000.prob - 1e-12);
  // and the window-base headlines themselves are never altered by the floor
  assert.equal(at1000.cohered, false);
});
