// dashboard.js — master multi-hazard dashboard. Statistics live in impact.js.
import * as I from './impact.js';

const $ = (id) => document.getElementById(id);
const fmtPct = (p) => {
  if (p >= 0.9995) return '>99.9%';
  if (p >= 0.10) return (p * 100).toFixed(1) + '%';
  if (p >= 0.01) return (p * 100).toFixed(2) + '%';
  if (p >= 0.0001) return (p * 100).toFixed(3) + '%';
  return p > 0 ? '<0.01%' : '0%';
};
const fmtInt = (n) => n.toLocaleString('en-US');
const fmtEvery = (lambda) => {
  if (lambda <= 0) return 'never observed';
  const yrs = 1 / lambda;
  if (yrs < 1 / 52) return `≈ ${Math.round(lambda / 52)} per week`;
  if (yrs < 1 / 12) return `≈ every ${Math.round(yrs * 365.25)} days`;
  if (yrs < 2) return `≈ every ${Math.round(yrs * 12)} months`;
  return `≈ every ${yrs < 20 ? yrs.toFixed(1) : Math.round(yrs)} years`;
};
const fmtDamage = (k) => { // CPI-adjusted '000 US$
  const usd = k * 1000;
  if (usd >= 1e12) return '$' + (usd / 1e12).toFixed(usd >= 3e12 ? 0 : 1) + 'T';
  if (usd >= 1e9) return '$' + (usd / 1e9).toFixed(usd >= 2e10 ? 0 : 1) + 'B';
  return '$' + Math.round(usd / 1e6) + 'M';
};
const fmtDate = (day) => new Date(I.msOfDay(day)).toISOString().slice(0, 10);

const HAZ_COLORS = ['#d8c98a', '#7fa8d9', '#6ab9b0', '#c9a15b', '#d4756a', '#a58b6f', '#e0834f', '#b07fd9', '#8a93a6'];

// sliders: log scales
const SCRUB_MIN_Y = 1 / 365.25, SCRUB_MAX_Y = 50;
const scrubToYears = (i) => Math.pow(10, Math.log10(SCRUB_MIN_Y) + (i / 1000) * (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)));
const yearsToScrub = (y) => Math.round(1000 * (Math.log10(y) - Math.log10(SCRUB_MIN_Y)) / (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)));
const fmtWindow = (y) => {
  const unit = (n, w) => `+${n} ${w}${n === 1 || n === '1' ? '' : 's'}`;
  if (y < 1 / 12) return unit(Math.max(1, Math.round(y * 365.25)), 'day');
  if (y < 1) return unit(Math.round(y * 12), 'month');
  if (y < 10) return unit(y.toFixed(1).replace(/\.0$/, ''), 'year');
  return unit(Math.round(y), 'year');
};
const TH = {
  deaths: { lo: 10, hi: 1e6 },
  damage: { lo: 1e5, hi: 5e8 }, // '000 US$: $100M → $500B
};
const thToValue = (metric, i) => {
  const { lo, hi } = TH[metric];
  const raw = lo * Math.pow(hi / lo, i / 1000);
  // snap to 1/2/5 ladder for readable labels
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / mag;
  const snap = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return Math.min(hi, Math.max(lo, snap * mag));
};
const valueToTh = (metric, v) => {
  const { lo, hi } = TH[metric];
  return Math.round(1000 * Math.log(v / lo) / Math.log(hi / lo));
};
const fmtThreshold = (metric, v) => (metric === 'deaths' ? `${fmtInt(v)} deaths` : `${fmtDamage(v)} damage`);

const state = {
  metric: 'deaths', us: false,
  threshold: 1000, windowYears: 1,
  imp: null,
};

async function init() {
  const raw = await (await fetch('data/impacts.json')).json();
  state.imp = I.decodeImpacts(raw);
  $('data-status').innerHTML = `${fmtInt(raw.n)} recorded disaster events, 1900 → ${raw.meta.dataEnd} · impact catalog is a fixed EM-DAT snapshot (see caveats) · <a href="earthquake.html" style="color:var(--accent-2)">earthquake deep-dive is live-updating →</a>`;
  wireControls();
  readHash();
  renderAll();
}

function assessment() {
  return I.assessImpact(state.imp, {
    metric: state.metric, threshold: state.threshold,
    windowYears: state.windowYears, us: state.us,
  });
}

function scopeText() { return state.us ? 'in the United States (incl. territories)' : 'anywhere on Earth'; }
function severityText() {
  return state.metric === 'deaths'
    ? `killing <b>${fmtInt(state.threshold)}+ people</b>`
    : `causing <b>${fmtDamage(state.threshold)}+</b> in damage (2024 dollars)`;
}

function renderAll() {
  const a = assessment();
  renderHeadline(a);
  renderHazards(a);
  renderCaveats(a);
  drawCurve(a);
  drawFS();
  drawSeason(a);
  renderEvents(a);
  writeHash();
}

function renderHeadline(a) {
  if (!a || a.n === 0) {
    $('prob-main').textContent = '—';
    $('prob-sub').innerHTML = `No event ${severityText()} ${scopeText()} appears in the applicable record — too rare to rate empirically. Lower the severity or widen the scope.`;
    $('prob-ci').textContent = ''; $('prob-facts').innerHTML = '';
    return;
  }
  const endDate = new Date(Date.now() + a.windowYears * 365.25 * 86400000).toISOString().slice(0, 10);
  $('prob-main').textContent = fmtPct(a.prob);
  $('prob-sub').innerHTML = `chance of at least one natural disaster ${severityText()}<br>${scopeText()}, between today and <b>${endDate}</b> (${fmtWindow(a.windowYears).slice(1)})`;
  $('prob-ci').textContent = `95% interval ${fmtPct(a.probLo)} – ${fmtPct(a.probHi)} · rate ${a.lambda >= 0.1 ? a.lambda.toFixed(1) : a.lambda.toFixed(3)}/yr (${fmtEvery(a.lambda)})` +
    (Math.abs(a.seasonalNet - 1) > 0.05 && a.windowYears < 2 ? ` · seasonal ×${a.seasonalNet.toFixed(2)}` : '');

  const facts = [];
  facts.push(`<div class="fact"><b>${fmtInt(a.n)}</b> such events in the ${a.Tyears.toFixed(0)}-year complete record <span class="sm">(${a.windowStartYear} → ${state.imp.meta.dataEnd.slice(0, 4)})</span></div>`);
  if (a.lastIdx != null) {
    const i = a.lastIdx;
    const imp = state.imp;
    const val = imp.value(i, state.metric, state.us);
    facts.push(`<div class="fact">most recent: <b>${fmtDate(imp.day[i])}</b> — ${imp.label[i] || imp.meta.hazards[imp.type[i]]}<br><span class="sm">${state.metric === 'deaths' ? fmtInt(val) + ' deaths' : fmtDamage(val)}</span></div>`);
  }
  if (a.maxIdx != null) {
    const i = a.maxIdx;
    facts.push(`<div class="fact"><span class="sm">largest on record in scope: ${state.imp.label[i] || state.imp.meta.hazards[state.imp.type[i]]} (${fmtDate(state.imp.day[i]).slice(0, 4)}) — ${state.metric === 'deaths' ? fmtInt(a.maxObserved) + ' deaths' : fmtDamage(a.maxObserved)}</span></div>`);
  }
  $('prob-facts').innerHTML = facts.join('');
}

function renderHazards(a) {
  const box = $('hazard-breakdown');
  if (!a || a.n === 0) { box.innerHTML = ''; $('hazard-caption').textContent = ''; return; }
  $('hazard-caption').textContent = `bar: share of combined risk · number: probability within the window · ${scopeText()}`;
  const rows = a.perHazard.filter((p) => p.n > 0);
  box.innerHTML = rows.map((p) => {
    const seasonBadge = Math.abs(p.seasonal - 1) > 0.15 && a.windowYears < 1
      ? `<span class="season-badge ${p.seasonal > 1 ? 'up' : 'down'}">${p.seasonal > 1 ? 'in season' : 'off season'}</span>` : '';
    const last = p.lastIdx != null ? `last: ${fmtDate(state.imp.day[p.lastIdx])}` : '';
    return `<div class="haz-row">
      <div class="haz-name" style="color:${HAZ_COLORS[p.type]}">${p.hazard}${seasonBadge}</div>
      <div class="haz-bar"><div class="haz-fill" style="width:${Math.max(1, p.share * 100)}%;background:${HAZ_COLORS[p.type]}"></div></div>
      <div class="haz-stats"><b>${fmtPct(p.prob)}</b> <span class="sm">${fmtEvery(p.lambda)} · n=${p.n} · ${last}</span></div>
    </div>`;
  }).join('');
}

function renderCaveats(a) {
  const items = [];
  items.push('<li><b>These are long-run statistical frequencies, not predictions.</b> No method can predict individual disasters. This page answers "how often has nature done this," not "what will happen."</li>');
  items.push(`<li><b>Fixed data snapshot:</b> the impact catalog ends <b>${state.imp.meta.dataEnd}</b> (EM-DAT public-table snapshot). Rates are long-run and remain valid, but the "most recent event" entries stop there. To refresh: download the current public table from emdat.be (free registration, non-commercial) and re-run <code>etl/build-impacts.mjs</code>.</li>`);
  items.push('<li><b>Non-stationarity, both directions:</b> disaster <i>mortality</i> has fallen for decades (warning systems, preparedness) while <i>damages</i> rise (exposure growth) — so death-based rates lean conservative-high at extreme thresholds dominated by early-century famines and floods, and damage-based rates lean low. The completeness windows limit but do not remove this.</li>');
  if (state.metric === 'deaths' && a && a.threshold >= 100000) {
    items.push('<li><b>At this severity the record is thin</b> and dominated by pre-1970 droughts and floods whose death tolls reflect a world without modern response capacity. Treat the number as an upper-leaning bound.</li>');
  }
  if (state.metric === 'damage') {
    items.push('<li><b>Damage reporting is sparse and biased:</b> only ~40% of events carry damage estimates, skewed toward insured, wealthy regions. Damage rates are lower bounds; the CPI adjustment corrects prices but not exposure growth.</li>');
  }
  items.push('<li><b>Epidemics are excluded</b> (this dashboard models physical hazards). EM-DAT entry requires ≥10 deaths, ≥100 affected, or a declaration/appeal — small events are undercounted, which is why low thresholds use only the modern record.</li>');
  if (state.us) items.push('<li><b>US scope</b> counts each event\'s US-portion impact (incl. Puerto Rico and territories). Sub-national US enrichment (NOAA Storm Events) is on the roadmap.</li>');
  items.push('<li><b>Attribution:</b> impact data from EM-DAT, CRED / UCLouvain, Brussels, Belgium — www.emdat.be (non-commercial use).</li>');
  $('caveat-list').innerHTML = items.join('');
}

// ─── charts (design heights cached — see designHeight in the earthquake app) ──
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
const GRID = '#16203a', TXT = '#8a93a6', BRASS = '#d8c98a', BAND = 'rgba(184,169,106,0.16)';

function drawCurve(a) {
  const { ctx, w, h } = setupCanvas($('curve-chart'));
  ctx.clearRect(0, 0, w, h);
  if (!a || a.n === 0) { $('curve-caption').textContent = ''; return; }
  const L = 46, R = 12, T = 12, B = 30;
  const x = (yrs) => L + (Math.log10(Math.max(yrs, SCRUB_MIN_Y)) - Math.log10(SCRUB_MIN_Y)) / (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)) * (w - L - R);
  const y = (p) => T + (1 - p) * (h - T - B);
  ctx.strokeStyle = GRID; ctx.fillStyle = TXT; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath(); ctx.moveTo(L, y(p)); ctx.lineTo(w - R, y(p)); ctx.stroke();
    ctx.fillText((p * 100) + '%', 6, y(p) + 4);
  }
  ctx.textAlign = 'center';
  for (const [yrs, lab] of [[1 / 365.25, '1d'], [7 / 365.25, '1w'], [1 / 12, '1mo'], [0.5, '6mo'], [1, '1y'], [5, '5y'], [10, '10y'], [25, '25y'], [50, '50y']]) {
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x(yrs), T); ctx.lineTo(x(yrs), h - B); ctx.stroke();
    ctx.fillText(lab, x(yrs), h - B + 16);
  }
  ctx.textAlign = 'left';
  const N = 140, pts = [];
  for (let i = 0; i <= N; i++) {
    const yrs = Math.pow(10, Math.log10(SCRUB_MIN_Y) + (i / N) * (Math.log10(SCRUB_MAX_Y) - Math.log10(SCRUB_MIN_Y)));
    const s = yrs >= 2 ? 1 : a.seasonalNet; // window-start seasonal approximation for the sweep
    pts.push({ yrs, p: 1 - Math.exp(-a.lambda * s * yrs), lo: 1 - Math.exp(-a.ci95.lo * s * yrs), hi: 1 - Math.exp(-a.ci95.hi * s * yrs) });
  }
  ctx.beginPath();
  pts.forEach((s, i) => (i ? ctx.lineTo(x(s.yrs), y(s.hi)) : ctx.moveTo(x(s.yrs), y(s.hi))));
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(x(pts[i].yrs), y(pts[i].lo));
  ctx.closePath(); ctx.fillStyle = BAND; ctx.fill();
  ctx.beginPath();
  pts.forEach((s, i) => (i ? ctx.lineTo(x(s.yrs), y(s.p)) : ctx.moveTo(x(s.yrs), y(s.p))));
  ctx.strokeStyle = BRASS; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = '#d4756a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x(state.windowYears), T); ctx.lineTo(x(state.windowYears), h - B); ctx.stroke();
  ctx.fillStyle = '#d4756a';
  ctx.fillText(fmtPct(a.prob), Math.min(x(state.windowYears) + 6, w - 60), Math.max(T + 12, y(a.prob) - 8));
  $('curve-caption').textContent = `band: 95% rate uncertainty · ${fmtThreshold(state.metric, state.threshold)}, ${scopeText()}`;
}

function drawFS() {
  const { ctx, w, h } = setupCanvas($('fs-chart'));
  ctx.clearRect(0, 0, w, h);
  const curve = I.exceedanceCurve(state.imp, { metric: state.metric, us: state.us });
  if (!curve.length) { $('fs-caption').textContent = 'no data in scope'; return; }
  const L = 56, R = 14, T = 12, B = 34;
  const xs = curve.map((c) => c.x);
  const xMin = Math.log10(xs[0]), xMax = Math.log10(xs[xs.length - 1]);
  const rates = curve.flatMap((c) => [c.lambda, c.ci95.hi, c.ci95.lo].filter((v) => v > 0));
  let lgMin = Math.floor(Math.log10(Math.min(...rates)));
  const lgMax = Math.ceil(Math.log10(Math.max(...rates)));
  lgMin = Math.max(lgMin, lgMax - 6);
  const x = (v) => L + (Math.log10(v) - xMin) / (xMax - xMin) * (w - L - R);
  const y = (r) => {
    const lg = Math.max(lgMin, Math.min(lgMax, Math.log10(Math.max(r, 1e-9))));
    return T + (lgMax - lg) / (lgMax - lgMin) * (h - T - B);
  };
  ctx.strokeStyle = GRID; ctx.fillStyle = TXT; ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let lg = lgMin; lg <= lgMax; lg++) {
    ctx.beginPath(); ctx.moveTo(L, y(10 ** lg)); ctx.lineTo(w - R, y(10 ** lg)); ctx.stroke();
    ctx.fillText(lg >= 0 ? String(10 ** lg) : `10⁻${'¹²³⁴⁵⁶'[-lg - 1] ?? -lg}`, L - 7, y(10 ** lg) + 4);
  }
  ctx.textAlign = 'center';
  const ticksD = state.metric === 'deaths'
    ? [[10, '10'], [100, '100'], [1000, '1k'], [10000, '10k'], [100000, '100k'], [1000000, '1M']]
    : [[1e5, '$100M'], [1e6, '$1B'], [1e7, '$10B'], [1e8, '$100B']];
  for (const [v, lab] of ticksD) {
    if (v < xs[0] * 0.9 || v > xs[xs.length - 1] * 1.1) continue;
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x(v), T); ctx.lineTo(x(v), h - B); ctx.stroke();
    ctx.fillText(lab, x(v), h - B + 16);
  }
  ctx.save(); ctx.translate(11, (h - B) / 2 + 55); ctx.rotate(-Math.PI / 2);
  ctx.fillText('events ≥ x per year', 0, 0); ctx.restore();
  ctx.textAlign = 'left';
  // per-hazard curves (top 5 by overall presence)
  const totals = new Map();
  for (const c of curve) for (const p of c.perHazard) totals.set(p.type, (totals.get(p.type) ?? 0) + p.lambda);
  const top = [...totals.entries()].sort((a2, b) => b[1] - a2[1]).slice(0, 5).map((e) => e[0]);
  for (const t of top) {
    ctx.beginPath();
    let started = false;
    for (const c of curve) {
      const p = c.perHazard.find((q) => q.type === t);
      if (!p || p.lambda <= 0) { started = false; continue; }
      const px = x(c.x), py = y(p.lambda);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      started = true;
    }
    ctx.strokeStyle = HAZ_COLORS[t] + '99'; ctx.lineWidth = 1.2; ctx.stroke();
  }
  // total with CI whiskers
  for (const c of curve) {
    ctx.strokeStyle = 'rgba(216,201,138,0.6)';
    ctx.beginPath(); ctx.moveTo(x(c.x), y(c.ci95.lo || 1e-9)); ctx.lineTo(x(c.x), y(c.ci95.hi)); ctx.stroke();
    ctx.fillStyle = BRASS;
    ctx.beginPath(); ctx.arc(x(c.x), y(c.lambda), 2.6, 0, 7); ctx.fill();
  }
  ctx.strokeStyle = '#d4756a';
  ctx.beginPath(); ctx.moveTo(x(state.threshold), T); ctx.lineTo(x(state.threshold), h - B); ctx.stroke();
  // legend
  let lx = L + 8;
  for (const t of top) {
    ctx.fillStyle = HAZ_COLORS[t];
    ctx.fillRect(lx, T + 2, 10, 3);
    ctx.fillStyle = TXT;
    ctx.fillText(state.imp.meta.hazards[t], lx + 14, T + 8);
    lx += 24 + ctx.measureText(state.imp.meta.hazards[t]).width;
  }
  $('fs-caption').textContent = `gold: all hazards (95% CI) · thin lines: leading hazards · ${scopeText()}`;
}

function drawSeason(a) {
  const { ctx, w, h } = setupCanvas($('season-chart'));
  ctx.clearRect(0, 0, w, h);
  const floor = state.metric === 'deaths' ? Math.min(state.threshold, 10) : Math.min(state.threshold, 1e5);
  const profile = I.monthlyProfile(state.imp, { metric: state.metric, us: state.us, type: null, floor });
  if (!profile) { ctx.fillStyle = TXT; ctx.font = '12px sans-serif'; ctx.fillText('Too few events in scope for a seasonal signal.', 10, 30); return; }
  const L = 8, R = 8, T = 18, B = 22;
  const bw = (w - L - R) / 12;
  const maxF = Math.max(...profile);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  for (let m = 0; m < 12; m++) {
    const f = profile[m];
    const bh = (h - T - B) * (f / maxF);
    ctx.fillStyle = `rgba(184,169,106,${0.25 + 0.55 * (f / maxF)})`;
    ctx.fillRect(L + m * bw + 2, h - B - bh, bw - 4, bh);
    ctx.fillStyle = TXT;
    ctx.fillText(MON[m], L + m * bw + bw / 2, h - B + 15);
  }
  const now = new Date();
  const mNow = now.getUTCMonth() + (now.getUTCDate() - 1) / 31;
  ctx.strokeStyle = '#d4756a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(L + mNow * bw + bw / 2, T - 6); ctx.lineTo(L + mNow * bw + bw / 2, h - B); ctx.stroke();
  ctx.fillStyle = '#d4756a'; ctx.textAlign = 'left';
  ctx.fillText('today', Math.min(L + mNow * bw + bw / 2 + 5, w - 40), T + 2);
}

function renderEvents(a) {
  const box = $('events-list');
  if (!a || a.n === 0) { box.innerHTML = ''; $('events-caption').textContent = ''; return; }
  const imp = state.imp;
  const rows = a.qualifying.slice().sort((x, y2) => imp.day[y2] - imp.day[x]).slice(0, 30);
  $('events-caption').textContent = `${fmtInt(a.n)} events ≥ this severity in the complete record · showing latest ${rows.length} (record ends ${imp.meta.dataEnd})`;
  box.innerHTML = rows.map((i) => {
    const v = imp.value(i, state.metric, state.us);
    return `<div class="ev"><span class="d">${fmtDate(imp.day[i])}</span>
      <span class="m" style="color:${HAZ_COLORS[imp.type[i]]}">${imp.meta.hazards[imp.type[i]]}</span>
      <span>${imp.label[i] || '—'}</span>
      <span class="val">${state.metric === 'deaths' ? fmtInt(v) + ' deaths' : fmtDamage(v)}</span></div>`;
  }).join('');
}

// ─── controls ────────────────────────────────────────────────────────────
let raf = null;
const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; renderAll(); }); };

function setMetric(metric) {
  state.metric = metric;
  $('metric-deaths').classList.toggle('active', metric === 'deaths');
  $('metric-damage').classList.toggle('active', metric === 'damage');
  state.threshold = metric === 'deaths' ? 1000 : 1e7;
  $('threshold').value = valueToTh(metric, state.threshold);
  $('threshold-label').textContent = fmtThreshold(metric, state.threshold);
  scheduleRender();
}
function setScope(us) {
  state.us = us;
  $('scope-global').classList.toggle('active', !us);
  $('scope-us').classList.toggle('active', us);
  scheduleRender();
}
function wireControls() {
  $('metric-deaths').onclick = () => setMetric('deaths');
  $('metric-damage').onclick = () => setMetric('damage');
  $('scope-global').onclick = () => setScope(false);
  $('scope-us').onclick = () => setScope(true);
  $('threshold').oninput = () => {
    state.threshold = thToValue(state.metric, Number($('threshold').value));
    $('threshold-label').textContent = fmtThreshold(state.metric, state.threshold);
    scheduleRender();
  };
  const scrub = $('scrub');
  scrub.value = yearsToScrub(1);
  scrub.oninput = () => {
    state.windowYears = scrubToYears(Number(scrub.value));
    $('scrub-label').textContent = fmtWindow(state.windowYears);
    scheduleRender();
  };
  $('threshold').value = valueToTh('deaths', state.threshold);
  $('threshold-label').textContent = fmtThreshold('deaths', state.threshold);
  window.addEventListener('resize', scheduleRender);
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('metric', state.metric);
  p.set('t', String(state.threshold));
  p.set('w', state.windowYears.toPrecision(3));
  if (state.us) p.set('scope', 'us');
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('metric') === 'damage') setMetric('damage');
  if (p.get('scope') === 'us') setScope(true);
  const t = Number(p.get('t'));
  if (Number.isFinite(t) && t > 0) {
    state.threshold = Math.min(TH[state.metric].hi, Math.max(TH[state.metric].lo, t));
    $('threshold').value = valueToTh(state.metric, state.threshold);
    $('threshold-label').textContent = fmtThreshold(state.metric, state.threshold);
  }
  const wY = Number(p.get('w'));
  if (Number.isFinite(wY) && wY > 0) {
    state.windowYears = Math.min(SCRUB_MAX_Y, Math.max(SCRUB_MIN_Y, wY));
    $('scrub').value = yearsToScrub(state.windowYears);
    $('scrub-label').textContent = fmtWindow(state.windowYears);
  }
}

init().catch((err) => {
  $('data-status').innerHTML = `<span class="warn">Failed to load data: ${err.message}. Serve this folder (e.g. \`python3 -m http.server\`) rather than opening from disk.</span>`;
});
