// globe.js — dependency-free interactive orthographic globe on canvas 2D
// for the "Happening now" page. Coastlines from data/world-outline.json
// (Natural Earth 110m, public domain). Auto-rotates when idle; drag to
// rotate; click a ping to select an event. Pure math exported for tests.

const DEG = Math.PI / 180;

/**
 * Orthographic projection of (lat, lon) onto a globe centered on
 * (cLat, cLon) with radius R. y is UP (caller flips for screen).
 * `visible` = on the near hemisphere (small tolerance so coastline
 * segments don't pop at the limb).
 */
export function project(lat, lon, cLat, cLon, R) {
  const p = lat * DEG, l = (lon - cLon) * DEG, p0 = cLat * DEG;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
  return {
    x: R * Math.cos(p) * Math.sin(l),
    y: R * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)),
    visible: cosc >= -0.015,
    cosc,
  };
}

/** Shortest signed longitude difference a→b in degrees, in (−180, 180]. */
export function lonDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export class Globe {
  constructor(canvas, world, { onSelect = null } = {}) {
    this.canvas = canvas;
    this.world = world; // { rings: [ [lat,lon,lat,lon,...], ... ] }
    this.onSelect = onSelect;
    this.cLat = 18; this.cLon = -30;
    this.events = [];
    this.selected = -1;
    this.lastInteract = 0;
    this.fly = null; // { fromLat, fromLon, toLat, toLon, t0, ms }
    this.dragging = false;
    this._raf = null;
    this._wirePointer();
    const ro = new ResizeObserver(() => this._size());
    ro.observe(canvas);
    this._size();
    this.start();
  }

  _size() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || w;
    this.w = w; this.h = h;
    this.R = Math.min(w, h) / 2 - 14;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx = ctx;
  }

  setEvents(events) { this.events = events; }

  select(i, fly = true) {
    this.selected = i;
    const e = this.events[i];
    if (e && fly) this.flyTo(e.lat, e.lon);
  }

  flyTo(lat, lon, ms = 750) {
    this.fly = { fromLat: this.cLat, fromLon: this.cLon, toLat: Math.max(-80, Math.min(80, lat)), dLon: lonDelta(this.cLon, lon), t0: performance.now(), ms };
    this.lastInteract = performance.now();
  }

  _wirePointer() {
    const c = this.canvas;
    let px = 0, py = 0, moved = 0;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (ev) => {
      this.dragging = true; moved = 0;
      px = ev.clientX; py = ev.clientY;
      c.setPointerCapture(ev.pointerId);
      this.lastInteract = performance.now();
      this.fly = null;
    });
    c.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return;
      const dx = ev.clientX - px, dy = ev.clientY - py;
      px = ev.clientX; py = ev.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const k = 90 / this.R; // degrees per pixel at globe scale
      this.cLon -= dx * k;
      this.cLat = Math.max(-85, Math.min(85, this.cLat + dy * k));
      this.lastInteract = performance.now();
    });
    c.addEventListener('pointerup', (ev) => {
      this.dragging = false;
      this.lastInteract = performance.now();
      if (moved < 5) {
        const rect = c.getBoundingClientRect();
        const hit = this.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
        if (hit >= 0) { this.selected = hit; if (this.onSelect) this.onSelect(hit); }
      }
    });
    c.addEventListener('pointercancel', () => { this.dragging = false; });
  }

  _screen(lat, lon) {
    const p = project(lat, lon, this.cLat, this.cLon, this.R);
    return { x: this.w / 2 + p.x, y: this.h / 2 - p.y, visible: p.visible, cosc: p.cosc };
  }

  hitTest(sx, sy) {
    let best = -1, bestD = 16;
    this.events.forEach((e, i) => {
      const s = this._screen(e.lat, e.lon);
      if (!s.visible) return;
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  start() {
    const tick = (t) => {
      // fly animation, else idle auto-spin
      if (this.fly) {
        const f = this.fly;
        const u = Math.min(1, (t - f.t0) / f.ms);
        const e = 1 - Math.pow(1 - u, 3); // ease-out cubic
        this.cLat = f.fromLat + (f.toLat - f.fromLat) * e;
        this.cLon = f.fromLon + f.dLon * e;
        if (u >= 1) this.fly = null;
      } else if (!this.dragging && t - this.lastInteract > 4000) {
        this.cLon -= 0.035; // slow idle spin
      }
      this.render(t);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  render(t = 0) {
    const { ctx, w, h, R } = this;
    if (!ctx) return;
    const cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    // sphere
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#111a30');
    g.addColorStop(1, '#070b16');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(184,169,106,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();

    // graticule
    ctx.strokeStyle = 'rgba(138,147,166,0.13)';
    ctx.lineWidth = 0.6;
    for (let lat = -60; lat <= 60; lat += 30) this._polyline(this._sample((s) => [lat, s]), false);
    for (let lon = -180; lon < 180; lon += 30) this._polyline(this._sample((s) => [(s / 2) - 90, lon], 90), false);

    // coastlines
    ctx.strokeStyle = 'rgba(216,201,138,0.55)';
    ctx.lineWidth = 1;
    for (const ring of this.world.rings) this._ring(ring);

    // pings
    this.events.forEach((e, i) => {
      const s = this._screen(e.lat, e.lon);
      if (!s.visible) return;
      const sel = i === this.selected;
      const phase = ((t / 1400) + i * 0.37) % 1;
      const rr = 4 + phase * (sel ? 22 : 14);
      ctx.strokeStyle = e.color.replace('ALPHA', String((1 - phase) * (sel ? 0.95 : 0.6)));
      ctx.lineWidth = sel ? 1.8 : 1.2;
      ctx.beginPath(); ctx.arc(s.x, s.y, rr, 0, 7); ctx.stroke();
      ctx.fillStyle = e.color.replace('ALPHA', sel ? '1' : '0.9');
      ctx.beginPath(); ctx.arc(s.x, s.y, sel ? 4.5 : 3, 0, 7); ctx.fill();
      if (sel) {
        ctx.fillStyle = 'rgba(232,236,244,0.95)';
        ctx.font = '11px sans-serif';
        const label = e.short;
        const tx = Math.min(Math.max(s.x + 9, 6), w - ctx.measureText(label).width - 6);
        ctx.fillText(label, tx, s.y - 9);
      }
    });
  }

  _sample(fn, steps = 180) {
    const pts = [];
    for (let s = 0; s <= steps; s += 3) pts.push(fn(s * (360 / steps) - (steps === 90 ? 0 : 180)));
    return pts;
  }

  _polyline(pts) {
    const { ctx } = this;
    ctx.beginPath();
    let pen = false;
    for (const [lat, lon] of pts) {
      const s = this._screen(lat, lon);
      if (!s.visible) { pen = false; continue; }
      if (pen) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
      pen = true;
    }
    ctx.stroke();
  }

  _ring(flat) {
    const { ctx } = this;
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k < flat.length; k += 2) {
      const s = this._screen(flat[k], flat[k + 1]);
      if (!s.visible) { pen = false; continue; }
      if (pen) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
      pen = true;
    }
    ctx.stroke();
  }
}
