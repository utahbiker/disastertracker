// anomaly.js — the "Seismologist's watchlist": sub-threshold seismic anomaly
// radar for the Happening-now page. Scans USGS's rolling 30-day M1+ feed and
// flags places where the LAST 7 DAYS are statistically incompatible with that
// same place's PRIOR 23 days — the signature a seismologist actually watches
// (swarm switch-ons, accelerating sequences, escalating magnitudes), at
// magnitudes far below the globe's M 5.9 "major event" threshold.
//
// ⚠️ What this is NOT (METHODOLOGY § 12c): earthquake prediction. No reliable
// short-term precursor is known to science. Worldwide, the chance that any
// earthquake is followed by a LARGER one nearby within a week is ~5% (USGS).
// The watchlist reports statistical anomalies — most of them will end
// quietly. It never feeds the probability model (§ 12b separation applies).
//
// Design choices, stated so they can be argued with:
//   - Self-relative baseline: each cell is compared with ITSELF over the same
//     feed, so wildly uneven catalog completeness (the US network sees M1.0;
//     the mid-ocean ridges see M4.5) cancels out of the rate ratio instead of
//     minting fake anomalies at network boundaries.
//   - Exact Poisson surprise, not z-scores: counts are small; the tail
//     P(X ≥ n | μ) is computed exactly via the regularized incomplete gamma.
//   - A 0.5-event pseudo-count on the baseline keeps p finite when a swarm
//     switches on in a previously silent cell (the Milford/FORGE case).
//   - Aftershock sequences are DETECTED but LABELED as expected: a mainshock
//     followed by Omori decay is normal physics, not a warning sign. They are
//     listed last, for context, never as anomalies.

import { gammaP } from './engine.js';

// USGS rolling 30-day feed of all M ≥ 1.0 events, permissive CORS, ~2–5 MB.
export const ANOMALY_FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/1.0_month.geojson';
// The feed is heavy; rescan on its own cadence, not the 2-minute page cycle.
export const ANOMALY_REFRESH_MS = 15 * 60 * 1000;

export const RECENT_DAYS = 7;    // the "now" window
export const BASELINE_DAYS = 23; // the rest of the 30-day feed
export const CELL_DEG = 0.75;    // ~83 km grid cells (lon width cos-adjusted)
export const MIN_RECENT = 10;    // fewer recent events than this: never flag
export const P_FLAG = 1e-4;      // exact Poisson tail must beat this
export const MERGE_KM = 200;     // adjacent flagged cells fuse into one cluster
export const MAX_WATCHLIST = 6;  // display cap, most interesting first
export const MAINSHOCK_MIN_MAG = 5.0; // a max-mag ≥ this that leads the burst ⇒ aftershocks

/** Exact Poisson tail P(X ≥ k | μ) — identity with the regularized lower
 *  incomplete gamma; verified against direct summation in tests. */
export const poissonTail = (k, mu) => (k <= 0 ? 1 : gammaP(k, mu));

const DEG = Math.PI / 180;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dphi = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dphi / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Equal-area-ish cell key: fixed lat bands, lon width widened by 1/cos. */
export function cellKey(lat, lon) {
  const bi = Math.floor((lat + 90) / CELL_DEG);
  const latC = (bi + 0.5) * CELL_DEG - 90;
  const widDeg = CELL_DEG / Math.max(Math.cos(latC * DEG), 0.2);
  const li = Math.floor(((lon + 540) % 360) / widDeg); // lon normalized to [0,360)
  return `${bi}:${li}`;
}

/** GeoJSON summary feed → the minimal event shape the detector needs. */
export function parseQuakeFeed(gj) {
  const out = [];
  for (const f of gj?.features ?? []) {
    const p = f.properties ?? {}, c = f.geometry?.coordinates ?? [];
    if (p.type && p.type !== 'earthquake') continue; // skip explosions/quarry
    if (!Number.isFinite(p.mag) || !Number.isFinite(p.time)) continue;
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    out.push({
      mag: p.mag, timeMs: p.time, lon: c[0], lat: c[1],
      depthKm: Number.isFinite(c[2]) ? c[2] : null,
      place: p.place ?? '', url: p.url ?? null,
    });
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function clusterStats(events, nowMs) {
  const recentCut = nowMs - RECENT_DAYS * 86400000;
  const recent = events.filter((e) => e.timeMs >= recentCut);
  const prior = events.filter((e) => e.timeMs < recentCut);
  const n7 = recent.length, nPrior = prior.length;
  // baseline expectation for the recent window, with a 0.5-event pseudo-count
  const mu = RECENT_DAYS * Math.max(nPrior, 0.5) / BASELINE_DAYS;
  const p = poissonTail(n7, mu);
  const rateRatio = (n7 / RECENT_DAYS) / (Math.max(nPrior, 0.5) / BASELINE_DAYS);

  let top = events[0];
  for (const e of events) if (e.mag > top.mag) top = e;
  const recentMax = recent.length ? Math.max(...recent.map((e) => e.mag)) : -Infinity;
  const priorMax = prior.length ? Math.max(...prior.map((e) => e.mag)) : -Infinity;

  // magnitude escalation: is the sequence producing its largest events late?
  let escalating;
  if (nPrior >= 3) {
    escalating = recentMax > priorMax + 0.05;
  } else {
    // new swarm: split its own timeline in half and compare maxima
    const ts = events.map((e) => e.timeMs);
    const mid = (Math.min(...ts) + Math.max(...ts)) / 2;
    const early = events.filter((e) => e.timeMs < mid);
    const late = events.filter((e) => e.timeMs >= mid);
    escalating = early.length >= 3 && late.length >= 3 &&
      Math.max(...late.map((e) => e.mag)) > Math.max(...early.map((e) => e.mag)) + 0.05;
  }

  // aftershock sequence: a qualifying mainshock LEADS the burst (most cluster
  // events follow it, nothing after it has exceeded it) ⇒ expected physics
  const after = events.filter((e) => e.timeMs > top.timeMs).length;
  const isAftershocks = top.mag >= MAINSHOCK_MIN_MAG &&
    after >= events.length * 0.5 && recentMax <= top.mag;

  return {
    lat: median(events.map((e) => e.lat)),
    lon: median(events.map((e) => e.lon)),
    n: events.length, n7, nPrior, mu, p, rateRatio,
    maxMag: top.mag, maxMagTimeMs: top.timeMs, maxMagUrl: top.url,
    place: top.place,
    recentMax: Number.isFinite(recentMax) ? recentMax : null,
    priorMax: Number.isFinite(priorMax) ? priorMax : null,
    medianDepthKm: median(events.map((e) => e.depthKm).filter(Number.isFinite)),
    escalating,
    kind: isAftershocks ? 'aftershocks' : nPrior <= 2 ? 'new-swarm' : 'swarm',
    events,
  };
}

/**
 * The detector. quakes = parseQuakeFeed() output (any order). Returns flagged
 * clusters, most watch-worthy first: escalating swarms, then swarms by
 * Poisson surprise, then aftershock sequences (labeled expected), capped.
 */
export function detectAnomalies(quakes, nowMs = Date.now()) {
  const cells = new Map();
  for (const q of quakes) {
    const k = cellKey(q.lat, q.lon);
    let arr = cells.get(k);
    if (!arr) cells.set(k, arr = []);
    arr.push(q);
  }
  // flag cells on their own stats first…
  let flagged = [];
  for (const evs of cells.values()) {
    if (evs.length < MIN_RECENT) continue;
    const s = clusterStats(evs, nowMs);
    if (s.n7 >= MIN_RECENT && s.p < P_FLAG) flagged.push(s);
  }
  // …then fuse neighbors (a swarm straddling a cell border is one swarm)
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < flagged.length; i++) {
      for (let j = i + 1; j < flagged.length; j++) {
        if (haversineKm(flagged[i].lat, flagged[i].lon, flagged[j].lat, flagged[j].lon) <= MERGE_KM) {
          const union = clusterStats([...flagged[i].events, ...flagged[j].events], nowMs);
          flagged.splice(j, 1); flagged[i] = union;
          merged = true; break outer;
        }
      }
    }
  }
  const rank = (c) => (c.kind === 'aftershocks' ? 2 : c.escalating ? 0 : 1);
  flagged.sort((a, b) => (rank(a) - rank(b)) || (a.p - b.p));
  return flagged.slice(0, MAX_WATCHLIST);
}

/** Fetch + parse the M1+ 30-day feed (browser-side; CORS-friendly). */
export async function fetchAnomalyFeed() {
  const res = await fetch(ANOMALY_FEED_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`anomaly feed HTTP ${res.status}`);
  return parseQuakeFeed(await res.json());
}
