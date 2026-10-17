// Layered battle arenas: floors at several heights joined by ramps, decks you can drive over and
// under, walls, jump pads, bumpers, moving obstacles and a drop into the void (or a moat).
// Shared by the server (authoritative simulation) and the browser (prediction for your own kart,
// rendering, the minimap). Maps are plain JSON-friendly data, hand-made or generated.
//
// Coordinates: x and y across the arena (0..size), z up. A kart is a cylinder KART_R wide and
// KART_H tall; it stands on the highest floor under its centre that it can step onto.
//
// Map data (every list optional):
//   size                       the arena is the square 0..size on x and y
//   edge 'wall' | 'void'       a wall all round (default) or open edges to fall off
//   deathZ                     falling below this destroys a kart (default -320)
//   liquid {kind, z}           water or lava filling everything below z
//   ground {z, depth, kind, holes: [{x0, y0, x1, y1}]}   a floor over the whole arena, minus holes
//   blocks [{x0, y0, x1, y1, z0, z1, kind}]              boxes: floors, decks, walls, battlements
//   ramps  [{x0, y0, x1, y1, z0, z1, dir, base, kind}]   a top rising from z0 to z1 towards dir
//                                                        ('x+', 'x-', 'y+', 'y-'), solid down to base
//   cyls   [{x, y, r, z0, z1, kind}]                     round towers, pillars, posts
//   roads  [{points: [[x, y, z]...], w, thick, curb, bank, pillars, kind}]   a raised road along a
//          smooth curve through the points (z null: on the ground there), banked in its bends, with
//          kerbs along both sides and pillars under it (cut into short straight pieces: segs)
//   terrain {seed, amp, scale, base, edge, flats, bowl, craters, kind}   rolling ground (see makeTerrain)
//   pads   [{x, y, z, r, to: [x, y, z], t}]              jump pads: t seconds of flight to `to`
//   bumpers [{x, y, z, r, h, kick}]                      pinball bumpers
//   boosts [{x, y, z, angle}]                            boost chevrons
//   hazards [{x, y, r, z, kind} | {x0, y0, x1, y1, z, kind}]   lava or water pools on a floor
//   movers [{type: 'sweeper' | 'slider' | 'pendulum' | 'drawbridge', ...}]
//   boxes  [{x, y, z}]                                   item boxes
//   spawns [{x, y, z, angle}]
//   deco   [...]                                         scenery only (the renderer's business)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KartLayers = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KART_R = 16; // kart-core's KART_RADIUS
  const KART_H = 36; // a kart with its driver: a deck lower than this above the floor is a wall, not a roof
  const STEP = 10; // a kart rolls up onto anything this much higher than where it is
  const CELL = 128; // collision lookup grid
  const REACH = KART_R + 34; // solids are listed in every cell within this distance of their footprint
  const NAV = 48; // navigation grid (CPU drivers, the map validator)
  const NAV_SLOPE = 0.8; // ground steeper than this is no place to drive (you slide off it): not on the grid
  const EDGE = 40; // edge walls stand this far in from the side of the arena (like the flat arenas)

  const BOX = 0;
  const RAMP = 1;
  const CYL = 2;
  const SEG = 3;
  const DIRS = { 'x+': [0, 1], 'x-': [0, -1], 'y+': [1, 1], 'y-': [1, -1] }; // [axis, sign]

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const ease = (u) => u * u * (3 - 2 * u);
  const smoothstep = (a, b, x) => ease(clamp((x - a) / (b - a), 0, 1));

  // ---------- noise (the same on every machine) ----------
  function hash2(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const u = ease(x - ix);
    const v = ease(y - iy);
    const a = hash2(ix, iy, seed);
    const b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed);
    const d = hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  // Fractal noise in [-1, 1].
  function fbm(x, y, seed, octaves = 4) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += (vnoise(x * f, y * f, seed + o * 17) * 2 - 1) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }

  // ---------- rolling ground ----------
  // def.terrain = {seed, amp, scale, base, edge, flats: [{x, y, r, z, soft}], kind}: a ground over the
  // whole arena that rolls with fractal noise, levelled to z inside each flat (where buildings and
  // pits stand) and back down to base over the last `edge` units by the sides. Baked into a grid once,
  // so lookups are cheap and every machine gets the very same numbers.
  //   bowl {x, y, r, height, width, max, jag}: beyond r from (x, y) the ground climbs into cliffs,
  //        height * ((d - r) / width) ^ 2.2 (up to max), made jagged by noise (jag: how much)
  //   craters [{x, y, r, z, lip, floor}]: inside r the ground dips to z: flat across the middle
  //        (`floor` of the radius; 0 for a plain cosine bowl), then steep walls up to a raised lip
  // Between grid points the ground is two flat triangles per cell, split the way the renderer's
  // mesh is, so the wheels sit on exactly the faces you see.
  const TCELL = 32;
  const lands = new WeakMap();
  function makeTerrain(def) {
    const t = def.terrain;
    if (!t) return null;
    const known = lands.get(t);
    if (known) return known;
    const S = def.size;
    const n = Math.ceil(S / TCELL) + 1;
    const h = new Float32Array(n * n);
    const base = t.base || 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = i * TCELL;
        const y = j * TCELL;
        let z = base + fbm(x / (t.scale || 800), y / (t.scale || 800), t.seed || 1, 4) * (t.amp || 0);
        if (t.edge) z = base + (z - base) * smoothstep(EDGE, t.edge, Math.min(x, y, S - x, S - y));
        for (const f of t.flats || []) {
          const d = Math.hypot(x - f.x, y - f.y);
          if (d < f.r) z += (f.z - z) * (1 - smoothstep(f.r * (f.soft ?? 0.6), f.r, d));
        }
        if (t.bowl) {
          const b = t.bowl;
          const d = Math.hypot(x - b.x, y - b.y) - b.r;
          if (d > 0) {
            const rise = Math.min(b.max || Infinity, b.height * (d / b.width) ** 2.2);
            z += rise * (1 + (b.jag || 0) * fbm(x / 150, y / 150, (t.seed || 1) + 71, 3));
          }
        }
        for (const c of t.craters || []) {
          const d = Math.hypot(x - c.x, y - c.y);
          const f = (c.floor || 0) * c.r;
          if (d < c.r) z += (c.z - z) * (d <= f ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (d - f)) / (c.r - f)));
          const u = (d - c.r) / (c.r * 0.22);
          if (c.lip && u > -1 && u < 1) z += c.lip * (0.5 + 0.5 * Math.cos(Math.PI * u));
        }
        h[j * n + i] = z;
      }
    }
    // Each cell is two triangles, split along the diagonal from (i + 1, j) to (i, j + 1); the slope
    // is the triangle's own (rise per unit along x and y).
    const cellOf = (x, y) => {
      const i = clamp(Math.floor(x / TCELL), 0, n - 2);
      const j = clamp(Math.floor(y / TCELL), 0, n - 2);
      return [i, j, clamp(x / TCELL - i, 0, 1), clamp(y / TCELL - j, 0, 1)];
    };
    const at = (x, y) => {
      const [i, j, fx, fy] = cellOf(x, y);
      const k = j * n + i;
      if (fx + fy <= 1) return h[k] + (h[k + 1] - h[k]) * fx + (h[k + n] - h[k]) * fy;
      return h[k + n + 1] + (h[k + n] - h[k + n + 1]) * (1 - fx) + (h[k + 1] - h[k + n + 1]) * (1 - fy);
    };
    const slope = (x, y, out) => {
      const [i, j, fx, fy] = cellOf(x, y);
      const k = j * n + i;
      if (fx + fy <= 1) {
        out.gx = (h[k + 1] - h[k]) / TCELL;
        out.gy = (h[k + n] - h[k]) / TCELL;
      } else {
        out.gx = (h[k + n + 1] - h[k + n]) / TCELL;
        out.gy = (h[k + n + 1] - h[k + 1]) / TCELL;
      }
      return out;
    };
    const land = { n, cell: TCELL, h, at, slope, kind: t.kind || 'grass' };
    lands.set(t, land);
    return land;
  }

  // ---------- static solids ----------
  function box(b, kind) {
    return {
      type: BOX, kind: b.kind || kind || 'stone',
      x0: Math.min(b.x0, b.x1), x1: Math.max(b.x0, b.x1), y0: Math.min(b.y0, b.y1), y1: Math.max(b.y0, b.y1),
      z0: Math.min(b.z0, b.z1), z1: Math.max(b.z0, b.z1), src: b,
    };
  }
  function ramp(r) {
    const [axis, sign] = DIRS[r.dir] || DIRS['x+'];
    const s = {
      type: RAMP, kind: r.kind || 'stone', axis, sign,
      x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1), y0: Math.min(r.y0, r.y1), y1: Math.max(r.y0, r.y1),
      zl: r.z0, zh: r.z1, src: r,
    };
    s.z1 = Math.max(r.z0, r.z1);
    s.z0 = r.base !== undefined ? r.base : Math.min(r.z0, r.z1) - 40;
    const len = axis ? s.y1 - s.y0 : s.x1 - s.x0;
    s.grade = ((s.zh - s.zl) / (len || 1)) * sign; // rise per unit along +x (axis 0) or +y (axis 1)
    return s;
  }
  function cyl(c, extra) {
    // Posts thinner than a kart (pillars, a brazier's foot, a dead tree) are never something to
    // stand on: whatever comes down on top slides off them.
    return { type: CYL, kind: c.kind || 'stone', x: c.x, y: c.y, r: c.r, z0: Math.min(c.z0, c.z1), z1: Math.max(c.z0, c.z1), thin: c.r < 20, src: c, ...extra };
  }
  // A straight piece of road from a to b, w wide (kerbs and decks alike): its top runs from za to zb
  // along it and is banked (rise per unit across, towards the left of a -> b); it is `thick` deep.
  // `ext` lengthens it at both ends, along the same slope, so the pieces of a bend overlap.
  function seg(g) {
    const dx = g.bx - g.ax;
    const dy = g.by - g.ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const hw = g.w / 2;
    const ext = g.ext || 0;
    const s = {
      type: SEG, kind: g.kind || 'road', ax: g.ax, ay: g.ay, ux, uy, len, hw, u0: -ext, u1: len + ext,
      za: g.za, grade: (g.zb - g.za) / len, bank: g.bank || 0, thick: g.thick || 16, src: g,
    };
    // Its footprint's bounding box (for the lookup grid) and the range of heights it spans.
    const xs = [];
    const ys = [];
    const zs = [];
    for (const u of [s.u0, s.u1]) {
      for (const v of [-hw, hw]) {
        xs.push(s.ax + u * ux - v * uy);
        ys.push(s.ay + u * uy + v * ux);
        zs.push(s.za + s.grade * u + s.bank * v);
      }
    }
    s.x0 = Math.min(...xs); s.x1 = Math.max(...xs); s.y0 = Math.min(...ys); s.y1 = Math.max(...ys);
    s.z1 = Math.max(...zs);
    s.z0 = Math.min(...zs) - s.thick;
    return s;
  }
  // (x, y) in a seg's own frame: u along it from a, v across it (left positive).
  function segUV(s, x, y) {
    const dx = x - s.ax;
    const dy = y - s.ay;
    return [dx * s.ux + dy * s.uy, -dx * s.uy + dy * s.ux];
  }
  function contains(s, x, y) {
    if (s.type === CYL) return (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r * s.r;
    if (s.type === SEG) {
      const [u, v] = segUV(s, x, y);
      return u >= s.u0 && u <= s.u1 && v >= -s.hw && v <= s.hw;
    }
    return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
  }
  // Underside of a solid at (x, y): a seg's runs along it; everything else is flat underneath.
  function bottomAt(s, x, y) {
    return s.type === SEG ? topAt(s, x, y) - s.thick : s.z0;
  }
  function topAt(s, x, y) {
    if (s.type === SEG) {
      const [u, v] = segUV(s, x, y);
      return s.za + s.grade * u + s.bank * v;
    }
    if (s.type !== RAMP) return s.z1;
    const p = s.axis ? y : x;
    const lo = s.axis ? s.y0 : s.x0;
    const hi = s.axis ? s.y1 : s.x1;
    let u = clamp((p - lo) / (hi - lo || 1), 0, 1);
    if (s.sign < 0) u = 1 - u;
    return s.zl + (s.zh - s.zl) * u;
  }

  // ---------- raised roads ----------
  // A road follows a Catmull-Rom curve through its points, sampled every PIECE units along the
  // ground: each sample has a position, a height, a heading and a bank. Banking leans the road into
  // its bends (the outside of a bend higher), and fades out at both ends, where it meets the ground.
  const PIECE = 36;
  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  }
  function roadSamples(road, land) {
    const pts = road.points.map(([x, y, z]) => [x, y, z === null || z === undefined ? (land ? land.at(x, y) : 0) : z]);
    const ext = [pts[0], ...pts, pts[pts.length - 1]];
    const dense = [];
    for (let i = 1; i < ext.length - 2; i++) {
      for (let k = 0; k < 40; k++) dense.push(catmull(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], k / 40));
    }
    dense.push(pts[pts.length - 1]);
    // Resample evenly along the ground.
    const out = [];
    let acc = 0;
    let next = 0;
    for (let i = 0; i < dense.length; i++) {
      if (i > 0) acc += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
      while (acc >= next && i > 0) {
        const a = dense[i - 1];
        const b = dense[i];
        const seglen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const f = clamp(1 - (acc - next) / seglen, 0, 1);
        out.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f, s: next });
        next += PIECE;
      }
      if (i === 0) { out.push({ x: dense[0][0], y: dense[0][1], z: dense[0][2], s: 0 }); next = PIECE; }
    }
    const last = dense[dense.length - 1];
    if (Math.hypot(last[0] - out[out.length - 1].x, last[1] - out[out.length - 1].y) > PIECE * 0.3) out.push({ x: last[0], y: last[1], z: last[2], s: acc });
    // Headings, and the bank from how sharply the road turns.
    for (let i = 0; i < out.length; i++) {
      const a = out[Math.max(0, i - 1)];
      const b = out[Math.min(out.length - 1, i + 1)];
      const h = Math.atan2(b.y - a.y, b.x - a.x);
      out[i].ux = Math.cos(h);
      out[i].uy = Math.sin(h);
      out[i].h = h;
    }
    const n = out.length;
    const raw = out.map((o, i) => {
      if (i === 0 || i === n - 1) return 0;
      let dh = out[i + 1].h - out[i - 1].h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const curve = dh / (out[i + 1].s - out[i - 1].s || 1); // + turning left
      return clamp(-curve * (road.bank || 0), -0.2, 0.2);
    });
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = -3; k <= 3; k++) if (raw[i + k] !== undefined) { sum += raw[i + k]; cnt++; }
      out[i].bank = (sum / cnt) * smoothstep(0, 4, Math.min(i, n - 1 - i));
    }
    return out;
  }
  // The solids of a road: deck pieces, a kerb along each side, pillars under it where it's high.
  function roadSolids(road, land) {
    const samples = roadSamples(road, land);
    const w = road.w || 180;
    const thick = road.thick || 18;
    const curb = road.curb === false ? null : { w: 10, h: 13, ...(road.curb || {}) };
    const segs = [];
    const cyls = [];
    // Near its ends the deck runs too low to drive under (higher off the ground than a step, lower
    // than a kart): there it is solid down to the ground, an embankment, so nothing gets wedged
    // underneath. o.fill: how deep the deck goes there (0: its usual thickness).
    const across = [-w / 2, 0, w / 2];
    const groundAt = (o, v) => (land ? land.at(o.x - o.uy * v, o.y + o.ux * v) : 0);
    for (const o of samples) {
      const gap = Math.min(...across.map((v) => o.z + o.bank * v - thick - groundAt(o, v)));
      o.fill = gap < KART_H + 12 ? Math.max(...across.map((v) => o.z + o.bank * v - groundAt(o, v))) + 10 : 0;
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const bank = (a.bank + b.bank) / 2;
      let dh = b.h - a.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const ext = 2 + (w / 2) * Math.abs(dh); // enough overlap to close the outside of a bend
      const deep = Math.max(thick, a.fill, b.fill);
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, za: a.z, zb: b.z, w, bank, thick: deep, ext, kind: road.kind || 'road' });
      if (curb) {
        for (const side of [1, -1]) {
          const v = side * (w / 2 - curb.w / 2);
          const ox = -a.uy * v;
          const oy = a.ux * v;
          const ox2 = -b.uy * v;
          const oy2 = b.ux * v;
          segs.push({
            ax: a.x + ox, ay: a.y + oy, bx: b.x + ox2, by: b.y + oy2, za: a.z + bank * v + curb.h, zb: b.z + bank * v + curb.h,
            w: curb.w, bank, thick: deep + curb.h, ext: 1, kind: 'kerb',
          });
        }
      }
    }
    // Pillars down to the ground wherever there's room for a kart underneath.
    const pil = road.pillars;
    if (pil) {
      let nextAt = pil.every / 2;
      for (const o of samples) {
        if (o.s < nextAt) continue;
        const g = land ? land.at(o.x, o.y) : 0;
        if (o.z - thick - g < (pil.min || 60)) continue;
        if ((pil.avoid || []).some((a) => Math.hypot(o.x - a.x, o.y - a.y) < a.r)) continue; // (a lava pool)
        cyls.push({ x: o.x, y: o.y, r: pil.r || 24, z0: g - 30, z1: o.z - thick + 1, kind: pil.kind || 'pillar' });
        nextAt = o.s + pil.every;
      }
    }
    return { samples, segs, cyls, w, thick, curb, kind: road.kind || 'road' };
  }

  // The ground: one slab over the whole arena minus rectangular holes, cut into as few boxes as the
  // holes allow (a grid on every hole edge, rows merged, then equal rows merged downwards).
  function groundBlocks(def) {
    const g = def.ground;
    if (!g) return [];
    const S = def.size;
    const z = g.z || 0;
    const depth = g.depth || 60;
    const holes = (g.holes || []).map((h) => ({ x0: Math.min(h.x0, h.x1), x1: Math.max(h.x0, h.x1), y0: Math.min(h.y0, h.y1), y1: Math.max(h.y0, h.y1) }));
    const cuts = (k0, k1) => [...new Set([0, S, ...holes.flatMap((h) => [clamp(h[k0], 0, S), clamp(h[k1], 0, S)])])].sort((a, b) => a - b);
    const xs = cuts('x0', 'x1');
    const ys = cuts('y0', 'y1');
    const rows = [];
    for (let j = 0; j < ys.length - 1; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      const runs = [];
      let start = null;
      for (let i = 0; i < xs.length - 1; i++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        const solid = !holes.some((h) => cx > h.x0 && cx < h.x1 && cy > h.y0 && cy < h.y1);
        if (solid && start === null) start = xs[i];
        if (!solid && start !== null) { runs.push([start, xs[i]]); start = null; }
      }
      if (start !== null) runs.push([start, S]);
      rows.push({ y0: ys[j], y1: ys[j + 1], runs });
    }
    const out = [];
    let open = []; // boxes still growing downwards: {x0, x1, y0, y1}
    for (const row of rows) {
      const next = [];
      for (const [x0, x1] of row.runs) {
        const b = open.find((o) => o.x0 === x0 && o.x1 === x1);
        if (b) { b.y1 = row.y1; next.push(b); } else next.push({ x0, x1, y0: row.y0, y1: row.y1 });
      }
      for (const o of open) if (!next.includes(o)) out.push(o);
      open = next;
    }
    out.push(...open);
    return out.map((b) => ({ ...b, z0: z - depth, z1: z, kind: g.kind || 'ground' }));
  }

  // ---------- moving obstacles ----------
  // Every mover is a pure function of the game clock, so the server, your kart's prediction and the
  // renderer all agree on where it is without sending it over the network.
  //   sweeper    {x, y, z, len, w, lo, hi, arms, speed, phase}  arms turning round a hub on the floor at z
  //   slider     {x0, y0, x1, y1, z0, z1, dx, dy, period, phase}  a block gliding to (dx, dy) and back
  //   pendulum   {x, y, z, len, r, axis, amp, period, phase}  a ball swinging under a pivot at z
  //   drawbridge {x0, y0, x1, y1, z, thick, hinge, period, at, move, hold, max, phase}
  //              a deck that tips up about its `hinge` side ('x0', 'x1', 'y0', 'y1') at `at` seconds
  //              into each period, stays up `hold` seconds and comes back down
  function makeMover(m, i) {
    const base = { ...m, i };
    if (m.type === 'sweeper') {
      return { len: 300, w: 12, lo: 5, hi: 21, arms: 2, speed: 1, phase: 0, hub: 34, ...base };
    }
    if (m.type === 'slider') {
      return { dx: 0, dy: 0, period: 6, phase: 0, ...base,
        x0: Math.min(m.x0, m.x1), x1: Math.max(m.x0, m.x1), y0: Math.min(m.y0, m.y1), y1: Math.max(m.y0, m.y1) };
    }
    if (m.type === 'pendulum') {
      return { len: 220, r: 34, axis: 'x', amp: 1.1, period: 3.2, phase: 0, ...base };
    }
    if (m.type === 'drawbridge') {
      return { thick: 14, hinge: 'x0', period: 30, at: 18, move: 1.6, hold: 6, max: 1.35, phase: 0, ...base,
        x0: Math.min(m.x0, m.x1), x1: Math.max(m.x0, m.x1), y0: Math.min(m.y0, m.y1), y1: Math.max(m.y0, m.y1) };
    }
    return null;
  }
  // Slider offset (0..1 of the way to dx, dy) and its rate of change.
  function sliderAt(m, t) {
    const w = TAU / m.period;
    const a = w * t + m.phase * TAU;
    return { u: 0.5 - 0.5 * Math.cos(a), du: 0.5 * w * Math.sin(a) };
  }
  function pendulumAt(m, t) {
    const w = TAU / m.period;
    const a = w * t + m.phase * TAU;
    const th = m.amp * Math.sin(a);
    const dth = m.amp * w * Math.cos(a);
    const [ax, ay] = m.axis === 'y' ? [0, 1] : [1, 0];
    const s = Math.sin(th);
    const c = Math.cos(th);
    return {
      x: m.x + ax * m.len * s, y: m.y + ay * m.len * s, z: m.z - m.len * c,
      vx: ax * m.len * c * dth, vy: ay * m.len * c * dth, vz: m.len * s * dth, th,
    };
  }
  // Drawbridge angle (0 = down, m.max = up) at time t, and seconds until it next starts to rise.
  function bridgeAt(m, t) {
    const P = m.period;
    const c = ((((t / P + m.phase) % 1) + 1) % 1) * P;
    let a = 0;
    if (c >= m.at && c < m.at + m.move) a = ease((c - m.at) / m.move);
    else if (c >= m.at + m.move && c < m.at + m.move + m.hold) a = 1;
    else if (c >= m.at + m.move + m.hold && c < m.at + 2 * m.move + m.hold) a = 1 - ease((c - m.at - m.move - m.hold) / m.move);
    const rise = c < m.at ? m.at - c : P - c + m.at; // until the next rise starts
    return { a: a * m.max, rise, down: a === 0 };
  }
  // A drawbridge deck tips about its hinge edge: [axis, sign, hinge coordinate, length].
  function bridgeFrame(m) {
    if (m.hinge === 'x0') return [0, 1, m.x0, m.x1 - m.x0];
    if (m.hinge === 'x1') return [0, -1, m.x1, m.x1 - m.x0];
    if (m.hinge === 'y0') return [1, 1, m.y0, m.y1 - m.y0];
    return [1, -1, m.y1, m.y1 - m.y0];
  }
  const MAX_BRIDGE_FLOOR = 0.5; // radians: steeper than this the deck is no floor any more

  // ---------- the arena ----------
  function makeLayeredArena(def) {
    const S = def.size;
    const solids = [];
    const land = makeTerrain(def); // rolling ground under everything (or none)
    for (const b of groundBlocks(def)) solids.push(box(b, 'ground'));
    for (const b of def.blocks || []) solids.push(box(b));
    for (const r of def.ramps || []) solids.push(ramp(r));
    for (const c of def.cyls || []) solids.push(cyl(c));
    const roads = (def.roads || []).map((r) => roadSolids(r, land));
    for (const r of roads) {
      for (const g of r.segs) solids.push(seg(g));
      for (const c of r.cyls) solids.push(cyl(c));
    }
    const bumpers = (def.bumpers || []).map((b, i) => ({ r: 30, h: 30, kick: 520, ...b, i }));
    for (const b of bumpers) solids.push(cyl({ x: b.x, y: b.y, r: b.r, z0: b.z - 10, z1: b.z + b.h, kind: 'bumper' }, { kick: b.kick, bumper: b.i }));
    const movers = (def.movers || []).map(makeMover).filter(Boolean);
    // A sweeper turns round a solid hub.
    for (const m of movers) if (m.type === 'sweeper') solids.push(cyl({ x: m.x, y: m.y, r: m.hub, z0: m.z - 10, z1: m.z + m.hi + 24, kind: 'hub' }));
    const bridges = movers.filter((m) => m.type === 'drawbridge');
    const solidMovers = movers.filter((m) => m.type !== 'drawbridge');
    const pads = (def.pads || []).map((p, i) => ({ r: 40, t: 1, ...p, i, tx: p.to[0], ty: p.to[1], tz: p.to[2] }));
    const hazards = (def.hazards || []).map((h) => ({ kind: 'lava', z: 0, ...h }));
    const liquid = def.liquid || null;
    const deathZ = def.deathZ !== undefined ? def.deathZ : -320;
    const edge = def.edge || 'wall';
    const onLand = (x, y) => land && x >= 0 && y >= 0 && x <= S && y <= S;
    const LAND = { kind: land ? land.kind : 'grass', land: true };

    // Lookup grid with one cell of margin round the arena.
    const GW = Math.ceil(S / CELL) + 2;
    const cellIndex = (x, y) => clamp(Math.floor(y / CELL) + 1, 0, GW - 1) * GW + clamp(Math.floor(x / CELL) + 1, 0, GW - 1);
    const grid = Array.from({ length: GW * GW }, () => []);
    for (const s of solids) {
      const [x0, y0, x1, y1] = s.type === CYL ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : [s.x0, s.y0, s.x1, s.y1];
      const c0 = clamp(Math.floor((x0 - REACH) / CELL) + 1, 0, GW - 1);
      const c1 = clamp(Math.floor((x1 + REACH) / CELL) + 1, 0, GW - 1);
      const r0 = clamp(Math.floor((y0 - REACH) / CELL) + 1, 0, GW - 1);
      const r1 = clamp(Math.floor((y1 + REACH) / CELL) + 1, 0, GW - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * GW + c].push(s);
    }
    const near = (x, y) => grid[cellIndex(x, y)];

    // Highest floor at (x, y) no higher than zMax: its height, and its slope in `out` (gx, gy: rise
    // per unit along x and y; s: what it is). -Infinity over the void. t = null: every drawbridge down.
    const scratch = { z: 0, gx: 0, gy: 0, s: null };
    function floorInfo(x, y, zMax, t = 0, out = scratch) {
      let best = -Infinity;
      let sol = null;
      for (const s of near(x, y)) {
        if (s.z1 < best || s.thin || !contains(s, x, y)) continue;
        const top = topAt(s, x, y);
        if (top <= zMax && top > best) { best = top; sol = s; }
      }
      out.gx = 0;
      out.gy = 0;
      if (sol && sol.type === RAMP) {
        if (sol.axis) out.gy = sol.grade; else out.gx = sol.grade;
      } else if (sol && sol.type === SEG) {
        out.gx = sol.grade * sol.ux - sol.bank * sol.uy;
        out.gy = sol.grade * sol.uy + sol.bank * sol.ux;
      }
      if (onLand(x, y)) {
        // The rolling ground is solid all the way down: a kart a little under it (a steep rise at
        // speed) is put back on top, never dropped through it.
        const top = land.at(x, y);
        if (top > best) { best = top; sol = LAND; land.slope(x, y, out); }
      }
      for (const m of bridges) {
        if (x < m.x0 || x > m.x1 || y < m.y0 || y > m.y1) continue;
        const a = t === null ? 0 : bridgeAt(m, t).a;
        if (a > MAX_BRIDGE_FLOOR) continue;
        const [axis, sign, h, len] = bridgeFrame(m);
        const d = ((axis ? y : x) - h) * sign; // horizontal distance from the hinge
        if (d > len * Math.cos(a)) continue;
        const top = m.z + d * Math.tan(a);
        if (top <= zMax && top > best) {
          best = top;
          sol = m;
          const g = Math.tan(a) * sign;
          out.gx = axis ? 0 : g;
          out.gy = axis ? g : 0;
        }
      }
      out.z = best;
      out.s = sol;
      return out;
    }
    const floorAt = (x, y, zMax, t) => floorInfo(x, y, zMax, t).z;

    // Is the point (x, y, z) inside something solid? (The camera keeps out of walls.)
    function inside(x, y, z) {
      if (onLand(x, y) && z < land.at(x, y) - 2) return true;
      for (const s of near(x, y)) {
        if (z <= s.z0 || z >= s.z1 || !contains(s, x, y)) continue;
        if (z < topAt(s, x, y) && z > bottomAt(s, x, y)) return true;
      }
      return false;
    }

    // Lowest underside above zFrom over (x, y) (Infinity: open sky).
    function ceilingAt(x, y, zFrom) {
      let best = Infinity;
      for (const s of near(x, y)) {
        if (s.z1 <= zFrom || !contains(s, x, y)) continue;
        const b = bottomAt(s, x, y);
        if (b >= zFrom && b < best) best = b;
      }
      return best;
    }

    // Static walls touching a circle of radius r at (x, y) for something standing at height z.
    // Calls hit(nx, ny, depth, s) for each (n: the way out); returns how many.
    function walls(x, y, z, r, hit) {
      let n = 0;
      for (const s of near(x, y)) {
        if (s.z0 >= z + KART_H || s.z1 <= z + STEP) continue; // over our heads, or low enough to drive onto
        let cx;
        let cy;
        let inside;
        if (s.type === CYL) {
          const dx = x - s.x;
          const dy = y - s.y;
          const d = Math.hypot(dx, dy);
          if (d >= s.r + r) continue;
          inside = d < s.r;
          const k = d > 1e-6 ? s.r / d : 0;
          cx = s.x + dx * k;
          cy = s.y + dy * k;
          if (d <= 1e-6) cx = s.x + s.r;
        } else if (s.type === SEG) {
          const [u, v] = segUV(s, x, y);
          const cu = clamp(u, s.u0, s.u1);
          const cv = clamp(v, -s.hw, s.hw);
          inside = cu === u && cv === v;
          if (!inside && (u - cu) ** 2 + (v - cv) ** 2 >= r * r) continue;
          cx = s.ax + cu * s.ux - cv * s.uy;
          cy = s.ay + cu * s.uy + cv * s.ux;
          // A road piece is a wall only where it stands between our wheels and our roof.
          const top = topAt(s, cx, cy);
          if (top <= z + STEP || top - s.thick >= z + KART_H) continue;
        } else {
          cx = clamp(x, s.x0, s.x1);
          cy = clamp(y, s.y0, s.y1);
          inside = cx === x && cy === y;
          if (!inside && (x - cx) ** 2 + (y - cy) ** 2 >= r * r) continue;
        }
        if (s.type === RAMP && topAt(s, cx, cy) <= z + STEP) continue;
        let nx;
        let ny;
        let depth;
        if (s.type === CYL) {
          const dx = x - s.x;
          const dy = y - s.y;
          const d = Math.hypot(dx, dy) || 1;
          nx = d > 1e-6 ? dx / d : 1;
          ny = d > 1e-6 ? dy / d : 0;
          depth = s.r + r - Math.hypot(dx, dy);
        } else if (inside && s.type === SEG) {
          // Deep inside a road piece: out through its nearest side.
          const [u, v] = segUV(s, x, y);
          const opts = [[u - s.u0, -1, 0], [s.u1 - u, 1, 0], [v + s.hw, 0, -1], [s.hw - v, 0, 1]];
          let best = opts[0];
          for (const o of opts) if (o[0] < best[0]) best = o;
          nx = best[1] * s.ux - best[2] * s.uy;
          ny = best[1] * s.uy + best[2] * s.ux;
          depth = best[0] + r;
        } else if (inside) {
          // Deep inside: out through the nearest side.
          const opts = [[x - s.x0, -1, 0], [s.x1 - x, 1, 0], [y - s.y0, 0, -1], [s.y1 - y, 0, 1]];
          let best = opts[0];
          for (const o of opts) if (o[0] < best[0]) best = o;
          nx = best[1];
          ny = best[2];
          depth = best[0] + r;
        } else {
          const d = Math.hypot(x - cx, y - cy);
          nx = (x - cx) / d;
          ny = (y - cy) / d;
          depth = r - d;
        }
        n++;
        if (hit) hit(nx, ny, depth, s);
      }
      return n;
    }

    // Push a kart out of everything solid at its height. Returns the contacts:
    // {nx, ny, kick, vx, vy, s} (n: away from the wall; kick: a bumper's shove; v: a mover's velocity).
    function collide(kart, t = 0, out = []) {
      out.length = 0;
      const z = Number.isFinite(kart.z) ? kart.z : 0;
      for (let pass = 0; pass < 2; pass++) {
        const before = out.length;
        walls(kart.x, kart.y, z, KART_R, (nx, ny, depth, s) => {
          kart.x += nx * depth;
          kart.y += ny * depth;
          out.push({ nx, ny, kick: s.kick || 0, vx: 0, vy: 0, s });
        });
        if (out.length === before) break;
      }
      for (const m of solidMovers) moverContact(m, kart, z, t, out);
      for (const m of bridges) bridgeWall(m, kart, z, t, out);
      if (edge === 'wall') {
        const lo = EDGE + KART_R;
        const hi = S - EDGE - KART_R;
        if (kart.x < lo) { kart.x = lo; out.push({ nx: 1, ny: 0, kick: 0, vx: 0, vy: 0, s: null }); }
        if (kart.x > hi) { kart.x = hi; out.push({ nx: -1, ny: 0, kick: 0, vx: 0, vy: 0, s: null }); }
        if (kart.y < lo) { kart.y = lo; out.push({ nx: 0, ny: 1, kick: 0, vx: 0, vy: 0, s: null }); }
        if (kart.y > hi) { kart.y = hi; out.push({ nx: 0, ny: -1, kick: 0, vx: 0, vy: 0, s: null }); }
      } else {
        // Nobody drives off into infinity: they fall long before reaching this.
        kart.x = clamp(kart.x, -2000, S + 2000);
        kart.y = clamp(kart.y, -2000, S + 2000);
      }
      return out;
    }

    // Is a kart-sized spot at (x, y) blocked for something at height z? (CPU drivers, the camera)
    function blocked(x, y, pad = 0, z = 0, t = 0) {
      if (edge === 'wall' && (x < EDGE || y < EDGE || x > S - EDGE || y > S - EDGE)) return true;
      if (walls(x, y, z, Math.max(1, pad), null) > 0) return true;
      const probe = { x, y, z };
      const out = [];
      for (const m of solidMovers) moverContact(m, probe, z, t, out, Math.max(1, pad));
      return out.length > 0;
    }

    function moverContact(m, kart, z, t, out, r = KART_R) {
      if (m.type === 'sweeper') {
        if (z >= m.z + m.hi || z + KART_H <= m.z + m.lo) return; // hopped over it (or far above / below)
        const a0 = m.phase + m.speed * t;
        for (let i = 0; i < m.arms; i++) {
          const a = a0 + (i * TAU) / m.arms;
          const ux = Math.cos(a);
          const uy = Math.sin(a);
          const along = clamp((kart.x - m.x) * ux + (kart.y - m.y) * uy, m.hub, m.len);
          const cx = m.x + ux * along;
          const cy = m.y + uy * along;
          const dx = kart.x - cx;
          const dy = kart.y - cy;
          const d = Math.hypot(dx, dy);
          if (d >= m.w + r) continue;
          const nx = d > 1e-6 ? dx / d : -uy;
          const ny = d > 1e-6 ? dy / d : ux;
          kart.x = cx + nx * (m.w + r);
          kart.y = cy + ny * (m.w + r);
          // The arm's own speed where it touched (it turns at `speed` rad/s).
          out.push({ nx, ny, kick: 0, vx: -uy * along * m.speed, vy: ux * along * m.speed, s: m, mover: true });
        }
      } else if (m.type === 'slider') {
        const { u, du } = sliderAt(m, t);
        const ox = m.dx * u;
        const oy = m.dy * u;
        if (m.z0 >= z + KART_H || m.z1 <= z + STEP) return;
        const x0 = m.x0 + ox; const x1 = m.x1 + ox; const y0 = m.y0 + oy; const y1 = m.y1 + oy;
        const cx = clamp(kart.x, x0, x1);
        const cy = clamp(kart.y, y0, y1);
        const inside = cx === kart.x && cy === kart.y;
        let nx;
        let ny;
        let depth;
        if (inside) {
          const opts = [[kart.x - x0, -1, 0], [x1 - kart.x, 1, 0], [kart.y - y0, 0, -1], [y1 - kart.y, 0, 1]];
          let best = opts[0];
          for (const o of opts) if (o[0] < best[0]) best = o;
          [depth, nx, ny] = [best[0] + r, best[1], best[2]];
        } else {
          const d = Math.hypot(kart.x - cx, kart.y - cy);
          if (d >= r) return;
          [nx, ny, depth] = [(kart.x - cx) / d, (kart.y - cy) / d, r - d];
        }
        kart.x += nx * depth;
        kart.y += ny * depth;
        out.push({ nx, ny, kick: 0, vx: m.dx * du, vy: m.dy * du, s: m, mover: true });
      } else if (m.type === 'pendulum') {
        const b = pendulumAt(m, t);
        const zc = clamp(b.z, z + 4, z + KART_H - 4); // nearest point of the kart's body to the ball
        const dz = zc - b.z;
        const reach = m.r + r;
        if (Math.abs(dz) >= reach) return;
        const flat = Math.sqrt(reach * reach - dz * dz);
        const dx = kart.x - b.x;
        const dy = kart.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d >= flat) return;
        const nx = d > 1e-6 ? dx / d : 1;
        const ny = d > 1e-6 ? dy / d : 0;
        kart.x = b.x + nx * flat;
        kart.y = b.y + ny * flat;
        out.push({ nx, ny, kick: 0, vx: b.vx, vy: b.vy, s: m, mover: true });
      }
    }

    // A raised drawbridge stands across the gate: a wall over its footprint while it is up.
    function bridgeWall(m, kart, z, t, out) {
      const { a } = bridgeAt(m, t);
      if (a <= MAX_BRIDGE_FLOOR) return;
      const [axis, sign, h, len] = bridgeFrame(m);
      const reachH = len * Math.cos(a) + m.thick * Math.sin(a);
      const top = m.z + len * Math.sin(a);
      if (m.z - m.thick >= z + KART_H || top <= z + STEP) return;
      // The raised deck's footprint: from the hinge out to reachH, across the full width.
      const lo = sign > 0 ? h : h - reachH;
      const hi = sign > 0 ? h + reachH : h;
      const [x0, x1, y0, y1] = axis ? [m.x0, m.x1, lo, hi] : [lo, hi, m.y0, m.y1];
      const cx = clamp(kart.x, x0, x1);
      const cy = clamp(kart.y, y0, y1);
      const d = Math.hypot(kart.x - cx, kart.y - cy);
      let nx;
      let ny;
      let depth;
      if (d < 1e-6) {
        // Still on the deck as it swings up: it scoops you back through the gate (the hinge side).
        const p = axis ? kart.y : kart.x;
        depth = (p - h) * sign + KART_R;
        nx = axis ? 0 : -sign;
        ny = axis ? -sign : 0;
      } else {
        if (d >= KART_R) return;
        nx = (kart.x - cx) / d;
        ny = (kart.y - cy) / d;
        depth = KART_R - d;
      }
      kart.x += nx * depth;
      kart.y += ny * depth;
      out.push({ nx, ny, kick: 0, vx: 0, vy: 0, s: m, mover: true });
    }

    // Deadly ground or liquid for a kart at (x, y, z): 'lava' | 'water' | 'void' | null.
    function hazardAt(x, y, z) {
      if (z < deathZ) return 'void';
      if (liquid && z < liquid.z - 2) return liquid.kind || 'water';
      for (const h of hazards) {
        if (Math.abs(z - h.z) > 6) continue;
        if (h.r !== undefined ? (x - h.x) ** 2 + (y - h.y) ** 2 < (h.r - 6) ** 2
          : x > h.x0 + 6 && x < h.x1 - 6 && y > h.y0 + 6 && y < h.y1 - 6) return h.kind;
      }
      return null;
    }

    function padAt(x, y, z) {
      for (const p of pads) {
        if (Math.abs(z - p.z) <= 8 && (x - p.x) ** 2 + (y - p.y) ** 2 < p.r * p.r) return p;
      }
      return null;
    }

    // The highest floor at (x, y) (scenery, the minimap, anything without a height of its own).
    const heightAt = (x, y) => {
      const z = floorAt(x, y, Infinity, 0);
      return Number.isFinite(z) ? z : (liquid ? liquid.z : deathZ);
    };

    const itemBoxes = (def.boxes || []).map((b) => ({ x: b.x, y: b.y, z: b.z || 0 }));
    const spawns = (def.spawns || []).map((s) => ({ x: s.x, y: s.y, z: s.z || 0, angle: s.angle || 0 }));
    const boostPads = (def.boosts || []).map((b) => ({ x: b.x, y: b.y, z: b.z || 0, angle: b.angle || 0 }));

    const map = {
      ...def, type: 'arena', layered: true, size: S, edge, deathZ, liquid,
      center: [S / 2, S / 2], bounds: { minX: 0, minY: 0, maxX: S, maxY: S },
      solids, movers, bumpers, pads, hazards, itemBoxes, spawns, boostPads, roads,
      obstacles: [], // the flat arenas' round obstacles (none here: everything is a solid)
      land, floorInfo, floorAt, ceilingAt, walls, collide, blocked, hazardAt, padAt, heightAt, inside,
      sliderAt, pendulumAt, bridgeAt, bridgeFrame,
    };
    let nav = null;
    Object.defineProperty(map, 'nav', { get() { return nav || (nav = buildNav(map)); } });
    return map;
  }

  // ---------- navigation ----------
  // A grid of standing spots: every NAV-sized cell has a node for each floor in it a kart fits on,
  // clear of walls and hazards. Edges join neighbouring nodes a kart can drive between (both ways),
  // drop down from (one way) or fly to (jump pads). Movers are left out: drivers dodge them live.
  // Drawbridge decks are tagged so drivers can check the timetable.
  const DRIVE = 0;
  const DROP = 1;
  const FLY = 2;
  // A binary min-heap of [key, id] pairs in a plain array (A* and Dijkstra over the nav grid).
  function heapPush(heap, f, id) {
    heap.push([f, id]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }
  function heapPop(heap) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  }

  function buildNav(map) {
    const S = map.size;
    const N = Math.ceil(S / NAV);
    const xs = [];
    const ys = [];
    const zs = [];
    const bridgeOf = [];
    const cellNodes = new Array(N * N);
    const bridges = map.movers.filter((m) => m.type === 'drawbridge');
    const tops = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) * NAV;
        const y = (j + 0.5) * NAV;
        tops.length = 0;
        for (const s of map.solids) if (!s.thin && contains(s, x, y)) tops.push([topAt(s, x, y), -1]);
        if (map.land) tops.push([map.land.at(x, y), -1]);
        for (const m of bridges) if (x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1) tops.push([m.z, m.i]);
        tops.sort((a, b) => a[0] - b[0]);
        const list = [];
        for (let k = 0; k < tops.length; k++) {
          const [z, b] = tops[k];
          if (k + 1 < tops.length && tops[k + 1][0] - z < 1) continue; // the same floor twice (seams)
          if (map.ceilingAt(x, y, z + 0.5) - z < KART_H) continue; // no headroom
          if (map.hazardAt(x, y, z)) continue;
          const f = map.floorInfo(x, y, z + 0.5, 0, {});
          if (Math.hypot(f.gx, f.gy) > NAV_SLOPE) continue; // a crater wall, a cliff
          if (map.walls(x, y, z, KART_R - 2, null) > 0) continue;
          const id = xs.length;
          xs.push(x); ys.push(y); zs.push(z); bridgeOf.push(b);
          list.push(id);
        }
        if (list.length) cellNodes[j * N + i] = list;
      }
    }
    const count = xs.length;
    const adj = Array.from({ length: count }, () => []);
    // Spots worth avoiding unless they're the way: jump pads (you'd be flown off somewhere) and the
    // reach of sweeper arms and pendulums. Driving into them costs extra.
    const cost = new Float32Array(count).fill(1);
    const padOf = new Int16Array(count).fill(-1);
    const lo = EDGE + KART_R + 22;
    const hi = S - lo;
    for (let id = 0; id < count; id++) {
      // Hugging a wall costs a little: paths go through the middle of doorways and wide of corners
      // and pillars, where a kart (which never quite follows the line) doesn't scrape them.
      const x = xs[id];
      const y = ys[id];
      const rim = map.edge === 'wall' && (x < lo || y < lo || x > hi || y > hi);
      if (map.walls(x, y, zs[id], KART_R + 10, null) > 0) cost[id] = 1.35;
      else if (rim || map.walls(x, y, zs[id], KART_R + 22, null) > 0) cost[id] = 1.12;
      // Steep ground pulls a kart sideways: keep to the gentle slopes unless it's the way.
      const f = map.floorInfo(x, y, zs[id] + 0.5, 0, {});
      const steep = Math.hypot(f.gx, f.gy);
      if (steep > 0.45) cost[id] *= 1 + (steep - 0.45) * 6;
      for (const p of map.pads) {
        if (Math.abs(zs[id] - p.z) <= 8 && (xs[id] - p.x) ** 2 + (ys[id] - p.y) ** 2 < (p.r + KART_R) ** 2) { cost[id] = 4; padOf[id] = p.i; }
      }
      for (const m of map.movers) {
        if (m.type === 'sweeper' && Math.abs(zs[id] - m.z) < 20 && (xs[id] - m.x) ** 2 + (ys[id] - m.y) ** 2 < (m.len + 30) ** 2) cost[id] = Math.max(cost[id], 3);
        if (m.type === 'pendulum') {
          const reach = m.len * Math.sin(m.amp) + m.r + KART_R;
          const along = m.axis === 'y' ? Math.abs(ys[id] - m.y) : Math.abs(xs[id] - m.x);
          const across = m.axis === 'y' ? Math.abs(xs[id] - m.x) : Math.abs(ys[id] - m.y);
          if (along < reach && across < m.r + KART_R + 10 && zs[id] < m.z && zs[id] > m.z - m.len - m.r - 10) cost[id] = Math.max(cost[id], 3);
        }
      }
    }
    // Drive from node a towards (bx, by), following the floor: DRIVE, DROP (went down a ledge) or -1.
    const walk = (a, bx, by, bz) => {
      const ax = xs[a];
      const ay = ys[a];
      let z = zs[a];
      const d = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(2, Math.ceil(d / 8));
      const stepLen = d / steps;
      let dropped = false;
      let airZ = z; // just off a ledge the kart is still up in the air, clear of the side it fell from
      let air = 0;
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const x = ax + (bx - ax) * u;
        const y = ay + (by - ay) * u;
        const f = map.floorAt(x, y, z + STEP, null);
        if (!Number.isFinite(f) || map.hazardAt(x, y, f)) return -1;
        if (f < z - STEP) { dropped = true; airZ = z; air = KART_R * 2; }
        z = f;
        const wz = air > 0 ? airZ : z;
        air -= stepLen;
        if (map.walls(x, y, wz, KART_R - 4, null) > 0) return -1;
      }
      if (Math.abs(z - bz) > 2) return -1;
      if (dropped) {
        // Coming off a ledge the kart carries on a way after it lands: that must be safe ground too.
        const ux = (bx - ax) / (d || 1);
        const uy = (by - ay) / (d || 1);
        for (const run of [40, 80]) {
          const f = map.floorAt(bx + ux * run, by + uy * run, z + STEP, null);
          if (!Number.isFinite(f) || map.hazardAt(bx + ux * run, by + uy * run, f)) return -1;
        }
      }
      return dropped ? DROP : DRIVE;
    };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const here = cellNodes[j * N + i];
        if (!here) continue;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
            const there = cellNodes[jj * N + ii];
            if (!there) continue;
            for (const a of here) {
              for (const b of there) {
                const kind = walk(a, xs[b], ys[b], zs[b]);
                if (kind < 0) continue;
                const len = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]) * cost[b];
                adj[a].push([b, kind === DROP ? len * 1.15 : len, kind]);
              }
            }
          }
        }
      }
    }
    const nodeAt = (x, y, z, radius = 2) => {
      const i0 = Math.floor(x / NAV);
      const j0 = Math.floor(y / NAV);
      let best = -1;
      let bestScore = Infinity;
      for (let r = 0; r <= radius && best < 0; r++) {
        for (let j = j0 - r; j <= j0 + r; j++) {
          for (let i = i0 - r; i <= i0 + r; i++) {
            if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || i < 0 || j < 0 || i >= N || j >= N) continue;
            for (const id of cellNodes[j * N + i] || []) {
              if (zs[id] > z + STEP + 2) continue; // a floor above us
              const score = Math.hypot(xs[id] - x, ys[id] - y) + (z - zs[id]) * 2;
              if (score < bestScore) { bestScore = score; best = id; }
            }
          }
        }
      }
      return best;
    };
    // Jump pads: every node on the pad flies to the node where it lands.
    for (const p of map.pads) {
      const to = nodeAt(p.tx, p.ty, p.tz + 1, 3);
      if (to < 0) continue;
      for (let j = Math.floor((p.y - p.r) / NAV); j <= Math.floor((p.y + p.r) / NAV); j++) {
        for (let i = Math.floor((p.x - p.r) / NAV); i <= Math.floor((p.x + p.r) / NAV); i++) {
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          for (const a of cellNodes[j * N + i] || []) {
            if (Math.abs(zs[a] - p.z) > 8 || (xs[a] - p.x) ** 2 + (ys[a] - p.y) ** 2 > p.r * p.r) continue;
            adj[a].push([to, p.t * 500, FLY, p.i]);
          }
        }
      }
    }

    // A* over the graph. `avoid(edge, node)` may veto an edge (closed drawbridges). Returns node ids.
    function path(from, to, avoid) {
      if (from < 0 || to < 0) return null;
      if (from === to) return [from];
      const g = new Float64Array(count).fill(Infinity);
      const prev = new Int32Array(count).fill(-1);
      const closed = new Uint8Array(count);
      const heap = [];
      const h = (id) => Math.hypot(xs[id] - xs[to], ys[id] - ys[to]);
      g[from] = 0;
      heapPush(heap, h(from), from);
      while (heap.length) {
        const [, id] = heapPop(heap);
        if (closed[id]) continue;
        if (id === to) break;
        closed[id] = 1;
        for (const e of adj[id]) {
          const [b, cost] = e;
          if (closed[b] || (avoid && avoid(e, b))) continue;
          const ng = g[id] + cost;
          if (ng < g[b]) { g[b] = ng; prev[b] = id; heapPush(heap, ng + h(b), b); }
        }
      }
      if (prev[to] < 0) return null;
      const out = [to];
      for (let id = to; prev[id] >= 0; id = prev[id]) out.push(prev[id]);
      return out.reverse();
    }

    // The edges turned round: back[b] lists [a, cost] for every edge a -> b.
    let back = null;
    const backEdges = () => {
      if (!back) {
        back = Array.from({ length: count }, () => []);
        for (let a = 0; a < count; a++) for (const [b, c] of adj[a]) back[b].push([a, c]);
      }
      return back;
    };

    // Every node reachable from `from` (following edges forwards, or backwards with `reverse`).
    function reach(from, reverse = false) {
      const seen = new Uint8Array(count);
      const edges = reverse ? backEdges() : adj;
      const stack = [from];
      seen[from] = 1;
      while (stack.length) {
        const id = stack.pop();
        for (const e of edges[id]) {
          const b = e[0];
          if (!seen[b]) { seen[b] = 1; stack.push(b); }
        }
      }
      return seen;
    }

    // How far it is to drive from every node to `to` (Dijkstra over the edges backwards), kept for
    // each target. CPU drivers rank item boxes by it: as the crow flies is a poor guide on a map
    // of walls, stairs and jump pads.
    const fields = new Map();
    function toward(to) {
      if (to < 0) return null;
      let dist = fields.get(to);
      if (dist) return dist;
      const edges = backEdges();
      dist = new Float64Array(count).fill(Infinity);
      const heap = [];
      dist[to] = 0;
      heapPush(heap, 0, to);
      while (heap.length) {
        const [d, id] = heapPop(heap);
        if (d > dist[id]) continue;
        for (const [a, c] of edges[id]) {
          if (d + c < dist[a]) { dist[a] = d + c; heapPush(heap, d + c, a); }
        }
      }
      fields.set(to, dist);
      return dist;
    }

    return { cell: NAV, n: N, count, xs, ys, zs, bridgeOf, padOf, cost, adj, cellNodes, nodeAt, path, reach, toward, DRIVE, DROP, FLY };
  }

  // ---------- symmetry helpers for map data ----------
  // A quarter turn (clockwise on screen, y pointing down) of a piece of map data about the middle
  // of a size-S arena: rectangles, points, ramp directions, drawbridge hinges, headings, pad
  // targets, pendulum axes and slider offsets all turn with it.
  const DIR_TURN = { 'x+': 'y+', 'y+': 'x-', 'x-': 'y-', 'y-': 'x+' };
  const HINGE_TURN = { y1: 'x0', x0: 'y0', y0: 'x1', x1: 'y1' };
  function turn(o, S, times = 1) {
    let r = o;
    for (let i = 0; i < times; i++) {
      const q = { ...r };
      if (r.x0 !== undefined) { q.x0 = S - r.y1; q.x1 = S - r.y0; q.y0 = r.x0; q.y1 = r.x1; }
      if (r.x !== undefined) { q.x = S - r.y; q.y = r.x; }
      if (r.to) q.to = [S - r.to[1], r.to[0], r.to[2]];
      if (r.dir) q.dir = DIR_TURN[r.dir];
      if (r.hinge) q.hinge = HINGE_TURN[r.hinge];
      if (r.angle !== undefined) q.angle = r.angle + Math.PI / 2;
      if (r.axis) q.axis = r.axis === 'x' ? 'y' : 'x';
      if (r.dx !== undefined || r.dy !== undefined) { q.dx = -(r.dy || 0); q.dy = r.dx || 0; }
      r = q;
    }
    return r;
  }
  // Every list in `part` four times (a quarter turn apart) or twice (half a turn apart), merged into `into`.
  function symmetric(into, part, S, turns = [0, 1, 2, 3]) {
    for (const [key, list] of Object.entries(part)) {
      into[key] = into[key] || [];
      for (const k of turns) for (const o of list) into[key].push(turn(o, S, k));
    }
    return into;
  }

  // ---------- the arenas ----------
  // The Keep: a castle on an island in a moat. Siege camp all round the outside; four gates whose
  // drawbridges rise in turn (north and south together, then east and west), each gate passage
  // running under the wall walk; ramps up onto the walls; flying bridges from every gate over the
  // courtyard to the keep's roof, with its hall underneath; corner towers you reach by jump pad;
  // siege pads that fly you over the moat onto the walls; quintains and bumpers in the courtyard.
  function theKeep() {
    const S = 3200;
    const WALK = 100;
    const ROOF = 100;
    const TOWER = 170;
    const def = {
      id: 'keep', name: 'The Keep', emoji: '🏰', theme: 'keep', size: S,
      blurb: 'Storm the castle: drawbridges, wall walks, tower perches and a moat.',
      edge: 'wall', deathZ: -320, liquid: { kind: 'water', z: -46 },
      ground: { z: 0, depth: 60, kind: 'grass', holes: [{ x0: 560, y0: 560, x1: 2640, y1: 2640 }] },
      blocks: [{ x0: 760, y0: 760, x1: 2440, y1: 2440, z0: -60, z1: 0, kind: 'courtyard' }],
      deco: [{ kind: 'crown', x: S / 2, y: S / 2, z: ROOF }],
    };
    // The north side; the other three are the same, turned.
    // Battlements: a parapet a kart can't climb (nor slip through), merlons standing on it.
    const merlons = [{ x0: 960, y0: 760, x1: 2240, y1: 776, z0: WALK, z1: WALK + 13, kind: 'merlon' }];
    for (let x = 975; x + 30 <= 2225; x += 60) merlons.push({ x0: x, y0: 760, x1: x + 30, y1: 782, z0: WALK, z1: WALK + 28, kind: 'merlon' });
    // The tower top's rim: crenellated all round the moat side, open towards the courtyard.
    const TX = 820;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const off = Math.abs(((a - Math.PI / 4 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (off < 0.95) continue; // the open side, facing the middle of the castle
      const cx = TX + Math.cos(a) * 124;
      const cy = TX + Math.sin(a) * 124;
      const h = i % 2 ? 26 : 14;
      merlons.push({ x0: cx - 13, y0: cy - 13, x1: cx + 13, y1: cy + 13, z0: TOWER, z1: TOWER + h, kind: 'merlon' });
    }
    symmetric(def, {
      blocks: [
        // Curtain wall either side of the gate, and the wall walk over the gate passage.
        { x0: 760, y0: 760, x1: 1510, y1: 880, z0: -60, z1: WALK, kind: 'wall' },
        { x0: 1690, y0: 760, x1: 2440, y1: 880, z0: -60, z1: WALK, kind: 'wall' },
        { x0: 1510, y0: 760, x1: 1690, y1: 880, z0: 58, z1: WALK, kind: 'gate' },
        ...merlons,
        // A flying bridge from over the gate to the keep's roof (the courtyard road runs underneath).
        { x0: 1545, y0: 880, x1: 1655, y1: 1400, z0: 82, z1: ROOF, kind: 'bridge' },
        // The keep: its north wall either side of the door, and a quarter of its roof.
        { x0: 1400, y0: 1400, x1: 1530, y1: 1430, z0: -60, z1: 76, kind: 'keep' },
        { x0: 1670, y0: 1400, x1: 1800, y1: 1430, z0: -60, z1: 76, kind: 'keep' },
        { x0: 1400, y0: 1400, x1: 1600, y1: 1600, z0: 76, z1: ROOF, kind: 'roof' },
        // The siege camp: tents and crates to hide behind.
        { x0: 880, y0: 230, x1: 1040, y1: 330, z0: 0, z1: 56, kind: 'tent' },
        { x0: 2300, y0: 380, x1: 2380, y1: 460, z0: 0, z1: 46, kind: 'crate' },
        { x0: 1240, y0: 110, x1: 1320, y1: 190, z0: 0, z1: 46, kind: 'crate' },
      ],
      ramps: [{ x0: 1000, y0: 880, x1: 1400, y1: 990, z0: 0, z1: WALK, dir: 'x+', base: -20, kind: 'stair' }],
      cyls: [{ x: 820, y: 820, r: 140, z0: -60, z1: TOWER, kind: 'tower' }],
      pads: [
        { x: 960, y: 1080, z: 0, r: 40, to: [840, 840, TOWER], t: 1 }, // up the tower
        { x: 2150, y: 300, z: 0, r: 44, to: [2150, 822, WALK], t: 1 }, // over the moat onto the wall
      ],
      boosts: [{ x: 1250, y: 300, z: 0, angle: 0 }, { x: 1100, y: 822, z: WALK, angle: 0 }],
      boxes: [
        { x: 1300, y: 420, z: 0 }, { x: 1900, y: 420, z: 0 }, // siege camp
        { x: 1250, y: 822, z: WALK }, { x: 800, y: 800, z: TOWER }, // wall walk, tower top
        { x: 1320, y: 1320, z: 0 }, { x: 1520, y: 1520, z: 0 }, { x: 1600, y: 1490, z: ROOF }, // courtyard, hall, roof
      ],
      spawns: [
        { x: 720, y: 300, z: 0, angle: 0 }, { x: 2000, y: 200, z: 0, angle: Math.PI },
        { x: 1400, y: 1050, z: 0, angle: Math.PI / 2 }, { x: 1600, y: 1480, z: 0, angle: Math.PI / 2 },
        { x: 1950, y: 822, z: WALK, angle: Math.PI },
      ],
    }, S);
    // Spawns: one more per side in the siege camp's corners.
    symmetric(def, { spawns: [{ x: 300, y: 300, z: 0, angle: Math.PI / 4 }] }, S);
    // Drawbridges: north and south rise together, then east and west, half a cycle later.
    const bridge = { type: 'drawbridge', x0: 1510, y0: 560, x1: 1690, y1: 760, z: 0, thick: 14, hinge: 'y1', period: 40, at: 26, move: 1.8, hold: 8, max: 1.3 };
    def.movers = [0, 1, 2, 3].map((k) => ({ ...turn(bridge, S, k), phase: (k % 2) * 0.5 }));
    // Quintains (north-east, south-west) and bumper clusters (north-west, south-east): half-turn symmetry.
    symmetric(def, {
      movers: [{ type: 'sweeper', x: 2010, y: 1190, z: 0, len: 140, w: 12, lo: 5, hi: 21, arms: 2, speed: 1.15, phase: 0, hub: 30 }],
      bumpers: [{ x: 1170, y: 1190, z: 0, r: 30 }, { x: 1260, y: 1215, z: 0, r: 30 }, { x: 1195, y: 1280, z: 0, r: 30 }],
    }, S, [0, 2]);
    def.cyls.push({ x: S / 2, y: S / 2, r: 34, z0: -60, z1: 76, kind: 'pillar' }); // holds up the keep's roof
    return def;
  }

  // The Graveyard: rolling hills under the moon, a crypt in the middle of a paved plaza. The crypt's
  // hall has four doors, a gallery round the inside up two flights of stairs, a scythe turning in the
  // atrium and bells swinging over the galleries; its roof has skylights you can drop through and
  // four jump pads fly you up onto it. Out on the hills: rows of headstones, fenced plots with open
  // graves full of acid, dead trees and pumpkin bumpers.
  function theGraveyard() {
    const S = 3200;
    const C = S / 2;
    const GAL = 84; // the gallery's floor
    const ROOF = 168;
    const plaza = { x: C, y: C, r: 760, z: 0, soft: 0.72 };
    const base = { seed: 13, amp: 58, scale: 640, base: 0, edge: 320, kind: 'grass' };
    // The fenced plots are levelled at whatever height the hills have there.
    const plots = [0, 1, 2, 3].map((k) => turn({ x: 600, y: 1000 }, S, k));
    const pre = makeTerrain({ size: S, terrain: { ...base, flats: [plaza] } });
    const def = {
      id: 'graveyard', name: 'The Graveyard', emoji: '🪦', theme: 'graveyard', size: S,
      blurb: 'Hills of headstones, acid graves and a two-storey crypt with a scythe in it.',
      edge: 'wall', deathZ: -320,
      terrain: { ...base, flats: [plaza, ...plots.map((p) => ({ x: p.x, y: p.y, r: 230, z: Math.round(pre.at(p.x, p.y)), soft: 0.75 }))] },
      blocks: [], ramps: [], cyls: [], pads: [], bumpers: [], boosts: [], hazards: [], boxes: [], spawns: [], movers: [],
      deco: [],
    };
    const land = makeTerrain(def);
    const hAt = (x, y) => land.at(x, y);
    // The crypt: the north and west halves, and the same again half a turn round.
    symmetric(def, {
      blocks: [
        { x0: 1120, y0: 1240, x1: 1530, y1: 1280, z0: -40, z1: 150, kind: 'crypt' },
        { x0: 1670, y0: 1240, x1: 2080, y1: 1280, z0: -40, z1: 150, kind: 'crypt' },
        { x0: 1530, y0: 1240, x1: 1670, y1: 1280, z0: 60, z1: 150, kind: 'crypt' }, // over the north door
        { x0: 1120, y0: 1280, x1: 1160, y1: 1530, z0: -40, z1: 150, kind: 'crypt' },
        { x0: 1120, y0: 1670, x1: 1160, y1: 1920, z0: -40, z1: 150, kind: 'crypt' },
        { x0: 1120, y0: 1530, x1: 1160, y1: 1670, z0: 60, z1: 150, kind: 'crypt' }, // over the west door
        // The gallery: along the north wall and down the west side, on pillars.
        { x0: 1160, y0: 1280, x1: 2040, y1: 1380, z0: 66, z1: GAL, kind: 'gallery' },
        { x0: 1160, y0: 1380, x1: 1260, y1: 1820, z0: 66, z1: GAL, kind: 'gallery' },
        // The roof, with three skylights over the atrium.
        { x0: 1120, y0: 1240, x1: 2080, y1: 1530, z0: 150, z1: ROOF, kind: 'slate' },
        { x0: 1120, y0: 1530, x1: 1310, y1: 1600, z0: 150, z1: ROOF, kind: 'slate' },
        { x0: 1450, y0: 1530, x1: 1530, y1: 1600, z0: 150, z1: ROOF, kind: 'slate' },
        { x0: 1670, y0: 1530, x1: 1750, y1: 1600, z0: 150, z1: ROOF, kind: 'slate' },
        { x0: 1890, y0: 1530, x1: 2080, y1: 1600, z0: 150, z1: ROOF, kind: 'slate' },
      ],
      ramps: [{ x0: 1300, y0: 1380, x1: 1620, y1: 1460, z0: 0, z1: GAL, dir: 'x+', base: -20, kind: 'stair' }],
      cyls: [
        { x: 1260, y: 1380, r: 16, z0: -40, z1: 66, kind: 'pillar' }, { x: 1940, y: 1380, r: 16, z0: -40, z1: 66, kind: 'pillar' },
        { x: 1800, y: 1380, r: 16, z0: -40, z1: 66, kind: 'pillar' },
      ],
      pads: [
        { x: 1380, y: 1040, z: 0, r: 40, to: [1380, 1330, ROOF], t: 1 }, // up onto the roof, from the north
        { x: 960, y: 1820, z: 0, r: 40, to: [1240, 1820, ROOF], t: 1 }, // and from the west
      ],
      movers: [{ type: 'pendulum', x: 1210, y: 1600, z: 150, len: 52, r: 18, axis: 'y', amp: 0.85, period: 2.6, phase: 0 }],
      boxes: [
        { x: 1330, y: 1600, z: 0 }, { x: 1450, y: 1330, z: GAL }, { x: 1600, y: 1380, z: ROOF }, { x: 1215, y: 1565, z: ROOF },
      ],
      spawns: [
        { x: 1600, y: 1330, z: 0, angle: Math.PI / 2 }, { x: 1850, y: 1330, z: GAL, angle: Math.PI },
        { x: 1210, y: 1460, z: GAL, angle: Math.PI / 2 }, { x: 1330, y: 1710, z: 0, angle: 0 },
      ],
      deco: [
        { kind: 'lantern', x: 1490, y: 1225, z: 110 }, { kind: 'lantern', x: 1710, y: 1225, z: 110 }, { kind: 'brazier', x: 1648, y: 1420, z: 0 }, // in the lee of the stair's top
        { kind: 'arch', x: 1600, y: 1233, z: 0, w: 140, h: 52, angle: 0 }, { kind: 'arch', x: 1113, y: 1600, z: 0, w: 140, h: 52, angle: Math.PI / 2 },
      ],
    }, S, [0, 2]);
    // The braziers' stone feet are solid.
    for (const d of def.deco) if (d.kind === 'brazier') def.cyls.push({ x: d.x, y: d.y, r: 16, z0: -40, z1: 46, kind: 'pillar' });
    def.movers.push({ type: 'sweeper', x: C, y: C, z: 0, len: 130, w: 10, lo: 6, hi: 22, arms: 2, speed: 1.3, phase: 0, hub: 26 });
    // The hills: one corner's worth of graves, turned to all four corners and set on the ground.
    const corner = { blocks: [], cyls: [], bumpers: [], boosts: [], hazards: [], boxes: [], spawns: [], deco: [] };
    // A fenced plot with two open graves (and their headstones), its gate facing the crypt.
    const P = { x: 600, y: 1000 };
    const fence = (x0, y0, x1, y1) => corner.blocks.push({ x0, y0, x1, y1, kind: 'fence' });
    fence(P.x - 150, P.y - 110, P.x + 150, P.y - 102); // north side
    fence(P.x - 150, P.y + 102, P.x + 150, P.y + 110); // south side
    fence(P.x - 150, P.y - 110, P.x - 142, P.y + 110); // west side
    fence(P.x + 142, P.y - 110, P.x + 150, P.y - 50); // east side, either side of the gate
    fence(P.x + 142, P.y + 50, P.x + 150, P.y + 110);
    for (const dx of [-60, 60]) {
      corner.hazards.push({ x0: P.x + dx - 26, y0: P.y - 34, x1: P.x + dx + 26, y1: P.y + 62, kind: 'acid' });
      corner.blocks.push({ x0: P.x + dx - 22, y0: P.y - 62, x1: P.x + dx + 22, y1: P.y - 48, kind: 'tomb' });
    }
    // Rows of headstones (a couple missing), to weave between.
    for (const [x, y] of [[860, 470], [950, 470], [1040, 470], [1130, 470], [860, 560], [1040, 560], [1130, 560], [860, 650], [950, 650], [1040, 650]]) {
      corner.blocks.push({ x0: x - 17, y0: y - 7, x1: x + 17, y1: y + 7, kind: 'tomb' });
    }
    corner.cyls.push({ x: 300, y: 640, r: 18, kind: 'deadtree' }, { x: 760, y: 300, r: 18, kind: 'deadtree' });
    corner.bumpers.push({ x: 1000, y: 880, r: 30 }, { x: 880, y: 1000, r: 30 });
    corner.boosts.push({ x: 520, y: 520, angle: Math.PI / 4 });
    corner.boxes.push({ x: 330, y: 900 }, { x: 900, y: 330 }, { x: 950, y: 560 }); // the last in the headstones' gap
    corner.spawns.push({ x: 300, y: 300, angle: Math.PI / 4 }, { x: 1220, y: 300, angle: Math.PI / 2 });
    corner.deco.push({ kind: 'lantern', x: P.x + 160, y: P.y - 60 }, { kind: 'lantern', x: P.x + 160, y: P.y + 60 });
    // The plaza round the crypt.
    corner.spawns.push({ x: 1600, y: 1060, angle: Math.PI / 2 }, { x: 1120, y: 1120, angle: Math.PI / 4 });
    corner.boxes.push({ x: 1800, y: 980 });
    const placed = symmetric({}, corner, S);
    // Everything out there stands on the hills.
    for (const b of placed.blocks) {
      const lo = Math.min(hAt(b.x0, b.y0), hAt(b.x1, b.y0), hAt(b.x0, b.y1), hAt(b.x1, b.y1));
      const hi = Math.max(hAt(b.x0, b.y0), hAt(b.x1, b.y0), hAt(b.x0, b.y1), hAt(b.x1, b.y1));
      def.blocks.push({ ...b, z0: lo - 24, z1: hi + (b.kind === 'fence' ? 42 : b.kind === 'tomb' ? (b.x1 - b.x0 > 40 || b.y1 - b.y0 > 40 ? 52 : 40) : 40) });
    }
    for (const c of placed.cyls) def.cyls.push({ ...c, z0: hAt(c.x, c.y) - 24, z1: hAt(c.x, c.y) + 150 });
    for (const b of placed.bumpers) def.bumpers.push({ ...b, z: hAt(b.x, b.y) });
    for (const b of placed.boosts) def.boosts.push({ ...b, z: hAt(b.x, b.y) });
    for (const h of placed.hazards) def.hazards.push({ ...h, z: hAt((h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2) });
    for (const b of placed.boxes) def.boxes.push({ ...b, z: hAt(b.x, b.y) });
    for (const p of placed.spawns) def.spawns.push({ ...p, z: hAt(p.x, p.y) });
    for (const d of placed.deco) def.deco.push({ ...d, z: d.z ?? hAt(d.x, d.y) });
    // The fences on each plot's levelled ground lie flat: no need for anything else.
    return def;
  }

  // The Cinder Bowl: a green bowl of rolling hills ringed by jagged cliffs, a lava crater in the
  // middle and a banked viaduct sweeping over it in an S, on pillars, under arches at both ends.
  // Four raised plateaus to fight on, tyre stacks round the crater's lip to bounce off, pines and
  // boulders on the hills, and two jump pads that throw you up onto the top of the bridge.
  function theCinderBowl() {
    const S = 3400;
    const C = S / 2;
    const CREST = 236; // the viaduct's highest point, over the lava
    const PLATEAU = 34;
    const plateaus = [0, 1, 2, 3].map((k) => {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      return { x: Math.round(C + Math.cos(a) * 800), y: Math.round(C + Math.sin(a) * 800), r: 220, z: PLATEAU, soft: 0.66 };
    });
    const def = {
      id: 'cinder', name: 'The Cinder Bowl', emoji: '🌋', theme: 'cinder', size: S,
      blurb: 'Hills round a lava crater, a banked viaduct over it and cliffs all round.',
      edge: 'wall', deathZ: -320, liquid: { kind: 'lava', z: -50 },
      terrain: {
        seed: 29, amp: 50, scale: 620, base: 0, kind: 'grass', style: 'lowpoly', flats: plateaus,
        bowl: { x: C, y: C, r: 1170, height: 150, width: 300, max: 760, jag: 0.35 },
        craters: [{ x: C, y: C, r: 440, z: -120, lip: 26, floor: 0.55 }],
      },
      roads: [{
        // An S over the crater: up from the hills in the south-west, over the lava, down to the north-east.
        points: [[C - 1010, C + 400, null], [C - 760, C + 140, 76], [C - 420, C - 110, 182], [C, C, CREST], [C + 420, C + 110, 182], [C + 760, C - 140, 76], [C + 1010, C - 400, null]],
        w: 190, thick: 18, bank: 70, curb: { w: 10, h: 13 }, pillars: { every: 300, r: 26, min: 60, avoid: [{ x: C, y: C, r: 440 }] }, kind: 'viaduct',
      }],
      blocks: [], ramps: [], cyls: [], pads: [], bumpers: [], boosts: [], hazards: [], boxes: [], spawns: [], movers: [], deco: [],
    };
    const land = makeTerrain(def);
    const g = (x, y) => land.at(x, y);
    const road = roadSolids(def.roads[0], land);
    const along = road.samples;
    const onRoad = (x, y, pad) => along.some((o) => Math.hypot(o.x - x, o.y - y) < road.w / 2 + pad);
    const at = (frac) => along[Math.round(frac * (along.length - 1))];
    // The deck's height at (x, y): its highest piece there (the pieces of a bend overlap a little).
    const deck = road.segs.filter((r) => r.kind !== 'kerb').map(seg);
    const deckZ = (x, y) => Math.max(...deck.filter((r) => contains(r, x, y)).map((r) => topAt(r, x, y)));
    // Arches over both ends of the viaduct: a pillar either side, a neon banner across.
    for (const o of [along[1], along[along.length - 2]]) {
      for (const side of [1, -1]) {
        const x = o.x - o.uy * side * (road.w / 2 + 34);
        const y = o.y + o.ux * side * (road.w / 2 + 34);
        def.cyls.push({ x: Math.round(x), y: Math.round(y), r: 22, z0: g(x, y) - 30, z1: g(x, y) + 210, kind: 'archpost' });
      }
      def.deco.push({ kind: 'gate', x: o.x, y: o.y, z: g(o.x, o.y), angle: o.h, w: road.w + 68, h: 200 });
    }
    // Tyre stacks round the crater's lip (clear of the viaduct), bouncy to hit.
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + 0.31;
      const x = C + Math.cos(a) * 560;
      const y = C + Math.sin(a) * 560;
      if (onRoad(x, y, 90)) continue;
      def.bumpers.push({ x: Math.round(x), y: Math.round(y), z: g(x, y), r: 30, h: 34, kick: 360, style: 'tyres' });
    }
    // Two jump pads up onto the crest, from the ground either side of the bridge.
    const crest = at(0.5);
    for (const side of [1, -1]) {
      const x = C - crest.uy * side * 600;
      const y = C + crest.ux * side * 600;
      const tx = Math.round(crest.x - crest.uy * side * 30);
      const ty = Math.round(crest.y + crest.ux * side * 30);
      def.pads.push({ x: Math.round(x), y: Math.round(y), z: g(x, y), r: 42, to: [tx, ty, deckZ(tx, ty)], t: 1.3 });
    }
    // Item boxes: on the bridge (the crest and halfway up each side), on the plateaus, round the
    // crater's lip and out on the hills.
    for (const f of [0.5, 0.3, 0.7]) {
      const o = at(f);
      const x = Math.round(o.x);
      const y = Math.round(o.y);
      def.boxes.push({ x, y, z: deckZ(x, y) });
    }
    for (const p of plateaus) {
      for (const d of [-70, 70]) def.boxes.push({ x: p.x + d, y: p.y - d, z: PLATEAU });
    }
    const ring = (n, r, phase, pad) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + phase;
        const x = Math.round(C + Math.cos(a) * r);
        const y = Math.round(C + Math.sin(a) * r);
        if (!onRoad(x, y, pad)) out.push([x, y, a]);
      }
      return out;
    };
    for (const [x, y] of ring(8, 500, 0, 70)) def.boxes.push({ x, y, z: g(x, y) });
    for (const [x, y] of ring(8, 1040, Math.PI / 8, 80)) def.boxes.push({ x, y, z: g(x, y) });
    // Spawns: two rings on the hills (and the plateaus), facing the crater.
    for (const [x, y, a] of [...ring(14, 950, 0.12, 110), ...ring(14, 700, 0.34, 110)]) def.spawns.push({ x, y, z: g(x, y), angle: a + Math.PI });
    // Pines and boulders out on the hills, where they're out of everything's way.
    const taken = [...def.spawns, ...def.boxes, ...def.pads, ...def.bumpers, ...def.cyls, ...plateaus];
    const free = (x, y, room) => !onRoad(x, y, 70) && taken.every((o) => Math.hypot(o.x - x, o.y - y) > room + (o.r || 0));
    for (let i = 0; i < 400 && def.deco.filter((d) => d.kind === 'pine').length < 46; i++) {
      const a = hash2(i, 1, 77) * Math.PI * 2;
      const r = 640 + hash2(i, 2, 77) * 640;
      const x = Math.round(C + Math.cos(a) * r);
      const y = Math.round(C + Math.sin(a) * r);
      if (!free(x, y, 120) || land.at(x, y) > 160) continue;
      const big = hash2(i, 3, 77);
      def.cyls.push({ x, y, r: 13, z0: g(x, y) - 20, z1: g(x, y) + 120, kind: 'trunk' });
      def.deco.push({ kind: 'pine', x, y, z: g(x, y), s: 0.85 + big * 0.6, seed: i });
      taken.push({ x, y, r: 40 });
    }
    for (let i = 0; i < 300 && def.deco.filter((d) => d.kind === 'boulder').length < 12; i++) {
      const a = hash2(i, 4, 78) * Math.PI * 2;
      const r = 620 + hash2(i, 5, 78) * 520;
      const x = Math.round(C + Math.cos(a) * r);
      const y = Math.round(C + Math.sin(a) * r);
      if (!free(x, y, 110)) continue;
      const size = 30 + hash2(i, 6, 78) * 22;
      def.cyls.push({ x, y, r: Math.round(size), z0: g(x, y) - 20, z1: g(x, y) + size * 1.1, kind: 'boulder' });
      def.deco.push({ kind: 'boulder', x, y, z: g(x, y), s: size, seed: i });
      taken.push({ x, y, r: size + 40 });
    }
    // Rocks strewn up the cliffs (scenery only: nobody drives up there).
    for (let i = 0; i < 70; i++) {
      const a = hash2(i, 7, 79) * Math.PI * 2;
      const r = 1250 + hash2(i, 8, 79) * 500;
      const x = C + Math.cos(a) * r;
      const y = C + Math.sin(a) * r;
      if (x < 60 || y < 60 || x > S - 60 || y > S - 60) continue;
      const slope = land.slope(x, y, {});
      if (Math.hypot(slope.gx, slope.gy) > 1.1) continue; // nothing perches on a sheer face
      def.deco.push({ kind: 'rock', x: Math.round(x), y: Math.round(y), z: g(x, y) - 8, s: 30 + hash2(i, 9, 79) * 60, seed: i });
    }
    return def;
  }

  // Harbour Havoc: a container port at sunset. To the south the yard, with a stepped pyramid of
  // containers in the middle (ramps along its north and south faces up to the first tier, and up
  // again from there to the summit), container rows either side with forklifts working the alleys
  // between them, and a parapet along the sea. To the north three finger piers run out over two
  // water slips: bollards along their edges (with gaps a kart fits through), double bascule bridges
  // across both slips that lift in turn, a railless gangway joining the piers' far ends, jump pads
  // that fly you from the outer piers' tips over the water onto the middle one, and a gantry crane
  // over the middle pier swinging a container low enough to hit you.
  function theHarbour() {
    const S = 2800;
    const C = S / 2;
    const TIER = 80; // a container's height: the pyramid's first tier, the rows' tops
    const SUMMIT = 2 * TIER;
    const PIERS = 1500; // where the piers meet the yard
    const def = {
      id: 'harbour', name: 'Harbour Havoc', emoji: '⚓', theme: 'harbour', size: S, look: 'bright',
      blurb: 'A container pyramid, lifting bridges, a swinging crane load and a lot of water.',
      edge: 'wall', deathZ: -320, liquid: { kind: 'water', z: -40 },
      ground: {
        z: 0, depth: 90, kind: 'quay',
        holes: [
          { x0: 0, y0: 0, x1: 180, y1: S }, { x0: S - 180, y0: 0, x1: S, y1: S },
          { x0: 180, y0: S - 180, x1: S - 180, y1: S }, { x0: 180, y0: 0, x1: S - 180, y1: PIERS },
        ],
      },
      blocks: [
        // The piers (timber decks over the water) and the gangway across their far ends.
        { x0: 180, y0: 380, x1: 640, y1: PIERS, z0: -90, z1: 0, kind: 'wharf' },
        { x0: 1120, y0: 260, x1: 1680, y1: PIERS, z0: -90, z1: 0, kind: 'wharf' },
        { x0: 2160, y0: 380, x1: 2620, y1: PIERS, z0: -90, z1: 0, kind: 'wharf' },
        { x0: 640, y0: 420, x1: 1120, y1: 500, z0: -12, z1: 0, kind: 'gangway' },
        { x0: 1680, y0: 420, x1: 2160, y1: 500, z0: -12, z1: 0, kind: 'gangway' },
        // The parapet along the yard's three sea sides.
        { x0: 180, y0: PIERS, x1: 204, y1: S - 180, z0: -90, z1: 30, kind: 'parapet' },
        { x0: S - 204, y0: PIERS, x1: S - 180, y1: S - 180, z0: -90, z1: 30, kind: 'parapet' },
        { x0: 204, y0: S - 204, x1: S - 204, y1: S - 180, z0: -90, z1: 30, kind: 'parapet' },
      ],
      ramps: [], cyls: [], pads: [], bumpers: [], boosts: [], hazards: [], boxes: [], spawns: [], movers: [], deco: [],
      // What everything looks like (kart3d/bright3d.js; the minimap uses the tops).
      palette: {
        quay: { top: '#c9cdd5', side: '#9399a5', top2: '#b9bec8', pattern: 'tiles', cell: 160, round: 0 },
        wharf: { top: '#cf945c', side: '#7d593a', top2: '#9f6b3f', pattern: 'planks', cell: 26, angle: 1, round: 3 },
        gangway: { top: '#6e778a', side: '#3d4352', top2: '#454c5c', pattern: 'grate', cell: 16, round: 2 },
        parapet: { top: '#ffd23f', side: '#cbbca3', top2: '#2b2d33', pattern: 'hazard', cell: 46, round: 5 },
        bollard: { top: '#ffd23f', side: '#30343f', round: 0 },
        craneleg: { top: '#ffcf33', side: '#ffcf33', side2: '#2b2d33', sidePattern: 'bands', sideCell: 64, foot: 0.85 },
        steel: { top: '#f5b43a', side: '#9a6c26', top2: '#d4861a', pattern: 'chevrons', cell: 44, round: 0 },
        ctr: { pattern: 'planks', cell: 13, angle: 0, sidePattern: 'ribs', sideCell: 12, round: 3, foot: 0.6, roof: false },
        ctrColours: { red: '#e5484d', blue: '#2f6fd6', teal: '#14a3a0', orange: '#f28a2e', purple: '#7a52d6', green: '#3fae5a', yellow: '#f2c230' },
        rim: ['#ffffff', '#e5484d'],
        hazardRim: ['#ffd23f', '#2b2d33'],
        water: { shallow: '#2fc8d6', deep: '#0e5f8e', line: '#d2fbff' },
      },
      paint: [
        // Dashed yellow centre lines down both roads and the piers; zebra crossings where the piers
        // meet the yard; a ring and cross on the summit.
        { type: 'line', from: [230, 1590], to: [S - 230, 1590], z: 0, w: 9, color: '#ffd23f', dash: 60, gap: 50 },
        { type: 'line', from: [230, 2510], to: [S - 230, 2510], z: 0, w: 9, color: '#ffd23f', dash: 60, gap: 50 },
        { type: 'line', from: [410, 520], to: [410, PIERS - 20], z: 0, w: 8, color: '#ffffff', dash: 50, gap: 50 },
        { type: 'line', from: [S - 410, 520], to: [S - 410, PIERS - 20], z: 0, w: 8, color: '#ffffff', dash: 50, gap: 50 },
        { type: 'line', from: [C, 300], to: [C, PIERS - 20], z: 0, w: 8, color: '#ffffff', dash: 50, gap: 50 },
        { type: 'zebra', x0: 220, y0: PIERS + 12, x1: 620, y1: PIERS + 58, z: 0, color: '#ffffff', along: 'x' },
        { type: 'zebra', x0: 1140, y0: PIERS + 12, x1: 1660, y1: PIERS + 58, z: 0, color: '#ffffff', along: 'x' },
        { type: 'zebra', x0: S - 620, y0: PIERS + 12, x1: S - 220, y1: PIERS + 58, z: 0, color: '#ffffff', along: 'x' },
        { type: 'circle', x: C, y: 2050, r: 74, z: 160, w: 9, color: '#ffffff' },
        { type: 'line', from: [C - 40, 2010], to: [C + 40, 2090], z: 160, w: 10, color: '#ffffff' },
        { type: 'line', from: [C - 40, 2090], to: [C + 40, 2010], z: 160, w: 10, color: '#ffffff' },
      ],
    };
    const COLOURS = ['red', 'blue', 'teal', 'orange', 'purple', 'green', 'yellow'];
    let paint = 0;
    const container = (x0, y0, x1, y1, z0, z1) => def.blocks.push({ x0, y0, x1, y1, z0, z1, kind: `ctr-${COLOURS[paint++ % COLOURS.length]}` });
    // The pyramid: a first tier of containers four long and five deep, two more on top.
    for (let j = 0; j < 5; j++) for (let i = 0; i < 4; i++) container(900 + i * 250, 1800 + j * 100, 1150 + i * 250, 1900 + j * 100, -2, TIER);
    container(1250, 1950, 1550, 2050, TIER - 2, SUMMIT);
    container(1250, 2050, 1550, 2150, TIER - 2, SUMMIT);
    // Ramps along its north and south faces (from either end towards the middle), and up from the
    // first tier to the summit at its west and east ends.
    def.ramps.push(
      { x0: 1050, y0: 1700, x1: 1350, y1: 1800, z0: 0, z1: TIER, dir: 'x+', base: -2, kind: 'steel' },
      { x0: 1450, y0: 1700, x1: 1750, y1: 1800, z0: 0, z1: TIER, dir: 'x-', base: -2, kind: 'steel' },
      { x0: 1050, y0: 2300, x1: 1350, y1: 2400, z0: 0, z1: TIER, dir: 'x+', base: -2, kind: 'steel' },
      { x0: 1450, y0: 2300, x1: 1750, y1: 2400, z0: 0, z1: TIER, dir: 'x-', base: -2, kind: 'steel' },
      { x0: 990, y0: 2000, x1: 1250, y1: 2100, z0: TIER, z1: SUMMIT, dir: 'x+', base: TIER - 2, kind: 'steel' },
      { x0: 1550, y0: 2000, x1: 1810, y1: 2100, z0: TIER, z1: SUMMIT, dir: 'x-', base: TIER - 2, kind: 'steel' },
    );
    // Container rows either side (mirrored), two lanes and an alley each side of the pyramid.
    for (const flip of [false, true]) {
      const X = (x) => (flip ? S - x : x);
      const row = (x0, x1, y0, n) => { for (let k = 0; k < n; k++) container(X(x0), y0 + k * 240, X(x1), y0 + (k + 1) * 240, -2, TIER); };
      row(420, 520, 1780, 2);
      row(660, 760, 1860, 2);
      // A forklift working the alley between the two rows.
      def.movers.push({ type: 'slider', x0: X(545), y0: 1840, x1: X(635), y1: 1930, z0: 0, z1: 46, dx: 0, dy: 330, period: 9, phase: flip ? 0.5 : 0, kind: 'forklift' });
    }
    // Bascule bridges over both slips: two leaves each, hinged at the piers; the west pair lifts,
    // then the east pair half a cycle later.
    for (const [xa, xb, phase] of [[640, 1120, 0], [1680, 2160, 0.5]]) {
      const mid = (xa + xb) / 2;
      const leaf = { type: 'drawbridge', y0: 980, y1: 1140, z: 0, thick: 14, period: 34, at: 14, move: 2, hold: 7, max: 1.25, phase, kind: 'bascule' };
      def.movers.push({ ...leaf, x0: xa, x1: mid, hinge: 'x0' }, { ...leaf, x0: mid, x1: xb, hinge: 'x1' });
    }
    // The gantry crane over the middle pier: four legs, and a container swinging north-south under
    // it, its ends reaching down to kart height at the bottom of each swing (three swinging balls
    // in a row make its hit box).
    for (const x of [1152, 1648]) for (const y of [640, 920]) def.cyls.push({ x, y, r: 24, z0: -20, z1: 390, kind: 'craneleg' });
    for (const dx of [-50, 0, 50]) def.movers.push({ type: 'pendulum', x: C + dx, y: 780, z: 292, len: 254, r: 34, axis: 'y', amp: 0.8, period: 4.4, phase: 0, group: 'crane', kind: 'cargo' });
    def.deco.push({ kind: 'crane', x: C, y: 780, z: 0, x0: 1152, x1: 1648, y0: 640, y1: 920, top: 390, pivot: 292 });
    // Bollards along the piers' edges and the yard's open edges by the slips, with gaps you can
    // slip through (and into the water): every 120 along the outer edges, every 160 by the slips.
    const bollard = (x, y) => def.cyls.push({ x: Math.round(x), y: Math.round(y), r: 12, z0: -10, z1: 26, kind: 'bollard' });
    const clear = (y, gaps) => gaps.every(([a, b]) => y < a || y > b);
    for (let y = 440; y <= 1460; y += 120) { bollard(196, y); bollard(S - 196, y); }
    for (let y = 560; y <= 1460; y += 160) {
      if (!clear(y, [[930, 1190]])) continue; // the bascule bridges land there
      for (const x of [624, 1136, 1664, 2176]) if (x < 1100 || x > 1700 || clear(y, [[600, 960]])) bollard(x, y);
    }
    for (const x0 of [660, 1700]) for (let x = x0; x <= x0 + 440; x += 110) bollard(x, PIERS + 14);
    for (let x = 240; x <= 600; x += 120) { bollard(x, 396); bollard(S - x, 396); }
    for (let x = 1160; x <= 1640; x += 120) bollard(x, 276);
    // Fender tyres (bouncy) at the piers' far ends.
    for (const [x, y] of [[300, 430], [2500, 430], [1220, 300], [1580, 300]]) def.bumpers.push({ x, y, z: 0, r: 30, h: 34, kick: 380, style: 'tyres' });
    // Jump pads: from the outer piers' tips over the slips onto the middle pier, and from the yard
    // roads (north and south) up onto the summit.
    def.pads.push(
      { x: 410, y: 600, z: 0, r: 42, to: [1330, 420, 0], t: 1.35 },
      { x: S - 410, y: 600, z: 0, r: 42, to: [S - 1330, 420, 0], t: 1.35 },
      { x: 1240, y: 1600, z: 0, r: 42, to: [1330, 2000, SUMMIT], t: 1.25 },
      { x: S - 1240, y: 2500, z: 0, r: 42, to: [S - 1330, 2100, SUMMIT], t: 1.25 },
    );
    def.boosts.push(
      { x: 410, y: 1300, z: 0, angle: -Math.PI / 2 }, { x: S - 410, y: 1300, z: 0, angle: -Math.PI / 2 },
      { x: C, y: 1260, z: 0, angle: -Math.PI / 2 },
      { x: 860, y: 1600, z: 0, angle: 0 }, { x: S - 860, y: 1600, z: 0, angle: Math.PI },
    );
    def.boxes.push(
      { x: 1340, y: 2050, z: SUMMIT }, { x: 1460, y: 2050, z: SUMMIT }, // the summit
      { x: 1000, y: 1880, z: TIER }, { x: 1800, y: 1880, z: TIER }, { x: 1000, y: 2220, z: TIER }, { x: 1800, y: 2220, z: TIER },
      { x: 880, y: 460, z: 0 }, { x: 1920, y: 460, z: 0 }, // out on the gangways
      { x: 1310, y: 780, z: 0 }, { x: 1490, y: 780, z: 0 }, // under the crane
      { x: 410, y: 760, z: 0 }, { x: 410, y: 1180, z: 0 }, { x: S - 410, y: 760, z: 0 }, { x: S - 410, y: 1180, z: 0 },
      { x: C, y: 360, z: 0 },
      { x: 590, y: 1790, z: 0 }, { x: S - 590, y: 1790, z: 0 }, { x: 830, y: 1980, z: 0 }, { x: S - 830, y: 1980, z: 0 },
      { x: C, y: 1580, z: 0 }, { x: C, y: 2500, z: 0 },
    );
    const spawn = (x, y, z, angle) => def.spawns.push({ x, y, z, angle });
    for (const x of [300, 820, 1980, 2500]) spawn(x, 1610, 0, Math.PI / 2);
    for (const x of [300, 760, 1000, 1800, 2040, 2500]) spawn(x, 2500, 0, -Math.PI / 2);
    for (const y of [1900, 2200]) { spawn(310, y, 0, 0); spawn(S - 310, y, 0, Math.PI); }
    for (const y of [880, 1340]) { spawn(410, y, 0, Math.PI / 2); spawn(S - 410, y, 0, Math.PI / 2); }
    spawn(1290, 1220, 0, Math.PI / 2); spawn(1510, 1220, 0, Math.PI / 2);
    spawn(1250, 560, 0, Math.PI / 2); spawn(1550, 560, 0, Math.PI / 2);
    spawn(1060, 1960, TIER, 0); spawn(1740, 2140, TIER, Math.PI);
    // The world round it: a lighthouse on a rock, a cargo ship moored off the east side, lamps.
    def.deco.push({ kind: 'lighthouse', x: 2520, y: 120, z: -40 }, { kind: 'ship', x: 3200, y: 900, z: -40, len: 1500, angle: Math.PI / 2 });
    for (const [x, y] of [[300, 1520], [S - 300, 1520], [300, 2580], [S - 300, 2580], [C - 300, 2580], [C + 300, 2580], [300, 1200], [S - 300, 1200]]) def.deco.push({ kind: 'lamp', x, y, z: 0 });
    return def;
  }

  const ARENAS = [theHarbour(), theCinderBowl(), theKeep(), theGraveyard()]; // in the lobby's order

  return {
    KART_R, KART_H, STEP, NAV, NAV_SLOPE, EDGE, ARENAS, makeLayeredArena, makeTerrain, groundBlocks, turn, symmetric, roadSolids, SEG,
  };
});
