// Maps and kart physics shared by the server (authoritative simulation)
// and the browser (prediction for your own kart + rendering).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KartCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const KART_RADIUS = 16;
  const WALL_PAD = 160; // race tracks: hard wall this far outside the asphalt
  const CURB = 18; // painted curb outside the asphalt; still counts as road
  const RUNOFF = 60; // sand/gravel strip after the curb: a light speed cap
  const RAIL = 36; // bridges and railed roads: the wall is the guard rail, this far outside the asphalt
  // Bridge decks and railed roads are solid out to here: the kart's centre stops at RAIL, its wheels
  // (18 either side) just touch the parapet's inner face at RAIL + 18, and the parapet is 12 thick.
  const DECK = RAIL + 30;
  const SPACING = 32; // world units between centerline samples
  const CREST_TOL = 45; // units/s²: how much faster than gravity the road must drop away to take off

  const PHYS = {
    accel: 500,
    brake: 820,
    reverseMax: -170,
    maxSpeed: 430,
    boostSpeed: 680,
    offTrackMax: 250, // grass
    runoffMax: 370,
    offTrackDecel: 420, // how fast you bleed speed down to the surface cap
    drag: 1.3,
    turnRate: 2.9,
    driftMinSpeed: 220,
    driftLevels: [0.7, 1.5], // seconds of drifting for blue / orange sparks
    miniTurbo: [0.55, 1.0], // boost seconds for each level
    padBoost: 0.8,
    gravity: 1500,
    rampLift: 520, // vertical launch speed off a ramp at full speed
    airSteer: 0.4, // steering left in the air
    slopePull: 620, // gravity along the road: uphill slows you, downhill speeds you up
    slopeTop: 0.9, // top speed change per unit of grade
    trickTime: 0.5, // length of the flip animation
    trickWindow: 0.2, // seconds after take-off that a held drift still counts as a trick
    trickBoost: 0.7, // boost seconds for landing a trick
    fallTime: 1.5, // seconds in the water/lava before you are fished back out
    hopVz: 290, // a tap of the drift button on the ground: ~0.39 s in the air, ~28 units up
    hopCooldown: 0.4,
    knockDecay: 5.5, // 1/s: how fast a shove from another kart dies away
  };

  // Item codes on the wire are index + 1. New items are only ever appended.
  const ITEMS = ['boost', 'rocket', 'banana', 'shield', 'triple', 'mine', 'minigun', 'bomb', 'shock', 'ghost',
    'bouncer', 'comet', 'star', 'ink', 'thunder'];

  // Item timings and the speed changes items cause. The server and the browser's
  // prediction both scale stepKart's `opts.speed` with itemSpeed(), so they agree.
  const ITEM_FX = {
    roulette: 1.1, // seconds the item roulette spins before the item can be used
    starTime: 6, starSpeed: 1.2,
    shrinkTime: 3, shrinkSpeed: 0.7, // thunder victims (race)
    inkTime: 4,
  };
  const itemSpeed = (star, shrunk) => (star ? ITEM_FX.starSpeed : 1) * (shrunk ? ITEM_FX.shrinkSpeed : 1);
  // Deadly ground on race tracks (gap codes are indexes into this list).
  const HAZARDS = [null, 'lava', 'water', 'void'];

  function driftLevel(t) {
    if (t >= PHYS.driftLevels[1]) return 2;
    if (t >= PHYS.driftLevels[0]) return 1;
    return 0;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // ---------- noise (deterministic, so the server and every browser build the same hills) ----------
  function hash2(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
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

  // Distance from (x, y) to an open polyline, with the nearest segment and how far along it.
  function polyDist(x, y, pts) {
    let best = Infinity;
    let bi = 0;
    let bt = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const sx = b[0] - a[0];
      const sy = b[1] - a[1];
      const len2 = sx * sx + sy * sy || 1;
      const t = clamp(((x - a[0]) * sx + (y - a[1]) * sy) / len2, 0, 1);
      const d = (a[0] + sx * t - x) ** 2 + (a[1] + sy * t - y) ** 2;
      if (d < best) { best = d; bi = i; bt = t; }
    }
    return { d: Math.sqrt(best), i: bi, t: bt };
  }

  // ---------- natural terrain ----------
  // A map's landscape before the road is cut into it: gentle noise plus hand-placed features.
  //   hill   {x, y, r, h, plateau?, jag?}  mound or (plateau) flat-topped mesa
  //   ridge  {pts: [[x, y, h]], w}         mountain chain along a line
  //   trench {pts: [[x, y]], w, depth | level, floor?}  valley, canyon or river bed
  //   slope  {x, y, nx, ny, from, to, h}   the whole land tilting along a direction (coastlines)
  //   flat   {x, y, r, level}              levelled ground (sea floor, town square)
  //   cone   {x, y, r, h, crater?}         volcano
  //   rim    {pad, w, h}                   mountains all around the edge of the map
  function makeNatural(t, bounds, extra) {
    const feats = (t.features || []).concat(extra || []);
    const seed = t.seed || 1;
    const amp = t.amp === undefined ? 50 : t.amp;
    const scale = t.scale || 1500;
    const base = t.base || 0;
    return function natural(x, y) {
      let h = base + fbm(x / scale, y / scale, seed, 4) * amp;
      for (const f of feats) {
        if (f.type === 'hill') {
          const dx = x - f.x;
          const dy = y - f.y;
          const d2 = dx * dx + dy * dy;
          const rMax = f.r * (1 + (f.jag || 0));
          if (d2 >= rMax * rMax) continue;
          let r = f.r;
          const dd = Math.sqrt(d2) || 1;
          if (f.jag) r *= 1 + f.jag * (vnoise((dx / dd) * 1.7 + 11, (dy / dd) * 1.7 + 5, seed + 3) - 0.5) * 2;
          const d = dd / r;
          if (d >= 1) continue;
          const k = f.plateau ? 1 - smoothstep(f.plateau, 1, d) : (1 - d * d) * (1 - d * d);
          h += f.h * k;
        } else if (f.type === 'ridge') {
          const q = polyDist(x, y, f.pts);
          if (q.d >= f.w) continue;
          const a = f.pts[q.i];
          const b = f.pts[q.i + 1];
          const d = q.d / f.w;
          if (f.plateau) {
            h += lerp(a[2], b[2], q.t) * (1 - smoothstep(f.plateau, 1, d));
          } else {
            const top = lerp(a[2], b[2], q.t) * (0.75 + 0.25 * (1 - Math.abs(fbm(x / 700, y / 700, seed + 7, 3))));
            h += top * (1 - d * d) * (1 - d * d);
          }
        } else if (f.type === 'trench') {
          const q = polyDist(x, y, f.pts);
          if (q.d >= f.w) continue;
          const k = 1 - smoothstep(f.w * (f.floor === undefined ? 0.35 : f.floor), f.w, q.d);
          if (f.level !== undefined) h += (Math.min(h, f.level) - h) * k; // flat bed at a set height
          else h -= f.depth * k;
        } else if (f.type === 'slope') {
          h += f.h * smoothstep(f.from, f.to, (x - f.x) * f.nx + (y - f.y) * f.ny);
        } else if (f.type === 'flat') {
          const d = Math.hypot(x - f.x, y - f.y);
          if (d >= f.r) continue;
          h += (f.level - h) * (1 - smoothstep(f.r * (f.soft || 0.6), f.r, d));
        } else if (f.type === 'cone') {
          const d = Math.hypot(x - f.x, y - f.y) / f.r;
          if (d >= 1) continue;
          let k = (1 - d) ** 1.35 * (0.92 + 0.08 * fbm(x / 400, y / 400, seed + 5, 3));
          if (f.crater && d < f.crater) k -= ((f.crater - d) / f.crater) ** 2 * 0.35;
          h += f.h * k;
        } else if (f.type === 'rim') {
          const ox = Math.max(bounds.minX - x, 0, x - bounds.maxX);
          const oy = Math.max(bounds.minY - y, 0, y - bounds.maxY);
          const out = Math.hypot(ox, oy) - (f.pad || 0);
          if (out <= 0) continue;
          const peaks = 0.55 + 0.45 * (1 - Math.abs(fbm(x / 1100, y / 1100, seed + 13, 4)));
          h += f.h * smoothstep(0, f.w, out) * peaks;
        }
      }
      return h;
    };
  }

  // ---------- centerline ----------
  // Centripetal Catmull-Rom through [x, y, z] control points (no loops or cusps on uneven spacing).
  function splinePoint(p0, p1, p2, p3, t) {
    const k = (a, b) => Math.max(1e-3, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t1 = k(p0, p1);
    const t2 = t1 + k(p1, p2);
    const t3 = t2 + k(p2, p3);
    const u = t1 + (t2 - t1) * t;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a1 = ((t1 - u) / t1) * p0[c] + (u / t1) * p1[c];
      const a2 = ((t2 - u) / (t2 - t1)) * p1[c] + ((u - t1) / (t2 - t1)) * p2[c];
      const a3 = ((t3 - u) / (t3 - t2)) * p2[c] + ((u - t2) / (t3 - t2)) * p3[c];
      const b1 = ((t2 - u) / t2) * a1 + (u / t2) * a2;
      const b2 = ((t3 - u) / (t3 - t1)) * a2 + ((u - t1) / (t3 - t1)) * a3;
      out[c] = ((t2 - u) / (t2 - t1)) * b1 + ((u - t1) / (t2 - t1)) * b2;
    }
    return out;
  }

  // Closed road through the control points, resampled every ~SPACING units so physics lookups,
  // bots and road meshes see the same density everywhere. Heights come along for the ride.
  function buildCenterline(points, vscale = 1) {
    const P = points.map((p) => [p[0], p[1], (p[2] || 0) * vscale]);
    const m = P.length;
    const dense = [];
    for (let i = 0; i < m; i++) {
      const p0 = P[(i - 1 + m) % m];
      const p1 = P[i];
      const p2 = P[(i + 1) % m];
      const p3 = P[(i + 2) % m];
      const steps = Math.max(8, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 6));
      for (let s = 0; s < steps; s++) dense.push(splinePoint(p0, p1, p2, p3, s / steps));
    }
    const cum = [0];
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1];
      const b = dense[i % dense.length];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[dense.length];
    const n = Math.max(16, Math.round(total / SPACING));
    const pts = [];
    let h = new Float64Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const target = (k / n) * total;
      while (cum[j + 1] < target) j++;
      const a = dense[j];
      const b = dense[(j + 1) % dense.length];
      const t = (target - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      h[k] = a[2] + (b[2] - a[2]) * t;
    }
    // A light smoothing pass so climbs and crests flow (no kinks at control points).
    for (let pass = 0; pass < 3; pass++) {
      const s = new Float64Array(n);
      for (let k = 0; k < n; k++) s[k] = 0.25 * h[(k - 1 + n) % n] + 0.5 * h[k] + 0.25 * h[(k + 1) % n];
      h = s;
    }
    return { pts, h, spacing: total / n, length: total };
  }

  // ---------- Race tracks ----------
  // `reverse` builds the same circuit driven the other way round. The start
  // line stays at centerline[0]; item rows and boost pads keep their physical
  // spots (fraction f -> 1 - f, lateral mirrored) but face the new direction.
  // Ramps only launch in their own direction; driven backwards they are just bumps.
  function makeRaceMap(def, reverse = false) {
    const width = def.width || 260;
    const half = width / 2;
    // vscale stretches every height of the map (road, terrain, water) without touching its layout.
    const vs = def.vscale || 1;
    const line = buildCenterline(def.points, vs);
    const n = line.pts.length;
    const spacing = line.spacing;
    const at = (f) => ((Math.round(f * n) % n) + n) % n;
    const span = (f0, f1, fn) => {
      let i = at(f0);
      const end = at(f1);
      for (let k = 0; k <= n; k++) { fn(i); if (i === end) break; i = (i + 1) % n; }
    };
    const wrapD = (d) => (d > n / 2 ? d - n : d < -n / 2 ? d + n : d);

    // Per-sample road properties, built for the forward direction.
    let anchor = new Float32Array(n).fill(1); // how much the terrain hugs the road (0 on bridges)
    let railed = new Uint8Array(n); // wall at the guard rail
    let bridge = new Uint8Array(n);
    let gap = new Uint8Array(n); // no road here: HAZARDS[code] below
    let fall = new Float32Array(n).fill(def.falloff || 480); // how far the road's shoulders reach into the terrain
    const zeroW = new Float32Array(n); // anchor transition width (samples) around bridges and gaps
    for (const [f0, f1] of def.bridges || []) span(f0, f1, (i) => { bridge[i] = 1; railed[i] = 1; anchor[i] = 0; zeroW[i] = 5; });
    for (const [f0, f1] of def.rails || []) span(f0, f1, (i) => { railed[i] = 1; });
    for (const z of def.zones || []) span(z.from, z.to, (i) => { if (z.falloff) fall[i] = z.falloff; });
    const ramps = (def.ramps || []).map((r) => ({
      i: at(r.at), dir: r.dir || 1, h: r.h || 26, up: r.up || 140, down: r.down || 90, lift: r.lift || PHYS.rampLift, gap: false,
    }));
    const channels = [];
    for (const j of def.jumps || []) {
      const c = at(j.at);
      const g = Math.max(2, Math.round((j.gap || 200) / spacing / 2));
      const kind = HAZARDS.indexOf(j.kind || 'void');
      for (let k = -g + 1; k <= g - 1; k++) {
        const i = (c + k + n) % n;
        gap[i] = kind;
        anchor[i] = 0;
        zeroW[i] = 1.5;
      }
      const r = { h: j.h || 30, up: j.up || 150, down: 30, lift: j.lift || PHYS.rampLift, gap: true };
      // Guard rails funnel every kart onto the kicker: nobody can slip past the ramp into the gap.
      const run = g + Math.ceil((r.up + 70) / spacing);
      for (let k = -run; k <= run; k++) railed[(c + k + n) % n] = 1;
      ramps.push({ ...r, i: (c - g + n) % n, dir: 1 }, { ...r, i: (c + g) % n, dir: -1 });
      // Lava/water rivers flow under their jumps; a 'void' jump can ask for a dry slot canyon.
      if (j.channel === false || (HAZARDS[kind] === 'void' && !j.channel)) continue;
      channels.push({ c, kind: HAZARDS[kind], w: (j.gap || 200) * 1.1, ...(j.channel || {}) });
    }
    if (zeroW.some((w) => w > 0)) {
      const a = new Float32Array(n).fill(1);
      for (let i = 0; i < n; i++) {
        if (!zeroW[i]) continue;
        const w = zeroW[i];
        for (let k = -Math.ceil(w); k <= Math.ceil(w); k++) {
          const j = (i + k + n) % n;
          a[j] = Math.min(a[j], smoothstep(0, w, Math.abs(k)));
        }
      }
      anchor = a;
      // Guard rails run on until the ground has come back up to the road at either end of a bridge.
      const run = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (anchor[i] >= 0.99) continue;
        let nearBridge = false;
        for (let o = -6; o <= 6; o++) if (bridge[(i + o + n) % n]) nearBridge = true;
        if (nearBridge) for (let o = -3; o <= 3; o++) run[(i + o + n) % n] = 1;
      }
      for (let i = 0; i < n; i++) if (run[i]) railed[i] = 1;
    }
    // Walls funnel in towards railed stretches over ~8 samples.
    let wallD = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let k = 99;
      for (let o = -8; o <= 8; o++) if (railed[(i + o + n) % n]) k = Math.min(k, Math.abs(o));
      wallD[i] = half + RAIL + (WALL_PAD - RAIL) * smoothstep(0, 8, k);
    }
    {
      const f2 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let o = -6; o <= 6; o++) s += fall[(i + o + n) % n];
        f2[i] = s / 13;
      }
      fall = f2;
    }

    // Channels crossing the road under a gap jump (lava, water or a dry slot): a winding trench at right angles.
    const fwdPts = line.pts;
    const fwdTan = (i) => {
      const a = fwdPts[(i - 2 + n) % n];
      const b = fwdPts[(i + 2) % n];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    };
    const channelFeats = [];
    for (const ch of channels) {
      const [cx, cy] = fwdPts[ch.c];
      const [tx, ty] = fwdTan(ch.c);
      const len = ch.len || 1800;
      const wig = ch.wiggle === undefined ? 0.18 : ch.wiggle;
      const pts = [];
      for (let k = -6; k <= 6; k++) {
        const s = (k / 6) * len;
        const off = Math.sin(k * 1.3 + ch.c) * wig * Math.abs(s) * 0.5;
        pts.push([cx - ty * s + tx * off, cy + tx * s + ty * off]);
      }
      ch.pts = pts;
      ch.depth = ch.depth || 90;
      channelFeats.push({ type: 'trench', pts, w: ch.w * 1.15, depth: ch.depth, floor: 0.55 });
    }
    const liquids = channels.filter((c) => c.kind !== 'void');
    for (const c of liquids) c.depth *= vs;
    for (const l of def.lava || []) {
      liquids.push({ kind: 'lava', pts: l.pts, w: l.w, depth: (l.depth || 70) * vs });
      channelFeats.push({ type: 'trench', pts: l.pts, w: l.w * 1.15, depth: l.depth || 70, floor: 0.55 });
    }

    // Everything above is indexed for the forward direction; flip it for reverse races.
    let C = line.pts;
    let H = line.h;
    if (reverse) {
      const flip = (arr) => {
        const out = new arr.constructor(n);
        for (let i = 0; i < n; i++) out[i] = arr[(n - i) % n];
        return out;
      };
      C = C.map((_, i) => line.pts[(n - i) % n]);
      H = flip(H);
      anchor = flip(anchor); railed = flip(railed); bridge = flip(bridge); gap = flip(gap); fall = flip(fall); wallD = flip(wallD);
      for (const r of ramps) { r.i = (n - r.i) % n; r.dir = -r.dir; }
    }
    const centerline = C;
    const flipF = (f) => (reverse ? (1 - f) % 1 : f);
    const tangents = centerline.map((p, i) => {
      const q = centerline[(i + 1) % n];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    });
    const grade = new Float64Array(n);
    for (let i = 0; i < n; i++) grade[i] = (H[(i + 1) % n] - H[(i - 1 + n) % n]) / (2 * spacing);
    // Direction of the road at each sample (the mitre between its two segments).
    const miter = tangents.map((b, i) => {
      const a = tangents[(i - 1 + n) % n];
      const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
      return [(a[0] + b[0]) / l, (a[1] + b[1]) / l];
    });

    const xs = centerline.map((p) => p[0]);
    const ys = centerline.map((p) => p[1]);
    const pad = half + WALL_PAD + 40;
    const bounds = { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad };
    const natural0 = makeNatural(def.terrain || {}, bounds, channelFeats);
    const natural = vs === 1 ? natural0 : (x, y) => natural0(x, y) * vs;

    // Spatial grid for nearest-sample lookups without a hint.
    const e0 = half + RUNOFF;
    let maxFall = 0;
    for (let i = 0; i < n; i++) maxFall = Math.max(maxFall, fall[i]);
    const reach = e0 + maxFall + 40; // beyond this the terrain is purely natural
    const CELL = 256;
    const REACH = Math.max(720, reach + 60);
    const gMinX = bounds.minX - 3000;
    const gMinY = bounds.minY - 3000;
    const gw = Math.ceil((bounds.maxX - bounds.minX + 6000) / CELL);
    const gh = Math.ceil((bounds.maxY - bounds.minY + 6000) / CELL);
    const grid = new Array(gw * gh);
    centerline.forEach(([x, y], i) => {
      const x0 = Math.max(0, Math.floor((x - REACH - gMinX) / CELL));
      const x1 = Math.min(gw - 1, Math.floor((x + REACH - gMinX) / CELL));
      const y0 = Math.max(0, Math.floor((y - REACH - gMinY) / CELL));
      const y1 = Math.min(gh - 1, Math.floor((y + REACH - gMinY) / CELL));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) (grid[cy * gw + cx] || (grid[cy * gw + cx] = [])).push(i);
    });
    function scanNearest(x, y, list) {
      let best = 0;
      let bestD = Infinity;
      if (list) {
        for (const i of list) {
          const d = (centerline[i][0] - x) ** 2 + (centerline[i][1] - y) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      } else {
        for (let i = 0; i < n; i++) {
          const d = (centerline[i][0] - x) ** 2 + (centerline[i][1] - y) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      return [best, bestD];
    }

    // Nearest centerline sample. With `hint`, only search nearby (prevents
    // snapping to a parallel stretch of track and keeps lookups cheap).
    // Also returns the projection onto the road: u (fractional sample index) and h (road height there).
    function nearestIndex(x, y, hint) {
      let best = 0;
      let bestD = Infinity;
      if (hint === undefined || hint === null) {
        const cx = Math.floor((x - gMinX) / CELL);
        const cy = Math.floor((y - gMinY) / CELL);
        const list = cx >= 0 && cy >= 0 && cx < gw && cy < gh ? grid[cy * gw + cx] : null;
        [best, bestD] = scanNearest(x, y, list);
        if (!list || bestD > REACH * REACH) [best, bestD] = scanNearest(x, y, null);
      } else {
        for (let o = -25; o <= 25; o++) {
          const i = (hint + o + n) % n;
          const d = (centerline[i][0] - x) ** 2 + (centerline[i][1] - y) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      // Refine onto the polyline itself (the nearest sample can be half a
      // segment away along the track, which skews distances and wall normals).
      let px = centerline[best][0];
      let py = centerline[best][1];
      let seg = best;
      let tt = 0;
      for (const j of [(best - 1 + n) % n, best]) {
        const a = centerline[j];
        const c = centerline[(j + 1) % n];
        const sx = c[0] - a[0];
        const sy = c[1] - a[1];
        const len2 = sx * sx + sy * sy || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (y - a[1]) * sy) / len2));
        const qx = a[0] + sx * t;
        const qy = a[1] + sy * t;
        const d = (qx - x) ** 2 + (qy - y) ** 2;
        if (d < bestD) { bestD = d; px = qx; py = qy; seg = j; tt = t; }
      }
      // How far along the road: measured between the mitred ends of a segment, so it neither
      // stalls on the outside of a bend nor skips ahead on the inside (heights stay smooth).
      const md = (k) => (x - centerline[k][0]) * miter[k][0] + (y - centerline[k][1]) * miter[k][1];
      let j0 = seg;
      let d0 = md(j0);
      let d1 = md((j0 + 1) % n);
      for (let it = 0; it < 3; it++) {
        if (d0 < 0) { j0 = (j0 - 1 + n) % n; d1 = d0; d0 = md(j0); } else if (d1 > 0) { j0 = (j0 + 1) % n; d0 = d1; d1 = md((j0 + 1) % n); } else break;
      }
      const s = d0 - d1 > 1e-9 ? clamp(d0 / (d0 - d1), 0, 1) : tt;
      // Road height: cubic Hermite between samples (smooth slopes for the karts).
      const j1 = (j0 + 1) % n;
      const t2 = s * s;
      const t3 = t2 * s;
      const h = (2 * t3 - 3 * t2 + 1) * H[j0] + (t3 - 2 * t2 + s) * grade[j0] * spacing
        + (-2 * t3 + 3 * t2) * H[j1] + (t3 - t2) * grade[j1] * spacing;
      return { index: best, dist: Math.sqrt(bestD), px, py, seg, t: tt, u: j0 + s, h };
    }

    // ---- terrain around the road ----
    // Close to the road the ground takes the road's height; further out it fades into the natural
    // terrain. Away from the road, road heights are blended between nearby stretches (inverse
    // distance over chunks of road), so the ground is continuous even between switchbacks.
    const rcIn = reach + 60;
    const rc = rcIn + 500;
    const CH = 8;
    const chunks = [];
    for (let s = 0; s < n; s += CH) {
      const end = Math.min(s + CH, n);
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (let i = s; i <= end; i++) {
        const p = centerline[i % n];
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      chunks.push({ s, end, minX, maxX, minY, maxY });
    }
    const CCELL = 512;
    const cw = Math.ceil((bounds.maxX - bounds.minX + 6000) / CCELL);
    const chh = Math.ceil((bounds.maxY - bounds.minY + 6000) / CCELL);
    const cgrid = new Array(cw * chh);
    chunks.forEach((c) => {
      const x0 = Math.max(0, Math.floor((c.minX - rc - gMinX) / CCELL));
      const x1 = Math.min(cw - 1, Math.floor((c.maxX + rc - gMinX) / CCELL));
      const y0 = Math.max(0, Math.floor((c.minY - rc - gMinY) / CCELL));
      const y1 = Math.min(chh - 1, Math.floor((c.maxY + rc - gMinY) / CCELL));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) (cgrid[cy * cw + cx] || (cgrid[cy * cw + cx] = [])).push(c);
    });
    function blendRoad(x, y) {
      const gx = Math.floor((x - gMinX) / CCELL);
      const gy = Math.floor((y - gMinY) / CCELL);
      const list = gx >= 0 && gy >= 0 && gx < cw && gy < chh ? cgrid[gy * cw + gx] : null;
      if (!list) return null;
      let sw = 0; let sh = 0; let sa = 0; let sf = 0;
      for (const c of list) {
        if (x < c.minX - rc || x > c.maxX + rc || y < c.minY - rc || y > c.maxY + rc) continue;
        let bd = Infinity; let bh = 0; let ba = 0; let bf = 0;
        for (let s = c.s; s < c.end; s++) {
          const i0 = s % n;
          const i1 = (s + 1) % n;
          const a = centerline[i0];
          const b = centerline[i1];
          const sx = b[0] - a[0];
          const sy = b[1] - a[1];
          const t = clamp(((x - a[0]) * sx + (y - a[1]) * sy) / (sx * sx + sy * sy || 1), 0, 1);
          const d = (a[0] + sx * t - x) ** 2 + (a[1] + sy * t - y) ** 2;
          if (d < bd) { bd = d; bh = lerp(H[i0], H[i1], t); ba = lerp(anchor[i0], anchor[i1], t); bf = lerp(fall[i0], fall[i1], t); }
        }
        const d = Math.sqrt(bd);
        if (d >= rc) continue;
        const w = (1 - smoothstep(rcIn, rc, d)) / (bd + 400);
        sw += w; sh += w * bh; sa += w * ba; sf += w * bf;
      }
      return sw > 0 ? { h: sh / sw, a: sa / sw, f: sf / sw } : null;
    }
    // Is any road sample within REACH of this grid cell? (cheap "far from the road" test)
    function nearRoad(x, y) {
      const cx = Math.floor((x - gMinX) / CELL);
      const cy = Math.floor((y - gMinY) / CELL);
      return cx >= 0 && cy >= 0 && cx < gw && cy < gh && !!grid[cy * gw + cx];
    }
    // Ground height of the landscape (not the road deck or ramps) at (x, y).
    function terrainAt(x, y, q) {
      const nat = natural(x, y);
      if (!q && !nearRoad(x, y)) return nat;
      q = q || nearestIndex(x, y);
      const d = q.dist;
      if (d >= reach) return nat;
      const j1 = (q.seg + 1) % n;
      let rh = q.h;
      let an = lerp(anchor[q.seg], anchor[j1], q.t);
      let fa = lerp(fall[q.seg], fall[j1], q.t);
      const t1 = smoothstep(half + CURB, e0, d);
      if (t1 > 0) {
        const w = blendRoad(x, y);
        if (w) { rh += (w.h - rh) * t1; an += (w.a - an) * t1; fa += (w.f - fa) * t1; }
      }
      const infl = an * (1 - smoothstep(e0, e0 + fa, d));
      return nat + (rh - nat) * infl;
    }
    // Bridges, gaps and railed roads are solid deck out to the parapet: the road's own height
    // reaches all the way to the guard rail, so there is never a hidden step beside the asphalt.
    const deckAt = (q) => {
      const j1 = (q.seg + 1) % n;
      return bridge[q.seg] || bridge[j1] || gap[q.seg] || gap[j1] || railed[q.seg] || railed[j1];
    };
    // Ramps are bumps across the asphalt (fading out over the curbs). The kickers in front of a
    // gap span the whole deck between the guard rails.
    function bumpAt(q, deck = deckAt(q)) {
      if (!ramps.length || q.dist > half + (deck ? DECK : CURB)) return 0;
      const k = q.dist <= half ? 1 : Math.max(0, 1 - (q.dist - half) / CURB);
      let b = 0;
      for (const r of ramps) {
        const s = wrapD(q.u - r.i) * spacing * r.dir;
        if (s < -r.up || s > r.down) continue;
        const v = (s <= 0 ? r.h * ((s + r.up) / r.up) ** 1.6 : r.h * (1 - smoothstep(0, r.down, s))) * (r.gap && deck ? 1 : k);
        if (v > b) b = v;
      }
      return b;
    }
    // What a kart stands on: the road (and ramps, bridge decks) when on it, the terrain otherwise
    // (from the curb outwards the ground blends smoothly into the landscape).
    function surfaceAt(x, y, q) {
      const deck = deckAt(q);
      if (q.dist <= half + (deck ? DECK : CURB)) return q.h + bumpAt(q, deck);
      return terrainAt(x, y, q);
    }
    function heightAt(x, y, hint) {
      return surfaceAt(x, y, nearestIndex(x, y, hint));
    }
    function wallAt(q) {
      return lerp(wallD[q.seg], wallD[(q.seg + 1) % n], q.t);
    }
    // Deadly ground under a kart: 'water', 'lava', 'void' or null.
    const water = Number.isFinite(def.water) ? def.water * vs : null;
    function hazardAt(x, y, q) {
      q = q || nearestIndex(x, y);
      const g = gap[q.index];
      if (g && q.dist <= wallAt(q) + 4) return HAZARDS[g];
      if (q.dist <= half + CURB || (deckAt(q) && q.dist <= half + DECK)) return null;
      if (water !== null && terrainAt(x, y, q) < water - 3) return 'water';
      for (const l of liquids) if (polyDist(x, y, l.pts).d < l.w * 0.42) return l.kind;
      return null;
    }

    // Where to put a kart back after a fall: a little behind its last safe spot, never on a
    // ramp, and with a run-up of at least 16 samples before any gap.
    const danger = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (gap[i]) danger[i] = 2;
    for (const r of ramps) {
      for (let k = -Math.ceil(r.up / spacing) - 1; k <= Math.ceil(r.down / spacing) + 1; k++) {
        const i = (r.i + k * r.dir + n) % n;
        if (!danger[i]) danger[i] = 1;
      }
    }
    const respawn = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let k = (i - 3 + n) % n;
      for (let tries = 0; tries < 80; tries++) {
        let bad = danger[k] > 0;
        for (let a = 1; a <= 16 && !bad; a++) if (danger[(k + a) % n] === 2) bad = true;
        if (!bad) break;
        k = (k - 1 + n) % n;
      }
      respawn[i] = k;
    }

    // Point across the track at sample `i`, lateral offset in [-1, 1].
    function trackPoint(i, lateral) {
      const k = ((i % n) + n) % n;
      const p = centerline[k];
      const t = tangents[k];
      return [p[0] - t[1] * lateral * half, p[1] + t[0] * lateral * half];
    }

    // Starting grid: rows of 5 behind the start line.
    function gridPosition(slot) {
      const row = Math.floor(slot / 5);
      const col = slot % 5;
      const i = (n - 3 - row * 2 + n * 4) % n;
      const [x, y] = trackPoint(i, -0.8 + col * 0.4);
      const t = tangents[i];
      return { x, y, angle: Math.atan2(t[1], t[0]), index: i };
    }

    const itemBoxes = [];
    for (const f of def.itemRows || [0.12, 0.37, 0.62, 0.86]) {
      for (let c = 0; c < 5; c++) {
        const [x, y] = trackPoint(Math.floor(n * flipF(f)), -0.7 + c * 0.35);
        itemBoxes.push({ x, y });
      }
    }
    const boostPads = (def.boostPads || []).map(([f, lateral]) => {
      const i = Math.floor(n * flipF(f));
      const [x, y] = trackPoint(i, reverse ? -lateral : lateral);
      const t = tangents[i];
      return { x, y, angle: Math.atan2(t[1], t[0]) };
    });

    let climb = 0;
    for (let i = 0; i < n; i++) climb += Math.max(0, H[(i + 1) % n] - H[i]);

    return {
      ...def, type: 'race', reverse: !!reverse, width, centerline, tangents, n, spacing, length: line.length, itemBoxes, boostPads, bounds,
      center: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2],
      size: Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
      heights: H, grade, anchor, railed, bridge, gap, wallD, fallD: fall, ramps, liquids, water, climb,
      nearestIndex, nearRoad, trackPoint, gridPosition, natural, terrainAt, surfaceAt, heightAt, bumpAt, wallAt, hazardAt,
      respawnIndex: (i) => respawn[((i % n) + n) % n],
      offTrack(x, y, pad2 = 0) { return nearestIndex(x, y).dist > width / 2 + pad2; },
    };
  }

  // ---------- Battle arenas ----------
  function makeArenaMap(def) {
    const S = def.size;
    const C = S / 2;
    const itemBoxes = def.itemBoxes || [];
    if (!def.itemBoxes) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        itemBoxes.push({ x: C + Math.cos(a) * 430, y: C + Math.sin(a) * 430 });
      }
      for (const [x, y] of [[300, 300], [S - 300, 300], [300, S - 300], [S - 300, S - 300], [C, 260], [C, S - 260], [260, C], [S - 260, C]]) {
        itemBoxes.push({ x, y });
      }
    }
    const obstacles = def.obstacles || [];
    const hazards = def.hazards || [];
    const free = (x, y, pad) => x > 60 + pad && y > 60 + pad && x < S - 60 - pad && y < S - 60 - pad
      && !obstacles.some((o) => (x - o.x) ** 2 + (y - o.y) ** 2 < (o.r + pad) ** 2)
      && !hazards.some((h) => (x - h.x) ** 2 + (y - h.y) ** 2 < (h.r + pad) ** 2);
    const spawns = [];
    for (let i = 0; i < 48 && spawns.length < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + (i >= 24 ? 0.13 : 0);
      const rad = (i % 2 ? 1050 : 650) * (S / 2600) + (i >= 24 ? 80 : 0);
      const x = C + Math.cos(a) * rad;
      const y = C + Math.sin(a) * rad;
      if (free(x, y, 50)) spawns.push({ x, y, angle: a + Math.PI });
    }
    function blocked(x, y, pad = 0) {
      if (x < 40 || y < 40 || x > S - 40 || y > S - 40) return true;
      return obstacles.some((o) => (x - o.x) ** 2 + (y - o.y) ** 2 < (o.r + pad) ** 2);
    }
    return {
      ...def, type: 'arena', obstacles, hazards, itemBoxes, spawns, boostPads: def.boostPads || [],
      center: [C, C], bounds: { minX: 0, minY: 0, maxX: S, maxY: S }, blocked,
      heightAt: () => 0, // arenas are flat
    };
  }

  // ---------- Map catalogue ----------
  // Race maps are built on first use (MAPS.x is a getter), so loading this file on the home page or
  // in the lobby costs next to nothing; mapList() and mapInfo() never build one.
  const MAPS = {};
  const RACE_DEFS = {};
  const INFO = {};
  const built = [];
  const info = (m, type) => { INFO[m.id] = { id: m.id, name: m.name, emoji: m.emoji, type, blurb: m.blurb }; };
  const add = (m) => { MAPS[m.id] = m; info(m, m.type); };
  const addRace = (def) => {
    RACE_DEFS[def.id] = def;
    info(def, 'race');
    let map = null;
    Object.defineProperty(MAPS, def.id, {
      enumerable: true,
      get() {
        if (!map) { map = makeRaceMap(def); built.push(def.id); }
        return map;
      },
    });
  };

  addRace({
    id: 'grandprix', name: 'Grand Prix', emoji: '🏁', theme: 'meadow', width: 290,
    blurb: 'Rolling green hills, a crest jump and a viaduct over the river.',
    vscale: 1.5,
    points: [
      [2400, 5200, 0], [3700, 5200, 0], [4800, 5000, 15], [5600, 4450, 60], [5900, 3700, 140], [5900, 2950, 200],
      [5880, 2400, 205], [5850, 1850, 210], [5650, 1150, 245], [5150, 700, 255], [4400, 620, 150], [3750, 830, 90],
      [3600, 1400, 30], [3350, 1950, 5], [2700, 2000, 0], [2000, 1700, 30], [2000, 1100, 80], [1550, 650, 90],
      [1050, 690, 85], [730, 820, 85], [600, 1180, 90], [800, 2200, 150], [600, 2900, 170], [1000, 3600, 100], [700, 4300, 40],
      [950, 5000, 5], [1500, 5200, 0],
    ],
    water: -40,
    terrain: {
      seed: 4, amp: 70, scale: 1700, base: 30,
      features: [
        { type: 'hill', x: 5900, y: 3300, r: 1700, h: 170 },
        { type: 'hill', x: 5500, y: 900, r: 1600, h: 220 },
        { type: 'hill', x: 600, y: 2600, r: 1500, h: 110 },
        { type: 'flat', x: 3300, y: 2900, r: 1100, level: -90 },
        { type: 'trench', pts: [[3300, 2900], [4400, 2650], [5300, 2450], [6400, 2300], [8000, 2200]], w: 650, level: -90, floor: 0.3 },
        { type: 'rim', pad: 700, w: 2600, h: 700 },
      ],
    },
    bridges: [[0.255, 0.33]],
    zones: [{ from: 0.495, to: 0.56, falloff: 120 }],
    ramps: [{ at: 0.4 }],
    landmarks: [{ kind: 'grandstand', at: 0.985, side: -1, len: 1000 }],
    itemRows: [0.1, 0.3, 0.5, 0.7, 0.88],
    boostPads: [[0.15, 0], [0.45, -0.3], [0.62, 0.3], [0.8, 0]],
  });
  addRace({
    id: 'canyon', name: 'Desert Canyon', emoji: '🏜️', theme: 'desert', width: 270,
    blurb: 'Climb the mesa, leap off its edge, bridge the canyon and jump the slot.',
    vscale: 1.3,
    points: [
      [5000, 4500, 0], [5000, 3700, 0], [5300, 3000, 20], [6100, 2600, 70], [6600, 1900, 150], [6500, 1100, 240],
      [6000, 500, 285], [5100, 350, 290], [4300, 700, 285], [4000, 1300, 285], [3700, 1700, 280], [3200, 1900, 150],
      [2700, 1850, 110], [2000, 1800, 90], [1300, 1500, 60], [700, 1900, 45], [900, 2650, 35], [1500, 2950, 40], [1750, 3350, 35],
      [1300, 3850, 25], [800, 4500, 15], [1300, 5200, 10], [2300, 5100, 20], [3350, 5050, 20], [4100, 5300, 5],
      [4700, 5450, 0], [5000, 5100, 0],
    ],
    terrain: {
      seed: 7, amp: 40, scale: 1400, base: 0,
      features: [
        { type: 'ridge', pts: [[3900, 1500, 285], [4800, 800, 290], [6000, 800, 290]], w: 900, plateau: 0.6 },
        { type: 'trench', pts: [[2000, -1500], [2300, 600], [2350, 1850], [2700, 2900], [3300, 3800]], w: 520, level: -200, floor: 0.45 },
        { type: 'rim', pad: 900, w: 2400, h: 500 },
      ],
    },
    bridges: [[0.44, 0.49]],
    ramps: [{ at: 0.42, h: 34, lift: 560 }],
    jumps: [{ at: 0.888, gap: 200, kind: 'void', channel: { len: 1700, w: 230, depth: 230, wiggle: 0.12 } }],
    itemRows: [0.08, 0.3, 0.52, 0.7, 0.84],
    boostPads: [[0.06, 0], [0.33, 0.3], [0.6, -0.3], [0.8, 0]],
  });
  addRace({
    id: 'frost', name: 'Snowy Peaks', emoji: '🏔️', theme: 'snow', width: 280, grip: 0.82,
    blurb: 'Climb the mountain pass, slide down the switchbacks, cross the ice bridge.',
    vscale: 1.45,
    points: [
      [2600, 5200, 0], [1600, 5200, 0], [800, 4900, 10], [500, 4200, 50], [600, 3500, 110], [700, 2900, 140],
      [500, 2200, 200], [800, 1500, 300], [1400, 1000, 400], [2200, 700, 480], [3100, 600, 540], [4000, 700, 520],
      [5400, 880, 470], [5850, 1030, 460], [6000, 1375, 440], [5850, 1720, 425], [5450, 1870, 410], [4200, 1900, 360],
      [3700, 2040, 350], [3520, 2400, 340], [3700, 2760, 325], [4100, 2900, 300], [5400, 2950, 250], [5850, 3100, 240],
      [6000, 3450, 230], [5850, 3800, 210], [5450, 3950, 190], [4300, 4000, 140], [3600, 4500, 80], [3300, 5100, 20],
    ],
    terrain: {
      seed: 11, amp: 80, scale: 1500, base: 20,
      features: [
        { type: 'hill', x: 3150, y: -150, r: 1150, h: 1300, jag: 0.25 },
        { type: 'hill', x: 2950, y: 1550, r: 950, h: 850, jag: 0.25 },
        { type: 'slope', x: 3000, y: 3000, nx: 0, ny: -1, from: -2000, to: 2400, h: 470 },
        { type: 'trench', pts: [[-1500, 3400], [600, 3300], [1600, 3000]], w: 380, level: -120, floor: 0.45 },
        { type: 'rim', pad: 700, w: 2400, h: 1000 },
      ],
    },
    bridges: [[0.147, 0.184]],
    zones: [{ from: 0.3, to: 0.42, falloff: 680 }],
    jumps: [{ at: 0.875, gap: 200, kind: 'void', channel: { len: 1600, w: 230, depth: 260, wiggle: 0.1 } }],
    itemRows: [0.06, 0.28, 0.48, 0.68, 0.84],
    boostPads: [[0.03, 0], [0.4, 0.3], [0.58, -0.3], [0.78, 0.3]],
  });
  addRace({
    id: 'neon', name: 'Neon City', emoji: '🌃', theme: 'neon', width: 270,
    blurb: 'Raised highways and ramp jumps between glowing towers.',
    vscale: 1.25,
    points: [
      [1800, 4700, 0], [3200, 4700, 0], [4100, 4650, 20], [4800, 4300, 90], [5100, 3600, 150], [5100, 2700, 160],
      [5100, 1800, 160], [4800, 1050, 150], [4000, 700, 140], [3100, 700, 100], [2400, 900, 30], [2200, 1600, 0],
      [2900, 2000, 0], [3300, 2700, 0], [2800, 3300, 0], [2000, 3250, 20], [1400, 2800, 90], [1100, 2000, 150],
      [1100, 1100, 160], [960, 660, 158], [625, 520, 155], [290, 660, 152], [150, 1000, 150], [150, 2300, 130], [250, 3500, 70], [800, 4500, 0],
    ],
    terrain: { seed: 3, amp: 0, base: 0, features: [] },
    bridges: [[0.16, 0.36], [0.68, 0.86]],
    jumps: [{ at: 0.24, gap: 200, kind: 'void' }, { at: 0.715, gap: 200, kind: 'void' }],
    landmarks: [{ kind: 'towers', at: 0.24 }, { kind: 'towers', at: 0.715 }],
    itemRows: [0.06, 0.3, 0.5, 0.64, 0.9],
    boostPads: [[0.04, 0], [0.2, 0], [0.45, 0], [0.58, 0], [0.72, 0]],
  });
  addRace({
    id: 'coast', name: 'Coral Coast', emoji: '🏝️', theme: 'coast', width: 290,
    blurb: 'Beach run, jungle hills, lighthouse cliffs and a long sea bridge. Mind the water!',
    vscale: 1.4,
    points: [
      [1500, 4000, 25], [2700, 4050, 20], [3700, 3950, 30], [4200, 3300, 80], [3900, 2500, 140], [3300, 2050, 160],
      [2550, 2150, 165], [2000, 1650, 180], [2350, 1000, 200], [3200, 820, 215], [4000, 700, 205], [4700, 850, 200], [5400, 1300, 170], [6100, 2200, 120], [6000, 3100, 150], [5900, 4000, 210],
      [5800, 4900, 220], [5300, 5500, 180], [4500, 5600, 90], [3300, 5650, 80], [2100, 5600, 80], [1100, 5300, 60],
      [600, 4700, 40], [800, 4100, 30],
    ],
    water: 0,
    terrain: {
      seed: 21, amp: 50, scale: 1300, base: 40,
      features: [
        { type: 'slope', x: 0, y: 0, nx: 0, ny: 1, from: 3900, to: 4300, h: -170 },
        { type: 'hill', x: 6000, y: 4700, r: 1500, h: 240, plateau: 0.55, jag: 0.2 },
        { type: 'hill', x: 900, y: 5400, r: 1200, h: 190, plateau: 0.35, jag: 0.2 },
        { type: 'hill', x: 4500, y: 1800, r: 1700, h: 170 },
        { type: 'hill', x: 2500, y: 1500, r: 1400, h: 150 },
        { type: 'ridge', pts: [[-2000, -500, 600], [3000, -1500, 800], [8000, -500, 600]], w: 2500 },
      ],
    },
    zones: [{ from: 0.965, to: 0.105, falloff: 200 }],
    bridges: [[0.7, 0.88]],
    landmarks: [{ kind: 'lighthouse', x: 6450, y: 5150 }],
    ramps: [{ at: 0.372 }],
    itemRows: [0.08, 0.26, 0.46, 0.66, 0.86],
    boostPads: [[0.05, 0], [0.38, 0.3], [0.6, 0], [0.72, 0], [0.92, 0]],
  });
  addRace({
    id: 'lavapeak', name: 'Lava Peak', emoji: '🌋', theme: 'lava', width: 270,
    blurb: 'Switchback up a live volcano and jump the lava rivers. Do not fall in!',
    vscale: 1.45,
    points: [
      [2800, 6150, 10], [4000, 6150, 20], [5000, 6000, 40], [5420, 5880, 55], [5590, 5530, 75], [5420, 5180, 95],
      [5000, 5060, 110], [3800, 5000, 160], [2700, 4900, 210], [2340, 4760, 230], [2180, 4425, 250], [2340, 4090, 275], [2700, 3950, 300], [3800, 4100, 380], [4600, 4150, 420], [5100, 3600, 440],
      [5200, 2800, 470], [4900, 1800, 490], [4000, 1300, 520], [3000, 1350, 530], [2200, 1900, 510], [1700, 2800, 400],
      [1250, 3800, 230], [1000, 4900, 90], [1600, 5800, 20], [2000, 6150, 10],
    ],
    terrain: {
      seed: 31, amp: 40, scale: 1200, base: 0,
      features: [
        { type: 'cone', x: 3600, y: 2800, r: 3400, h: 1100, crater: 0.17 },
        { type: 'rim', pad: 900, w: 2600, h: 600 },
      ],
    },
    jumps: [{ at: 0.5, gap: 200, kind: 'lava' }, { at: 0.66, gap: 200, kind: 'lava' }],
    crater: { x: 3600, y: 2800, r: 560 },
    itemRows: [0.08, 0.27, 0.46, 0.62, 0.86],
    boostPads: [[0.05, 0], [0.4, 0], [0.75, 0.3], [0.9, -0.3]],
  });

  {
    const S = 2600;
    const C = S / 2;
    add(makeArenaMap({
      id: 'colosseum', name: 'Colosseum', emoji: '🏟️', theme: 'arena', size: S,
      blurb: 'Stone tower, pillars and crates under the floodlights.',
      obstacles: [
        { x: C, y: C, r: 170, kind: 'tower' },
        { x: 700, y: 700, r: 80, kind: 'pillar' }, { x: 1900, y: 700, r: 80, kind: 'pillar' },
        { x: 700, y: 1900, r: 80, kind: 'pillar' }, { x: 1900, y: 1900, r: 80, kind: 'pillar' },
        { x: C, y: 520, r: 55, kind: 'crate' }, { x: C, y: 2080, r: 55, kind: 'crate' },
        { x: 520, y: C, r: 55, kind: 'crate' }, { x: 2080, y: C, r: 55, kind: 'crate' },
        { x: 1000, y: 1600, r: 45, kind: 'crate' }, { x: 1600, y: 1000, r: 45, kind: 'crate' },
      ],
      boostPads: [{ x: C, y: 300, angle: 0 }, { x: C, y: S - 300, angle: Math.PI }],
    }));
    add(makeArenaMap({
      id: 'volcano', name: 'Volcano Crater', emoji: '🌋', theme: 'volcano', size: S,
      blurb: 'Lava pools burn your kart. Knock rivals in!',
      obstacles: [
        { x: 650, y: 1300, r: 110, kind: 'rock' }, { x: 1950, y: 1300, r: 110, kind: 'rock' },
        { x: 1300, y: 600, r: 90, kind: 'rock' }, { x: 1300, y: 2000, r: 90, kind: 'rock' },
        { x: 450, y: 450, r: 70, kind: 'rock' }, { x: 2150, y: 2150, r: 70, kind: 'rock' },
      ],
      hazards: [
        { x: C, y: C, r: 200, kind: 'lava' },
        { x: 900, y: 850, r: 110, kind: 'lava' }, { x: 1700, y: 1750, r: 110, kind: 'lava' },
        { x: 1750, y: 800, r: 90, kind: 'lava' }, { x: 850, y: 1800, r: 90, kind: 'lava' },
      ],
      boostPads: [{ x: 300, y: C, angle: -Math.PI / 2 }, { x: S - 300, y: C, angle: Math.PI / 2 }],
    }));
  }

  const DEFAULT_MAP = { race: 'grandprix', arena: 'colosseum' };
  const REVERSED = {};
  // opts.reverse: race tracks only, a cached variant driven the other way.
  function getMap(id, type, opts) {
    const known = INFO[id] && (!type || INFO[id].type === type);
    const m = MAPS[known ? id : DEFAULT_MAP[type || 'race']];
    if (opts && opts.reverse && m.type === 'race' && RACE_DEFS[m.id]) {
      if (!REVERSED[m.id]) REVERSED[m.id] = makeRaceMap(RACE_DEFS[m.id], true);
      return REVERSED[m.id];
    }
    return m;
  }
  function mapList() {
    return Object.values(INFO).map((m) => ({ ...m }));
  }
  // Name, type and blurb of a map without building it (null for an unknown id).
  function mapInfo(id) {
    return INFO[id] || null;
  }
  const mapsBuilt = () => built.slice(); // race maps built so far, in order

  // ---------- Physics ----------
  // Wall contact: drop only the part of the velocity that goes into the wall,
  // so grazing a wall keeps nearly all your speed and a head-on hit bounces
  // you back a little. (nx, ny) is the unit normal pointing away from the wall.
  function slideOffWall(kart, nx, ny, dt) {
    const h = kart.heading === undefined ? kart.angle : kart.heading;
    const vx = Math.cos(h) * kart.speed;
    const vy = Math.sin(h) * kart.speed;
    const vn = vx * nx + vy * ny;
    if (vn >= 0) return 0;
    const scrape = Math.max(0, 1 - 0.35 * dt);
    const ox = (vx - vn * nx) * scrape - vn * 0.25 * nx;
    const oy = (vy - vn * ny) * scrape - vn * 0.25 * ny;
    const v = Math.hypot(ox, oy);
    const forward = ox * Math.cos(kart.angle) + oy * Math.sin(kart.angle) >= 0;
    kart.speed = forward ? v : -v;
    if (v > 1) kart.heading = forward ? Math.atan2(oy, ox) : Math.atan2(-oy, -ox);
    if (kart.drift && -vn > 200) { kart.drift = 0; kart.driftTime = 0; }
    return -vn;
  }

  function collideArena(kart, map, dt) {
    const r = KART_RADIUS;
    let impact = 0;
    const min = 40 + r;
    const max = map.size - 40 - r;
    if (kart.x < min) { kart.x = min; impact = Math.max(impact, slideOffWall(kart, 1, 0, dt)); }
    if (kart.x > max) { kart.x = max; impact = Math.max(impact, slideOffWall(kart, -1, 0, dt)); }
    if (kart.y < min) { kart.y = min; impact = Math.max(impact, slideOffWall(kart, 0, 1, dt)); }
    if (kart.y > max) { kart.y = max; impact = Math.max(impact, slideOffWall(kart, 0, -1, dt)); }
    for (const o of map.obstacles) {
      const dx = kart.x - o.x;
      const dy = kart.y - o.y;
      const d = Math.hypot(dx, dy);
      const minD = o.r + r;
      if (d < minD && d > 0.001) {
        kart.x = o.x + (dx / d) * minD;
        kart.y = o.y + (dy / d) * minD;
        impact = Math.max(impact, slideOffWall(kart, dx / d, dy / d, dt));
      }
    }
    return impact;
  }

  // Put a kart that fell into water/lava back on the road, facing the right way.
  function respawnOnTrack(kart, map) {
    const base = kart.safeIndex !== undefined && kart.safeIndex !== null ? kart.safeIndex : (kart.trackIndex || 0);
    const i = map.respawnIndex(base);
    const p = map.centerline[i];
    const t = map.tangents[i];
    const a = Math.atan2(t[1], t[0]);
    Object.assign(kart, {
      x: p[0], y: p[1], angle: a, heading: a, speed: 0, trackIndex: i, safeIndex: i,
      air: 0, vz: 0, z: null, gz: null, airTime: 0, trick: 0, tricked: false, trickable: false,
      drift: 0, driftTime: 0, boost: 0, spin: 0, fall: 0, fallKind: null, kx: 0, ky: 0, hopping: false,
    });
  }

  // Vertical speed of the road under a kart driving along it (+ climbing).
  function roadVz(kart, map, q) {
    const t = map.tangents[q.index];
    const h = kart.heading === undefined ? kart.angle : kart.heading;
    return map.grade[q.index] * kart.speed * (Math.cos(h) * t[0] + Math.sin(h) * t[1]);
  }

  // Time until a flying kart comes down (on ground at its take-off height).
  function timeToLand(kart) {
    const G = PHYS.gravity;
    const vz = kart.vz || 0;
    return (vz + Math.sqrt(Math.max(0, vz * vz + 2 * G * Math.max(0, kart.air || 0)))) / G;
  }

  // Heights on race tracks: follow the road, fly off ramps and crests, land, fall into hazards.
  function vertical(kart, input, dt, map, q, prevU, opts) {
    const G = PHYS.gravity;
    const g = map.surfaceAt(kart.x, kart.y, q);
    const grounded = !(kart.air > 0);
    if (kart.z === undefined || kart.z === null || !Number.isFinite(kart.z)) {
      kart.z = g + Math.max(0, kart.air || 0);
      kart.vz = 0;
      kart.gz = null;
    }
    // The ground's own vertical speed under the kart. Steps in the ground (kerbs, the edge of a
    // deck) are clamped to the road's slope, so they are bumps, never a catapult.
    const rv = roadVz(kart, map, q);
    const groundVz = Number.isFinite(kart.gz) ? clamp((g - kart.gz) / dt, rv - 300, rv + 300) : rv;
    if (kart.air > 0) {
      kart.airTime = (kart.airTime || 0) + dt;
      kart.vz -= G * dt;
      kart.z += kart.vz * dt;
      if (kart.z <= g) {
        // Touchdown: carry on at the slope's speed (a descent is not a new crest). A trick in the
        // air pays out as a mini boost.
        kart.landed = -kart.vz;
        kart.z = g; kart.air = 0; kart.vz = groundVz; kart.airTime = 0; kart.trickable = false; kart.hopping = false;
        if (kart.tricked) kart.boost = Math.max(kart.boost || 0, PHYS.trickBoost);
        kart.tricked = false;
      } else {
        kart.air = kart.z - g;
      }
    } else {
      const vz0 = kart.vz || 0;
      const free = kart.z + vz0 * dt - G * dt * dt;
      // Airborne over a crest when the road drops away faster than gravity pulls (the tolerance is
      // an acceleration, so 30 Hz servers and 144 Hz screens agree on when that happens).
      if (free > g + Math.max(CREST_TOL * dt * dt, 0.05) && Math.abs(kart.speed) > 150) {
        kart.vz = vz0 - G * dt;
        kart.z = free;
        kart.air = free - g;
        kart.airTime = 0;
        // Only a proper crest on the road is worth a trick (not a bump on a grassy bank).
        kart.trickable = vz0 > 260 && q.dist <= map.width / 2 + CURB;
      } else {
        kart.vz = groundVz;
        kart.z = g;
        kart.air = 0;
      }
    }
    kart.gz = g;

    const half = map.width / 2;
    if ((grounded || kart.airTime < 0.1 || kart.hopping) && kart.speed > 60 && map.ramps.length && q.dist <= map.wallAt(q) + 2) {
      for (const r of map.ramps) {
        if (r.dir !== 1) continue;
        // Kickers in front of a gap launch everyone between the rails; other ramps only the road.
        if (!r.gap && q.dist > half + CURB) continue;
        let s0 = prevU - r.i;
        let s1 = q.u - r.i;
        if (s0 > map.n / 2) s0 -= map.n; else if (s0 < -map.n / 2) s0 += map.n;
        if (s1 > map.n / 2) s1 -= map.n; else if (s1 < -map.n / 2) s1 += map.n;
        if (s0 < 0 && s1 >= 0 && s0 > -6) {
          // Over the lip: launch. Slow karts only get a little hop.
          kart.vz = Math.max(kart.vz || 0, r.lift * clamp(kart.speed / 330, 0.25, 1));
          kart.air = Math.max(kart.air, 0.5);
          kart.z = g + kart.air;
          kart.airTime = 0;
          kart.trickable = true;
          kart.hopping = false; // a real jump now
          break;
        }
      }
    }

    if (kart.air <= 0) {
      if (!(opts && opts.noFall)) {
        const kind = map.hazardAt(kart.x, kart.y, q);
        if (kind) {
          Object.assign(kart, { fall: PHYS.fallTime, fallKind: kind, speed: 0, drift: 0, driftTime: 0, boost: 0, trick: 0, tricked: false });
          return;
        }
      }
      // Safe ground (road, curb, grass or run-off inside the walls): a fall from here puts you back
      // on the road right beside it, not where you last touched the asphalt.
      if (q.dist <= map.wallAt(q) && !map.gap[q.index]) kart.safeIndex = q.index;
    }
  }

  // Advance a kart by dt seconds. `input` = {up, down, left, right, drift}.
  // Mutates and returns kart {x, y, angle, speed, boost, spin, drift, trackIndex, air, ...}.
  // opts.speed scales top speed, boost speed, acceleration and off-track speed
  // (the room's speed class); it must match on the server and in prediction.
  // opts.noFall: never start a fall (client prediction follows the server for those).
  function stepKart(kart, input, dt, map, opts) {
    const arena = map.type === 'arena';
    if (kart.fall > 0) {
      // In the water/lava: wait to be fished out.
      kart.fall -= dt;
      kart.speed = 0;
      if (kart.fall <= 0) respawnOnTrack(kart, map);
      return kart;
    }
    const mul = opts && Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1;
    // Hop: a tap of the drift button on the ground. Just high enough to clear a banana or a mine
    // if you time it; tap it into a turn and the drift starts as you hop, the way it always did.
    const hopPress = !!input.drift && !kart.hopHeld;
    kart.hopHeld = !!input.drift;
    if (kart.hopCd > 0) kart.hopCd = Math.max(0, kart.hopCd - dt);
    if (hopPress && !(kart.spin > 0) && !(kart.air > 0) && !(kart.hopCd > 0)) {
      kart.hopCd = PHYS.hopCooldown;
      kart.hopping = true;
      kart.vz = (arena ? 0 : kart.vz || 0) + PHYS.hopVz;
      kart.air = 0.5;
      if (!arena && Number.isFinite(kart.z)) kart.z += 0.5;
    }
    const accel = PHYS.accel * mul;
    const maxSpeed = PHYS.maxSpeed * mul;
    const boostSpeed = PHYS.boostSpeed * mul;
    const offTrackMax = PHYS.offTrackMax * mul;
    const grip = map.grip || 1;
    const spinning = kart.spin > 0;
    const air = !arena && kart.air > 0;
    // A hop keeps the grip of the ground: only a real jump (ramp, crest) loses it.
    const flying = air && !kart.hopping;
    const steerMul = flying ? PHYS.airSteer : 1;
    const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    const v0 = kart.speed;
    if (spinning) {
      kart.angle += 9 * dt;
      kart.speed *= Math.max(0, 1 - 4 * dt);
      kart.drift = 0;
      kart.driftTime = 0;
    } else {
      if (flying) kart.speed -= Math.sign(kart.speed) * Math.min(Math.abs(kart.speed), 15 * dt); // no grip, keep momentum
      else if (input.up) kart.speed += accel * dt * (0.6 + 0.4 * grip);
      else if (input.down) kart.speed -= (kart.speed > 0 ? PHYS.brake * grip : accel * 0.6) * dt;
      else kart.speed -= Math.sign(kart.speed) * Math.min(Math.abs(kart.speed), PHYS.drag * 100 * grip * dt);

      // Drifting: hold drift while steering at speed. The kart slides into the
      // turn; the longer you hold it, the bigger the mini-turbo on release.
      if (!flying && !kart.drift && input.drift && steer && kart.speed > PHYS.driftMinSpeed) {
        kart.drift = steer;
        kart.driftTime = 0;
      }
      if (kart.drift) {
        if (!input.drift || kart.speed < PHYS.driftMinSpeed * 0.6) {
          const level = driftLevel(kart.driftTime);
          if (level > 0) kart.boost = Math.max(kart.boost || 0, PHYS.miniTurbo[level - 1]);
          kart.drift = 0;
          kart.driftTime = 0;
        } else {
          if (!flying) kart.driftTime += dt;
          // Steering tightens or widens the drift but never reverses it.
          const tight = 1 + 0.55 * steer * kart.drift;
          kart.angle += kart.drift * PHYS.turnRate * 0.78 * tight * dt * steerMul;
          if (!flying) kart.speed -= 60 * dt;
        }
      } else {
        const g = Math.min(1, Math.abs(kart.speed) / 140);
        kart.angle += steer * PHYS.turnRate * g * (0.75 + 0.25 * grip) * dt * (kart.speed >= 0 ? 1 : -1) * steerMul;
      }
    }
    if (!arena) {
      // Tricks: press drift at take-off or in the air; land it for a mini boost. Only real jumps
      // count: there must be time to finish the flip before touching down.
      if (air && !spinning && input.drift && kart.trickable && !kart.tricked && (!kart.prevDrift || kart.airTime < PHYS.trickWindow)
        && timeToLand(kart) > PHYS.trickTime * 0.6) {
        kart.tricked = true;
        kart.trick = PHYS.trickTime;
      }
      kart.prevDrift = !!input.drift;
      if (kart.trick > 0) kart.trick = Math.max(0, kart.trick - dt);
    }

    // Surface under the kart: 0 road (curbs included), 1 run-off strip, 2 grass.
    let surface = 0;
    let near = null;
    let slope = 0;
    if (!arena) {
      near = map.nearestIndex(kart.x, kart.y, kart.trackIndex);
      kart.trackIndex = near.index;
      const edge = near.dist - map.width / 2;
      surface = flying || edge <= CURB + KART_RADIUS * 0.5 ? 0 : edge <= RUNOFF ? 1 : 2;
      if (!flying && map.grade) {
        // Grade along the kart's heading: + uphill, - downhill.
        const t = map.tangents[near.index];
        const h = kart.heading === undefined ? kart.angle : kart.heading;
        slope = map.grade[near.index] * (Math.cos(h) * t[0] + Math.sin(h) * t[1]);
        kart.speed -= PHYS.slopePull * slope * dt;
      }
    }
    kart.surface = surface;
    if (!flying) {
      for (const p of map.boostPads) {
        if ((kart.x - p.x) ** 2 + (kart.y - p.y) ** 2 < 34 * 34) kart.boost = Math.max(kart.boost || 0, PHYS.padBoost);
      }
    }
    const hill = clamp(1 - slope * PHYS.slopeTop, 0.85, 1.12);
    let max = (kart.boost > 0 ? boostSpeed : maxSpeed) * hill;
    if (kart.boost <= 0 && surface) max = (surface === 2 ? offTrackMax : PHYS.runoffMax * mul) * hill;
    if (kart.boost > 0 && !spinning) kart.speed = Math.max(kart.speed, boostSpeed * 0.95);
    if (kart.speed > max) {
      // Over a surface's cap the throttle does nothing: grass and run-off only ever slow you down.
      const from = surface ? Math.min(kart.speed, v0) : kart.speed;
      kart.speed = Math.max(max, from - (surface ? PHYS.offTrackDecel : PHYS.brake * 1.5) * dt);
    }
    if (kart.speed < PHYS.reverseMax) kart.speed = PHYS.reverseMax;

    // On slippery maps the kart's travel direction lags behind where it points.
    kart.heading = kart.heading === undefined ? kart.angle : kart.heading;
    let dh = kart.angle - kart.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    kart.heading += dh * Math.min(1, dt * 14 * grip * grip * (kart.drift ? 0.55 : 1));
    kart.x += Math.cos(kart.heading) * kart.speed * dt;
    kart.y += Math.sin(kart.heading) * kart.speed * dt;
    // A shove from another kart: extra velocity the kart's own grip doesn't fight; it dies away.
    if (kart.kx || kart.ky) {
      kart.x += kart.kx * dt;
      kart.y += kart.ky * dt;
      const fade = Math.exp(-PHYS.knockDecay * dt);
      kart.kx *= fade;
      kart.ky *= fade;
      if (Math.abs(kart.kx) + Math.abs(kart.ky) < 4) { kart.kx = 0; kart.ky = 0; }
    }

    kart.bump = 0;
    if (arena) {
      kart.bump = collideArena(kart, map, dt);
      if (kart.bump) { kart.kx = 0; kart.ky = 0; }
      // Arena floors are flat: a hop is all the height there is.
      if (kart.air > 0 || kart.vz > 0) {
        kart.vz = (kart.vz || 0) - PHYS.gravity * dt;
        kart.air = Math.max(0, (kart.air || 0) + kart.vz * dt);
        if (kart.air <= 0) { kart.landed = -kart.vz; kart.vz = 0; kart.hopping = false; }
      }
    } else {
      // Hard wall outside the track so nobody gets lost (on bridges: the guard rail). Karts slide along it.
      const after = map.nearestIndex(kart.x, kart.y, kart.trackIndex);
      const wall = map.wallAt ? map.wallAt(after) : map.width / 2 + WALL_PAD;
      if (after.dist > wall) {
        const nx = (after.px - kart.x) / after.dist;
        const ny = (after.py - kart.y) / after.dist;
        const k = wall / after.dist;
        kart.x = after.px + (kart.x - after.px) * k;
        kart.y = after.py + (kart.y - after.py) * k;
        after.dist = wall;
        kart.bump = slideOffWall(kart, nx, ny, dt);
        const kn = (kart.kx || 0) * nx + (kart.ky || 0) * ny;
        if (kn < 0) { kart.kx -= kn * nx; kart.ky -= kn * ny; }
      }
      kart.trackIndex = after.index;
      if (map.surfaceAt) vertical(kart, input, dt, map, after, near.u, opts);
    }

    if (kart.boost > 0) kart.boost = Math.max(0, kart.boost - dt);
    if (kart.spin > 0) kart.spin = Math.max(0, kart.spin - dt);
    return kart;
  }

  return {
    KART_RADIUS, WALL_PAD, CURB, RUNOFF, RAIL, DECK, SPACING, PHYS, ITEMS, ITEM_FX, HAZARDS, MAPS, DEFAULT_MAP,
    getMap, mapList, mapInfo, mapsBuilt, stepKart, driftLevel, itemSpeed, respawnOnTrack, makeRaceMap, timeToLand,
    noise: { vnoise, fbm, smoothstep, polyDist },
  };
});
