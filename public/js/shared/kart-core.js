// Track geometry and kart physics shared by the server (authoritative simulation)
// and the browser (prediction for your own kart + rendering).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KartCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TRACK_WIDTH = 260;
  const KART_RADIUS = 16;
  const WORLD = { w: 3400, h: 3400 };

  // Control points of the circuit (clockwise). Smoothed with Catmull-Rom below.
  const CONTROL_POINTS = [
    [500, 500], [1500, 350], [2500, 500], [2950, 1000], [2650, 1550], [1950, 1450],
    [1500, 1800], [1900, 2250], [2750, 2350], [2600, 2900], [1450, 2950], [550, 2750],
    [300, 1900], [750, 1350], [400, 950],
  ];

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

  const CENTERLINE = catmullRom(CONTROL_POINTS, 20);
  const N = CENTERLINE.length;

  // Unit tangent at each sample (direction of travel).
  const TANGENTS = CENTERLINE.map((p, i) => {
    const q = CENTERLINE[(i + 1) % N];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  });

  // Find nearest centerline sample. If `hint` is given, only search nearby
  // (prevents snapping to a parallel stretch of track and allows cheap lookups).
  function nearestIndex(x, y, hint) {
    let best = 0;
    let bestD = Infinity;
    if (hint === undefined || hint === null) {
      for (let i = 0; i < N; i++) {
        const d = (CENTERLINE[i][0] - x) ** 2 + (CENTERLINE[i][1] - y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let o = -25; o <= 25; o++) {
        const i = (hint + o + N) % N;
        const d = (CENTERLINE[i][0] - x) ** 2 + (CENTERLINE[i][1] - y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return { index: best, dist: Math.sqrt(bestD) };
  }

  // Point across the track at sample `i`, lateral offset in [-1, 1].
  function trackPoint(i, lateral) {
    const p = CENTERLINE[((i % N) + N) % N];
    const t = TANGENTS[((i % N) + N) % N];
    const half = TRACK_WIDTH / 2;
    return [p[0] - t[1] * lateral * half, p[1] + t[0] * lateral * half];
  }

  // Starting grid: rows of 5 behind the start line.
  function gridPosition(slot) {
    const row = Math.floor(slot / 5);
    const col = slot % 5;
    const i = (N - 3 - row * 2 + N) % N;
    const lateral = -0.8 + col * 0.4;
    const [x, y] = trackPoint(i, lateral);
    const t = TANGENTS[i];
    return { x, y, angle: Math.atan2(t[1], t[0]), index: i };
  }

  const PHYS = {
    accel: 620,
    brake: 900,
    reverseMax: -200,
    maxSpeed: 520,
    boostSpeed: 820,
    offTrackMax: 230,
    drag: 1.4,
    turnRate: 3.1,
  };

  // Advance a kart by dt seconds. `input` = {up, down, left, right}.
  // Mutates and returns kart {x, y, angle, speed, boost, spin, trackIndex}.
  function stepKart(kart, input, dt) {
    const spinning = kart.spin > 0;
    if (spinning) {
      kart.angle += 9 * dt;
      kart.speed *= Math.max(0, 1 - 4 * dt);
    } else {
      if (input.up) kart.speed += PHYS.accel * dt;
      else if (input.down) kart.speed -= (kart.speed > 0 ? PHYS.brake : PHYS.accel * 0.6) * dt;
      else kart.speed -= Math.sign(kart.speed) * Math.min(Math.abs(kart.speed), PHYS.drag * 100 * dt);

      const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
      const grip = Math.min(1, Math.abs(kart.speed) / 140);
      kart.angle += steer * PHYS.turnRate * grip * dt * (kart.speed >= 0 ? 1 : -1);
    }

    const near = nearestIndex(kart.x, kart.y, kart.trackIndex);
    kart.trackIndex = near.index;
    const offTrack = near.dist > TRACK_WIDTH / 2;
    let max = kart.boost > 0 ? PHYS.boostSpeed : PHYS.maxSpeed;
    if (offTrack && kart.boost <= 0) max = PHYS.offTrackMax;
    if (kart.boost > 0 && !spinning) kart.speed = Math.max(kart.speed, PHYS.boostSpeed * 0.95);
    if (kart.speed > max) kart.speed = Math.max(max, kart.speed - PHYS.brake * 1.5 * dt);
    if (kart.speed < PHYS.reverseMax) kart.speed = PHYS.reverseMax;

    kart.x += Math.cos(kart.angle) * kart.speed * dt;
    kart.y += Math.sin(kart.angle) * kart.speed * dt;

    // Hard wall far outside the track so nobody gets lost.
    const after = nearestIndex(kart.x, kart.y, kart.trackIndex);
    const wall = TRACK_WIDTH / 2 + 160;
    if (after.dist > wall) {
      const c = CENTERLINE[after.index];
      const k = wall / after.dist;
      kart.x = c[0] + (kart.x - c[0]) * k;
      kart.y = c[1] + (kart.y - c[1]) * k;
      kart.speed *= 0.5;
    }
    kart.x = Math.max(0, Math.min(WORLD.w, kart.x));
    kart.y = Math.max(0, Math.min(WORLD.h, kart.y));

    if (kart.boost > 0) kart.boost = Math.max(0, kart.boost - dt);
    if (kart.spin > 0) kart.spin = Math.max(0, kart.spin - dt);
    return kart;
  }

  // Item box rows: sample index of each row, 5 boxes across.
  const ITEM_ROWS = [Math.floor(N * 0.12), Math.floor(N * 0.37), Math.floor(N * 0.62), Math.floor(N * 0.86)];
  const ITEM_BOXES = [];
  for (const row of ITEM_ROWS) {
    for (let c = 0; c < 5; c++) {
      const [x, y] = trackPoint(row, -0.7 + c * 0.35);
      ITEM_BOXES.push({ x, y });
    }
  }

  const ITEMS = ['boost', 'rocket', 'banana', 'shield', 'triple'];

  return {
    TRACK_WIDTH, KART_RADIUS, WORLD, CENTERLINE, TANGENTS, N, PHYS, ITEM_BOXES, ITEMS,
    nearestIndex, trackPoint, gridPosition, stepKart,
  };
});
