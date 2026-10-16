const K = require('../../public/js/shared/kart-core');

const TICK_HZ = 30;
const SEND_EVERY = 2; // broadcast at 15 Hz
const COUNTDOWN_S = 4;
const FINISH_GRACE_S = 25;
const BOX_RESPAWN = 3;
const SPIN_TIME = 1.4;
const SHIELD_TIME = 4;
const GHOST_TIME = 4;
const BOOST_TIME = 1.6;
const RESPAWN_TIME = 2.5; // arena: seconds dead before respawning
const SPAWN_SHIELD = 2;
const KILL_POINTS = 100;
const HP_MAX = 100;
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
const DAMAGE = { rocket: 70, triple: 45, bullet: 9, banana: 35, mine: 100, bomb: 100, shock: 45, lava: 45 };

const SHOT_CODE = { rocket: 1, bullet: 2, bomb: 3 };
const NO_INPUT = { up: false, down: false, left: false, right: false, drift: false };

// Item odds. Arena favours weapons; in a race, karts at the back get stronger items.
const ARENA_ODDS = { rocket: 20, triple: 10, minigun: 13, bomb: 10, mine: 10, shock: 8, banana: 7, shield: 8, ghost: 6, boost: 8 };
const RACE_ODDS_FRONT = { banana: 26, mine: 18, shield: 18, rocket: 14, minigun: 10, boost: 8, bomb: 6, ghost: 0, triple: 0, shock: 0 };
const RACE_ODDS_BACK = { boost: 26, rocket: 16, triple: 14, shock: 12, ghost: 10, minigun: 8, bomb: 8, shield: 4, banana: 2, mine: 0 };

function weightedPick(odds) {
  const total = Object.values(odds).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [item, w] of Object.entries(odds)) {
    r -= w;
    if (r <= 0) return item;
  }
  return 'boost';
}

// Kart Battle has two variants:
//  - race:  laps around a circuit, items, points for placement + hits
//  - arena: timed deathmatch with health; destroyed karts respawn
class KartBattle {
  static minPlayers = 1;

  constructor(room) {
    this.room = room;
    const type = room.settings.kartMode === 'arena' ? 'arena' : 'race';
    this.map = K.getMap(room.settings.kartMap, type);
    this.arena = this.map.type === 'arena';
    this.laps = room.settings.kartLaps;
    this.duration = room.settings.arenaTime;
    this.phase = 'countdown';
    this.time = 0;
    this.karts = new Map();
    this.order = []; // kart index -> player id
    this.shots = []; // rockets, bullets, bombs
    this.mines = [];
    this.bananas = [];
    this.boxes = this.map.itemBoxes.map(() => 0); // respawn timer, 0 = available
    this.finishOrder = [];
    this.firstFinishAt = null;
    this.tickCount = 0;
    this.nextId = 1;
    this.interval = null;
  }

  start() {
    const players = this.room.connectedPlayers;
    players.forEach((p, slot) => this.addKart(p, slot));
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
    this.karts.set(player.id, {
      idx: this.order.length,
      id: player.id,
      x: g.x, y: g.y, angle: g.angle, speed: 0,
      trackIndex: g.index,
      lap: 0,
      boost: 0, spin: 0, shield: 0, invuln: 0, ghost: 0,
      gun: 0, gunCd: 0,
      hp: HP_MAX, lastHit: -99, lastAttacker: null,
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
      karts: this.order.map((id, idx) => {
        const p = this.room.players.get(id);
        return { idx, id, name: p ? p.name : '?', color: p ? p.color : '#888', team: p ? p.team : 0 };
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
    if (!kart.item || kart.spin > 0 || kart.dead > 0 || kart.finished) return;
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
    if (this.arena) return weightedPick(ARENA_ODDS);
    const ranked = this.rankings();
    const pos = ranked.findIndex((k) => k.id === kart.id);
    const behind = ranked.length > 1 ? pos / (ranked.length - 1) : 0;
    const odds = {};
    for (const item of Object.keys(RACE_ODDS_FRONT)) {
      odds[item] = RACE_ODDS_FRONT[item] * (1 - behind) + RACE_ODDS_BACK[item] * behind;
    }
    return weightedPick(odds);
  }

  isFriendly(a, b) {
    if (!a || !b || a === b || !this.room.settings.teamMode) return false;
    const pa = this.room.players.get(a);
    const pb = this.room.players.get(b);
    return !!(pa && pb && pa.team === pb.team);
  }

  // ---------- damage ----------
  damage(target, amount, attacker, kind) {
    if (target.dead > 0 || target.finished || target.ghost > 0) return;
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
        target.speed *= 0.72;
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
    target.dead = RESPAWN_TIME;
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
      shield: SPAWN_SHIELD, invuln: 0, hp: HP_MAX, lastAttacker: null,
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
        const allDone = [...this.karts.values()].every((k) => k.finished || !this.room.players.get(k.id)?.connected);
        const graceOver = this.firstFinishAt !== null && this.time - this.firstFinishAt > FINISH_GRACE_S;
        const hardLimit = elapsed > this.laps * 120 + 60;
        if (allDone || graceOver || hardLimit) this.endRace();
      }
    }

    if (this.tickCount % SEND_EVERY === 0) this.broadcast();
  }

  simulate(dt) {
    const karts = [...this.karts.values()];
    for (const k of karts) {
      if (k.dead > 0) {
        k.dead -= dt;
        if (k.dead <= 0) this.respawn(k);
        continue;
      }
      const input = k.finished ? { down: true } : k.input;
      const prevIndex = k.trackIndex;
      K.stepKart(k, input, dt, this.map);
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
        for (const h of this.map.hazards) {
          if ((k.x - h.x) ** 2 + (k.y - h.y) ** 2 < h.r * h.r) this.damage(k, DAMAGE.lava * dt, null, 'lava');
        }
        if (k.dead <= 0 && k.hp < HP_MAX && this.time - k.lastHit > REGEN_DELAY) k.hp = Math.min(HP_MAX, k.hp + REGEN_RATE * dt);
      } else {
        this.trackLaps(k, prevIndex);
      }
    }
    const alive = karts.filter((k) => k.dead <= 0);
    const solid = alive.filter((k) => k.ghost <= 0);

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
          this.boxes[i] = BOX_RESPAWN;
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
        const r = K.KART_RADIUS + (s.kind === 'bullet' ? 4 : 8);
        if ((k.x - s.x) ** 2 + (k.y - s.y) ** 2 < r * r) {
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
      if (this.firstFinishAt === null) this.firstFinishAt = this.time;
      const p = this.room.players.get(k.id);
      this.room.emit('game:kart:finish', { idx: k.idx, place: this.finishOrder.length, time: k.finishTime });
      if (p) this.room.systemMessage(`🏁 ${p.name} finished #${this.finishOrder.length}`);
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
        k.kills, k.deaths, Math.max(0, Math.round(k.hp)),
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
    const results = this.room.buildResults(scores);
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

module.exports = { KartBattle, DAMAGE, HP_MAX };
