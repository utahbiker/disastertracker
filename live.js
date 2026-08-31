// live.js — the "Happening now" layer: live situational awareness fetched by
// the BROWSER from open feeds (USGS, GDACS, ReliefWeb). Display only.
//
// ⚠️ Separation of concerns, on purpose: nothing in this module ever feeds
// the probability model. The statistics on this page come only from the
// validated historical record (METHODOLOGY Parts II–V); live alerts are
// operational awareness with completely different semantics (alert levels,
// not qualifying events). Each source degrades independently — a failed
// fetch shows a status line, never a broken page.

import { gammaP } from './engine.js';

// Long-run global rate of M ≥ 5.0 earthquakes, derived from the shipped
// modern catalog (2000-01-01 → 2024-01-08: 42,707 events / 24.02 yr).
// Pinned against the catalog by test/live.test.mjs so it cannot silently
// drift when the data refreshes.
export const M5_ANNUAL_RATE = 1778.0;

export const PULSE_WINDOW_DAYS = 30;

/** Exact Poisson CDF via the regularized incomplete gamma: P(X ≤ n | μ). */
const poissonCDF = (n, mu) => (n < 0 ? 0 : 1 - gammaP(n + 1, mu));

/**
 * Verdict on an observed 30-day M5+ count vs the long-run expectation:
 * exact central 95% Poisson count interval → 'quiet' | 'normal' | 'elevated'.
 * lo = smallest n with P(X ≤ n) ≥ 2.5%; hi = smallest n with P(X ≤ n) ≥ 97.5%.
 */
export function seismicPulseVerdict(observed, windowDays = PULSE_WINDOW_DAYS, annualRate = M5_ANNUAL_RATE) {
  const mu = annualRate * windowDays / 365.25;
  let lo = 0;
  while (poissonCDF(lo, mu) < 0.025) lo++;
  let hi = lo;
  while (poissonCDF(hi, mu) < 0.975) hi++;
  const verdict = observed < lo ? 'quiet' : observed > hi ? 'elevated' : 'normal';
  return { mu, lo, hi, verdict };
}

// GDACS event-type codes → display
export const GDACS_TYPES = {
  EQ: { label: 'Earthquake', icon: '🌐' },
  TC: { label: 'Tropical cyclone', icon: '🌀' },
  FL: { label: 'Flood', icon: '🌊' },
  VO: { label: 'Volcano', icon: '🌋' },
  WF: { label: 'Wildfire', icon: '🔥' },
  DR: { label: 'Drought', icon: '☀️' },
  TS: { label: 'Tsunami', icon: '🌊' },
};

/**
 * Parse a GDACS geteventlist/MAP GeoJSON FeatureCollection into display
 * rows. Defensive: unknown shapes are skipped, property spellings vary
 * across GDACS deployments. Returns { alerts: [...], greens: n } with
 * alerts (Red then Orange) sorted most-severe first.
 */
export function parseGdacs(gj) {
  const feats = Array.isArray(gj?.features) ? gj.features : [];
  const alerts = [];
  let greens = 0;
  for (const f of feats) {
    const p = f?.properties ?? {};
    const level = String(p.alertlevel ?? p.alertLevel ?? '').toLowerCase();
    if (!level) continue;
    const type = String(p.eventtype ?? p.eventType ?? '').toUpperCase();
    const t = GDACS_TYPES[type] ?? { label: type || 'Event', icon: '⚠️' };
    if (level === 'green') { greens++; continue; }
    if (level !== 'red' && level !== 'orange') continue;
    alerts.push({
      level,
      type,
      label: t.label,
      icon: t.icon,
      name: String(p.eventname ?? p.name ?? '').slice(0, 60),
      country: String(p.country ?? '').slice(0, 60),
      from: String(p.fromdate ?? p.fromDate ?? '').slice(0, 10),
      url: typeof p?.url?.report === 'string' ? p.url.report : (typeof p.link === 'string' ? p.link : null),
    });
  }
  alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
  return { alerts, greens };
}

/** Parse a ReliefWeb /v1/disasters listing into the same row shape. */
export function parseReliefWeb(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const alerts = [];
  for (const r of rows) {
    const f = r?.fields ?? {};
    const status = String(f.status ?? '').toLowerCase();
    if (status !== 'alert' && status !== 'ongoing' && status !== 'current') continue;
    alerts.push({
      level: status === 'alert' ? 'orange' : 'ongoing',
      type: '',
      label: String(f?.primary_type?.name ?? f?.type?.[0]?.name ?? 'Disaster').slice(0, 40),
      icon: '⚠️',
      name: String(f.name ?? '').slice(0, 80),
      country: String(f?.primary_country?.name ?? '').slice(0, 60),
      from: String(f?.date?.created ?? '').slice(0, 10),
      url: typeof f.url === 'string' ? f.url : (typeof r.href === 'string' ? r.href : null),
    });
  }
  return { alerts, greens: 0 };
}

// ─── fetchers (browser only; each independently fallible) ────────────────

const timeoutFetch = (url, ms = 15000) => fetch(url, { signal: AbortSignal.timeout(ms) })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

export async function fetchSeismicPulse() {
  const since = new Date(Date.now() - PULSE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const base = 'https://earthquake.usgs.gov/fdsnws/event/1/';
  const count = await timeoutFetch(`${base}count?format=geojson&starttime=${since}&minmagnitude=5&eventtype=earthquake`);
  const big = await timeoutFetch(`${base}query?format=geojson&starttime=${since}&minmagnitude=6.5&eventtype=earthquake&orderby=magnitude&limit=5`);
  return {
    observed: count.count,
    largest: big.features.map((f) => ({
      mag: f.properties.mag,
      place: f.properties.place ?? '',
      timeMs: f.properties.time,
      url: f.properties.url,
    })),
  };
}

export async function fetchAlerts() {
  try {
    const gj = await timeoutFetch('https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP');
    return { source: 'GDACS', ...parseGdacs(gj) };
  } catch {
    const rw = await timeoutFetch('https://api.reliefweb.int/v1/disasters?appname=disastertracker-goinwardout&preset=latest&profile=list&limit=12');
    return { source: 'ReliefWeb', ...parseReliefWeb(rw) };
  }
}
