// Control Room (Spaceteam style). Every crew of 2-6 flies one ship. Each player has a panel of
// silly-named controls and sees one order at a time, usually for a control on a crewmate's panel,
// so the crew has to shout orders at each other. Completed orders fill the sector progress,
// expired orders damage the hull. Fill the progress to warp to the next, harder sector.
// All crews fly at once; the furthest sector (then progress) wins.
const MIN_CREW = 2;
const MAX_CREW = 6;
const MAX_CREWS = 5;
const MAX_PANEL = 8; // a panel can grow past its normal size when a crewmate drops out
const TICK_MS = 150;
const FLUSH_MS = 25; // crew state updates are coalesced this long
const FLEET_MS = 300; // fleet summary broadcast at most this often
const BRIEFING_MS = 5000;
const WARP_MS = 3800;
const FINAL_COUNTDOWN_MS = 60_000; // once one crew finishes, the others get this long
const END_DELAY_MS = 2600; // let the last explosion / warp play before the results
const ORDER_GAP_MS = [500, 1100]; // pause before your next order (random in range)
const MISS_GAP_MS = 1400;
const OTHER_BIAS = 0.75; // share of orders for a control on someone else's panel
const RELAY_COOLDOWN_MS = 2500;
const RELAY_SHOW_MS = 3000;
const ACTIONS_PER_SEC = 25;
const MASH_PER_SEC = 18;
const HULL_MAX = 100;
const WARP_REPAIR = 12;

const CREW_STYLES = [
  { id: 0, name: 'Red', color: '#ef4444' },
  { id: 1, name: 'Blue', color: '#3b82f6' },
  { id: 2, name: 'Green', color: '#22c55e' },
  { id: 3, name: 'Yellow', color: '#eab308' },
  { id: 4, name: 'Purple', color: '#a855f7' },
];

const SHIP_NAMES = [
  'Star Badger', 'Comet Kazoo', 'Nebula Nomad', 'Void Pelican', 'Quasar Waffle', 'Rusty Meteor',
  'Cosmic Toaster', 'Lunar Llama', 'Photon Pickle', 'Hyper Hamster', 'Astro Noodle', 'Galactic Goose',
  'Orbit Otter', 'Pulsar Puffin', 'Solar Sloth', 'Warp Walrus',
];

// Panels get harder each sector: more controls, shorter timers, bigger goals, more events.
const DIFFICULTY = {
  cadet: { time: 18, floor: 8.5, decay: 0.93, controls: [4, 4, 5, 5, 5, 6], damage: 5, goal: 3.2, events: [0, 1, 2, 2, 3], mash: 6, mashMs: 10_000, asteroid: 12 },
  pilot: { time: 14, floor: 6.5, decay: 0.92, controls: [4, 5, 5, 6], damage: 7, goal: 3.8, events: [0, 2, 3], mash: 7, mashMs: 8500, asteroid: 16 },
  ace: { time: 10.5, floor: 5, decay: 0.92, controls: [5, 5, 6], damage: 9, goal: 4.4, events: [1, 2, 3], mash: 8, mashMs: 7500, asteroid: 20 },
};

// Team events. Each runs for `ms`; the client presents them (see public/js/games/controlroom.js).
const EVENTS = {
  asteroid: { ms: null, label: 'Asteroid field' }, // duration comes from the difficulty
  blackout: { ms: 6000, label: 'Blackout' },
  shuffle: { ms: 4000, label: 'Panel shuffle' },
  wormhole: { ms: 10_000, label: 'Wormhole' },
  ionstorm: { ms: 9000, label: 'Ion storm' },
};
const EVENT_TYPES = Object.keys(EVENTS);
const BLACKOUT_GRACE_MS = 4000; // order timers are extended so the dark isn't pure punishment

const TYPES = ['button', 'toggle', 'slider', 'dial', 'multi', 'lever'];
const MULTI_SETS = [
  ['A', 'B', 'C'], ['A', 'B', 'C', 'D'], ['Red', 'Green', 'Blue'], ['Pink', 'Cyan', 'Lime', 'Gold'],
  ['Alpha', 'Beta', 'Gamma'], ['Mild', 'Spicy', 'Nuclear'], ['Idle', 'Cruise', 'Max'], ['North', 'East', 'South', 'West'],
];
const RANGES = { slider: [0, 5], dial: [0, 9] };

const FIRST_WORDS = [
  'Quantum', 'Gravy', 'Wobble', 'Flux', 'Plasma', 'Turbo', 'Hyper', 'Ion', 'Neutrino', 'Photon', 'Banana', 'Noodle',
  'Waffle', 'Tachyon', 'Giga', 'Pickle', 'Muon', 'Chrono', 'Disco', 'Fizzy', 'Gamma', 'Krypto', 'Lunar', 'Mega',
  'Nano', 'Omega', 'Polka', 'Retro', 'Sonic', 'Tofu', 'Ultra', 'Vortex', 'Zappy', 'Jelly', 'Cosmic', 'Spongy',
  'Biscuit', 'Nebula', 'Pulsar', 'Boson', 'Hadron', 'Graviton', 'Thermo', 'Cryo', 'Electro', 'Magneto', 'Spectral',
  'Crunchy', 'Squishy', 'Bouncy', 'Fuzzy', 'Wonky', 'Jiggly', 'Zesty', 'Galactic', 'Stellar', 'Orbital', 'Atomic',
  'Bubble', 'Custard', 'Pretzel', 'Comet', 'Laser', 'Sprinkle', 'Velvet', 'Turnip', 'Mango', 'Sizzle', 'Glitter', 'Moxie',
];
const SECOND_WORDS = [
  'Thruster', 'Spatula', 'Inducer', 'Capacitor', 'Modulator', 'Flange', 'Sprocket', 'Coil', 'Valve', 'Gyro', 'Whisk',
  'Regulator', 'Oscillator', 'Manifold', 'Injector', 'Dampener', 'Stabilizer', 'Toaster', 'Accordion', 'Kazoo',
  'Harmonizer', 'Reticulator', 'Turbine', 'Lattice', 'Ladle', 'Doohickey', 'Gizmo', 'Doodad', 'Splitter', 'Conduit',
  'Booster', 'Emitter', 'Rectifier', 'Agitator', 'Calibrator', 'Converter', 'Sprinkler', 'Blender', 'Throttle',
  'Piston', 'Gasket', 'Bellows', 'Siphon', 'Funnel', 'Antenna', 'Beacon', 'Gimbal', 'Ratchet', 'Spindle', 'Sensor',
  'Scanner', 'Matrix', 'Array', 'Engine', 'Reactor', 'Battery', 'Drive', 'Pump', 'Kettle', 'Grinder', 'Juicer',
  'Wrangler', 'Spooler', 'Amplifier', 'Diffuser', 'Vaporizer', 'Plunger', 'Gearbox', 'Whistle', 'Trumpet',
];

const VERBS = {
  button: ['Engage', 'Activate', 'Press', 'Fire up', 'Punch', 'Boop'],
  lever: ['Pull', 'Yank', 'Crank'],
  slider: ['Set', 'Slide'],
  dial: ['Turn', 'Dial', 'Rotate'],
  multi: ['Switch', 'Set'],
};

function pick(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

function shuffled(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Crew sizes for an automatic split: one crew for 2-3 players, otherwise balanced crews of 2-6
// aiming at about four per ship (at most five ships).
function crewSizes(n) {
  if (n < MIN_CREW) return [];
  const k = n <= 3 ? 1 : Math.min(MAX_CREWS, Math.max(2, Math.ceil(n / MAX_CREW), Math.round(n / 4)));
  return Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
}

// Who flies with whom. Team mode uses the room's teams (each must have 2-6 players); otherwise
// everyone is split automatically. Returns { crews: [{ id, name, color, members }] } or { error }.
function planCrews(players, settings, teams, rand = Math.random) {
  if (players.length < MIN_CREW) return { error: `Control Room needs at least ${MIN_CREW} players` };
  if (settings.teamMode) {
    const groups = teams
      .map((t) => ({ team: t, members: players.filter((p) => p.team === t.id) }))
      .filter((g) => g.members.length);
    const bad = groups.filter((g) => g.members.length < MIN_CREW || g.members.length > MAX_CREW);
    if (bad.length) {
      const list = bad.map((g) => `${g.team.name} has ${g.members.length}`).join(', ');
      return { error: `Each crew needs ${MIN_CREW}-${MAX_CREW} players (${list}). Move players between teams or turn teams off.` };
    }
    return { crews: groups.map((g) => ({ id: g.team.id, name: g.team.name, color: g.team.color, members: g.members.map((p) => p.id) })) };
  }
  const order = shuffled(players, rand);
  const sizes = crewSizes(order.length);
  let at = 0;
  return {
    crews: sizes.map((size, i) => {
      const members = order.slice(at, at + size).map((p) => p.id);
      at += size;
      return { ...CREW_STYLES[i], members };
    }),
  };
}

// `count` control names, unique within the crew: no first or last word is used twice
// (so a shouted "Gravy!" means one control), avoiding names in `taken`.
function makeNames(count, rand = Math.random, taken = []) {
  const usedA = new Set(taken.map((n) => n.split(' ')[0]));
  const usedB = new Set(taken.map((n) => n.split(' ').slice(1).join(' ')));
  const usedFull = new Set(taken);
  const firsts = shuffled(FIRST_WORDS, rand);
  const seconds = shuffled(SECOND_WORDS, rand);
  const names = [];
  for (const a of firsts) {
    if (names.length >= count) break;
    if (usedA.has(a)) continue;
    const b = seconds.find((w) => !usedB.has(w) && `${a} ${w}`.length <= 20);
    if (!b) break;
    usedA.add(a); usedB.add(b); usedFull.add(`${a} ${b}`);
    names.push(`${a} ${b}`);
  }
  // Huge crews after many rejoins can run out of fresh words: fall back to unique full names.
  for (let i = 0; names.length < count && i < 5000; i++) {
    const n = `${pick(FIRST_WORDS, rand)} ${pick(SECOND_WORDS, rand)}`;
    if (!usedFull.has(n)) { usedFull.add(n); names.push(n); }
  }
  return names;
}

class ControlRoom {
  static minPlayers = MIN_CREW;

  // Checked before the room switches to the game, so a bad team split is refused with a message.
  static canStart(room) {
    const plan = planCrews(room.connectedPlayers, room.settings, room.teamList());
    return plan.error ? { ok: false, error: plan.error } : { ok: true };
  }

  constructor(room) {
    const s = room.settings;
    this.room = room;
    this.clock = () => Date.now(); // swapped out by tests
    this.rand = Math.random;
    this.difficulty = DIFFICULTY[s.crDifficulty] ? s.crDifficulty : 'pilot';
    this.cfg = DIFFICULTY[this.difficulty];
    this.comms = s.crComms === 'relay' ? 'relay' : 'voice';
    this.sectors = [0, 5, 10].includes(s.crSectors) ? s.crSectors : 5; // 0 = endless
    this.crews = [];
    this.crewByPlayer = new Map();
    this.stats = new Map(); // playerId -> { done, mine, panic, relays, missed }
    this.phase = 'briefing'; // briefing | flying | over
    this.briefingEnds = 0;
    this.finalAt = 0;
    this.endAt = 0;
    this.nextId = 1;
    this.nextOrderId = 1;
    this.dirty = new Set();
    this.flushTimer = null;
    this.fleetDirty = true;
    this.lastFleet = 0;
    this.rate = new Map(); // playerId -> { act: { t, n }, mash: { t, n } } per-second counters
    this.relayAt = new Map();
    this.interval = null;
    this.stopped = false;
  }

  // ---------- Setup ----------
  start() {
    const room = this.room;
    const plan = planCrews(room.connectedPlayers, room.settings, room.teamList(), this.rand);
    if (plan.error) throw new Error(plan.error);
    const ships = shuffled(SHIP_NAMES, this.rand);
    const now = this.clock();
    this.crews = plan.crews.map((c, i) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      ship: ships[i % ships.length],
      members: c.members.map((id) => ({ id, connected: true })),
      sector: 1,
      progress: 0,
      goal: 0,
      hull: HULL_MAX,
      status: 'flying', // flying | warping | done | destroyed | abandoned
      controls: new Map(),
      panels: new Map(),
      orders: new Map(), // holder playerId -> order
      nextOrderAt: new Map(),
      event: null,
      eventPlan: [],
      eventBag: [],
      eventCooldown: 0,
      sectorStart: now,
      warpEnds: 0,
      startedAt: now,
      finishedAt: 0,
      endedAt: 0,
      completed: 0,
      missed: 0,
    }));
    for (const crew of this.crews) {
      for (const m of crew.members) {
        this.crewByPlayer.set(m.id, crew);
        this.statsFor(m.id);
      }
      this.setupSector(crew, 1, now);
    }
    this.phase = 'briefing';
    this.briefingEnds = now + BRIEFING_MS;
    for (const crew of this.crews) this.markCrew(crew);
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.interval);
    clearTimeout(this.flushTimer);
    this.interval = null;
    this.flushTimer = null;
  }

  statsFor(id) {
    if (!this.stats.has(id)) this.stats.set(id, { done: 0, mine: 0, panic: 0, relays: 0, missed: 0 });
    return this.stats.get(id);
  }

  crewOf(playerId) {
    return this.crewByPlayer.get(playerId) || null;
  }

  member(crew, id) {
    return crew.members.find((m) => m.id === id) || null;
  }

  connectedMembers(crew) {
    return crew.members.filter((m) => m.connected && this.room.players.get(m.id)?.connected);
  }

  panelSize(sector) {
    const list = this.cfg.controls;
    return list[Math.min(sector - 1, list.length - 1)];
  }

  orderTime(sector) {
    return Math.max(this.cfg.floor, this.cfg.time * this.cfg.decay ** (sector - 1));
  }

  goalFor(crew, sector) {
    const n = Math.max(MIN_CREW, this.connectedMembers(crew).length || crew.members.length);
    return Math.max(4, Math.round(n * (this.cfg.goal + 0.7 * (sector - 1))));
  }

  damage(sector) {
    return Math.round(this.cfg.damage * (1 + 0.08 * (sector - 1)));
  }

  eventCount(sector) {
    const list = this.cfg.events;
    return list[Math.min(sector - 1, list.length - 1)];
  }

  makeControl(name, owner, type) {
    const c = { id: `k${this.nextId++}`, name, type, owner, home: owner, value: null };
    if (type === 'toggle') c.value = this.rand() < 0.5;
    if (type === 'slider' || type === 'dial') {
      [c.min, c.max] = RANGES[type];
      c.value = c.min + Math.floor(this.rand() * (c.max - c.min + 1));
    }
    if (type === 'multi') {
      c.options = pick(MULTI_SETS, this.rand);
      c.value = Math.floor(this.rand() * c.options.length);
    }
    return c;
  }

  // A panel of `size` controls with as many different types as possible.
  makePanel(crew, owner, size) {
    const taken = [...crew.controls.values()].map((c) => c.name);
    const names = makeNames(size, this.rand, taken);
    let bag = [];
    const ids = [];
    for (const name of names) {
      if (!bag.length) bag = shuffled(TYPES, this.rand);
      const c = this.makeControl(name, owner, bag.pop());
      crew.controls.set(c.id, c);
      ids.push(c.id);
    }
    return ids;
  }

  // New sector: fresh panels for everyone, a new goal and this sector's events.
  setupSector(crew, sector, now) {
    crew.sector = sector;
    crew.progress = 0;
    crew.controls.clear();
    crew.panels.clear();
    crew.orders.clear();
    crew.nextOrderAt.clear();
    crew.event = null;
    const size = this.panelSize(sector);
    const active = crew.members.filter((m) => m.connected);
    for (const m of active) crew.panels.set(m.id, this.makePanel(crew, m.id, size));
    for (const m of crew.members) if (!crew.panels.has(m.id)) crew.panels.set(m.id, []);
    crew.goal = this.goalFor(crew, sector);
    crew.sectorStart = now;
    // Events trigger at progress milestones (or after a while, if the crew is stuck).
    const count = this.eventCount(sector);
    crew.eventPlan = Array.from({ length: count }, (_, i) => ({
      at: (i + 0.6) / (count + 0.6),
      latest: now + 22_000 + i * 18_000,
    }));
    crew.eventCooldown = now + 6000;
    crew.members.forEach((m, i) => crew.nextOrderAt.set(m.id, now + 400 + i * 350 + this.rand() * 500));
  }

  nextEventType(crew) {
    // A bag, so every event type shows up before any repeats.
    if (!crew.eventBag.length) crew.eventBag = shuffled(EVENT_TYPES, this.rand);
    return crew.eventBag.pop();
  }

  // ---------- Orders ----------
  orderText(c, target, rand) {
    const name = c.name;
    let pre;
    let post = '';
    if (c.type === 'toggle') {
      pre = pick(target ? ['Turn on', 'Switch on'] : ['Turn off', 'Switch off'], rand);
    } else {
      pre = pick(VERBS[c.type], rand);
      if (c.type === 'slider' || c.type === 'dial') post = `to ${target}`;
      if (c.type === 'multi') post = `to ${c.options[target]}`;
    }
    pre = `${pre} the`;
    return { pre, name, post, text: `${pre} ${name}${post ? ` ${post}` : ''}` };
  }

  // A target the control is not already at (orders are never already true).
  pickTarget(c) {
    if (c.type === 'button' || c.type === 'lever') return null;
    if (c.type === 'toggle') return !c.value;
    const values = c.type === 'multi'
      ? c.options.map((_, i) => i)
      : Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i);
    return pick(values.filter((v) => v !== c.value), this.rand);
  }

  // Give `holderId` a new order. ~75% of the time the control is on someone else's panel.
  issueOrder(crew, holderId, now) {
    const busy = new Set([...crew.orders.values()].map((o) => o.controlId));
    const live = new Set(this.connectedMembers(crew).map((m) => m.id));
    const free = [...crew.controls.values()].filter((c) => !busy.has(c.id) && live.has(c.owner));
    const others = free.filter((c) => c.owner !== holderId);
    const mine = free.filter((c) => c.owner === holderId);
    let pool = others.length && (this.rand() < OTHER_BIAS || !mine.length) ? others : mine;
    if (!pool.length) pool = others;
    if (!pool.length) return null;
    const c = pick(pool, this.rand);
    const target = this.pickTarget(c);
    const duration = Math.round(this.orderTime(crew.sector) * 1000);
    const order = {
      id: this.nextOrderId++,
      controlId: c.id,
      holder: holderId,
      target,
      ...this.orderText(c, target, this.rand),
      issued: now,
      duration,
      expires: now + duration,
    };
    crew.orders.set(holderId, order);
    crew.nextOrderAt.delete(holderId);
    return order;
  }

  satisfied(order, c, pressed) {
    if (order.controlId !== c.id) return false;
    if (c.type === 'button' || c.type === 'lever') return pressed;
    return c.value === order.target;
  }

  completeOrder(crew, order, byId, now) {
    crew.orders.delete(order.holder);
    crew.nextOrderAt.set(order.holder, now + ORDER_GAP_MS[0] + this.rand() * (ORDER_GAP_MS[1] - ORDER_GAP_MS[0]));
    crew.progress = Math.min(crew.goal, crew.progress + 1);
    crew.completed++;
    this.statsFor(byId).done++;
    if (byId !== order.holder) this.statsFor(order.holder).mine++;
    this.fx(crew, { kind: 'done', orderId: order.id, holder: order.holder, by: byId, control: order.controlId, text: order.text });
    if (crew.progress >= crew.goal) this.beginWarp(crew, now);
  }

  expireOrder(crew, order, now) {
    crew.orders.delete(order.holder);
    crew.nextOrderAt.set(order.holder, now + MISS_GAP_MS);
    crew.missed++;
    this.statsFor(order.holder).missed++;
    const dmg = this.damage(crew.sector);
    this.fx(crew, { kind: 'expired', orderId: order.id, holder: order.holder, text: order.text, damage: dmg });
    this.hurt(crew, dmg, now);
  }

  // Orders that point at controls which no longer exist (or have nobody to operate them) are
  // dropped without penalty and replaced shortly.
  dropStaleOrders(crew, now) {
    const live = new Set(this.connectedMembers(crew).map((m) => m.id));
    for (const o of [...crew.orders.values()]) {
      const c = crew.controls.get(o.controlId);
      if (!c || !live.has(c.owner) || !live.has(o.holder)) {
        crew.orders.delete(o.holder);
        if (live.has(o.holder)) crew.nextOrderAt.set(o.holder, now + 600);
      }
    }
  }

  hurt(crew, amount, now) {
    crew.hull = Math.max(0, crew.hull - amount);
    this.markCrew(crew);
    if (crew.hull <= 0) this.destroy(crew, now);
  }

  // ---------- Sector flow ----------
  beginWarp(crew, now) {
    crew.orders.clear();
    crew.nextOrderAt.clear();
    crew.event = null;
    const last = this.sectors && crew.sector >= this.sectors;
    if (last) {
      crew.status = 'done';
      crew.finishedAt = now;
      crew.endedAt = now;
      this.fx(crew, { kind: 'complete', sector: crew.sector });
      this.checkEnd(now);
    } else {
      crew.status = 'warping';
      crew.warpEnds = now + WARP_MS;
      crew.hull = Math.min(HULL_MAX, crew.hull + WARP_REPAIR);
      this.fx(crew, { kind: 'warp', sector: crew.sector + 1, repair: WARP_REPAIR });
    }
    this.markCrew(crew);
  }

  destroy(crew, now) {
    if (crew.status === 'destroyed') return;
    crew.status = 'destroyed';
    crew.endedAt = now;
    crew.orders.clear();
    crew.nextOrderAt.clear();
    crew.event = null;
    this.fx(crew, { kind: 'destroyed', sector: crew.sector });
    this.room.systemMessage(`💥 ${crew.ship} (${crew.name}) was destroyed in sector ${crew.sector}`);
    this.markCrew(crew);
    this.checkEnd(now);
  }

  flying(crew) {
    return crew.status === 'flying' || crew.status === 'warping';
  }

  checkEnd(now) {
    if (this.phase === 'over') return;
    const active = this.crews.filter((c) => this.flying(c));
    if (!active.length) {
      this.endAt = this.endAt || now + END_DELAY_MS;
      return;
    }
    // Someone finished every sector: the rest get a last minute to catch up.
    if (!this.finalAt && this.crews.some((c) => c.status === 'done')) {
      this.finalAt = now + FINAL_COUNTDOWN_MS;
      this.fleetDirty = true;
      for (const c of this.crews) this.markCrew(c);
    }
  }

  // ---------- Events ----------
  startEvent(crew, type, now) {
    const ms = type === 'asteroid' ? this.cfg.mashMs : EVENTS[type].ms;
    const ev = { type, started: now, ends: now + ms, duration: ms };
    if (type === 'asteroid') {
      ev.quota = this.cfg.mash;
      ev.mash = new Map();
    }
    if (type === 'blackout') {
      for (const o of crew.orders.values()) o.expires += BLACKOUT_GRACE_MS;
    }
    if (type === 'shuffle') {
      for (const [id, panel] of crew.panels) {
        if (panel.length < 2) continue;
        let next = shuffled(panel, this.rand);
        for (let i = 0; i < 5 && next.every((c, j) => c === panel[j]); i++) next = shuffled(panel, this.rand);
        crew.panels.set(id, next);
      }
    }
    crew.event = ev;
    this.fx(crew, { kind: 'event', type, duration: ms });
    this.markCrew(crew);
  }

  endEvent(crew, now, success = null) {
    const ev = crew.event;
    if (!ev) return;
    crew.event = null;
    crew.eventCooldown = now + 7000;
    if (ev.type === 'asteroid') {
      // The panel was locked while mashing: give the order timers that time back.
      const paused = now - ev.started;
      for (const o of crew.orders.values()) o.expires += paused;
      for (const [id, t] of crew.nextOrderAt) crew.nextOrderAt.set(id, t + paused);
      const ok = success ?? false;
      this.fx(crew, { kind: 'eventEnd', type: ev.type, success: ok, damage: ok ? 0 : this.cfg.asteroid });
      if (ok) {
        crew.progress = Math.min(crew.goal - 1, crew.progress + 1);
      } else {
        this.hurt(crew, this.cfg.asteroid, now);
      }
    } else {
      this.fx(crew, { kind: 'eventEnd', type: ev.type, success: true });
    }
    this.markCrew(crew);
  }

  // Everyone on board has mashed their share.
  asteroidCleared(crew) {
    const ev = crew.event;
    const live = this.connectedMembers(crew);
    return live.length > 0 && live.every((m) => (ev.mash.get(m.id) || 0) >= ev.quota);
  }

  // ---------- Main loop ----------
  tick() {
    if (this.stopped) return;
    const now = this.clock();
    if (this.phase === 'briefing' && now >= this.briefingEnds) {
      this.phase = 'flying';
      for (const crew of this.crews) {
        crew.sectorStart = now;
        crew.eventCooldown = now + 6000;
        crew.eventPlan.forEach((e, i) => { e.latest = now + 22_000 + i * 18_000; });
        crew.members.forEach((m, i) => crew.nextOrderAt.set(m.id, now + 300 + i * 300 + this.rand() * 400));
        this.markCrew(crew);
      }
      this.fleetDirty = true;
    }
    if (this.phase === 'flying') {
      for (const crew of this.crews) this.tickCrew(crew, now);
    }
    if (this.endAt && now >= this.endAt) { this.finish(); return; }
    if (this.finalAt && now >= this.finalAt) { this.finish(); return; }
    if (this.fleetDirty && now - this.lastFleet >= FLEET_MS) {
      this.fleetDirty = false;
      this.lastFleet = now;
      this.room.emit('game:cr:fleet', { fleet: this.fleet(), finalIn: this.finalAt ? Math.max(0, this.finalAt - now) : null });
    }
  }

  tickCrew(crew, now) {
    if (crew.status === 'warping') {
      if (now >= crew.warpEnds) {
        crew.status = 'flying';
        this.setupSector(crew, crew.sector + 1, now);
        this.fx(crew, { kind: 'sector', sector: crew.sector });
        this.markCrew(crew);
      }
      return;
    }
    if (crew.status !== 'flying') return;
    const ev = crew.event;
    if (ev && now >= ev.ends) this.endEvent(crew, now, ev.type === 'asteroid' ? this.asteroidCleared(crew) : true);
    if (crew.status !== 'flying') return;
    // While deflecting asteroids the panel is locked, so the order clocks are paused.
    if (crew.event?.type === 'asteroid') return;
    for (const o of [...crew.orders.values()]) {
      if (now >= o.expires) this.expireOrder(crew, o, now);
      if (crew.status !== 'flying') return;
    }
    for (const m of this.connectedMembers(crew)) {
      if (crew.orders.has(m.id)) continue;
      const at = crew.nextOrderAt.get(m.id);
      if (at === undefined) crew.nextOrderAt.set(m.id, now + 800);
      else if (now >= at && this.issueOrder(crew, m.id, now)) this.markCrew(crew);
    }
    // Next event due?
    const next = crew.eventPlan[0];
    if (next && !crew.event && now >= crew.eventCooldown && (crew.progress / crew.goal >= next.at || now >= next.latest)) {
      crew.eventPlan.shift();
      this.startEvent(crew, this.nextEventType(crew), now);
    }
  }

  // ---------- Client messages ----------
  onEvent(player, event, data, reply) {
    let res;
    switch (event) {
      case 'act': res = this.act(player, data); break;
      case 'mash': res = this.mash(player); break;
      case 'relay': res = this.relay(player); break;
      case 'finish':
        if (!this.room.isHost(player)) { res = { ok: false, error: 'Only the host can end the flight' }; break; }
        this.finish();
        res = { ok: true };
        break;
      default: res = { ok: false, error: 'Unknown action' };
    }
    reply(res);
  }

  allow(playerId, kind, limit) {
    const now = this.clock();
    let r = this.rate.get(playerId);
    if (!r) { r = {}; this.rate.set(playerId, r); }
    const slot = r[kind] || (r[kind] = { t: now, n: 0 });
    if (now - slot.t >= 1000) { slot.t = now; slot.n = 0; }
    slot.n++;
    return slot.n <= limit;
  }

  // Operate one of your own controls: { c: controlId, v: value }.
  act(player, data) {
    // Controls can be tried out during the briefing; orders start after it.
    if (this.phase === 'over') return { ok: false, error: 'The flight is over' };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Bad action' };
    const crew = this.crewOf(player.id);
    if (!crew) return { ok: false, error: 'You are not on a crew' };
    if (crew.status !== 'flying') return { ok: false, error: 'Your ship is not flying' };
    if (crew.event?.type === 'asteroid') return { ok: false, error: 'Deflect the asteroids first!' };
    if (!this.allow(player.id, 'act', ACTIONS_PER_SEC)) return { ok: false, error: 'Too fast' };
    if (typeof data.c !== 'string') return { ok: false, error: 'Unknown control' };
    const c = crew.controls.get(data.c);
    if (!c || c.owner !== player.id) return { ok: false, error: 'Not your control' };
    const v = data.v;
    let pressed = false;
    switch (c.type) {
      case 'button':
      case 'lever':
        pressed = true;
        break;
      case 'toggle':
        if (typeof v !== 'boolean') return { ok: false, error: 'Bad value' };
        if (v === c.value) return { ok: true, done: 0 };
        c.value = v;
        break;
      case 'slider':
      case 'dial':
        if (!Number.isInteger(v) || v < c.min || v > c.max) return { ok: false, error: 'Bad value' };
        if (v === c.value) return { ok: true, done: 0 };
        c.value = v;
        break;
      case 'multi':
        if (!Number.isInteger(v) || v < 0 || v >= c.options.length) return { ok: false, error: 'Bad value' };
        if (v === c.value) return { ok: true, done: 0 };
        c.value = v;
        break;
      default:
        return { ok: false, error: 'Bad control' };
    }
    const now = this.clock();
    const hits = [...crew.orders.values()].filter((o) => this.satisfied(o, c, pressed));
    for (const o of hits) {
      if (crew.status !== 'flying') break;
      this.completeOrder(crew, o, player.id, now);
    }
    if (!hits.length && this.phase === 'flying') this.statsFor(player.id).panic++;
    this.markCrew(crew);
    return { ok: true, done: hits.length };
  }

  mash(player) {
    const crew = this.crewOf(player.id);
    const ev = crew?.event;
    if (!crew || crew.status !== 'flying' || ev?.type !== 'asteroid') return { ok: false, error: 'Nothing to deflect' };
    if (!this.allow(player.id, 'mash', MASH_PER_SEC)) return { ok: false, error: 'Too fast' };
    ev.mash.set(player.id, Math.min(ev.quota * 3, (ev.mash.get(player.id) || 0) + 1));
    if (this.asteroidCleared(crew)) this.endEvent(crew, this.clock(), true);
    this.markCrew(crew);
    return { ok: true };
  }

  // Relay comms: flash your order on your crew's screens.
  relay(player) {
    if (this.comms !== 'relay') return { ok: false, error: 'Relay comms are off: shout it!' };
    const crew = this.crewOf(player.id);
    if (!crew || crew.status !== 'flying') return { ok: false, error: 'Your ship is not flying' };
    const order = crew.orders.get(player.id);
    if (!order) return { ok: false, error: 'No order to relay' };
    const now = this.clock();
    if (now - (this.relayAt.get(player.id) || -Infinity) < RELAY_COOLDOWN_MS) return { ok: false, error: 'Relay is recharging' };
    this.relayAt.set(player.id, now);
    this.statsFor(player.id).relays++;
    order.relayed = true;
    const p = this.room.players.get(player.id);
    this.fx(crew, { kind: 'relay', from: player.id, name: p?.name, avatar: p?.avatar ?? 0, orderId: order.id, pre: order.pre, control: order.name, post: order.post, text: order.text, ms: RELAY_SHOW_MS });
    return { ok: true };
  }

  // ---------- Players coming and going ----------
  // A player dropped: their order is dropped and their controls move to crewmates.
  onPlayerDisconnect(player) {
    const crew = this.crewOf(player.id);
    if (!crew) return;
    const m = this.member(crew, player.id);
    if (m) m.connected = false;
    const now = this.clock();
    if (this.flying(crew)) {
      crew.orders.delete(player.id);
      crew.nextOrderAt.delete(player.id);
      this.redistribute(crew, player.id, now);
      if (crew.event?.type === 'asteroid' && this.asteroidCleared(crew)) this.endEvent(crew, now, true);
    }
    this.fleetDirty = true;
    this.markCrew(crew);
  }

  redistribute(crew, fromId, now) {
    const ids = crew.panels.get(fromId) || [];
    const receivers = this.connectedMembers(crew).filter((m) => m.id !== fromId);
    if (!receivers.length || !ids.length) { this.dropStaleOrders(crew, now); return; }
    crew.panels.set(fromId, []);
    for (const id of ids) {
      const c = crew.controls.get(id);
      if (!c) continue;
      const r = receivers.map((m) => m.id).sort((a, b) => crew.panels.get(a).length - crew.panels.get(b).length)[0];
      if (crew.panels.get(r).length >= MAX_PANEL) {
        crew.controls.delete(id); // no room: the control goes offline
        continue;
      }
      c.owner = r;
      crew.panels.get(r).push(id);
    }
    this.dropStaleOrders(crew, now);
  }

  // Back again: your own controls come home, topped up to a full panel.
  onPlayerReconnect(player) {
    const crew = this.crewOf(player.id);
    // Offline when the flight started: they take a free seat now, like anyone joining.
    if (!crew) { this.onPlayerJoin(player); return; }
    const m = this.member(crew, player.id);
    if (!m) return;
    m.connected = true;
    const now = this.clock();
    if (crew.status === 'flying') this.restorePanel(crew, player.id, now);
    this.fleetDirty = true;
    this.markCrew(crew);
  }

  restorePanel(crew, id, now) {
    const panel = crew.panels.get(id) || [];
    crew.panels.set(id, panel);
    for (const c of crew.controls.values()) {
      if (c.home !== id || c.owner === id) continue;
      const from = crew.panels.get(c.owner);
      if (from) crew.panels.set(c.owner, from.filter((x) => x !== c.id));
      c.owner = id;
      panel.push(c.id);
    }
    const missing = this.panelSize(crew.sector) - panel.length;
    if (missing > 0) panel.push(...this.makePanel(crew, id, missing));
    if (!crew.orders.has(id)) crew.nextOrderAt.set(id, now + 1500);
    this.dropStaleOrders(crew, now);
  }

  // Someone new joined the room mid-game: they hop aboard a crew with a free seat.
  onPlayerJoin(player) {
    if (this.phase === 'over' || this.crewOf(player.id)) return;
    const open = this.crews.filter((c) => this.flying(c) && c.members.length < MAX_CREW);
    const teamMode = this.room.settings.teamMode;
    const smallest = [...open].sort((a, b) => a.members.length - b.members.length)[0];
    // In teams, their own team's ship; if their team has none flying, the ship with most room.
    const crew = (teamMode && open.find((c) => c.id === player.team)) || smallest;
    if (!crew) return; // spectates
    if (teamMode && player.team !== crew.id) player.team = crew.id;
    crew.members.push({ id: player.id, connected: true });
    this.crewByPlayer.set(player.id, crew);
    this.statsFor(player.id);
    crew.panels.set(player.id, []);
    const now = this.clock();
    if (crew.status === 'flying') {
      crew.panels.set(player.id, this.makePanel(crew, player.id, this.panelSize(crew.sector)));
      crew.nextOrderAt.set(player.id, now + 3000);
    }
    this.room.systemMessage(`🚀 ${player.name} boarded the ${crew.ship}`);
    this.fleetDirty = true;
    this.markCrew(crew);
  }

  // Gone for good (left the room or never came back).
  onPlayerLeave(player) {
    const crew = this.crewOf(player.id);
    if (!crew) return;
    const now = this.clock();
    if (this.flying(crew)) {
      crew.orders.delete(player.id);
      this.redistribute(crew, player.id, now);
    }
    crew.members = crew.members.filter((m) => m.id !== player.id);
    crew.panels.delete(player.id);
    crew.nextOrderAt.delete(player.id);
    for (const c of crew.controls.values()) if (c.home === player.id) c.home = c.owner;
    if (!crew.members.length && this.flying(crew)) {
      crew.status = 'abandoned';
      crew.endedAt = now;
      crew.orders.clear();
      crew.event = null;
      this.checkEnd(now);
    }
    this.fleetDirty = true;
    this.markCrew(crew);
  }

  // ---------- Output ----------
  fx(crew, payload) {
    for (const m of crew.members) if (m.connected) this.room.emitTo(m.id, 'game:cr:fx', payload);
  }

  markCrew(crew) {
    this.dirty.add(crew);
    this.fleetDirty = true;
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.flushTimer = null;
    if (this.stopped) return;
    const crews = [...this.dirty];
    this.dirty.clear();
    for (const crew of crews) {
      for (const m of crew.members) {
        const p = this.room.players.get(m.id);
        if (p?.connected) this.room.emitTo(m.id, 'game:cr:state', this.stateFor(p));
      }
    }
  }

  fleet() {
    return this.crews.map((c) => ({
      id: c.id,
      name: c.name,
      ship: c.ship,
      color: c.color,
      status: c.status,
      sector: c.sector,
      progress: c.goal ? c.progress / c.goal : 0,
      hull: c.hull,
      crew: c.members.length,
      online: c.members.filter((m) => m.connected).length,
      event: c.event?.type || null,
    }));
  }

  crewPublic(crew, now) {
    const players = this.room.players;
    const ev = crew.event;
    return {
      id: crew.id,
      name: crew.name,
      ship: crew.ship,
      color: crew.color,
      status: crew.status,
      sector: crew.sector,
      progress: crew.progress,
      goal: crew.goal,
      hull: crew.hull,
      warpIn: crew.status === 'warping' ? Math.max(0, crew.warpEnds - now) : 0,
      members: crew.members.map((m) => {
        const p = players.get(m.id);
        return { id: m.id, name: p?.name || 'Crew', avatar: p?.avatar ?? 0, connected: m.connected && !!p?.connected, controls: (crew.panels.get(m.id) || []).length };
      }),
      event: ev ? {
        type: ev.type,
        endsIn: Math.max(0, ev.ends - now),
        duration: ev.duration,
        quota: ev.quota,
        mash: ev.mash ? Object.fromEntries(ev.mash) : undefined,
      } : null,
    };
  }

  stateFor(player) {
    const now = this.clock();
    const crew = this.crewOf(player.id);
    const base = {
      phase: this.phase,
      comms: this.comms,
      difficulty: this.difficulty,
      sectors: this.sectors,
      briefingIn: this.phase === 'briefing' ? Math.max(0, this.briefingEnds - now) : 0,
      finalIn: this.finalAt ? Math.max(0, this.finalAt - now) : null,
      fleet: this.fleet(),
      orderTime: crew ? Math.round(this.orderTime(crew.sector) * 1000) : 0,
    };
    if (!crew) return { ...base, crew: null, panel: [], order: null, spectating: true };
    const order = crew.orders.get(player.id);
    const panel = (crew.panels.get(player.id) || []).map((id) => crew.controls.get(id)).filter(Boolean).map((c) => ({
      id: c.id, name: c.name, type: c.type, value: c.value, min: c.min, max: c.max, options: c.options,
    }));
    return {
      ...base,
      crew: this.crewPublic(crew, now),
      panel,
      order: order ? {
        id: order.id, pre: order.pre, name: order.name, post: order.post, text: order.text,
        expiresIn: Math.max(0, order.expires - now), duration: order.duration, relayed: !!order.relayed,
      } : null,
      spectating: !this.flying(crew) || !this.member(crew, player.id)?.connected,
    };
  }

  snapshotFor(player) {
    return { mode: 'controlroom', ...this.stateFor(player) };
  }

  // ---------- Results ----------
  // Finished crews first (fastest first), then the furthest sector, progress, hull, and finally
  // whoever survived longest.
  ranking(now = this.clock()) {
    const prog = (c) => (c.status === 'done' ? 1 : c.goal ? c.progress / c.goal : 0);
    const done = (c) => (c.status === 'done' ? 1 : 0);
    return [...this.crews].sort((a, b) => done(b) - done(a)
      || (done(a) && done(b) ? a.finishedAt - b.finishedAt : 0)
      || b.sector - a.sector
      || prog(b) - prog(a)
      || b.hull - a.hull
      || (b.endedAt || now) - (a.endedAt || now));
  }

  finish() {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.stop();
    const now = this.clock();
    const players = this.room.players;
    const ranked = this.ranking(now);
    const cleared = (c) => (c.status === 'done' ? c.sector : c.sector - 1);
    const crews = ranked.map((c, i) => ({
      id: c.id,
      rank: i + 1,
      name: c.name,
      ship: c.ship,
      color: c.color,
      status: c.status === 'warping' ? 'flying' : c.status,
      sector: c.sector,
      cleared: cleared(c),
      progress: c.status === 'done' ? 1 : c.goal ? c.progress / c.goal : 0,
      hull: c.hull,
      time: (c.endedAt || now) - c.startedAt,
      completed: c.completed,
      missed: c.missed,
      members: c.members.map((m) => ({ id: m.id, name: players.get(m.id)?.name || 'Crew', avatar: players.get(m.id)?.avatar ?? 0 })),
    }));
    const results = [...this.stats.entries()]
      .filter(([id]) => players.has(id))
      .map(([id, s]) => {
        const p = players.get(id);
        const crew = this.crewOf(id);
        return {
          id, name: p.name, color: p.color, avatar: p.avatar, team: crew ? crew.id : p.team, crew: crew ? crew.id : null,
          score: s.done * 10 + s.mine * 5, done: s.done, mine: s.mine, panic: s.panic, relays: s.relays, missed: s.missed,
        };
      })
      .sort((a, b) => b.score - a.score);
    const best = (key) => {
      const top = [...results].sort((a, b) => b[key] - a[key])[0];
      return top && top[key] > 0 ? { id: top.id, name: top.name, avatar: top.avatar, value: top[key] } : null;
    };
    const awards = [
      { key: 'done', title: 'Hands of Lightning', desc: 'orders completed', one: 'order completed', who: best('done') },
      { key: 'mine', title: 'Loudest Voice', desc: 'of their orders done by crewmates', who: best('mine') },
      { key: 'panic', title: 'Panic Button', desc: 'presses that did nothing', one: 'press that did nothing', who: best('panic') },
      ...(this.comms === 'relay' ? [{ key: 'relays', title: 'Radio Star', desc: 'orders relayed', one: 'order relayed', who: best('relays') }] : []),
    ].filter((a) => a.who);
    this.room.finishGame(this, {
      crews,
      players: results,
      teams: crews.map((c) => ({ id: c.id, name: `${c.name} · ${c.ship}`, color: c.color, score: c.cleared, members: c.members.length })),
      awards,
      sectors: this.sectors,
      difficulty: this.difficulty,
      comms: this.comms,
    });
  }
}

module.exports = { ControlRoom, planCrews, crewSizes, makeNames, DIFFICULTY, EVENT_TYPES, MAX_PANEL, MAX_CREW, MIN_CREW };
