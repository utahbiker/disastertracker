#!/usr/bin/env node
// backtest/spatial.mjs — pseudo-prospective validation of kernel-smoothed
// seismicity against the hard-count baseline (CSEP-style spatial test).
//
// Question: does Gaussian-kernel smoothing of epicenters forecast WHERE
// earthquakes happen better than raw counting does? Method (Zechar & Jordan
// 2008 framing; Helmstetter, Kagan & Jackson 2007 for the models):
//
//   - Equal-area world grid (~1.5° at the equator).
//   - Each model converts TRAINING events (M ≥ 5.0, modern complete era)
//     into a per-cell annual rate; every model is mixed with the same tiny
//     uniform "water level" (0.5% of total mass) so a surprise event
//     penalizes rather than disqualifies.
//   - Score on TEST events: Poisson log-likelihood Σ_c [n_c ln μ_c − μ_c].
//     Reported as information gain per test event vs the M0 count baseline.
//
// Selection protocol (no test-set selection, per project rule):
//   1. SELECT bandwidth on train 2000–2011 → validate 2012–2016
//      (fixed σ ∈ {15, 25, 50, 100} km; adaptive k-NN k ∈ {2, 4, 8},
//      σ_i clamped [10, 150] km).
//   2. TEST the selected configuration(s), refitted on 2000–2016, against
//      M0 on held-out 2017–2024. Adoption requires beating M0 there.
//
// Usage: node backtest/spatial.mjs [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeCatalog, yearToMin, EPS_MAG } from '../engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));
const cat = decodeCatalog(load('catalog-modern.json'));

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }),
);

const MMIN = 5.0;
const KM_PER_DEG = 111.2;

// ─── equal-area grid: 1.5° latitude bands, longitude cells scaled by cos ──
const BAND_DEG = 1.5;
const NBANDS = Math.round(180 / BAND_DEG);
const nLon = [];
for (let b = 0; b < NBANDS; b++) {
  const latMid = -90 + (b + 0.5) * BAND_DEG;
  nLon.push(Math.max(1, Math.round((360 / BAND_DEG) * Math.cos(latMid * Math.PI / 180))));
}
const cellId = (b, j) => b * 100000 + j;
const bandOf = (lat) => Math.min(NBANDS - 1, Math.max(0, Math.floor((lat + 90) / BAND_DEG)));
const lonCellOf = (b, lon) => {
  let x = (lon + 180) / 360;
  x -= Math.floor(x);
  return Math.min(nLon[b] - 1, Math.floor(x * nLon[b]));
};
let NCELLS = 0;
for (let b = 0; b < NBANDS; b++) NCELLS += nLon[b];

// ─── events ──────────────────────────────────────────────────────────────
function eventsBetween(fromISO, toISO) {
  const a = yearToMin(fromISO), z = yearToMin(toISO);
  const out = [];
  for (let i = 0; i < cat.n; i++) {
    if (cat.mag[i] >= MMIN - EPS_MAG && cat.t[i] >= a && cat.t[i] < z) {
      out.push({ lat: cat.lat[i], lon: cat.lon[i] });
    }
  }
  return out;
}

// ─── model rate fields (per-cell ANNUAL rates, sparse Maps) ──────────────
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function countField(events, Tyears) {
  const f = new Map();
  for (const e of events) {
    const b = bandOf(e.lat), j = lonCellOf(b, e.lon), id = cellId(b, j);
    f.set(id, (f.get(id) ?? 0) + 1 / Tyears);
  }
  return f;
}

/** Spread one event's unit mass over grid cells with a Gaussian of sigmaKm. */
function spread(f, e, sigmaKm, perYear) {
  const sLat = sigmaKm / KM_PER_DEG;
  const cosL = Math.max(0.05, Math.cos(e.lat * Math.PI / 180));
  const sLon = sigmaKm / (KM_PER_DEG * cosL);
  const b0 = bandOf(e.lat - 4 * sLat), b1 = bandOf(e.lat + 4 * sLat);
  for (let b = b0; b <= b1; b++) {
    const latLo = -90 + b * BAND_DEG, latHi = latLo + BAND_DEG;
    const mLat = phi((latHi - e.lat) / sLat) - phi((latLo - e.lat) / sLat);
    if (mLat < 1e-9) continue;
    const width = 360 / nLon[b];
    const span = Math.min(nLon[b], Math.ceil((4 * sLon) / width) + 1);
    const jc = lonCellOf(b, e.lon);
    for (let dj = -span; dj <= span; dj++) {
      const j = ((jc + dj) % nLon[b] + nLon[b]) % nLon[b];
      // unwrapped cell edges relative to the event longitude
      const lo = -180 + (jc + dj) * width, hi = lo + width;
      const mLon = phi((hi - e.lon) / sLon) - phi((lo - e.lon) / sLon);
      if (mLon < 1e-9) continue;
      const id = cellId(b, j);
      f.set(id, (f.get(id) ?? 0) + mLat * mLon * perYear);
    }
  }
}

/** sigmas: a number (fixed bandwidth) or an array aligned with events. */
function kernelField(events, Tyears, sigmas) {
  const f = new Map();
  for (let i = 0; i < events.length; i++) {
    spread(f, events[i], typeof sigmas === 'number' ? sigmas : sigmas[i], 1 / Tyears);
  }
  return f;
}

// adaptive bandwidth: distance to k-th nearest training neighbor, via 2°
// bucketed search; clamped [10, 150] km
function adaptiveSigmas(events, k) {
  const buckets = new Map();
  const key = (la, lo) => `${Math.floor(la / 2)}|${Math.floor(((lo + 540) % 360) / 2)}`;
  events.forEach((e, i) => {
    const kk = key(e.lat, e.lon);
    if (!buckets.has(kk)) buckets.set(kk, []);
    buckets.get(kk).push(i);
  });
  const dKm = (a, bE) => {
    const d = Math.PI / 180;
    const dLat = (bE.lat - a.lat) * d, dLon = (bE.lon - a.lon) * d;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(bE.lat * d) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  return events.map((e, i) => {
    const best = [];
    const push = (dist) => {
      if (best.length < k) { best.push(dist); best.sort((a, b) => a - b); }
      else if (dist < best[k - 1]) { best[k - 1] = dist; best.sort((a, b) => a - b); }
    };
    const bla = Math.floor(e.lat / 2), blo = Math.floor(((e.lon + 540) % 360) / 2);
    for (let ring = 0; ring <= 2; ring++) {
      for (let da = -ring; da <= ring; da++) {
        for (let dodo = -ring; dodo <= ring; dodo++) {
          if (Math.max(Math.abs(da), Math.abs(dodo)) !== ring) continue;
          const bucket = buckets.get(`${bla + da}|${(blo + dodo + 180) % 180}`);
          if (!bucket) continue;
          for (const jdx of bucket) {
            if (jdx === i) continue;
            push(dKm(e, events[jdx]));
          }
        }
      }
      if (best.length >= k && best[k - 1] <= ring * 111) break; // ring covers it
    }
    const s = best.length >= k ? best[k - 1] : 150;
    return Math.min(150, Math.max(10, s));
  });
}

// ─── scoring ─────────────────────────────────────────────────────────────
function score(field, testEvents, Ttest, label) {
  // total predicted annual rate + water level
  let total = 0;
  for (const v of field.values()) total += v;
  const eps = 0.005 * total / NCELLS; // uniform 0.5% water level per cell
  const testCounts = new Map();
  for (const e of testEvents) {
    const b = bandOf(e.lat), id = cellId(b, lonCellOf(b, e.lon));
    testCounts.set(id, (testCounts.get(id) ?? 0) + 1);
  }
  // Σ n_c ln μ_c  over occupied cells  −  Σ μ_c over ALL cells
  let ll = 0;
  for (const [id, n] of testCounts) {
    const mu = ((field.get(id) ?? 0) * 0.995 + eps) * Ttest;
    ll += n * Math.log(mu);
  }
  ll -= (total * 0.995 + eps * NCELLS) * Ttest; // Σ μ_c
  return { label, ll, perEvent: ll / testEvents.length };
}

// ─── protocol ────────────────────────────────────────────────────────────
function evaluate(trainFrom, trainTo, testFrom, testTo, configs) {
  const train = eventsBetween(trainFrom, trainTo);
  const test = eventsBetween(testFrom, testTo);
  const Ttrain = (yearToMin(trainTo) - yearToMin(trainFrom)) / (365.25 * 24 * 60);
  const Ttest = (yearToMin(testTo) - yearToMin(testFrom)) / (365.25 * 24 * 60);
  const rows = [];
  rows.push(score(countField(train, Ttrain), test, Ttest, 'M0 cell-count'));
  for (const c of configs) {
    if (c.type === 'fixed') {
      rows.push(score(kernelField(train, Ttrain, c.sigma), test, Ttest, `fixed σ=${c.sigma}km`));
    } else {
      rows.push(score(kernelField(train, Ttrain, adaptiveSigmas(train, c.k)), test, Ttest, `adaptive k=${c.k}`));
    }
  }
  return { train: train.length, test: test.length, rows };
}

console.log(`grid: ${NCELLS} equal-area cells (${BAND_DEG}° bands), M ≥ ${MMIN}\n`);

console.log('— SELECTION: train 2000–2011 → validate 2012–2016 —');
const sel = evaluate('2000-01-01', '2012-01-01', '2012-01-01', '2017-01-01', [
  { type: 'fixed', sigma: 15 }, { type: 'fixed', sigma: 25 },
  { type: 'fixed', sigma: 50 }, { type: 'fixed', sigma: 100 },
  { type: 'adaptive', k: 2 }, { type: 'adaptive', k: 4 }, { type: 'adaptive', k: 8 },
]);
const base = sel.rows[0];
console.log(`train n=${sel.train}, validate n=${sel.test}`);
for (const r of sel.rows) {
  console.log(`  ${r.label.padEnd(16)} LL/event ${r.perEvent.toFixed(4)}  gain vs M0 ${(r.perEvent - base.perEvent >= 0 ? '+' : '')}${(r.perEvent - base.perEvent).toFixed(4)} nats`);
}
const winner = sel.rows.slice(1).reduce((a, b) => (b.perEvent > a.perEvent ? b : a));
const bestFixed = sel.rows.filter((r) => r.label.startsWith('fixed')).reduce((a, b) => (b.perEvent > a.perEvent ? b : a));
console.log(`  selected: ${winner.label} (best fixed: ${bestFixed.label})`);

// Both configurations carried to the held-out test were chosen on the
// VALIDATION split only: the overall winner, and the best fixed-bandwidth
// config (a candidate because per-event bandwidths carry real shipping
// complexity — the simpler model is preferred when its held-out skill is
// materially the same).
console.log('\n— HELD-OUT TEST: fit 2000–2016 → test 2017–2024 —');
const parse = (label) => (label.startsWith('fixed')
  ? { type: 'fixed', sigma: Number(label.match(/σ=(\d+)/)[1]) }
  : { type: 'adaptive', k: Number(label.match(/k=(\d+)/)[1]) });
const cfg = [parse(winner.label)];
if (bestFixed.label !== winner.label) cfg.push(parse(bestFixed.label));
const fin = evaluate('2000-01-01', '2017-01-01', '2017-01-01', '2024-01-01', cfg);
const fbase = fin.rows[0], fwin = fin.rows[1];
console.log(`train n=${fin.train}, test n=${fin.test}`);
for (const r of fin.rows) {
  console.log(`  ${r.label.padEnd(16)} LL/event ${r.perEvent.toFixed(4)}  gain vs M0 ${(r.perEvent - fbase.perEvent >= 0 ? '+' : '')}${(r.perEvent - fbase.perEvent).toFixed(4)} nats`);
}
console.log(`\nVERDICT: ${fwin.perEvent > fbase.perEvent ? 'ADOPT — smoothing beats counting out-of-sample' : 'DO NOT ADOPT'}`);

if (args.json) {
  writeFileSync(args.json, JSON.stringify({ selection: sel, test: fin, selected: winner.label }, null, 1));
  console.log(`written ${args.json}`);
}
