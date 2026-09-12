// test/anomaly.test.mjs — the seismologist's watchlist: exact Poisson tail,
// self-relative anomaly detection, swarm/aftershock classification, magnitude
// escalation, neighbor-cell merging, and defensive feed parsing.
// Run: node --test test/anomaly.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../anomaly.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-12T00:00:00Z');

// synthetic event helper: daysAgo relative to NOW
const ev = (daysAgo, mag, lat, lon, depthKm = 8) => ({
  mag, timeMs: NOW - daysAgo * DAY, lat, lon, depthKm, place: 'test', url: 'https://x/e',
});

test('poissonTail matches direct Poisson summation', () => {
  const direct = (k, mu) => {
    let s = 0, p = Math.exp(-mu);
    for (let i = 0; i < k; i++) { s += p; p *= mu / (i + 1); }
    return 1 - s;
  };
  for (const [k, mu] of [[1, 0.2], [3, 1], [8, 0.5], [10, 4], [25, 7]]) {
    assert.ok(Math.abs(A.poissonTail(k, mu) - direct(k, mu)) < 1e-10, `k=${k} mu=${mu}`);
  }
  assert.equal(A.poissonTail(0, 3), 1); // P(X >= 0) is certain
});

test('steady background rate is NOT an anomaly', () => {
  // one event a day for 30 days in one cell — perfectly steady
  const quakes = [];
  for (let d = 0; d < 30; d++) quakes.push(ev(d + 0.5, 1.5 + (d % 5) * 0.2, 38.5, -112.9));
  assert.equal(A.detectAnomalies(quakes, NOW).length, 0);
});

test('swarm switch-on in a silent cell is flagged as new-swarm', () => {
  // nothing for 23 days, then 40 events in the last 5 days (the FORGE shape)
  const quakes = [];
  for (let i = 0; i < 40; i++) quakes.push(ev(5 * (i / 40), 1.2 + (i % 8) * 0.1, 38.5, -112.9, 2.4));
  const out = A.detectAnomalies(quakes, NOW);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.kind, 'new-swarm');
  assert.equal(c.n7, 40);
  assert.equal(c.nPrior, 0);
  assert.ok(c.p < A.P_FLAG, `p=${c.p}`);
  assert.ok(Math.abs(c.lat - 38.5) < 0.01 && Math.abs(c.lon + 112.9) < 0.01);
  assert.ok(Math.abs(c.medianDepthKm - 2.4) < 0.01);
});

test('accelerating swarm with rising magnitudes: kind=swarm, escalating', () => {
  const quakes = [];
  // sparse background: 5 events, max M2.0, spread over the baseline window
  for (let i = 0; i < 5; i++) quakes.push(ev(9 + i * 3, 1.6 + i * 0.1, 38.5, -112.9));
  // burst: 30 events in the last week, climbing to M3.1
  for (let i = 0; i < 30; i++) quakes.push(ev(6.5 - i * 0.2, 1.4 + i * 0.06, 38.52, -112.88));
  const out = A.detectAnomalies(quakes, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'swarm');
  assert.equal(out[0].escalating, true);
  assert.ok(out[0].recentMax > 3.0);
  assert.ok(out[0].rateRatio > 10);
});

test('mainshock + Omori decay is labeled aftershocks and ranked last', () => {
  const quakes = [];
  // aftershock sequence: M6.2 six days ago, 50 smaller events after it
  quakes.push(ev(6, 6.2, 35.0, 140.0));
  for (let i = 0; i < 50; i++) quakes.push(ev(5.8 * (1 - i / 50), 2.0 + (i % 10) * 0.15, 35.02, 140.03));
  // plus an escalating new swarm elsewhere
  for (let i = 0; i < 30; i++) quakes.push(ev(4 - i * 0.12, 1.2 + i * 0.06, 38.5, -112.9));
  const out = A.detectAnomalies(quakes, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'new-swarm');       // the watch-worthy one leads
  assert.equal(out[1].kind, 'aftershocks');     // expected physics trails
  assert.equal(out[1].maxMag, 6.2);
});

test('a swarm straddling a cell border merges into one cluster', () => {
  const quakes = [];
  // two lobes ~78 km apart, different grid cells, same physical swarm
  for (let i = 0; i < 15; i++) quakes.push(ev(3 - i * 0.1, 1.5, 38.5, -112.9));
  for (let i = 0; i < 15; i++) quakes.push(ev(3 - i * 0.1, 1.7, 38.5, -112.0));
  const out = A.detectAnomalies(quakes, NOW);
  assert.equal(out.length, 1, 'lobes should fuse');
  assert.equal(out[0].n7, 30);
});

test('parseQuakeFeed keeps earthquakes, drops blasts and malformed rows', () => {
  const gj = { features: [
    { properties: { mag: 2.1, time: NOW, type: 'earthquake', place: 'ok', url: 'u' }, geometry: { coordinates: [-112.9, 38.5, 2.4] } },
    { properties: { mag: 1.8, time: NOW, type: 'quarry blast' }, geometry: { coordinates: [-112, 38, 0] } },
    { properties: { mag: null, time: NOW, type: 'earthquake' }, geometry: { coordinates: [-112, 38, 0] } },
    { properties: { mag: 1.1, time: NOW, type: 'earthquake' }, geometry: { coordinates: [null, 38, 0] } },
  ] };
  const out = A.parseQuakeFeed(gj);
  assert.equal(out.length, 1);
  assert.equal(out[0].mag, 2.1);
  assert.equal(out[0].depthKm, 2.4);
});

test('haversineKm sanity', () => {
  assert.ok(Math.abs(A.haversineKm(0, 0, 0, 1) - 111.2) < 1);
  assert.ok(Math.abs(A.haversineKm(38.5, -112.9, 38.51, -112.83) - 6.2) < 1.5);
});
