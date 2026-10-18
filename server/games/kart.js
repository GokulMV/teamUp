const K = require('../../public/js/shared/kart-core');
const Bots = require('./kart-bots');
const crypto = require('crypto');
const { fixedLoop } = require('./loop');

const TICK_HZ = 30;
const SEND_EVERY = 2; // broadcast at 15 Hz
const COUNTDOWN_S = 4;
const FINISH_GRACE_S = 25; // at least; on long tracks three quarters of a lap (see finishGrace)
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
// Bombs are lobbed (see K.ITEM_FX.bomb: hold fire to aim near..far, a tap throws mid-range).
const BOMB = { ...K.ITEM_FX.bomb, radius: 140 };
const MINE = { arm: 0.8, life: 60, trigger: 40, radius: 95 };
// Bouncer shell: fired straight (backwards when braking), caroms off walls and obstacles.
const BOUNCER = { speed: 880, life: 6, bounces: 5, radius: 8 };
// Comet: climbs, flies over the track to the leader (arena: the top scorer) and dives onto them.
const COMET = { speed: 1900, altitude: 110, climb: 0.45, dive: 0.5, divePoint: 380, radius: 190, life: 15 };
const INK_RADIUS = 900; // arena: how far ink reaches
// Snowball: a straight shot that freezes whoever it hits (see K.ITEM_FX.freezeTime). Any hit on a
// frozen kart shatters the ice: race, a longer spin-out; arena, half as much damage again.
const SNOW = { speed: 920, life: 1.3, shatterSpin: 1.4, shatterMul: 1.5 };
// Sticky bomb: thrown a short way; it sticks to the first kart it touches (or lands and waits for
// one) and goes off on whoever carries it when the fuse runs out. Bump someone to pass it on.
const STICKY = { speed: 620, flight: 0.55, ground: 10, radius: 95, passGap: 0.5, ownerGrace: 0.8 };
// Spin spikes: a spiked ring round your kart for a few seconds; touching it spins rivals out.
const SPIKES = { reach: 12, gap: 0.8, hits: 3 }; // the spikes snap off after `hits` karts
const DECOY = { life: 25, trigger: 34 };
const STAR_RAM_GAP = 0.8; // seconds before the same star kart can ram the same victim again
// Kart-kart bumps trade momentum. Boosting karts are heavier, shrunk ones lighter. A hit closing
// faster than ramSpeed is a ram: the victim gets shoved harder (and in the arena takes a little damage).
const BUMP = { restitution: 0.35, boostMass: 1.5, shrunkMass: 0.55, ramSpeed: 260, ramShove: 1.35, ramGap: 0.5, eventSpeed: 90 };
const SHOCK_RADIUS = 360;
// Arena knockback (units/s, dying away like a bump's shove): a shell's direct hit, and a blast at
// point blank (scaled by its size).
const KNOCK = { shell: 300, blast: 360 };
// Everyone drives a kart with one of the animal drivers (kart-core CHARACTERS, modelled by
// kart3d/gokart.js): the one they picked, or else the one that goes with their lobby avatar.
function characterFor(player) {
  if (K.CHARACTERS.some((c) => c.id === player.character)) return player.character;
  const n = K.CHARACTERS.length;
  return K.CHARACTERS[(((Number(player.avatar) || 0) % n) + n) % n].id;
}
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
  rocket: 70, triple: 45, bullet: 6, banana: 35, mine: 100, bomb: 100, shock: 45, lava: 1000, // lava (water, acid, the void) is instant death
  bouncer: 50, comet: 90, star: 40, thunder: 35, ram: 6, // ram: 6 at ramSpeed, up to 16 for a full-speed T-bone
  snowball: 10, sticky: 75, spikes: 25, decoy: 40,
};

// Lava, water and falling into the void: nothing protects you, and the kill goes to whoever hit you last.
const ENV_KILLS = new Set(['lava', 'water', 'void', 'acid', 'cup']); // (cup: a golf hole you drive into)
// Layered arenas: how close in height things must be to touch (shots, traps and boxes are on one floor).
const LEVEL = { shot: 26, trap: 20, box: 30, shock: 90 };
const BOMB_LOB = { apex: 110, reach: 60 }; // a bomb lands on a floor up to `reach` above the thrower

const SHOT_CODE = { rocket: 1, bullet: 2, bomb: 3, bouncer: 4, comet: 5, snowball: 6, sticky: 7 };
const SHOT_SPEED = { rocket: ROCKET.speed, bullet: BULLET.speed, snowball: SNOW.speed, sticky: STICKY.speed };
const SHOT_LIFE = { rocket: ROCKET.life, bullet: BULLET.life, snowball: SNOW.life, sticky: STICKY.flight };
const NO_INPUT = { up: false, down: false, left: false, right: false, drift: false };
// Input timing: how many ticks a late input is remembered for when choosing how long inputs wait,
// and how many inputs can wait at once.
const NET = { window: 90, queue: 32 };
const newNet = () => ({ q: [], off: null, c: -Infinity, n: null, L: null, hist: [], eased: 0 });
const TIMERS = ['shield', 'invuln', 'ghost', 'star', 'shrink', 'ink', 'roulette', 'roulette2', 'freeze', 'spikes']; // per-kart countdowns (seconds)

// Item odds. Arena favours weapons; in a race, karts at the back get stronger items.
const ARENA_ODDS = {
  rocket: 18, triple: 9, minigun: 12, bomb: 9, mine: 9, shock: 7, banana: 6, shield: 7, ghost: 5, boost: 7,
  bouncer: 12, comet: 3, star: 5, ink: 4, thunder: 2, snowball: 9, sticky: 7, spikes: 6, decoy: 4,
};
const RACE_ODDS_FRONT = {
  banana: 24, mine: 14, shield: 14, rocket: 10, minigun: 8, boost: 8, bomb: 5, ghost: 0, triple: 0, shock: 0,
  bouncer: 16, comet: 0, star: 0, ink: 4, thunder: 0, snowball: 7, sticky: 5, spikes: 2, decoy: 12,
};
const RACE_ODDS_BACK = {
  boost: 22, rocket: 12, triple: 13, shock: 10, ghost: 8, minigun: 6, bomb: 6, shield: 3, banana: 1, mine: 0,
  bouncer: 4, comet: 6, star: 13, ink: 5, thunder: 4, snowball: 8, sticky: 6, spikes: 7, decoy: 0,
};

// Room options (see DEFAULT_SETTINGS in server/rooms.js).
const CLASS_SPEED = { chill: 0.82, standard: 1, turbo: 1.18 };
const BOX_RESPAWN = { rare: 6, normal: 3, frequent: 1.5 };
const RESPAWN_TIME = { fast: 1.5, normal: 2.5, slow: 4 }; // arena: seconds dead before respawning
const ARENA_HEALTH = { low: 60, normal: 100, high: 150 };
const KILL_LIMITS = [0, 5, 10, 15, 25];
const WEAPON_ITEMS = ['rocket', 'triple', 'minigun', 'bomb', 'mine', 'shock', 'bouncer', 'comet', 'thunder', 'snowball', 'sticky', 'spikes', 'decoy'];

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

  // opts.map: play on this map instead of the one the settings name (the weekly arena's play test).
  constructor(room, opts = {}) {
    this.room = room;
    const s = room.settings;
    const type = s.kartMode === 'arena' ? 'arena' : 'race';
    this.map = opts.map || K.getMap(s.kartMap, type, { reverse: type === 'race' && s.kartReverse === true });
    this.arena = this.map.type === 'arena';
    this.layered = !!this.map.layered; // floors at several heights: everything carries a z
    this.reverse = !!this.map.reverse;
    this.laps = s.kartLaps;
    this.duration = s.arenaTime;
    this.speedMul = CLASS_SPEED[s.kartClass] || 1;
    // After the first human finishes, the rest get about three quarters of a lap to cross the line.
    this.finishGrace = this.arena ? FINISH_GRACE_S : Math.max(FINISH_GRACE_S, (0.75 * this.map.length) / (K.PHYS.maxSpeed * 0.85 * this.speedMul));
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
    this.round = crypto.randomBytes(4).toString('hex'); // tells clients a new game from the same one again (not Math.random: the weekly play test seeds it)
    this.time = 0;
    this.karts = new Map();
    this.order = []; // kart index -> player id
    this.shots = []; // rockets, bullets, bombs
    this.mines = [];
    this.bananas = [];
    this.stickies = []; // sticky bombs lying on the ground, waiting for a kart
    this.decoys = []; // fake item boxes
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
    this.interval = fixedLoop(TICK_HZ, (dt) => this.tick(dt));
  }

  addKart(player, slot) {
    let g;
    if (this.arena) {
      const s = this.map.spawns[slot % this.map.spawns.length];
      g = { x: s.x, y: s.y, angle: s.angle, index: null, z: this.layered ? s.z : null };
    } else {
      g = this.map.gridPosition(slot);
    }
    const bot = !!player.bot;
    this.karts.set(player.id, {
      idx: this.order.length,
      id: player.id,
      name: player.name, color: player.color, avatar: player.avatar || 0, team: player.team || 0,
      bot, skill: bot ? player.skill : null,
      character: characterFor(player),
      speedMul: this.speedMul * (bot ? Bots.SKILLS[player.skill].speed : 1),
      x: g.x, y: g.y, angle: g.angle, speed: 0,
      z: g.z ?? null, // height (race tracks and layered arenas; set by the physics on races)
      trackIndex: g.index,
      lap: 0,
      boost: 0, spin: 0, shield: 0, invuln: 0, ghost: 0,
      star: 0, shrink: 0, ink: 0, // seconds left of star power, thunder shrink, ink on the screen
      freeze: 0, spikes: 0, sticky: null, // frozen by a snowball, spin spikes out, a sticky bomb on board
      gun: 0, gunCd: 0,
      hp: this.hpMax, lastHit: -99, lastAttacker: null,
      dead: 0,
      item: null, ammo: 0, roulette: 0, // the item can't be used until the roulette stops
      item2: null, ammo2: 0, roulette2: 0, // a second item held in reserve (two at most)
      input: { ...NO_INPUT },
      net: bot ? null : newNet(), // when this player's inputs are used (see onInput)
      finished: false, finishTime: null,
      hits: 0, kills: 0, deaths: 0, streak: 0,
      progress: this.arena ? 0 : g.index - this.map.n,
    });
    this.order.push(player.id);
  }

  initPayload() {
    return {
      round: this.round,
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
        meta.character = k.character;
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
    if (!kart) return;
    kart.input = { ...NO_INPUT };
    if (kart.net) kart.net.q = [];
  }

  onPlayerDisconnect(player) {
    this.onPlayerLeave(player);
  }

  onEvent(player, event, data, reply) {
    if (event === 'ping') { reply({ ok: true }); return; }
    const kart = this.karts.get(player.id);
    if (!kart) return;
    if (event === 'input') {
      this.onInput(kart, data);
    } else if (event === 'use') {
      // A bomb thrown after aiming says how far (0 near .. 1 far); everything else ignores it.
      if (this.phase === 'racing') this.useItem(kart, { power: data && typeof data === 'object' ? data.power : undefined });
    } else if (event === 'swap') {
      if (this.phase === 'racing') this.swapItems(kart);
    }
  }

  // ---------- input timing ----------
  // Every input says which of the player's own 30 Hz steps it starts at (c) and which step their
  // screen was on when it was sent (n). The server uses it from tick c + off, where off is the
  // smallest gap that got this player's recent inputs here in time: so the server drives their
  // kart with the same inputs at the same moments as their own screen did, however much the
  // network delay wobbles, and the two never drift apart. An input that still turns up late is
  // used at once, and the gap grows to fit; it shrinks again once the connection settles.
  onInput(kart, data) {
    const input = { up: !!data?.up, down: !!data?.down, left: !!data?.left, right: !!data?.right, drift: !!data?.drift };
    const net = kart.net;
    const n = data?.n;
    if (!net || !Number.isSafeInteger(n) || !Number.isSafeInteger(data.c)) { kart.input = input; return; }
    const c = Math.min(data.c, n + 1); // an input can't start before it was sent
    const now = this.tickCount;
    // A page that started counting again (reloaded): start over.
    if (net.n !== null && n < net.n - 30) Object.assign(net, newNet());
    net.n = Math.max(net.n ?? n, n);
    const need = now - n; // the gap at which this input is just in time
    net.hist.push([now, need]);
    while (net.hist.length > 64 || (net.hist.length && now - net.hist[0][0] > NET.window)) net.hist.shift();
    if (net.off === null || need > net.off) {
      net.off = need + 1; // and a tick to spare
      net.eased = now;
    } else if (now - net.eased > 30 && !kart.input.left && !kart.input.right && !kart.input.drift) {
      // Over two ticks more than the last three seconds needed: come down to one to spare (once a
      // second at most, and only while driving straight, where it only nudges the kart along).
      let most = -Infinity;
      for (const h of net.hist) most = Math.max(most, h[1]);
      if (net.off > most + 2) { net.off = most + 1; net.eased = now; }
    }
    if (c < net.c) return; // an older input sent again
    if (c === net.c) { kart.input = input; return; }
    const q = net.q;
    let i = q.length;
    while (i > 0 && q[i - 1].c >= c) i--;
    if (q[i] && q[i].c === c) q[i].input = input;
    else q.splice(i, 0, { c, input });
    while (q.length > NET.queue) { const it = q.shift(); kart.input = it.input; net.c = it.c; }
  }

  // Start of a tick: the inputs due by now, and which of each player's steps this tick is.
  pumpInputs() {
    for (const k of this.karts.values()) {
      const net = k.net;
      if (!net || net.off === null) continue;
      const due = this.tickCount - net.off;
      while (net.q.length && net.q[0].c <= due) {
        const it = net.q.shift();
        k.input = it.input;
        net.c = it.c;
      }
      net.L = due;
    }
  }

  // ---------- item slots ----------
  // Every kart holds at most two items: the one it fires next and one in reserve. A full kart
  // drives straight through item boxes, leaving them for someone else.
  static ammoFor(item) { return item === 'triple' ? 3 : 1; }

  giveItem(kart, item) {
    if (!item) return;
    if (!kart.item) Object.assign(kart, { item, ammo: KartBattle.ammoFor(item), roulette: ROULETTE_TIME });
    else if (!kart.item2) Object.assign(kart, { item2: item, ammo2: KartBattle.ammoFor(item), roulette2: ROULETTE_TIME });
  }

  // The front slot just emptied: the reserve item moves up (its roulette keeps spinning if it was).
  promoteItem(kart) {
    if (kart.item || !kart.item2) return;
    Object.assign(kart, { item: kart.item2, ammo: kart.ammo2, roulette: kart.roulette2, item2: null, ammo2: 0, roulette2: 0 });
  }

  clearItems(kart) {
    Object.assign(kart, { item: null, ammo: 0, roulette: 0, item2: null, ammo2: 0, roulette2: 0 });
  }

  swapItems(kart) {
    if (!kart.item2 || kart.dead > 0 || kart.fall > 0 || kart.finished) return false;
    Object.assign(kart, {
      item: kart.item2, ammo: kart.ammo2, roulette: kart.roulette2,
      item2: kart.item, ammo2: kart.ammo, roulette2: kart.roulette,
    });
    this.room.emit('game:kart:swap', { idx: kart.idx });
    return true;
  }

  // ---------- items ----------
  fire(kind, kart, angleOffset = 0, power = BOMB.tap) {
    const a = kart.angle + angleOffset;
    const speed = kind === 'bomb' ? Math.max(0, kart.speed) + K.bombLead(power) / BOMB.flight
      : SHOT_SPEED[kind] + Math.max(0, kart.speed);
    const shot = {
      id: this.nextId++, kind, owner: kart.id,
      x: kart.x + Math.cos(a) * 26, y: kart.y + Math.sin(a) * 26, angle: a, speed,
      life: kind === 'bomb' ? BOMB.flight : SHOT_LIFE[kind],
      age: 0,
      ti: kart.trackIndex, // nearest centerline sample, a hint for cheap wall checks
      dmg: kind === 'rocket' && kart.item === 'triple' ? DAMAGE.triple : DAMAGE[kind],
    };
    if (this.layered) { shot.z = this.heightOf(kart); shot.vz = 0; }
    if (kind === 'bomb') {
      // Where it will land, so everyone can see the danger zone.
      shot.lx = shot.x + Math.cos(a) * speed * BOMB.flight;
      shot.ly = shot.y + Math.sin(a) * speed * BOMB.flight;
      if (this.layered) {
        // On whatever floor is there (a deck up to BOMB_LOB.reach above the thrower, or anything below).
        const f = this.map.floorAt(shot.lx, shot.ly, shot.z + BOMB_LOB.reach, this.time);
        shot.z0 = shot.z;
        shot.lz = Number.isFinite(f) ? f : this.map.deathZ;
      }
    }
    this.shots.push(shot);
    return shot;
  }

  // Height of a kart: race tracks and layered arenas know it; on a flat arena it is just the air under it.
  heightOf(k) {
    return Number.isFinite(k.z) ? k.z : k.air || 0;
  }

  // Layered arenas: are a kart and something lying or flying at height z on the same level?
  level(k, z, tol) {
    return !this.layered || z === undefined || Math.abs(this.heightOf(k) - z) < tol;
  }

  // Layered arenas: the height on the end of an event or snapshot row (nothing elsewhere).
  withZ(obj, z) {
    if (this.layered) obj.z = Math.round(z);
    return obj;
  }

  // Straight ahead, or backwards when braking. The owner can be hit once it has bounced.
  fireBouncer(kart, back) {
    const a = kart.angle + (back ? Math.PI : 0);
    const fwd = Math.max(0, kart.speed);
    const shot = {
      id: this.nextId++, kind: 'bouncer', owner: kart.id,
      x: kart.x + Math.cos(a) * 30, y: kart.y + Math.sin(a) * 30, angle: a,
      speed: back ? BOUNCER.speed * 0.85 : BOUNCER.speed + fwd * 0.8,
      life: BOUNCER.life, age: 0, ti: kart.trackIndex, bounces: BOUNCER.bounces, bounced: false, dmg: DAMAGE.bouncer,
    };
    if (this.layered) { shot.z = this.heightOf(kart); shot.vz = 0; }
    this.shots.push(shot);
  }

  launchComet(kart) {
    const target = this.cometTarget(kart);
    const comet = {
      id: this.nextId++, kind: 'comet', owner: kart.id, target: target ? target.id : null,
      x: kart.x, y: kart.y, angle: kart.angle, speed: COMET.speed, alt: 20,
      life: COMET.life, age: 0, phase: 'cruise', dmg: DAMAGE.comet,
    };
    if (this.layered) comet.z = this.heightOf(kart); // the height its altitude is counted from
    if (!this.arena) {
      // Ride the centerline from here; the sideways offset to it fades out as the comet climbs.
      const near = this.map.nearestIndex(kart.x, kart.y, kart.trackIndex);
      comet.ci = near.index;
      comet.ox = kart.x - this.map.centerline[near.index][0];
      comet.oy = kart.y - this.map.centerline[near.index][1];
    }
    this.shots.push(comet);
  }

  // Race: the best placed rival still racing. Arena: the top scorer among rivals; a tie (everyone
  // on 0 kills at the start, say) is broken at random rather than by join order.
  cometTarget(owner) {
    const rivals = this.rankings().filter((k) => k !== owner && k.dead <= 0 && !k.finished && !this.isFriendly(k.id, owner.id));
    if (!this.arena || rivals.length < 2) return rivals[0] || null;
    const top = rivals.filter((k) => k.kills === rivals[0].kills && k.deaths === rivals[0].deaths);
    return top[Math.floor(Math.random() * top.length)];
  }

  // Race: is any rival still racing ahead of this kart? (Ink and comets only ever go forwards.)
  rivalAhead(kart) {
    for (const k of this.karts.values()) {
      if (k !== kart && !k.finished && k.dead <= 0 && k.progress > kart.progress && !this.isFriendly(k.id, kart.id)) return true;
    }
    return false;
  }

  useItem(kart, opts = {}) {
    if (this.phase !== 'racing' || !kart.item || kart.roulette > 0 || kart.spin > 0 || kart.dead > 0 || kart.fall > 0 || kart.finished || kart.freeze > 0) return false;
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
      case 'bomb': {
        const p = opts.power;
        this.fire('bomb', kart, 0, typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : BOMB.tap);
        break;
      }
      case 'banana': {
        const [x, y] = [kart.x - cos * 34, kart.y - sin * 34];
        const z = this.dropZ(x, y, kart);
        if (z !== null) this.bananas.push({ id: this.nextId++, x, y, z, life: BANANA_LIFE, owner: kart.id, safe: 0.6 });
        break;
      }
      case 'mine': {
        const [x, y] = [kart.x - cos * 36, kart.y - sin * 36];
        const z = this.dropZ(x, y, kart);
        if (z !== null) this.mines.push({ id: this.nextId++, x, y, z, owner: kart.id, arm: MINE.arm, life: MINE.life });
        break;
      }
      case 'shock': this.shock(kart); break;
      case 'snowball': this.fire('snowball', kart); break;
      case 'sticky': this.fire('sticky', kart); break;
      case 'spikes': kart.spikes = K.ITEM_FX.spikesTime; kart.spikeHits = 0; break;
      case 'decoy': {
        const [x, y] = [kart.x - cos * 38, kart.y - sin * 38];
        const z = this.dropZ(x, y, kart);
        if (z !== null) this.decoys.push({ id: this.nextId++, x, y, z, owner: kart.id, life: DECOY.life });
        break;
      }
      case 'bouncer': this.fireBouncer(kart, opts.back !== undefined ? !!opts.back : !!kart.input.down); break;
      case 'comet': this.launchComet(kart); break;
      case 'star': kart.star = STAR_TIME; kart.boost = Math.max(kart.boost, 0.3); break;
      case 'ink': this.ink(kart); break;
      case 'thunder': this.thunder(kart); break;
      default:
    }
    this.room.emit('game:kart:use', { idx: kart.idx, item });
    kart.ammo--;
    if (kart.ammo <= 0) { kart.item = null; kart.ammo = 0; this.promoteItem(kart); }
    return true;
  }

  // Can a dropped item lie here? Over a gap, water or lava it just falls in. The height it lies at
  // (layered arenas: the floor there, which may be below a ledge; 0 elsewhere), or null.
  dropZ(x, y, kart, from = this.heightOf(kart)) {
    if (this.layered) {
      const z = this.map.floorAt(x, y, from + K.Layers.STEP, this.time);
      return Number.isFinite(z) && !this.map.hazardAt(x, y, z) ? z : null;
    }
    if (this.arena) return 0;
    const q = this.map.nearestIndex(x, y, kart.trackIndex);
    return !this.map.gap[q.index] && !this.map.hazardAt(x, y, q) ? 0 : null;
  }

  solidGround(x, y, kart) {
    return this.dropZ(x, y, kart) !== null;
  }

  shock(kart) {
    for (const k of this.karts.values()) {
      if (k === kart || k.dead > 0 || this.isFriendly(k.id, kart.id) || !this.level(k, this.heightOf(kart), LEVEL.shock)) continue;
      if ((k.x - kart.x) ** 2 + (k.y - kart.y) ** 2 < SHOCK_RADIUS ** 2) this.damage(k, DAMAGE.shock, kart, 'shock');
    }
    this.room.emit('game:kart:shock', this.withZ({ idx: kart.idx, x: Math.round(kart.x), y: Math.round(kart.y), r: SHOCK_RADIUS }, this.heightOf(kart)));
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
    const skip = Object.keys(RARE_COOLDOWN).filter((item) => this.time - this.lastRare[item] < RARE_COOLDOWN[item]);
    // The race leader never rolls ink (nobody ahead to splat) or a comet (it would have to fly a
    // whole lap round to reach 2nd place), whatever the catch-up setting.
    if (!this.arena && !this.rivalAhead(kart)) skip.push('ink', 'comet');
    for (const item of skip) if (odds[item]) odds[item] = 0;
    if (!Object.values(odds).some((w) => w > 0)) {
      // Nothing left in the odds table: any allowed item, still avoiding the ones skipped above if possible.
      const pool = this.items.filter((item) => !skip.includes(item));
      for (const item of pool.length ? pool : this.items) odds[item] = 1;
    }
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
  // Returns true when the hit landed (not dodged, blocked or friendly). knock: [x, y] velocity a
  // blast or a shell gives the kart it hits in the arena (it's sent with the hit, so the victim's
  // own prediction is thrown too).
  damage(target, amount, attacker, kind, knock = null) {
    // Nothing more can happen once the round is over (e.g. a kill limit hit mid-blast).
    if (this.phase !== 'racing') return false;
    const env = ENV_KILLS.has(kind);
    if (target.dead > 0 || target.finished || target.fall > 0 || (target.ghost > 0 && !env)) return false;
    if (attacker && attacker !== target && this.isFriendly(attacker.id, target.id)) return false;
    if (!env) {
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
    const event = this.withZ({ target: target.idx, by: by ? by.idx : -1, x: Math.round(target.x), y: Math.round(target.y), kind, kill: false, streak: 0 }, this.heightOf(target));
    // Shatter: a proper hit on a frozen kart breaks the ice, and hurts more for it.
    const shatter = target.freeze > 0 && !env && !['snowball', 'bullet'].includes(kind);
    if (shatter) { target.freeze = 0; event.shatter = true; }
    if (kind === 'snowball') Object.assign(target, { freeze: K.ITEM_FX.freezeTime, drift: 0, driftTime: 0, boost: 0, gun: 0 });

    if (!this.arena) {
      if (kind === 'bullet') {
        target.speed *= 0.82;
        this.room.emit('game:kart:hit', event);
        return true;
      }
      if (kind === 'snowball') {
        if (by) by.hits++;
        this.room.emit('game:kart:hit', event);
        return true;
      }
      target.spin = SPIN_TIME + (shatter ? SNOW.shatterSpin : 0);
      target.invuln = target.spin + 1;
      target.boost = 0;
      if (kind === 'thunder') {
        // Shrunk for a while (slower top speed) and both items are gone, roulettes and all.
        Object.assign(target, { shrink: SHRINK_TIME, gun: 0 });
        this.clearItems(target);
      } else if (by) {
        by.hits++; // thunder counts once for the striker, in thunder()
      }
      this.room.emit('game:kart:hit', event);
      return true;
    }

    // The damage dealt rides on the hit event (floating damage numbers); a finishing blow counts
    // only what it took.
    const dealt = shatter ? Math.round(amount * SNOW.shatterMul) : amount;
    event.dmg = Math.max(0, Math.min(dealt, Math.ceil(target.hp)));
    target.hp -= dealt;
    if (!env || !target.lastAttacker) target.lastHit = this.time;
    if (by) { target.lastAttacker = by.id; target.lastHit = this.time; }
    if (kind === 'banana') { target.spin = 0.8; target.invuln = 0.3; }
    if (target.hp > 0) {
      if (knock) {
        target.kx = (target.kx || 0) + knock[0];
        target.ky = (target.ky || 0) + knock[1];
        event.kx = Math.round(knock[0]);
        event.ky = Math.round(knock[1]);
      }
      if (!env) this.room.emit('game:kart:hit', event);
      return true;
    }
    // Destroyed. Lava (and void) kills go to whoever hit you last (within 5 s), so knocking rivals in counts.
    let killer = by;
    if (!killer && target.lastAttacker && this.time - target.lastHit < 5) killer = this.karts.get(target.lastAttacker) || null;
    if (killer === target) killer = null;
    target.dead = this.respawnTime;
    target.deaths++;
    target.streak = 0;
    Object.assign(target, { speed: 0, boost: 0, gun: 0, drift: 0, hp: 0, star: 0, shrink: 0, ink: 0, freeze: 0, spikes: 0, sticky: null, kx: 0, ky: 0, launch: 0, lost: null });
    this.clearItems(target);
    if (killer && !this.isFriendly(killer.id, target.id)) {
      killer.kills++;
      killer.streak++;
      event.streak = killer.streak;
    }
    event.by = killer ? killer.idx : -1;
    event.kill = true;
    this.room.emit('game:kart:hit', event);
    this.room.record?.('kart_kill', killer ? killer.id : null, {
      victim: target.id, kind, map: this.map.id, streak: event.streak, x: event.x, y: event.y, at: Math.round((this.time - this.raceStart) * 10) / 10,
    });
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

  // z: the height the blast goes off at (layered arenas; elsewhere blasts are on the ground).
  explode(x, y, radius, maxDmg, attacker, kind, z = 0) {
    for (const k of this.karts.values()) {
      const dz = this.layered ? this.heightOf(k) - z : k.air || 0; // high flyers escape
      const d = Math.hypot(k.x - x, k.y - y, dz);
      if (d > radius) continue;
      if (attacker && k.id === attacker.id) continue; // your own blasts never hurt you
      // Thrown away from the middle, harder the closer it went off.
      const flat = Math.hypot(k.x - x, k.y - y) || 1;
      const push = KNOCK.blast * (radius / 95) * (1 - 0.6 * (d / radius));
      this.damage(k, Math.round(maxDmg * (1 - 0.5 * (d / radius))), attacker, kind, [((k.x - x) / flat) * push, ((k.y - y) / flat) * push]);
    }
    this.boom(x, y, radius, kind, z);
  }

  boom(x, y, r, kind, z = 0) {
    this.room.emit('game:kart:boom', this.withZ({ x: Math.round(x), y: Math.round(y), r, kind }, z));
  }

  respawn(kart) {
    // Pick the spawn point furthest from every living enemy.
    let best = this.map.spawns[0];
    let bestScore = -Infinity;
    for (const s of this.map.spawns) {
      let nearest = Infinity;
      for (const k of this.karts.values()) {
        if (k === kart || k.dead > 0) continue;
        nearest = Math.min(nearest, (k.x - s.x) ** 2 + (k.y - s.y) ** 2 + (this.layered ? (this.heightOf(k) - s.z) ** 2 : 0));
      }
      const score = nearest + Math.random() * 1000;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    Object.assign(kart, {
      x: best.x, y: best.y, angle: best.angle, heading: best.angle, speed: 0, spin: 0, dead: 0,
      shield: SPAWN_SHIELD, invuln: 0, hp: this.hpMax, lastAttacker: null, kx: 0, ky: 0, air: 0, vz: 0, hopping: false,
    });
    if (this.layered) Object.assign(kart, { z: best.z, gz: null, launch: 0, padCd: 0, lost: null });
  }

  // ---------- simulation ----------
  tick(dt) {
    this.time += dt;
    this.tickCount++;
    this.pumpInputs();

    if (this.phase === 'countdown') {
      // Counted in ticks, so every player's screen knows exactly which step the race starts at.
      if (this.tickCount >= COUNTDOWN_S * TICK_HZ) { this.phase = 'racing'; this.raceStart = this.time; }
    } else if (this.phase === 'racing') {
      this.simulate(dt);
      const elapsed = this.time - this.raceStart;
      if (this.arena) {
        if (elapsed >= this.duration) this.endRace();
      } else {
        // Bots never hold up the end: once every connected human is done, so is the race.
        const allDone = [...this.karts.values()].every((k) => k.finished || k.bot || !this.room.players.get(k.id)?.connected);
        const graceOver = this.firstFinishAt !== null && this.time - this.firstFinishAt > this.finishGrace;
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
      K.stepKart(k, input, dt, this.map, { speed: k.speedMul * K.itemSpeed(k.star > 0, k.shrink > 0), frozen: k.freeze > 0, t: this.time });
      if (this.layered) this.layerEvents(k);
      if (!wasFalling && k.fall > 0) {
        // Off the road into water, lava or a gap: fished back out after a moment (a sticky bomb sinks).
        Object.assign(k, { gun: 0, freeze: 0, sticky: null });
        this.room.emit('game:kart:fall', { idx: k.idx, x: Math.round(k.x), y: Math.round(k.y), kind: k.fallKind });
      } else if (wasFalling && !(k.fall > 0)) {
        k.invuln = Math.max(k.invuln, FALL_INVULN);
      }
      for (const t of TIMERS) if (k[t] > 0) k[t] = Math.max(0, k[t] - dt);
      if (k.sticky) {
        k.sticky.fuse -= dt;
        if (k.sticky.fuse <= 0) this.blowSticky(k);
      }

      if (k.gun > 0) {
        k.gun -= dt;
        k.gunCd -= dt;
        while (k.gunCd <= 0 && k.gun > 0) {
          this.fire('bullet', k, (Math.random() - 0.5) * 2 * BULLET.spread);
          k.gunCd += BULLET.every;
        }
      }
      if (this.arena) {
        // Driving (or getting knocked) into lava blows you up on the spot (layered arenas: see layerEvents).
        if (!this.layered) {
          for (const h of this.map.hazards) {
            if ((k.x - h.x) ** 2 + (k.y - h.y) ** 2 < (h.r - 6) ** 2) { this.damage(k, DAMAGE.lava, null, 'lava'); break; }
          }
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

    // Kart-kart collisions: they push apart and trade momentum (ghosts pass through).
    const R = K.KART_RADIUS * 2;
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i];
        const b = solid[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        // Spin spikes reach a little beyond the kart.
        const spiky = (a.spikes > 0) !== (b.spikes > 0);
        const reach = R + (spiky ? SPIKES.reach : 0);
        if (d2 >= reach * reach || d2 < 0.0001 || Math.abs(this.heightOf(a) - this.heightOf(b)) >= 30) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        if (spiky) this.spikeHit(a.spikes > 0 ? a : b, a.spikes > 0 ? b : a);
        if (d >= R) continue;
        this.passSticky(a, b);
        if ((a.star > 0) !== (b.star > 0)) {
          const push = (R - d) / 2;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          if (a.star > 0) this.starRam(a, b, nx, ny);
          else this.starRam(b, a, -nx, -ny);
        } else {
          this.bumpKarts(a, b, nx, ny, R - d);
        }
      }
    }

    // Item boxes.
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i] > 0) { this.boxes[i] = Math.max(0, this.boxes[i] - dt); continue; }
      const box = this.map.itemBoxes[i];
      for (const k of alive) {
        if ((k.air || 0) < BOX_CLEAR && (k.x - box.x) ** 2 + (k.y - box.y) ** 2 < 32 * 32 && this.level(k, box.z, LEVEL.box)) {
          // Both slots full (or finished): drive straight through, the box stays for someone else.
          if (k.finished || (k.item && k.item2)) continue;
          this.boxes[i] = this.boxRespawn;
          // Decided now, usable once the roulette in the HUD stops spinning.
          this.giveItem(k, this.rollItem(k));
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
        if (k.ghost > 0 || k.dead > 0 || k.air > GROUND_CLEAR || k.id === m.owner || this.isFriendly(k.id, m.owner) || !this.level(k, m.z, LEVEL.trap)) continue;
        if ((k.x - m.x) ** 2 + (k.y - m.y) ** 2 < MINE.trigger ** 2) {
          m.life = 0;
          this.explode(m.x, m.y, MINE.radius, DAMAGE.mine, this.karts.get(m.owner), 'mine', m.z);
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
        if (k.ghost > 0 || k.dead > 0 || k.air > GROUND_CLEAR || (b.safe > 0 && k.id === b.owner) || this.isFriendly(k.id, b.owner) || !this.level(k, b.z, LEVEL.trap)) continue;
        if ((k.x - b.x) ** 2 + (k.y - b.y) ** 2 < (K.KART_RADIUS + 10) ** 2) {
          if (k.invuln > 0 && k.shield <= 0) continue;
          this.damage(k, DAMAGE.banana, this.karts.get(b.owner), 'banana');
          b.life = 0;
          break;
        }
      }
    }
    this.bananas = this.bananas.filter((b) => b.life > 0);

    // Sticky bombs on the ground cling to the first kart over them (the thrower gets a moment to clear).
    for (const g of this.stickies) {
      g.life -= dt;
      g.age += dt;
      for (const k of alive) {
        if (k.ghost > 0 || k.sticky || k.finished || k.air > GROUND_CLEAR || this.isFriendly(k.id, g.owner) || !this.level(k, g.z, LEVEL.trap)) continue;
        if (k.id === g.owner && g.age < STICKY.ownerGrace) continue;
        if ((k.x - g.x) ** 2 + (k.y - g.y) ** 2 < (K.KART_RADIUS + 12) ** 2) {
          this.attachSticky(k, this.karts.get(g.owner));
          g.life = 0;
          break;
        }
      }
    }
    this.stickies = this.stickies.filter((g) => g.life > 0);

    // Decoy boxes: they look like item boxes until a rival drives into one.
    for (const d of this.decoys) {
      d.life -= dt;
      for (const k of alive) {
        if (k.ghost > 0 || k.finished || k.id === d.owner || this.isFriendly(k.id, d.owner) || (k.air || 0) > BOX_CLEAR || !this.level(k, d.z, LEVEL.box)) continue;
        if ((k.x - d.x) ** 2 + (k.y - d.y) ** 2 < DECOY.trigger ** 2) {
          d.life = 0;
          this.boom(d.x, d.y, 60, 'decoy', d.z);
          this.damage(k, DAMAGE.decoy, this.karts.get(d.owner), 'decoy');
          break;
        }
      }
    }
    this.decoys = this.decoys.filter((d) => d.life > 0);
  }

  // ---------- layered arenas ----------
  // After a kart's physics step: fell into the void, the moat or a lava pool (the kill goes to whoever
  // hit it last), flew off a jump pad, bounced off a bumper or got hit by a moving obstacle.
  layerEvents(k) {
    if (k.padded) { this.room.emit('game:kart:pad', { idx: k.idx, i: k.padded - 1 }); k.padded = 0; }
    if (k.bumper) { this.room.emit('game:kart:bumper', { idx: k.idx, i: k.bumper - 1 }); k.bumper = 0; }
    if (k.whacked) { this.room.emit('game:kart:whack', { idx: k.idx, i: k.whacked - 1, x: Math.round(k.x), y: Math.round(k.y), z: Math.round(k.z) }); k.whacked = 0; }
    if (k.lost) {
      const kind = k.lost;
      k.lost = null;
      this.damage(k, DAMAGE.lava, null, kind);
    }
  }

  // Shots in a layered arena hug the floor: they follow ramps, drop off ledges (falling) and are
  // stopped by walls at their own height; over the void they fall away.
  shotFloor(s, dt) {
    const f = this.map.floorAt(s.x, s.y, s.z + K.Layers.STEP, this.time);
    if (f >= s.z - 2) { s.z = f; s.vz = 0; return; }
    s.vz = (s.vz || 0) - K.PHYS.gravity * dt;
    s.z = Math.max(f, s.z + s.vz * dt);
    if (s.z <= f) s.vz = 0;
    if (s.z < this.map.deathZ) s.life = 0;
  }

  // ---------- sticky bombs and spikes ----------
  attachSticky(k, by) {
    if (k.sticky) return;
    k.sticky = { fuse: K.ITEM_FX.stickyFuse, by: by ? by.id : null, at: this.time };
    this.room.emit('game:kart:stick', { idx: k.idx, by: by ? by.idx : -1 });
  }

  // Touching karts: a sticky bomb jumps to the one without (not straight back: it has to stay put a moment).
  passSticky(a, b) {
    const from = a.sticky && !b.sticky ? a : b.sticky && !a.sticky ? b : null;
    if (!from) return;
    const to = from === a ? b : a;
    if (this.time - from.sticky.at < STICKY.passGap) return;
    to.sticky = { fuse: from.sticky.fuse, by: from.id, at: this.time };
    from.sticky = null;
    this.room.emit('game:kart:stick', { idx: to.idx, by: from.idx, pass: true });
  }

  // The fuse ran out: whoever carries it takes the whole blast (even its thrower, even if a teammate
  // passed it); karts close by get caught at half strength.
  blowSticky(k) {
    const st = k.sticky;
    k.sticky = null;
    const by = st.by ? this.karts.get(st.by) : null;
    const credit = by && by !== k && !this.isFriendly(by.id, k.id) ? by : null;
    this.boom(k.x, k.y, STICKY.radius, 'sticky', this.heightOf(k));
    this.damage(k, DAMAGE.sticky, credit, 'sticky');
    for (const o of this.karts.values()) {
      if (o === k || o === by || o.dead > 0) continue;
      const d = Math.hypot(o.x - k.x, o.y - k.y, this.layered ? this.heightOf(o) - this.heightOf(k) : o.air || 0);
      if (d > STICKY.radius) continue;
      this.damage(o, Math.round(DAMAGE.sticky * 0.5 * (1 - 0.5 * (d / STICKY.radius))), by, 'sticky');
    }
  }

  spikeHit(spiky, victim) {
    if (this.isFriendly(spiky.id, victim.id)) return;
    if (victim.spikedBy === spiky.id && this.time - victim.spikedAt < SPIKES.gap) return;
    victim.spikedBy = spiky.id;
    victim.spikedAt = this.time;
    if (!this.damage(victim, DAMAGE.spikes, spiky, 'spikes')) return;
    if (++spiky.spikeHits >= SPIKES.hits) spiky.spikes = 0;
    // Flung off the spikes.
    const d = Math.hypot(victim.x - spiky.x, victim.y - spiky.y) || 1;
    victim.kx = (victim.kx || 0) + ((victim.x - spiky.x) / d) * 260;
    victim.ky = (victim.ky || 0) + ((victim.y - spiky.y) / d) * 260;
  }

  // Two karts touch: separate them (the lighter one gives way more) and, if they were closing,
  // trade momentum like billiard balls. The part of the change along a kart's travel direction
  // goes into its speed; the sideways part becomes a shove (kx, ky) that fades over ~0.2 s.
  bumpKarts(a, b, nx, ny, overlap) {
    const mass = (k) => (k.boost > 0 ? BUMP.boostMass : 1) * (k.shrink > 0 ? BUMP.shrunkMass : 1);
    const ma = mass(a);
    const mb = mass(b);
    a.x -= nx * overlap * (mb / (ma + mb)); a.y -= ny * overlap * (mb / (ma + mb));
    b.x += nx * overlap * (ma / (ma + mb)); b.y += ny * overlap * (ma / (ma + mb));
    const vel = (k) => {
      const h = k.heading === undefined ? k.angle : k.heading;
      return [Math.cos(h) * k.speed + (k.kx || 0), Math.sin(h) * k.speed + (k.ky || 0)];
    };
    const va = vel(a);
    const vb = vel(b);
    const rel = (vb[0] - va[0]) * nx + (vb[1] - va[1]) * ny;
    if (rel >= 0) return; // already moving apart
    const closing = -rel;
    const j = ((1 + BUMP.restitution) * closing) / (1 / ma + 1 / mb);
    // Who drove into whom: the kart moving faster along the line between them.
    const aIn = va[0] * nx + va[1] * ny;
    const bIn = -(vb[0] * nx + vb[1] * ny);
    const rammer = closing > BUMP.ramSpeed ? (aIn >= bIn ? a : b) : null;
    const victim = rammer === a ? b : rammer === b ? a : null;
    const shove = (k, dvx, dvy) => {
      const h = k.heading === undefined ? k.angle : k.heading;
      const hx = Math.cos(h);
      const hy = Math.sin(h);
      const along = dvx * hx + dvy * hy;
      const sx = dvx - along * hx;
      const sy = dvy - along * hy;
      k.speed += along;
      k.kx = (k.kx || 0) + sx;
      k.ky = (k.ky || 0) + sy;
      return [k.idx, Math.round(along), Math.round(sx), Math.round(sy)];
    };
    const ja = (j / ma) * (victim === a ? BUMP.ramShove : 1);
    const jb = (j / mb) * (victim === b ? BUMP.ramShove : 1);
    const shoves = [shove(a, -nx * ja, -ny * ja), shove(b, nx * jb, ny * jb)];
    if (closing > BUMP.eventSpeed) {
      this.room.emit('game:kart:bump', this.withZ({
        x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), p: Math.round(Math.min(1, closing / 600) * 100) / 100,
        ram: rammer ? rammer.idx : -1, s: shoves,
      }, (this.heightOf(a) + this.heightOf(b)) / 2));
    }
    // Arena: a proper ram costs the victim a little health (once per ram, teammates excepted).
    if (rammer && this.arena && !this.isFriendly(rammer.id, victim.id)
      && !(victim.bumpBy === rammer.id && this.time - victim.bumpAt < BUMP.ramGap)) {
      victim.bumpBy = rammer.id;
      victim.bumpAt = this.time;
      const hard = Math.min(1, (closing - BUMP.ramSpeed) / 300);
      this.damage(victim, DAMAGE.ram + Math.round(10 * hard), rammer, 'ram');
    }
  }

  // A star kart rams a rival: race, they spin out; arena, they take damage and get knocked away.
  // One hit per ram: the same star kart can't hit the same victim again for STAR_RAM_GAP seconds
  // (a per-pair cooldown, so the victim stays open to everyone else's attacks meanwhile).
  starRam(star, victim, nx, ny) {
    if (this.isFriendly(star.id, victim.id)) return;
    if (victim.ramBy === star.id && this.time - victim.ramAt < STAR_RAM_GAP) return;
    if (!this.damage(victim, DAMAGE.star, star, 'star')) return;
    victim.ramBy = star.id;
    victim.ramAt = this.time;
    victim.x += nx * 14;
    victim.y += ny * 14;
    victim.speed *= 0.4;
  }

  // Is (x, y) past the walls (or inside an obstacle)? `shot.ti` keeps race lookups local and cheap.
  blocked(x, y, shot) {
    if (this.layered) return this.map.blocked(x, y, 0, shot ? shot.z : 0, this.time);
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
          if (k.id === s.owner || k.ghost > 0 || k.dead > 0 || this.isFriendly(k.id, s.owner) || !this.level(k, s.z, 60)) continue;
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
        // Bombs fly over karts and go off where they land (or against a wall). In a layered arena
        // the lob arcs from the thrower's height down (or up) to the floor it lands on.
        if (this.layered) {
          const u = Math.min(1, s.age / BOMB.flight);
          s.z = s.z0 + (s.lz - s.z0) * u + BOMB_LOB.apex * 4 * u * (1 - u);
        }
        const wall = this.layered ? this.map.blocked(s.x, s.y, 0, s.z - K.Layers.STEP, this.time) : this.arena && this.map.blocked(s.x, s.y);
        if (s.life <= 0 || wall) {
          s.life = 0;
          this.explode(s.x, s.y, BOMB.radius, DAMAGE.bomb, owner, 'bomb', this.layered ? (s.life <= 0 && !wall ? s.lz : s.z) : 0);
        }
        continue;
      }
      if (this.layered && s.kind !== 'sticky') this.shotFloor(s, dt);
      if (s.kind === 'bouncer') {
        this.bounce(s);
        if (s.life <= 0) { // out of bounces (or time): it shatters
          this.boom(s.x, s.y, 30, 'bouncer', s.z);
          continue;
        }
      }
      const shell = s.kind !== 'bullet';
      for (const k of alive) {
        // Bouncers can come back for their owner once they have hit a wall.
        const own = k.id === s.owner;
        if ((own && !(s.kind === 'bouncer' && s.bounced)) || k.ghost > 0 || k.dead > 0 || (!own && this.isFriendly(k.id, s.owner))) continue;
        if (!this.level(k, s.z, LEVEL.shot)) continue;
        const r = K.KART_RADIUS + (s.kind === 'bullet' ? 4 : 8);
        // Swept test over this tick's whole path: bullets cover ~60 units a
        // tick, more than a kart is wide, so a point test lets them pass through.
        if (segmentDist2(px, py, s.x, s.y, k.x, k.y) < r * r) {
          s.life = 0;
          if (shell && this.trailBlock(k, s)) { s.used = true; break; }
          if (s.kind === 'sticky') {
            // It sticks (a star or a shield shrugs it off).
            if (k.star > 0 || k.shield > 0 || k.sticky) this.room.emit('game:kart:block', { idx: k.idx });
            else this.attachSticky(k, owner);
            s.used = true;
            break;
          }
          const knock = shell ? [Math.cos(s.angle) * KNOCK.shell, Math.sin(s.angle) * KNOCK.shell] : null;
          this.damage(k, s.dmg, owner, s.kind === 'bullet' ? 'bullet' : s.kind, knock);
          if (shell) this.boom(s.x, s.y, 40, s.kind, s.z);
          break;
        }
      }
      if (s.life > 0 && s.kind !== 'bouncer' && this.blocked(s.x, s.y, s)) {
        s.life = 0;
        if (s.kind === 'rocket' || s.kind === 'snowball') this.boom(s.x, s.y, 40, s.kind, s.z);
      }
      // A sticky bomb that touched nobody lands and waits for a kart.
      if (s.kind === 'sticky' && s.life <= 0 && !s.used && owner) {
        const z = this.dropZ(s.x, s.y, owner, s.z);
        if (z !== null) this.stickies.push({ id: s.id, x: s.x, y: s.y, z, owner: s.owner, life: STICKY.ground, age: 0 });
      }
    }
    this.shots = this.shots.filter((s) => s.life > 0);
  }

  // A banana or mine held behind your kart soaks up a shell coming from behind (and is used up).
  // Only when the shell would have hurt: star power, a shield or post-hit invulnerability keep the item.
  trailBlock(k, s) {
    if ((k.item !== 'banana' && k.item !== 'mine') || k.roulette > 0) return false;
    if (k.star > 0 || k.shield > 0 || k.invuln > 0 || k.finished) return false;
    if ((s.x - k.x) * Math.cos(k.angle) + (s.y - k.y) * Math.sin(k.angle) > -4) return false;
    k.ammo--;
    if (k.ammo <= 0) { k.item = null; k.ammo = 0; this.promoteItem(k); }
    this.room.emit('game:kart:block', { idx: k.idx, kind: 'trail' });
    this.boom(s.x, s.y, 30, s.kind, s.z);
    return true;
  }

  // Bouncer shells reflect off walls and obstacles until they run out of bounces.
  bounce(s) {
    const R = BOUNCER.radius;
    let nx = 0;
    let ny = 0;
    if (this.layered) {
      this.map.walls(s.x, s.y, s.z, R, (wx, wy, depth) => { s.x += wx * depth; s.y += wy * depth; nx += wx; ny += wy; });
      if (this.map.edge === 'wall') {
        const lo = K.Layers.EDGE + R;
        const hi = this.map.size - K.Layers.EDGE - R;
        if (s.x < lo) { s.x = lo; nx += 1; }
        if (s.x > hi) { s.x = hi; nx -= 1; }
        if (s.y < lo) { s.y = lo; ny += 1; }
        if (s.y > hi) { s.y = hi; ny -= 1; }
      }
    } else if (this.arena) {
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
      if (s.phase === 'dive' && target) { s.sx = s.x; s.sy = s.y; s.sAlt = s.alt; s.sz = s.z; s.diveT = 0; }
    }
    if (!target || s.life <= 0) {
      s.life = 0;
      this.boom(s.x, s.y, 60, 'comet', (s.z || 0) + (this.layered ? s.alt : 0));
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
        Object.assign(s, { phase: 'dive', diveT: 0, sx: s.x, sy: s.y, sAlt: s.alt, sz: s.z });
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
    if (this.layered) s.z = s.sz + (this.heightOf(target) - s.sz) * p; // down onto the floor the target is on
    if (p >= 1) {
      s.life = 0;
      this.explode(target.x, target.y, COMET.radius, DAMAGE.comet, owner, 'comet', this.heightOf(target));
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
      k.sticky = null; // nothing goes off on the victory lap
      k.finishTime = this.time - this.raceStart;
      this.finishOrder.push(k.id);
      // Only a human finishing starts the grace countdown; bots finishing first never cut a race short.
      if (this.firstFinishAt === null && !k.bot) this.firstFinishAt = this.time;
      const p = this.room.players.get(k.id);
      const name = k.bot ? `🤖 ${k.name}` : p ? p.name : null;
      this.room.emit('game:kart:finish', { idx: k.idx, place: this.finishOrder.length, time: k.finishTime });
      this.room.record?.('kart_finish', k.id, { place: this.finishOrder.length, time: Math.round(k.finishTime * 1000) / 1000, bot: k.bot, map: this.map.id });
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
      // [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags, kills, deaths, hp, air, fx, roulette,
      //  item2, ammo2, roulette2, sticky]
      // air: height above the ground; fx: 1 falling, 2 trick, 4 fell in lava, 8 fell in water
      // roulette: hundredths of a second until the item roulette stops (0 = item ready / none)
      // item2 / ammo2 / roulette2: the reserve slot, same encoding
      // sticky: tenths of a second until the sticky bomb on this kart goes off (0 = none)
      // flags add 32768 frozen, 65536 spin spikes
      // Layered arenas add [z]: the kart's height (its wheels), and every shot, trap and decoy row
      // below ends with the height it is at.
      k: [...this.karts.values()].map((k) => this.zRow([
        k.idx, Math.round(k.x), Math.round(k.y), Math.round(k.angle * 1000), Math.round(k.speed),
        Math.max(1, Math.min(this.laps, k.lap)), place.get(k.id), itemCode(k.item), k.ammo,
        (k.spin > 0 ? 1 : 0) | (k.boost > 0 ? 2 : 0) | (k.shield > 0 ? 4 : 0) | (k.finished ? 8 : 0)
          | (k.invuln > 0 ? 16 : 0) | (k.dead > 0 ? 32 : 0)
          | (k.drift ? 64 : 0) | (k.drift && K.driftLevel(k.driftTime) >= 1 ? 128 : 0)
          | (k.drift && K.driftLevel(k.driftTime) >= 2 ? 256 : 0) | (k.drift < 0 ? 512 : 0)
          | (k.ghost > 0 ? 1024 : 0) | (k.gun > 0 ? 2048 : 0)
          | (k.star > 0 ? 4096 : 0) | (k.shrink > 0 ? 8192 : 0) | (k.ink > 0 ? 16384 : 0)
          | (k.freeze > 0 ? 32768 : 0) | (k.spikes > 0 ? 65536 : 0),
        // hp is sent as a percentage of this round's max health.
        k.kills, k.deaths, Math.max(0, Math.min(100, Math.round((k.hp / this.hpMax) * 100))),
        Math.round(k.air || 0),
        (k.fall > 0 ? 1 : 0) | (k.trick > 0 ? 2 : 0) | (k.fall > 0 && k.fallKind === 'lava' ? 4 : 0) | (k.fall > 0 && k.fallKind === 'water' ? 8 : 0),
        Math.ceil(k.roulette * 100 - 1e-6),
        itemCode(k.item2), k.ammo2, Math.ceil(k.roulette2 * 100 - 1e-6),
        k.sticky ? Math.max(1, Math.ceil(k.sticky.fuse * 10)) : 0,
      ], k.z)),
      // shots: [id, kind (1 rocket, 2 bullet, 3 bomb, 4 bouncer, 5 comet, 6 snowball, 7 sticky), x, y, angle*1000,
      //   flight progress 0-100 (bombs, stickies)]
      //   bombs add [landing x, landing y] (layered arenas: and landing z); comets send their altitude as the
      //   6th field and add [target kart idx]
      s: this.shots.map((s) => {
        const row = [s.id, SHOT_CODE[s.kind], Math.round(s.x), Math.round(s.y), Math.round(s.angle * 1000),
          s.kind === 'bomb' ? Math.round((s.age / BOMB.flight) * 100) : s.kind === 'comet' ? Math.round(s.alt)
            : s.kind === 'sticky' ? Math.round((s.age / STICKY.flight) * 100) : 0];
        if (s.kind === 'bomb') row.push(Math.round(s.lx), Math.round(s.ly), ...(this.layered ? [Math.round(s.lz)] : []));
        else if (s.kind === 'comet') row.push(s.target ? this.karts.get(s.target).idx : -1);
        return this.zRow(row, s.z);
      }),
      m: this.mines.map((m) => this.zRow([m.id, Math.round(m.x), Math.round(m.y), m.arm > 0 ? 0 : 1], m.z)),
      b: this.bananas.map((b) => this.zRow([b.id, Math.round(b.x), Math.round(b.y)], b.z)),
      g: this.stickies.map((g) => this.zRow([g.id, Math.round(g.x), Math.round(g.y)], g.z)),
      // decoys carry their owner's index so the owner's team can tell them apart
      d: this.decoys.map((d) => this.zRow([d.id, Math.round(d.x), Math.round(d.y), this.karts.get(d.owner)?.idx ?? -1], d.z)),
      x: this.boxes.map((t) => (t > 0 ? 0 : 1)),
    });
    // Each player's own kart, in full, and which of their steps it is after (see onInput): their
    // screen replays its newer inputs from here. g: their first step of the race (karts only move
    // from the tick after the countdown's last); f: 1 racing, 2 wrecked, 4 falling, 8 over.
    for (const k of this.karts.values()) {
      if (!k.net || k.net.L === null) continue;
      this.room.emitTo(k.id, 'game:kart:me', {
        L: k.net.L, t: this.time, s: K.packKart(k), g: COUNTDOWN_S * TICK_HZ + 1 - k.net.off,
        f: (this.phase === 'racing' ? 1 : 0) | (k.dead > 0 ? 2 : 0) | (k.fall > 0 ? 4 : 0) | (this.phase === 'done' ? 8 : 0),
      });
    }
  }

  // Layered arenas: a snapshot row ends with the height of what it describes.
  zRow(row, z) {
    if (this.layered) row.push(Math.round(Number.isFinite(z) ? z : 0));
    return row;
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
    this.interval?.stop?.();
    clearTimeout(this.endTimer);
    this.interval = null;
  }
}

module.exports = {
  KartBattle, DAMAGE, HP_MAX, CLASS_SPEED, BOX_RESPAWN, RESPAWN_TIME, ARENA_HEALTH, KILL_LIMITS, WEAPON_ITEMS, allowedItems,
};
