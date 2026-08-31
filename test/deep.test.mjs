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
