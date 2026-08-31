#!/usr/bin/env node
// etl/build-world.mjs — compacts Natural Earth 110m land polygons into
// data/world-outline.json for the "Happening now" globe.
//
// Source: Natural Earth (naturalearthdata.com), 110m land, PUBLIC DOMAIN,
// via the ne_110m_land.geojson copy in github.com/nvkelso/natural-earth-vector.
//
// Output format: { meta, rings: [ [lat0,lon0, lat1,lon1, ...], ... ] } —
// flat interleaved arrays, coordinates rounded to 0.1°, rings under
// `minVerts` vertices dropped (micro-islands invisible at globe scale).
//
// Usage: node etl/build-world.mjs --in <ne_110m_land.geojson> [--out data]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }),
);
if (!args.in) { console.error('usage: build-world.mjs --in <geojson> [--out data]'); process.exit(1); }
const OUT = args.out ?? 'data';
const MIN_VERTS = 8;

const gj = JSON.parse(readFileSync(args.in, 'utf8'));
const rings = [];
for (const f of gj.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      if (ring.length < MIN_VERTS) continue;
      const flat = [];
      let lastLat = null, lastLon = null;
      for (const [lon, lat] of ring) {
        const la = Math.round(lat * 10) / 10, lo = Math.round(lon * 10) / 10;
        if (la === lastLat && lo === lastLon) continue; // rounding-collapsed
        flat.push(la, lo);
        lastLat = la; lastLon = lo;
      }
      if (flat.length >= MIN_VERTS * 2) rings.push(flat);
    }
  }
}

const out = {
  meta: {
    source: 'Natural Earth 110m land (public domain), via github.com/nvkelso/natural-earth-vector ne_110m_land.geojson',
    precision: 0.1,
    buildDate: new Date().toISOString().slice(0, 10),
  },
  rings,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'world-outline.json'), JSON.stringify(out));
const nv = rings.reduce((s, r) => s + r.length / 2, 0);
console.log(`written ${OUT}/world-outline.json — ${rings.length} rings, ${nv} vertices, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
