const K = require('../../public/js/shared/kart-core');
const Bots = require('./kart-bots');

const TICK_HZ = 30;
const SEND_EVERY = 2; // broadcast at 15 Hz
const COUNTDOWN_S = 4;
const FINISH_GRACE_S = 25;
const MAX_KARTS = 30;
const SPIN_TIME = 1.4;
const SHIELD_TIME = 4;
const GHOST_TIME = 4;
const BOOST_TIME = 1.6;
const SPAWN_SHIELD = 2;
const KILL_POINTS = 100;
const HP_MAX = 100; // default arena health ('normal')
const REGEN_DELAY = 3;
const REGEN_RATE = 10; // hp per second

const ROCKET = { speed: 1000, life: 1.8, homing: 2.2 };
const BULLET = { speed: 1700, life: 0.55, every: 0.08, spread: 0.06 };
const BOMB = { speed: 650, flight: 0.85, radius: 140 };
const MINE = { arm: 0.8, life: 60, trigger: 40, radius: 95 };
const SHOCK_RADIUS = 360;
const GUN_TIME = 2;
const BANANA_LIFE = 40;

// Damage in the arena (karts have 100 hp). In a race every hit except bullets spins you out.
const DAMAGE = { rocket: 70, triple: 45, bullet: 6, banana: 35, mine: 100, bomb: 100, shock: 45, lava: 1000 }; // lava is instant death

const SHOT_CODE = { rocket: 1, bullet: 2, bomb: 3 };
const NO_INPUT = { up: false, down: false, left: false, right: false, drift: false };

// Item odds. Arena favours weapons; in a race, karts at the back get stronger items.
const ARENA_ODDS = { rocket: 20, triple: 10, minigun: 13, bomb: 10, mine: 10, shock: 8, banana: 7, shield: 8, ghost: 6, boost: 8 };
const RACE_ODDS_FRONT = { banana: 26, mine: 18, shield: 18, rocket: 14, minigun: 10, boost: 8, bomb: 6, ghost: 0, triple: 0, shock: 0 };
const RACE_ODDS_BACK = { boost: 26, rocket: 16, triple: 14, shock: 12, ghost: 10, minigun: 8, bomb: 8, shield: 4, banana: 2, mine: 0 };

// Room options (see DEFAULT_SETTINGS in server/rooms.js).
const CLASS_SPEED = { chill: 0.82, standard: 1, turbo: 1.18 };
const BOX_RESPAWN = { rare: 6, normal: 3, frequent: 1.5 };
const RESPAWN_TIME = { fast: 1.5, normal: 2.5, slow: 4 }; // arena: seconds dead before respawning
const ARENA_HEALTH = { low: 60, normal: 100, high: 150 };
const KILL_LIMITS = [0, 5, 10, 15, 25];
const WEAPON_ITEMS = ['rocket', 'triple', 'minigun', 'bomb', 'mine', 'shock'];

// Which items can come out of a box for these settings ([] = no item boxes).
function allowedItems(s) {
  if (s.kartItems === 'none') return [];
  if (s.kartItems === 'weapons') return WEAPON_ITEMS.slice();
  if (s.kartItems === 'custom') {
    const list = Array.isArray(s.kartItemList) ? s.kartItemList : [];
    return K.ITEMS.filter((it) => list.includes(it));
  }
  return K.ITEMS.slice();
}

function weightedPick(odds) {
  const entries = Object.entries(odds);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [item, w] of entries) {
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return item;
  }
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i][1] > 0) return entries[i][0];
  return entries.length ? entries[0][0] : null;
}

// Kart Battle has two variants:
//  - race:  laps around a circuit, items, points for placement + hits
//  - arena: timed deathmatch with health; destroyed karts respawn
// Squared distance from point (x, y) to the segment (ax, ay)-(bx, by).
function segmentDist2(ax, ay, bx, by, x, y) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
  return (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
}

class KartBattle {
  static minPlayers = 1;

  constructor(room) {
    this.room = room;
    const s = room.settings;
    const type = s.kartMode === 'arena' ? 'arena' : 'race';
    this.map = K.getMap(s.kartMap, type, { reverse: type === 'race' && s.kartReverse === true });
    this.arena = this.map.type === 'arena';
    this.reverse = !!this.map.reverse;
    this.laps = s.kartLaps;
    this.duration = s.arenaTime;
    this.speedMul = CLASS_SPEED[s.kartClass] || 1;
    this.items = allowedItems(s);
    this.boxRespawn = BOX_RESPAWN[s.kartBoxRespawn] || BOX_RESPAWN.normal;
    this.catchup = s.kartCatchup !== false;
    this.killLimit = KILL_LIMITS.includes(s.arenaKillLimit) ? s.arenaKillLimit : 0;
    this.respawnTime = RESPAWN_TIME[s.arenaRespawn] || RESPAWN_TIME.normal;
    this.hpMax = ARENA_HEALTH[s.arenaHealth] || HP_MAX;
    this.botCount = Number.isInteger(s.kartBots) ? Math.max(0, Math.min(Bots.MAX_BOTS, s.kartBots)) : 0;
    this.botSkill = Bots.SKILLS[s.kartBotSkill] ? s.kartBotSkill : 'normal';
    this.botError = false;
    this.phase = 'countdown';
    this.time = 0;
    this.karts = new Map();
    this.order = []; // kart index -> player id
    this.shots = []; // rockets, bullets, bombs
    this.mines = [];
    this.bananas = [];
    // Respawn timer per item box, 0 = available. No boxes at all without items.
    this.boxes = this.items.length ? this.map.itemBoxes.map(() => 0) : [];
    this.finishOrder = [];
    this.firstFinishAt = null;
    this.tickCount = 0;
    this.nextId = 1;
    this.interval = null;
  }

  start() {
    const players = this.room.connectedPlayers.slice(0, MAX_KARTS);
    players.forEach((p, slot) => this.addKart(p, slot));
    const teamCounts = this.room.settings.teamMode
      ? this.room.teamList().map((t) => players.filter((p) => p.team === t.id).length)
      : null;
    const bots = Bots.makeBots(Math.min(this.botCount, MAX_KARTS - players.length), {
      skill: this.botSkill,
      takenNames: [...this.room.players.values()].map((p) => p.name),
      teamCounts,
    });
    bots.forEach((b, i) => this.addKart(b, players.length + i));
    this.room.emit('game:kart:init', this.initPayload());
    this.interval = setInterval(() => this.tick(1 / TICK_HZ), 1000 / TICK_HZ);
  }

  addKart(player, slot) {
    let g;
    if (this.arena) {
      const s = this.map.spawns[slot % this.map.spawns.length];
      g = { x: s.x, y: s.y, angle: s.angle, index: null };
    } else {
      g = this.map.gridPosition(slot);
    }
    const bot = !!player.bot;
    this.karts.set(player.id, {
      idx: this.order.length,
      id: player.id,
      name: player.name, color: player.color, avatar: player.avatar || 0, team: player.team || 0,
      bot, skill: bot ? player.skill : null,
      speedMul: this.speedMul * (bot ? Bots.SKILLS[player.skill].speed : 1),
      x: g.x, y: g.y, angle: g.angle, speed: 0,
      trackIndex: g.index,
      lap: 0,
      boost: 0, spin: 0, shield: 0, invuln: 0, ghost: 0,
      gun: 0, gunCd: 0,
      hp: this.hpMax, lastHit: -99, lastAttacker: null,
      dead: 0,
      item: null, ammo: 0,
      input: { ...NO_INPUT },
      finished: false, finishTime: null,
      hits: 0, kills: 0, deaths: 0, streak: 0,
      progress: this.arena ? 0 : g.index - this.map.n,
    });
    this.order.push(player.id);
  }

  initPayload() {
    return {
      map: this.map.type, // 'race' | 'arena'
      mapId: this.map.id,
      laps: this.laps,
      duration: this.duration,
      phase: this.phase,
      countdown: Math.max(0, COUNTDOWN_S - this.time),
      speedMul: this.speedMul,
      reverse: this.reverse,
      items: this.items.length > 0,
      killLimit: this.arena ? this.killLimit : 0,
      hpMax: this.hpMax,
      respawn: this.respawnTime, // seconds a destroyed kart waits (the client's death card counts it down)
      karts: this.order.map((id, idx) => {
        const k = this.karts.get(id);
        const src = (!k.bot && this.room.players.get(id)) || k;
        const meta = { idx, id, name: src.name || '?', color: src.color || '#888', avatar: src.avatar || 0, team: src.team || 0 };
        if (k.bot) meta.bot = true;
        return meta;
      }),
    };
  }

  snapshotFor(_player) {
    return { mode: 'kart', init: this.initPayload() };
  }

  onPlayerJoin(player) {
    // Late joiners spectate this round; they'll be in the next one.
    this.room.emitTo(player.id, 'game:kart:init', this.initPayload());
  }

  onPlayerLeave(player) {
    const kart = this.karts.get(player.id);
    if (kart) kart.input = { ...NO_INPUT };
  }

  onPlayerDisconnect(player) {
    this.onPlayerLeave(player);
  }

  onEvent(player, event, data, reply) {
    if (event === 'ping') { reply({ ok: true }); return; }
    const kart = this.karts.get(player.id);
    if (!kart) return;
    if (event === 'input') {
      kart.input = { up: !!data?.up, down: !!data?.down, left: !!data?.left, right: !!data?.right, drift: !!data?.drift };
    } else if (event === 'use') {
      if (this.phase === 'racing') this.useItem(kart);
    }
  }

  // ---------- items ----------
  fire(kind, kart, angleOffset = 0) {
    const a = kart.angle + angleOffset;
    const base = kind === 'bullet' ? BULLET.speed : kind === 'bomb' ? BOMB.speed : ROCKET.speed;
    const speed = base + Math.max(0, kart.speed) * (kind === 'bomb' ? 0.5 : 1);
    this.shots.push({
      id: this.nextId++, kind, owner: kart.id,
      x: kart.x + Math.cos(a) * 26, y: kart.y + Math.sin(a) * 26, angle: a, speed,
      life: kind === 'bullet' ? BULLET.life : kind === 'bomb' ? BOMB.flight : ROCKET.life,
      age: 0,
      dmg: kind === 'rocket' && kart.item === 'triple' ? DAMAGE.triple : DAMAGE[kind],
    });
  }

  useItem(kart) {
    if (this.phase !== 'racing' || !kart.item || kart.spin > 0 || kart.dead > 0 || kart.finished) return;
    const item = kart.item;
    const cos = Math.cos(kart.angle);
    const sin = Math.sin(kart.angle);
    switch (item) {
      case 'boost': kart.boost = BOOST_TIME; break;
      case 'shield': kart.shield = SHIELD_TIME; break;
      case 'ghost': kart.ghost = GHOST_TIME; break;
      case 'minigun': kart.gun = GUN_TIME; kart.gunCd = 0; break;
      case 'rocket':
      case 'triple': this.fire('rocket', kart); break;
      case 'bomb': this.fire('bomb', kart); break;
      case 'banana':
        this.bananas.push({ id: this.nextId++, x: kart.x - cos * 34, y: kart.y - sin * 34, life: BANANA_LIFE, owner: kart.id, safe: 0.6 });
        break;
      case 'mine':
        this.mines.push({ id: this.nextId++, x: kart.x - cos * 36, y: kart.y - sin * 36, owner: kart.id, arm: MINE.arm, life: MINE.life });
        break;
      case 'shock': this.shock(kart); break;
      default:
    }
    this.room.emit('game:kart:use', { idx: kart.idx, item });
    kart.ammo--;
    if (kart.ammo <= 0) { kart.item = null; kart.ammo = 0; }
  }

  shock(kart) {
    for (const k of this.karts.values()) {
      if (k === kart || k.dead > 0 || this.isFriendly(k.id, kart.id)) continue;
      if ((k.x - kart.x) ** 2 + (k.y - kart.y) ** 2 < SHOCK_RADIUS ** 2) this.damage(k, DAMAGE.shock, kart, 'shock');
    }
    this.room.emit('game:kart:shock', { idx: kart.idx, x: Math.round(kart.x), y: Math.round(kart.y), r: SHOCK_RADIUS });
  }

  rollItem(kart) {
    if (!this.items.length) return null;
    const odds = {};
    if (this.arena) {
      for (const item of this.items) odds[item] = ARENA_ODDS[item] || 0;
    } else {
      // Catch-up: karts at the back get stronger items. Without it everyone
      // rolls from the same middle-of-the-pack table.
      let behind = 0.5;
      if (this.catchup) {
        const ranked = this.rankings();
        const pos = ranked.findIndex((k) => k.id === kart.id);
        behind = ranked.length > 1 ? pos / (ranked.length - 1) : 0;
      }
      for (const item of this.items) {
        odds[item] = (RACE_ODDS_FRONT[item] || 0) * (1 - behind) + (RACE_ODDS_BACK[item] || 0) * behind;
      }
    }
    if (!Object.values(odds).some((w) => w > 0)) for (const item of this.items) odds[item] = 1;
    return weightedPick(odds);
  }

  // Team of a kart: humans follow their (possibly changed) lobby team, bots keep theirs.
  teamOf(id) {
    const p = this.room.players.get(id);
    if (p) return p.team;
    const k = this.karts.get(id);
    return k ? k.team : undefined;
  }

  isFriendly(a, b) {
    if (!a || !b || a === b || !this.room.settings.teamMode) return false;
    const ta = this.teamOf(a);
    return ta !== undefined && ta === this.teamOf(b);
  }

  // ---------- damage ----------
  damage(target, amount, attacker, kind) {
    // Nothing more can happen once the round is over (e.g. a kill limit hit mid-blast).
    if (this.phase !== 'racing') return;
    if (target.dead > 0 || target.finished || (target.ghost > 0 && kind !== 'lava')) return;
    if (attacker && attacker !== target && this.isFriendly(attacker.id, target.id)) return;
    if (kind !== 'lava') {
      if (target.shield > 0) {
        target.shield = 0;
        target.invuln = 0.4;
        this.room.emit('game:kart:block', { idx: target.idx });
        return;
      }
      if (target.invuln > 0) return;
    }
    const by = attacker && attacker !== target ? attacker : null;
    const event = { target: target.idx, by: by ? by.idx : -1, x: Math.round(target.x), y: Math.round(target.y), kind, kill: false, streak: 0 };

    if (!this.arena) {
      if (kind === 'bullet') {
        target.speed *= 0.82;
        this.room.emit('game:kart:hit', event);
        return;
      }
      target.spin = SPIN_TIME;
      target.invuln = SPIN_TIME + 1;
      target.boost = 0;
      if (by) by.hits++;
      this.room.emit('game:kart:hit', event);
      return;
    }

    target.hp -= amount;
    if (kind !== 'lava' || !target.lastAttacker) target.lastHit = this.time;
    if (by) { target.lastAttacker = by.id; target.lastHit = this.time; }
    if (kind === 'banana') { target.spin = 0.8; target.invuln = 0.3; }
    if (target.hp > 0) {
      if (kind !== 'lava') this.room.emit('game:kart:hit', event);
      return;
    }
    // Destroyed. Lava kills go to whoever hit you last (within 5 s), so knocking rivals in counts.
    let killer = by;
    if (!killer && target.lastAttacker && this.time - target.lastHit < 5) killer = this.karts.get(target.lastAttacker) || null;
    if (killer === target) killer = null;
    target.dead = this.respawnTime;
    target.deaths++;
    target.streak = 0;
    Object.assign(target, { speed: 0, boost: 0, item: null, ammo: 0, gun: 0, drift: 0, hp: 0 });
    if (killer && !this.isFriendly(killer.id, target.id)) {
      killer.kills++;
      killer.streak++;
      event.streak = killer.streak;
    }
    event.by = killer ? killer.idx : -1;
    event.kill = true;
    this.room.emit('game:kart:hit', event);
    if (killer) this.checkKillLimit(killer);
  }

  // Arena kill limit: first player (or team, in team mode) to reach it wins.
  checkKillLimit(killer) {
    if (!this.arena || !this.killLimit || this.phase !== 'racing') return;
    let reached = killer.kills >= this.killLimit;
    if (this.room.settings.teamMode) {
      const team = this.teamOf(killer.id);
      let total = 0;
      for (const k of this.karts.values()) if (this.teamOf(k.id) === team) total += k.kills;
      reached = total >= this.killLimit;
    }
    if (reached) this.endRace();
  }

  explode(x, y, radius, maxDmg, attacker, kind) {
    for (const k of this.karts.values()) {
      const d = Math.hypot(k.x - x, k.y - y);
      if (d > radius) continue;
      if (attacker && k.id === attacker.id) continue; // your own blasts never hurt you
      this.damage(k, Math.round(maxDmg * (1 - 0.5 * (d / radius))), attacker, kind);
    }
    this.room.emit('game:kart:boom', { x: Math.round(x), y: Math.round(y), r: radius, kind });
  }

  respawn(kart) {
    // Pick the spawn point furthest from every living enemy.
    let best = this.map.spawns[0];
    let bestScore = -Infinity;
    for (const s of this.map.spawns) {
      let nearest = Infinity;
      for (const k of this.karts.values()) {
        if (k === kart || k.dead > 0) continue;
        nearest = Math.min(nearest, (k.x - s.x) ** 2 + (k.y - s.y) ** 2);
      }
      const score = nearest + Math.random() * 1000;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    Object.assign(kart, {
      x: best.x, y: best.y, angle: best.angle, heading: best.angle, speed: 0, spin: 0, dead: 0,
      shield: SPAWN_SHIELD, invuln: 0, hp: this.hpMax, lastAttacker: null,
    });
  }

  // ---------- simulation ----------
  tick(dt) {
    this.time += dt;
    this.tickCount++;

    if (this.phase === 'countdown') {
      if (this.time >= COUNTDOWN_S) { this.phase = 'racing'; this.raceStart = this.time; }
    } else if (this.phase === 'racing') {
      this.simulate(dt);
      const elapsed = this.time - this.raceStart;
      if (this.arena) {
        if (elapsed >= this.duration) this.endRace();
      } else {
        // Bots never hold up the end: once every connected human is done, so is the race.
        const allDone = [...this.karts.values()].every((k) => k.finished || k.bot || !this.room.players.get(k.id)?.connected);
        const graceOver = this.firstFinishAt !== null && this.time - this.firstFinishAt > FINISH_GRACE_S;
        const hardLimit = elapsed > this.laps * 120 + 60;
        if (allDone || graceOver || hardLimit) this.endRace();
      }
    }

    if (this.tickCount % SEND_EVERY === 0) this.broadcast();
  }

  driveBots(dt) {
    for (const k of this.karts.values()) {
      if (!k.bot) continue;
      try {
        Bots.think(this, k, dt);
      } catch (err) {
        // A confused bot just coasts; never take the game down with it.
        k.input = { ...NO_INPUT };
        if (!this.botError) { this.botError = true; console.error('Kart bot error:', err); }
      }
    }
  }

  simulate(dt) {
    const karts = [...this.karts.values()];
    this.driveBots(dt);
    for (const k of karts) {
      if (k.dead > 0) {
        k.dead -= dt;
        if (k.dead <= 0) this.respawn(k);
        continue;
      }
      // Finished karts keep full control for a victory lap (no items, can't be hit, pass through others).
      const input = k.input;
      const prevIndex = k.trackIndex;
      K.stepKart(k, input, dt, this.map, { speed: k.speedMul });
      for (const t of ['shield', 'invuln', 'ghost']) if (k[t] > 0) k[t] = Math.max(0, k[t] - dt);

      if (k.gun > 0) {
        k.gun -= dt;
        k.gunCd -= dt;
        while (k.gunCd <= 0 && k.gun > 0) {
          this.fire('bullet', k, (Math.random() - 0.5) * 2 * BULLET.spread);
          k.gunCd += BULLET.every;
        }
      }
      if (this.arena) {
        // Driving (or getting knocked) into lava blows you up on the spot.
        for (const h of this.map.hazards) {
          if ((k.x - h.x) ** 2 + (k.y - h.y) ** 2 < (h.r - 6) ** 2) { this.damage(k, DAMAGE.lava, null, 'lava'); break; }
        }
        if (k.dead <= 0 && k.hp < this.hpMax && this.time - k.lastHit > REGEN_DELAY) {
          k.hp = Math.min(this.hpMax, k.hp + REGEN_RATE * (this.hpMax / HP_MAX) * dt);
        }
      } else {
        this.trackLaps(k, prevIndex);
      }
    }
    const alive = karts.filter((k) => k.dead <= 0);
    const solid = alive.filter((k) => k.ghost <= 0 && !k.finished);

    // Kart-kart collisions: simple circle separation (ghosts pass through).
    const r2 = (K.KART_RADIUS * 2) ** 2;
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i];
        const b = solid[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2 && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          const push = (K.KART_RADIUS * 2 - d) / 2;
          const nx = dx / d;
          const ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          a.speed *= 0.97; b.speed *= 0.97;
        }
      }
    }

    // Item boxes.
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i] > 0) { this.boxes[i] = Math.max(0, this.boxes[i] - dt); continue; }
      const box = this.map.itemBoxes[i];
      for (const k of alive) {
        if ((k.x - box.x) ** 2 + (k.y - box.y) ** 2 < 32 * 32) {
          this.boxes[i] = this.boxRespawn;
          if (!k.item && !k.finished) {
            k.item = this.rollItem(k);
            k.ammo = k.item === 'triple' ? 3 : 1;
          }
          break;
        }
      }
    }

    this.updateShots(dt, alive);

    // Mines: arm, then blow up when a rival (not the owner or a teammate) drives over.
    for (const m of this.mines) {
      m.life -= dt;
      if (m.arm > 0) { m.arm -= dt; continue; }
      for (const k of alive) {
        if (k.ghost > 0 || k.dead > 0 || k.id === m.owner || this.isFriendly(k.id, m.owner)) continue;
        if ((k.x - m.x) ** 2 + (k.y - m.y) ** 2 < MINE.trigger ** 2) {
          m.life = 0;
          this.explode(m.x, m.y, MINE.radius, DAMAGE.mine, this.karts.get(m.owner), 'mine');
          break;
        }
      }
    }
    this.mines = this.mines.filter((m) => m.life > 0);

    // Bananas spin out anyone (teammates excepted) once the drop grace period expires.
    for (const b of this.bananas) {
      b.life -= dt;
      if (b.safe > 0) b.safe -= dt;
      for (const k of alive) {
        if (k.ghost > 0 || k.dead > 0 || (b.safe > 0 && k.id === b.owner) || this.isFriendly(k.id, b.owner)) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 < (K.KART_RADIUS + 10) ** 2) {
          if (k.invuln > 0 && k.shield <= 0) continue;
          this.damage(k, DAMAGE.banana, this.karts.get(b.owner), 'banana');
          b.life = 0;
          break;
        }
      }
    }
    this.bananas = this.bananas.filter((b) => b.life > 0);
  }

  blocked(x, y) {
    return this.arena ? this.map.blocked(x, y) : this.map.offTrack(x, y, 120);
  }

  updateShots(dt, alive) {
    for (const s of this.shots) {
      const owner = this.karts.get(s.owner);
      if (s.kind === 'rocket') {
        // Gently home in on the nearest enemy ahead.
        let turn = null;
        let bestD = 700 * 700;
        for (const k of alive) {
          if (k.id === s.owner || k.ghost > 0 || k.dead > 0 || this.isFriendly(k.id, s.owner)) continue;
          const dx = k.x - s.x;
          const dy = k.y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > bestD) continue;
          let da = Math.atan2(dy, dx) - s.angle;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          if (Math.abs(da) < Math.PI / 4) { bestD = d2; turn = da; }
        }
        if (turn !== null) s.angle += Math.max(-ROCKET.homing * dt, Math.min(ROCKET.homing * dt, turn));
      }
      const px = s.x;
      const py = s.y;
      s.x += Math.cos(s.angle) * s.speed * dt;
      s.y += Math.sin(s.angle) * s.speed * dt;
      s.life -= dt;
      s.age += dt;

      if (s.kind === 'bomb') {
        // Bombs fly over karts and go off where they land (or against a wall).
        if (s.life <= 0 || (this.arena && this.map.blocked(s.x, s.y))) {
          s.life = 0;
          this.explode(s.x, s.y, BOMB.radius, DAMAGE.bomb, owner, 'bomb');
        }
        continue;
      }
      for (const k of alive) {
        if (k.id === s.owner || k.ghost > 0 || k.dead > 0 || this.isFriendly(k.id, s.owner)) continue;
        // Swept test over this tick's whole path: bullets cover ~60 units a
        // tick, more than a kart is wide, so a point test lets them pass through.
        const r = K.KART_RADIUS + (s.kind === 'bullet' ? 4 : 8);
        if (segmentDist2(px, py, s.x, s.y, k.x, k.y) < r * r) {
          this.damage(k, s.dmg, owner, s.kind === 'bullet' ? 'bullet' : 'rocket');
          s.life = 0;
          if (s.kind === 'rocket') this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 40, kind: 'rocket' });
          break;
        }
      }
      if (s.life > 0 && this.blocked(s.x, s.y)) {
        s.life = 0;
        if (s.kind === 'rocket') this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 40, kind: 'rocket' });
      }
    }
    this.shots = this.shots.filter((s) => s.life > 0);
  }

  trackLaps(k, prevIndex) {
    // Lap counting: crossing index 0 forwards/backwards.
    const n = this.map.n;
    const delta = k.trackIndex - prevIndex;
    if (delta < -n / 2) k.lap++;
    else if (delta > n / 2) k.lap--;
    k.progress = k.lap * n + k.trackIndex - n;

    if (!k.finished && k.lap > this.laps) {
      k.finished = true;
      k.finishTime = this.time - this.raceStart;
      this.finishOrder.push(k.id);
      // Only a human finishing starts the grace countdown; bots finishing first never cut a race short.
      if (this.firstFinishAt === null && !k.bot) this.firstFinishAt = this.time;
      const p = this.room.players.get(k.id);
      const name = k.bot ? `🤖 ${k.name}` : p ? p.name : null;
      this.room.emit('game:kart:finish', { idx: k.idx, place: this.finishOrder.length, time: k.finishTime });
      if (name) this.room.systemMessage(`🏁 ${name} finished #${this.finishOrder.length}`);
    }
  }

  rankings() {
    const list = [...this.karts.values()];
    if (this.arena) return list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.idx - b.idx);
    return list.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
  }

  broadcast() {
    const ranked = this.rankings();
    const place = new Map(ranked.map((k, i) => [k.id, i + 1]));
    const itemCode = (it) => (it ? K.ITEMS.indexOf(it) + 1 : 0);
    const elapsed = this.raceStart !== undefined ? this.time - this.raceStart : 0;
    this.room.emit('game:kart:state', {
      t: Math.round(this.time * 1000),
      phase: this.phase,
      countdown: this.phase === 'countdown' ? COUNTDOWN_S - this.time : 0,
      elapsed,
      timeLeft: this.arena ? Math.max(0, this.duration - elapsed) : null,
      // [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags, kills, deaths, hp]
      k: [...this.karts.values()].map((k) => [
        k.idx, Math.round(k.x), Math.round(k.y), Math.round(k.angle * 1000), Math.round(k.speed),
        Math.max(1, Math.min(this.laps, k.lap)), place.get(k.id), itemCode(k.item), k.ammo,
        (k.spin > 0 ? 1 : 0) | (k.boost > 0 ? 2 : 0) | (k.shield > 0 ? 4 : 0) | (k.finished ? 8 : 0)
          | (k.invuln > 0 ? 16 : 0) | (k.dead > 0 ? 32 : 0)
          | (k.drift ? 64 : 0) | (k.drift && K.driftLevel(k.driftTime) >= 1 ? 128 : 0)
          | (k.drift && K.driftLevel(k.driftTime) >= 2 ? 256 : 0) | (k.drift < 0 ? 512 : 0)
          | (k.ghost > 0 ? 1024 : 0) | (k.gun > 0 ? 2048 : 0),
        // hp is sent as a percentage of this round's max health.
        k.kills, k.deaths, Math.max(0, Math.min(100, Math.round((k.hp / this.hpMax) * 100))),
      ]),
      // shots: [id, kind (1 rocket, 2 bullet, 3 bomb), x, y, angle*1000, flight progress 0-100]
      s: this.shots.map((s) => [s.id, SHOT_CODE[s.kind], Math.round(s.x), Math.round(s.y), Math.round(s.angle * 1000),
        s.kind === 'bomb' ? Math.round((s.age / BOMB.flight) * 100) : 0]),
      m: this.mines.map((m) => [m.id, Math.round(m.x), Math.round(m.y), m.arm > 0 ? 0 : 1]),
      b: this.bananas.map((b) => [b.id, Math.round(b.x), Math.round(b.y)]),
      x: this.boxes.map((t) => (t > 0 ? 0 : 1)),
    });
  }

  endRace() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.broadcast();
    const ranked = this.rankings();
    const n = ranked.length;
    const scores = new Map();
    const details = {};
    ranked.forEach((k, i) => {
      scores.set(k.id, this.arena ? k.kills * KILL_POINTS : (n - i) * 10 + k.hits * 5);
      details[k.id] = {
        place: i + 1, time: k.finishTime, hits: k.hits, finished: k.finished, kills: k.kills, deaths: k.deaths,
      };
    });
    const bots = [...this.karts.values()].filter((k) => k.bot)
      .map((k) => ({ id: k.id, name: k.name, color: k.color, avatar: k.avatar, team: k.team, bot: true }));
    const results = this.room.buildResults(scores, bots);
    results.players.forEach((p) => Object.assign(p, details[p.id] || {}));
    results.map = this.map.type;
    results.mapName = this.map.name;
    // Arena ties on kills are broken by fewer deaths.
    if (this.arena) results.players.sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    this.endTimer = setTimeout(() => this.room.finishGame(this, results), 2500);
  }

  stop() {
    clearInterval(this.interval);
    clearTimeout(this.endTimer);
    this.interval = null;
  }
}

module.exports = {
  KartBattle, DAMAGE, HP_MAX, CLASS_SPEED, BOX_RESPAWN, RESPAWN_TIME, ARENA_HEALTH, KILL_LIMITS, WEAPON_ITEMS, allowedItems,
};
