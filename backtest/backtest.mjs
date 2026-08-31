#!/usr/bin/env node
// backtest/backtest.mjs — walk-forward evaluation of the probability models.
//
// The accuracy standard for this project: hold out history, forecast it from
// only earlier data, and score against what happened. For every evaluation
// month m and every target (metric, threshold, scope), each candidate model
// is fitted using ONLY events before m (no lookahead — completeness window
// *starts* stay policy-fixed, the window *end* is m), produces
// P(≥1 qualifying event during m), and is scored against the observed 0/1.
//
// Scores:
//   Brier  = mean (p − y)²            (lower is better)
//   Log    = mean −[y ln p + (1−y) ln(1−p)]   (lower is better)
//   BSS    = 1 − Brier/Brier_ref      (skill vs the M0 constant-rate baseline;
//                                      positive = better than baseline)
//   Calibration: forecasts bucketed, mean p vs observed frequency per bucket.
//
// Models:
//   M0 constant   rate = count/window (policy window start → m)
//   M1 seasonal   M0 × monthly climatology (the shipped model)
//   M2 trend      per-hazard Poisson log-linear trend on annual counts,
//                 evaluated at m (projection capped), × climatology
//   M3 cluster    M1 × r when ≥1 qualifying event occurred in the previous
//                 month, where r = P(event | event last month)/P(event),
//                 estimated on training months only
//   M4 renewal    Gamma renewal fit to training inter-event gaps,
//                 conditioned on time elapsed since the last training event
//                 ("overdue" logic; falls back to M1 when < 15 gaps)
//
// Usage: node backtest/backtest.mjs [--from 2010-01] [--to 2024-01] [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as I from '../impact.js';
import { poissonTrendMultiplier } from '../impact.js';
import { fitGammaMLE, gammaCDF } from '../engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));
const imp = I.decodeImpacts(load('impacts.json'));

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }),
);
const FROM = args.from ?? '2010-01';
const TO = args.to ?? '2024-01';

const EPOCH_1900 = Date.UTC(1900, 0, 1);
const dayOf = (y, mo, d) => Math.round((Date.UTC(y, mo - 1, d) - EPOCH_1900) / 86400000);
const monthsBetween = (a, b) => (b.y - a.y) * 12 + (b.mo - a.mo);
const parseYM = (s) => ({ y: +s.slice(0, 4), mo: +s.slice(5, 7) });

// evaluation months
const months = [];
for (let c = parseYM(FROM); monthsBetween(c, parseYM(TO)) >= 0; c = c.mo === 12 ? { y: c.y + 1, mo: 1 } : { y: c.y, mo: c.mo + 1 }) {
  months.push({ ...c, startDay: dayOf(c.y, c.mo, 1), endDay: dayOf(c.mo === 12 ? c.y + 1 : c.y, c.mo === 12 ? 1 : c.mo + 1, 1) });
}

// targets: (metric, threshold, us). Window-start policy from the shipped
// completeness config; the fit end is always the forecast month start.
const TARGETS = [
  { name: 'deaths≥100 global', metric: 'deaths', threshold: 100, us: false },
  { name: 'deaths≥1k global', metric: 'deaths', threshold: 1000, us: false },
  { name: 'deaths≥10k global', metric: 'deaths', threshold: 10000, us: false },
  { name: 'deaths≥100 US', metric: 'deaths', threshold: 100, us: true },
  { name: 'dmg≥$10B global', metric: 'damage', threshold: 1e7, us: false },
];

const value = (i, t) => imp.value(i, t.metric, t.us);
const startYearFor = (t) => I.windowStartYear(t.threshold,
  t.metric === 'deaths' ? imp.completeness.deaths : imp.completeness.damageK);

// per-target precomputation: qualifying event list (day, month, year, type)
function qualifyingEvents(t) {
  const out = [];
  for (let i = 0; i < imp.n; i++) {
    if (value(i, t) >= t.threshold) out.push({ day: imp.day[i], month: imp.month[i], year: new Date(imp.day[i] * 86400000 + EPOCH_1900).getUTCFullYear(), type: imp.type[i] });
  }
  out.sort((a, b) => a.day - b.day);
  return out;
}

// smoothed monthly climatology from training events only (mean 1)
function climatology(events, uptoDay) {
  const counts = new Array(12).fill(0);
  let n = 0;
  for (const e of events) {
    if (e.day >= uptoDay || e.month < 1) continue;
    counts[e.month - 1]++; n++;
  }
  if (n < 60) return null;
  const sm = counts.map((_, m) => 0.25 * counts[(m + 11) % 12] + 0.5 * counts[m] + 0.25 * counts[(m + 1) % 12]);
  const mean = sm.reduce((a, b) => a + b, 0) / 12;
  return sm.map((v) => v / mean);
}

function runTarget(t) {
  const events = qualifyingEvents(t);
  const startDay = dayOf(startYearFor(t), 1, 1);
  const rows = [];
  // cluster ratio state, estimated ONLY from months before the forecast month
  for (const m of months) {
    const train = events.filter((e) => e.day >= startDay && e.day < m.startDay);
    const Tyears = (m.startDay - startDay) / 365.25;
    if (Tyears < 5) continue;
    const lambda = train.length / Tyears;
    const monthYears = (m.endDay - m.startDay) / 365.25;

    const clim = climatology(events, m.startDay);
    const s = clim ? clim[m.mo - 1] : 1;

    // cluster statistics on training months
    let nPrevYes = 0, nPrevYesHit = 0, nAll = 0, nAllHit = 0;
    const firstTrainMonth = { y: Math.max(startYearFor(t), parseYM(FROM).y - 25), mo: 1 };
    for (let c = firstTrainMonth; ; c = c.mo === 12 ? { y: c.y + 1, mo: 1 } : { y: c.y, mo: c.mo + 1 }) {
      const s0 = dayOf(c.y, c.mo, 1), s1 = dayOf(c.mo === 12 ? c.y + 1 : c.y, c.mo === 12 ? 1 : c.mo + 1, 1);
      if (s1 > m.startDay) break;
      const prev0 = dayOf(c.mo === 1 ? c.y - 1 : c.y, c.mo === 1 ? 12 : c.mo - 1, 1);
      const hit = events.some((e) => e.day >= s0 && e.day < s1) ? 1 : 0;
      const prevHit = events.some((e) => e.day >= prev0 && e.day < s0) ? 1 : 0;
      nAll++; nAllHit += hit;
      if (prevHit) { nPrevYes++; nPrevYesHit += hit; }
    }
    const base = nAll > 0 ? nAllHit / nAll : 0;
    const condp = nPrevYes >= 24 ? nPrevYesHit / nPrevYes : base;
    const clusterR = base > 0.02 && base < 0.98 && condp > 0 ? condp / base : 1;
    const prevMonthHit = events.some((e) => e.day >= dayOf(m.mo === 1 ? m.y - 1 : m.y, m.mo === 1 ? 12 : m.mo - 1, 1) && e.day < m.startDay);

    const lastTrainYear = m.mo === 1 ? m.y - 1 : m.y - 1; // last complete calendar year before the forecast month
    const annual = [];
    for (let y = startYearFor(t); y <= lastTrainYear; y++) annual.push(train.filter((e) => e.year === y).length);
    const trendM = annual.length >= 15 ? poissonTrendMultiplier(annual, startYearFor(t), m.y) : 1;

    const p = (rate) => 1 - Math.exp(-Math.max(1e-9, rate) * monthYears);
    const clamp = (x) => Math.min(0.9999, Math.max(0.0001, x));
    const y = events.some((e) => e.day >= m.startDay && e.day < m.endDay) ? 1 : 0;

    // M4: renewal conditioning on training gaps only
    let m4 = clamp(p(lambda * s));
    const gaps = [];
    for (let i = 1; i < train.length; i++) gaps.push(Math.max(1 / 365.25, (train[i].day - train[i - 1].day) / 365.25));
    if (gaps.length >= 15) {
      const fit = fitGammaMLE(gaps);
      if (fit) {
        const elapsed = (m.startDay - train[train.length - 1].day) / 365.25;
        const F = (x) => gammaCDF(x, fit.k, fit.theta);
        const surv = 1 - F(elapsed);
        if (surv > 1e-9) m4 = clamp((F(elapsed + monthYears) - F(elapsed)) / surv);
      }
    }

    rows.push({
      y,
      M0: clamp(p(lambda)),
      M1: clamp(p(lambda * s)),
      M2: clamp(p(lambda * trendM * s)),
      M3: clamp(p(lambda * s) * (prevMonthHit ? Math.min(2, Math.max(0.5, clusterR)) : 1)),
      M4: m4,
    });
  }
  return rows;
}

function score(rows, key) {
  const n = rows.length;
  let brier = 0, log = 0;
  for (const r of rows) {
    const p = r[key];
    brier += (p - r.y) ** 2;
    log += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }
  return { brier: brier / n, log: log / n };
}

function calibration(rows, key, bins = 5) {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of rows) {
    const b = Math.min(bins - 1, Math.floor(r[key] * bins));
    buckets[b].n++; buckets[b].p += r[key]; buckets[b].y += r.y;
  }
  return buckets.map((b, i) => (b.n ? { bin: i / bins, n: b.n, meanP: b.p / b.n, obs: b.y / b.n } : null)).filter(Boolean);
}

const results = {};
for (const t of TARGETS) {
  const rows = runTarget(t);
  const out = { n: rows.length, hits: rows.reduce((s, r) => s + r.y, 0) };
  const s0 = score(rows, 'M0');
  for (const k of ['M0', 'M1', 'M2', 'M3', 'M4']) {
    const s = score(rows, k);
    out[k] = { ...s, bss: 1 - s.brier / s0.brier };
  }
  out.calibrationM1 = calibration(rows, 'M1');
  results[t.name] = out;
  console.log(`\n${t.name}  (n=${out.n} months, ${out.hits} with events)`);
  for (const k of ['M0', 'M1', 'M2', 'M3', 'M4']) {
    console.log(`  ${k}: Brier ${out[k].brier.toFixed(4)}  log ${out[k].log.toFixed(4)}  BSS ${out[k].bss >= 0 ? '+' : ''}${(out[k].bss * 100).toFixed(2)}%`);
  }
  console.log('  calibration (M1): ' + out.calibrationM1.map((c) => `[${c.meanP.toFixed(2)}→${c.obs.toFixed(2)} n=${c.n}]`).join(' '));
}
if (args.json) {
  writeFileSync(args.json, JSON.stringify({ from: FROM, to: TO, results }, null, 1));
  console.log(`\nwritten ${args.json}`);
}
