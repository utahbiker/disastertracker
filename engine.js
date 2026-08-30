// disaster-tracker/engine.js
//
// Statistical engine for earthquake occurrence probabilities.
// Pure ESM module — runs unchanged in the browser and under Node (tests).
//
// Methods implemented (full derivations + citations in METHODOLOGY.md):
//   - Gutenberg–Richter b-value: Aki (1965) / Utsu (1966) maximum-likelihood
//     with the Tinti & Mulargia (1987) binned-magnitude correction;
//     uncertainty per Shi & Bolt (1982).
//   - Completeness magnitude Mc: maximum-curvature (Wiemer & Wyss 2000)
//     with the conventional +0.2 correction.
//   - Occurrence rates: empirical counts inside per-threshold completeness
//     windows, with exact (Garwood 1936) Poisson confidence intervals.
//   - Extrapolation beyond the observed record: tapered Gutenberg–Richter
//     (Kagan 2002) — profile MLE of the corner moment with β = (2/3)·b.
//   - Window probability: homogeneous Poisson, P = 1 − exp(−λT)
//     (Kagan & Jackson 1991 support Poisson as the global null model).
//   - Time-dependent ("overdue") view: renewal process with Gamma
//     inter-event distribution (MLE via Newton on the digamma equation);
//     conditional probability given the elapsed quiet interval.
//
// The engine treats "rate" in events per Julian year (365.25 d).

export const MIN_PER_YEAR = 365.25 * 24 * 60;
export const EPOCH_2000_MS = Date.UTC(2000, 0, 1);
const LOG10E = Math.LOG10E;
// Magnitudes travel as Float32 and are quantized to 0.1 units; a half-least-
// unit epsilon keeps threshold comparisons exact at bin boundaries (float32
// cannot represent 5.7, so `mag >= 5.7 - 1e-9` would drop boundary events).
export const EPS_MAG = 5e-3;

// ─── catalog decode / merge ──────────────────────────────────────────────

/** Decode a columnar catalog file (delta-encoded minutes) into flat arrays. */
export function decodeCatalog(col) {
  const n = col.n;
  const t = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += col.t[i]; t[i] = acc; }
  const lat = new Float32Array(n), lon = new Float32Array(n);
  const mag = new Float32Array(n), dep = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = col.lat[i] / 100;
    lon[i] = col.lon[i] / 100;
    mag[i] = col.mag[i] < 0 ? NaN : col.mag[i] / 10;
    dep[i] = col.dep[i] < 0 ? NaN : col.dep[i];
  }
  return { n, t, lat, lon, mag, dep, meta: col.meta };
}

/** Merge decoded catalogs into one time-sorted catalog. */
export function mergeCatalogs(...cats) {
  const n = cats.reduce((s, c) => s + c.n, 0);
  const t = new Float64Array(n), lat = new Float32Array(n),
    lon = new Float32Array(n), mag = new Float32Array(n), dep = new Float32Array(n);
  let off = 0;
  for (const c of cats) {
    t.set(c.t, off); lat.set(c.lat, off); lon.set(c.lon, off);
    mag.set(c.mag, off); dep.set(c.dep, off);
    off += c.n;
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b]);
  const pick = (arr, Ctor) => { const o = new Ctor(n); for (let i = 0; i < n; i++) o[i] = arr[idx[i]]; return o; };
  return {
    n,
    t: pick(t, Float64Array), lat: pick(lat, Float32Array), lon: pick(lon, Float32Array),
    mag: pick(mag, Float32Array), dep: pick(dep, Float32Array),
  };
}

/** Splice: drop all events at/after spliceMin, append replacement events (for the live top-up). */
export function spliceCatalog(cat, spliceMin, events) {
  let cut = cat.n;
  while (cut > 0 && cat.t[cut - 1] >= spliceMin) cut--;
  const add = events.filter((e) => e.tMin >= spliceMin).sort((a, b) => a.tMin - b.tMin);
  const n = cut + add.length;
  const t = new Float64Array(n), lat = new Float32Array(n),
    lon = new Float32Array(n), mag = new Float32Array(n), dep = new Float32Array(n);
  t.set(cat.t.subarray(0, cut)); lat.set(cat.lat.subarray(0, cut));
  lon.set(cat.lon.subarray(0, cut)); mag.set(cat.mag.subarray(0, cut));
  dep.set(cat.dep.subarray(0, cut));
  for (let i = 0; i < add.length; i++) {
    t[cut + i] = add[i].tMin; lat[cut + i] = add[i].lat; lon[cut + i] = add[i].lon;
    mag[cut + i] = add[i].mag; dep[cut + i] = Number.isFinite(add[i].dep) ? add[i].dep : NaN;
  }
  return { n, t, lat, lon, mag, dep };
}

export const msToMin = (ms) => (ms - EPOCH_2000_MS) / 60000;
export const minToMs = (min) => min * 60000 + EPOCH_2000_MS;
export const yearToMin = (isoDate) => msToMin(Date.parse(isoDate + 'T00:00:00Z'));

// ─── geometry ────────────────────────────────────────────────────────────

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (lat2 - lat1) * d, dLon = (lon2 - lon1) * d;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Return index array of events within radiusKm of (lat0, lon0). */
export function regionIndices(cat, lat0, lon0, radiusKm) {
  const out = [];
  // cheap prefilter: 1° lat ≈ 111.2 km
  const dLat = radiusKm / 111.2;
  const cosLat = Math.max(0.01, Math.cos(lat0 * Math.PI / 180));
  const dLon = radiusKm / (111.2 * cosLat);
  for (let i = 0; i < cat.n; i++) {
    if (Math.abs(cat.lat[i] - lat0) > dLat) continue;
    let dl = Math.abs(cat.lon[i] - lon0);
    if (dl > 180) dl = 360 - dl;
    if (dl > dLon) continue;
    if (haversineKm(lat0, lon0, cat.lat[i], cat.lon[i]) <= radiusKm) out.push(i);
  }
  return out;
}

// ─── special functions ───────────────────────────────────────────────────

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(z) {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (a <= 0) return 1;
  if (x < a + 1) {
    // series
    let term = 1 / a, sum = term, k = a;
    for (let i = 0; i < 500; i++) {
      k += 1; term *= x / k; sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - logGamma(a)));
  }
  // continued fraction for Q(a,x)
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return Math.max(0, 1 - q);
}

export function digamma(x) {
  let r = 0;
  while (x < 6) { r -= 1 / x; x += 1; }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x -
    f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f * (1 / 240 - f / 132))));
}

/** Inverse of chi-square CDF (dof k) by bisection on gammaP(k/2, x/2). */
export function chi2inv(p, k) {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  let lo = 0, hi = Math.max(10, k + 10 * Math.sqrt(2 * k));
  while (gammaP(k / 2, hi / 2) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(k / 2, mid / 2) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-10 * (1 + hi)) break;
  }
  return (lo + hi) / 2;
}

// ─── rate estimation ─────────────────────────────────────────────────────

/**
 * Exact Poisson CI for a rate given n events in T years (Garwood 1936).
 * conf e.g. 0.95.
 */
export function poissonRateCI(n, Tyears, conf = 0.95) {
  const alpha = 1 - conf;
  const lo = n === 0 ? 0 : chi2inv(alpha / 2, 2 * n) / (2 * Tyears);
  const hi = chi2inv(1 - alpha / 2, 2 * n + 2) / (2 * Tyears);
  return { lo, hi };
}

/** P(at least one event in tYears) under homogeneous Poisson with rate lambda. */
export const poissonProb = (lambda, tYears) => 1 - Math.exp(-lambda * tYears);

/**
 * Completeness policy → for threshold m, the [startMin, endMin] window in
 * which the catalog is complete at m. `completeness` is the ETL-emitted
 * config; nowMin caps the window end.
 */
export function windowForThreshold(m, completeness, nowMin) {
  let start = null;
  // pick the earliest window whose minMag ≤ m
  for (const w of completeness.windows) {
    if (m >= w.minMag - 1e-9) {
      const s = yearToMin(w.start);
      if (start === null || s < start) start = s;
    }
  }
  if (start === null) return null; // below any completeness threshold
  let end = nowMin;
  for (const cap of completeness.bandCaps ?? []) {
    // a band cap shortens the window only if the *whole* threshold range
    // sits inside the capped band (i.e. thresholds < cap.maxMag rely on it)
    if (m >= cap.minMag - 1e-9 && m < cap.maxMag - 1e-9) {
      end = Math.min(end, yearToMin(cap.end));
    }
  }
  return { startMin: start, endMin: end };
}

/**
 * Empirical exceedance rate for magnitude ≥ m over the completeness window.
 * `indices` optionally restricts to a region (array of catalog indices).
 */
export function empiricalRate(cat, m, completeness, nowMin, indices = null) {
  const w = windowForThreshold(m, completeness, nowMin);
  if (!w) return null;
  const Tyears = (w.endMin - w.startMin) / MIN_PER_YEAR;
  if (Tyears <= 0) return null;
  let n = 0;
  let lastMin = null;
  const scan = (i) => {
    if (cat.mag[i] >= m - EPS_MAG && cat.t[i] >= w.startMin && cat.t[i] < w.endMin) {
      n++;
      if (lastMin === null || cat.t[i] > lastMin) lastMin = cat.t[i];
    }
  };
  if (indices) for (const i of indices) scan(i);
  else for (let i = 0; i < cat.n; i++) scan(i);
  const lambda = n / Tyears;
  const ci95 = poissonRateCI(n, Tyears, 0.95);
  const ci68 = poissonRateCI(n, Tyears, 0.68);
  return { m, n, Tyears, lambda, ci68, ci95, windowStartMin: w.startMin, windowEndMin: w.endMin, lastEventMin: lastMin };
}

// ─── Gutenberg–Richter ───────────────────────────────────────────────────

/**
 * Aki–Utsu maximum-likelihood b-value with the Tinti–Mulargia binned
 * correction (bin width dm), Shi & Bolt (1982) standard error, and the
 * annual a-value referenced at mc.
 * mags: array/typed array of magnitudes already filtered to ≥ mc.
 */
export function fitGutenbergRichter(mags, mc, Tyears, dm = 0.1) {
  const n = mags.length;
  if (n < 2) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += mags[i];
  const mean = sum / n;
  const denom = mean - (mc - dm / 2);
  if (denom <= 0) return null;
  const b = LOG10E / denom;
  // Shi & Bolt: sigma_b = 2.3026 * b^2 * sqrt( sum((Mi - mean)^2) / (n (n-1)) )
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = mags[i] - mean; ss += d * d; }
  const sigmaB = n > 1 ? Math.log(10) * b * b * Math.sqrt(ss / (n * (n - 1))) : NaN;
  const aAnnual = Math.log10(n / Tyears) + b * mc; // log10 N(M≥0) per year
  return { b, sigmaB, aAnnual, n, mc, mean, Tyears };
}

/** G-R annual exceedance rate at magnitude m from a fit. */
export const grRate = (fit, m) => Math.pow(10, fit.aAnnual - fit.b * m);

/**
 * Maximum-curvature Mc estimate (Wiemer & Wyss 2000): modal 0.1-magnitude
 * bin of the non-cumulative histogram, + 0.2 correction.
 */
export function estimateMcMaxCurvature(mags, floor = 4.5) {
  if (mags.length < 20) return null;
  const counts = new Map();
  for (const m of mags) {
    const bin = Math.round(m * 10);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  let best = null, bestC = -1;
  for (const [bin, c] of counts) {
    if (c > bestC || (c === bestC && bin < best)) { best = bin; bestC = c; }
  }
  return Math.max(floor, best / 10 + 0.2);
}

// ─── tapered Gutenberg–Richter (Kagan 2002) ──────────────────────────────

/** Seismic moment (N·m) from moment magnitude (Hanks & Kanamori 1979). */
export const momentOf = (mw) => Math.pow(10, 1.5 * mw + 9.05);
export const magOfMoment = (m0) => (Math.log10(m0) - 9.05) / 1.5;

/**
 * Profile MLE of the tapered-Pareto corner moment with fixed beta = (2/3) b.
 * moments: seismic moments of events with M ≥ mt (threshold magnitude).
 * Returns { beta, cornerMag, logL }.
 */
export function fitTaperedGR(moments, mt, beta) {
  const m0t = momentOf(mt);
  const x = moments.filter((v) => v >= m0t);
  if (x.length < 10) return null;
  const logL = (cornerMag) => {
    const mc = momentOf(cornerMag);
    let ll = 0;
    for (const xi of x) {
      ll += Math.log(beta / xi + 1 / mc) + beta * (Math.log(m0t) - Math.log(xi)) + (m0t - xi) / mc;
    }
    return ll;
  };
  // golden-section maximize over cornerMag ∈ [max observed − 0.3, 10.0]
  let maxObs = mt;
  for (const xi of x) maxObs = Math.max(maxObs, magOfMoment(xi));
  let a = Math.max(mt + 0.3, maxObs - 0.3), b2 = 10.0;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b2 - phi * (b2 - a), d = a + phi * (b2 - a);
  let fc = logL(c), fd = logL(d);
  for (let i = 0; i < 80; i++) {
    if (fc > fd) { b2 = d; d = c; fd = fc; c = b2 - phi * (b2 - a); fc = logL(c); }
    else { a = c; c = d; fc = fd; d = a + phi * (b2 - a); fd = logL(d); }
    if (b2 - a < 1e-4) break;
  }
  const cornerMag = (a + b2) / 2;
  return { beta, cornerMag, logL: logL(cornerMag), n: x.length, maxObserved: maxObs };
}

/** TGR survival fraction S(m | mt): fraction of M≥mt events that exceed m. */
export function tgrSurvival(m, mt, beta, cornerMag) {
  const m0 = momentOf(m), m0t = momentOf(mt), mc = momentOf(cornerMag);
  return Math.pow(m0t / m0, beta) * Math.exp((m0t - m0) / mc);
}

// ─── renewal (Gamma) model ───────────────────────────────────────────────

/**
 * Inter-event times (years) for events with mag ≥ m inside the completeness
 * window, plus the open interval from the last event to `nowMin`.
 */
export function interEventTimes(cat, m, completeness, nowMin, indices = null) {
  const w = windowForThreshold(m, completeness, nowMin);
  if (!w) return null;
  const times = [];
  const scan = (i) => {
    if (cat.mag[i] >= m - EPS_MAG && cat.t[i] >= w.startMin && cat.t[i] < w.endMin) times.push(cat.t[i]);
  };
  if (indices) for (const i of indices) scan(i);
  else for (let i = 0; i < cat.n; i++) scan(i);
  times.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / MIN_PER_YEAR);
  const openYears = times.length ? (nowMin - times[times.length - 1]) / MIN_PER_YEAR : null;
  return { gaps, openYears, count: times.length, lastMin: times.length ? times[times.length - 1] : null };
}

/**
 * Gamma MLE via Newton iteration on ln(k) − ψ(k) = ln(mean) − mean(ln x).
 * Returns { k, theta, cv, mean, n } (theta in the same units as data).
 */
export function fitGammaMLE(xs) {
  const n = xs.length;
  if (n < 5) return null;
  let sum = 0, sumLog = 0;
  for (const x of xs) {
    const v = Math.max(x, 1e-9);
    sum += v; sumLog += Math.log(v);
  }
  const mean = sum / n;
  const s = Math.log(mean) - sumLog / n;
  if (s <= 0) return null; // degenerate (all equal)
  // initial guess (Minka 2002)
  let k = (3 - s + Math.sqrt((s - 3) ** 2 + 24 * s)) / (12 * s);
  for (let i = 0; i < 60; i++) {
    const f = Math.log(k) - digamma(k) - s;
    // derivative: 1/k − ψ′(k); approximate ψ′ numerically
    const h = Math.max(1e-6, k * 1e-6);
    const fp = (digamma(k + h) - digamma(k - h)) / (2 * h);
    const deriv = 1 / k - fp;
    const step = f / deriv;
    const next = k - step;
    if (!Number.isFinite(next) || next <= 0) break;
    k = next;
    if (Math.abs(step) < 1e-10 * k) break;
  }
  return { k, theta: mean / k, cv: 1 / Math.sqrt(k), mean, n };
}

/** Gamma CDF with shape k, scale theta. */
export const gammaCDF = (x, k, theta) => (x <= 0 ? 0 : gammaP(k, x / theta));

/**
 * Renewal conditional probability: given `elapsed` years since the last
 * event, probability of at least one event within the next `windowYears`.
 * Guards the far tail (survival < 1e-9 → returns 1).
 */
export function renewalConditionalProb(fit, elapsed, windowYears) {
  const F1 = gammaCDF(elapsed, fit.k, fit.theta);
  const F2 = gammaCDF(elapsed + windowYears, fit.k, fit.theta);
  const surv = 1 - F1;
  if (surv < 1e-9) return 1;
  return Math.min(1, Math.max(0, (F2 - F1) / surv));
}

// ─── high-level model assembly ───────────────────────────────────────────

/**
 * Build the global (or regional) model summary the UI consumes.
 *
 * cat           merged decoded catalog
 * completeness  ETL completeness config
 * nowMin        current time in catalog minutes
 * region        null for global, else { lat, lon, radiusKm }
 */
export function buildModel(cat, completeness, nowMin, region = null) {
  const indices = region ? regionIndices(cat, region.lat, region.lon, region.radiusKm) : null;

  // G-R fit on the modern complete era (2000+ → now cap for [4.5,5.5) band
  // handled by only fitting on the modern window at mc)
  const fitStartMin = yearToMin('2000-01-01');
  const fitEndMin = Math.min(nowMin, yearToMin('2024-01-08')); // span where M4.5 band is complete
  const magsModern = [];
  const collect = (i) => {
    if (cat.t[i] >= fitStartMin && cat.t[i] < fitEndMin && Number.isFinite(cat.mag[i])) magsModern.push(cat.mag[i]);
  };
  if (indices) for (const i of indices) collect(i);
  else for (let i = 0; i < cat.n; i++) collect(i);

  const TyearsFit = (fitEndMin - fitStartMin) / MIN_PER_YEAR;
  let mc = 4.5, mcMethod = 'catalog floor';
  if (region) {
    const est = estimateMcMaxCurvature(magsModern, 4.5);
    if (est !== null) { mc = est; mcMethod = 'maximum curvature + 0.2'; }
  }
  const magsAboveMc = magsModern.filter((m) => m >= mc - EPS_MAG);
  let gr = fitGutenbergRichter(magsAboveMc, mc, TyearsFit);
  let grIsRegional = true;
  if (region && (!gr || magsAboveMc.length < 50)) {
    gr = null; grIsRegional = false; // caller supplies globalGR fallback
  }

  // Tapered G-R (global only; regional records are too short for a corner)
  let tgr = null;
  if (!region && gr) {
    // fit on M ≥ 5.5 within its completeness window for the longest record
    const w = windowForThreshold(5.5, completeness, nowMin);
    const moments = [];
    for (let i = 0; i < cat.n; i++) {
      if (cat.mag[i] >= 5.5 - EPS_MAG && cat.t[i] >= w.startMin && cat.t[i] < w.endMin) moments.push(momentOf(cat.mag[i]));
    }
    tgr = fitTaperedGR(moments, 5.5, (2 / 3) * gr.b);
    if (tgr) {
      const wT = (w.endMin - w.startMin) / MIN_PER_YEAR;
      tgr.lambdaAtThreshold = moments.length / wT; // annual rate of M≥5.5
      tgr.thresholdMag = 5.5;
    }
  }

  let maxObserved = -Infinity, maxObservedMin = null;
  const scanMax = (i) => {
    if (Number.isFinite(cat.mag[i]) && cat.mag[i] > maxObserved) { maxObserved = cat.mag[i]; maxObservedMin = cat.t[i]; }
  };
  if (indices) for (const i of indices) scanMax(i);
  else for (let i = 0; i < cat.n; i++) scanMax(i);

  return {
    region, indices, gr, grIsRegional, tgr, mc, mcMethod,
    nEvents: indices ? indices.length : cat.n,
    maxObserved: Number.isFinite(maxObserved) ? maxObserved : null,
    maxObservedMin,
  };
}

/**
 * The headline computation: probability of ≥1 event of magnitude ≥ m within
 * `windowYears` starting now, plus the pieces the UI displays.
 *
 * Rate selection policy (documented in METHODOLOGY.md § Rate selection):
 *   n ≥ 3 in the completeness window → empirical rate (exact Poisson CI).
 *   n < 3 and a G-R/TGR model is available → model extrapolation, flagged.
 */
export function assessThreshold(cat, completeness, nowMin, model, m, windowYears, globalGR = null) {
  const emp = empiricalRate(cat, m, completeness, nowMin, model.indices);
  if (!emp) return null;

  let lambda = emp.lambda, lambdaLo = emp.ci95.lo, lambdaHi = emp.ci95.hi;
  let method = 'empirical';
  const gr = model.gr ?? globalGR;

  if (emp.n < 3) {
    if (!model.region && model.tgr) {
      const t = model.tgr;
      lambda = t.lambdaAtThreshold * tgrSurvival(m, t.thresholdMag, t.beta, t.cornerMag);
      method = 'tapered-gr';
      // crude band: combine TGR point with the empirical exact CI, which for
      // small n is wide and honest; keep the wider of the two on each side
      lambdaLo = Math.min(lambdaLo, lambda / 3);
      lambdaHi = Math.max(lambdaHi, lambda * 3);
    } else if (gr) {
      lambda = grRate(gr, m);
      method = model.grIsRegional === false || model.region ? 'gr-regional-extrapolation' : 'gr';
      if (model.region && !model.grIsRegional && globalGR) {
        // fixed-b scaling: regional a from regional counts at a robust
        // reference threshold, global b for the slope
        const ref = referenceThreshold(cat, completeness, nowMin, model.indices);
        if (ref) {
          lambda = ref.lambda * Math.pow(10, -globalGR.b * (m - ref.m));
          method = 'fixed-b-scaling';
        }
      }
      lambdaLo = Math.min(emp.ci95.lo, lambda / 3);
      lambdaHi = Math.max(emp.ci95.hi, lambda * 3);
    }
  }

  const pPoisson = poissonProb(lambda, windowYears);
  const pLo = poissonProb(lambdaLo, windowYears);
  const pHi = poissonProb(lambdaHi, windowYears);

  // renewal view
  const iet = interEventTimes(cat, m, completeness, nowMin, model.indices);
  let renewal = null;
  if (iet && iet.gaps.length >= 8) {
    const gfit = fitGammaMLE(iet.gaps);
    if (gfit) {
      renewal = {
        fit: gfit,
        elapsedYears: iet.openYears,
        nIntervals: iet.gaps.length,
        prob: renewalConditionalProb(gfit, iet.openYears, windowYears),
        meanGapYears: gfit.mean,
      };
    }
  }

  return {
    m, windowYears, method,
    lambda, lambdaLo, lambdaHi,
    pPoisson, pLo, pHi,
    empirical: emp,
    renewal,
    lastEventMin: iet?.lastMin ?? emp.lastEventMin,
    extrapolated: model.maxObserved !== null && m > model.maxObserved + EPS_MAG,
  };
}

/** Largest threshold with ≥ 30 events regionally — anchor for fixed-b scaling. */
function referenceThreshold(cat, completeness, nowMin, indices) {
  for (const m of [6.0, 5.5, 5.0, 4.5]) {
    const r = empiricalRate(cat, m, completeness, nowMin, indices);
    if (r && r.n >= 30) return r;
  }
  // fall back to the most populated of the candidates
  let best = null;
  for (const m of [5.0, 4.5]) {
    const r = empiricalRate(cat, m, completeness, nowMin, indices);
    if (r && r.n > 0 && (!best || r.n > best.n)) best = r;
  }
  return best;
}
