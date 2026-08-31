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

import { poissonRateCI, poissonProb, fitGammaMLE, gammaCDF } from './engine.js';

/**
 * Poisson log-linear trend fit on annual counts (IRLS): log mu_y = a + b*x.
 * Returns the multiplier that converts the window-average rate into the
 * trend-evaluated rate at `forecastYear`, with three guards that were part
 * of the validated (backtested) configuration:
 *   - the trend is used only when its slope is significant (|z| >= 2);
 *   - the projection year is capped at lastTrainingYear + 3;
 *   - the multiplier is clamped to [1/3, 3].
 * Walk-forward validation (backtest/backtest.mjs): +7.7% Brier skill vs the
 * flat rate at deaths>=100, neutral elsewhere (gate closes). See
 * METHODOLOGY Part IV.
 */
export function poissonTrendMultiplier(annualCounts, startYear, forecastYear) {
  const years = annualCounts.length;
  if (years < 15) return 1;
  const mid = (startYear + forecastYear) / 2;
  const x = annualCounts.map((_, k) => startYear + k - mid);
  let a = Math.log(Math.max(1e-6, annualCounts.reduce((s, c) => s + c, 0) / years)), b = 0;
  for (let it = 0; it < 25; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let k = 0; k < years; k++) {
      const mu = Math.exp(a + b * x[k]);
      g0 += annualCounts[k] - mu; g1 += (annualCounts[k] - mu) * x[k];
      h00 += mu; h01 += mu * x[k]; h11 += mu * x[k] * x[k];
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (g0 * h11 - g1 * h01) / det, db = (g1 * h00 - g0 * h01) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  let h00 = 0, h01 = 0, h11 = 0;
  for (let k = 0; k < years; k++) {
    const mu = Math.exp(a + b * x[k]);
    h00 += mu; h01 += mu * x[k]; h11 += mu * x[k] * x[k];
  }
  const det = h00 * h11 - h01 * h01;
  if (det <= 0) return 1;
  const seB = Math.sqrt(h00 / det);
  if (!Number.isFinite(seB) || Math.abs(b / seB) < 2) return 1;
  const lastTrain = startYear + years - 1;
  const xf = Math.min(forecastYear, lastTrain + 3) - mid;
  const flat = annualCounts.reduce((s, c) => s + c, 0) / years;
  const mult = Math.exp(a + b * xf) / Math.max(1e-9, flat);
  return Math.min(3, Math.max(1 / 3, mult));
}

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

  // trend multiplier — fitted on the aggregate annual counts of qualifying
  // events (the exact configuration validated by the walk-forward backtest),
  // applied uniformly so the per-hazard decomposition stays consistent
  const startCalYear = startYear;
  const nowYear = new Date(nowMs).getUTCFullYear();
  const lastDataYear = new Date(msOfDay(endDay)).getUTCFullYear() - 1; // last complete year
  let trend = 1;
  if (lastDataYear - startCalYear + 1 >= 15) {
    const annual = [];
    for (let y = startCalYear; y <= lastDataYear; y++) annual.push(0);
    for (const i of qualifying) {
      const y = new Date(msOfDay(imp.day[i])).getUTCFullYear();
      if (y >= startCalYear && y <= lastDataYear) annual[y - startCalYear]++;
    }
    trend = poissonTrendMultiplier(annual, startCalYear, nowYear);
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
    lambdaEffTotal += lambda * s * trend;
    perHazard.push({
      hazard: imp.meta.hazards[h], type: h, n: counts[h], lambda,
      ci95: poissonRateCI(counts[h], Tyears, 0.95),
      seasonal: s,
      prob: poissonProb(lambda * s * trend, windowYears),
      lastIdx: lastIdx[h] >= 0 ? lastIdx[h] : null,
    });
  }
  for (const ph of perHazard) ph.share = lambdaEffTotal > 0 ? (ph.lambda * ph.seasonal * trend) / lambdaEffTotal : 0;

  const ciTotal = poissonRateCI(total, Tyears, 0.95);
  const seasonalNet = lambdaTotal > 0 ? lambdaEffTotal / (lambdaTotal * trend) : 1;
  return {
    trend,
    metric, threshold, windowYears, us,
    windowStartYear: startYear, Tyears, n: total,
    lambda: lambdaTotal, lambdaEff: lambdaEffTotal, ci95: ciTotal,
    seasonalNet,
    prob: poissonProb(lambdaEffTotal, windowYears),
    probLo: poissonProb(ciTotal.lo * seasonalNet * trend, windowYears),
    probHi: poissonProb(ciTotal.hi * seasonalNet * trend, windowYears),
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


/**
 * Renewal ("overdue") assessment for an impact threshold: fits a Gamma
 * distribution to the observed inter-event gaps inside the completeness
 * window and conditions on the time elapsed since the last event.
 * Requires >= 15 gaps to fit honestly. This is a COMPARISON view: the
 * headline stays Poisson+trend unless walk-forward backtesting shows the
 * renewal conditioning predicts better (backtest model M4).
 */
export function assessRenewal(imp, { metric, threshold, windowYears, us = false, nowMs = Date.now() }) {
  const table = metric === 'deaths' ? imp.completeness.deaths : imp.completeness.damageK;
  const startYear = windowStartYear(threshold, table);
  if (startYear === null) return { ok: false, reason: 'below modeled range' };
  const startDay = Math.round((Date.UTC(startYear, 0, 1) - EPOCH_1900_MS) / DAY_MS);
  const days = [];
  for (let i = 0; i < imp.n; i++) {
    if (imp.value(i, metric, us) >= threshold && imp.day[i] >= startDay && imp.day[i] < imp.meta.dataEndDay) days.push(imp.day[i]);
  }
  days.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(Math.max(1 / 365.25, (days[i] - days[i - 1]) / 365.25));
  if (gaps.length < 15) return { ok: false, reason: 'too few inter-event gaps', nGaps: gaps.length };
  const fit = fitGammaMLE(gaps);
  if (!fit) return { ok: false, reason: 'degenerate fit', nGaps: gaps.length };
  const elapsedYears = (dayOfMs(nowMs) - days[days.length - 1]) / 365.25;
  const F = (x) => gammaCDF(x, fit.k, fit.theta);
  const surv = 1 - F(elapsedYears);
  const prob = surv < 1e-9 ? 1 : Math.min(1, Math.max(0, (F(elapsedYears + windowYears) - F(elapsedYears)) / surv));
  return {
    ok: true, nGaps: gaps.length,
    meanGapYears: fit.mean, cv: fit.cv, k: fit.k,
    elapsedYears, lastDay: days[days.length - 1],
    prob,
  };
}
