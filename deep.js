// deep.js — deep-history layer: colossal-eruption occurrence probabilities
// and the documented-catastrophes record. Statistics utilities from engine.js.
//
// Two very different uses of the deep past (METHODOLOGY.md Part III):
//   RATES  — only where the record is complete at that size: VEI≥6 from
//            1500 CE, VEI≥7 from 900 CE, M≥8.5 from 1900 (instrumental).
//   DISPLAY — documented catastrophes across ~4 millennia, era-labeled,
//            never feeding the probability model (the completeness ramp in
//            centuryRamp() is the evidence for that separation).

import { poissonRateCI, poissonProb } from './engine.js';

const NOW_YEAR = () => new Date().getUTCFullYear();

/** Occurrence assessment for one extreme class over its complete window. */
function occurrenceRate(events, { start, end, pick }) {
  const qualifying = events.filter((e) => e.y >= start && e.y <= end && pick(e));
  const Tyears = end - start + 1;
  const n = qualifying.length;
  const lambda = n / Tyears;
  return {
    n, Tyears, start, end, lambda,
    ci95: poissonRateCI(n, Tyears, 0.95),
    last: qualifying.length ? qualifying[qualifying.length - 1] : null,
    events: qualifying,
  };
}

/**
 * The three deep-history extreme classes. windowYears is the forecast
 * window; probabilities are homogeneous-Poisson over the class rate.
 */
export function assessExtremes(deep, windowYears) {
  const out = {};
  const defs = {
    vei6: { events: deep.eruptions, start: deep.occurrence.vei6.start, end: deep.meta.eruptionsEnd, pick: (e) => e.vei >= 6, label: 'Colossal eruption (VEI ≥ 6)' },
    vei7: { events: deep.eruptions, start: deep.occurrence.vei7.start, end: deep.meta.eruptionsEnd, pick: (e) => e.vei >= 7, label: 'Super-colossal eruption (VEI ≥ 7)' },
    m85: { events: deep.quakes, start: deep.occurrence.m85.start, end: deep.meta.quakesEnd, pick: (e) => e.mag !== null && e.mag >= 8.5, label: 'Great earthquake (M ≥ 8.5)' },
  };
  for (const [key, d] of Object.entries(defs)) {
    const r = occurrenceRate(d.events, d);
    out[key] = {
      key, label: d.label, ...r,
      prob: poissonProb(r.lambda, windowYears),
      probLo: poissonProb(r.ci95.lo, windowYears),
      probHi: poissonProb(r.ci95.hi, windowYears),
      quietYears: r.last ? NOW_YEAR() - r.last.y : null,
    };
  }
  return out;
}

/**
 * Documented catastrophes across the whole record, merged and era-labeled:
 * earthquakes with deaths ≥ minDeaths, all VEI≥7 eruptions, and (optionally)
 * modern-era events supplied by the caller from the EM-DAT impact catalog.
 * Sorted chronologically.
 */
export function documentedCatastrophes(deep, { minDeaths = 100000, extra = [] } = {}) {
  const rows = [];
  for (const q of deep.quakes) {
    if (q.deaths !== null && q.deaths >= minDeaths) {
      rows.push({ y: q.y, kind: 'Earthquake', name: q.name, detail: q.mag ? `M ${q.mag.toFixed(1)}${q.tsu ? ' + tsunami' : ''}` : (q.tsu ? 'tsunami' : ''), deaths: q.deaths, source: 'NCEI' });
    }
  }
  for (const e of deep.eruptions) {
    if (e.vei >= 7) {
      rows.push({ y: e.y, kind: 'Eruption', name: e.name, detail: `VEI ${e.vei}`, deaths: null, source: 'GVP' });
    }
  }
  rows.push(...extra);
  rows.sort((a, b) => a.y - b.y);
  return rows;
}

/**
 * Century counts for an extreme class — the completeness-ramp evidence.
 * Returns [{century, n}] ascending. A count that climbs century over
 * century for a physically stationary process is a documentation artifact.
 */
export function centuryRamp(events, pick, fromCentury = 1500, toCentury = 1900) {
  const out = [];
  for (let c = fromCentury; c <= toCentury; c += 100) {
    out.push({ century: c, n: events.filter((e) => e.y >= c && e.y < c + 100 && pick(e)).length });
  }
  return out;
}

export const eraLabel = (y) => (y < 0 ? `${-y} BC` : y < 1000 ? `${y} CE` : String(y));
