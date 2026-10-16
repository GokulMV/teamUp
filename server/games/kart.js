const K = require('../../public/js/shared/kart-core');

const TICK_HZ = 30;
const SEND_EVERY = 2; // broadcast at 15 Hz
const COUNTDOWN_S = 4;
const FINISH_GRACE_S = 25;
const ROCKET_SPEED = 1000;
const ROCKET_LIFE = 1.8;
const ROCKET_HOMING = 2.2; // rad/s turn toward the nearest target in front
const BANANA_LIFE = 40;
const SPIN_TIME = 1.4;
const SHIELD_TIME = 4;
const BOOST_TIME = 1.6;
const BOX_RESPAWN = 3;
const RESPAWN_TIME = 2.5; // arena: seconds dead before respawning
const SPAWN_SHIELD = 2;
const KILL_POINTS = 100;

const NO_INPUT = { up: false, down: false, left: false, right: false, drift: false };

// Kart Battle has two variants:
//  - race:  laps around a circuit, items, points for placement + hits
//  - arena: timed deathmatch in an arena; a hit destroys the kart, it respawns
class KartBattle {
  static minPlayers = 1;

  constructor(room) {
    this.room = room;
    this.map = room.settings.kartMode === 'arena' ? 'arena' : 'race';
    this.laps = room.settings.kartLaps;
    this.duration = room.settings.arenaTime;
    this.phase = 'countdown';
    this.time = 0;
    this.karts = new Map();
    this.order = []; // kart index -> player id
    this.rockets = [];
    this.bananas = [];
    this.boxPositions = this.map === 'arena' ? K.ARENA.itemBoxes : K.ITEM_BOXES;
    this.boxes = this.boxPositions.map(() => 0); // respawn timer, 0 = available
    this.finishOrder = [];
    this.firstFinishAt = null;
    this.tickCount = 0;
    this.nextProjectileId = 1;
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
    if (this.map === 'arena') {
      const s = K.ARENA.spawns[slot % K.ARENA.spawns.length];
      g = { x: s.x, y: s.y, angle: s.angle, index: null };
    } else {
      g = K.gridPosition(slot);
    }
    this.karts.set(player.id, {
      idx: this.order.length,
      id: player.id,
      x: g.x, y: g.y, angle: g.angle, speed: 0,
      trackIndex: g.index,
      lap: 0,
      boost: 0, spin: 0, shield: 0, invuln: 0,
      dead: 0,
      item: null, ammo: 0,
      input: { ...NO_INPUT },
      finished: false, finishTime: null,
      hits: 0, kills: 0, deaths: 0,
      progress: this.map === 'race' ? g.index - K.N : 0,
    });
    this.order.push(player.id);
  }

  initPayload() {
    return {
      map: this.map,
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

  useItem(kart) {
    if (!kart.item || kart.spin > 0 || kart.dead > 0 || kart.finished) return;
    const item = kart.item;
    const cos = Math.cos(kart.angle);
    const sin = Math.sin(kart.angle);
    if (item === 'boost') {
      kart.boost = BOOST_TIME;
    } else if (item === 'shield') {
      kart.shield = SHIELD_TIME;
    } else if (item === 'banana') {
      this.bananas.push({ id: this.nextProjectileId++, x: kart.x - cos * 34, y: kart.y - sin * 34, life: BANANA_LIFE, owner: kart.id, safe: 0.6 });
    } else if (item === 'rocket' || item === 'triple') {
      const speed = ROCKET_SPEED + Math.max(0, kart.speed);
      this.rockets.push({
        id: this.nextProjectileId++,
        x: kart.x + cos * 26, y: kart.y + sin * 26,
        angle: kart.angle, speed,
        life: ROCKET_LIFE, owner: kart.id,
      });
    }
    kart.ammo--;
    if (kart.ammo <= 0) { kart.item = null; kart.ammo = 0; }
  }

  rollItem(kart) {
    const r = Math.random();
    if (this.map === 'arena') {
      // Arena is about combat: mostly weapons.
      if (r < 0.4) return 'rocket';
      if (r < 0.58) return 'triple';
      if (r < 0.74) return 'banana';
      if (r < 0.88) return 'shield';
      return 'boost';
    }
    // Karts further behind get better odds of boosts and rockets (rubber banding).
    const ranked = this.rankings();
    const pos = ranked.findIndex((k) => k.id === kart.id);
    const behind = ranked.length > 1 ? pos / (ranked.length - 1) : 0;
    if (r < 0.15 + behind * 0.25) return 'boost';
    if (r < 0.45 + behind * 0.1) return 'rocket';
    if (r < 0.65) return 'banana';
    if (r < 0.82) return 'shield';
    return 'triple';
  }

  isFriendly(a, b) {
    if (!this.room.settings.teamMode) return false;
    const pa = this.room.players.get(a);
    const pb = this.room.players.get(b);
    return pa && pb && pa.team === pb.team;
  }

  hitKart(target, attackerId) {
    if (target.dead > 0) return;
    if (target.shield > 0) { target.shield = 0; target.invuln = 0.5; return; }
    if (target.invuln > 0 || target.finished) return;
    const attacker = attackerId && attackerId !== target.id ? this.karts.get(attackerId) : null;
    if (this.map === 'arena') {
      target.dead = RESPAWN_TIME;
      target.deaths++;
      target.speed = 0;
      target.boost = 0;
      target.item = null;
      target.ammo = 0;
      target.streak = 0;
      // Banana kills on teammates don't count for the dropper.
      if (attacker && !this.isFriendly(attacker.id, target.id)) {
        attacker.kills++;
        attacker.streak = (attacker.streak || 0) + 1;
      }
    } else {
      target.spin = SPIN_TIME;
      target.invuln = SPIN_TIME + 1;
      target.boost = 0;
      if (attacker) attacker.hits++;
    }
    this.room.emit('game:kart:hit', {
      target: target.idx, by: attacker ? attacker.idx : -1, x: Math.round(target.x), y: Math.round(target.y), kill: this.map === 'arena',
      streak: attacker && this.map === 'arena' ? attacker.streak || 0 : 0,
    });
  }

  respawn(kart) {
    // Pick the spawn point furthest from every living enemy.
    let best = K.ARENA.spawns[0];
    let bestScore = -Infinity;
    for (const s of K.ARENA.spawns) {
      let nearest = Infinity;
      for (const k of this.karts.values()) {
        if (k === kart || k.dead > 0) continue;
        nearest = Math.min(nearest, (k.x - s.x) ** 2 + (k.y - s.y) ** 2);
      }
      const score = nearest + Math.random() * 1000;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    Object.assign(kart, { x: best.x, y: best.y, angle: best.angle, speed: 0, spin: 0, dead: 0, shield: SPAWN_SHIELD, invuln: 0 });
  }

  tick(dt) {
    this.time += dt;
    this.tickCount++;

    if (this.phase === 'countdown') {
      if (this.time >= COUNTDOWN_S) { this.phase = 'racing'; this.raceStart = this.time; }
    } else if (this.phase === 'racing') {
      this.simulate(dt);
      const elapsed = this.time - this.raceStart;
      if (this.map === 'arena') {
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
      const input = k.finished ? { up: false, down: true } : k.input;
      const prevIndex = k.trackIndex;
      K.stepKart(k, input, dt, this.map);
      if (k.shield > 0) k.shield = Math.max(0, k.shield - dt);
      if (k.invuln > 0) k.invuln = Math.max(0, k.invuln - dt);

      if (this.map === 'race') this.trackLaps(k, prevIndex);
    }
    const alive = karts.filter((k) => k.dead <= 0);

    // Kart-kart collisions: simple circle separation.
    const r2 = (K.KART_RADIUS * 2) ** 2;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
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
      const box = this.boxPositions[i];
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

    // Rockets: fly forward, gently home in on the nearest enemy ahead.
    for (const r of this.rockets) {
      let target = null;
      let bestD = 700 * 700;
      for (const k of alive) {
        if (k.id === r.owner || this.isFriendly(k.id, r.owner)) continue;
        const dx = k.x - r.x;
        const dy = k.y - r.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > bestD) continue;
        let da = Math.atan2(dy, dx) - r.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) < Math.PI / 4) { bestD = d2; target = da; }
      }
      if (target !== null) r.angle += Math.max(-ROCKET_HOMING * dt, Math.min(ROCKET_HOMING * dt, target));
      r.x += Math.cos(r.angle) * r.speed * dt;
      r.y += Math.sin(r.angle) * r.speed * dt;
      r.life -= dt;
      for (const k of alive) {
        if (k.id === r.owner || this.isFriendly(k.id, r.owner) || k.dead > 0) continue;
        if ((k.x - r.x) ** 2 + (k.y - r.y) ** 2 < (K.KART_RADIUS + 8) ** 2) {
          this.hitKart(k, r.owner);
          r.life = 0;
          break;
        }
      }
      if (r.life > 0) {
        const blocked = this.map === 'arena'
          ? K.arenaBlocked(r.x, r.y)
          : K.nearestIndex(r.x, r.y).dist > K.TRACK_WIDTH / 2 + 120;
        if (blocked) {
          r.life = 0;
          this.room.emit('game:kart:boom', { x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
    }
    this.rockets = this.rockets.filter((r) => r.life > 0);

    // Bananas hit anyone (including teammates) once the drop grace period expires.
    for (const b of this.bananas) {
      b.life -= dt;
      if (b.safe > 0) b.safe -= dt;
      for (const k of alive) {
        if (k.dead > 0 || (b.safe > 0 && k.id === b.owner)) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 < (K.KART_RADIUS + 10) ** 2) {
          if (k.invuln > 0 && k.shield <= 0) continue;
          this.hitKart(k, b.owner);
          b.life = 0;
          break;
        }
      }
    }
    this.bananas = this.bananas.filter((b) => b.life > 0);
  }

  trackLaps(k, prevIndex) {
    // Lap counting: crossing index 0 forwards/backwards.
    const delta = k.trackIndex - prevIndex;
    if (delta < -K.N / 2) k.lap++;
    else if (delta > K.N / 2) k.lap--;
    k.progress = k.lap * K.N + k.trackIndex - K.N;

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
    if (this.map === 'arena') return list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.idx - b.idx);
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
      timeLeft: this.map === 'arena' ? Math.max(0, this.duration - elapsed) : null,
      // [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags, kills, deaths]
      k: [...this.karts.values()].map((k) => [
        k.idx, Math.round(k.x), Math.round(k.y), Math.round(k.angle * 1000), Math.round(k.speed),
        Math.max(1, Math.min(this.laps, k.lap)), place.get(k.id), itemCode(k.item), k.ammo,
        (k.spin > 0 ? 1 : 0) | (k.boost > 0 ? 2 : 0) | (k.shield > 0 ? 4 : 0) | (k.finished ? 8 : 0)
          | (k.invuln > 0 ? 16 : 0) | (k.dead > 0 ? 32 : 0)
          | (k.drift ? 64 : 0) | (k.drift && K.driftLevel(k.driftTime) >= 1 ? 128 : 0)
          | (k.drift && K.driftLevel(k.driftTime) >= 2 ? 256 : 0) | (k.drift < 0 ? 512 : 0),
        k.kills, k.deaths,
      ]),
      r: this.rockets.map((r) => [r.id, Math.round(r.x), Math.round(r.y), Math.round(r.angle * 1000)]),
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
      scores.set(k.id, this.map === 'arena' ? k.kills * KILL_POINTS : (n - i) * 10 + k.hits * 5);
      details[k.id] = {
        place: i + 1, time: k.finishTime, hits: k.hits, finished: k.finished, kills: k.kills, deaths: k.deaths,
      };
    });
    const results = this.room.buildResults(scores);
    results.players.forEach((p) => Object.assign(p, details[p.id] || {}));
    results.map = this.map;
    // Arena ties on kills are broken by fewer deaths.
    if (this.map === 'arena') results.players.sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    this.endTimer = setTimeout(() => this.room.finishGame(this, results), 2500);
  }

  stop() {
    clearInterval(this.interval);
    clearTimeout(this.endTimer);
    this.interval = null;
  }
}

module.exports = { KartBattle };
