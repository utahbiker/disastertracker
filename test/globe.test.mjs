// test/globe.test.mjs — globe math (orthographic projection, longitude
// wrap), the major-event thresholds and merge/dedup, and the world-outline
// data file. Run: node --test test/globe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { project, lonDelta } from '../globe.js';
import {
  mergeGlobeEvents, GLOBE_QUAKE_MIN_MAG, GLOBE_MAX_EVENTS, GLOBE_WINDOW_DAYS,
  hazardCode, parseEonetStorms, parseReliefWeb, ssCategory,
} from '../live.js';

const here = dirname(fileURLToPath(import.meta.url));

test('orthographic projection: center, cardinal points, far side', () => {
  const R = 100;
  const c = project(10, 20, 10, 20, R);
  assert.ok(Math.abs(c.x) < 1e-9 && Math.abs(c.y) < 1e-9 && c.visible);
  // 90° east on the equator, centered on the equator: x = R, y = 0
  const e = project(0, 90, 0, 0, R);
  assert.ok(Math.abs(e.x - R) < 1e-9 && Math.abs(e.y) < 1e-9);
  // north pole from an equatorial center: y = R
  const n = project(90, 0, 0, 0, R);
  assert.ok(Math.abs(n.y - R) < 1e-9 && Math.abs(n.x) < 1e-9);
  // the antipode is hidden
  assert.equal(project(-10, -160, 10, 20, R).visible, false);
  // date-line wrap: 179°E seen from 179°W is nearby and visible
  const w = project(0, 179, 0, -179, R);
  assert.ok(w.visible && Math.abs(w.x) < R * 0.05);
});

test('lonDelta wraps the short way', () => {
  assert.equal(lonDelta(170, -170), 20);
  assert.equal(lonDelta(-170, 170), -20);
  assert.equal(lonDelta(0, 180), 180);
  assert.equal(lonDelta(10, 10), 0);
});

test('mergeGlobeEvents: thresholds, dedup, ordering, cap', () => {
  const now = Date.now();
  const quakes = [
    { mag: 5.5, lat: 0, lon: 0, timeMs: now, place: 'too small' },
    { mag: 5.9, lat: 10, lon: 10, timeMs: now - 1000, place: 'at threshold' },
    { mag: 7.1, lat: 35, lon: 140, timeMs: now - 5000, place: 'Japan' },
    { mag: 6.2, lat: NaN, lon: 20, timeMs: now, place: 'no coords' },
  ];
  const alerts = [
    // GDACS echo of the Japan quake → deduped
    { type: 'EQ', level: 'red', lat: 36, lon: 141, timeMs: now - 6000, name: 'Japan EQ', label: 'Earthquake', icon: 'x' },
    // distinct cyclone → kept
    { type: 'TC', level: 'orange', lat: -18, lon: 178, timeMs: now - 2000, name: 'Cyclone Test', label: 'Tropical cyclone', icon: 'y', country: 'Fiji' },
    // no coordinates → dropped
    { type: 'FL', level: 'orange', lat: null, lon: null, timeMs: now, name: 'Flood', label: 'Flood', icon: 'z' },
  ];
  const out = mergeGlobeEvents(quakes, alerts);
  assert.equal(out.length, 3); // threshold quake + Japan quake + cyclone
  assert.ok(out.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
  assert.ok(!out.some((e) => e.title.includes('too small')));
  assert.ok(!out.some((e) => e.title.includes('Japan EQ'))); // dedup kept USGS
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].timeMs >= out[i].timeMs, 'newest first');
  // cap
  const many = Array.from({ length: 60 }, (_, i) => ({ mag: 6, lat: (i % 30) * 5 - 70, lon: i * 6 - 180, timeMs: now - i * 1e7, place: String(i) }));
  assert.equal(mergeGlobeEvents(many, []).length, GLOBE_MAX_EVENTS);
  assert.ok(GLOBE_QUAKE_MIN_MAG >= 5.9 - 1e-9, 'threshold per spec');
});

test('21-day window: older events are excluded', () => {
  const now = Date.now();
  const quakes = [
    { mag: 7.0, lat: 0, lon: 0, timeMs: now - (GLOBE_WINDOW_DAYS - 1) * 86400000, place: 'recent' },
    { mag: 7.5, lat: 20, lon: 20, timeMs: now - (GLOBE_WINDOW_DAYS + 2) * 86400000, place: 'too old' },
  ];
  const out = mergeGlobeEvents(quakes, [], [], now);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /recent/);
});

test('hazardCode inference from free-text labels', () => {
  assert.equal(hazardCode('Tropical Cyclone'), 'TC');
  assert.equal(hazardCode('Flash Flood'), 'FL');
  assert.equal(hazardCode('Land Slide'), 'LS');
  assert.equal(hazardCode('Mudslide'), 'LS');
  assert.equal(hazardCode('Volcanic eruption'), 'VO');
  assert.equal(hazardCode('Wild Fire'), 'WF');
  assert.equal(hazardCode('Earthquake'), 'EQ');
  assert.equal(hazardCode('Cold Wave'), '');
});

test('EONET storms: hurricane-force filter, latest track point', () => {
  const now = new Date().toISOString();
  const json = { events: [
    { title: 'Hurricane Test', link: 'https://e', geometry: [
      { date: '2026-08-20T00:00:00Z', coordinates: [-60, 15], magnitudeValue: 45, magnitudeUnit: 'kts' },
      { date: now, coordinates: [-70, 22], magnitudeValue: 90, magnitudeUnit: 'kts' },
    ] },
    { title: 'Tropical Depression Weak', geometry: [
      { date: now, coordinates: [130, 18], magnitudeValue: 30, magnitudeUnit: 'kts' },
    ] },
  ] };
  const out = parseEonetStorms(json);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Hurricane Test');
  assert.equal(out[0].lat, 22); // latest point, not first
  assert.equal(out[0].kts, 90);
  assert.equal(parseEonetStorms(null).length, 0);
});

test('cross-source dedup: GDACS storm suppresses the EONET echo, distinct storm kept', () => {
  const now = Date.now();
  const alerts = [{ type: 'TC', level: 'red', lat: 12.4, lon: 124.5, timeMs: now - 3600e3, name: 'Cyclone A', label: 'Tropical cyclone', icon: 'x' }];
  const storms = [
    { name: 'Cyclone A (EONET)', kts: 100, lat: 13.0, lon: 125.2, timeMs: now - 1800e3 }, // same storm
    { name: 'Hurricane B', kts: 80, lat: 25, lon: -75, timeMs: now - 7200e3 },            // different basin
  ];
  const out = mergeGlobeEvents([], alerts, storms, now);
  assert.equal(out.length, 2);
  assert.ok(out.some((e) => e.title.includes('Cyclone A') && !e.title.includes('EONET')));
  assert.ok(out.some((e) => e.title.includes('Hurricane B')));
});

test('ReliefWeb fallback rows carry country-centroid coordinates', () => {
  const rw = { data: [
    { fields: { name: 'Floods — Pakistan', status: 'ongoing', primary_type: { name: 'Flood' }, primary_country: { name: 'Pakistan', location: { lat: 30.0, lon: 70.0 } }, date: { created: new Date().toISOString() } } },
  ] };
  const r = parseReliefWeb(rw);
  assert.equal(r.alerts[0].lat, 30);
  assert.equal(r.alerts[0].lon, 70);
  assert.equal(r.alerts[0].type, 'FL');
  const out = mergeGlobeEvents([], r.alerts, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'FL');
});

test('world-outline.json: sane public-domain coastline data', () => {
  const w = JSON.parse(readFileSync(join(here, '..', 'data', 'world-outline.json'), 'utf8'));
  assert.ok(w.rings.length > 50, `rings=${w.rings.length}`);
  assert.match(w.meta.source, /Natural Earth/);
  let nv = 0;
  for (const r of w.rings) {
    assert.ok(r.length >= 16 && r.length % 2 === 0);
    for (let k = 0; k < r.length; k += 2) {
      assert.ok(r[k] >= -91 && r[k] <= 91, `lat ${r[k]}`);
      assert.ok(r[k + 1] >= -181 && r[k + 1] <= 181, `lon ${r[k + 1]}`);
      nv++;
    }
  }
  assert.ok(nv > 3000 && nv < 20000, `vertices ${nv}`);
});

test('event rows carry info + live-tracking links per source', () => {
  const now = Date.now();
  const quakes = [{ mag: 7.1, magType: 'mww', lat: 38.1, lon: 142.3, timeMs: now - 3600e3, place: 'Japan', depthKm: 29, pager: 'yellow', tsunami: true, felt: 1234, url: 'https://earthquake.usgs.gov/x' }];
  const alerts = [{ type: 'TC', level: 'red', lat: 12.4, lon: 124.5, timeMs: now - 7200e3, name: 'Cyclone V', label: 'Tropical cyclone', icon: 'x', country: 'Philippines', from: '2026-08-29', to: '2026-08-31', score: 2.5, severity: 'Cat 4. max wind 120 kt', url: 'https://gdacs.org/r' }];
  const storms = [{ name: 'Hurricane B', kts: 100, lat: 25, lon: -75, timeMs: now - 9000e3, trackPts: 14, sinceMs: now - 5 * 86400e3, agency: 'NOAA_NHC', url: 'https://nhc.noaa.gov/x' }];
  const out = mergeGlobeEvents(quakes, alerts, storms, now);
  assert.equal(out.length, 3);
  const q = out.find((e) => e.kind === 'EQ');
  assert.ok(q.info.some(([k, v]) => k === 'Depth' && /29 km — shallow/.test(v)));
  assert.ok(q.info.some(([k]) => k === 'USGS PAGER'));
  assert.ok(q.info.some(([k, v]) => k === 'Tsunami'));
  assert.ok(q.links.some((l) => /USGS event page/.test(l.t) && l.u.includes('usgs.gov')));
  assert.ok(q.links.some((l) => l.t === 'Map' && l.u.includes('google.com/maps')));
  const a = out.find((e) => e.title.includes('Cyclone V'));
  assert.ok(a.info.some(([k, v]) => k === 'Alert level' && /GDACS RED \(score 2.5\)/.test(v)));
  assert.ok(a.info.some(([k, v]) => k === 'Since' && v === '2026-08-29 → 2026-08-31'));
  assert.ok(a.links.some((l) => /GDACS event report/.test(l.t)));
  const s = out.find((e) => e.title === 'Hurricane B');
  assert.ok(s.info.some(([k, v]) => k === 'Peak winds' && /100 kt .* Category 3/.test(v)));
  assert.ok(s.info.some(([k, v]) => k === 'Track' && /14 positions/.test(v)));
  assert.ok(s.links.some((l) => /NOAA_NHC storm tracking/.test(l.t) && l.u.includes('nhc.noaa.gov')));
});

test('ssCategory: Saffir–Simpson bins', () => {
  assert.equal(ssCategory(63), 0);
  assert.equal(ssCategory(64), 1);
  assert.equal(ssCategory(83), 2);
  assert.equal(ssCategory(96), 3);
  assert.equal(ssCategory(113), 4);
  assert.equal(ssCategory(140), 5);
});

test('EONET agency source link preferred over the API link', () => {
  const now = new Date().toISOString();
  const json = { events: [{ title: 'Hurricane S', link: 'https://eonet.gsfc.nasa.gov/api/v3/events/E1',
    sources: [{ id: 'NOAA_NHC', url: 'https://www.nhc.noaa.gov/storm' }],
    geometry: [{ date: now, coordinates: [-70, 22], magnitudeValue: 90, magnitudeUnit: 'kts' }] }] };
  const out = parseEonetStorms(json);
  assert.equal(out[0].url, 'https://www.nhc.noaa.gov/storm');
  assert.equal(out[0].agency, 'NOAA_NHC');
});
