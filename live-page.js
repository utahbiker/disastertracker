// live-page.js — controller for the "Happening now" page: globe + event
// list + pulse/alert cards. All statistics separation rules of live.js
// apply; this file is pure presentation.

import * as L from './live.js';
import { Globe } from './globe.js';
import { VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 10 * 60 * 1000;
const fmtInt = (n) => n.toLocaleString('en-US');

const ago = (ms) => {
  const h = (Date.now() - ms) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

let globe = null;

function renderList(events) {
  const box = $('globe-list');
  box.innerHTML = events.map((e, i) => `
    <div class="globe-row" data-i="${i}">
      <span class="globe-dot" style="background:${e.color.replace('ALPHA', '1')}"></span>
      <span class="globe-row-main">${e.icon} <b>${e.title}</b>${e.url ? ` <a class="globe-src-link" href="${e.url}" target="_blank" rel="noopener" title="Open source report">↗</a>` : ''}<br>
        <span class="sm subtle">${e.detail ? e.detail + ' · ' : ''}${ago(e.timeMs)}</span></span>
    </div>`).join('');
  for (const row of box.querySelectorAll('.globe-row')) {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return; // source link, not a select
      const i = Number(row.dataset.i);
      globe.select(i);
      highlight(i);
    });
  }
}

function highlight(i) {
  const box = $('globe-list');
  box.querySelectorAll('.globe-row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.i) === i));
  const el = box.querySelector(`.globe-row[data-i="${i}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function refreshGlobe() {
  let quakes = [], alerts = [], storms = [];
  const sources = [];
  try { quakes = await L.fetchGlobeQuakes(); sources.push('USGS'); } catch { /* status line reports */ }
  try {
    const a = await L.fetchAlerts();
    alerts = a.alerts; // GDACS positions, or ReliefWeb country centroids
    sources.push(a.source);
  } catch { /* status line reports */ }
  try { storms = await L.fetchEonetStorms(); if (storms.length) sources.push('EONET'); } catch { /* optional source */ }
  const events = L.mergeGlobeEvents(quakes, alerts, storms);
  const firstLoad = globe.events.length === 0;
  globe.setEvents(events);
  renderList(events);
  // on first load, fly to the newest event so a ping is front and center
  if (events.length) { globe.select(0, firstLoad); highlight(0); }
  $('data-status').textContent = events.length
    ? `${events.length} major events, last ${L.GLOBE_WINDOW_DAYS} days (${sources.join(' + ')}) · quakes M ≥ ${L.GLOBE_QUAKE_MIN_MAG} · alerts orange/red · storms ≥ 64 kt · updated ${new Date().toTimeString().slice(0, 5)}`
    : 'Live feeds unreachable from this network — the globe will retry. The Overview statistics are unaffected.';
}

// pulse + alert cards (same rendering as the former dashboard section)
async function renderPulse() {
  const box = $('live-pulse');
  try {
    const p = await L.fetchSeismicPulse();
    const v = L.seismicPulseVerdict(p.observed);
    const tone = v.verdict === 'elevated' ? 'up' : v.verdict === 'quiet' ? 'down' : '';
    const biggest = p.largest[0];
    box.innerHTML = `
      <div class="live-head">🌐 Global seismicity, last ${L.PULSE_WINDOW_DAYS} days <span class="live-src">USGS, live</span></div>
      <div class="live-big"><b>${fmtInt(p.observed)}</b> <span class="sm">M 5+ earthquakes</span>
        <span class="live-verdict ${tone}">${v.verdict}</span></div>
      <div class="sm">long-run pace: ${Math.round(v.mu)} per ${L.PULSE_WINDOW_DAYS} days · typical range ${v.lo}–${v.hi} <span class="subtle">(95% Poisson band from this site's own catalog)</span></div>
      ${biggest ? `<div class="sm">largest: <b>M ${biggest.mag.toFixed(1)}</b> — ${biggest.place} <span class="subtle">(${new Date(biggest.timeMs).toISOString().slice(0, 10)})</span></div>` : ''}`;
    return true;
  } catch {
    box.innerHTML = '<span class="sm subtle">USGS live feed unreachable — will retry.</span>';
    return false;
  }
}

async function renderAlerts() {
  const box = $('live-alerts');
  try {
    const a = await L.fetchAlerts();
    const rows = a.alerts.slice(0, 8).map((al) => `
      <div class="live-alert">
        <span class="alert-dot ${al.level}"></span>
        <span>${al.icon} <b>${al.name || al.label}</b>${al.country ? ` — ${al.country}` : ''}
          <span class="subtle sm">${al.label}${al.from ? ` · since ${al.from}` : ''}</span></span>
      </div>`).join('');
    const quiet = a.alerts.length === 0 ? '<div class="sm subtle">No red or orange alerts right now.</div>' : '';
    const greens = a.greens > 0 ? `<div class="sm subtle">+ ${a.greens} minor (green) events being tracked</div>` : '';
    box.innerHTML = `<div class="live-head">🚨 Active disaster alerts <span class="live-src">${a.source}, live</span></div>${rows}${quiet}${greens}`;
    return true;
  } catch {
    box.innerHTML = '<span class="sm subtle">Alert feeds (GDACS / ReliefWeb) unreachable — will retry.</span>';
    return false;
  }
}

async function refreshAll() {
  const [okP, okA] = await Promise.all([renderPulse(), renderAlerts()]);
  await refreshGlobe();
  const t = new Date().toTimeString().slice(0, 5);
  $('live-status').textContent = okP || okA
    ? `Updated ${t} · refreshes every 10 minutes · live feeds never feed the probability model.`
    : 'Live feeds unreachable from this network. The statistics on the Overview run on the bundled record and are unaffected.';
}

async function init() {
  $('app-version').textContent = VERSION;
  const world = await (await fetch('data/world-outline.json')).json();
  globe = new Globe($('globe'), world, { onSelect: highlight });
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
}

init().catch((err) => {
  $('data-status').innerHTML = `<span class="warn">Failed to start: ${err.message}</span>`;
});
