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
  };

  // Item codes on the wire are index + 1.
  const ITEMS = ['boost', 'rocket', 'banana', 'shield', 'triple', 'mine', 'minigun', 'bomb', 'shock', 'ghost'];

  function driftLevel(t) {
    if (t >= PHYS.driftLevels[1]) return 2;
    if (t >= PHYS.driftLevels[0]) return 1;
    return 0;
  }

  function catmullRom(points, samplesPerSegment) {
    const out = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];
      for (let s = 0; s < samplesPerSegment; s++) {
        const t = s / samplesPerSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
        const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
        out.push([x, y]);
      }
    }
    return out;
  }

  // ---------- Race tracks ----------
  function makeRaceMap(def) {
    const width = def.width || 260;
    const centerline = catmullRom(def.points, def.samples || 20);
    const n = centerline.length;
    const tangents = centerline.map((p, i) => {
      const q = centerline[(i + 1) % n];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    });

    // Nearest centerline sample. With `hint`, only search nearby (prevents
    // snapping to a parallel stretch of track and keeps lookups cheap).
    function nearestIndex(x, y, hint) {
      let best = 0;
      let bestD = Infinity;
      if (hint === undefined || hint === null) {
        for (let i = 0; i < n; i++) {
          const d = (centerline[i][0] - x) ** 2 + (centerline[i][1] - y) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
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
        if (d < bestD) { bestD = d; px = qx; py = qy; }
      }
      return { index: best, dist: Math.sqrt(bestD), px, py };
    }

    // Point across the track at sample `i`, lateral offset in [-1, 1].
    function trackPoint(i, lateral) {
      const k = ((i % n) + n) % n;
      const p = centerline[k];
      const t = tangents[k];
      const half = width / 2;
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
        const [x, y] = trackPoint(Math.floor(n * f), -0.7 + c * 0.35);
        itemBoxes.push({ x, y });
      }
    }
    const boostPads = (def.boostPads || []).map(([f, lateral]) => {
      const i = Math.floor(n * f);
      const [x, y] = trackPoint(i, lateral);
      const t = tangents[i];
      return { x, y, angle: Math.atan2(t[1], t[0]) };
    });

    const xs = centerline.map((p) => p[0]);
    const ys = centerline.map((p) => p[1]);
    const pad = width / 2 + WALL_PAD + 40;
    const bounds = { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad };

    return {
      ...def, type: 'race', width, centerline, tangents, n, itemBoxes, boostPads, bounds,
      center: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2],
      size: Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
      nearestIndex, trackPoint, gridPosition,
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
    };
  }

  // ---------- Map catalogue ----------
  const MAPS = {};
  const add = (m) => { MAPS[m.id] = m; };

  add(makeRaceMap({
    id: 'grandprix', name: 'Grand Prix', emoji: '🏁', theme: 'meadow',
    blurb: 'Classic green circuit with fast sweepers.',
    points: [
      [500, 500], [1500, 350], [2500, 500], [2950, 1000], [2650, 1550], [1950, 1450],
      [1500, 1800], [1900, 2250], [2750, 2350], [2600, 2900], [1450, 2950], [550, 2750],
      [300, 1900], [750, 1350], [400, 950],
    ],
    boostPads: [[0.25, 0], [0.5, -0.4], [0.75, 0.4]],
  }));
  add(makeRaceMap({
    id: 'canyon', name: 'Desert Canyon', emoji: '🏜️', theme: 'desert', width: 250,
    blurb: 'Hairpins between red rock mesas. Drift or crash.',
    points: [
      [600, 450], [1700, 330], [2900, 450], [3150, 1000], [2600, 1230], [2000, 950],
      [1450, 1250], [1700, 1900], [2750, 2020], [3100, 2550], [2700, 3100], [1700, 3050],
      [1150, 2450], [650, 2950], [250, 2300], [500, 1550], [250, 950],
    ],
    boostPads: [[0.08, 0], [0.33, 0.3], [0.58, -0.3], [0.8, 0]],
  }));
  add(makeRaceMap({
    id: 'frost', name: 'Snowy Peaks', emoji: '🏔️', theme: 'snow', width: 270, grip: 0.82,
    blurb: 'Slippery ice road through snowy pines.',
    points: [
      [700, 500], [2600, 450], [3050, 950], [2950, 1650], [2300, 1800], [2900, 2350],
      [2800, 3000], [1800, 3050], [1300, 2500], [800, 2950], [350, 2400], [500, 1700],
      [1050, 1300], [450, 900],
    ],
    boostPads: [[0.12, 0.3], [0.45, 0], [0.7, -0.3]],
  }));
  add(makeRaceMap({
    id: 'neon', name: 'Neon City', emoji: '🌃', theme: 'neon', width: 250,
    blurb: 'Night race through glowing city blocks.',
    points: [
      [500, 500], [1700, 500], [1750, 1100], [2900, 1100], [2950, 2000], [2250, 2050],
      [2200, 2900], [1100, 2900], [1050, 2050], [500, 2000],
    ],
    samples: 30,
    boostPads: [[0.05, 0], [0.3, 0], [0.55, 0], [0.8, 0]],
  }));

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
  function getMap(id, type) {
    const m = MAPS[id];
    if (m && (!type || m.type === type)) return m;
    return MAPS[DEFAULT_MAP[type || 'race']];
  }
  function mapList() {
    return Object.values(MAPS).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji, type: m.type, blurb: m.blurb }));
  }

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

  // Advance a kart by dt seconds. `input` = {up, down, left, right, drift}.
  // Mutates and returns kart {x, y, angle, speed, boost, spin, drift, trackIndex}.
  function stepKart(kart, input, dt, map) {
    const arena = map.type === 'arena';
    const grip = map.grip || 1;
    const spinning = kart.spin > 0;
    const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    if (spinning) {
      kart.angle += 9 * dt;
      kart.speed *= Math.max(0, 1 - 4 * dt);
      kart.drift = 0;
      kart.driftTime = 0;
    } else {
      if (input.up) kart.speed += PHYS.accel * dt * (0.6 + 0.4 * grip);
      else if (input.down) kart.speed -= (kart.speed > 0 ? PHYS.brake * grip : PHYS.accel * 0.6) * dt;
      else kart.speed -= Math.sign(kart.speed) * Math.min(Math.abs(kart.speed), PHYS.drag * 100 * grip * dt);

      // Drifting: hold drift while steering at speed. The kart slides into the
      // turn; the longer you hold it, the bigger the mini-turbo on release.
      if (!kart.drift && input.drift && steer && kart.speed > PHYS.driftMinSpeed) {
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
          kart.driftTime += dt;
          // Steering tightens or widens the drift but never reverses it.
          const tight = 1 + 0.55 * steer * kart.drift;
          kart.angle += kart.drift * PHYS.turnRate * 0.78 * tight * dt;
          kart.speed -= 60 * dt;
        }
      } else {
        const g = Math.min(1, Math.abs(kart.speed) / 140);
        kart.angle += steer * PHYS.turnRate * g * (0.75 + 0.25 * grip) * dt * (kart.speed >= 0 ? 1 : -1);
      }
    }

    // Surface under the kart: 0 road (curbs included), 1 run-off strip, 2 grass.
    let surface = 0;
    if (!arena) {
      const near = map.nearestIndex(kart.x, kart.y, kart.trackIndex);
      kart.trackIndex = near.index;
      const edge = near.dist - map.width / 2;
      surface = edge <= CURB + KART_RADIUS * 0.5 ? 0 : edge <= RUNOFF ? 1 : 2;
    }
    kart.surface = surface;
    for (const p of map.boostPads) {
      if ((kart.x - p.x) ** 2 + (kart.y - p.y) ** 2 < 34 * 34) kart.boost = Math.max(kart.boost || 0, PHYS.padBoost);
    }
    let max = kart.boost > 0 ? PHYS.boostSpeed : PHYS.maxSpeed;
    if (kart.boost <= 0 && surface) max = surface === 2 ? PHYS.offTrackMax : PHYS.runoffMax;
    if (kart.boost > 0 && !spinning) kart.speed = Math.max(kart.speed, PHYS.boostSpeed * 0.95);
    if (kart.speed > max) kart.speed = Math.max(max, kart.speed - (surface ? PHYS.offTrackDecel : PHYS.brake * 1.5) * dt);
    if (kart.speed < PHYS.reverseMax) kart.speed = PHYS.reverseMax;

    // On slippery maps the kart's travel direction lags behind where it points.
    kart.heading = kart.heading === undefined ? kart.angle : kart.heading;
    let dh = kart.angle - kart.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    kart.heading += dh * Math.min(1, dt * 14 * grip * grip * (kart.drift ? 0.55 : 1));
    kart.x += Math.cos(kart.heading) * kart.speed * dt;
    kart.y += Math.sin(kart.heading) * kart.speed * dt;

    kart.bump = 0;
    if (arena) {
      kart.bump = collideArena(kart, map, dt);
    } else {
      // Hard wall outside the track so nobody gets lost. Karts slide along it.
      const after = map.nearestIndex(kart.x, kart.y, kart.trackIndex);
      const wall = map.width / 2 + WALL_PAD;
      if (after.dist > wall) {
        const nx = (after.px - kart.x) / after.dist;
        const ny = (after.py - kart.y) / after.dist;
        const k = wall / after.dist;
        kart.x = after.px + (kart.x - after.px) * k;
        kart.y = after.py + (kart.y - after.py) * k;
        kart.bump = slideOffWall(kart, nx, ny, dt);
      }
    }

    if (kart.boost > 0) kart.boost = Math.max(0, kart.boost - dt);
    if (kart.spin > 0) kart.spin = Math.max(0, kart.spin - dt);
    return kart;
  }

  return {
    KART_RADIUS, WALL_PAD, CURB, RUNOFF, PHYS, ITEMS, MAPS, DEFAULT_MAP,
    getMap, mapList, stepKart, driftLevel,
  };
});
