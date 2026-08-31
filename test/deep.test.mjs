// test/deep.test.mjs — deep-history layer against the shipped NCEI + GVP
// data, pinned to the published volcanology/seismology benchmarks.
// Run: node --test test/deep.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as D from '../deep.js';

const here = dirname(fileURLToPath(import.meta.url));
const deep = JSON.parse(readFileSync(join(here, '..', 'data', 'deep-history.json'), 'utf8'));

test('deep catalog shape and spans', () => {
  assert.ok(deep.quakes.length > 2500, `quakes=${deep.quakes.length}`);
  assert.ok(deep.eruptions.length > 7000, `eruptions=${deep.eruptions.length}`);
  assert.ok(deep.quakes[0].y <= -1500, 'reaches antiquity');
  assert.ok(deep.eruptions[0].y < -9000, 'reaches early Holocene');
});

test('VEI≥6 rate since 1500 matches published ~1–3 per century', () => {
  const x = D.assessExtremes(deep, 1).vei6;
  assert.equal(x.start, 1500);
  assert.ok(x.n >= 7 && x.n <= 12, `n=${x.n}`);
  const perCentury = x.lambda * 100;
  assert.ok(perCentury > 1 && perCentury < 3, `rate=${perCentury}/century`);
  assert.equal(x.last.name, 'Pinatubo');
});

test('VEI≥7: the known three of the last ~1,100 years', () => {
  const x = D.assessExtremes(deep, 1).vei7;
  assert.equal(x.n, 3, `n=${x.n}`); // Changbaishan/Paektu 946*, Samalas/Rinjani 1257, Tambora
  const names = x.events.map((e) => e.name);
  assert.ok(names.includes('Tambora'));
  assert.ok(names.includes('Rinjani'));
  // annual probability ~0.15–0.5%
  assert.ok(x.prob > 0.001 && x.prob < 0.006, `P=${x.prob}`);
});

test('M≥8.5 occurrence uses the instrumental era only', () => {
  const x = D.assessExtremes(deep, 1).m85;
  assert.equal(x.start, 1900);
  assert.ok(x.n >= 12 && x.n <= 22, `n=${x.n}`);
  assert.ok(x.lambda > 0.08 && x.lambda < 0.2, `λ=${x.lambda}`);
});

test('probabilities are monotonic in window length', () => {
  let prev = { vei6: 0, vei7: 0, m85: 0 };
  for (const T of [1, 10, 50, 100]) {
    const x = D.assessExtremes(deep, T);
    for (const k of ['vei6', 'vei7', 'm85']) {
      assert.ok(x[k].prob >= prev[k]);
      prev[k] = x[k].prob;
    }
  }
});

test('documented catastrophes include the historical giants', () => {
  const rows = D.documentedCatastrophes(deep, { minDeaths: 100000 });
  const shaanxi = rows.find((r) => r.y === 1556 && r.kind === 'Earthquake');
  assert.ok(shaanxi, 'Shaanxi 1556 present');
  assert.ok(shaanxi.deaths >= 800000, `deaths=${shaanxi.deaths}`);
  const antioch = rows.find((r) => r.y === 115);
  assert.ok(antioch, 'Antioch 115 present');
  const tambora = rows.find((r) => r.kind === 'Eruption' && r.name === 'Tambora');
  assert.ok(tambora, 'Tambora present');
  // chronological order
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].y >= rows[i - 1].y);
});

test('the completeness ramp is real (and justifies the window policy)', () => {
  const ramp = D.centuryRamp(deep.quakes, (e) => e.mag !== null && e.mag >= 8.5);
  // documented M≥8.5 counts must climb toward the present — documentation,
  // not seismicity — hence occurrence windows exclude the documentary era
  assert.ok(ramp[0].n < ramp[ramp.length - 1].n, JSON.stringify(ramp));
});

test('era labels', () => {
  assert.equal(D.eraLabel(-1610), '1610 BC');
  assert.equal(D.eraLabel(946), '946 CE');
  assert.equal(D.eraLabel(1815), '1815');
});

// ─── stationarity: tested, not assumed ────────────────────────────────────
// "Is the rate of big earthquakes increasing?" is answered from data inside
// the constant-detection era, after removing aftershock clustering. If this
// test ever fails on a data rebuild, the stationarity claim in METHODOLOGY
// § 16 must be revisited — do not weaken the bounds to get green.
import * as E from '../engine.js';

test('declustered M≥7 mainshock rate is stationary across the instrumental century', () => {
  const loadCat = (f) => E.decodeCatalog(JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8')));
  const cat = E.mergeCatalogs(loadCat('catalog-instrumental.json'), loadCat('catalog-modern.json'));
  const idx = [];
  for (let i = 0; i < cat.n; i++) if (cat.mag[i] >= 7 - E.EPS_MAG) idx.push(i);
  const keep = [];
  outer: for (const i of idx) {
    for (const j of idx) {
      if (j === i || cat.mag[j] <= cat.mag[i]) continue;
      const dt = (cat.t[i] - cat.t[j]) / E.MIN_PER_YEAR;
      if (dt <= 0 || dt > 1.5) continue;
      if (E.haversineKm(cat.lat[i], cat.lon[i], cat.lat[j], cat.lon[j]) <= 300) continue outer;
    }
    keep.push(i);
  }
  const counts = [];
  for (let y0 = 1920; y0 < 2020; y0 += 10) {
    const a = E.yearToMin(`${y0}-01-01`), b = E.yearToMin(`${y0 + 10}-01-01`);
    counts.push(keep.filter((i) => cat.t[i] >= a && cat.t[i] < b).length);
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const chi2 = counts.reduce((s, n) => s + (n - mean) ** 2 / mean, 0);
  const xs = counts.map((_, i) => i - (counts.length - 1) / 2);
  const slope = xs.reduce((s, x, i) => s + x * counts[i], 0) / xs.reduce((s, x) => s + x * x, 0);
  const z = slope / Math.sqrt(mean / xs.reduce((s, x) => s + x * x, 0));
  // 1% chi-square cutoff (df=9) and a generous trend bound
  assert.ok(chi2 < 21.7, `chi2=${chi2.toFixed(1)} — decade counts not homogeneous`);
  assert.ok(Math.abs(z) < 2.5, `trend z=${z.toFixed(2)} — significant secular trend detected`);
});

test('documentary record captures only a small fraction of the instrumental rate', () => {
  // 1500–1899 documented M≥7.5 events per century vs 1900+ — the measured
  // size of the pre-instrumental undercount (~one event in six)
  const pre = deep.quakes.filter((q) => q.mag >= 7.5 && q.y >= 1500 && q.y <= 1899).length / 4;
  const ins = deep.quakes.filter((q) => q.mag >= 7.5 && q.y >= 1900).length / 1.21;
  assert.ok(pre / ins < 0.5, `documentary/instrumental = ${(pre / ins).toFixed(2)} — undercount vanished?`);
});
