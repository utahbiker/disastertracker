// impact.js — multi-hazard impact probability engine for the master dashboard.
// Pure ESM, browser + Node. Statistical utilities come from engine.js.
//
// Model (full write-up in METHODOLOGY.md § Multi-hazard impact model):
// natural-disaster occurrences above an impact threshold are treated as a
// superposition of independent per-hazard Poisson processes. For threshold X
// on metric m (deaths or CPI-adjusted damage), each hazard's rate λ_h is the
// empirical count of qualifying PHYSICAL EVENTS inside the completeness
// window for X, divided by the window length, with exact Garwood CIs.
// P(≥1 event in T) = 1 − exp(−Σ_h λ_h · s(T) · T), where s(T) is a
// seasonality factor: the mean of the (smoothed, per-hazard) monthly event
// climatology over the forecast window — materially different from 1 only
// for sub-annual windows.

import { poissonRateCI, poissonProb } from './engine.js';

export const DAY_MS = 86400000;
export const EPOCH_1900_MS = Date.UTC(1900, 0, 1);
export const dayOfMs = (ms) => (ms - EPOCH_1900_MS) / DAY_MS;
export const msOfDay = (day) => day * DAY_MS + EPOCH_1900_MS;
const DAYS_PER_YEAR = 365.25;

/** Decode data/impacts.json (already flat arrays; wraps with helpers). */
export function decodeImpacts(raw) {
  return {
    ...raw,
    value(i, metric, us) {
      if (metric === 'deaths') return us ? this.deathsUS[i] : this.deaths[i];
      return us ? this.dmgUSK[i] : this.dmgK[i];
    },
  };
}

/**
 * Completeness window start (calendar year) for a threshold: the entry with
 * the largest `min` ≤ threshold. Thresholds below the smallest modeled
 * `min` are outside the model — returns null.
 */
export function windowStartYear(threshold, table) {
  let best = null;
  for (const row of table) {
    if (threshold >= row.min && (best === null || row.min > best.min)) best = row;
  }
  return best ? best.start : null;
}

const dayOfYearStart = (year) => Math.round((Date.UTC(year, 0, 1) - EPOCH_1900_MS) / DAY_MS);

/**
 * Smoothed monthly climatology (12 factors, mean 1) for events of hazard
 * `type` (or all types, type = null) with metric value ≥ floor, in the
 * modern era. Returns null when too few events to be meaningful.
 */
export function monthlyProfile(imp, { metric = 'deaths', us = false, type = null, floor, sinceYear = 2000 }) {
  const startDay = dayOfYearStart(sinceYear);
  const counts = new Array(12).fill(0);
  let n = 0;
  for (let i = 0; i < imp.n; i++) {
    if (imp.day[i] < startDay || imp.day[i] >= imp.meta.dataEndDay) continue;
    if (type !== null && imp.type[i] !== type) continue;
    if (imp.month[i] < 1) continue;
    if (imp.value(i, metric, us) < floor) continue;
    counts[imp.month[i] - 1]++;
    n++;
  }
  if (n < 60) return null; // too sparse for a monthly signal
  const smooth = counts.map((_, m) =>
    0.25 * counts[(m + 11) % 12] + 0.5 * counts[m] + 0.25 * counts[(m + 1) % 12]);
  const mean = smooth.reduce((a, b) => a + b, 0) / 12;
  return smooth.map((v) => v / mean);
}

/**
 * Mean seasonal factor over a forecast window [startMs, startMs + T years)
 * for a monthly profile. Integrates month-by-month; ≥ 2-year windows are 1
 * by construction (whole years average out).
 */
export function seasonalFactor(profile, startMs, windowYears) {
  if (!profile || windowYears >= 2) return 1;
  let remainingDays = windowYears * DAYS_PER_YEAR;
  const d = new Date(startMs);
  let y = d.getUTCFullYear(), m = d.getUTCMonth(), dayInMonth = d.getUTCDate() - 1;
  let acc = 0, total = 0;
  while (remainingDays > 0.01) {
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const take = Math.min(remainingDays, daysInMonth - dayInMonth);
    acc += profile[m] * take;
    total += take;
    remainingDays -= take;
    dayInMonth = 0; m++;
    if (m === 12) { m = 0; y++; }
  }
  return total > 0 ? acc / total : 1;
}

/**
 * The dashboard's core computation.
 *
 * imp          decoded impacts data
 * metric       'deaths' | 'damage'  (damage thresholds in CPI-adjusted '000 US$)
 * threshold    events with metric value ≥ threshold count
 * windowYears  forecast window starting at nowMs
 * us           scope to United States (incl. territories) impact components
 * nowMs        wall-clock now (used only for the seasonal phase)
 */
export function assessImpact(imp, { metric, threshold, windowYears, us = false, nowMs = Date.now() }) {
  const table = metric === 'deaths' ? imp.completeness.deaths : imp.completeness.damageK;
  const startYear = windowStartYear(threshold, table);
  if (startYear === null) return null;
  const startDay = dayOfYearStart(startYear);
  const endDay = imp.meta.dataEndDay;
  const Tyears = (endDay - startDay) / DAYS_PER_YEAR;

  const nHaz = imp.meta.hazards.length;
  const counts = new Array(nHaz).fill(0);
  const lastIdx = new Array(nHaz).fill(-1);
  let total = 0, lastAny = -1, maxVal = 0, maxIdx = -1;
  const qualifying = [];
  for (let i = 0; i < imp.n; i++) {
    const v = imp.value(i, metric, us);
    if (v >= maxVal && imp.day[i] >= startDay && imp.day[i] < endDay) { maxVal = Math.max(maxVal, v); maxIdx = i; }
    if (v < threshold) continue;
    if (imp.day[i] < startDay || imp.day[i] >= endDay) continue;
    const h = imp.type[i];
    counts[h]++; total++;
    if (lastIdx[h] < 0 || imp.day[i] > imp.day[lastIdx[h]]) lastIdx[h] = i;
    if (lastAny < 0 || imp.day[i] > imp.day[lastAny]) lastAny = i;
    qualifying.push(i);
  }

  // floor for the seasonal climatology: a level with enough events for a
  // stable monthly signal, never above the requested threshold's own scale
  const floor = metric === 'deaths' ? Math.min(threshold, 10) : Math.min(threshold, 1e5);

  const perHazard = [];
  let lambdaTotal = 0, lambdaEffTotal = 0;
  for (let h = 0; h < nHaz; h++) {
    const lambda = counts[h] / Tyears;
    const profile = monthlyProfile(imp, { metric, us, type: h, floor });
    const s = seasonalFactor(profile, nowMs, windowYears);
    lambdaTotal += lambda;
    lambdaEffTotal += lambda * s;
    perHazard.push({
      hazard: imp.meta.hazards[h], type: h, n: counts[h], lambda,
      ci95: poissonRateCI(counts[h], Tyears, 0.95),
      seasonal: s,
      prob: poissonProb(lambda * s, windowYears),
      lastIdx: lastIdx[h] >= 0 ? lastIdx[h] : null,
    });
  }
  for (const ph of perHazard) ph.share = lambdaEffTotal > 0 ? (ph.lambda * ph.seasonal) / lambdaEffTotal : 0;

  const ciTotal = poissonRateCI(total, Tyears, 0.95);
  const seasonalNet = lambdaTotal > 0 ? lambdaEffTotal / lambdaTotal : 1;
  return {
    metric, threshold, windowYears, us,
    windowStartYear: startYear, Tyears, n: total,
    lambda: lambdaTotal, lambdaEff: lambdaEffTotal, ci95: ciTotal,
    seasonalNet,
    prob: poissonProb(lambdaEffTotal, windowYears),
    probLo: poissonProb(ciTotal.lo * seasonalNet, windowYears),
    probHi: poissonProb(ciTotal.hi * seasonalNet, windowYears),
    perHazard: perHazard.sort((a, b) => b.share - a.share),
    lastIdx: lastAny >= 0 ? lastAny : null,
    maxObserved: maxVal, maxIdx: maxVal > 0 ? maxIdx : null,
    qualifying,
  };
}

/**
 * Exceedance curve for the frequency–severity chart: annual rate of events
 * ≥ x at log-spaced thresholds, per hazard and total, each computed inside
 * its own completeness window.
 */
export function exceedanceCurve(imp, { metric, us = false, points = 28 }) {
  const lo = metric === 'deaths' ? 10 : 1e5;
  const hi = metric === 'deaths' ? 2e6 : 5e8;
  const out = [];
  for (let k = 0; k < points; k++) {
    const x = lo * Math.pow(hi / lo, k / (points - 1));
    const a = assessImpact(imp, { metric, threshold: x, windowYears: 1, us });
    if (!a || a.n === 0) continue;
    out.push({ x, lambda: a.lambda, ci95: a.ci95, perHazard: a.perHazard.map((p) => ({ type: p.type, lambda: p.lambda })) });
  }
  return out;
}
