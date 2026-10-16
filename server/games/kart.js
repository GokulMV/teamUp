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
const FALL_INVULN = 1.5; // race: blinking after being fished out of water/lava
const KILL_POINTS = 100;
const HP_MAX = 100; // default arena health ('normal')
const REGEN_DELAY = 3;
const REGEN_RATE = 10; // hp per second

const ROCKET = { speed: 1000, life: 1.8, homing: 2.2 };
const BULLET = { speed: 1700, life: 0.55, every: 0.08, spread: 0.06 };
const BOMB = { speed: 650, flight: 0.85, radius: 140 };
const MINE = { arm: 0.8, life: 60, trigger: 40, radius: 95 };
// Bouncer shell: fired straight (backwards when braking), caroms off walls and obstacles.
const BOUNCER = { speed: 880, life: 6, bounces: 5, radius: 8 };
// Comet: climbs, flies over the track to the leader (arena: the top scorer) and dives onto them.
const COMET = { speed: 1900, altitude: 110, climb: 0.45, dive: 0.5, divePoint: 380, radius: 190, life: 15 };
const INK_RADIUS = 900; // arena: how far ink reaches
const SHOCK_RADIUS = 360;
const GUN_TIME = 2;
const BANANA_LIFE = 40;
const { roulette: ROULETTE_TIME, starTime: STAR_TIME, shrinkTime: SHRINK_TIME, inkTime: INK_TIME } = K.ITEM_FX;
// Comets and thunder are rare: once one comes out of a box, nobody rolls another for a while.
const RARE_COOLDOWN = { comet: 12, thunder: 20 };
// Race tracks have height: karts flying higher than this pass over bananas and mines (item boxes float higher).
const GROUND_CLEAR = 18;
const BOX_CLEAR = 40;

// Damage in the arena (karts have 100 hp). In a race every hit except bullets spins you out.
const DAMAGE = {
  rocket: 70, triple: 45, bullet: 6, banana: 35, mine: 100, bomb: 100, shock: 45, lava: 1000, // lava is instant death
  bouncer: 50, comet: 90, star: 40, thunder: 35,
};

const SHOT_CODE = { rocket: 1, bullet: 2, bomb: 3, bouncer: 4, comet: 5 };
const NO_INPUT = { up: false, down: false, left: false, right: false, drift: false };
const TIMERS = ['shield', 'invuln', 'ghost', 'star', 'shrink', 'ink', 'roulette']; // per-kart countdowns (seconds)

// Item odds. Arena favours weapons; in a race, karts at the back get stronger items.
const ARENA_ODDS = {
  rocket: 18, triple: 9, minigun: 12, bomb: 9, mine: 9, shock: 7, banana: 6, shield: 7, ghost: 5, boost: 7,
  bouncer: 12, comet: 3, star: 5, ink: 4, thunder: 2,
};
const RACE_ODDS_FRONT = {
  banana: 24, mine: 14, shield: 14, rocket: 10, minigun: 8, boost: 8, bomb: 5, ghost: 0, triple: 0, shock: 0,
  bouncer: 16, comet: 0, star: 0, ink: 4, thunder: 0,
};
const RACE_ODDS_BACK = {
  boost: 22, rocket: 12, triple: 13, shock: 10, ghost: 8, minigun: 6, bomb: 6, shield: 3, banana: 1, mine: 0,
  bouncer: 4, comet: 6, star: 13, ink: 5, thunder: 4,
};

// Room options (see DEFAULT_SETTINGS in server/rooms.js).
const CLASS_SPEED = { chill: 0.82, standard: 1, turbo: 1.18 };
const BOX_RESPAWN = { rare: 6, normal: 3, frequent: 1.5 };
const RESPAWN_TIME = { fast: 1.5, normal: 2.5, slow: 4 }; // arena: seconds dead before respawning
const ARENA_HEALTH = { low: 60, normal: 100, high: 150 };
const KILL_LIMITS = [0, 5, 10, 15, 25];
const WEAPON_ITEMS = ['rocket', 'triple', 'minigun', 'bomb', 'mine', 'shock', 'bouncer', 'comet', 'thunder'];

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
    this.lastRare = { comet: -Infinity, thunder: -Infinity }; // when each rare item last came out of a box
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
      star: 0, shrink: 0, ink: 0, // seconds left of star power, thunder shrink, ink on the screen
      gun: 0, gunCd: 0,
      hp: this.hpMax, lastHit: -99, lastAttacker: null,
      dead: 0,
      item: null, ammo: 0, roulette: 0, // the item can't be used until the roulette stops
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
      itemList: this.items, // what the item roulette cycles through
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
    const shot = {
      id: this.nextId++, kind, owner: kart.id,
      x: kart.x + Math.cos(a) * 26, y: kart.y + Math.sin(a) * 26, angle: a, speed,
      life: kind === 'bullet' ? BULLET.life : kind === 'bomb' ? BOMB.flight : ROCKET.life,
      age: 0,
      ti: kart.trackIndex, // nearest centerline sample, a hint for cheap wall checks
      dmg: kind === 'rocket' && kart.item === 'triple' ? DAMAGE.triple : DAMAGE[kind],
    };
    if (kind === 'bomb') {
      // Where it will land, so everyone can see the danger zone.
      shot.lx = shot.x + Math.cos(a) * speed * BOMB.flight;
      shot.ly = shot.y + Math.sin(a) * speed * BOMB.flight;
    }
    this.shots.push(shot);
    return shot;
  }

  // Straight ahead, or backwards when braking. The owner can be hit once it has bounced.
  fireBouncer(kart, back) {
    const a = kart.angle + (back ? Math.PI : 0);
    const fwd = Math.max(0, kart.speed);
    this.shots.push({
      id: this.nextId++, kind: 'bouncer', owner: kart.id,
      x: kart.x + Math.cos(a) * 30, y: kart.y + Math.sin(a) * 30, angle: a,
      speed: back ? BOUNCER.speed * 0.85 : BOUNCER.speed + fwd * 0.8,
      life: BOUNCER.life, age: 0, ti: kart.trackIndex, bounces: BOUNCER.bounces, bounced: false, dmg: DAMAGE.bouncer,
    });
  }

  launchComet(kart) {
    const target = this.cometTarget(kart);
    const comet = {
      id: this.nextId++, kind: 'comet', owner: kart.id, target: target ? target.id : null,
      x: kart.x, y: kart.y, angle: kart.angle, speed: COMET.speed, alt: 20,
      life: COMET.life, age: 0, phase: 'cruise', dmg: DAMAGE.comet,
    };
    if (!this.arena) {
      // Ride the centerline from here; the sideways offset to it fades out as the comet climbs.
      const near = this.map.nearestIndex(kart.x, kart.y, kart.trackIndex);
      comet.ci = near.index;
      comet.ox = kart.x - this.map.centerline[near.index][0];
      comet.oy = kart.y - this.map.centerline[near.index][1];
    }
    this.shots.push(comet);
  }

  // Race: the best placed rival still racing. Arena: the top scorer among rivals.
  cometTarget(owner) {
    return this.rankings().find((k) => k !== owner && k.dead <= 0 && !k.finished && !this.isFriendly(k.id, owner.id)) || null;
  }

  useItem(kart, opts = {}) {
    if (this.phase !== 'racing' || !kart.item || kart.roulette > 0 || kart.spin > 0 || kart.dead > 0 || kart.fall > 0 || kart.finished) return false;
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
      case 'banana': {
        const [x, y] = [kart.x - cos * 34, kart.y - sin * 34];
        if (this.solidGround(x, y, kart)) this.bananas.push({ id: this.nextId++, x, y, life: BANANA_LIFE, owner: kart.id, safe: 0.6 });
        break;
      }
      case 'mine': {
        const [x, y] = [kart.x - cos * 36, kart.y - sin * 36];
        if (this.solidGround(x, y, kart)) this.mines.push({ id: this.nextId++, x, y, owner: kart.id, arm: MINE.arm, life: MINE.life });
        break;
      }
      case 'shock': this.shock(kart); break;
      case 'bouncer': this.fireBouncer(kart, opts.back !== undefined ? !!opts.back : !!kart.input.down); break;
      case 'comet': this.launchComet(kart); break;
      case 'star': kart.star = STAR_TIME; kart.boost = Math.max(kart.boost, 0.3); break;
      case 'ink': this.ink(kart); break;
      case 'thunder': this.thunder(kart); break;
      default:
    }
    this.room.emit('game:kart:use', { idx: kart.idx, item });
    kart.ammo--;
    if (kart.ammo <= 0) { kart.item = null; kart.ammo = 0; }
    return true;
  }

  // Can a dropped item lie here? Over a gap, water or lava it just falls in.
  solidGround(x, y, kart) {
    if (this.arena) return true;
    const q = this.map.nearestIndex(x, y, kart.trackIndex);
    return !this.map.gap[q.index] && !this.map.hazardAt(x, y, q);
  }

  shock(kart) {
    for (const k of this.karts.values()) {
      if (k === kart || k.dead > 0 || this.isFriendly(k.id, kart.id)) continue;
      if ((k.x - kart.x) ** 2 + (k.y - kart.y) ** 2 < SHOCK_RADIUS ** 2) this.damage(k, DAMAGE.shock, kart, 'shock');
    }
    this.room.emit('game:kart:shock', { idx: kart.idx, x: Math.round(kart.x), y: Math.round(kart.y), r: SHOCK_RADIUS });
  }

  // Can an item from `owner` reach kart k at all? (Ghosts and stars shrug everything off.)
  affectable(k, owner) {
    return k !== owner && k.dead <= 0 && !k.finished && k.ghost <= 0 && k.star <= 0 && !this.isFriendly(k.id, owner.id);
  }

  // Ink: race, every rival ahead of you; arena, every rival nearby. A shield bubble keeps it off.
  ink(kart) {
    const hit = [];
    for (const k of this.karts.values()) {
      if (!this.affectable(k, kart) || k.shield > 0) continue;
      if (this.arena ? (k.x - kart.x) ** 2 + (k.y - kart.y) ** 2 > INK_RADIUS ** 2 : k.progress <= kart.progress) continue;
      k.ink = INK_TIME;
      hit.push(k.idx);
    }
    this.room.emit('game:kart:ink', { idx: kart.idx, hit });
  }

  // Thunder strikes every rival. Race: spin out, shrink, slow down and lose your item. Arena: damage.
  thunder(kart) {
    const hit = [];
    for (const k of this.karts.values()) {
      if (k === kart || k.dead > 0 || k.finished || this.isFriendly(k.id, kart.id)) continue;
      if (this.damage(k, DAMAGE.thunder, kart, 'thunder')) hit.push(k.idx);
    }
    if (hit.length && !this.arena) kart.hits++;
    this.room.emit('game:kart:thunder', { idx: kart.idx, hit });
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
    for (const item of Object.keys(RARE_COOLDOWN)) {
      if (odds[item] && this.time - this.lastRare[item] < RARE_COOLDOWN[item]) odds[item] = 0;
    }
    if (!Object.values(odds).some((w) => w > 0)) for (const item of this.items) odds[item] = 1;
    const item = weightedPick(odds);
    if (RARE_COOLDOWN[item]) this.lastRare[item] = this.time;
    return item;
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
  // Returns true when the hit landed (not dodged, blocked or friendly).
  damage(target, amount, attacker, kind) {
    // Nothing more can happen once the round is over (e.g. a kill limit hit mid-blast).
    if (this.phase !== 'racing') return false;
    if (target.dead > 0 || target.finished || target.fall > 0 || (target.ghost > 0 && kind !== 'lava')) return false;
    if (attacker && attacker !== target && this.isFriendly(attacker.id, target.id)) return false;
    if (kind !== 'lava') {
      if (target.star > 0) return false; // star power: invincible
      if (target.shield > 0) {
        target.shield = 0;
        target.invuln = 0.4;
        this.room.emit('game:kart:block', { idx: target.idx });
        return false;
      }
      if (target.invuln > 0) return false;
    }
    const by = attacker && attacker !== target ? attacker : null;
    const event = { target: target.idx, by: by ? by.idx : -1, x: Math.round(target.x), y: Math.round(target.y), kind, kill: false, streak: 0 };

    if (!this.arena) {
      if (kind === 'bullet') {
        target.speed *= 0.82;
        this.room.emit('game:kart:hit', event);
        return true;
      }
      target.spin = SPIN_TIME;
      target.invuln = SPIN_TIME + 1;
      target.boost = 0;
      if (kind === 'thunder') {
        // Shrunk for a while (slower top speed) and the item is gone, roulette and all.
        Object.assign(target, { shrink: SHRINK_TIME, item: null, ammo: 0, roulette: 0, gun: 0 });
      } else if (by) {
        by.hits++; // thunder counts once for the striker, in thunder()
      }
      this.room.emit('game:kart:hit', event);
      return true;
    }

    target.hp -= amount;
    if (kind !== 'lava' || !target.lastAttacker) target.lastHit = this.time;
    if (by) { target.lastAttacker = by.id; target.lastHit = this.time; }
    if (kind === 'banana') { target.spin = 0.8; target.invuln = 0.3; }
    if (target.hp > 0) {
      if (kind !== 'lava') this.room.emit('game:kart:hit', event);
      return true;
    }
    // Destroyed. Lava kills go to whoever hit you last (within 5 s), so knocking rivals in counts.
    let killer = by;
    if (!killer && target.lastAttacker && this.time - target.lastHit < 5) killer = this.karts.get(target.lastAttacker) || null;
    if (killer === target) killer = null;
    target.dead = this.respawnTime;
    target.deaths++;
    target.streak = 0;
    Object.assign(target, { speed: 0, boost: 0, item: null, ammo: 0, roulette: 0, gun: 0, drift: 0, hp: 0, star: 0, shrink: 0, ink: 0 });
    if (killer && !this.isFriendly(killer.id, target.id)) {
      killer.kills++;
      killer.streak++;
      event.streak = killer.streak;
    }
    event.by = killer ? killer.idx : -1;
    event.kill = true;
    this.room.emit('game:kart:hit', event);
    if (killer) this.checkKillLimit(killer);
    return true;
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
      const d = Math.hypot(k.x - x, k.y - y, k.air || 0); // blasts are on the ground: high flyers escape
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
      const wasFalling = k.fall > 0;
      K.stepKart(k, input, dt, this.map, { speed: k.speedMul * K.itemSpeed(k.star > 0, k.shrink > 0) });
      if (!wasFalling && k.fall > 0) {
        // Off the road into water, lava or a gap: fished back out after a moment.
        k.gun = 0;
        this.room.emit('game:kart:fall', { idx: k.idx, x: Math.round(k.x), y: Math.round(k.y), kind: k.fallKind });
      } else if (wasFalling && !(k.fall > 0)) {
        k.invuln = Math.max(k.invuln, FALL_INVULN);
      }
      for (const t of TIMERS) if (k[t] > 0) k[t] = Math.max(0, k[t] - dt);

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
    const alive = karts.filter((k) => k.dead <= 0 && !(k.fall > 0));
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
        if (d2 < r2 && d2 > 0.0001 && Math.abs((a.air || 0) - (b.air || 0)) < 30) {
          const d = Math.sqrt(d2);
          const push = (K.KART_RADIUS * 2 - d) / 2;
          const nx = dx / d;
          const ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          if ((a.star > 0) !== (b.star > 0)) {
            if (a.star > 0) this.starRam(a, b, nx, ny);
            else this.starRam(b, a, -nx, -ny);
          } else {
            a.speed *= 0.97; b.speed *= 0.97;
          }
        }
      }
    }

    // Item boxes.
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i] > 0) { this.boxes[i] = Math.max(0, this.boxes[i] - dt); continue; }
      const box = this.map.itemBoxes[i];
      for (const k of alive) {
        if ((k.air || 0) < BOX_CLEAR && (k.x - box.x) ** 2 + (k.y - box.y) ** 2 < 32 * 32) {
          this.boxes[i] = this.boxRespawn;
          if (!k.item && !k.finished) {
            // Decided now, usable once the roulette in the HUD stops spinning.
            k.item = this.rollItem(k);
            k.ammo = k.item === 'triple' ? 3 : 1;
            k.roulette = k.item ? ROULETTE_TIME : 0;
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
        if (k.ghost > 0 || k.dead > 0 || k.air > GROUND_CLEAR || k.id === m.owner || this.isFriendly(k.id, m.owner)) continue;
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
        if (k.ghost > 0 || k.dead > 0 || k.air > GROUND_CLEAR || (b.safe > 0 && k.id === b.owner) || this.isFriendly(k.id, b.owner)) continue;
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

  // A star kart rams a rival: race, they spin out; arena, they take damage and get knocked away.
  starRam(star, victim, nx, ny) {
    if (this.isFriendly(star.id, victim.id)) return;
    if (!this.damage(victim, DAMAGE.star, star, 'star')) return;
    victim.x += nx * 14;
    victim.y += ny * 14;
    victim.speed *= 0.4;
    if (this.arena && victim.dead <= 0) victim.invuln = Math.max(victim.invuln, 0.8); // one hit per ram
  }

  // Is (x, y) past the walls (or inside an obstacle)? `shot.ti` keeps race lookups local and cheap.
  blocked(x, y, shot) {
    if (this.arena) return this.map.blocked(x, y);
    const near = this.map.nearestIndex(x, y, shot ? shot.ti : undefined);
    if (shot) shot.ti = near.index;
    return near.dist > this.map.width / 2 + 120;
  }

  updateShots(dt, alive) {
    for (const s of this.shots) {
      const owner = this.karts.get(s.owner);
      if (s.kind === 'comet') { this.updateComet(s, dt); continue; }
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
      if (s.kind === 'bouncer') {
        this.bounce(s);
        if (s.life <= 0) { // out of bounces (or time): it shatters
          this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 30, kind: 'bouncer' });
          continue;
        }
      }
      const shell = s.kind !== 'bullet';
      for (const k of alive) {
        // Bouncers can come back for their owner once they have hit a wall.
        const own = k.id === s.owner;
        if ((own && !(s.kind === 'bouncer' && s.bounced)) || k.ghost > 0 || k.dead > 0 || (!own && this.isFriendly(k.id, s.owner))) continue;
        const r = K.KART_RADIUS + (s.kind === 'bullet' ? 4 : 8);
        // Swept test over this tick's whole path: bullets cover ~60 units a
        // tick, more than a kart is wide, so a point test lets them pass through.
        if (segmentDist2(px, py, s.x, s.y, k.x, k.y) < r * r) {
          s.life = 0;
          if (shell && this.trailBlock(k, s)) break;
          this.damage(k, s.dmg, owner, s.kind === 'bullet' ? 'bullet' : s.kind);
          if (shell) this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 40, kind: s.kind });
          break;
        }
      }
      if (s.life > 0 && s.kind !== 'bouncer' && this.blocked(s.x, s.y, s)) {
        s.life = 0;
        if (s.kind === 'rocket') this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 40, kind: 'rocket' });
      }
    }
    this.shots = this.shots.filter((s) => s.life > 0);
  }

  // A banana or mine held behind your kart soaks up a shell coming from behind (and is used up).
  trailBlock(k, s) {
    if ((k.item !== 'banana' && k.item !== 'mine') || k.roulette > 0) return false;
    if ((s.x - k.x) * Math.cos(k.angle) + (s.y - k.y) * Math.sin(k.angle) > -4) return false;
    k.ammo--;
    if (k.ammo <= 0) { k.item = null; k.ammo = 0; }
    this.room.emit('game:kart:block', { idx: k.idx, kind: 'trail' });
    this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 30, kind: s.kind });
    return true;
  }

  // Bouncer shells reflect off walls and obstacles until they run out of bounces.
  bounce(s) {
    const R = BOUNCER.radius;
    let nx = 0;
    let ny = 0;
    if (this.arena) {
      const lo = 40 + R;
      const hi = this.map.size - 40 - R;
      if (s.x < lo) { s.x = lo; nx += 1; }
      if (s.x > hi) { s.x = hi; nx -= 1; }
      if (s.y < lo) { s.y = lo; ny += 1; }
      if (s.y > hi) { s.y = hi; ny -= 1; }
      for (const o of this.map.obstacles) {
        const dx = s.x - o.x;
        const dy = s.y - o.y;
        const d = Math.hypot(dx, dy);
        if (d < o.r + R && d > 0.001) {
          s.x = o.x + (dx / d) * (o.r + R);
          s.y = o.y + (dy / d) * (o.r + R);
          nx += dx / d;
          ny += dy / d;
        }
      }
    } else {
      const near = this.map.nearestIndex(s.x, s.y, s.ti);
      s.ti = near.index;
      const wall = this.map.width / 2 + K.WALL_PAD;
      if (near.dist > wall) {
        nx = (near.px - s.x) / near.dist;
        ny = (near.py - s.y) / near.dist;
        const k = wall / near.dist;
        s.x = near.px + (s.x - near.px) * k;
        s.y = near.py + (s.y - near.py) * k;
      }
    }
    const len = Math.hypot(nx, ny);
    if (!len) return;
    nx /= len;
    ny /= len;
    const dx = Math.cos(s.angle);
    const dy = Math.sin(s.angle);
    const dot = dx * nx + dy * ny;
    if (dot >= 0) return; // already moving away
    s.angle = Math.atan2(dy - 2 * dot * ny, dx - 2 * dot * nx);
    s.bounced = true;
    s.bounces--;
    if (s.bounces < 0) s.life = 0;
  }

  // Advance a centerline position (sample index + fraction) by `dist` world units.
  alongTrack(ci, dist) {
    const c = this.map.centerline;
    const n = this.map.n;
    let i = Math.floor(ci) % n;
    let f = ci - Math.floor(ci);
    for (let guard = 0; dist > 0 && guard < n; guard++) {
      const a = c[i];
      const b = c[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const left = (1 - f) * len;
      if (dist < left) { f += dist / len; break; }
      dist -= left;
      i = (i + 1) % n;
      f = 0;
    }
    return i + f;
  }

  updateComet(s, dt) {
    s.age += dt;
    s.life -= dt;
    const owner = this.karts.get(s.owner);
    let target = s.target ? this.karts.get(s.target) : null;
    if (!target || target.dead > 0 || target.finished) {
      // The target finished or was destroyed: go after whoever leads now.
      target = owner ? this.cometTarget(owner) : null;
      s.target = target ? target.id : null;
      if (s.phase === 'dive' && target) { s.sx = s.x; s.sy = s.y; s.sAlt = s.alt; s.diveT = 0; }
    }
    if (!target || s.life <= 0) {
      s.life = 0;
      this.room.emit('game:kart:boom', { x: Math.round(s.x), y: Math.round(s.y), r: 60, kind: 'comet' });
      return;
    }
    if (s.phase === 'cruise') {
      const climb = Math.min(1, s.age / COMET.climb);
      s.alt = 20 + (COMET.altitude - 20) * (1 - (1 - climb) ** 2);
      const step = s.speed * (0.35 + 0.65 * climb) * dt;
      const px = s.x;
      const py = s.y;
      if (this.arena) {
        let da = Math.atan2(target.y - s.y, target.x - s.x) - s.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        s.angle += Math.max(-5 * dt, Math.min(5 * dt, da));
        s.x += Math.cos(s.angle) * step;
        s.y += Math.sin(s.angle) * step;
      } else {
        s.ci = this.alongTrack(s.ci, step);
        const decay = Math.exp(-dt * 2.5);
        s.ox *= decay;
        s.oy *= decay;
        const i = Math.floor(s.ci);
        const a = this.map.centerline[i];
        const b = this.map.centerline[(i + 1) % this.map.n];
        const f = s.ci - i;
        s.x = a[0] + (b[0] - a[0]) * f + s.ox;
        s.y = a[1] + (b[1] - a[1]) * f + s.oy;
        if (s.x !== px || s.y !== py) s.angle = Math.atan2(s.y - py, s.x - px);
      }
      if (s.age > COMET.climb && Math.hypot(target.x - s.x, target.y - s.y) < COMET.divePoint) {
        Object.assign(s, { phase: 'dive', diveT: 0, sx: s.x, sy: s.y, sAlt: s.alt });
      }
      return;
    }
    // Dive: home onto the target, dropping faster and faster.
    s.diveT += dt;
    const p = Math.min(1, s.diveT / COMET.dive);
    const px = s.x;
    const py = s.y;
    s.x = s.sx + (target.x - s.sx) * p;
    s.y = s.sy + (target.y - s.sy) * p;
    if (s.x !== px || s.y !== py) s.angle = Math.atan2(s.y - py, s.x - px);
    s.alt = s.sAlt * (1 - p * p);
    if (p >= 1) {
      s.life = 0;
      this.explode(target.x, target.y, COMET.radius, DAMAGE.comet, owner, 'comet');
    }
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
      // [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags, kills, deaths, hp, air, fx, roulette]
      // air: height above the ground; fx: 1 falling, 2 trick, 4 fell in lava, 8 fell in water
      // roulette: hundredths of a second until the item roulette stops (0 = item ready / none)
      k: [...this.karts.values()].map((k) => [
        k.idx, Math.round(k.x), Math.round(k.y), Math.round(k.angle * 1000), Math.round(k.speed),
        Math.max(1, Math.min(this.laps, k.lap)), place.get(k.id), itemCode(k.item), k.ammo,
        (k.spin > 0 ? 1 : 0) | (k.boost > 0 ? 2 : 0) | (k.shield > 0 ? 4 : 0) | (k.finished ? 8 : 0)
          | (k.invuln > 0 ? 16 : 0) | (k.dead > 0 ? 32 : 0)
          | (k.drift ? 64 : 0) | (k.drift && K.driftLevel(k.driftTime) >= 1 ? 128 : 0)
          | (k.drift && K.driftLevel(k.driftTime) >= 2 ? 256 : 0) | (k.drift < 0 ? 512 : 0)
          | (k.ghost > 0 ? 1024 : 0) | (k.gun > 0 ? 2048 : 0)
          | (k.star > 0 ? 4096 : 0) | (k.shrink > 0 ? 8192 : 0) | (k.ink > 0 ? 16384 : 0),
        // hp is sent as a percentage of this round's max health.
        k.kills, k.deaths, Math.max(0, Math.min(100, Math.round((k.hp / this.hpMax) * 100))),
        Math.round(k.air || 0),
        (k.fall > 0 ? 1 : 0) | (k.trick > 0 ? 2 : 0) | (k.fall > 0 && k.fallKind === 'lava' ? 4 : 0) | (k.fall > 0 && k.fallKind === 'water' ? 8 : 0),
        Math.ceil(k.roulette * 100 - 1e-6),
      ]),
      // shots: [id, kind (1 rocket, 2 bullet, 3 bomb, 4 bouncer, 5 comet), x, y, angle*1000, flight progress 0-100]
      //   bombs add [landing x, landing y]; comets send their altitude as the 6th field and add [target kart idx]
      s: this.shots.map((s) => {
        const row = [s.id, SHOT_CODE[s.kind], Math.round(s.x), Math.round(s.y), Math.round(s.angle * 1000),
          s.kind === 'bomb' ? Math.round((s.age / BOMB.flight) * 100) : s.kind === 'comet' ? Math.round(s.alt) : 0];
        if (s.kind === 'bomb') row.push(Math.round(s.lx), Math.round(s.ly));
        else if (s.kind === 'comet') row.push(s.target ? this.karts.get(s.target).idx : -1);
        return row;
      }),
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
