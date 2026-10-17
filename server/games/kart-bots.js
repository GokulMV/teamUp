// CPU drivers for Kart Battle. A bot is an ordinary kart without a socket:
// every tick think() fills kart.input (and may fire its item) the same way a
// human's key presses would. Everything here has to stay cheap (up to 30 karts
// at 30 Hz) and must never throw into the game loop.
const K = require('../../public/js/shared/kart-core');

const BOT_NAMES = ['Bolt', 'Nitro', 'Pixel', 'Turbo', 'Comet', 'Blaze', 'Rocket', 'Sprocket', 'Zippy', 'Flash', 'Dash', 'Skid', 'Fizz', 'Rally', 'Echo'];
const BOT_COLORS = [
  '#f97316', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#14b8a6', '#f43f5e', '#6366f1',
  '#facc15', '#10b981', '#0ea5e9', '#d946ef', '#fb7185', '#4ade80', '#38bdf8',
];
const AVATAR_COUNT = 24;
const MAX_BOTS = 15;

// react: seconds between decisions; aim: radians of slack when firing;
// noise: steering wobble; corner: how hard it attacks corners; line: how far it
// cuts to the inside; itemChance: odds of acting on a good item opportunity;
// holdMax: seconds before it just uses whatever it holds; trick: odds of a trick off a ramp.
const SKILLS = {
  easy: { speed: 0.9, react: 0.45, aim: 0.5, noise: 0.2, look: 0.9, corner: 0.8, line: 0.1, drift: false, itemChance: 0.15, holdMax: 16, lead: 0, trick: 0, hop: 0 },
  normal: { speed: 1, react: 0.2, aim: 0.3, noise: 0.06, look: 1, corner: 0.95, line: 0.3, drift: false, itemChance: 0.65, holdMax: 9, lead: 0.5, trick: 0.5, hop: 0.25 },
  hard: { speed: 1, react: 0.08, aim: 0.18, noise: 0, look: 1.05, corner: 1.05, line: 0.45, drift: true, itemChance: 1, holdMax: 5, lead: 1, trick: 1, hop: 0.6 },
};
const SKILL_NAMES = Object.keys(SKILLS);

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Profiles for `count` bots. `takenNames` avoids clashing with humans,
// `teamCounts` (humans per team, team mode only) keeps teams balanced.
function makeBots(count, { skill = 'normal', takenNames = [], teamCounts = null } = {}) {
  const n = clamp(Math.floor(count) || 0, 0, MAX_BOTS);
  const taken = new Set(takenNames.map((s) => String(s).toLowerCase()));
  const names = shuffled(BOT_NAMES);
  const colors = shuffled(BOT_COLORS);
  const counts = teamCounts ? teamCounts.slice() : null;
  const bots = [];
  for (let i = 0; i < n; i++) {
    let name = names[i % names.length];
    if (taken.has(name.toLowerCase())) name = `${name} CPU`;
    taken.add(name.toLowerCase());
    let team = 0;
    if (counts && counts.length) {
      let best = 0;
      for (let t = 1; t < counts.length; t++) if (counts[t] < counts[best]) best = t;
      team = best;
      counts[best]++;
    }
    bots.push({
      id: `bot:${i + 1}`,
      name,
      color: colors[i % colors.length],
      avatar: Math.floor(Math.random() * AVATAR_COUNT),
      team,
      bot: true,
      skill: SKILLS[skill] ? skill : 'normal',
    });
  }
  return bots;
}

// ---------- per-map helpers (cached) ----------
const TRACK_INFO = new WeakMap();
function trackInfo(map) {
  let info = TRACK_INFO.get(map);
  if (info) return info;
  const { n, centerline: c, tangents } = map;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const q = c[(i + 1) % n];
    total += Math.hypot(q[0] - c[i][0], q[1] - c[i][1]);
  }
  const seg = total / n;
  const head = tangents.map((t) => Math.atan2(t[1], t[0]));
  const W = 220; // window (world units) over which corner sharpness is measured
  const w = Math.max(1, Math.round(W / seg));
  const turn = new Float32Array(n); // signed heading change over the next W units
  for (let i = 0; i < n; i++) turn[i] = wrap(head[(i + w) % n] - head[i]);
  info = { n, seg, turn, w, wDist: w * seg };
  TRACK_INFO.set(map, info);
  return info;
}

function newAi(k) {
  return {
    clock: Math.random() * 0.3,
    itemClock: 0.5 + Math.random(),
    hold: 0,
    stuck: 0,
    reverse: 0,
    reverseSteer: 1,
    wobble: 0,
    lane: (Math.random() - 0.5) * 0.5,
    mode: 'roam',
    target: null,
    tx: k.x,
    ty: k.y,
    roamClock: 0,
    shotCd: 0,
  };
}

function setSteer(input, err, dead) {
  input.left = err < -dead;
  input.right = err > dead;
}

// Is something dangerous about to hit this kart?
function threatened(game, k) {
  let bullets = 0;
  for (const s of game.shots) {
    if (s.kind === 'comet') {
      if (s.target === k.id && s.age > 0.6) return true; // a comet is coming for us
      continue;
    }
    if ((s.owner === k.id && !s.bounced) || game.isFriendly(s.owner, k.id)) continue;
    const dx = k.x - s.x;
    const dy = k.y - s.y;
    const d2 = dx * dx + dy * dy;
    if (s.kind === 'bomb') {
      const lx = s.x + Math.cos(s.angle) * s.speed * Math.max(0, s.life);
      const ly = s.y + Math.sin(s.angle) * s.speed * Math.max(0, s.life);
      if ((lx - k.x) ** 2 + (ly - k.y) ** 2 < 170 * 170) return true;
      continue;
    }
    if (d2 > 520 * 520) continue;
    const rel = Math.abs(wrap(Math.atan2(dy, dx) - s.angle));
    if ((s.kind === 'rocket' || s.kind === 'bouncer') && rel < 0.6) return true;
    if (s.kind === 'bullet' && rel < 0.15 && ++bullets >= 3) return true;
  }
  return false;
}

// Rivals relative to this kart: nearest in front (within aim cone), nearest
// behind, nearest overall and how many are close by.
// Layered arenas: `near` counts climbing (a rival up on the walls is further than it looks) and
// front/behind/close only see rivals on the same level (shots and traps stay on their own floor).
function scan(game, k, aimTol) {
  const res = { front: null, frontD: Infinity, frontErr: 0, behind: null, behindD: Infinity, near: null, nearD: Infinity, close: 0 };
  const cosA = Math.cos(k.angle);
  const sinA = Math.sin(k.angle);
  const layered = !!game.layered;
  for (const r of game.karts.values()) {
    if (r === k || r.dead > 0 || r.finished || game.isFriendly(r.id, k.id)) continue;
    const dx = r.x - k.x;
    const dy = r.y - k.y;
    const d = Math.hypot(dx, dy);
    const dz = layered ? Math.abs((r.z || 0) - (k.z || 0)) : 0;
    if (d + dz * 2.5 < res.nearD) { res.nearD = d + dz * 2.5; res.near = r; }
    if (dz > 40) continue;
    if (d < 320) res.close++;
    if (d < 1) continue;
    const fwd = (dx * cosA + dy * sinA) / d;
    const err = Math.abs(wrap(Math.atan2(dy, dx) - k.angle));
    if (err < aimTol && d < res.frontD && r.ghost <= 0) { res.front = r; res.frontD = d; res.frontErr = err; }
    if (fwd < -0.6 && d < res.behindD) { res.behind = r; res.behindD = d; }
  }
  return res;
}

// ---------- race ----------
function raceDrive(game, k, ai, sk, input) {
  const map = game.map;
  const T = trackInfo(map);
  const n = T.n;
  const grip = map.grip || 1;
  let idx = k.trackIndex;
  if (idx === null || idx === undefined) idx = map.nearestIndex(k.x, k.y).index;
  const v = Math.max(0, k.speed);
  const mul = k.speedMul || 1;

  // Aim at a point down the track; cut to the inside of the next corner.
  const ahead = (80 + v * 0.42) * sk.look;
  const la = Math.max(2, Math.round(ahead / T.seg));
  const ti = (idx + la) % n;
  const curv = T.turn[ti];
  let lateral = clamp(curv * sk.line * 1.3 + ai.lane, -0.6, 0.6);

  // Sidestep bananas and mines lying near the line ahead.
  const cosA = Math.cos(k.angle);
  const sinA = Math.sin(k.angle);
  const dodge = (x, y) => {
    const dx = x - k.x;
    const dy = y - k.y;
    const fwd = dx * cosA + dy * sinA;
    if (fwd < 0 || fwd > 260) return;
    const side = -dx * sinA + dy * cosA; // + = to the right of the kart
    if (Math.abs(side) < 45) lateral = clamp(lateral + (side > 0 ? -0.45 : 0.45), -0.75, 0.75);
    // Dead ahead and too close to steer round: hop it (the hop clears it ~0.1-0.3 s after take-off).
    if (Math.abs(side) < 26 && fwd > v * 0.08 + 20 && fwd < v * 0.14 + 40 && Math.random() < sk.hop) ai.hopNow = true;
  };
  if (k.ghost <= 0) {
    for (const b of game.bananas) if (b.owner !== k.id || b.safe <= 0) dodge(b.x, b.y);
    for (const m of game.mines) if (m.owner !== k.id && !game.isFriendly(m.owner, k.id)) dodge(m.x, m.y);
    for (const g of game.stickies) if (!game.isFriendly(g.owner, k.id) && sk.hop > 0) dodge(g.x, g.y);
    // Only the sharpest drivers spot a decoy for what it is.
    for (const d of game.decoys) if (d.owner !== k.id && !game.isFriendly(d.owner, k.id) && sk.hop > 0.3) dodge(d.x, d.y);
  }
  // A sticky bomb on board: swerve into the nearest rival alongside or just ahead to pass it on.
  if (k.sticky) {
    let best = null;
    let bestD = 260;
    for (const r of game.karts.values()) {
      if (r === k || r.dead > 0 || r.finished || r.ghost > 0 || r.sticky || game.isFriendly(r.id, k.id)) continue;
      const d = Math.hypot(r.x - k.x, r.y - k.y);
      if (d < bestD && (r.x - k.x) * cosA + (r.y - k.y) * sinA > -30) { best = r; bestD = d; }
    }
    if (best) {
      const side = -(best.x - k.x) * sinA + (best.y - k.y) * cosA;
      lateral = clamp(lateral + clamp(side / (map.width / 2), -0.8, 0.8), -0.85, 0.85);
    }
  }

  let [tx, ty] = map.trackPoint(ti, lateral);

  // Grab a nearby item box while there's a free item slot (two at most).
  if (!(k.item && k.item2) && game.boxes.length) {
    let best = null;
    let bestD = 380;
    for (let i = 0; i < game.boxes.length; i++) {
      if (game.boxes[i] > 0) continue;
      const b = map.itemBoxes[i];
      const dx = b.x - k.x;
      const dy = b.y - k.y;
      const d = Math.hypot(dx, dy);
      if (d < 50 || d > bestD) continue;
      if ((dx * cosA + dy * sinA) / d < 0.82) continue;
      best = b;
      bestD = d;
    }
    if (best) { tx = best.x; ty = best.y; }
  }

  const err = wrap(Math.atan2(ty - k.y, tx - k.x) + ai.wobble - k.angle);

  // Corner speed: the sharpest bend within braking distance sets the limit.
  const brakeDist = (v * v) / (2 * K.PHYS.brake * grip) + v * 0.2 + 60;
  const span = Math.min(Math.floor(n / 3), Math.round(brakeDist / T.seg) + T.w);
  let sharp = 0;
  for (let j = 0; j <= span; j += 2) {
    const t = Math.abs(T.turn[(idx + j) % n]);
    if (t > sharp) sharp = t;
  }
  const rate = K.PHYS.turnRate * (0.75 + 0.25 * grip);
  const vCorner = ((rate * T.wDist) / Math.max(0.05, sharp)) * sk.corner * grip;
  const top = K.PHYS.maxSpeed * mul;

  input.up = v < vCorner && Math.abs(err) < 1.3;
  input.down = v > vCorner + 70 || (Math.abs(err) > 1.6 && v > 160);
  if (input.down) input.up = false;
  if (!input.up && !input.down && v < Math.min(vCorner, top) * 0.75) input.up = true;

  // Drifting (hard bots): slide through long bends for a mini-turbo.
  const near = map.nearestIndex(k.x, k.y, idx);
  const edge = near.dist > (map.width / 2) * 0.8;
  if (sk.drift && !edge) {
    const bend = T.turn[(idx + 1) % n] + T.turn[(idx + T.w) % n];
    if (!k.drift) {
      if (Math.abs(bend) > 0.7 && v > 300 && Math.sign(bend) === Math.sign(err)) {
        input.drift = true;
        setSteer(input, Math.sign(bend), 0);
        return;
      }
    } else if (bend * k.drift > 0.25 && err * k.drift > -0.35) {
      input.drift = true;
      input.up = true;
      input.down = false;
      // Tighten when the line is still inside, widen when it's outside.
      const e = err * k.drift;
      input.left = false;
      input.right = false;
      if (e > 0.1) setSteer(input, k.drift, 0);
      else if (e < -0.05) setSteer(input, -k.drift, 0);
      return;
    }
  }
  input.drift = false;
  setSteer(input, err, 0.05);
}

// Bombs are lobbed a chosen distance beyond the thrower's own path: where can this kart land one
// right now, and how hard to throw to hit `target` (leading its motion; better bots lead more)?
function bombReach(k) {
  const own = 26 + Math.max(0, k.speed) * K.ITEM_FX.bomb.flight;
  return { min: own + K.ITEM_FX.bomb.near, max: own + K.ITEM_FX.bomb.far, own };
}
function bombPower(k, target, dist, sk) {
  if (!target) return K.ITEM_FX.bomb.tap;
  const tv = (target.speed || 0) * Math.cos((target.heading ?? target.angle) - k.angle) * K.ITEM_FX.bomb.flight * sk.lead;
  const { near, far } = K.ITEM_FX.bomb;
  return clamp((dist + tv - bombReach(k).own - near) / (far - near), 0, 1);
}

// Close up, a minigun is worth opening up on a rival that isn't dead ahead yet: the burst keeps
// going while the kart turns onto them (a kart can't turn on the spot, so close targets are often
// off to the side).
function closeSpray(k, s) {
  if (!s.near || s.nearD > 260 || s.near.ghost > 0) return false;
  return Math.abs(wrap(Math.atan2(s.near.y - k.y, s.near.x - k.x) - k.angle)) < 1.0;
}

// Rivals ahead of this kart in the race (by track progress).
function rivalsAhead(game, k) {
  let n = 0;
  for (const r of game.karts.values()) {
    if (r !== k && !r.finished && r.progress > k.progress && !game.isFriendly(r.id, k.id)) n++;
  }
  return n;
}

// true = use it now, 'back' = use it backwards (bouncer), false = keep it.
function raceItems(game, k, ai, sk, item = k.item) {
  const s = scan(game, k, sk.aim * 1.3);
  const T = trackInfo(game.map);
  const idx = k.trackIndex || 0;
  const straight = Math.abs(T.turn[(idx + T.w) % T.n]) < 0.3 && Math.abs(T.turn[(idx + 2 * T.w) % T.n]) < 0.3;
  const holdTooLong = ai.hold > sk.holdMax;
  switch (item) {
    case 'bouncer':
      if (s.front && s.frontD < 700) return true;
      if (s.behind && s.behindD < 300) return 'back';
      return holdTooLong;
    case 'comet':
    case 'thunder':
      return rivalsAhead(game, k) > 0 || holdTooLong;
    case 'ink':
      return rivalsAhead(game, k) >= 2 || (rivalsAhead(game, k) > 0 && ai.hold > 2) || holdTooLong;
    case 'star':
      return threatened(game, k) || (s.front && s.frontD < 450) || (straight && k.speed > 250) || holdTooLong;
    case 'rocket':
    case 'triple':
      return (s.front && s.frontD < 1000) || holdTooLong;
    case 'bomb': {
      const r = bombReach(k);
      return (s.front && s.frontD > r.min - 60 && s.frontD < r.max) || holdTooLong;
    }
    case 'minigun':
      return (s.front && s.frontD < 550) || closeSpray(k, s) || holdTooLong;
    case 'banana':
    case 'mine':
      return (s.behind && s.behindD < 380) || holdTooLong;
    case 'decoy':
      return (s.behind && s.behindD < 600) || holdTooLong;
    case 'snowball':
      return (s.front && s.frontD < 900) || holdTooLong;
    case 'sticky':
      return (s.front && s.frontD < 420) || holdTooLong;
    case 'spikes':
      return (s.near && s.nearD < 110) || threatened(game, k) || holdTooLong;
    case 'boost':
      return (straight && k.speed > 250) || holdTooLong;
    case 'shield':
      return threatened(game, k) || Math.random() < 0.03 || holdTooLong;
    case 'ghost':
      return threatened(game, k) || s.close >= 3 || holdTooLong;
    case 'shock':
      return s.close >= 1 || holdTooLong;
    default:
      return holdTooLong;
  }
}

// ---------- arena ----------
function pickArenaGoal(game, k, ai, sk) {
  const map = game.map;
  const s = scan(game, k, sk.aim);
  const hpFrac = k.hp / (game.hpMax || 100);
  // Defensive items aren't a weapon: keep looking for boxes until they're used (while a slot is free).
  const weapon = (it) => !!it && !['ghost', 'shield', 'boost'].includes(it);
  const armed = weapon(k.item) || weapon(k.item2) || k.gun > 0;
  // A sticky bomb on board: get rid of it on the nearest rival.
  if (k.sticky && s.near) {
    ai.mode = 'hunt';
    ai.target = s.near;
    return;
  }
  if (hpFrac < 0.3 && s.near && s.nearD < 650) {
    ai.mode = 'flee';
    ai.target = s.near;
    return;
  }
  if (!armed && !(k.item && k.item2) && game.boxes.length) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < game.boxes.length; i++) {
      if (game.boxes[i] > 0) continue;
      const b = map.itemBoxes[i];
      if (map.hazards.some((h) => (b.x - h.x) ** 2 + (b.y - h.y) ** 2 < (h.r + 30) ** 2)) continue;
      const d = (b.x - k.x) ** 2 + (b.y - k.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      ai.mode = 'box';
      ai.target = null;
      ai.tx = map.itemBoxes[best].x;
      ai.ty = map.itemBoxes[best].y;
      return;
    }
  }
  if (s.near && (armed || !game.boxes.length || s.nearD < 500)) {
    ai.mode = 'hunt';
    ai.target = s.near;
    return;
  }
  ai.mode = 'roam';
  ai.target = null;
  if (ai.roamClock <= 0 || Math.hypot(ai.tx - k.x, ai.ty - k.y) < 120) {
    const sp = map.spawns[Math.floor(Math.random() * map.spawns.length)] || { x: map.center[0], y: map.center[1] };
    ai.tx = sp.x;
    ai.ty = sp.y;
    ai.roamClock = 4;
  }
}

function arenaDrive(game, k, ai, sk, input) {
  const map = game.map;
  const S = map.size;
  let tx = ai.tx;
  let ty = ai.ty;
  const tgt = ai.target;
  if ((ai.mode === 'hunt' || ai.mode === 'flee') && (!tgt || tgt.dead > 0)) ai.mode = 'roam';
  let dist = Math.hypot(tx - k.x, ty - k.y);
  if (ai.mode === 'hunt') {
    // Lead the target a little (better bots lead more).
    const dt = Math.min(0.8, Math.hypot(tgt.x - k.x, tgt.y - k.y) / 1000) * sk.lead;
    tx = tgt.x + Math.cos(tgt.angle) * tgt.speed * dt;
    ty = tgt.y + Math.sin(tgt.angle) * tgt.speed * dt;
    dist = Math.hypot(tgt.x - k.x, tgt.y - k.y);
  } else if (ai.mode === 'flee') {
    const dx = k.x - tgt.x;
    const dy = k.y - tgt.y;
    const d = Math.hypot(dx, dy) || 1;
    tx = clamp(k.x + (dx / d) * 600, 200, S - 200);
    ty = clamp(k.y + (dy / d) * 600, 200, S - 200);
  }

  // Never aim into a wall or an obstacle (chasing someone pinned there just rams it).
  tx = clamp(tx, 130, S - 130);
  ty = clamp(ty, 130, S - 130);
  for (const o of map.obstacles) {
    const dx = tx - o.x;
    const dy = ty - o.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < o.r + 60) { tx = o.x + (dx / d) * (o.r + 60); ty = o.y + (dy / d) * (o.r + 60); }
  }

  // Desired direction plus repulsion from walls, obstacles and lava.
  let vx = tx - k.x;
  let vy = ty - k.y;
  const vl = Math.hypot(vx, vy) || 1;
  vx /= vl;
  vy /= vl;
  for (const o of map.obstacles) {
    const dx = k.x - o.x;
    const dy = k.y - o.y;
    const d = Math.hypot(dx, dy) || 1;
    const gap = d - o.r - K.KART_RADIUS;
    if (gap < 130) { const w = ((130 - gap) / 130) * 1.4; vx += (dx / d) * w; vy += (dy / d) * w; }
  }
  for (const h of map.hazards) {
    const dx = k.x - h.x;
    const dy = k.y - h.y;
    const d = Math.hypot(dx, dy) || 1;
    const gap = d - h.r;
    if (gap < 170) { const w = ((170 - gap) / 170) * 2.4; vx += (dx / d) * w; vy += (dy / d) * w; }
  }
  const wallZone = 180;
  if (k.x < 40 + wallZone) vx += ((40 + wallZone - k.x) / wallZone) * 1.5;
  if (k.x > S - 40 - wallZone) vx -= ((k.x - (S - 40 - wallZone)) / wallZone) * 1.5;
  if (k.y < 40 + wallZone) vy += ((40 + wallZone - k.y) / wallZone) * 1.5;
  if (k.y > S - 40 - wallZone) vy -= ((k.y - (S - 40 - wallZone)) / wallZone) * 1.5;

  let want = Math.atan2(vy, vx);
  // Probe straight ahead; swerve to whichever side is clear.
  const v = Math.max(0, k.speed);
  const probe = 70 + v * 0.3;
  const bad = (a) => {
    const px = k.x + Math.cos(a) * probe;
    const py = k.y + Math.sin(a) * probe;
    return px < 90 || py < 90 || px > S - 90 || py > S - 90 || map.blocked(px, py, 24) || map.hazards.some((h) => (px - h.x) ** 2 + (py - h.y) ** 2 < (h.r + 20) ** 2);
  };
  if (bad(want)) {
    if (!bad(want + 0.8)) want += 0.8;
    else if (!bad(want - 0.8)) want -= 0.8;
    else if (!bad(want + 1.6)) want += 1.6;
    else want -= 1.6;
  }
  const err = wrap(want + ai.wobble - k.angle);

  const gunning = k.gun > 0 || k.item === 'minigun';
  input.drift = false;
  input.down = false;
  input.up = true;
  // Coast to keep some distance with the minigun, but never roll to a stop:
  // karts can only turn while moving.
  if (ai.mode === 'hunt' && gunning && dist < 230 && v > 140) input.up = false;
  // Box just off to the side: brake to tighten the turn instead of orbiting it.
  if (ai.mode === 'box' && dist < 240 && Math.abs(err) > 0.9 && v > 170) { input.up = false; input.down = true; }
  if (Math.abs(err) > 2 && v > 250) { input.up = false; input.down = true; }
  // A rival right beside us can't be faced by circling (the turn is wider than the gap): back off
  // while turning towards it. Steering flips in reverse.
  if (ai.mode === 'hunt' && dist < 120 && Math.abs(err) > 0.6) {
    input.up = false;
    input.down = true;
    setSteer(input, k.speed < 0 ? -err : err, 0.06);
    return;
  }
  setSteer(input, err, 0.06);
}

// ---------- layered arenas ----------
// The same goals as the flat arena (boxes, hunting, fleeing, roaming), but the way there is a path
// over the map's navigation grid: up ramps, off ledges, over jump pads, across drawbridges only
// while they're down for a while yet, never into the moat. The kart steers at a point a little way
// along the path and swerves round bumpers, sweeper arms and pendulums.
function layeredGoal(game, k, ai, sk) {
  const map = game.map;
  const s = scan(game, k, sk.aim);
  const hpFrac = k.hp / (game.hpMax || 100);
  const weapon = (it) => !!it && !['ghost', 'shield', 'boost'].includes(it);
  const armed = weapon(k.item) || weapon(k.item2) || k.gun > 0;
  const kz = k.z || 0;
  const far = (p) => Math.hypot(p.x - k.x, p.y - k.y) + Math.abs((p.z || 0) - kz) * 2.5;
  ai.target = null;
  if (k.sticky && s.near) { ai.mode = 'hunt'; ai.target = s.near; return; }
  if (hpFrac < 0.3 && s.near && s.nearD < 650) {
    // Run for the spawn point furthest from the threat.
    ai.mode = 'flee';
    let best = map.spawns[0];
    let bestD = -1;
    for (const p of map.spawns) {
      const d = Math.hypot(p.x - s.near.x, p.y - s.near.y) + Math.abs(p.z - (s.near.z || 0)) * 2;
      if (d > bestD) { bestD = d; best = p; }
    }
    ai.goal = best;
    return;
  }
  if (!armed && !(k.item && k.item2) && game.boxes.length) {
    // The nearest box to drive to: round the walls, up the stairs or by jump pad, not as the crow
    // flies (a box on the gallery overhead can be a long way round).
    const nav = map.nav;
    const here = nav.nodeAt(k.x, k.y, kz);
    // Boxes up on the high ground count for more (that's where the view and the fun are).
    const way = (i) => {
      const box = map.itemBoxes[i];
      const field = here >= 0 ? nav.toward(nav.nodeAt(box.x, box.y, box.z || 0, 3)) : null;
      const d = field && Number.isFinite(field[here]) ? field[here] : far(box) * 2 + 1000;
      return (box.z || 0) > kz + 40 ? d * 0.6 : d;
    };
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < game.boxes.length; i++) {
      if (game.boxes[i] > 0) continue;
      const d = way(i);
      if (d < bestD) { bestD = d; best = i; }
    }
    // Stick with the box we were after unless another is a good deal nearer: two about as far off
    // would otherwise swap at every think, and the kart would turn back and forth between them.
    const cur = ai.mode === 'box' ? map.itemBoxes.indexOf(ai.goal) : -1;
    if (cur >= 0 && best !== cur && !(game.boxes[cur] > 0) && bestD > way(cur) * 0.7 - 40) best = cur;
    if (best >= 0) {
      if (ai.goal !== map.itemBoxes[best]) ai.path = null; // a new box: find the way there now
      ai.mode = 'box';
      ai.goal = map.itemBoxes[best];
      return;
    }
  }
  if (s.near && (armed || !game.boxes.length || s.nearD < 500)) {
    // The same goes for rivals: keep after the one we're chasing unless another is much closer.
    const was = ai.mode === 'hunt' ? ai.prey : null;
    let prey = s.near;
    if (was && was !== prey && was.dead <= 0 && game.karts.get(was.id) === was) {
      const d = Math.hypot(was.x - k.x, was.y - k.y) + Math.abs((was.z || 0) - kz) * 2.5;
      if (s.nearD > d * 0.7 - 40) prey = was;
    }
    ai.mode = 'hunt';
    ai.target = prey;
    ai.prey = prey;
    return;
  }
  if (ai.mode !== 'roam' || ai.roamClock <= 0 || !ai.goal || far(ai.goal) < 120) {
    // Wander somewhere, up on the high ground as often as not (that's where the fun is).
    const high = map.spawns.filter((p) => p.z > 40).concat(map.itemBoxes.filter((b) => b.z > 40));
    ai.goal = high.length && Math.random() < 0.5 ? high[Math.floor(Math.random() * high.length)] : map.spawns[Math.floor(Math.random() * map.spawns.length)];
    ai.roamClock = 6;
  }
  ai.mode = 'roam';
}

function planPath(game, k, ai, goal) {
  const map = game.map;
  const nav = map.nav;
  const t = game.time;
  const from = nav.nodeAt(k.x, k.y, k.z || 0);
  const to = nav.nodeAt(goal.x, goal.y, goal.z || 0, 3);
  // A drawbridge is only worth driving onto while it stays down for a good while yet (but a kart
  // already on one can always drive off it).
  const onBridge = from >= 0 ? nav.bridgeOf[from] : -1;
  const avoid = (e, b) => {
    const bi = nav.bridgeOf[b];
    if (bi < 0 || bi === onBridge) return false;
    const st = map.bridgeAt(map.movers[bi], t);
    return !st.down || st.rise < 6;
  };
  ai.path = nav.path(from, to, avoid);
  ai.pi = 0;
  ai.planAt = t;
  ai.planTo = to;
  ai.offPath = 0;
  return !!ai.path;
}

// Layered arenas: would a kart at height z go to its doom at (x, y)? (the void, the moat, lava)
function deadly(map, x, y, z, t) {
  const f = map.floorAt(x, y, z + K.Layers.STEP, t);
  return !Number.isFinite(f) || !!map.hazardAt(x, y, f);
}
// Drive (in thought) from where the kart is straight towards (x, y) for `dist`, following the
// floor as the kart would: up ramps, and off ledges (just off one it is still up in the air, clear
// of the side it fell from). Blocked by a wall at the height it would be at by then (`pad` wide),
// or a drop to its doom. (Testing at the kart's own height instead, a kart halfway up a ramp sees
// the top of it, and the floor it leads onto, as walls.)
function lineBlocked(map, k, x, y, dist, pad, t) {
  const L = Math.hypot(x - k.x, y - k.y) || 1;
  const ux = (x - k.x) / L;
  const uy = (y - k.y) / L;
  const n = Math.max(2, Math.ceil(dist / 20));
  const stepLen = dist / n;
  let z = k.z || 0;
  let airZ = z;
  let air = 0;
  for (let i = 1; i <= n; i++) {
    const px = k.x + (ux * dist * i) / n;
    const py = k.y + (uy * dist * i) / n;
    const f = map.floorAt(px, py, z + K.Layers.STEP, t);
    if (!Number.isFinite(f) || map.hazardAt(px, py, f)) return true;
    if (f < z - K.Layers.STEP) { airZ = Math.max(airZ, z); air = 70; }
    z = f;
    if (map.blocked(px, py, pad, air > 0 ? airZ : z, t)) return true;
    air -= stepLen;
  }
  return false;
}
// Can a kart drive straight from where it is to (x, y) on its floor (no wall, no drop to its doom)?
function clearLine(map, k, x, y, t) {
  return !lineBlocked(map, k, x, y, Math.hypot(x - k.x, y - k.y), K.Layers.KART_R + 5, t);
}

function layeredDrive(game, k, ai, sk, input) {
  const map = game.map;
  const nav = map.nav;
  const t = game.time;
  const kz = k.z || 0;
  const tgt = ai.target;
  if (ai.mode === 'hunt' && (!tgt || tgt.dead > 0)) { ai.mode = 'roam'; ai.goal = null; }
  let goal = ai.goal;
  if (ai.mode === 'hunt') {
    // Lead the target a little (better bots lead more).
    const lead = Math.min(0.8, Math.hypot(tgt.x - k.x, tgt.y - k.y) / 1000) * sk.lead;
    goal = { x: tgt.x + Math.cos(tgt.angle) * tgt.speed * lead, y: tgt.y + Math.sin(tgt.angle) * tgt.speed * lead, z: tgt.z || 0 };
  }
  if (!goal) goal = { x: map.center[0], y: map.center[1], z: 0 };
  const replan = ai.mode === 'hunt' ? 0.7 : 2.5;
  if (!ai.path || t - ai.planAt > replan || ai.offPath > 0.5 || (ai.pi >= ai.path.length - 1 && t - ai.planAt > 0.3)) {
    if (!planPath(game, k, ai, goal)) {
      // No way there right now (the drawbridges are up): roam somewhere this side can reach.
      for (let tries = 0; tries < 4 && !ai.path; tries++) {
        ai.goal = map.spawns[Math.floor(Math.random() * map.spawns.length)];
        goal = ai.goal;
        planPath(game, k, ai, goal);
      }
      ai.mode = 'roam';
      ai.roamClock = 4;
    }
  }
  if (!ai.path) {
    // Nowhere to go from here (yet): sit tight rather than drive off blind.
    Object.assign(input, { up: false, down: false, left: false, right: false, drift: false });
    return;
  }

  // Follow the path: drop the nodes we've passed, then aim a little way further along it.
  let tx = goal.x;
  let ty = goal.y;
  const v = Math.max(0, k.speed);
  if (ai.path && ai.path.length > 1) {
    const P = ai.path;
    while (ai.pi < P.length - 1) {
      const id = P[ai.pi];
      // Passed only on its own level: beside a ramp, a node a little way up it isn't reached yet.
      if (Math.hypot(nav.xs[id] - k.x, nav.ys[id] - k.y) < 56 && Math.abs(nav.zs[id] - kz) < 16) ai.pi++;
      else break;
    }
    const cur = P[ai.pi];
    const off = Math.hypot(nav.xs[cur] - k.x, nav.ys[cur] - k.y);
    // Off the path: too far away, or on the ground beside (or under) where it goes (not in mid air,
    // dropping or flying, when the height is bound to be wrong for a moment).
    ai.offPath = !(k.air > 0) && (off > 170 || Math.abs(nav.zs[cur] - kz) > 24) ? ai.offPath + 1 / 30 : 0;
    const look = 70 + v * 0.22;
    let j = ai.pi;
    let along = Math.hypot(nav.xs[cur] - k.x, nav.ys[cur] - k.y);
    while (j < P.length - 1 && along < look) {
      // A jump pad ahead: drive right onto it (don't cut the corner past it). A level change ahead
      // (ramp, drop): no further. And never cut a corner across the moat or into a wall.
      if (nav.padOf[P[j]] >= 0) break;
      const nx = nav.xs[P[j + 1]];
      const ny = nav.ys[P[j + 1]];
      if (Math.abs(nav.zs[P[j + 1]] - kz) > 30 && j > ai.pi) break;
      if (!clearLine(map, k, nx, ny, t)) break;
      along += Math.hypot(nx - nav.xs[P[j]], ny - nav.ys[P[j]]);
      j++;
    }
    tx = nav.xs[P[j]];
    ty = nav.ys[P[j]];
    const pad = nav.padOf[P[j]];
    if (pad >= 0) { tx = map.pads[pad].x; ty = map.pads[pad].y; }
  }
  // The last stretch on the same floor: straight for the box or the rival (if nothing's in between).
  const dist = Math.hypot(goal.x - k.x, goal.y - k.y);
  if (Math.abs((goal.z || 0) - kz) < 25 && dist < 170 && clearLine(map, k, goal.x, goal.y, t)) { tx = goal.x; ty = goal.y; }

  let vx = tx - k.x;
  let vy = ty - k.y;
  const vl = Math.hypot(vx, vy) || 1;
  vx /= vl;
  vy /= vl;
  // Keep clear of bumpers and moving obstacles on this floor.
  const push = (x, y, r, w) => {
    const dx = k.x - x;
    const dy = k.y - y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < r) { const f = ((r - d) / r) * w; vx += (dx / d) * f; vy += (dy / d) * f; }
  };
  for (const b of map.bumpers) if (Math.abs(b.z - kz) < 30) push(b.x, b.y, b.r + 90, 1.4);
  for (const m of map.movers) {
    if (m.type === 'sweeper' && Math.abs(m.z - kz) < 30) {
      // Repelled by the arm that is coming round, not the hub: aim behind it.
      const a = m.phase + m.speed * t;
      for (let i = 0; i < m.arms; i++) {
        const ang = a + (i * Math.PI * 2) / m.arms + 0.35 * Math.sign(m.speed);
        const along = Math.max(m.hub, Math.min(m.len, (k.x - m.x) * Math.cos(ang) + (k.y - m.y) * Math.sin(ang)));
        push(m.x + Math.cos(ang) * along, m.y + Math.sin(ang) * along, 120, 1.6);
      }
    } else if (m.type === 'pendulum') {
      const b = map.pendulumAt(m, t + 0.3);
      if (b.z - m.r < kz + 40 && b.z + m.r > kz) push(b.x, b.y, m.r + 110, 1.6);
    }
  }
  let want = Math.atan2(vy, vx);
  // Probe ahead: never drive into a wall, the moat, lava or off into the void.
  const probe = 60 + v * 0.3;
  const bad = (a) => lineBlocked(map, k, k.x + Math.cos(a), k.y + Math.sin(a), probe, 20, t);
  // Backing up (to turn onto a rival, or out of a corner) is only safe with floor behind.
  const behindSafe = () => !deadly(map, k.x - Math.cos(k.angle) * 70, k.y - Math.sin(k.angle) * 70, kz, t);
  if (bad(want)) {
    if (!bad(want + 0.7)) want += 0.7;
    else if (!bad(want - 0.7)) want -= 0.7;
    else if (!bad(want + 1.5)) want += 1.5;
    else if (!bad(want - 1.5)) want -= 1.5;
    else {
      // Boxed in: back out, wheels turned so the nose swings towards where we want to go (steering
      // works the other way round in reverse).
      input.up = false;
      input.down = behindSafe();
      setSteer(input, k.speed < 0 ? -wrap(want - k.angle) : wrap(want - k.angle), 0.06);
      return;
    }
  }
  let err = wrap(want + ai.wobble - k.angle);
  const gunning = k.gun > 0 || k.item === 'minigun';
  input.drift = false;
  input.down = false;
  input.up = true;
  // Where the kart will actually go: a turn at speed is a wide arc (and so is going straight on).
  // If that arc crosses the moat or the void, turn the other way round, or brake till it doesn't.
  // (Checked for the turn as steered and a wider one, since the kart's heading lags its nose.)
  const arc = (dir, rates, steps, hit) => {
    for (const rate of rates) {
      let x = k.x;
      let y = k.y;
      let h = k.heading ?? k.angle;
      const sp = Math.max(v, 90);
      for (let i = 1; i <= steps; i++) {
        h += dir * K.PHYS.turnRate * rate * 0.07;
        x += Math.cos(h) * sp * 0.07;
        y += Math.sin(h) * sp * 0.07;
        if (hit(x, y)) return true;
      }
    }
    return false;
  };
  const arcBad = (dir) => arc(dir, [1, 0.6], 9, (x, y) => deadly(map, x, y, kz, t));
  const turn = Math.abs(err) > 0.25 ? Math.sign(err) : 0;
  if (v > 50 && arcBad(turn)) {
    if (turn && !arcBad(-turn) && Math.abs(err) > 1.6) err = -turn; // the long way round, on land
    else if (!turn && !arcBad(1)) err = 1;
    else if (!turn && !arcBad(-1)) err = -1;
    else { input.up = false; input.down = true; }
  }
  // Turning hard at speed with a wall in the way of the arc (a U-turn beside a tower, a corner cut
  // too tight): brake as well as steer, rather than plough into it.
  if (v > 170 && turn && Math.abs(err) > 0.9 && arc(turn, [1], 6, (x, y) => map.blocked(x, y, 18, kz, t))) { input.up = false; input.down = true; }
  if (ai.mode === 'hunt' && gunning && dist < 230 && v > 140) input.up = false;
  if (ai.mode === 'box' && dist < 240 && Math.abs(err) > 0.9 && v > 170) { input.up = false; input.down = true; }
  if (Math.abs(err) > 2 && v > 250) { input.up = false; input.down = true; }
  if (ai.mode === 'hunt' && dist < 120 && Math.abs(err) > 0.6 && Math.abs((tgt.z || 0) - kz) < 25 && behindSafe()) {
    input.up = false;
    input.down = true;
    setSteer(input, k.speed < 0 ? -err : err, 0.06);
    return;
  }
  // Facing the wrong way at a crawl (nose to a wall, the goal behind): a three-point turn, backing
  // out with the wheels turned the other way so the nose swings round.
  if (Math.abs(err) > 1.9 && v < 110 && behindSafe()) {
    input.up = false;
    input.down = true;
    setSteer(input, -err, 0.06);
    return;
  }
  // Braking hard enough to roll backwards: only with floor behind.
  if (input.down && k.speed < 60 && !behindSafe()) { input.down = false; input.up = true; }
  setSteer(input, err, 0.06);
}

function arenaItems(game, k, ai, sk, item = k.item) {
  const s = scan(game, k, sk.aim);
  const hpFrac = k.hp / (game.hpMax || 100);
  const holdTooLong = ai.hold > sk.holdMax;
  switch (item) {
    case 'bouncer':
      if (s.front && s.frontD < 800) return true;
      if (s.behind && s.behindD < 280) return 'back';
      return holdTooLong;
    case 'comet':
    case 'thunder':
      return !!s.near || holdTooLong;
    case 'ink':
      return s.nearD < 700 || holdTooLong;
    case 'star':
      return threatened(game, k) || s.nearD < 520 || holdTooLong;
    case 'rocket':
    case 'triple':
      return !!(s.front && s.frontD < 850);
    case 'bomb': {
      const r = bombReach(k);
      return !!(s.front && s.frontD > Math.max(200, r.min - 60) && s.frontD < r.max);
    }
    case 'minigun':
      return !!(s.front && s.frontD < 520) || closeSpray(k, s);
    case 'banana':
    case 'mine':
      return (s.behind && s.behindD < 350) || holdTooLong;
    case 'decoy':
      return (s.behind && s.behindD < 500) || holdTooLong;
    case 'snowball':
      return !!(s.front && s.frontD < 800);
    case 'sticky':
      return !!(s.front && s.frontD < 380);
    case 'spikes':
      return (s.near && s.nearD < 140) || holdTooLong;
    case 'shock':
      return s.close >= 1 || holdTooLong;
    case 'shield':
      return threatened(game, k) || (hpFrac < 0.5 && s.nearD < 400) || holdTooLong;
    case 'ghost':
      return threatened(game, k) || (hpFrac < 0.4 && s.nearD < 450) || holdTooLong;
    case 'boost':
      return ai.mode === 'flee' || (ai.mode === 'hunt' && s.nearD > 650 && Math.abs(wrap(Math.atan2(s.near.y - k.y, s.near.x - k.x) - k.angle)) < 0.3) || holdTooLong;
    default:
      return holdTooLong;
  }
}

// ---------- entry point ----------
const NO_INPUT = { up: false, down: false, left: false, right: false, drift: false };

function think(game, k, dt) {
  const ai = k.ai || (k.ai = newAi(k));
  const sk = SKILLS[k.skill] || SKILLS.normal;
  if (!k.input || k.input === NO_INPUT) k.input = { ...NO_INPUT };
  const input = k.input;
  if (k.dead > 0 || k.finished || k.fall > 0) { Object.assign(input, NO_INPUT); return; }

  ai.hold = k.item ? ai.hold + dt : 0; // how long the front item has been held
  ai.roamClock -= dt;
  ai.clock -= dt;
  if (ai.clock <= 0) {
    ai.clock = sk.react * (0.7 + Math.random() * 0.6);
    // Ink on the windscreen makes even the best bots wobble.
    const noise = sk.noise + (k.ink > 0 ? 0.35 : 0);
    ai.wobble = noise ? (Math.random() - 0.5) * 2 * noise : 0;
    if (game.layered) layeredGoal(game, k, ai, sk);
    else if (game.arena) pickArenaGoal(game, k, ai, sk);
  }

  // Unstick: back up and turn when pinned against something.
  if (ai.reverse > 0) {
    ai.reverse -= dt;
    Object.assign(input, { up: false, down: true, drift: false, left: ai.reverseSteer < 0, right: ai.reverseSteer > 0 });
    return;
  }
  ai.hopNow = false;
  if (game.layered) layeredDrive(game, k, ai, sk, input);
  else if (game.arena) arenaDrive(game, k, ai, sk, input);
  else {
    raceDrive(game, k, ai, sk, input);
    // Off a ramp: decide once per jump whether to do a trick (press drift at take-off).
    if (k.air > 0 && !ai.inAir) { ai.inAir = true; ai.wantTrick = Math.random() < sk.trick; }
    else if (!(k.air > 0)) ai.inAir = false;
    if (ai.inAir && ai.wantTrick && k.trickable && !k.tricked) input.drift = true;
    // A tap of drift is a hop (it only counts on the press, so not while holding a drift).
    if (ai.hopNow && !k.hopHeld && !(k.air > 0)) input.drift = true;
  }
  if ((input.up || input.down) && Math.abs(k.speed) < 40 && k.spin <= 0 && !(k.air > 0)) {
    ai.stuck += dt;
    if (ai.stuck > 0.8) {
      ai.stuck = 0;
      const back = !game.layered || !deadly(game.map, k.x - Math.cos(k.angle) * 80, k.y - Math.sin(k.angle) * 80, k.z || 0, game.time);
      if (back) {
        ai.reverse = 0.6 + Math.random() * 0.4;
        ai.reverseSteer = input.left ? 1 : input.right ? -1 : (Math.random() < 0.5 ? -1 : 1);
      }
      if (game.layered) ai.path = null; // and find the way again
    }
  } else {
    ai.stuck = Math.max(0, ai.stuck - dt * 2);
  }

  // Items, at the bot's reaction speed.
  ai.shotCd -= dt;
  ai.itemClock -= dt;
  if (k.item && k.roulette <= 0 && ai.itemClock <= 0 && ai.shotCd <= 0 && k.spin <= 0) {
    ai.itemClock = sk.react * (0.7 + Math.random() * 0.6);
    const decide = game.arena ? arenaItems : raceItems;
    let want = decide(game, k, ai, sk);
    // The front item isn't wanted right now but the reserve one is: swap it in first.
    if (!want && k.item2 && k.item2 !== k.item && k.roulette2 <= 0) {
      const alt = decide(game, k, ai, sk, k.item2);
      if (alt && game.swapItems(k)) want = alt;
    }
    if (want && (ai.hold > sk.holdMax || Math.random() < sk.itemChance)) {
      const last = k.ammo <= 1;
      const opts = { back: want === 'back' };
      if (k.item === 'bomb') {
        const s = scan(game, k, sk.aim * 1.3);
        opts.power = bombPower(k, s.front, s.frontD, sk);
      }
      const used = game.useItem(k, opts);
      ai.shotCd = 0.35;
      if (used && last) ai.hold = 0; // the slot emptied: the next item starts its own clock
    }
  }
}

module.exports = { makeBots, think, trackInfo, SKILLS, SKILL_NAMES, BOT_NAMES, MAX_BOTS };
