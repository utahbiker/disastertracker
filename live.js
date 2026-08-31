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
  LS: { label: 'Landslide', icon: '⛰️' },
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
    // Point geometry gives the alert a globe position
    const coords = f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    const fromRaw = String(p.fromdate ?? p.fromDate ?? '');
    const timeMs = Date.parse(fromRaw);
    alerts.push({
      level,
      type,
      label: t.label,
      icon: t.icon,
      name: String(p.eventname ?? p.name ?? '').slice(0, 60),
      country: String(p.country ?? '').slice(0, 60),
      from: fromRaw.slice(0, 10),
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
      lat: coords && Number.isFinite(coords[1]) ? coords[1] : null,
      lon: coords && Number.isFinite(coords[0]) ? coords[0] : null,
      url: typeof p?.url?.report === 'string' ? p.url.report : (typeof p.link === 'string' ? p.link : null),
    });
  }
  alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
  return { alerts, greens };
}

/**
 * Parse a ReliefWeb /v1/disasters listing into the same row shape. When the
 * query includes primary_country.location, alerts carry the affected
 * country's centroid so they can ping the globe (coarser than GDACS
 * positions, but honest — the whole row is country-scoped).
 */
export function parseReliefWeb(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const alerts = [];
  for (const r of rows) {
    const f = r?.fields ?? {};
    const status = String(f.status ?? '').toLowerCase();
    if (status !== 'alert' && status !== 'ongoing' && status !== 'current') continue;
    const label = String(f?.primary_type?.name ?? f?.type?.[0]?.name ?? 'Disaster').slice(0, 40);
    const code = hazardCode(label);
    const loc = f?.primary_country?.location;
    const timeMs = Date.parse(String(f?.date?.created ?? ''));
    alerts.push({
      level: status === 'alert' ? 'orange' : 'ongoing',
      type: code,
      label,
      icon: (GDACS_TYPES[code] ?? { icon: '⚠️' }).icon,
      name: String(f.name ?? '').slice(0, 80),
      country: String(f?.primary_country?.name ?? '').slice(0, 60),
      from: String(f?.date?.created ?? '').slice(0, 10),
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
      lat: loc && Number.isFinite(loc.lat) ? loc.lat : null,
      lon: loc && Number.isFinite(loc.lon) ? loc.lon : null,
      source: 'ReliefWeb',
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
    const rw = await timeoutFetch('https://api.reliefweb.int/v1/disasters?appname=disastertracker-goinwardout&preset=latest&profile=list&limit=20'
      + '&fields[include][]=primary_country.location');
    return { source: 'ReliefWeb', ...parseReliefWeb(rw) };
  }
}

// ─── globe events: STATISTICALLY MAJOR events of the last 21 days ────────
//
// Thresholds (documented in METHODOLOGY § 12b): an event pings the globe
// only when it clears a rarity bar —
//   · earthquakes at M ≥ 5.9: λ = 193/yr from this site's own catalog,
//     one every ~1.9 days globally (~11 in a 21-day window). M5.5s
//     (2.7× more common) would reduce the globe to noise.
//   · every other hazard at GDACS ORANGE or RED: GDACS's alert score is
//     calibrated to expected humanitarian impact, which is the right
//     severity scale for non-seismic hazards; greens are excluded.
//   · tropical storms at HURRICANE STRENGTH (≥ 64 kt sustained — the
//     Saffir–Simpson Category-1 bar) via NASA EONET, which carries
//     precise storm positions and works from any browser.
//   · when GDACS is unreachable, ReliefWeb's current-disaster list fills
//     in (alerts pinned at the affected country's centroid).

export const GLOBE_QUAKE_MIN_MAG = 5.9;
export const GLOBE_WINDOW_DAYS = 21;
export const GLOBE_MAX_EVENTS = 40; // clutter bound, rarely reached
export const EONET_MIN_KTS = 64;    // hurricane-force

// ping colors per hazard family ('ALPHA' replaced at render time).
// Quakes are bright saturated gold — deliberately hotter than the dim
// brass coastlines so they can never camouflage against the geography.
const PING = {
  quake: 'rgba(255,214,90,ALPHA)',
  TC: 'rgba(120,180,255,ALPHA)',
  FL: 'rgba(90,220,205,ALPHA)',
  VO: 'rgba(255,140,70,ALPHA)',
  WF: 'rgba(255,110,95,ALPHA)',
  DR: 'rgba(222,175,95,ALPHA)',
  LS: 'rgba(196,160,130,ALPHA)',
  other: 'rgba(200,140,255,ALPHA)',
};

/** Infer a GDACS-style hazard code from a free-text disaster-type label. */
export function hazardCode(label) {
  const s = String(label ?? '').toLowerCase();
  if (/earthquake|seism/.test(s)) return 'EQ';
  if (/cyclone|hurricane|typhoon|tropical storm|storm/.test(s)) return 'TC';
  if (/flood/.test(s)) return 'FL';
  if (/volcan/.test(s)) return 'VO';
  if (/fire/.test(s)) return 'WF';
  if (/drought/.test(s)) return 'DR';
  if (/land ?slide|mud ?slide|avalanche/.test(s)) return 'LS';
  return '';
}

const lonDiff = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };

/**
 * Merge positioned events from all sources into the globe's list:
 * 21-day window, threshold-filtered, deduplicated across sources (same
 * hazard kind within 3° and 4 days is the same event — the first-listed
 * source wins, and sources are passed in metadata-quality order:
 * USGS quakes, then GDACS/ReliefWeb alerts, then EONET storms),
 * newest first, clutter-capped.
 */
export function mergeGlobeEvents(quakes, alerts, storms = [], nowMs = Date.now()) {
  const cutoff = nowMs - GLOBE_WINDOW_DAYS * 86400000;
  const out = [];
  const dupe = (kind, lat, lon, timeMs) => out.some((e) => e.kind === kind
    && Math.abs(e.lat - lat) < 3 && Math.abs(lonDiff(e.lon, lon)) < 3
    && Math.abs(e.timeMs - timeMs) < 4 * 86400000);
  for (const q of quakes) {
    if (!(q.mag >= GLOBE_QUAKE_MIN_MAG - 1e-9)) continue;
    if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon) || q.timeMs < cutoff) continue;
    out.push({
      kind: 'EQ', icon: '🌐', color: PING.quake,
      lat: q.lat, lon: q.lon, timeMs: q.timeMs,
      title: `M ${q.mag.toFixed(1)} — ${q.place || 'earthquake'}`,
      short: `M ${q.mag.toFixed(1)}`,
      detail: 'Earthquake', level: null, url: q.url ?? null,
    });
  }
  for (const a of alerts) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(a.timeMs)) continue;
    if (a.timeMs < cutoff) continue;
    const kind = a.type || hazardCode(a.label) || 'other';
    if (dupe(kind, a.lat, a.lon, a.timeMs)) continue;
    const base = a.name || a.label;
    const withCountry = a.country && !base.toLowerCase().includes(a.country.toLowerCase());
    out.push({
      kind, icon: a.icon, color: PING[kind] ?? PING.other,
      lat: a.lat, lon: a.lon, timeMs: a.timeMs,
      title: `${base}${withCountry ? ` — ${a.country}` : ''}`,
      short: a.name || a.label,
      detail: `${a.label}${a.level && a.level !== 'ongoing' ? ` · ${a.source ?? 'GDACS'} ${a.level}` : a.level === 'ongoing' ? ' · ongoing' : ''}`,
      level: a.level, url: a.url,
    });
  }
  for (const s of storms) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || !Number.isFinite(s.timeMs)) continue;
    if (s.timeMs < cutoff) continue;
    if (dupe('TC', s.lat, s.lon, s.timeMs)) continue;
    out.push({
      kind: 'TC', icon: '🌀', color: PING.TC,
      lat: s.lat, lon: s.lon, timeMs: s.timeMs,
      title: s.name,
      short: s.name,
      detail: `Hurricane-strength storm${s.kts ? ` · ${Math.round(s.kts)} kt` : ''}`,
      level: 'orange', url: s.url ?? null,
    });
  }
  out.sort((x, y) => y.timeMs - x.timeMs);
  return out.slice(0, GLOBE_MAX_EVENTS);
}

/** Quakes M ≥ GLOBE_QUAKE_MIN_MAG over the globe window, positioned. */
export async function fetchGlobeQuakes(days = GLOBE_WINDOW_DAYS) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const gj = await timeoutFetch('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson' +
    `&starttime=${since}&minmagnitude=${GLOBE_QUAKE_MIN_MAG}&eventtype=earthquake&orderby=time&limit=60`);
  return gj.features.map((f) => ({
    mag: f.properties.mag,
    place: f.properties.place ?? '',
    timeMs: f.properties.time,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    url: f.properties.url,
  }));
}

/**
 * NASA EONET open severe storms at hurricane strength (≥ 64 kt) — the one
 * open feed with precise, current storm positions and permissive CORS.
 * Returns the latest track point of each qualifying storm.
 */
export function parseEonetStorms(json, minKts = EONET_MIN_KTS) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const out = [];
  for (const ev of events) {
    const g = Array.isArray(ev.geometry) ? ev.geometry : [];
    let maxKts = 0, last = null;
    for (const p of g) {
      if (p?.magnitudeUnit === 'kts' && Number.isFinite(p.magnitudeValue)) maxKts = Math.max(maxKts, p.magnitudeValue);
      if (Array.isArray(p?.coordinates) && p.date) last = p;
    }
    if (maxKts < minKts || !last) continue;
    const t = Date.parse(last.date);
    out.push({
      name: String(ev.title ?? 'Severe storm').slice(0, 60),
      kts: maxKts,
      lon: last.coordinates[0], lat: last.coordinates[1],
      timeMs: Number.isFinite(t) ? t : null,
      url: typeof ev.link === 'string' ? ev.link : null,
    });
  }
  return out;
}

export async function fetchEonetStorms() {
  const json = await timeoutFetch(`https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=severeStorms&days=${GLOBE_WINDOW_DAYS}&limit=60`);
  return parseEonetStorms(json);
}
