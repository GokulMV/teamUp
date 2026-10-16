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
  easy: { speed: 0.9, react: 0.45, aim: 0.5, noise: 0.2, look: 0.9, corner: 0.8, line: 0.1, drift: false, itemChance: 0.15, holdMax: 16, lead: 0, trick: 0 },
  normal: { speed: 1, react: 0.2, aim: 0.3, noise: 0.06, look: 1, corner: 0.95, line: 0.3, drift: false, itemChance: 0.65, holdMax: 9, lead: 0.5, trick: 0.5 },
  hard: { speed: 1, react: 0.08, aim: 0.18, noise: 0, look: 1.05, corner: 1.05, line: 0.45, drift: true, itemChance: 1, holdMax: 5, lead: 1, trick: 1 },
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
    if (s.owner === k.id || game.isFriendly(s.owner, k.id)) continue;
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
    if (s.kind === 'rocket' && rel < 0.6) return true;
    if (s.kind === 'bullet' && rel < 0.15 && ++bullets >= 3) return true;
  }
  return false;
}

// Rivals relative to this kart: nearest in front (within aim cone), nearest
// behind, nearest overall and how many are close by.
function scan(game, k, aimTol) {
  const res = { front: null, frontD: Infinity, frontErr: 0, behind: null, behindD: Infinity, near: null, nearD: Infinity, close: 0 };
  const cosA = Math.cos(k.angle);
  const sinA = Math.sin(k.angle);
  for (const r of game.karts.values()) {
    if (r === k || r.dead > 0 || r.finished || game.isFriendly(r.id, k.id)) continue;
    const dx = r.x - k.x;
    const dy = r.y - k.y;
    const d = Math.hypot(dx, dy);
    if (d < res.nearD) { res.nearD = d; res.near = r; }
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
  };
  if (k.ghost <= 0) {
    for (const b of game.bananas) if (b.owner !== k.id || b.safe <= 0) dodge(b.x, b.y);
    for (const m of game.mines) if (m.owner !== k.id && !game.isFriendly(m.owner, k.id)) dodge(m.x, m.y);
  }

  let [tx, ty] = map.trackPoint(ti, lateral);

  // Grab a nearby item box when empty-handed.
  if (!k.item && game.boxes.length) {
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

function raceItems(game, k, ai, sk) {
  const item = k.item;
  const s = scan(game, k, sk.aim * 1.3);
  const T = trackInfo(game.map);
  const idx = k.trackIndex || 0;
  const straight = Math.abs(T.turn[(idx + T.w) % T.n]) < 0.3 && Math.abs(T.turn[(idx + 2 * T.w) % T.n]) < 0.3;
  const holdTooLong = ai.hold > sk.holdMax;
  switch (item) {
    case 'rocket':
    case 'triple':
      return (s.front && s.frontD < 1000) || holdTooLong;
    case 'bomb':
      return (s.front && s.frontD > 250 && s.frontD < 750) || holdTooLong;
    case 'minigun':
      return (s.front && s.frontD < 550) || holdTooLong;
    case 'banana':
    case 'mine':
      return (s.behind && s.behindD < 380) || holdTooLong;
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
  // Defensive items aren't a weapon: keep looking for boxes until they're used.
  const armed = (!!k.item && !['ghost', 'shield', 'boost'].includes(k.item)) || k.gun > 0;
  if (hpFrac < 0.3 && s.near && s.nearD < 650) {
    ai.mode = 'flee';
    ai.target = s.near;
    return;
  }
  if (!armed && game.boxes.length) {
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
  setSteer(input, err, 0.06);
}

function arenaItems(game, k, ai, sk) {
  const item = k.item;
  const s = scan(game, k, sk.aim);
  const hpFrac = k.hp / (game.hpMax || 100);
  const holdTooLong = ai.hold > sk.holdMax;
  switch (item) {
    case 'rocket':
    case 'triple':
      return !!(s.front && s.frontD < 850);
    case 'bomb':
      return !!(s.front && s.frontD > 280 && s.frontD < 700);
    case 'minigun':
      return !!(s.front && s.frontD < 520);
    case 'banana':
    case 'mine':
      return (s.behind && s.behindD < 350) || holdTooLong;
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

  ai.hold = k.item ? ai.hold + dt : 0;
  ai.roamClock -= dt;
  ai.clock -= dt;
  if (ai.clock <= 0) {
    ai.clock = sk.react * (0.7 + Math.random() * 0.6);
    ai.wobble = sk.noise ? (Math.random() - 0.5) * 2 * sk.noise : 0;
    if (game.arena) pickArenaGoal(game, k, ai, sk);
  }

  // Unstick: back up and turn when pinned against something.
  if (ai.reverse > 0) {
    ai.reverse -= dt;
    Object.assign(input, { up: false, down: true, drift: false, left: ai.reverseSteer < 0, right: ai.reverseSteer > 0 });
    return;
  }
  if (game.arena) arenaDrive(game, k, ai, sk, input);
  else {
    raceDrive(game, k, ai, sk, input);
    // Off a ramp: decide once per jump whether to do a trick (press drift at take-off).
    if (k.air > 0 && !ai.inAir) { ai.inAir = true; ai.wantTrick = Math.random() < sk.trick; }
    else if (!(k.air > 0)) ai.inAir = false;
    if (ai.inAir && ai.wantTrick && k.trickable && !k.tricked) input.drift = true;
  }
  if ((input.up || input.down) && Math.abs(k.speed) < 40 && k.spin <= 0 && !(k.air > 0)) {
    ai.stuck += dt;
    if (ai.stuck > 0.8) {
      ai.stuck = 0;
      ai.reverse = 0.6 + Math.random() * 0.4;
      ai.reverseSteer = input.left ? 1 : input.right ? -1 : (Math.random() < 0.5 ? -1 : 1);
    }
  } else {
    ai.stuck = Math.max(0, ai.stuck - dt * 2);
  }

  // Items, at the bot's reaction speed.
  ai.shotCd -= dt;
  ai.itemClock -= dt;
  if (k.item && ai.itemClock <= 0 && ai.shotCd <= 0 && k.spin <= 0) {
    ai.itemClock = sk.react * (0.7 + Math.random() * 0.6);
    const want = game.arena ? arenaItems(game, k, ai, sk) : raceItems(game, k, ai, sk);
    if (want && (ai.hold > sk.holdMax || Math.random() < sk.itemChance)) {
      game.useItem(k);
      ai.shotCd = 0.35;
      if (!k.item) ai.hold = 0;
    }
  }
}

module.exports = { makeBots, think, trackInfo, SKILLS, SKILL_NAMES, BOT_NAMES, MAX_BOTS };
