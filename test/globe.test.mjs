// test/globe.test.mjs — globe math (orthographic projection, longitude
// wrap), the major-event thresholds and merge/dedup, and the world-outline
// data file. Run: node --test test/globe.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { project, lonDelta } from '../globe.js';
import { mergeGlobeEvents, GLOBE_QUAKE_MIN_MAG, GLOBE_MAX_EVENTS } from '../live.js';

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
  const many = Array.from({ length: 40 }, (_, i) => ({ mag: 6, lat: i, lon: i, timeMs: now - i, place: String(i) }));
  assert.equal(mergeGlobeEvents(many, []).length, GLOBE_MAX_EVENTS);
  assert.ok(GLOBE_QUAKE_MIN_MAG >= 5.9 - 1e-9, 'threshold per spec');
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
