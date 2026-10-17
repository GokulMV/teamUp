// Layered arenas: floors at several heights (kart-layers.js) and the kart physics on them (kart-core.js).
const { test } = require('node:test');
const assert = require('node:assert');
const K = require('../public/js/shared/kart-core');

const L = K.Layers;

// A small test bed: a deck you can drive over and under, a ramp up to it, a jump pad, a bumper,
// a pit into the void, a low shelf to bonk your head on, a lava pool up on a ledge, and a moat
// with a drawbridge over it.
const BED = {
  id: 'testbed', size: 2000, deathZ: -300,
  ground: { z: 0, holes: [{ x0: 1300, y0: 800, x1: 1600, y1: 1100 }, { x0: 200, y0: 1700, x1: 1800, y1: 1800 }] },
  blocks: [
    { x0: 600, y0: 600, x1: 1000, y1: 800, z0: 70, z1: 90, kind: 'wood' }, // the deck
    { x0: 1100, y0: 200, x1: 1300, y1: 400, z0: 30, z1: 50 }, // a low shelf (too low to drive under)
    { x0: 200, y0: 200, x1: 500, y1: 400, z0: 0, z1: 60 }, // a ledge with a lava pool on top
  ],
  ramps: [{ x0: 300, y0: 600, x1: 600, y1: 800, z0: 0, z1: 90, dir: 'x+' }],
  hazards: [{ x: 350, y: 300, r: 60, z: 60, kind: 'lava' }],
  pads: [{ x: 300, y: 1300, z: 0, r: 40, to: [800, 700, 90], t: 1 }],
  bumpers: [{ x: 1250, y: 1350, z: 0, r: 30 }],
  movers: [
    { type: 'sweeper', x: 1700, y: 400, z: 0, len: 220, speed: 1.2 },
    { type: 'drawbridge', x0: 900, y0: 1700, x1: 1000, y1: 1800, z: 0, hinge: 'y0', period: 20, at: 10, move: 2, hold: 4 },
  ],
  liquid: { kind: 'water', z: -40 },
  spawns: [{ x: 150, y: 150, z: 0, angle: 0 }, { x: 800, y: 700, z: 90, angle: 0 }],
};
const bed = () => L.makeLayeredArena(BED);
const kartAt = (x, y, z, angle = 0) => ({ x, y, z, angle, heading: angle, speed: 0, air: 0, vz: 0, boost: 0, spin: 0, drift: 0 });
const UP = { up: true };
function drive(map, k, input, seconds, t0 = 0, each) {
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    K.stepKart(k, input, 1 / 30, map, { t: t0 + i / 30 });
    if (each) each(k, i);
  }
  return k;
}

test('layers: the ground is the arena minus its holes, in a few boxes', () => {
  const blocks = L.groundBlocks(BED);
  const area = blocks.reduce((a, b) => a + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  assert.strictEqual(area, 2000 * 2000 - 300 * 300 - 1600 * 100);
  assert.ok(blocks.length <= 8, `${blocks.length} boxes`);
  const map = bed();
  assert.strictEqual(map.floorAt(1450, 950, 1000), -Infinity, 'the pit has no floor');
  assert.strictEqual(map.floorAt(100, 100, 1000), 0);
  assert.strictEqual(map.floorAt(800, 700, 1000), 90, 'on top of the deck');
  assert.strictEqual(map.floorAt(800, 700, 10), 0, 'under the deck');
  assert.strictEqual(map.floorAt(450, 700, 1000), 45, 'half way up the ramp');
});

test('layers: drive up a ramp onto a deck, along it, and off the end onto the ground', () => {
  const map = bed();
  const k = kartAt(150, 700, 0);
  let top = 0;
  drive(map, k, UP, 2.4, 0, (kk) => { if (kk.x > 300 && kk.x < 600) assert.ok(Math.abs(kk.z - map.floorAt(kk.x, kk.y, 1000)) < 2, `on the ramp at x ${kk.x.toFixed(0)}`); top = Math.max(top, kk.z); });
  assert.ok(k.x > 650 && k.x < 1000, `on the deck (x ${k.x.toFixed(0)})`);
  assert.strictEqual(k.z, 90);
  assert.ok(top < 95, 'no catapult off the top of the ramp');
  let flew = 0;
  drive(map, k, UP, 1, 0, (kk) => { flew = Math.max(flew, kk.air); });
  assert.ok(flew > 40, 'fell off the end of the deck');
  assert.strictEqual(k.z, 0, 'and landed on the ground');
  assert.ok(k.landed > 200, 'with a thump');
});

test('layers: a kart drives under the deck while another drives over it', () => {
  const map = bed();
  const under = kartAt(800, 450, 0, Math.PI / 2);
  const over = kartAt(800, 610, 90, Math.PI / 2);
  under.speed = 300;
  over.speed = 150;
  for (let i = 0; i < 18; i++) {
    K.stepKart(under, UP, 1 / 30, map, { t: 0 });
    K.stepKart(over, { up: false }, 1 / 30, map, { t: 0 });
    assert.strictEqual(under.z, 0, 'under the deck: on the ground');
    assert.strictEqual(over.z, 90, 'on the deck');
  }
  assert.ok(under.y > 650 && under.y < 800, 'right under it');
});

test('layers: walls are where a floor is too high to step onto; ceilings stop hops', () => {
  const map = bed();
  // Along the side of the ramp at its tall end: a wall.
  const k = kartAt(560, 950, 0, -Math.PI / 2);
  drive(map, k, UP, 1.5);
  assert.ok(k.y >= 800 + L.KART_R - 0.5 && k.z === 0, `stopped by the ramp's side (y ${k.y.toFixed(1)}, z ${k.z})`);
  // At its low end the side is only a kerb: up you go.
  const low = kartAt(320, 900, 0, -Math.PI / 2);
  drive(map, low, UP, 0.8);
  assert.ok(low.y < 790 && low.z > 0, `climbed on from the side (y ${low.y.toFixed(0)}, z ${low.z.toFixed(1)})`);
  // Under a shelf 30 up a kart can't fit (it's a wall), and a hop under the deck (70 up) stays below it.
  const shelf = kartAt(1050, 300, 0, 0);
  drive(map, shelf, UP, 1);
  assert.ok(shelf.x <= 1100 - L.KART_R + 0.5, 'the low shelf is a wall');
  const hop = kartAt(800, 700, 0);
  let peak = 0;
  for (let i = 0; i < 20; i++) { K.stepKart(hop, { drift: i === 0 }, 1 / 30, map, { t: 0 }); peak = Math.max(peak, hop.z); }
  assert.ok(peak > 15 && peak + L.KART_H <= 70, `hopped ${peak.toFixed(1)} under a 70-high deck`);
  const deckOver = L.makeLayeredArena({ ...BED, blocks: [{ x0: 600, y0: 600, x1: 1000, y1: 800, z0: 44, z1: 60 }] });
  const bonk = kartAt(800, 700, 0);
  peak = 0;
  for (let i = 0; i < 20; i++) { K.stepKart(bonk, { drift: i === 0 }, 1 / 30, deckOver, { t: 0 }); peak = Math.max(peak, bonk.z); }
  assert.ok(peak > 5 && peak + L.KART_H <= 44.01, `bonked its head (peak ${peak.toFixed(1)})`);
});

test('layers: a jump pad flies you to its landing spot', () => {
  const map = bed();
  const k = kartAt(300, 1450, 0, -Math.PI / 2);
  let launched = false;
  let landedAt = null;
  drive(map, k, UP, 2, 0, (kk) => {
    if (kk.padded) { launched = true; kk.padded = 0; }
    if (launched && !landedAt && !(kk.air > 0)) landedAt = { x: kk.x, y: kk.y, z: kk.z };
  });
  assert.ok(launched, 'launched');
  assert.ok(landedAt, 'landed');
  assert.strictEqual(landedAt.z, 90, 'on the deck');
  assert.ok(Math.hypot(landedAt.x - 800, landedAt.y - 700) < 40, `near the target (${landedAt.x.toFixed(0)}, ${landedAt.y.toFixed(0)})`);
  assert.ok(k.speed <= K.PHYS.maxSpeed + 1, 'back to normal speed after touching down');
});

test('layers: the void, the moat and a lava pool are deadly (only on their own level)', () => {
  const map = bed();
  const pit = kartAt(1450, 650, 0, Math.PI / 2);
  drive(map, pit, UP, 1.6);
  assert.strictEqual(pit.lost, 'void', 'fell into the pit');
  const moat = kartAt(600, 1650, 0, Math.PI / 2);
  moat.speed = 200;
  drive(map, moat, UP, 0.6);
  assert.strictEqual(moat.lost, 'water', 'drove into the moat');
  const ledge = kartAt(350, 300, 60);
  drive(map, ledge, {}, 1 / 30);
  assert.strictEqual(ledge.lost, 'lava', 'parked in the lava on the ledge');
  assert.strictEqual(map.hazardAt(350, 300, 0), null, 'nothing at ground level under it');
});

test('layers: bumpers throw you back, sweepers sweep you along', () => {
  const map = bed();
  const k = kartAt(1050, 1350, 0);
  let bounced = false;
  drive(map, k, UP, 1, 0, (kk) => { if (kk.bumper) { bounced = true; kk.bumper = 0; } });
  assert.ok(bounced, 'hit the bumper');
  assert.ok(k.x < 1180, `thrown back (x ${k.x.toFixed(0)})`);
  const parked = kartAt(1700 + 120, 400, 0);
  drive(map, parked, {}, 3);
  assert.ok(Math.hypot(parked.x - 1700, parked.y - 400) > 220, 'pushed out of the sweep');
});

test('layers: a drawbridge is a floor when down, scoops karts back through the gate as it rises, and is a wall when up', () => {
  const map = bed();
  const m = map.movers.find((mm) => mm.type === 'drawbridge');
  assert.strictEqual(map.floorAt(950, 1750, 100, 0), 0, 'down: a floor over the moat');
  assert.strictEqual(map.floorAt(950, 1750, 100, 13), -Infinity, 'up: no floor');
  assert.strictEqual(map.bridgeAt(m, 5).rise, 5, 'rises again in 5 s');
  // Drive across while it's down.
  const k = kartAt(950, 1650, 0, Math.PI / 2);
  drive(map, k, UP, 0.8, 0);
  assert.ok(k.y > 1800 && k.z === 0 && !k.lost, `crossed (y ${k.y.toFixed(0)})`);
  // Parked on it as it starts to rise: lifted, then swept back off the hinge end, onto the land.
  for (const y of [1720, 1780, 1795]) {
    const p = kartAt(950, y, 0);
    let lifted = 0;
    drive(map, p, {}, 3, 9.5, (kk) => { lifted = Math.max(lifted, kk.z); });
    assert.ok(lifted > 5, `lifted (${lifted.toFixed(1)})`);
    assert.ok(!p.lost && p.y < 1700 && p.z === 0, `back on the gate side from ${y} (y ${p.y.toFixed(0)}, ${p.lost})`);
  }
  // Up: a wall across the gate.
  const w = kartAt(950, 1600, 0, Math.PI / 2);
  drive(map, w, UP, 1.2, 13);
  assert.ok(w.y < 1700 && !w.lost, `the raised bridge blocks the gate (y ${w.y.toFixed(0)})`);
});

test('layers: CPU navigation finds ways up ramps, off ledges and over jump pads', () => {
  const map = bed();
  const nav = map.nav;
  assert.ok(nav.count > 1000, `${nav.count} nodes`);
  const ground = nav.nodeAt(150, 150, 0);
  const deck = nav.nodeAt(800, 700, 90);
  const under = nav.nodeAt(800, 700, 0);
  assert.ok(ground >= 0 && deck >= 0 && under >= 0 && deck !== under, 'a node on the deck and one under it');
  assert.strictEqual(nav.zs[deck], 90);
  assert.strictEqual(nav.zs[under], 0);
  const up = nav.path(ground, deck);
  assert.ok(up, 'a way up');
  assert.ok(up.some((id) => nav.zs[id] > 20 && nav.zs[id] < 70), 'up the ramp');
  const down = nav.path(deck, under);
  assert.ok(down && down.length < 12, 'straight off the side');
  // Ledges are one way: nothing climbs straight back up the side of the deck.
  const side = nav.nodeAt(800, 830, 0);
  const edge = nav.nodeAt(800, 780, 90);
  assert.ok(!nav.adj[side].some(([b]) => b === edge), 'no edge up the side of the deck');
  assert.ok(nav.adj[edge].some(([b, , kind]) => kind === nav.DROP && nav.zs[b] === 0), 'but one down off it');
  // The jump pad is an edge to its landing spot.
  const pad = nav.nodeAt(300, 1300, 0);
  assert.ok(nav.adj[pad].some(([, , kind]) => kind === nav.FLY), 'the pad flies');
  // Nothing in the moat, the pit or the lava.
  assert.strictEqual(nav.nodeAt(1450, 950, 0, 0), -1);
  assert.ok(!nav.cellNodes[Math.floor(300 / 48) * nav.n + Math.floor(350 / 48)]?.some((id) => nav.zs[id] === 60), 'no node in the lava pool');
  // How far it is to drive to the deck, from everywhere at once: no further than the way A* found.
  const field = nav.toward(deck);
  const length = (p) => p.slice(1).reduce((sum, id, i) => sum + nav.adj[p[i]].find(([b]) => b === id)[1], 0);
  assert.strictEqual(field[deck], 0);
  assert.ok(field[ground] > 300 && field[ground] <= length(up) + 0.5, `${field[ground]} vs ${length(up)}`);
  assert.ok(field[under] <= length(nav.path(under, deck)) + 0.5);
  assert.strictEqual(nav.toward(deck), field, 'worked out once per spot');
});

test('layers: posts thinner than a kart are in the way but never a floor', () => {
  const map = L.makeLayeredArena({
    id: 'posts', size: 1000, ground: { z: 0 },
    cyls: [{ x: 500, y: 500, r: 16, z0: 0, z1: 46, kind: 'pillar' }, { x: 700, y: 500, r: 60, z0: 0, z1: 46 }],
  });
  assert.strictEqual(map.floorAt(500, 500, 100, 0), 0, 'nothing to stand on atop a post');
  assert.strictEqual(map.floorAt(700, 500, 100, 0), 46, 'a wide drum is a floor');
  assert.ok(map.walls(470, 500, 0, L.KART_R, null) > 0, 'the post is in the way');
  // Dropped onto the post, a kart slides off it to the ground.
  const k = drive(map, kartAt(500, 503, 70), {}, 1.5);
  assert.ok(Math.abs(k.z) < 0.5, `on the ground (${k.z})`);
  assert.ok(Math.hypot(k.x - 500, k.y - 500) >= 16 + L.KART_R - 1, 'beside the post');
  // And the CPU drivers never plan a stop on top of it.
  const nav = map.nav;
  assert.ok(!(nav.cellNodes[Math.floor(500 / 48) * nav.n + Math.floor(500 / 48)] || []).some((id) => nav.zs[id] > 1));
  assert.ok((nav.cellNodes[Math.floor(500 / 48) * nav.n + Math.floor(700 / 48)] || []).some((id) => nav.zs[id] === 46));
});

test('layers: the kart physics is deterministic (server and prediction agree)', () => {
  const map = bed();
  const inputs = [UP, { up: true, left: true }, { up: true, drift: true, right: true }, { down: true }, UP, { up: true, drift: true }];
  const run = () => {
    const k = kartAt(150, 700, 0);
    for (let i = 0; i < 240; i++) K.stepKart(k, inputs[Math.floor(i / 20) % inputs.length], 1 / 30, map, { t: i / 30 });
    return [k.x, k.y, k.z, k.angle, k.speed];
  };
  assert.deepStrictEqual(run(), run());
});

// ---------- the server's game on a layered arena ----------
const { KartBattle } = require('../server/games/kart');

function layeredBattle(n, def = BED) {
  const players = new Map();
  for (let i = 0; i < n; i++) players.set(`p${i}`, { id: `p${i}`, name: `P${i}`, color: '#ef4444', connected: true, team: 0 });
  const events = [];
  const room = {
    settings: { kartMode: 'arena', kartMap: 'colosseum', arenaTime: 60, kartItems: 'all', kartBots: 0 },
    players, connectedPlayers: [...players.values()], events,
    emit: (e, d) => events.push([e, d]), emitTo() {}, teamList: () => [], systemMessage() {},
    buildResults: () => ({ players: [] }), finishGame() {},
  };
  const game = new KartBattle(room);
  game.map = L.makeLayeredArena(def);
  game.layered = true;
  game.boxes = game.map.itemBoxes.map(() => 0);
  [...players.values()].forEach((p, slot) => game.addKart(p, slot));
  game.phase = 'racing';
  game.raceStart = 0;
  const kart = (i) => game.karts.get(`p${i}`);
  const calm = { speed: 0, shield: 0, invuln: 0, spin: 0, ghost: 0, star: 0, item: null, ammo: 0, roulette: 0, item2: null, ammo2: 0, roulette2: 0, air: 0, vz: 0, gz: null, kx: 0, ky: 0 };
  const place = (i, x, y, z, angle = 0) => Object.assign(kart(i), calm, { x, y, z, angle, heading: angle });
  const run = (seconds) => { for (let i = 0; i < Math.round(seconds * 30); i++) { game.time += 1 / 30; game.simulate(1 / 30); } };
  return { game, room, events, kart, place, run };
}

test('layers: knocked into the void, the kill goes to whoever hit you last', () => {
  const { game, events, kart, place, run } = layeredBattle(2, { ...BED, liquid: null }); // a dry pit
  const [a, b] = [kart(0), kart(1)];
  place(0, 1300, 500, 0, Math.PI / 2);
  place(1, 1450, 560, 0, Math.PI / 2);
  a.item = 'rocket'; a.ammo = 1;
  // Face B and fire.
  a.angle = a.heading = Math.atan2(b.y - a.y, b.x - a.x);
  game.useItem(a);
  run(0.3);
  assert.strictEqual(b.hp, 30, 'the rocket took 70');
  // B drives on into the pit.
  place(1, 1450, 760, 0, Math.PI / 2);
  b.hp = 30;
  b.lastAttacker = a.id;
  b.lastHit = game.time;
  b.input = { up: true };
  run(1.5);
  assert.ok(b.dead > 0 || b.deaths === 1, 'B fell to its doom');
  const kill = events.find(([e, d]) => e === 'game:kart:hit' && d.kill);
  assert.ok(kill, 'a kill was announced');
  assert.strictEqual(kill[1].kind, 'void');
  assert.strictEqual(kill[1].by, a.idx, 'credited to A');
  assert.strictEqual(a.kills, 1);
});

test('layers: rockets, mines and blasts stay on their own floor', () => {
  const { game, kart, place, run } = layeredBattle(3);
  const [a, under, over] = [kart(0), kart(1), kart(2)];
  // A on the deck fires along it; one rival right below on the ground, one further along the deck.
  place(0, 640, 700, 90, 0);
  place(1, 760, 700, 0, Math.PI / 2);
  place(2, 900, 700, 90, Math.PI / 2);
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a);
  run(0.4);
  assert.strictEqual(under.hp, 100, 'the kart underneath is untouched');
  assert.strictEqual(over.hp, 30, 'the one on the deck took the rocket');
  // A mine on the deck isn't set off by a kart driving underneath it.
  place(0, 800, 640, 90, Math.PI / 2);
  game.mines.push({ id: 999, x: 800, y: 700, z: 90, owner: a.id, arm: 0, life: 60 });
  place(1, 800, 620, 0, Math.PI / 2);
  under.input = { up: true };
  run(0.8);
  assert.strictEqual(game.mines.length, 1, 'still armed on the deck');
  assert.strictEqual(under.hp, 100);
  // A bomb lobbed off the deck comes down on the ground and hits a kart there.
  place(0, 980, 700, 90, 0);
  place(1, 1300, 700, 0, Math.PI / 2);
  place(2, 600, 1200, 0);
  a.input = {};
  under.input = {};
  a.item = 'bomb'; a.ammo = 1;
  game.useItem(a, { power: (300 - 26 - K.ITEM_FX.bomb.near) / (K.ITEM_FX.bomb.far - K.ITEM_FX.bomb.near) });
  run(1);
  assert.ok(under.hp < 100, `the bomb landed on the ground floor (hp ${under.hp})`);
});

test('layers: snapshots carry every height; respawns use the spawn point height', () => {
  const { game, events, kart, place, run } = layeredBattle(2);
  place(0, 800, 700, 90);
  place(1, 150, 150, 0);
  game.bananas.push({ id: 5, x: 820, y: 700, z: 90, life: 30, owner: 'p1', safe: 0 });
  game.broadcast();
  const [, state] = events.filter(([e]) => e === 'game:kart:state').pop();
  const row = state.k.find((r) => r[0] === kart(0).idx);
  assert.strictEqual(row.length, 21);
  assert.strictEqual(row[20], 90, 'kart height');
  assert.deepStrictEqual(state.b[0], [5, 820, 700, 90], 'banana height');
  kart(1).dead = 0.01;
  run(0.1);
  const b = kart(1);
  const spawn = game.map.spawns.find((s) => s.x === b.x && s.y === b.y);
  assert.ok(spawn, 'respawned on a spawn point');
  assert.strictEqual(b.z, spawn.z);
});

test('layers: CPU drivers on The Keep collect boxes, use the jump pads and keep out of the moat', () => {
  const Bots = require('../server/games/kart-bots');
  const events = [];
  const room = {
    settings: { kartMode: 'arena', kartMap: 'keep', arenaTime: 600, kartItems: 'none', kartBots: 6, kartBotSkill: 'normal' },
    players: new Map(), connectedPlayers: [], emit: (e, d) => events.push([e, d]), emitTo() {}, teamList: () => [], systemMessage() {},
    buildResults: () => ({ players: [] }), finishGame() {},
  };
  const game = new KartBattle(room);
  assert.strictEqual(game.map.id, 'keep');
  assert.ok(game.layered);
  Bots.makeBots(6, { skill: 'normal' }).forEach((b, i) => game.addKart(b, i));
  game.items = ['rocket']; // boxes to chase, nothing that knocks anyone in
  game.boxes = game.map.itemBoxes.map(() => 0);
  game.rollItem = () => null;
  game.phase = 'racing';
  game.raceStart = 0;
  let boxes = 0;
  let high = 0;
  for (let i = 0; i < 60 * 30; i++) {
    game.time += 1 / 30;
    const before = game.boxes.filter((b) => b > 0).length;
    game.simulate(1 / 30);
    boxes += Math.max(0, game.boxes.filter((b) => b > 0).length - before);
    for (const k of game.karts.values()) if (k.dead <= 0 && k.z > 50) high += 1 / 30;
  }
  assert.strictEqual(game.botError, false);
  const drowned = events.filter(([e, d]) => e === 'game:kart:hit' && d.kill && d.by < 0).length;
  const pads = events.filter(([e]) => e === 'game:kart:pad').length;
  assert.ok(boxes >= 20, `${boxes} boxes picked up`);
  assert.ok(pads >= 1, `${pads} jump pad launches`);
  assert.ok(high > 5, `${high.toFixed(0)} kart-seconds up on the walls, the roof or a tower`);
  assert.ok(drowned <= 5, `${drowned} karts drove into the moat by themselves`);
});

test('layers: The Keep and The Graveyard: every spawn and box stands on its floor, and each is reachable from every other', () => {
  for (const id of ['keep', 'graveyard']) checkArena(K.getMap(id, 'arena'));
});

function checkArena(map) {
  assert.ok(map.layered);
  const nav = map.nav;
  const home = nav.nodeAt(map.spawns[0].x, map.spawns[0].y, map.spawns[0].z);
  const there = nav.reach(home);
  const back = nav.reach(home, true);
  for (const [what, list] of [['spawn', map.spawns], ['box', map.itemBoxes]]) {
    list.forEach((p, i) => {
      assert.strictEqual(map.floorAt(p.x, p.y, p.z + L.STEP, 0), p.z, `${map.id}: ${what} ${i} on its floor`);
      if (what === 'spawn') assert.strictEqual(map.walls(p.x, p.y, p.z, L.KART_R, null), 0, `${map.id}: spawn ${i} clear of walls`);
      const id = nav.nodeAt(p.x, p.y, p.z);
      assert.ok(id >= 0 && there[id] && back[id], `${map.id}: ${what} ${i} at (${p.x}, ${p.y}, ${p.z}) reachable both ways`);
    });
  }
  assert.ok(map.spawns.length >= 24 && map.itemBoxes.length >= 20);
}

test('layers: rolling ground: karts follow it, decks stand over it, and nothing falls through a steep rise', () => {
  const def = {
    id: 'hills', size: 2400,
    terrain: { seed: 5, amp: 70, scale: 500, base: 0, edge: 200, flats: [{ x: 1200, y: 1200, r: 300, z: 0 }] },
    blocks: [{ x0: 1100, y0: 1150, x1: 1300, y1: 1250, z0: 50, z1: 66 }],
  };
  const map = L.makeLayeredArena(def);
  assert.ok(map.land, 'a rolling ground');
  assert.strictEqual(map.floorAt(1200, 1100, 1000), 0, 'levelled where the flat is');
  assert.strictEqual(map.floorAt(1200, 1200, 1000), 66, 'a deck stands over it');
  assert.strictEqual(map.floorAt(1200, 1200, 10), 0, 'and the ground is under the deck');
  const lo = Math.min(...map.land.h);
  const hi = Math.max(...map.land.h);
  assert.ok(hi - lo > 60, `hills ${lo.toFixed(0)}..${hi.toFixed(0)}`);
  // Drive across the hills at boost speed: the kart is never under the ground.
  const k = kartAt(250, 300, map.floorAt(250, 300, 1e9), 0.6);
  k.boost = 30;
  let worst = 0;
  drive(map, k, UP, 4, 0, (kk) => { worst = Math.max(worst, map.land.at(kk.x, kk.y) - kk.z); });
  assert.ok(worst < 0.5, `never under the ground (worst ${worst.toFixed(2)})`);
  assert.ok(Math.hypot(k.x - 250, k.y - 300) > 1500, 'and covered the distance');
  // The navigation grid walks over the hills.
  const nav = map.nav;
  const a = nav.nodeAt(300, 300, map.land.at(300, 300));
  const b = nav.nodeAt(2100, 2100, map.land.at(2100, 2100));
  assert.ok(nav.path(a, b), 'a way across the hills');
});
