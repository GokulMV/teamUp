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
  const EDGE = 40; // edge walls stand this far in from the side of the arena (like the flat arenas)

  const BOX = 0;
  const RAMP = 1;
  const CYL = 2;
  const DIRS = { 'x+': [0, 1], 'x-': [0, -1], 'y+': [1, 1], 'y-': [1, -1] }; // [axis, sign]

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const ease = (u) => u * u * (3 - 2 * u);

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
    return { type: CYL, kind: c.kind || 'stone', x: c.x, y: c.y, r: c.r, z0: Math.min(c.z0, c.z1), z1: Math.max(c.z0, c.z1), src: c, ...extra };
  }
  function contains(s, x, y) {
    if (s.type === CYL) return (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r * s.r;
    return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
  }
  function topAt(s, x, y) {
    if (s.type !== RAMP) return s.z1;
    const p = s.axis ? y : x;
    const lo = s.axis ? s.y0 : s.x0;
    const hi = s.axis ? s.y1 : s.x1;
    let u = clamp((p - lo) / (hi - lo || 1), 0, 1);
    if (s.sign < 0) u = 1 - u;
    return s.zl + (s.zh - s.zl) * u;
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
    for (const b of groundBlocks(def)) solids.push(box(b, 'ground'));
    for (const b of def.blocks || []) solids.push(box(b));
    for (const r of def.ramps || []) solids.push(ramp(r));
    for (const c of def.cyls || []) solids.push(cyl(c));
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
        if (s.z1 < best || !contains(s, x, y)) continue;
        const top = topAt(s, x, y);
        if (top <= zMax && top > best) { best = top; sol = s; }
      }
      out.gx = 0;
      out.gy = 0;
      if (sol && sol.type === RAMP) {
        if (sol.axis) out.gy = sol.grade; else out.gx = sol.grade;
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

    // Lowest underside above zFrom over (x, y) (Infinity: open sky).
    function ceilingAt(x, y, zFrom) {
      let best = Infinity;
      for (const s of near(x, y)) {
        if (s.z0 >= zFrom && s.z0 < best && contains(s, x, y)) best = s.z0;
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
      solids, movers, bumpers, pads, hazards, itemBoxes, spawns, boostPads,
      obstacles: [], // the flat arenas' round obstacles (none here: everything is a solid)
      floorInfo, floorAt, ceilingAt, walls, collide, blocked, hazardAt, padAt, heightAt,
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
        for (const s of map.solids) if ((s.type === CYL ? (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r * s.r : contains(s, x, y))) tops.push([topAt(s, x, y), -1]);
        for (const m of bridges) if (x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1) tops.push([m.z, m.i]);
        tops.sort((a, b) => a[0] - b[0]);
        const list = [];
        for (let k = 0; k < tops.length; k++) {
          const [z, b] = tops[k];
          if (k + 1 < tops.length && tops[k + 1][0] - z < 1) continue; // the same floor twice (seams)
          if (map.ceilingAt(x, y, z + 0.5) - z < KART_H) continue; // no headroom
          if (map.hazardAt(x, y, z)) continue;
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
    // Drive from node a towards (bx, by), following the floor: DRIVE, DROP (went down a ledge) or -1.
    const walk = (a, bx, by, bz) => {
      const ax = xs[a];
      const ay = ys[a];
      let z = zs[a];
      const d = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(2, Math.ceil(d / 8));
      let dropped = false;
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const x = ax + (bx - ax) * u;
        const y = ay + (by - ay) * u;
        const f = map.floorAt(x, y, z + STEP, null);
        if (!Number.isFinite(f) || map.hazardAt(x, y, f)) return -1;
        if (f < z - STEP) dropped = true;
        z = f;
        if (map.walls(x, y, z, KART_R - 4, null) > 0) return -1;
      }
      return Math.abs(z - bz) <= 2 ? (dropped ? DROP : DRIVE) : -1;
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
                const len = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
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
      const push = (id, f) => {
        heap.push([f, id]);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      };
      const pop = () => {
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
      };
      const h = (id) => Math.hypot(xs[id] - xs[to], ys[id] - ys[to]);
      g[from] = 0;
      push(from, h(from));
      while (heap.length) {
        const [, id] = pop();
        if (closed[id]) continue;
        if (id === to) break;
        closed[id] = 1;
        for (const e of adj[id]) {
          const [b, cost] = e;
          if (closed[b] || (avoid && avoid(e, b))) continue;
          const ng = g[id] + cost;
          if (ng < g[b]) { g[b] = ng; prev[b] = id; push(b, ng + h(b)); }
        }
      }
      if (prev[to] < 0) return null;
      const out = [to];
      for (let id = to; prev[id] >= 0; id = prev[id]) out.push(prev[id]);
      return out.reverse();
    }

    // Every node reachable from `from` (following edges forwards, or backwards with `reverse`).
    function reach(from, reverse = false) {
      const seen = new Uint8Array(count);
      let back = null;
      if (reverse) {
        back = Array.from({ length: count }, () => []);
        for (let a = 0; a < count; a++) for (const [b] of adj[a]) back[b].push(a);
      }
      const stack = [from];
      seen[from] = 1;
      while (stack.length) {
        const id = stack.pop();
        for (const e of reverse ? back[id] : adj[id]) {
          const b = reverse ? e : e[0];
          if (!seen[b]) { seen[b] = 1; stack.push(b); }
        }
      }
      return seen;
    }

    return { cell: NAV, n: N, count, xs, ys, zs, bridgeOf, adj, cellNodes, nodeAt, path, reach, DRIVE, DROP, FLY };
  }

  return {
    KART_R, KART_H, STEP, NAV, EDGE, makeLayeredArena, groundBlocks,
  };
});
