// The weekly arena: a new layered battle arena every week, the same for everyone that week.
// The week's number (ISO 8601, in UTC) seeds everything: the look, the name and the layout. The
// layout is built from pieces (plateaus with ramps, decks you can drive under, towers you reach by
// jump pad, two plateaus joined by a bridge, pits, lava or acid pools, cover, bumpers, a sweeper)
// placed round a centrepiece, one quarter (or half) of the arena at a time and turned to fill the
// rest, so every side is the same. Every layout is checked before anyone drives it: each spawn and
// item box stands on its floor, every jump pad lands on one, and a flood fill over the CPU drivers'
// nav grid (every floor, ramp, drop and jump pad) has to reach each spawn and box from every other
// and back, leaving no big part of the arena out of reach or a dead end. A layout that fails is
// thrown away and the next one tried, up to MAX_TRIES.
//
// Shared by the server and the browser like kart-layers.js (loaded after it, before kart-core.js).
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./kart-layers') : root.KartLayers);
  if (node) module.exports = api;
  else root.KartWeekly = api;
})(typeof self !== 'undefined' ? self : this, function (Layers) {
  const { KART_R, STEP, EDGE, turn, symmetric, makeLayeredArena } = Layers;
  const MAX_TRIES = 20;
  const DAY = 86400000;
  const GRADE = 0.3; // ramps rise this much per unit (the Graveyard's stairs are 0.26)

  // ---------- the week ----------
  // The ISO week (Monday to Sunday, UTC) a moment falls in: the Thursday of it decides the year.
  function weekOf(ms = Date.now()) {
    const d = new Date(ms);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dow = new Date(day).getUTCDay() || 7;
    const thursday = new Date(day + (4 - dow) * DAY);
    const year = thursday.getUTCFullYear();
    const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
    return { year, week };
  }
  const weekKey = ({ year, week }) => `${year}-${String(week).padStart(2, '0')}`;
  const parseKey = (key) => {
    const m = /^(\d{4})-(\d{2})$/.exec(key || '');
    return m && +m[2] >= 1 && +m[2] <= 53 ? { year: +m[1], week: +m[2] } : null;
  };
  // Monday 00:00 UTC of an ISO week.
  function mondayOf({ year, week }) {
    const jan4 = Date.UTC(year, 0, 4);
    const dow = new Date(jan4).getUTCDay() || 7;
    return jan4 - (dow - 1) * DAY + (week - 1) * 7 * DAY;
  }
  // When the next week (and its arena) starts.
  const nextWeekAt = (ms = Date.now()) => mondayOf(weekOf(ms)) + 7 * DAY;

  // ---------- randomness (the same on every machine) ----------
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function random(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      range: (lo, hi) => lo + (hi - lo) * next(),
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      pick: (list) => list[Math.floor(next() * list.length)],
      chance: (p) => next() < p,
      // [[weight, value], ...]
      weighted(list) {
        let total = 0;
        for (const [w] of list) total += w;
        let r = next() * total;
        for (const [w, v] of list) if ((r -= w) < 0) return v;
        return list[list.length - 1][1];
      },
    };
  }
  const snap = (v, to = 10) => Math.round(v / to) * to;

  // ---------- looks: a theme, the solids' kinds, what fills the pits, and names ----------
  const LOOKS = [
    {
      theme: 'keep', emoji: '🛡️', liquid: 'water', pool: null,
      first: ['Old', 'High', 'Broken', 'Windy', 'Twin', 'Iron', 'Red', 'Copper'],
      second: ['Bastion', 'Ramparts', 'Citadel', 'Stronghold', 'Bailey', 'Barbican', 'Redoubt', 'Watch'],
    },
    {
      theme: 'ruins', emoji: '🏜️', liquid: 'water', pool: null,
      first: ['Sunken', 'Golden', 'Forgotten', 'Scorched', 'Buried', 'Shifting', 'Lost', 'Amber'],
      second: ['Ziggurat', 'Temple', 'Oasis', 'Ruins', 'Sanctum', 'Colonnade', 'Terraces', 'Steps'],
    },
    {
      theme: 'glacier', emoji: '❄️', liquid: 'water', pool: null,
      first: ['Frozen', 'Glacial', 'Frostbite', 'Shivering', 'Polar', 'Silver', 'Hailstone', 'Whiteout'],
      second: ['Fjord', 'Icefall', 'Bastion', 'Glacier', 'Hollow', 'Crown', 'Terraces', 'Fortress'],
    },
    {
      theme: 'basalt', emoji: '🔥', liquid: 'lava', pool: 'lava',
      first: ['Molten', 'Ashen', 'Smouldering', 'Obsidian', 'Burning', 'Cinder', 'Brimstone', 'Sulphur'],
      second: ['Forge', 'Caldera', 'Crucible', 'Foundry', 'Pits', 'Throne', 'Anvil', 'Furnace'],
    },
    {
      theme: 'graveyard', emoji: '🦇', liquid: 'water', pool: 'acid',
      first: ['Moonlit', 'Silent', 'Restless', 'Hollow', 'Crooked', 'Whispering', 'Midnight', 'Weeping'],
      second: ['Barrows', 'Catacombs', 'Ossuary', 'Necropolis', 'Mausoleum', 'Tombs', 'Crypts', 'Vigil'],
    },
  ];
  // Weeks since a fixed Monday. The looks take turns (3 is coprime with 5, so no look comes back two
  // weeks running and all five come round every five weeks).
  const EPOCH = Date.UTC(2024, 0, 1);
  const weekIndex = (w) => Math.round((mondayOf(w) - EPOCH) / (7 * DAY));
  const lookOf = (w) => LOOKS[(((weekIndex(w) * 3) % LOOKS.length) + LOOKS.length) % LOOKS.length];

  // Name, emoji and look of a week's arena: no layout needed. Each look goes through all 64 of its
  // names before one comes back (c and c + 8m share a first word but never a second).
  function weeklyInfo(key) {
    const w = parseKey(key);
    if (!w) return null;
    const look = lookOf(w);
    const c = (Math.floor(weekIndex(w) / LOOKS.length) + hash(look.theme)) % 64;
    const name = `The ${look.first[c % 8]} ${look.second[(5 * c + (c >> 3)) % 8]}`;
    return { key, week: `${w.year}-W${String(w.week).padStart(2, '0')}`, theme: look.theme, emoji: look.emoji, name };
  }

  // ---------- the pieces ----------
  // A piece works in the north-west quarter of the arena (the layout turns it round to the other
  // three, or to the other half) inside a slot {x0, y0, x1, y1}, on a floor at height P.z. It adds
  // to `part` (blocks, ramps, cyls, pads, bumpers, boosts, hazards, movers, boxes, holes) and to
  // P.tops (spots up high that deserve an item box), and returns a tag (or null: it didn't fit).
  const W = (s) => s.x1 - s.x0;
  const H = (s) => s.y1 - s.y0;

  // A raised floor with a ramp up one side; sometimes a deck on posts you can drive under too.
  function plateau(part, s, P) {
    const { rnd, z } = P;
    const h = rnd.pick([64, 80, 96]);
    const L = snap(h / GRADE);
    const alongX = W(s) - L >= 200 && (H(s) - L < 200 || rnd.chance(0.5));
    const span = (alongX ? W(s) : H(s)) - L; // room for the plateau along the ramp's axis
    if (span < 200) return null;
    const pl = snap(Math.min(span, rnd.range(240, 380)));
    const pw = snap(Math.min(alongX ? H(s) : W(s), rnd.range(240, 360)));
    // Plateau at one end of the slot, the ramp climbing to it from the other.
    const flip = rnd.chance(0.5);
    const a0 = (alongX ? s.x0 : s.y0) + (flip ? L : 0) + snap(rnd.range(0, span - pl));
    const b0 = (alongX ? s.y0 : s.x0) + snap(rnd.range(0, (alongX ? H(s) : W(s)) - pw));
    const deck = h >= 80 && rnd.chance(0.4);
    const rw = Math.min(pw - 40, 130);
    const r0 = b0 + snap(rnd.range(20, pw - rw - 20));
    const top = { z0: deck ? z + h - 20 : z - 40, z1: z + h, kind: deck ? 'deck' : 'stone' };
    const rampAt = flip ? a0 - L : a0 + pl;
    const dir = alongX ? (flip ? 'x+' : 'x-') : (flip ? 'y+' : 'y-');
    const [x0, y0, x1, y1] = alongX ? [a0, b0, a0 + pl, b0 + pw] : [b0, a0, b0 + pw, a0 + pl];
    part.blocks.push({ x0, y0, x1, y1, ...top });
    if (alongX) part.ramps.push({ x0: rampAt, y0: r0, x1: rampAt + L, y1: r0 + rw, z0: z, z1: z + h, dir, base: z - 20, kind: 'stair' });
    else part.ramps.push({ x0: r0, y0: rampAt, x1: r0 + rw, y1: rampAt + L, z0: z, z1: z + h, dir, base: z - 20, kind: 'stair' });
    if (deck) {
      // Posts at the corners hold the deck up; the space under it is a covered lane.
      for (const [px, py] of [[x0 + 26, y0 + 26], [x1 - 26, y0 + 26], [x0 + 26, y1 - 26], [x1 - 26, y1 - 26]]) {
        part.cyls.push({ x: px, y: py, r: 16, z0: z - 40, z1: z + h - 20, kind: 'pillar' });
      }
    } else if (pl >= 280 && pw >= 280) {
      // Low walls along the far edge to hide behind up there.
      const far = flip ? (alongX ? x1 : y1) : (alongX ? x0 : y0);
      const c = alongX ? (y0 + y1) / 2 : (x0 + x1) / 2;
      const f0 = far + (flip ? -34 : 4);
      if (alongX) part.blocks.push({ x0: f0, y0: c - 60, x1: f0 + 30, y1: c + 60, z0: z + h, z1: z + h + 30, kind: 'wall' });
      else part.blocks.push({ x0: c - 60, y0: f0, x1: c + 60, y1: f0 + 30, z0: z + h, z1: z + h + 30, kind: 'wall' });
    }
    P.tops.push({ x: snap((x0 + x1) / 2, 2), y: snap((y0 + y1) / 2, 2), z: z + h });
    return deck ? 'deck' : 'plateau';
  }

  // A tower you can only get onto by jump pad (and off by driving over the edge).
  function perch(part, s, P) {
    const { rnd, z } = P;
    const t = snap(rnd.range(70, 90), 5);
    const h = rnd.pick([150, 170, 190]);
    const D = snap(rnd.range(230, 280));
    // Tower in the slot's outer corner, the pad towards the open side.
    const dirs = [[1, 1], [1, 0], [0, 1]].filter(([dx, dy]) => W(s) >= 2 * t + (dx ? D : 0) + 80 && H(s) >= 2 * t + (dy ? D : 0) + 80);
    if (!dirs.length) return null;
    const [dx, dy] = rnd.pick(dirs);
    const n = Math.hypot(dx, dy);
    const cx = s.x0 + t + 40 + (dx ? 0 : snap(rnd.range(0, W(s) - 2 * t - 80)));
    const cy = s.y0 + t + 40 + (dy ? 0 : snap(rnd.range(0, H(s) - 2 * t - 80)));
    part.blocks.push({ x0: cx - t, y0: cy - t, x1: cx + t, y1: cy + t, z0: z - 40, z1: z + h, kind: 'tower' });
    // Battlements on the corners: cover for whoever holds it.
    for (const [ex, ey] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const bx = cx + ex * (t - 14);
      const by = cy + ey * (t - 14);
      part.blocks.push({ x0: bx - 14, y0: by - 14, x1: bx + 14, y1: by + 14, z0: z + h, z1: z + h + 30, kind: 'merlon' });
    }
    part.pads.push({ x: snap(cx + (dx / n) * D, 2), y: snap(cy + (dy / n) * D, 2), z, r: 40, to: [cx, cy, z + h], t: 1.05 });
    P.tops.push({ x: cx, y: cy, z: z + h });
    return 'perch';
  }

  // Two plateaus at the ends of a long slot with a bridge between them: a lane under the bridge,
  // a ramp up the near plateau, and the far one only reachable over the bridge (or by dropping on).
  function twin(part, s, P) {
    const { rnd, z } = P;
    const alongX = W(s) >= H(s);
    const len = alongX ? W(s) : H(s);
    const wide = alongX ? H(s) : W(s);
    const h = rnd.pick([80, 96]);
    const L = snap(h / GRADE);
    const a = snap(rnd.range(180, 230));
    const gap = Math.min(len - 2 * a, 420);
    const d = snap(rnd.range(200, 240));
    if (gap < 170 || wide < d + L + 20) return null;
    const start = (alongX ? s.x0 : s.y0) + snap((len - 2 * a - gap) / 2);
    // The plateaus sit on the slot's outer edge; the ramp comes off the near one towards the middle.
    const b0 = alongX ? s.y0 : s.x0;
    const ends = [start, start + a + gap];
    const near = rnd.int(0, 1);
    const bw = 120;
    const mid = b0 + (d - bw) / 2;
    for (const p0 of ends) {
      if (alongX) part.blocks.push({ x0: p0, y0: b0, x1: p0 + a, y1: b0 + d, z0: z - 40, z1: z + h, kind: 'stone' });
      else part.blocks.push({ x0: b0, y0: p0, x1: b0 + d, y1: p0 + a, z0: z - 40, z1: z + h, kind: 'stone' });
    }
    const g0 = start + a;
    if (alongX) part.blocks.push({ x0: g0, y0: mid, x1: g0 + gap, y1: mid + bw, z0: z + h - 18, z1: z + h, kind: 'bridge' });
    else part.blocks.push({ x0: mid, y0: g0, x1: mid + bw, y1: g0 + gap, z0: z + h - 18, z1: z + h, kind: 'bridge' });
    const n0 = ends[near] + (a - 120) / 2;
    if (alongX) part.ramps.push({ x0: n0, y0: b0 + d, x1: n0 + 120, y1: b0 + d + L, z0: z, z1: z + h, dir: 'y-', base: z - 20, kind: 'stair' });
    else part.ramps.push({ x0: b0 + d, y0: n0, x1: b0 + d + L, y1: n0 + 120, z0: z, z1: z + h, dir: 'x-', base: z - 20, kind: 'stair' });
    const farEnd = ends[1 - near] + a / 2;
    const c = b0 + d / 2;
    P.tops.push(alongX ? { x: farEnd, y: c, z: z + h } : { x: c, y: farEnd, z: z + h });
    // A box under the bridge, in the covered lane.
    const under = g0 + gap / 2;
    part.boxes.push(alongX ? { x: under, y: c, z } : { x: c, y: under, z });
    return 'bridge';
  }

  // A hole in the ground into the water (or lava) below, with bumpers to knock people in.
  function pit(part, s, P) {
    const { rnd, z } = P;
    if (z !== 0) return null; // only the ground has holes
    const w = snap(Math.min(W(s) - 120, rnd.range(180, 280)));
    const d = snap(Math.min(H(s) - 120, rnd.range(150, 240)));
    if (w < 150 || d < 130) return null;
    const x0 = s.x0 + snap(rnd.range(60, W(s) - w - 60));
    const y0 = s.y0 + snap(rnd.range(60, H(s) - d - 60));
    part.holes.push({ x0, y0, x1: x0 + w, y1: y0 + d });
    const cx = x0 + w / 2;
    const cy = y0 + d / 2;
    // Bumpers off two corners, far enough out to drive between them and the edge.
    for (const [ex, ey] of rnd.pick([[[1, 1], [-1, -1]], [[1, -1], [-1, 1]]])) {
      const bx = cx + ex * (w / 2 + 70);
      const by = cy + ey * (d / 2 + 70);
      if (bx > s.x0 + 30 && bx < s.x1 - 30 && by > s.y0 + 30 && by < s.y1 - 30) part.bumpers.push({ x: snap(bx, 2), y: snap(by, 2), z: 0, r: 30 });
    }
    return 'pit';
  }

  // A pool of lava (or acid).
  function pool(part, s, P) {
    const { rnd, z, look } = P;
    if (!look.pool) return null;
    const w = snap(Math.min(W(s) - 120, rnd.range(170, 260)));
    const d = snap(Math.min(H(s) - 120, rnd.range(140, 220)));
    if (w < 140 || d < 120) return null;
    const x0 = s.x0 + snap(rnd.range(60, W(s) - w - 60));
    const y0 = s.y0 + snap(rnd.range(60, H(s) - d - 60));
    part.hazards.push({ x0, y0, x1: x0 + w, y1: y0 + d, z, kind: look.pool });
    return 'pool';
  }

  // Crates and a low wall to hide behind.
  function cover(part, s, P) {
    const { rnd, z } = P;
    const spots = [];
    for (let i = 0; i < 40 && spots.length < 5; i++) {
      const long = rnd.chance(0.3);
      const w = long ? snap(rnd.range(150, 200)) : snap(rnd.range(60, 90));
      const d = long ? 30 : w;
      const [sw, sd] = rnd.chance(0.5) ? [w, d] : [d, w];
      const x = s.x0 + 40 + snap(rnd.range(0, W(s) - sw - 80));
      const y = s.y0 + 40 + snap(rnd.range(0, H(s) - sd - 80));
      // Kart-and-a-half gaps at least, so nobody gets wedged.
      if (spots.some((o) => x < o.x + o.w + 110 && x + sw + 110 > o.x && y < o.y + o.d + 110 && y + sd + 110 > o.y)) continue;
      spots.push({ x, y, w: sw, d: sd, long });
    }
    if (spots.length < 2) return null;
    for (const o of spots) part.blocks.push({ x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.d, z0: z - 40, z1: z + (o.long ? 50 : rnd.pick([46, 56])), kind: o.long ? 'wall' : 'crate' });
    return 'cover';
  }

  // A triangle of pinball bumpers with a boost pad through the middle.
  function bumpers(part, s, P) {
    const { rnd, z } = P;
    if (W(s) < 300 || H(s) < 300) return null;
    const cx = snap((s.x0 + s.x1) / 2, 2);
    const cy = snap((s.y0 + s.y1) / 2, 2);
    const a = rnd.range(0, Math.PI * 2);
    for (let i = 0; i < 3; i++) {
      const b = a + (i * Math.PI * 2) / 3;
      part.bumpers.push({ x: snap(cx + Math.cos(b) * 100, 2), y: snap(cy + Math.sin(b) * 100, 2), z, r: 28 });
    }
    part.boosts.push({ x: cx, y: cy, z, angle: snap(a + Math.PI / 3, 0.01) });
    return 'bumpers';
  }

  // A sweeper: arms going round a hub.
  function sweeper(part, s, P) {
    const { rnd, z } = P;
    const len = snap(rnd.range(120, 160));
    if (W(s) < 2 * len + 80 || H(s) < 2 * len + 80) return null;
    part.movers.push({
      type: 'sweeper', x: snap((s.x0 + s.x1) / 2, 2), y: snap((s.y0 + s.y1) / 2, 2), z, len, w: 10, lo: 6, hi: 22, arms: 2,
      speed: snap(rnd.range(1.1, 1.5) * (rnd.chance(0.5) ? 1 : -1), 0.05), phase: snap(rnd.next(), 0.01), hub: 26,
    });
    return 'sweeper';
  }

  const PIECES = { plateau, perch, twin, pit, pool, cover, bumpers, sweeper };

  // ---------- centrepieces (built whole: they are symmetric already) ----------
  // `lim`: how far a centrepiece may reach from the middle along the middle lines (axis) and the
  // diagonals (diag, as a square's half-size). Each returns what it reached, or null if it can't fit.
  function hub(def, Q, lim) {
    const { C, rnd } = Q;
    let h = rnd.pick([90, 110]);
    if (snap(h / GRADE) + 170 > lim.axis) h = 64;
    const L = snap(h / GRADE);
    const R = snap(Math.min(rnd.range(190, 250), lim.axis - L, lim.diag - 60));
    if (R < 170) return null;
    def.blocks.push({ x0: C - R, y0: C - R, x1: C + R, y1: C + R, z0: -40, z1: h, kind: 'stone' });
    symmetric(def, { ramps: [{ x0: C - 60, y0: C - R - L, x1: C + 60, y1: C - R, z0: 0, z1: h, dir: 'y+', base: -20, kind: 'stair' }] }, Q.S);
    def.cyls.push({ x: C, y: C, r: 34, z0: h, z1: h + 60, kind: 'pillar' });
    def.deco.push({ kind: 'crown', x: C, y: C, z: h + 60 });
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) Q.tops.push({ x: C + (dx * R) / 2, y: C + (dy * R) / 2, z: h });
    return { axis: R + L, diag: R + 60, tag: 'hub' };
  }
  function moat(def, Q, lim) {
    const { C, rnd } = Q;
    const ring = snap(rnd.range(130, 170));
    const R = snap(Math.min(rnd.range(220, 270), Math.min(lim.axis, lim.diag) - ring - 60));
    if (R < 200) return null;
    const O = R + ring;
    def.ground.holes.push(
      { x0: C - O, y0: C - O, x1: C + O, y1: C - R }, { x0: C - O, y0: C + R, x1: C + O, y1: C + O },
      { x0: C - O, y0: C - R, x1: C - R, y1: C + R }, { x0: C + R, y0: C - R, x1: C + O, y1: C + R },
    );
    // Four causeways over the gap, with parapets.
    symmetric(def, {
      blocks: [
        { x0: C - 75, y0: C - O - 20, x1: C + 75, y1: C - R + 20, z0: -18, z1: 0, kind: 'bridge' },
        { x0: C - 75, y0: C - O, x1: C - 59, y1: C - R, z0: -18, z1: 28, kind: 'merlon' },
        { x0: C + 59, y0: C - O, x1: C + 75, y1: C - R, z0: -18, z1: 28, kind: 'merlon' },
      ],
    }, Q.S);
    def.movers.push({ type: 'sweeper', x: C, y: C, z: 0, len: R - 50, w: 10, lo: 6, hi: 22, arms: 2, speed: snap(rnd.range(1.0, 1.3), 0.05), phase: 0, hub: 30 });
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) def.boxes.push({ x: C + dx * (R - 50), y: C + dy * (R - 50), z: 0 });
    return { axis: O + 60, diag: O + 60, tag: 'moat' };
  }
  function spire(def, Q, lim) {
    const { C, rnd } = Q;
    const T = snap(Math.min(rnd.range(110, 140), lim.axis - 170, (lim.diag - 50) * Math.SQRT2 - 230));
    if (T < 100) return null;
    const z = rnd.pick([170, 200]);
    def.blocks.push({ x0: C - T, y0: C - T, x1: C + T, y1: C + T, z0: -40, z1: z, kind: 'tower' });
    def.deco.push({ kind: 'crown', x: C, y: C, z });
    const D = T + 230;
    const pad = { x: snap(C - D * Math.SQRT1_2, 2), y: snap(C - D * Math.SQRT1_2, 2), z: 0, r: 40, to: [C - 40, C - 40, z], t: 1.1 };
    symmetric(def, { pads: [pad] }, Q.S);
    // Low walls round the foot, between the pads.
    symmetric(def, { blocks: [{ x0: C - 70, y0: C - T - 150, x1: C + 70, y1: C - T - 120, z0: -40, z1: 50, kind: 'wall' }] }, Q.S);
    Q.tops.push({ x: C + 40, y: C + 40, z });
    return { axis: T + 160, diag: Math.ceil(D * Math.SQRT1_2) + 50, tag: 'spire' };
  }
  function bowl(def, Q, lim) {
    const { C, rnd } = Q;
    const len = snap(Math.min(rnd.range(170, 210), lim.axis - 140, (lim.diag - 40) * Math.SQRT2 - 150));
    if (len < 130) return null;
    def.movers.push({ type: 'sweeper', x: C, y: C, z: 0, len, w: 10, lo: 6, hi: 22, arms: rnd.pick([2, 3]), speed: snap(rnd.range(1.0, 1.3), 0.05), phase: 0, hub: 30 });
    const D = len + 150;
    symmetric(def, { bumpers: [{ x: snap(C - D * Math.SQRT1_2, 2), y: snap(C - D * Math.SQRT1_2, 2), z: 0, r: 30 }] }, Q.S);
    symmetric(def, { boosts: [{ x: C, y: C - len - 90, z: 0, angle: 0 }] }, Q.S);
    return { axis: len + 130, diag: Math.ceil(D * Math.SQRT1_2) + 40, tag: 'bowl' };
  }
  const CENTRES = { hub, moat, spire, bowl };

  // ---------- architectures: the arena's big shape ----------
  // Each builds its shape whole (symmetric already) and says where the centrepiece and the pieces
  // go: `lim` for the centrepiece, then slots(centre) -> [{name, s, z}] in the north-west quarter,
  // the floor levels spawns stand on, and which centrepieces suit it.
  const M = 110; // pieces keep this far in from the arena's edge
  const G = 90; // and this far from the middle lines

  // A walled courtyard: a wall walk all round with a gate in each side and a bridge over every gate
  // (a covered way under it), ramps up the inside of the walls and sometimes the outside.
  function ring(Q) {
    const { def, C, rnd, S } = Q;
    const Rw = snap(C * rnd.range(0.46, 0.52));
    const T = 110;
    const top = rnd.pick([80, 96]);
    const gate = 240;
    const o = C - Rw - T; // the wall's outer face
    const part = { blocks: [], ramps: [] };
    part.blocks.push(
      { x0: o, y0: o, x1: C - gate / 2, y1: C - Rw, z0: -40, z1: top, kind: 'wall' },
      { x0: o, y0: C - Rw, x1: C - Rw, y1: C - gate / 2, z0: -40, z1: top, kind: 'wall' },
    );
    // Battlements along the outer edge of the walk: cover, and the walk inside stays 90 wide.
    for (let x = o + 30; x + 40 <= C - gate / 2 - 20; x += 90) part.blocks.push({ x0: x, y0: o, x1: x + 40, y1: o + 20, z0: top, z1: top + 26, kind: 'merlon' });
    for (let y = o + 120; y + 40 <= C - gate / 2 - 20; y += 90) part.blocks.push({ x0: o, y0: y, x1: o + 20, y1: y + 40, z0: top, z1: top + 26, kind: 'merlon' });
    // A ramp up the inside of the north wall, to the gate or to the corner.
    const L = snap(top / GRADE);
    const toGate = rnd.chance(0.5);
    const xa = toGate ? C - gate / 2 - L : C - Rw;
    part.ramps.push({ x0: xa, y0: C - Rw, x1: xa + L, y1: C - Rw + 100, z0: 0, z1: top, dir: toGate ? 'x+' : 'x-', base: -20, kind: 'stair' });
    // Sometimes one up the outside of the west wall as well.
    const outer = rnd.chance(0.5);
    if (outer) {
      const ya = snap(rnd.range(o + 160, C - gate / 2 - 60 - L));
      part.ramps.push({ x0: o - 100, y0: ya, x1: o, y1: ya + L, z0: 0, z1: top, dir: rnd.chance(0.5) ? 'y+' : 'y-', base: -20, kind: 'stair' });
    }
    symmetric(def, part, S);
    symmetric(def, { blocks: [{ x0: C - gate / 2, y0: o, x1: C + gate / 2, y1: C - Rw, z0: top - 18, z1: top, kind: 'bridge' }] }, S);
    Q.tags.push('ring');
    return {
      lim: { axis: Rw - 130, diag: Rw - 170 },
      centres: [[3, 'hub'], [2, 'spire'], [2, 'bowl'], [1, 'moat']],
      levels: [0],
      slots: (c) => [
        { name: 'corner', z: 0, s: { x0: M, y0: M, x1: o - 70, y1: o - 70 } },
        { name: 'side', z: 0, s: { x0: M, y0: o + 90, x1: o - 170, y1: C - G } },
        { name: 'side', z: 0, s: { x0: o + 90, y0: M, x1: C - G, y1: o - 170 } },
        { name: 'yard', z: 0, s: { x0: C - Rw + 140, y0: C - Rw + 140, x1: C - c.diag - G, y1: C - c.diag - G } },
      ],
    };
  }

  // A sunken bowl in the middle with high terraces all round it, a wide ramp up on every side.
  function terraces(Q) {
    const { def, C, rnd, S } = Q;
    const Rb = snap(C * rnd.range(0.5, 0.56));
    const up = rnd.pick([56, 64]);
    const L = snap(up / GRADE);
    const rw = 100; // half the ramps' width
    const t = { z0: -40, z1: up, kind: 'terrace' };
    // The north-west quarter's share: the north band's west part (with the corner), the west band's
    // north part, the bits beyond the ramps' tops and half of each ramp; turned, they meet up.
    symmetric(def, {
      blocks: [
        { x0: 0, y0: 0, x1: C - rw, y1: C - Rb, ...t },
        { x0: 0, y0: C - Rb, x1: C - Rb, y1: C - rw, ...t },
        { x0: C - rw, y0: 0, x1: C, y1: C - Rb - L, ...t },
        { x0: 0, y0: C - rw, x1: C - Rb - L, y1: C, ...t },
      ],
      ramps: [
        { x0: C - rw, y0: C - Rb - L, x1: C, y1: C - Rb, z0: 0, z1: up, dir: 'y-', base: -20, kind: 'stair' },
        { x0: C - Rb - L, y0: C - rw, x1: C - Rb, y1: C, z0: 0, z1: up, dir: 'x-', base: -20, kind: 'stair' },
      ],
    }, S);
    Q.tags.push('terraces');
    return {
      lim: { axis: Rb - 130, diag: Rb - 150 },
      centres: [[3, 'hub'], [2, 'spire'], [3, 'bowl'], [1, 'moat']],
      levels: [up, 0],
      slots: (c) => [
        { name: 'corner', z: up, s: { x0: M, y0: M, x1: C - Rb - 70, y1: C - Rb - 70 } },
        { name: 'side', z: up, s: { x0: C - Rb + 10, y0: M, x1: C - rw - 70, y1: C - Rb - 70 } },
        { name: 'side', z: up, s: { x0: M, y0: C - Rb + 10, x1: C - Rb - 70, y1: C - rw - 70 } },
        { name: 'yard', z: 0, s: { x0: C - Rb + 70, y0: C - Rb + 70, x1: C - c.diag - G, y1: C - c.diag - G } },
      ],
    };
  }

  // Islands: water (or lava) all round the middle and down the middle lines, so the four corners
  // and the middle are islands, joined by bridges and jump pads.
  function islands(Q) {
    const { def, C, rnd, S } = Q;
    const Ri = snap(C * rnd.range(0.3, 0.34));
    const mw = snap(rnd.range(170, 210));
    const cw = snap(rnd.range(170, 210));
    const e = C - Ri - mw; // where the moat starts
    for (const k of [0, 1, 2, 3]) {
      for (const h of [
        { x0: e, y0: e, x1: C, y1: C - Ri }, { x0: e, y0: C - Ri, x1: C - Ri, y1: C },
        { x0: C - cw / 2, y0: 0, x1: C, y1: e }, { x0: 0, y0: C - cw / 2, x1: e, y1: C },
      ]) def.ground.holes.push(turn(h, S, k));
    }
    // A bridge over the north channel and one over the north side of the moat (off to one side:
    // turned, the moat's bridges make a pinwheel), and a jump pad from the corner to the middle.
    const yb = snap(rnd.range(320, e - 240));
    const xb = snap(rnd.range(C - Ri * 0.7, C - cw / 2 - 125));
    // Low parapets along the bridges: nobody drives off one by mistake (though a hit at either end
    // still puts you in).
    const rail = (x0, y0, x1, y1) => ({ x0, y0, x1, y1, z0: -18, z1: 28, kind: 'merlon' });
    symmetric(def, {
      blocks: [
        { x0: C - cw / 2 - 30, y0: yb - 85, x1: C + cw / 2 + 30, y1: yb + 85, z0: -18, z1: 0, kind: 'bridge' },
        rail(C - cw / 2 - 10, yb - 85, C + cw / 2 + 10, yb - 69), rail(C - cw / 2 - 10, yb + 69, C + cw / 2 + 10, yb + 85),
        { x0: xb - 85, y0: e - 30, x1: xb + 85, y1: C - Ri + 30, z0: -18, z1: 0, kind: 'bridge' },
        rail(xb - 85, e - 10, xb - 69, C - Ri + 10), rail(xb + 69, e - 10, xb + 85, C - Ri + 10),
      ],
      pads: [{ x: e - 170, y: e - 170, z: 0, r: 40, to: [C - Ri + 110, C - Ri + 110, 0], t: 1 }],
    }, S);
    Q.tags.push('islands');
    // The middle island keeps a wide ring of open ground round its centrepiece: everyone arrives
    // there off a bridge or a jump pad with water just behind them.
    return {
      lim: { axis: Ri - 220, diag: Ri - 200 },
      centres: [[2, 'spire'], [3, 'bowl']],
      levels: [0],
      slots: () => [
        { name: 'corner', z: 0, s: { x0: M, y0: M, x1: e - 260, y1: e - 260 } },
        { name: 'side', z: 0, s: { x0: e + 20, y0: M, x1: C - cw / 2 - 80, y1: e - 80 } },
        { name: 'side', z: 0, s: { x0: M, y0: e + 20, x1: e - 80, y1: C - cw / 2 - 80 } },
      ],
    };
  }

  // Open ground: pieces everywhere round the centrepiece.
  function open(Q) {
    const { C } = Q;
    const w = snap(C * 0.38);
    const lane = 160;
    Q.tags.push('open');
    return {
      lim: { axis: C * 0.45, diag: C * 0.4 },
      centres: [[3, 'hub'], [2, 'moat'], [2, 'spire'], [2, 'bowl']],
      levels: [0],
      slots: (c) => [
        { name: 'corner', z: 0, s: { x0: M, y0: M, x1: M + w, y1: M + w } },
        { name: 'side', z: 0, s: { x0: M, y0: M + w + lane, x1: M + w, y1: C - G } },
        { name: 'side', z: 0, s: { x0: M + w + lane, y0: M, x1: C - G, y1: M + w } },
        { name: 'yard', z: 0, s: { x0: M + w + lane, y0: M + w + lane, x1: Math.min(C - G, C - c.diag - G), y1: Math.min(C - G, C - c.diag - G) } },
      ],
    };
  }
  const PLANS = { ring, terraces, islands, open };
  // What may go where (weights).
  const MENU = {
    corner: [[3, 'plateau'], [3, 'perch'], [1, 'cover'], [1, 'pit'], [1, 'pool']],
    side: [[3, 'twin'], [2, 'plateau'], [1, 'perch'], [2, 'pit'], [1, 'pool'], [1, 'bumpers'], [1, 'cover']],
    yard: [[2, 'cover'], [2, 'bumpers'], [1, 'pool'], [1, 'perch'], [2, 'sweeper'], [1, 'pit']],
  };

  // ---------- one layout ----------
  function layout(key, attempt) {
    const look = lookOf(parseKey(key));
    const rnd = random(hash(`weekly:${key}:${attempt}`));
    const planName = rnd.weighted([[3, 'ring'], [2, 'terraces'], [2, 'islands'], [2, 'open']]);
    const S = planName === 'open' ? rnd.pick([2800, 3200]) : 3200;
    const C = S / 2;
    const def = {
      size: S, edge: 'wall', deathZ: -320, theme: look.theme,
      ground: { z: 0, kind: 'ground', holes: [] },
      blocks: [], ramps: [], cyls: [], pads: [], bumpers: [], boosts: [], hazards: [], movers: [], boxes: [], spawns: [], deco: [],
    };
    const Q = { def, S, C, rnd, look, tags: [], tops: [] };
    const plan = PLANS[planName](Q);
    // The centrepiece: the first of the suitable ones (in a random order) that fits.
    let centre = null;
    const menu = plan.centres.slice();
    while (!centre && menu.length) {
      const name = rnd.weighted(menu);
      menu.splice(menu.findIndex(([, n]) => n === name), 1);
      centre = CENTRES[name](def, Q, plan.lim);
    }
    if (!centre) centre = { axis: 0, diag: 0, tag: null };
    if (centre.tag) Q.tags.push(centre.tag);
    // The pieces: one per slot, in the north-west quarter, or the north half (two quarters with
    // pieces of their own) for open ground now and then.
    const halves = planName === 'open' && rnd.chance(0.35);
    const blank = () => ({ blocks: [], ramps: [], cyls: [], pads: [], bumpers: [], boosts: [], hazards: [], movers: [], boxes: [], holes: [], tops: [] });
    const fill = (part) => {
      for (const sl of plan.slots(centre)) {
        if (W(sl.s) < 220 || H(sl.s) < 220) continue;
        const menu = MENU[sl.name].filter(([, p]) => (p !== 'pool' || look.pool) && (p !== 'pit' || sl.z === 0));
        for (let i = 0; i < 4; i++) {
          const tag = PIECES[rnd.weighted(menu)](part, sl.s, { rnd, look, z: sl.z, tops: part.tops });
          if (tag) { Q.tags.push(tag); break; }
        }
      }
    };
    const part = blank();
    fill(part);
    let turns = [0, 1, 2, 3];
    if (halves) {
      const b = blank();
      fill(b);
      for (const [k, list] of Object.entries(b)) for (const o of list) part[k].push(turn(o, S, 1));
      turns = [0, 2];
    }
    const { holes, tops, ...rest } = part;
    symmetric(def, rest, S, turns);
    for (const t of turns) for (const h of holes) def.ground.holes.push(turn(h, S, t));
    for (const t of turns) for (const p of tops) Q.tops.push(turn(p, S, t));
    if (def.ground.holes.length || def.hazards.some((h) => h.kind === 'lava')) def.liquid = { kind: look.liquid, z: -46 };
    return { def, rnd, tags: Q.tags, tops: Q.tops, turns, S, C, look, levels: plan.levels, plan: planName };
  }

  // ---------- clutter, spawns and item boxes: open spots, spread out ----------
  // Spots on one of `levels` with room round them: no wall within `clear`, floor all round (no pit
  // or ledge), clear of pads, bumpers, sweepers and the feet and tops of ramps.
  function openSpots(map, region, opts) {
    const { levels = [0], step = 60, clear = KART_R + 34, keep = [], min = 200, n, ramps = [], first } = opts;
    const cands = [];
    for (let y = region.y0; y <= region.y1; y += step) {
      for (let x = region.x0; x <= region.x1; x += step) {
        const z = map.floorAt(x, y, 1e4, 0);
        if (!levels.includes(z) || map.hazardAt(x, y, z)) continue;
        if (map.walls(x, y, z, clear, null) > 0) continue;
        let ok = true;
        for (let a = 0; a < 8 && ok; a++) {
          const px = x + Math.cos((a * Math.PI) / 4) * 110;
          const py = y + Math.sin((a * Math.PI) / 4) * 110;
          const f = map.floorAt(px, py, z + STEP, 0);
          if (Math.abs(f - z) > STEP || map.hazardAt(px, py, f)) ok = false;
        }
        if (!ok) continue;
        if (map.pads.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + 140 || Math.hypot(p.tx - x, p.ty - y) < 140)) continue;
        if (map.bumpers.some((b) => Math.hypot(b.x - x, b.y - y) < b.r + 110)) continue;
        if (map.movers.some((mv) => mv.type === 'sweeper' && Math.hypot(mv.x - x, mv.y - y) < mv.len + 90)) continue;
        if (ramps.some((r) => x > r.x0 - 130 && x < r.x1 + 130 && y > r.y0 - 130 && y < r.y1 + 130)) continue;
        cands.push({ x, y, z });
      }
    }
    // Farthest-point picking.
    const out = [];
    const taken = keep.slice();
    while (out.length < n && cands.length) {
      let best = -1;
      let bestD = -1;
      for (let i = 0; i < cands.length; i++) {
        let d = Infinity;
        for (const t of taken) d = Math.min(d, Math.hypot(t.x - cands[i].x, t.y - cands[i].y) + Math.abs(t.z - cands[i].z));
        if (!taken.length) d = Math.hypot(cands[i].x - first.x, cands[i].y - first.y);
        if (d > bestD) { bestD = d; best = i; }
      }
      if (bestD < min) break;
      const p = cands.splice(best, 1)[0];
      out.push(p);
      taken.push(p);
    }
    return out;
  }

  function place(Lo) {
    const { def, tops, turns, S, C, rnd, levels } = Lo;
    const region = turns.length === 4 ? { x0: 120, y0: 120, x1: C - 60, y1: C - 60 } : { x0: 120, y0: 120, x1: S - 120, y1: C - 60 };
    const mine = (p) => p.x >= region.x0 - 60 && p.x <= region.x1 + 60 && p.y >= region.y0 - 60 && p.y <= region.y1 + 60;
    const each = (p, fn) => { for (const t of turns) fn(turn(p, S, t)); };
    // Clutter first (crates and pillars on open ground), then spawns round it, then boxes.
    const bare = makeLayeredArena({ ...def, boxes: [], spawns: [] });
    const fromCentre = { x: C, y: C, z: 0 };
    const clutter = openSpots(bare, region, {
      levels, clear: 110, min: 230, n: (turns.length === 4 ? 1 : 2) * rnd.int(3, 5), ramps: bare.solids.filter((s) => s.type === 1),
      keep: [...def.boxes, ...tops].filter(mine), first: fromCentre,
    });
    for (const p of clutter) {
      if (rnd.chance(0.55)) {
        const r = snap(rnd.range(26, 36), 2);
        const crate = { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r, z0: p.z - 40, z1: p.z + rnd.pick([46, 56]), kind: 'crate' };
        each(crate, (q) => def.blocks.push(q));
      } else {
        each({ x: p.x, y: p.y, r: 24, z0: p.z - 40, z1: p.z + 120, kind: 'column' }, (q) => def.cyls.push(q));
      }
    }
    const map = makeLayeredArena({ ...def, boxes: [], spawns: [] });
    // Spawns face the middle.
    const per = turns.length === 4 ? 6 : 12;
    const corner = { x: region.x0, y: region.y0, z: 0 };
    const spots = openSpots(map, region, { levels, n: per, min: 180, first: corner });
    for (const p of spots) {
      each({ x: p.x, y: p.y }, (q) => def.spawns.push({ x: q.x, y: q.y, z: p.z, angle: Math.round(Math.atan2(C - q.y, C - q.x) * 100) / 100 }));
    }
    // Boxes: the high spots, and a few out in the open.
    for (const t of tops) def.boxes.push({ x: t.x, y: t.y, z: t.z });
    const ground = openSpots(map, region, {
      levels, n: turns.length === 4 ? 3 : 6, min: 240, keep: [...spots, ...def.boxes.filter(mine), fromCentre], first: corner,
    });
    for (const p of ground) each({ x: p.x, y: p.y }, (q) => def.boxes.push({ x: q.x, y: q.y, z: p.z }));
    return def;
  }

  // ---------- the check ----------
  function check(def) {
    const map = makeLayeredArena(def);
    const why = [];
    if (def.spawns.length < 16) why.push(`only ${def.spawns.length} spawns`);
    if (def.boxes.length < 16) why.push(`only ${def.boxes.length} boxes`);
    // Inside the edge walls, where a kart can be.
    const lo = EDGE + KART_R;
    const hi = def.size - lo;
    const inside = (x, y) => x >= lo && y >= lo && x <= hi && y <= hi;
    for (const [what, list] of [['spawn', def.spawns], ['box', def.boxes]]) {
      list.forEach((p, i) => {
        const f = map.floorAt(p.x, p.y, p.z + STEP, 0);
        if (!inside(p.x, p.y)) why.push(`${what} ${i} outside the walls`);
        if (Math.abs(f - p.z) > 0.01) why.push(`${what} ${i} floor ${f} not ${p.z}`);
        if (map.hazardAt(p.x, p.y, p.z)) why.push(`${what} ${i} in a hazard`);
        if (what === 'spawn' && map.walls(p.x, p.y, p.z, KART_R + 6, null) > 0) why.push(`spawn ${i} in a wall`);
      });
    }
    for (const p of map.pads) {
      const f = map.floorAt(p.tx, p.ty, p.tz + STEP, 0);
      if (!inside(p.tx, p.ty) || Math.abs(f - p.tz) > 0.01 || map.walls(p.tx, p.ty, p.tz, KART_R, null) > 0) why.push(`pad ${p.i} lands nowhere`);
    }
    if (why.length) return { ok: false, why, map };
    // The flood fill: from the first spawn, following the drivers' graph forwards and backwards.
    const nav = map.nav;
    const home = nav.nodeAt(def.spawns[0].x, def.spawns[0].y, def.spawns[0].z);
    const there = nav.reach(home);
    const back = nav.reach(home, true);
    for (const [what, list] of [['spawn', def.spawns], ['box', def.boxes]]) {
      list.forEach((p, i) => {
        const id = nav.nodeAt(p.x, p.y, p.z);
        if (id < 0 || !there[id] || !back[id]) why.push(`${what} ${i} at (${p.x}, ${p.y}, ${p.z}) out of reach`);
      });
    }
    // No big part of the arena you can't get to, or can't get back from.
    let both = 0;
    let trapped = 0;
    for (let i = 0; i < nav.count; i++) {
      if (there[i] && back[i]) both++;
      else if (there[i]) trapped++;
    }
    if (both < nav.count * 0.85) why.push(`only ${Math.round((100 * both) / nav.count)}% of the floor connected`);
    if (trapped > 12) why.push(`${trapped} spots you can't get back from`);
    return { ok: !why.length, why, map, stats: { nodes: nav.count, connected: both / nav.count } };
  }

  // ---------- a week's arena ----------
  const PHRASES = {
    ring: 'a walled courtyard with a wall walk over its gates',
    terraces: 'a sunken bowl ringed by high terraces',
    islands: 'islands joined by bridges and jump pads',
    hub: 'a raised hub in the middle',
    moat: 'a moated island with a sweeper on it',
    spire: 'a tall spire you reach by jump pad',
    bowl: 'a sweeper and bumpers in the middle',
    plateau: 'plateaus with ramps',
    deck: 'decks you can drive under',
    perch: 'towers you reach by jump pad',
    bridge: 'bridges over covered lanes',
    cover: 'crates for cover',
    bumpers: 'bumpers',
    sweeper: 'sweepers',
  };
  function blurb(Lo) {
    const seen = [];
    for (const t of Lo.tags) if (t !== 'open' && !seen.includes(t)) seen.push(t);
    const words = seen.slice(0, 4).map((t) => {
      if (t === 'pit') return Lo.look.liquid === 'lava' ? 'lava pits' : 'pits of water';
      if (t === 'pool') return Lo.look.pool === 'acid' ? 'acid pools' : 'lava pools';
      if (t === 'islands' && Lo.look.liquid === 'lava') return 'islands in a lava lake, joined by bridges and jump pads';
      return PHRASES[t];
    });
    const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] || 'open ground';
    return `New every week. This one: ${list}.`;
  }

  // The def for one attempt (no checking: the server says which attempt passed).
  function weeklyDef(key, attempt = 0) {
    const info = weeklyInfo(key);
    if (!info) return null;
    const Lo = layout(key, attempt);
    const def = place(Lo);
    return Object.assign(def, {
      id: `weekly-${key}-a${attempt}`, name: info.name, emoji: info.emoji, blurb: blurb(Lo),
      weekly: { key, week: info.week, attempt, plan: Lo.plan },
    });
  }

  // Generate, check and try again until a layout passes. `accept(def, map)` (the server's play
  // test) can turn down a layout that passed the checks: {ok, why}. Returns {def, map, attempt,
  // tries} (tries: why the ones before failed), or null if none of MAX_TRIES did.
  function weeklyArena(key, accept) {
    const tries = [];
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const def = weeklyDef(key, attempt);
      if (!def) return null;
      const res = check(def);
      const verdict = res.ok && accept ? accept(def, res.map) : res;
      if (verdict.ok) return { def, map: res.map, attempt, tries, stats: res.stats };
      tries.push({ attempt, why: verdict.why.slice(0, 4) });
    }
    return null;
  }

  return { MAX_TRIES, LOOKS, weekOf, weekKey, parseKey, mondayOf, nextWeekAt, weeklyInfo, weeklyDef, weeklyArena, check, random, hash };
});
