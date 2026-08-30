// disaster-tracker/app.js — UI wiring + charts. All statistics live in engine.js.
import * as E from './engine.js';

const $ = (id) => document.getElementById(id);
const fmtPct = (p) => {
  if (p >= 0.9995) return '>99.9%';
  if (p >= 0.10) return (p * 100).toFixed(1) + '%';
  if (p >= 0.01) return (p * 100).toFixed(2) + '%';
  if (p >= 0.0001) return (p * 100).toFixed(3) + '%';
  return p > 0 ? '<0.01%' : '0%';
};
const fmtDate = (min) => new Date(E.minToMs(min)).toISOString().slice(0, 10);
const fmtEvery = (lambda) => {
  if (lambda <= 0) return '—';
  const yrs = 1 / lambda;
  if (yrs < 1 / 365) return `≈ ${Math.round(1 / (yrs * 365))} per day`;
  if (yrs < 1 / 12) return `≈ every ${Math.round(yrs * 365)} days`;
  if (yrs < 2) return `≈ every ${Math.round(yrs * 12)} months`;
  return `≈ every ${yrs < 20 ? yrs.toFixed(1) : Math.round(yrs)} years`;
};

const PRESETS = [
  ['Draper, Utah', 40.5247, -111.8638],
  ['Salt Lake City, Utah', 40.7608, -111.8910],
  ['San Francisco, CA', 37.7749, -122.4194],
  ['Los Angeles, CA', 34.0522, -118.2437],
  ['Seattle, WA', 47.6062, -122.3321],
  ['Anchorage, AK', 61.2181, -149.9003],
  ['Tokyo, Japan', 35.6762, 139.6503],
  ['Istanbul, Türkiye', 41.0082, 28.9784],
  ['Mexico City, Mexico', 19.4326, -99.1332],
  ['Santiago, Chile', -33.4489, -70.6693],
  ['Lisbon, Portugal', 38.7223, -9.1393],
  ['Kathmandu, Nepal', 27.7172, 85.3240],
  ['Jakarta, Indonesia', -6.2088, 106.8456],
  ['Wellington, New Zealand', -41.2866, 174.7756],
];

const STUBS = {
  hurricane: ['Hurricanes & tropical cyclones', 'Planned: NOAA HURDAT2 Atlantic + Pacific best-track archives (1851→present) and IBTrACS for global basins — landfall frequency and Saffir–Simpson exceedance probabilities by coastal segment, with the same completeness-window discipline used for earthquakes.'],
  tornado: ['Tornadoes', 'Planned: NOAA/SPC severe-weather database (1950→present) — EF-scale exceedance rates by county-scale region. Reporting completeness changed dramatically over the record (Doppler era), so the completeness modeling matters even more here.'],
  flood: ['Floods', 'Planned: NOAA Storm Events + USGS streamgauge peak-flow records — annual exceedance probabilities per gauge basin (the proper statistical object for floods; “100-year flood” = 1% AEP).'],
  volcano: ['Volcanic eruptions', 'Planned: Smithsonian Global Volcanism Program eruption database — per-volcano VEI exceedance from Holocene eruptive histories.'],
};

// scrub slider: index 0..1000 → log-spaced window from 1 day to 100 years
const SCRUB_MIN_Y = 1 / 365.25, SCRUB_MAX_Y = 100;
const scrubToYears = (i) => Math.pow(10, Math.log10(SCRUB_MIN_Y) + (i / 1000) * (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)));
const yearsToScrub = (y) => Math.round(1000 * (Math.log10(y) - Math.log10(SCRUB_MIN_Y)) / (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)));
const fmtWindow = (y) => {
  if (y < 1 / 12) return `+${Math.max(1, Math.round(y * 365.25))} days`;
  if (y < 1) return `+${Math.round(y * 12)} months`;
  if (y < 10) return `+${y.toFixed(1).replace(/\.0$/, '')} years`;
  return `+${Math.round(y)} years`;
};

const state = {
  scope: 'global',
  lat: 40.5247, lon: -111.8638, radiusKm: 200, placeName: null,
  mag: 6.0, windowYears: 1,
  cat: null, completeness: null, historical: null,
  nowMin: null, dataEdgeNote: null,
  globalModel: null, model: null,
  topupPlaces: new Map(), // tMin(rounded) -> place string
};

// ─── data loading ────────────────────────────────────────────────────────

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function usgsTopUp(modernMeta) {
  const spliceMin = modernMeta.coverage.bridgeStartMin;
  const startISO = new Date(E.minToMs(spliceMin) - 86400000).toISOString().slice(0, 10);
  const cacheKey = 'dt-usgs-topup-v1';
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { cached = null; }

  const fetchRange = async (start) => {
    const events = [];
    let offset = 1;
    for (let page = 0; page < 6; page++) {
      const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson' +
        `&starttime=${start}&minmagnitude=5&eventtype=earthquake&orderby=time-asc&limit=20000&offset=${offset}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`USGS ${r.status}`);
      const gj = await r.json();
      for (const f of gj.features) {
        const [lon, lat, dep] = f.geometry.coordinates;
        events.push({
          tMin: E.msToMin(f.properties.time), lat, lon,
          dep: Number.isFinite(dep) ? dep : NaN,
          mag: f.properties.mag, place: f.properties.place ?? '',
        });
      }
      if (gj.features.length < 20000) break;
      offset += 20000;
    }
    return events;
  };

  try {
    const events = await fetchRange(startISO);
    const payload = { fetchedAt: Date.now(), events: events.map((e) => [Math.round(e.tMin), Math.round(e.lat * 100) / 100, Math.round(e.lon * 100) / 100, Number.isFinite(e.dep) ? Math.round(e.dep) : -1, e.mag, e.place.slice(0, 60)]) };
    try { localStorage.setItem(cacheKey, JSON.stringify(payload)); } catch { /* storage full/blocked: live data still used this session */ }
    return { events, fetchedAt: Date.now(), live: true };
  } catch (err) {
    if (cached && Array.isArray(cached.events)) {
      const events = cached.events.map(([tMin, lat, lon, dep, mag, place]) => ({ tMin, lat, lon, dep: dep < 0 ? NaN : dep, mag, place }));
      return { events, fetchedAt: cached.fetchedAt, live: false };
    }
    return { events: null, error: String(err) };
  }
}

async function init() {
  const [modernRaw, instrRaw, histRaw, completeness] = await Promise.all([
    loadJSON('data/catalog-modern.json'),
    loadJSON('data/catalog-instrumental.json'),
    loadJSON('data/catalog-historical.json'),
    loadJSON('data/completeness.json'),
  ]);
  const modern = E.decodeCatalog(modernRaw);
  const instrumental = E.decodeCatalog(instrRaw);
  let cat = E.mergeCatalogs(instrumental, modern);
  state.historical = histRaw;

  const bridgeEndMin = E.yearToMin(modernRaw.meta.coverage.bridgeEnd);
  const spliceMin = modernRaw.meta.coverage.bridgeStartMin;
  const realNowMin = E.msToMin(Date.now());

  $('data-status').textContent = 'Catalogs loaded. Fetching latest events from USGS…';
  const topup = await usgsTopUp(modernRaw.meta);

  if (topup.events && topup.events.length) {
    cat = E.spliceCatalog(cat, spliceMin, topup.events);
    for (const e of topup.events) if (e.place) state.topupPlaces.set(Math.round(e.tMin), e.place);
    // with an M5+ top-up the [5.0, 5.5) band is now complete to the fetch time;
    // only [4.5, 5.0) stays capped at the bundled ComCat end.
    state.completeness = {
      ...completeness,
      bandCaps: [{ minMag: 4.5, maxMag: 5.0, end: completeness.bandCaps[0].end }],
    };
    state.nowMin = topup.live ? realNowMin : E.msToMin(topup.fetchedAt);
    const nEv = topup.events.length;
    $('data-status').textContent = topup.live
      ? `Live: catalog current through today (${nEv.toLocaleString()} recent events from USGS).`
      : `Offline — using USGS events cached ${fmtDate(state.nowMin)} (${nEv.toLocaleString()} events).`;
    if (!topup.live) state.dataEdgeNote = `USGS unreachable; statistics evaluated as of the last successful update (${fmtDate(state.nowMin)}).`;
  } else {
    state.completeness = completeness;
    state.nowMin = bridgeEndMin; // evaluate stats at the offline data edge — never dilute rates with empty catalog time
    state.dataEdgeNote = `USGS feed unreachable and no cache: statistics are evaluated as of ${modernRaw.meta.coverage.bridgeEnd} (bundled data edge), and events since then — including any recent large earthquakes — are missing.`;
    $('data-status').innerHTML = `<span class="warn">Offline — bundled data only (through ${modernRaw.meta.coverage.bridgeEnd}).</span>`;
  }

  state.cat = cat;
  state.globalModel = E.buildModel(cat, state.completeness, state.nowMin);
  buildMapBase();
  wireControls();
  readHash();
  recomputeModel();
  renderAll();
}

// ─── model + render ──────────────────────────────────────────────────────

function recomputeModel() {
  state.model = state.scope === 'global'
    ? state.globalModel
    : E.buildModel(state.cat, state.completeness, state.nowMin, { lat: state.lat, lon: state.lon, radiusKm: state.radiusKm });
}

function assessment() {
  return E.assessThreshold(state.cat, state.completeness, state.nowMin, state.model, state.mag, state.windowYears, state.globalModel.gr);
}

function renderAll() {
  const a = assessment();
  renderHeadline(a);
  renderModelCards(a);
  renderCaveats(a);
  drawCurve(a);
  drawGR();
  drawMap();
  renderTimeline();
  writeHash();
}

function scopeLabel() {
  if (state.scope === 'global') return 'anywhere on Earth';
  const name = state.placeName ?? `${state.lat.toFixed(2)}°, ${state.lon.toFixed(2)}°`;
  return `within ${state.radiusKm} km of ${name}`;
}

function renderHeadline(a) {
  if (!a) { $('prob-main').textContent = '—'; return; }
  const endDate = new Date(Date.now() + state.windowYears * 365.25 * 86400000).toISOString().slice(0, 10);
  $('prob-main').textContent = fmtPct(a.pPoisson);
  $('prob-sub').innerHTML = `chance of at least one <b>M ${state.mag.toFixed(1)}+</b> earthquake ${scopeLabel()}<br>between today and <b>${endDate}</b> (${fmtWindow(state.windowYears).slice(1)})`;
  $('prob-ci').textContent = `95% interval: ${fmtPct(a.pLo)} – ${fmtPct(a.pHi)}  ·  rate ${a.lambda >= 0.01 ? a.lambda.toFixed(2) : a.lambda.toExponential(1)}/yr (${fmtEvery(a.lambda)})`;

  const facts = [];
  const emp = a.empirical;
  facts.push(`<div class="fact"><b>${emp.n.toLocaleString()}</b> event${emp.n === 1 ? '' : 's'} M ${state.mag.toFixed(1)}+ in the ${emp.Tyears.toFixed(0)}-year complete record <span class="sm">(${fmtDate(emp.windowStartMin)} → ${fmtDate(emp.windowEndMin)})</span></div>`);
  if (a.lastEventMin != null) {
    const quietY = (state.nowMin - a.lastEventMin) / E.MIN_PER_YEAR;
    const place = state.topupPlaces.get(Math.round(a.lastEventMin));
    facts.push(`<div class="fact">last one: <b>${fmtDate(a.lastEventMin)}</b>${place ? ` <span class="sm">${place}</span>` : ''}<br><span class="sm">quiet for ${quietY < 1 ? Math.round(quietY * 365.25) + ' days' : quietY.toFixed(1) + ' years'}</span></div>`);
  } else {
    facts.push(`<div class="fact">no event this large in the complete record for this scope</div>`);
  }
  const methodText = {
    'empirical': 'empirical rate (counted events, exact Poisson CI)',
    'tapered-gr': 'tapered Gutenberg–Richter extrapolation (Kagan 2002) — few or no observed events this large',
    'gr': 'Gutenberg–Richter extrapolation',
    'gr-regional-extrapolation': 'regional Gutenberg–Richter extrapolation',
    'fixed-b-scaling': 'regional rate scaled with the global b-value (sparse local record)',
  }[a.method] ?? a.method;
  facts.push(`<div class="fact"><span class="sm">method: ${methodText}</span></div>`);
  if (state.model.gr && (state.scope === 'global' || state.model.grIsRegional)) {
    facts.push(`<div class="fact"><span class="sm">b-value ${state.model.gr.b.toFixed(2)} ± ${state.model.gr.sigmaB.toFixed(2)} (${state.scope === 'global' ? 'global' : 'regional'} fit, n=${state.model.gr.n.toLocaleString()})</span></div>`);
  }
  $('prob-facts').innerHTML = facts.join('');
}

function renderModelCards(a) {
  if (!a) return;
  $('poisson-value').textContent = fmtPct(a.pPoisson);
  if (a.renewal) {
    $('renewal-value').textContent = fmtPct(a.renewal.prob);
    const r = a.renewal;
    const cv = r.fit.cv;
    const character = cv > 1.15 ? `CV ${cv.toFixed(2)} → clustered: quiet spells slightly LOWER the near-term probability`
      : cv < 0.85 ? `CV ${cv.toFixed(2)} → quasi-periodic: probability genuinely rises with quiet time`
        : `CV ${cv.toFixed(2)} → close to Poisson (memoryless)`;
    $('renewal-note').innerHTML = `Gamma fit to ${r.nIntervals} inter-event gaps (mean ${r.meanGapYears < 1 ? (r.meanGapYears * 365.25).toFixed(0) + ' days' : r.meanGapYears.toFixed(1) + ' years'}), conditioned on ${r.elapsedYears < 1 ? (r.elapsedYears * 365.25).toFixed(0) + ' days' : r.elapsedYears.toFixed(1) + ' years'} elapsed since the last event. <b>${character}.</b> True “overdue” behavior belongs to individual faults with quasi-periodic recurrence, not whole regions.`;
  } else {
    $('renewal-value').textContent = 'n/a';
    $('renewal-note').textContent = 'Fewer than 8 inter-event gaps at this magnitude and scope — not enough to fit a renewal distribution honestly. The Poisson model is the defensible choice here.';
  }
}

function renderCaveats(a) {
  const items = [];
  items.push('<li><b>These are long-run statistical frequencies, not predictions.</b> No method — statistical or otherwise — can predict individual earthquakes (time, place, magnitude). Anyone claiming otherwise is selling something.</li>');
  if (state.dataEdgeNote) items.push(`<li><b>Data edge:</b> ${state.dataEdgeNote}</li>`);
  if (a?.method !== 'empirical') items.push('<li><b>Extrapolated value:</b> fewer than 3 events of this size exist in the applicable record, so the rate comes from a fitted magnitude–frequency model rather than direct counting. The uncertainty band is wide for a reason.</li>');
  if (a?.extrapolated) items.push(`<li><b>Beyond the observed record:</b> nothing this large appears in the catalog for this scope (max observed M ${state.model.maxObserved?.toFixed(1)}). Whether the local tectonics can physically produce M ${state.mag.toFixed(1)} is a geological question the catalog alone cannot answer.</li>`);
  if (state.scope === 'local') {
    items.push('<li><b>Short instrumental record vs. slow faults:</b> ~60–125 years of catalog cannot see faults whose big earthquakes recur every 300–2,000 years. Paleoseismic (trench) studies routinely imply higher large-magnitude hazard than instrumental rates suggest.</li>');
    if (E.haversineKm(state.lat, state.lon, 40.75, -111.9) < 300) {
      items.push('<li><b>Wasatch Front specifically:</b> the Working Group on Utah Earthquake Probabilities (2016) — which folds in trench-derived paleoseismic recurrence — puts the 50-year probability of an M6.75+ on the Wasatch Front at <b>43%</b>, far above what the instrumental catalog here implies. For Utah planning purposes, prefer their numbers for large magnitudes; this tool’s M5–6 rates are consistent with theirs.</li>');
    }
    items.push('<li><b>Radius matters:</b> probabilities scale with the area you draw. A 200 km circle answers “near me”; it does not answer “under my house.”</li>');
  }
  items.push('<li><b>Catalog seams:</b> magnitudes before 2000 are ISC-GEM Mw; after 2000 they are ComCat preferred magnitudes (mixed types). The b-value is fitted on the homogeneous modern era only. Aftershocks are included (rates are total-seismicity, not declustered — appropriate for “will one happen,” inflating short-window probabilities right after big events).</li>');
  $('caveat-list').innerHTML = items.join('');
}

// ─── charts ──────────────────────────────────────────────────────────────

// The design height must be cached on first read: assigning `canvas.height`
// below WRITES the same attribute, so re-reading it on every redraw would
// compound by devicePixelRatio each frame (charts grew exponentially on
// retina displays).
function designHeight(canvas) {
  if (!canvas.dataset.designH) canvas.dataset.designH = canvas.getAttribute('height');
  return parseInt(canvas.dataset.designH, 10);
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = designHeight(canvas);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const AX = '#2a3a5c', GRID = '#16203a', TXT = '#8a93a6', BRASS = '#d8c98a', BAND = 'rgba(184,169,106,0.16)';

function drawCurve(a) {
  const { ctx, w, h } = setupCanvas($('curve-chart'));
  ctx.clearRect(0, 0, w, h);
  if (!a) return;
  const L = 46, R = 12, T = 12, B = 30;
  const x = (yrs) => L + (Math.log10(Math.max(yrs, SCRUB_MIN_Y)) - Math.log10(SCRUB_MIN_Y)) / (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)) * (w - L - R);
  const y = (p) => T + (1 - p) * (h - T - B);

  ctx.strokeStyle = GRID; ctx.fillStyle = TXT; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath(); ctx.moveTo(L, y(p)); ctx.lineTo(w - R, y(p)); ctx.stroke();
    ctx.fillText((p * 100) + '%', 6, y(p) + 4);
  }
  const ticks = [[1 / 365.25, '1d'], [7 / 365.25, '1w'], [1 / 12, '1mo'], [0.5, '6mo'], [1, '1y'], [5, '5y'], [10, '10y'], [25, '25y'], [50, '50y'], [100, '100y']];
  ctx.textAlign = 'center';
  for (const [yrs, lab] of ticks) {
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x(yrs), T); ctx.lineTo(x(yrs), h - B); ctx.stroke();
    ctx.fillText(lab, x(yrs), h - B + 16);
  }
  ctx.textAlign = 'left';

  const N = 160;
  const samples = [];
  for (let i = 0; i <= N; i++) {
    const yrs = Math.pow(10, Math.log10(SCRUB_MIN_Y) + (i / N) * (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)));
    samples.push({ yrs, p: E.poissonProb(a.lambda, yrs), lo: E.poissonProb(a.lambdaLo, yrs), hi: E.poissonProb(a.lambdaHi, yrs) });
  }
  // CI band
  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.yrs), y(s.hi)) : ctx.moveTo(x(s.yrs), y(s.hi))));
  for (let i = samples.length - 1; i >= 0; i--) ctx.lineTo(x(samples[i].yrs), y(samples[i].lo));
  ctx.closePath(); ctx.fillStyle = BAND; ctx.fill();
  // Poisson line
  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.yrs), y(s.p)) : ctx.moveTo(x(s.yrs), y(s.p))));
  ctx.strokeStyle = BRASS; ctx.lineWidth = 2; ctx.stroke();
  // renewal line
  if (a.renewal) {
    ctx.beginPath();
    samples.forEach((s, i) => {
      const p = E.renewalConditionalProb(a.renewal.fit, a.renewal.elapsedYears, s.yrs);
      i ? ctx.lineTo(x(s.yrs), y(p)) : ctx.moveTo(x(s.yrs), y(p));
    });
    ctx.strokeStyle = '#7fa8d9'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  // marker at current window
  ctx.strokeStyle = '#d4756a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x(state.windowYears), T); ctx.lineTo(x(state.windowYears), h - B); ctx.stroke();
  ctx.fillStyle = '#d4756a';
  ctx.fillText(fmtPct(a.pPoisson), Math.min(x(state.windowYears) + 6, w - 60), Math.max(T + 12, y(a.pPoisson) - 8));

  $('curve-caption').textContent = a.renewal
    ? `solid: Poisson · dashed: renewal (Gamma) · band: 95% rate uncertainty · M ${state.mag.toFixed(1)}+, ${scopeLabel()}`
    : `Poisson · band: 95% rate uncertainty · M ${state.mag.toFixed(1)}+, ${scopeLabel()}`;
}

function drawGR() {
  const { ctx, w, h } = setupCanvas($('gr-chart'));
  ctx.clearRect(0, 0, w, h);
  const L = 56, R = 14, T = 12, B = 32;
  const M0 = 4.5, M1 = 9.6;
  const pts = [];
  for (let m = M0; m <= M1 + 1e-9; m += 0.25) {
    const r = E.empiricalRate(state.cat, m, state.completeness, state.nowMin, state.model.indices);
    if (r) pts.push(r);
  }
  const rates = pts.flatMap((p) => [p.lambda, p.ci95.hi, p.ci95.lo].filter((v) => v > 0));
  if (!rates.length) { $('gr-caption').textContent = 'no events in scope'; return; }
  let lgMin = Math.floor(Math.log10(Math.min(...rates))) - 1;
  const lgMax = Math.ceil(Math.log10(Math.max(...rates)));
  lgMin = Math.max(lgMin, lgMax - 8);
  const x = (m) => L + (m - M0) / (M1 - M0) * (w - L - R);
  const y = (rate) => {
    const lg = Math.max(lgMin, Math.min(lgMax, Math.log10(Math.max(rate, 1e-12))));
    return T + (lgMax - lg) / (lgMax - lgMin) * (h - T - B);
  };

  ctx.strokeStyle = GRID; ctx.fillStyle = TXT; ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let lg = lgMin; lg <= lgMax; lg++) {
    ctx.beginPath(); ctx.moveTo(L, y(10 ** lg)); ctx.lineTo(w - R, y(10 ** lg)); ctx.stroke();
    ctx.fillText(lg >= 0 ? String(10 ** lg) : `10⁻${'¹²³⁴⁵⁶⁷⁸'[-lg - 1] ?? -lg}`, L - 7, y(10 ** lg) + 4);
  }
  ctx.textAlign = 'left';
  ctx.textAlign = 'center';
  for (let m = 5; m <= 9.5; m += 0.5) {
    ctx.fillText(m.toFixed(1), x(m), h - B + 16);
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x(m), T); ctx.lineTo(x(m), h - B); ctx.stroke();
  }
  ctx.save(); ctx.translate(11, (h - B) / 2 + 55); ctx.rotate(-Math.PI / 2);
  ctx.fillText('events ≥ M per year', 0, 0); ctx.restore();
  ctx.textAlign = 'left';

  // G-R model line
  const gr = state.model.gr ?? state.globalModel.gr;
  if (gr && (state.scope === 'global' || state.model.grIsRegional)) {
    ctx.beginPath();
    for (let m = gr.mc; m <= M1; m += 0.05) {
      const r = E.grRate(gr, m);
      m === gr.mc ? ctx.moveTo(x(m), y(r)) : ctx.lineTo(x(m), y(r));
    }
    ctx.strokeStyle = 'rgba(216,201,138,0.55)'; ctx.lineWidth = 1.4; ctx.stroke();
  }
  // TGR curve (global scope)
  if (state.scope === 'global' && state.model.tgr) {
    const t = state.model.tgr;
    ctx.beginPath();
    for (let m = t.thresholdMag; m <= M1; m += 0.05) {
      const r = t.lambdaAtThreshold * E.tgrSurvival(m, t.thresholdMag, t.beta, t.cornerMag);
      m === t.thresholdMag ? ctx.moveTo(x(m), y(r)) : ctx.lineTo(x(m), y(r));
    }
    ctx.strokeStyle = '#7fa8d9'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
  }
  // empirical points + CI whiskers
  for (const p of pts) {
    if (p.n === 0) continue;
    ctx.strokeStyle = 'rgba(216,201,138,0.7)';
    ctx.beginPath(); ctx.moveTo(x(p.m), y(p.ci95.lo || 1e-12)); ctx.lineTo(x(p.m), y(p.ci95.hi)); ctx.stroke();
    ctx.fillStyle = BRASS;
    ctx.beginPath(); ctx.arc(x(p.m), y(p.lambda), 3, 0, 7); ctx.fill();
  }
  // selected magnitude marker
  ctx.strokeStyle = '#d4756a'; ctx.beginPath(); ctx.moveTo(x(state.mag), T); ctx.lineTo(x(state.mag), h - B); ctx.stroke();

  $('gr-caption').textContent = (state.scope === 'global'
    ? `dots: counted rates (95% CI) · line: G-R fit b=${state.globalModel.gr.b.toFixed(2)} · dashed: tapered G-R, corner M ${state.globalModel.tgr?.cornerMag.toFixed(1)}`
    : state.model.grIsRegional
      ? `dots: counted regional rates (95% CI) · line: regional G-R fit b=${state.model.gr.b.toFixed(2)}`
      : 'dots: counted regional rates (95% CI) · too few events for a regional G-R fit');
}

// map: static base rendered once, overlays per frame
let mapBase = null, mapDims = null;
function buildMapBase() {
  const canvas = $('map-chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = designHeight(canvas);
  mapDims = { w, h };
  mapBase = document.createElement('canvas');
  mapBase.width = w * dpr; mapBase.height = h * dpr;
  const ctx = mapBase.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0f1c'; ctx.fillRect(0, 0, w, h);
  const cat = state.cat;
  for (let i = 0; i < cat.n; i++) {
    const m = cat.mag[i];
    if (!Number.isFinite(m)) continue;
    const px = (cat.lon[i] + 180) / 360 * w;
    const py = (90 - cat.lat[i]) / 180 * h;
    if (m >= 8) { ctx.fillStyle = 'rgba(216,169,106,0.95)'; ctx.beginPath(); ctx.arc(px, py, 3, 0, 7); ctx.fill(); }
    else if (m >= 7) { ctx.fillStyle = 'rgba(216,169,106,0.55)'; ctx.fillRect(px - 1, py - 1, 2, 2); }
    else if (m >= 6) { ctx.fillStyle = 'rgba(184,169,106,0.30)'; ctx.fillRect(px, py, 1.4, 1.4); }
    else { ctx.fillStyle = 'rgba(150,160,190,0.14)'; ctx.fillRect(px, py, 1, 1); }
  }
}

function drawMap() {
  const canvas = $('map-chart');
  const { ctx, w, h } = setupCanvas(canvas);
  if (!mapBase || mapDims.w !== w) buildMapBase();
  ctx.drawImage(mapBase, 0, 0, w, h);
  if (state.scope === 'local') {
    // geodesic circle
    ctx.beginPath();
    for (let a = 0; a <= 360; a += 3) {
      const rad = a * Math.PI / 180;
      const dLat = (state.radiusKm / 111.2) * Math.cos(rad);
      const dLon = (state.radiusKm / (111.2 * Math.max(0.05, Math.cos(state.lat * Math.PI / 180)))) * Math.sin(rad);
      const px = (state.lon + dLon + 180) / 360 * w;
      const py = (90 - (state.lat + dLat)) / 180 * h;
      a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#d4756a'; ctx.lineWidth = 1.5; ctx.stroke();
    const cx = (state.lon + 180) / 360 * w, cy = (90 - state.lat) / 180 * h;
    ctx.strokeStyle = '#d4756a';
    ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();
  }
}

function renderTimeline() {
  const section = $('timeline-section');
  if (state.scope !== 'local') { section.hidden = true; return; }
  section.hidden = false;
  const { ctx, w, h } = setupCanvas($('timeline-chart'));
  ctx.clearRect(0, 0, w, h);
  const idx = state.model.indices;
  const cat = state.cat;

  // regional historical (pre-1900) context events
  const hist = state.historical.events.filter((e) =>
    E.haversineKm(state.lat, state.lon, e.lat / 100, e.lon / 100) <= state.radiusKm);

  const y0 = 1900;
  let yMinYear = y0;
  if (hist.length) yMinYear = Math.min(...hist.map((e) => e.y));
  const yNow = new Date(E.minToMs(state.nowMin)).getUTCFullYear() + 1;
  const L = 40, R = 10, T = 10, B = 26;
  // piecewise x-scale: pre-1900 compressed into the left 18% when present
  const split = hist.length ? 0.18 : 0;
  const x = (yr) => {
    if (yr < y0) return L + (yr - yMinYear) / Math.max(1, y0 - yMinYear) * (w - L - R) * split;
    return L + (w - L - R) * (split + (yr - y0) / (yNow - y0) * (1 - split));
  };
  const magMax = 9.6, magMin = 4.4;
  const y = (m) => T + (magMax - m) / (magMax - magMin) * (h - T - B);

  ctx.strokeStyle = GRID; ctx.fillStyle = TXT; ctx.font = '11px sans-serif';
  for (const m of [5, 6, 7, 8, 9]) {
    ctx.beginPath(); ctx.moveTo(L, y(m)); ctx.lineTo(w - R, y(m)); ctx.stroke();
    ctx.fillText('M' + m, 8, y(m) + 4);
  }
  ctx.textAlign = 'center';
  const yearTicks = hist.length ? [yMinYear, 1900, 1950, 2000, yNow] : [1900, 1925, 1950, 1975, 2000, yNow];
  for (const yr of yearTicks) ctx.fillText(String(yr), Math.min(x(yr), w - 18), h - B + 16);
  if (hist.length) { ctx.strokeStyle = AX; ctx.beginPath(); ctx.moveTo(x(y0), T); ctx.lineTo(x(y0), h - B); ctx.stroke(); }
  ctx.textAlign = 'left';

  for (const e of hist) {
    const m = e.mag > 0 ? e.mag / 10 : 4.6;
    ctx.strokeStyle = 'rgba(127,168,217,0.5)';
    ctx.beginPath(); ctx.moveTo(x(e.y), h - B); ctx.lineTo(x(e.y), y(m)); ctx.stroke();
    ctx.fillStyle = 'rgba(127,168,217,0.8)';
    ctx.beginPath(); ctx.arc(x(e.y), y(m), 2.5, 0, 7); ctx.fill();
  }
  const rows = [];
  for (const i of idx) {
    if (!Number.isFinite(cat.mag[i])) continue;
    const yr = 2000 + cat.t[i] / (E.MIN_PER_YEAR);
    const sel = cat.mag[i] >= state.mag - E.EPS_MAG;
    ctx.strokeStyle = sel ? 'rgba(212,117,106,0.85)' : 'rgba(216,201,138,0.45)';
    ctx.beginPath(); ctx.moveTo(x(yr), h - B); ctx.lineTo(x(yr), y(cat.mag[i])); ctx.stroke();
    ctx.fillStyle = sel ? '#d4756a' : BRASS;
    ctx.beginPath(); ctx.arc(x(yr), y(cat.mag[i]), sel ? 3 : 2, 0, 7); ctx.fill();
    rows.push({ tMin: cat.t[i], mag: cat.mag[i], dist: E.haversineKm(state.lat, state.lon, cat.lat[i], cat.lon[i]) });
  }
  $('timeline-caption').textContent = `${idx.length} instrumental events · ${hist.length} pre-1900 significant events (blue, context only)`;

  rows.sort((a, b) => b.tMin - a.tMin);
  const listed = rows.filter((r) => r.mag >= Math.min(state.mag, 5.5) - E.EPS_MAG).slice(0, 40);
  $('timeline-list').innerHTML = listed.map((r) => {
    const place = state.topupPlaces.get(Math.round(r.tMin));
    return `<div class="ev"><span class="d">${fmtDate(r.tMin)}</span><span class="m">M ${r.mag.toFixed(1)}</span><span>${place ?? Math.round(r.dist) + ' km away'}</span></div>`;
  }).join('') + hist.slice().reverse().slice(0, 10).map((e) =>
    `<div class="ev"><span class="d">${e.y}</span><span class="m">${e.mag > 0 ? 'M ' + (e.mag / 10).toFixed(1) : 'M ?'}</span><span class="ctx">${e.name || 'significant event (pre-instrumental)'}</span></div>`,
  ).join('');
}

// ─── controls ────────────────────────────────────────────────────────────

function setScope(scope) {
  state.scope = scope;
  $('scope-global').classList.toggle('active', scope === 'global');
  $('scope-local').classList.toggle('active', scope === 'local');
  $('local-controls').hidden = scope !== 'local';
  if (scope === 'local') $('coords-readout').textContent = `${state.lat.toFixed(3)}°, ${state.lon.toFixed(3)}°`;
  recomputeModel();
  renderAll();
}

let raf = null;
function scheduleRender(recompute = false) {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    if (recompute) recomputeModel();
    renderAll();
  });
}

function wireControls() {
  $('scope-global').onclick = () => setScope('global');
  $('scope-local').onclick = () => setScope('local');

  const preset = $('preset-select');
  for (const [name, lat, lon] of PRESETS) {
    const o = document.createElement('option');
    o.value = `${lat},${lon}`; o.textContent = name;
    preset.appendChild(o);
  }
  preset.onchange = () => {
    if (!preset.value) return;
    const [lat, lon] = preset.value.split(',').map(Number);
    state.lat = lat; state.lon = lon;
    state.placeName = preset.options[preset.selectedIndex].textContent;
    setScope('local');
  };

  $('geolocate').onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      state.lat = pos.coords.latitude; state.lon = pos.coords.longitude;
      state.placeName = 'your location';
      preset.value = '';
      setScope('local');
    }, () => { $('coords-readout').textContent = 'location permission denied — pick a preset or click the map'; });
  };

  $('radius').oninput = () => {
    state.radiusKm = Number($('radius').value);
    $('radius-label').textContent = state.radiusKm;
    scheduleRender(true);
  };

  $('mag').oninput = () => {
    state.mag = Number($('mag').value);
    $('mag-label').textContent = state.mag.toFixed(1);
    scheduleRender(false);
  };

  const scrub = $('scrub');
  scrub.value = yearsToScrub(1);
  scrub.oninput = () => {
    state.windowYears = scrubToYears(Number(scrub.value));
    $('scrub-label').textContent = fmtWindow(state.windowYears);
    scheduleRender(false);
  };

  $('map-chart').onclick = (ev) => {
    const rect = ev.target.getBoundingClientRect();
    state.lon = (ev.clientX - rect.left) / rect.width * 360 - 180;
    state.lat = 90 - (ev.clientY - rect.top) / rect.height * 180;
    state.placeName = null;
    $('preset-select').value = '';
    setScope('local');
  };

  // hazard tabs
  for (const btn of document.querySelectorAll('#hazard-tabs .tab')) {
    btn.onclick = () => {
      document.querySelectorAll('#hazard-tabs .tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const hz = btn.dataset.hazard;
      $('earthquake-panel').hidden = hz !== 'earthquake';
      $('stub-panel').hidden = hz === 'earthquake';
      if (hz !== 'earthquake') {
        $('stub-title').textContent = STUBS[hz][0];
        $('stub-body').textContent = STUBS[hz][1];
      } else {
        scheduleRender(false);
      }
    };
  }

  window.addEventListener('resize', () => { mapBase = null; scheduleRender(false); });
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('m', state.mag.toFixed(1));
  p.set('w', state.windowYears.toPrecision(3));
  if (state.scope === 'local') {
    p.set('lat', state.lat.toFixed(3)); p.set('lon', state.lon.toFixed(3)); p.set('r', state.radiusKm);
  }
  history.replaceState(null, '', '#' + p.toString());
}

function readHash() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('m')) { state.mag = Math.min(9.5, Math.max(5, Number(p.get('m')))); $('mag').value = state.mag; $('mag-label').textContent = state.mag.toFixed(1); }
  if (p.get('w')) {
    const wY = Math.min(SCRUB_MAX_Y, Math.max(SCRUB_MIN_Y, Number(p.get('w'))));
    if (Number.isFinite(wY)) { state.windowYears = wY; $('scrub').value = yearsToScrub(wY); $('scrub-label').textContent = fmtWindow(wY); }
  }
  if (p.get('lat') && p.get('lon')) {
    state.lat = Number(p.get('lat')); state.lon = Number(p.get('lon'));
    state.radiusKm = Number(p.get('r')) || 200;
    $('radius').value = state.radiusKm; $('radius-label').textContent = state.radiusKm;
    state.scope = 'local';
    $('scope-global').classList.remove('active'); $('scope-local').classList.add('active');
    $('local-controls').hidden = false;
  }
}

init().catch((err) => {
  $('data-status').innerHTML = `<span class="warn">Failed to load data: ${err.message}. If you opened index.html directly from disk, serve the folder instead (e.g. \`python3 -m http.server\`).</span>`;
});
