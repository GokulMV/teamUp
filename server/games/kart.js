const K = require('../../public/js/shared/kart-core');

const TICK_HZ = 30;
const SEND_EVERY = 2; // broadcast at 15 Hz
const COUNTDOWN_S = 4;
const FINISH_GRACE_S = 25;
const ROCKET_SPEED = 1000;
const ROCKET_LIFE = 1.8;
const BANANA_LIFE = 40;
const SPIN_TIME = 1.4;
const SHIELD_TIME = 4;
const BOOST_TIME = 1.6;
const BOX_RESPAWN = 3;

class KartBattle {
  static minPlayers = 1;

  constructor(room) {
    this.room = room;
    this.laps = room.settings.kartLaps;
    this.phase = 'countdown';
    this.time = 0;
    this.karts = new Map();
    this.order = []; // kart index -> player id
    this.rockets = [];
    this.bananas = [];
    this.boxes = K.ITEM_BOXES.map(() => 0); // respawn timer, 0 = available
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
    const g = K.gridPosition(slot);
    this.karts.set(player.id, {
      idx: this.order.length,
      id: player.id,
      x: g.x, y: g.y, angle: g.angle, speed: 0,
      trackIndex: g.index,
      lap: 0,
      boost: 0, spin: 0, shield: 0, invuln: 0,
      item: null, ammo: 0,
      input: { up: false, down: false, left: false, right: false },
      finished: false, finishTime: null,
      hits: 0,
      progress: g.index - K.N,
    });
    this.order.push(player.id);
  }

  initPayload() {
    return {
      laps: this.laps,
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
    // Late joiners spectate this race; they'll be on the grid for the next one.
    this.room.emitTo(player.id, 'game:kart:init', this.initPayload());
  }

  onPlayerLeave(player) {
    const kart = this.karts.get(player.id);
    if (kart) kart.input = { up: false, down: false, left: false, right: false };
  }

  onPlayerDisconnect(player) {
    this.onPlayerLeave(player);
  }

  onEvent(player, event, data, reply) {
    if (event === 'ping') { reply({ ok: true }); return; }
    const kart = this.karts.get(player.id);
    if (!kart) return;
    if (event === 'input') {
      kart.input = { up: !!data?.up, down: !!data?.down, left: !!data?.left, right: !!data?.right };
    } else if (event === 'use') {
      if (this.phase === 'racing') this.useItem(kart);
    }
  }

  useItem(kart) {
    if (!kart.item || kart.spin > 0 || kart.finished) return;
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
      this.rockets.push({
        id: this.nextProjectileId++,
        x: kart.x + cos * 26, y: kart.y + sin * 26,
        vx: cos * (ROCKET_SPEED + Math.max(0, kart.speed)), vy: sin * (ROCKET_SPEED + Math.max(0, kart.speed)),
        life: ROCKET_LIFE, owner: kart.id,
      });
    }
    kart.ammo--;
    if (kart.ammo <= 0) { kart.item = null; kart.ammo = 0; }
  }

  rollItem(kart) {
    // Karts further behind get better odds of boosts and rockets (rubber banding).
    const ranked = this.rankings();
    const pos = ranked.findIndex((r) => r.id === kart.id);
    const behind = ranked.length > 1 ? pos / (ranked.length - 1) : 0;
    const r = Math.random();
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
    if (target.shield > 0) { target.shield = 0; target.invuln = 0.5; return; }
    if (target.invuln > 0 || target.finished) return;
    target.spin = SPIN_TIME;
    target.invuln = SPIN_TIME + 1;
    target.boost = 0;
    const attacker = attackerId && attackerId !== target.id ? this.karts.get(attackerId) : null;
    if (attacker) attacker.hits++;
    this.room.emit('game:kart:hit', { target: target.idx, by: attacker ? attacker.idx : -1 });
  }

  tick(dt) {
    this.time += dt;
    this.tickCount++;

    if (this.phase === 'countdown') {
      if (this.time >= COUNTDOWN_S) { this.phase = 'racing'; this.raceStart = this.time; }
    } else if (this.phase === 'racing') {
      this.simulate(dt);
      const allDone = [...this.karts.values()].every((k) => k.finished || !this.room.players.get(k.id)?.connected);
      const graceOver = this.firstFinishAt !== null && this.time - this.firstFinishAt > FINISH_GRACE_S;
      const hardLimit = this.time - this.raceStart > this.laps * 120 + 60;
      if (allDone || graceOver || hardLimit) this.endRace();
    }

    if (this.tickCount % SEND_EVERY === 0) this.broadcast();
  }

  simulate(dt) {
    const karts = [...this.karts.values()];
    for (const k of karts) {
      const input = k.finished ? { up: false, down: true } : k.input;
      const prevIndex = k.trackIndex;
      K.stepKart(k, input, dt);
      if (k.shield > 0) k.shield = Math.max(0, k.shield - dt);
      if (k.invuln > 0) k.invuln = Math.max(0, k.invuln - dt);

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

    // Kart-kart collisions: simple circle separation.
    const r2 = (K.KART_RADIUS * 2) ** 2;
    for (let i = 0; i < karts.length; i++) {
      for (let j = i + 1; j < karts.length; j++) {
        const a = karts[i];
        const b = karts[j];
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
      const box = K.ITEM_BOXES[i];
      for (const k of karts) {
        if ((k.x - box.x) ** 2 + (k.y - box.y) ** 2 < 30 * 30) {
          this.boxes[i] = BOX_RESPAWN;
          if (!k.item && !k.finished) {
            k.item = this.rollItem(k);
            k.ammo = k.item === 'triple' ? 3 : 1;
          }
          break;
        }
      }
    }

    // Rockets.
    for (const r of this.rockets) {
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.life -= dt;
      for (const k of karts) {
        if (k.id === r.owner || this.isFriendly(k.id, r.owner)) continue;
        if ((k.x - r.x) ** 2 + (k.y - r.y) ** 2 < (K.KART_RADIUS + 8) ** 2) {
          this.hitKart(k, r.owner);
          r.life = 0;
          break;
        }
      }
      // Rockets explode when they leave the track area.
      if (r.life > 0 && K.nearestIndex(r.x, r.y).dist > K.TRACK_WIDTH / 2 + 120) r.life = 0;
    }
    this.rockets = this.rockets.filter((r) => r.life > 0);

    // Bananas hit anyone (including teammates) once the drop grace period expires.
    for (const b of this.bananas) {
      b.life -= dt;
      if (b.safe > 0) b.safe -= dt;
      for (const k of karts) {
        if (b.safe > 0 && k.id === b.owner) continue;
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

  rankings() {
    return [...this.karts.values()].sort((a, b) => {
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
    this.room.emit('game:kart:state', {
      t: Math.round(this.time * 1000),
      phase: this.phase,
      countdown: this.phase === 'countdown' ? COUNTDOWN_S - this.time : 0,
      elapsed: this.raceStart !== undefined ? this.time - this.raceStart : 0,
      // [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags]
      k: [...this.karts.values()].map((k) => [
        k.idx, Math.round(k.x), Math.round(k.y), Math.round(k.angle * 1000), Math.round(k.speed),
        Math.max(1, Math.min(this.laps, k.lap)), place.get(k.id), itemCode(k.item), k.ammo,
        (k.spin > 0 ? 1 : 0) | (k.boost > 0 ? 2 : 0) | (k.shield > 0 ? 4 : 0) | (k.finished ? 8 : 0) | (k.invuln > 0 ? 16 : 0),
      ]),
      r: this.rockets.map((r) => [r.id, Math.round(r.x), Math.round(r.y), Math.round(Math.atan2(r.vy, r.vx) * 1000)]),
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
      const placePts = (n - i) * 10;
      scores.set(k.id, placePts + k.hits * 5);
      details[k.id] = { place: i + 1, time: k.finishTime, hits: k.hits, finished: k.finished };
    });
    const results = this.room.buildResults(scores);
    results.players.forEach((p) => Object.assign(p, details[p.id] || {}));
    this.endTimer = setTimeout(() => this.room.finishGame(this, results), 2500);
  }

  stop() {
    clearInterval(this.interval);
    clearTimeout(this.endTimer);
    this.interval = null;
  }
}

module.exports = { KartBattle };
