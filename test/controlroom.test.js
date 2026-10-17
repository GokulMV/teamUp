const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { server, rooms } = require('../server/index');
const CR = require('../server/games/controlroom');

let url;
const sockets = [];

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.close());
  for (const room of rooms.rooms.values()) room.destroy();
  await new Promise((resolve) => server.close(resolve));
});

function client() {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

const call = (s, event, data) => new Promise((resolve) => s.emit(event, data, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, event, pred = () => true, timeout = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
  const fn = (data) => {
    if (!pred(data)) return;
    clearTimeout(t);
    s.off(event, fn);
    resolve(data);
  };
  s.on(event, fn);
});

async function makeRoom(n) {
  const host = client();
  const res = await call(host, 'room:create', { name: 'Host' });
  assert.ok(res.ok);
  const players = [{ socket: host, id: res.playerId, token: res.token }];
  for (let i = 1; i < n; i++) {
    const s = client();
    const r = await call(s, 'room:join', { code: res.code, name: `P${i}` });
    assert.ok(r.ok, r.error);
    players.push({ socket: s, id: r.playerId, token: r.token });
  }
  return { code: res.code, host, players, room: rooms.rooms.get(res.code) };
}

// Small seeded PRNG so statistical checks are repeatable.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Start a Control Room game and take over its clock: tests advance time by hand.
async function startCR(n, settings = {}, teams = null) {
  const ctx = await makeRoom(n);
  await call(ctx.host, 'lobby:settings', { mode: 'controlroom', ...settings });
  if (teams) ctx.players.forEach((p, i) => { ctx.room.players.get(p.id).team = teams[i]; });
  const res = await call(ctx.host, 'game:start');
  assert.ok(res.ok, res.error);
  const game = ctx.room.game;
  clearInterval(game.interval);
  let now = Date.now();
  game.clock = () => now;
  Object.assign(ctx, {
    game,
    now: () => now,
    advance(ms, step = 100) { for (let t = 0; t < ms; t += step) { now += step; game.tick(); } },
    sock: (id) => ctx.players.find((p) => p.id === id).socket,
    player: (id) => ctx.room.players.get(id),
  });
  return ctx;
}

// The value that satisfies an order (undefined for buttons and levers).
function answer(game, crew, order) {
  const c = crew.controls.get(order.controlId);
  return { c, v: c.type === 'button' || c.type === 'lever' ? undefined : order.target };
}

// ---------------------------------------------------------------------------

test('control room crews: balanced 2-6 per ship, at most five ships, small rooms fly together', () => {
  for (let n = 2; n <= 30; n++) {
    const sizes = CR.crewSizes(n);
    assert.strictEqual(sizes.reduce((a, b) => a + b, 0), n, `n=${n}`);
    assert.ok(sizes.length <= 5, `n=${n} has ${sizes.length} crews`);
    assert.ok(sizes.every((s) => s >= 2 && s <= 6), `n=${n} sizes ${sizes}`);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n} unbalanced ${sizes}`);
    if (n <= 3) assert.strictEqual(sizes.length, 1);
    else assert.ok(sizes.length >= 2, `n=${n} should be split into teams`);
  }
  assert.deepStrictEqual(CR.crewSizes(30), [6, 6, 6, 6, 6]);
  assert.deepStrictEqual(CR.crewSizes(1), []);

  const teams = [{ id: 0, name: 'Red', color: '#f00' }, { id: 1, name: 'Blue', color: '#00f' }, { id: 2, name: 'Green', color: '#0f0' }];
  const people = (spec) => spec.flatMap((count, team) => Array.from({ length: count }, (_, i) => ({ id: `${team}-${i}`, team })));
  const ok = CR.planCrews(people([3, 2, 0]), { teamMode: true }, teams);
  assert.deepStrictEqual(ok.crews.map((c) => [c.name, c.members.length]), [['Red', 3], ['Blue', 2]]);
  const lonely = CR.planCrews(people([3, 1, 0]), { teamMode: true }, teams);
  assert.match(lonely.error, /2-6 players/);
  assert.match(lonely.error, /Blue has 1/);
  const crowded = CR.planCrews(people([7, 2, 2]), { teamMode: true }, teams);
  assert.match(crowded.error, /Red has 7/);
  assert.match(CR.planCrews(people([1]), { teamMode: false }, teams).error, /at least 2/);
});

test('team mode: room teams become crews (up to 5), bad team sizes refuse to start with a clear message', async () => {
  const { host, players, room } = await makeRoom(10);
  await call(host, 'lobby:settings', { mode: 'controlroom', teamMode: true, teamCount: 5 });
  assert.strictEqual(room.settings.teamCount, 5, 'five teams are allowed');
  players.forEach((p, i) => { room.players.get(p.id).team = i % 5; });
  const res = await call(host, 'game:start');
  assert.ok(res.ok, res.error);
  const crews = room.game.crews;
  assert.strictEqual(crews.length, 5);
  for (const crew of crews) {
    assert.strictEqual(crew.members.length, 2);
    assert.ok(crew.members.every((m) => room.players.get(m.id).team === crew.id));
  }
  assert.deepStrictEqual(crews.map((c) => c.name), ['Red', 'Blue', 'Green', 'Yellow', 'Purple']);
  await call(host, 'game:stop');

  // One player alone on a team: refused, still in the lobby.
  players.forEach((p, i) => { room.players.get(p.id).team = i === 9 ? 2 : i % 2; });
  const lonely = await call(host, 'game:start');
  assert.strictEqual(lonely.ok, false);
  assert.match(lonely.error, /Green has 1/);
  assert.strictEqual(room.state, 'lobby');
  // Seven on one team: refused too.
  players.forEach((p, i) => { room.players.get(p.id).team = i < 7 ? 0 : 1; });
  const crowded = await call(host, 'game:start');
  assert.strictEqual(crowded.ok, false);
  assert.match(crowded.error, /Red has 7/);
  room.destroy();
});

test('auto split: 30 players fly five ships of six; three players are one crew', async () => {
  const big = await startCR(30);
  assert.deepStrictEqual(big.game.crews.map((c) => c.members.length), [6, 6, 6, 6, 6]);
  const all = big.game.crews.flatMap((c) => c.members.map((m) => m.id));
  assert.strictEqual(new Set(all).size, 30, 'everyone is on exactly one ship');
  assert.strictEqual(new Set(big.game.crews.map((c) => c.ship)).size, 5, 'ship names are unique');
  big.room.destroy();
  const small = await startCR(3);
  assert.strictEqual(small.game.crews.length, 1);
  assert.strictEqual(small.game.crews[0].members.length, 3);
  small.room.destroy();
});

test('panels: unique technobabble per crew, varied control types, valid values, bigger panels in later sectors', async () => {
  const names = CR.makeNames(48, seeded(3));
  assert.strictEqual(new Set(names).size, 48);
  const firsts = names.map((n) => n.split(' ')[0]);
  assert.strictEqual(new Set(firsts).size, 48, 'no first word repeats, so shouting it is unambiguous');

  const { game, room } = await startCR(6, { crDifficulty: 'pilot' });
  for (const crew of game.crews) {
    const controls = [...crew.controls.values()];
    assert.strictEqual(new Set(controls.map((c) => c.name)).size, controls.length, 'names unique within the crew');
    for (const m of crew.members) {
      const panel = crew.panels.get(m.id).map((id) => crew.controls.get(id));
      assert.strictEqual(panel.length, CR.DIFFICULTY.pilot.controls[0]);
      assert.strictEqual(new Set(panel.map((c) => c.type)).size, panel.length, 'a 4-control panel has 4 different types');
      for (const c of panel) {
        assert.strictEqual(c.owner, m.id);
        if (c.type === 'toggle') assert.strictEqual(typeof c.value, 'boolean');
        if (c.type === 'slider') assert.ok(c.min === 0 && c.max === 5 && Number.isInteger(c.value) && c.value >= 0 && c.value <= 5);
        if (c.type === 'dial') assert.ok(c.min === 0 && c.max === 9 && c.value >= 0 && c.value <= 9);
        if (c.type === 'multi') assert.ok(c.options.length >= 3 && c.value >= 0 && c.value < c.options.length);
      }
    }
  }
  // Next sector: brand new panels, one more control each.
  const crew = game.crews[0];
  const oldIds = new Set(crew.controls.keys());
  game.setupSector(crew, 2, game.clock());
  assert.ok([...crew.controls.keys()].every((id) => !oldIds.has(id)));
  for (const m of crew.members) assert.strictEqual(crew.panels.get(m.id).length, CR.DIFFICULTY.pilot.controls[1]);
  room.destroy();
});

test('orders: about 75% for a crewmate\'s control, never already true, never two on the same control', async () => {
  const { game, room } = await startCR(4, {}, null);
  game.rand = seeded(42);
  const crew = game.crews[0];
  const holder = crew.members[0].id;
  let others = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    crew.orders.clear();
    const o = game.issueOrder(crew, holder, game.clock());
    const c = crew.controls.get(o.controlId);
    if (c.owner !== holder) others++;
    if (c.type === 'toggle' || c.type === 'slider' || c.type === 'dial' || c.type === 'multi') {
      assert.notStrictEqual(o.target, c.value, `order "${o.text}" is already true`);
    }
    // Shake the values so targets are tested from every state.
    if (c.type === 'slider' || c.type === 'dial') c.value = c.min + Math.floor(game.rand() * (c.max - c.min + 1));
    if (c.type === 'toggle') c.value = game.rand() < 0.5;
  }
  const share = others / N;
  assert.ok(share > 0.71 && share < 0.79, `share of orders for crewmates' controls: ${share}`);
  // Everyone at once: never two orders on one control.
  for (let i = 0; i < 300; i++) {
    crew.orders.clear();
    for (const m of crew.members) game.issueOrder(crew, m.id, game.clock());
    const ids = [...crew.orders.values()].map((o) => o.controlId);
    assert.strictEqual(new Set(ids).size, ids.length);
  }
  // Order text names the control and the target.
  const o = [...crew.orders.values()][0];
  assert.ok(o.text.includes(o.name));
  room.destroy();
});

test('every client message is validated: control id, ownership, type, range, phase, rate', async () => {
  const ctx = await startCR(6);
  const { game, room } = ctx;
  ctx.advance(5200);
  // No random events: an asteroid storm locks the panels and would turn the checks below upside down.
  for (const c of game.crews) { c.event = null; c.eventCooldown = Infinity; }
  // Crews are shuffled: act as a crew member who isn't the host (the host may end the flight).
  const crew = game.crews.find((c) => c.members.some((m) => m.id !== room.hostId) && c.members.length >= 2);
  const me = crew.members.find((m) => m.id !== room.hostId).id;
  const mate = crew.members.find((m) => m.id !== me).id;
  const s = ctx.sock(me);
  const mine = (type) => crew.panels.get(me).map((id) => crew.controls.get(id)).find((c) => c.type === type);
  // Make sure the panel has one of each value type to poke at.
  const kinds = ['toggle', 'slider', 'dial', 'multi'];
  crew.panels.get(me).forEach((id, i) => {
    const c = crew.controls.get(id);
    const type = kinds[i % kinds.length];
    Object.assign(c, game.makeControl(c.name, me, type), { id: c.id, home: me });
  });
  const before = JSON.stringify([...crew.controls.values()]);
  const bad = [
    undefined, null, 5, 'k1', [], [{ c: mine('toggle').id }], {}, { c: 12 }, { c: { id: 1 } }, { c: 'nope' }, { c: '__proto__' },
    { c: crew.panels.get(mate)[0] }, // a crewmate's control
    { c: ((o) => o.panels.get(o.members[0].id)[0])(game.crews.find((c) => c !== crew)) }, // another ship's control
    { c: mine('toggle').id, v: 1 }, { c: mine('toggle').id, v: 'true' }, { c: mine('toggle').id },
    { c: mine('slider').id, v: 6 }, { c: mine('slider').id, v: -1 }, { c: mine('slider').id, v: 2.5 }, { c: mine('slider').id, v: '3' }, { c: mine('slider').id, v: null },
    { c: mine('dial').id, v: 10 }, { c: mine('dial').id, v: Infinity },
    { c: mine('multi').id, v: mine('multi').options.length }, { c: mine('multi').id, v: -1 }, { c: mine('multi').id, v: 0.5 },
  ];
  for (const data of bad) {
    const res = await call(s, 'game:act', data);
    assert.strictEqual(res.ok, false, `accepted ${JSON.stringify(data)}`);
  }
  assert.strictEqual(JSON.stringify([...crew.controls.values()]), before, 'rejected actions change nothing');
  // Valid actions work.
  const sl = mine('slider');
  const target = (sl.value + 1) % 6;
  assert.deepStrictEqual((await call(s, 'game:act', { c: sl.id, v: target })).ok, true);
  assert.strictEqual(sl.value, target);
  const tg = mine('toggle');
  const was = tg.value;
  assert.ok((await call(s, 'game:act', { c: tg.id, v: !was })).ok);
  assert.strictEqual(tg.value, !was);
  // Other events.
  for (const ev of ['game:hack', 'game:constructor', 'game:__proto__', 'game:toString']) {
    assert.strictEqual((await call(s, ev, {})).ok, false, ev);
  }
  assert.match((await call(s, 'game:mash')).error, /Nothing to deflect/);
  assert.match((await call(s, 'game:relay')).error, /Relay comms are off/);
  assert.match((await call(s, 'game:finish')).error, /Only the host/);
  // Flooding the server gets throttled.
  const flood = await Promise.all(Array.from({ length: 40 }, () => call(s, 'game:act', { c: sl.id, v: sl.value })));
  assert.ok(flood.some((r) => r.error === 'Too fast'));
  // Nothing works once the ship is out of the race.
  ctx.advance(1100);
  crew.status = 'destroyed';
  assert.match((await call(s, 'game:act', { c: sl.id, v: 0 })).error, /not flying/);
  assert.strictEqual(room.state, 'playing', 'no crash');
  room.destroy();
});

test('timers: expired orders damage the hull, done orders fill progress, the goal warps the ship, hull 0 destroys it', async () => {
  const ctx = await startCR(3, { crDifficulty: 'pilot' });
  const { game, room } = ctx;
  const crew = game.crews[0];
  assert.strictEqual(game.phase, 'briefing');
  assert.strictEqual(crew.orders.size, 0, 'no orders during the briefing');
  ctx.advance(5200);
  assert.strictEqual(game.phase, 'flying');
  ctx.advance(2500);
  assert.strictEqual(crew.orders.size, 3, 'every crew member has an order');
  const o = [...crew.orders.values()][0];
  assert.strictEqual(o.duration, 14000);

  // Complete one order through the socket of whoever owns the control.
  const { c, v } = answer(game, crew, o);
  const holderSock = ctx.sock(o.holder);
  const fx = once(holderSock, 'game:cr:fx', (d) => d.kind === 'done');
  const res = await call(ctx.sock(c.owner), 'game:act', v === undefined ? { c: c.id } : { c: c.id, v });
  assert.ok(res.ok);
  assert.strictEqual(res.done, 1);
  const done = await fx;
  assert.strictEqual(done.by, c.owner);
  assert.strictEqual(crew.progress, 1);
  assert.strictEqual(game.stats.get(c.owner).done, 1);
  if (c.owner !== o.holder) assert.strictEqual(game.stats.get(o.holder).mine, 1);
  assert.ok(!crew.orders.has(o.holder));
  ctx.advance(1200);
  assert.ok(crew.orders.has(o.holder), 'a new order follows shortly');

  // Let every order run out: each one costs hull.
  const hull = crew.hull;
  const open = crew.orders.size;
  const expired = once(holderSock, 'game:cr:fx', (d) => d.kind === 'expired');
  ctx.advance(14100);
  assert.ok((await expired).damage > 0);
  assert.strictEqual(crew.hull, hull - open * game.damage(1));
  assert.strictEqual(crew.missed, open);

  // A pointless press is a panic press.
  const owner = crew.members[0].id;
  const btn = crew.panels.get(owner).map((id) => crew.controls.get(id)).find((x) => ![...crew.orders.values()].some((oo) => oo.controlId === x.id) && (x.type === 'button' || x.type === 'lever'));
  if (btn) {
    await call(ctx.sock(owner), 'game:act', { c: btn.id });
    assert.strictEqual(game.stats.get(owner).panic, 1);
  }

  // Reach the goal: warp, a little hull repair, then sector 2 is harder.
  crew.progress = crew.goal - 1;
  const hullBefore = crew.hull;
  const next = [...crew.orders.values()][0];
  const a = answer(game, crew, next);
  const warp = once(holderSock, 'game:cr:fx', (d) => d.kind === 'warp');
  await call(ctx.sock(a.c.owner), 'game:act', a.v === undefined ? { c: a.c.id } : { c: a.c.id, v: a.v });
  assert.strictEqual((await warp).sector, 2);
  assert.strictEqual(crew.status, 'warping');
  assert.strictEqual(crew.hull, Math.min(100, hullBefore + 12));
  assert.strictEqual(crew.orders.size, 0);
  const goal1 = crew.goal;
  ctx.advance(3900);
  assert.strictEqual(crew.status, 'flying');
  assert.strictEqual(crew.sector, 2);
  assert.strictEqual(crew.progress, 0);
  assert.ok(crew.goal > goal1);
  ctx.advance(2000);
  assert.ok([...crew.orders.values()].every((x) => x.duration < 14000), 'shorter timers in sector 2');

  // Hull at 0: destroyed, the game ends with results.
  crew.hull = 3;
  const boom = once(holderSock, 'game:cr:fx', (d) => d.kind === 'destroyed');
  const results = once(ctx.host, 'room:state', (st) => st.state === 'results');
  ctx.advance(15000);
  await boom;
  assert.strictEqual(crew.status, 'destroyed');
  ctx.advance(3000);
  const final = await results;
  assert.strictEqual(final.results.mode, 'controlroom');
  assert.strictEqual(final.results.crews[0].status, 'destroyed');
  assert.strictEqual(final.results.crews[0].sector, 2);
  room.destroy();
});

test('sector escalation: more controls, shorter timers, bigger goals, more events; harder difficulties are harder', async () => {
  const { game, room } = await startCR(4);
  const crew = game.crews[0];
  for (const diff of ['cadet', 'pilot', 'ace']) {
    game.cfg = CR.DIFFICULTY[diff];
    let prev = { size: 0, time: Infinity, goal: 0, events: 0 };
    for (let s = 1; s <= 12; s++) {
      const cur = { size: game.panelSize(s), time: game.orderTime(s), goal: game.goalFor(crew, s), events: game.eventCount(s) };
      assert.ok(cur.size >= prev.size && cur.size >= 4 && cur.size <= 6, `${diff} s${s} size`);
      assert.ok(cur.time <= prev.time && cur.time >= game.cfg.floor, `${diff} s${s} time`);
      assert.ok(cur.goal > prev.goal, `${diff} s${s} goal`);
      assert.ok(cur.events >= prev.events, `${diff} s${s} events`);
      prev = cur;
    }
    assert.ok(game.orderTime(10) < game.orderTime(1));
    assert.ok(game.eventCount(3) >= 2, `${diff} has events by sector 3`);
  }
  const t = (d, s) => { game.cfg = CR.DIFFICULTY[d]; return game.orderTime(s); };
  assert.ok(t('ace', 1) < t('pilot', 1) && t('pilot', 1) < t('cadet', 1));
  game.cfg = CR.DIFFICULTY.pilot;
  assert.strictEqual(game.eventCount(1), 0, 'pilots get a calm first sector');
  room.destroy();
});

test('events: asteroid field needs every crew member to mash, blackout buys time, shuffle and wormhole and ion storm run their course', async () => {
  const ctx = await startCR(3);
  const { game, room } = ctx;
  const crew = game.crews[0];
  ctx.advance(5200);
  ctx.advance(2500);
  const [a, b, c] = crew.members.map((m) => m.id);

  // The event bag deals every type before repeating.
  const bag = new Set(Array.from({ length: 5 }, () => game.nextEventType(crew)));
  assert.deepStrictEqual([...bag].sort(), [...CR.EVENT_TYPES].sort());

  // Asteroids: panels lock, everyone must reach the quota.
  const startFx = once(ctx.sock(a), 'game:cr:fx', (d) => d.kind === 'event' && d.type === 'asteroid');
  const expiresBefore = [...crew.orders.values()].map((o) => o.expires);
  game.startEvent(crew, 'asteroid', game.clock());
  await startFx;
  const any = crew.panels.get(a)[0];
  assert.match((await call(ctx.sock(a), 'game:act', { c: any, v: 1 })).error, /asteroids/);
  const quota = crew.event.quota;
  for (let i = 0; i < quota; i++) {
    await call(ctx.sock(a), 'game:mash');
    await call(ctx.sock(b), 'game:mash');
  }
  assert.strictEqual(crew.event?.type, 'asteroid', 'not cleared until everyone has mashed');
  const cleared = once(ctx.sock(c), 'game:cr:fx', (d) => d.kind === 'eventEnd');
  ctx.advance(1000);
  for (let i = 0; i < quota; i++) await call(ctx.sock(c), 'game:mash');
  const endFx = await cleared;
  assert.strictEqual(endFx.success, true);
  assert.strictEqual(crew.event, null);
  assert.strictEqual(crew.progress, 1, 'clearing asteroids is worth a little progress');
  const expiresAfter = [...crew.orders.values()].map((o) => o.expires);
  expiresAfter.forEach((e, i) => assert.ok(e >= expiresBefore[i] + 1000, 'order timers paused while mashing'));

  // Asteroids nobody deflects: hull damage.
  const hull = crew.hull;
  game.startEvent(crew, 'asteroid', game.clock());
  ctx.advance(game.cfg.mashMs + 200);
  assert.strictEqual(crew.event, null);
  assert.strictEqual(crew.hull, hull - game.cfg.asteroid);

  // Blackout: order timers get extra time; it ends by itself.
  ctx.advance(2000);
  const o = [...crew.orders.values()][0];
  const exp = o.expires;
  game.startEvent(crew, 'blackout', game.clock());
  assert.strictEqual(o.expires, exp + 4000);
  ctx.advance(6100);
  assert.strictEqual(crew.event, null);

  // Shuffle: same controls, new places.
  const before = crew.members.map((m) => [...crew.panels.get(m.id)]);
  game.startEvent(crew, 'shuffle', game.clock());
  const afterShuffle = crew.members.map((m) => crew.panels.get(m.id));
  before.forEach((p, i) => {
    assert.deepStrictEqual([...afterShuffle[i]].sort(), [...p].sort());
    assert.notDeepStrictEqual(afterShuffle[i], p);
  });
  ctx.advance(4100);
  assert.strictEqual(crew.event, null);

  // Wormhole and ion storm are shown on the clients and time out.
  for (const type of ['wormhole', 'ionstorm']) {
    const st = once(ctx.sock(b), 'game:cr:state', (d) => d.crew.event?.type === type);
    game.startEvent(crew, type, game.clock());
    const seen = await st;
    assert.ok(seen.crew.event.endsIn > 0);
    ctx.advance(10_100);
    assert.strictEqual(crew.event, null, `${type} ended`);
  }

  // Events also trigger on their own once progress passes a milestone.
  game.setupSector(crew, 2, game.clock());
  assert.strictEqual(crew.eventPlan.length, 2);
  ctx.advance(6100);
  crew.progress = Math.ceil(crew.goal * 0.3);
  ctx.advance(200);
  assert.ok(crew.event, 'an event started at the progress milestone');
  room.destroy();
});

test('relay comms flash your order on your own crew\'s screens only, with a cooldown', async () => {
  const ctx = await startCR(6, { crComms: 'relay' });
  const { game, room } = ctx;
  ctx.advance(5200);
  ctx.advance(2500);
  const [crewA, crewB] = game.crews;
  const sender = crewA.members[0].id;
  const order = crewA.orders.get(sender);
  const mateSock = ctx.sock(crewA.members[1].id);
  const otherSock = ctx.sock(crewB.members[0].id);
  let leaked = false;
  const spy = (d) => { if (d.kind === 'relay') leaked = true; };
  otherSock.on('game:cr:fx', spy);
  const got = once(mateSock, 'game:cr:fx', (d) => d.kind === 'relay');
  const res = await call(ctx.sock(sender), 'game:relay');
  assert.ok(res.ok, res.error);
  const relay = await got;
  assert.strictEqual(relay.text, order.text);
  assert.strictEqual(relay.from, sender);
  assert.strictEqual(relay.control, order.name);
  assert.ok(relay.ms >= 2500 && relay.ms <= 4000);
  await sleep(150);
  otherSock.off('game:cr:fx', spy);
  assert.strictEqual(leaked, false, 'other crews never see your relays');
  assert.match((await call(ctx.sock(sender), 'game:relay')).error, /recharging/);
  ctx.advance(2600);
  assert.ok(crewA.orders.get(sender), 'still has an order');
  assert.ok((await call(ctx.sock(sender), 'game:relay')).ok);
  assert.strictEqual(game.stats.get(sender).relays, 2);
  room.destroy();
});

test('disconnects: the leaver\'s controls move to crewmates, stale orders are dropped, a rejoin brings the panel back', async () => {
  const ctx = await startCR(6);
  const { game, room, code } = ctx;
  ctx.advance(5200);
  ctx.advance(2500);
  const crew = game.crews[0];
  const leaver = ctx.players.find((p) => p.id === crew.members[1].id);
  const theirs = [...crew.panels.get(leaver.id)];
  // A crewmate's order that needs one of the leaver's controls.
  const holder = crew.members[0].id;
  let pointing;
  for (let i = 0; i < 500 && !theirs.includes(pointing?.controlId); i++) {
    crew.orders.clear();
    pointing = game.issueOrder(crew, holder, game.clock());
  }
  assert.ok(theirs.includes(pointing.controlId));

  const hull = crew.hull;
  leaver.socket.disconnect();
  await sleep(150);
  assert.strictEqual(crew.members.find((m) => m.id === leaver.id).connected, false);
  assert.ok(!crew.orders.has(leaver.id), 'the leaver\'s own order is dropped');
  // For a few seconds their controls wait for them (a phone locking, a reload); orders that needed
  // them are dropped without damage, and no new ones ask for them.
  assert.deepStrictEqual(crew.panels.get(leaver.id), theirs, 'controls kept through a short drop-out');
  assert.ok(!crew.orders.has(holder) || !theirs.includes(crew.orders.get(holder).controlId));
  ctx.advance(3000);
  for (const o of crew.orders.values()) assert.ok(!theirs.includes(o.controlId), 'no new order needs the missing player');
  assert.strictEqual(crew.hull, hull);
  ctx.advance(1200);
  assert.deepStrictEqual(crew.panels.get(leaver.id), [], 'then they move to the crew');
  for (const id of theirs) {
    const c = crew.controls.get(id);
    assert.ok(c, 'control still exists');
    assert.notStrictEqual(c.owner, leaver.id);
    assert.ok(crew.panels.get(c.owner).includes(id));
  }
  for (const o of crew.orders.values()) {
    const c = crew.controls.get(o.controlId);
    assert.ok(c && c.owner !== leaver.id, 'no order needs the missing player');
  }
  // Orders keep coming for the two who are left and can be completed.
  ctx.advance(3000);
  assert.strictEqual(crew.orders.size, 2);
  const o = [...crew.orders.values()][0];
  const a = answer(game, crew, o);
  const r = await call(ctx.sock(a.c.owner), 'game:act', a.v === undefined ? { c: a.c.id } : { c: a.c.id, v: a.v });
  assert.strictEqual(r.done, 1);

  // Back again with the same token: their own controls come home.
  const back = client();
  const snap = once(back, 'game:snapshot');
  const res = await call(back, 'room:join', { code, token: leaver.token, name: 'x' });
  assert.ok(res.ok);
  const s = await snap;
  assert.strictEqual(s.mode, 'controlroom');
  const panel = crew.panels.get(leaver.id);
  for (const id of theirs) if (crew.controls.has(id)) assert.ok(panel.includes(id), 'home controls returned');
  assert.strictEqual(panel.length, game.panelSize(crew.sector));
  assert.deepStrictEqual(s.panel.map((c) => c.id), panel);
  ctx.advance(2000);
  assert.ok(crew.orders.has(leaver.id), 'orders resume after the rejoin');

  room.destroy();
});

test('a panel never grows past the limit: controls that do not fit go offline and their orders are dropped', async () => {
  const ctx = await startCR(3);
  const { game, room } = ctx;
  ctx.advance(7700);
  const crew = game.crews[0];
  const [a, b, c] = crew.members.map((m) => m.id);
  while (crew.panels.get(a).length < CR.MAX_PANEL - 1) crew.panels.get(a).push(...game.makePanel(crew, a, 1));
  // a holds an order for one of c's controls.
  const target = crew.panels.get(c)[0];
  crew.orders.clear();
  let order;
  for (let i = 0; i < 500 && order?.controlId !== target; i++) { crew.orders.clear(); order = game.issueOrder(crew, a, game.clock()); }
  assert.strictEqual(order.controlId, target);
  ctx.sock(b).disconnect();
  ctx.sock(c).disconnect();
  await sleep(200);
  ctx.advance(4200); // past the drop-out grace
  assert.strictEqual(crew.panels.get(a).length, CR.MAX_PANEL, 'filled up to the limit, not past it');
  assert.strictEqual(crew.controls.size, CR.MAX_PANEL, 'controls with no room went offline');
  for (const id of crew.panels.get(a)) assert.strictEqual(crew.controls.get(id).owner, a);
  for (const o of crew.orders.values()) assert.ok(crew.controls.has(o.controlId) && crew.controls.get(o.controlId).owner === a);
  if (!crew.controls.has(target)) assert.ok(!crew.orders.has(a) || crew.orders.get(a).controlId !== target, 'the order for an offline control is gone');
  ctx.advance(2000);
  assert.ok(crew.orders.has(a), 'the last pilot keeps getting orders');
  room.destroy();
});

test('players leaving for good: the crew flies on; an empty ship is abandoned and the game ends', async () => {
  const ctx = await startCR(4); // two crews of two
  const { game, room } = ctx;
  ctx.advance(7700);
  const [crewA, crewB] = game.crews;
  const aIds = crewA.members.map((m) => m.id);
  const leaveOne = ctx.sock(aIds[0]);
  await call(leaveOne, 'room:leave');
  assert.deepStrictEqual(crewA.members.map((m) => m.id), [aIds[1]]);
  assert.strictEqual(crewA.status, 'flying');
  assert.ok(crewA.panels.get(aIds[1]).length > game.panelSize(1) - 1, 'the remaining pilot took the controls');
  ctx.advance(2000);
  assert.ok(crewA.orders.has(aIds[1]));
  await call(ctx.sock(aIds[1]), 'room:leave');
  assert.strictEqual(crewA.status, 'abandoned');
  // Crew B still flying, so the game goes on until B is out too.
  assert.strictEqual(room.state, 'playing');
  crewB.hull = 1;
  ctx.advance(16000);
  assert.strictEqual(crewB.status, 'destroyed');
  ctx.advance(3000);
  assert.strictEqual(room.state, 'results');
  assert.strictEqual(room.lastResults.crews.length, 2);
  room.destroy();
});

test('late joiners board a crew with a free seat, or watch when every ship is full', async () => {
  const ctx = await startCR(4);
  const { game, room, code } = ctx;
  ctx.advance(7700);
  const late = client();
  const snap = once(late, 'game:snapshot');
  const r = await call(late, 'room:join', { code, name: 'Late' });
  assert.ok(r.ok);
  const s = await snap;
  assert.strictEqual(s.spectating, false);
  const crew = game.crewOf(r.playerId);
  assert.ok(crew);
  assert.strictEqual(crew.members.length, 3);
  assert.strictEqual(crew.panels.get(r.playerId).length, game.panelSize(crew.sector));
  assert.strictEqual(s.panel.length, game.panelSize(crew.sector));
  room.destroy();

  // Team mode with two full crews of six: the newcomer watches.
  const full = await startCR(12, { teamMode: true, teamCount: 2 }, Array.from({ length: 12 }, (_, i) => i % 2));
  const watcher = client();
  const watchSnap = once(watcher, 'game:snapshot');
  const r2 = await call(watcher, 'room:join', { code: full.code, name: 'Watcher' });
  const ws = await watchSnap;
  assert.strictEqual(ws.spectating, true);
  assert.strictEqual(ws.crew, null);
  assert.strictEqual(ws.fleet.length, 2);
  assert.match((await call(watcher, 'game:act', { c: 'k1', v: 1 })).error, /not on a crew/);
  assert.ok(!full.game.crewOf(r2.playerId));
  full.room.destroy();
});

test('results: crews ranked by sector then progress, finished crews first; player stats and awards', async () => {
  const ctx = await startCR(9, { crSectors: 5, teamMode: true, teamCount: 3 }, Array.from({ length: 9 }, (_, i) => i % 3));
  const { game, room } = ctx;
  ctx.advance(7700);
  const [a, b, c] = game.crews;
  game.setupSector(a, 3, game.clock()); a.progress = 2;
  game.setupSector(b, 3, game.clock()); b.progress = 5;
  game.setupSector(c, 2, game.clock()); c.progress = 9; c.status = 'destroyed'; c.endedAt = game.clock();
  const someone = a.members[0].id;
  Object.assign(game.stats.get(someone), { done: 7, mine: 3, panic: 4 });
  const nonHost = ctx.players.find((p) => p.id !== room.hostId).socket;
  assert.match((await call(nonHost, 'game:finish')).error, /Only the host/);
  const results = once(ctx.host, 'room:state', (st) => st.state === 'results');
  assert.ok((await call(ctx.host, 'game:finish')).ok);
  const r = (await results).results;
  assert.deepStrictEqual(r.crews.map((x) => x.id), [b.id, a.id, c.id]);
  assert.deepStrictEqual(r.crews.map((x) => x.rank), [1, 2, 3]);
  assert.strictEqual(r.crews[0].cleared, 2);
  assert.strictEqual(r.crews[2].status, 'destroyed');
  assert.strictEqual(r.players.length, 9);
  const p = r.players.find((x) => x.id === someone);
  assert.deepStrictEqual([p.done, p.mine, p.panic], [7, 3, 4]);
  assert.strictEqual(r.players[0].id, someone, 'ranked by score');
  assert.strictEqual(r.awards.find((x) => x.key === 'panic').who.id, someone);
  assert.ok(r.crews.every((x) => x.members.length === 3 && x.ship));
  room.destroy();
});

test('clearing every sector finishes first; the others get a final countdown, then results', async () => {
  const ctx = await startCR(4, { crSectors: 5 });
  const { game, room } = ctx;
  ctx.advance(7700);
  const [a, b] = game.crews;
  game.setupSector(a, 5, game.clock());
  ctx.advance(2000);
  a.progress = a.goal - 1;
  const o = [...a.orders.values()][0];
  const ans = answer(game, a, o);
  await call(ctx.sock(ans.c.owner), 'game:act', ans.v === undefined ? { c: ans.c.id } : { c: ans.c.id, v: ans.v });
  assert.strictEqual(a.status, 'done');
  assert.ok(game.finalAt > game.clock(), 'final countdown started');
  assert.strictEqual(room.state, 'playing');
  const state = once(ctx.sock(b.members[0].id), 'game:cr:state', (s) => s.finalIn > 0);
  b.progress = 1;
  game.markCrew(b);
  assert.ok((await state).finalIn <= 60_000);
  ctx.advance(60_100, 500);
  assert.strictEqual(room.state, 'results');
  assert.strictEqual(room.lastResults.crews[0].id, a.id);
  assert.strictEqual(room.lastResults.crews[0].status, 'done');
  room.destroy();

  // Endless: no finish line, the flight ends when the ship is destroyed.
  const endless = await startCR(2, { crSectors: 0 });
  endless.advance(7700);
  const crew = endless.game.crews[0];
  endless.game.setupSector(crew, 12, endless.game.clock());
  crew.progress = crew.goal - 1;
  endless.game.beginWarp(crew, endless.game.clock());
  assert.strictEqual(crew.status, 'warping', 'endless never runs out of sectors');
  crew.hull = 1;
  endless.advance(4000);
  endless.advance(20000);
  endless.advance(3000);
  assert.strictEqual(endless.room.state, 'results');
  endless.room.destroy();
});

test('the host ending the game goes back to the lobby and stops every timer', async () => {
  const ctx = await startCR(4);
  const { game, room } = ctx;
  ctx.advance(7700);
  let after = 0;
  const count = () => { after++; };
  const res = await call(ctx.host, 'game:stop');
  assert.ok(res.ok);
  assert.strictEqual(room.state, 'lobby');
  assert.strictEqual(room.game, null);
  assert.strictEqual(game.interval, null);
  assert.strictEqual(game.flushTimer, null);
  ctx.players.forEach((p) => p.socket.on('game:cr:state', count));
  game.tick();
  game.markCrew(game.crews[0]);
  await sleep(200);
  assert.strictEqual(after, 0, 'a stopped game sends nothing');
  room.destroy();
});

test('control room lobby settings are validated', async () => {
  const { host, room } = await makeRoom(2);
  const s = room.settings;
  assert.deepStrictEqual([s.crDifficulty, s.crSectors, s.crComms], ['pilot', 5, 'voice']);
  await call(host, 'lobby:settings', { mode: 'controlroom', crDifficulty: 'ace', crSectors: 10, crComms: 'relay' });
  assert.deepStrictEqual([s.mode, s.crDifficulty, s.crSectors, s.crComms], ['controlroom', 'ace', 10, 'relay']);
  await call(host, 'lobby:settings', { crDifficulty: 'god', crSectors: 7, crComms: 'telepathy' });
  assert.deepStrictEqual([s.crDifficulty, s.crSectors, s.crComms], ['ace', 10, 'relay']);
  await call(host, 'lobby:settings', { crSectors: '0' });
  assert.strictEqual(s.crSectors, 0);
  await call(host, 'lobby:settings', { crSectors: 'abc' });
  await call(host, 'lobby:settings', { crSectors: 5.5 });
  assert.strictEqual(s.crSectors, 0);
  await call(host, 'lobby:settings', { teamCount: 9 });
  assert.strictEqual(s.teamCount, 5);
  room.destroy();
});

test('full flight over sockets: two crews of three shout their way through three sectors and every event type', async () => {
  const ctx = await startCR(6, { crDifficulty: 'ace' });
  const { game, room } = ctx;
  const latest = new Map();
  for (const p of ctx.players) p.socket.on('game:cr:state', (s) => latest.set(p.id, s));
  const kinds = new Set();
  for (const p of ctx.players) p.socket.on('game:cr:fx', (d) => { if (d.kind === 'event') kinds.add(d.type); });
  ctx.advance(5200);
  let rounds = 0;
  while (game.crews.some((c) => c.sector <= 3 && c.status !== 'destroyed') && rounds++ < 2000) {
    ctx.advance(300);
    await sleep(5);
    // Players act on what their screens show: find whose panel has the control and shout.
    // (A crew whose next event is due holds on until it arrives, so every event gets played.)
    const due = (crew) => crew.eventPlan.length && crew.progress / crew.goal >= crew.eventPlan[0].at;
    for (const p of ctx.players) {
      const s = latest.get(p.id);
      if (!s?.crew || s.crew.status !== 'flying') continue;
      if (s.crew.event?.type === 'asteroid') { await call(p.socket, 'game:mash'); continue; }
      if (due(game.crewOf(p.id))) continue;
      if (!s.order) continue;
      const mates = s.crew.members.map((m) => ({ id: m.id, panel: latest.get(m.id)?.panel || [] }));
      const owner = mates.find((m) => m.panel.some((c) => c.name === s.order.name));
      if (!owner) continue;
      const c = owner.panel.find((x) => x.name === s.order.name);
      const post = s.order.post.replace(/^to /, '');
      let v;
      if (c.type === 'toggle') v = s.order.pre.includes('on');
      if (c.type === 'slider' || c.type === 'dial') v = Number(post);
      if (c.type === 'multi') v = c.options.indexOf(post);
      await call(ctx.sock(owner.id), 'game:act', v === undefined ? { c: c.id } : { c: c.id, v });
    }
  }
  for (const crew of game.crews) assert.ok(crew.sector > 3 || crew.status !== 'flying', `crew ${crew.name} reached sector ${crew.sector}`);
  assert.ok(game.crews.every((c) => c.status !== 'destroyed'), 'a crew that does its job survives');
  assert.deepStrictEqual([...kinds].sort(), [...CR.EVENT_TYPES].sort(), 'every event type came up');
  const results = once(ctx.host, 'room:state', (st) => st.state === 'results');
  await call(ctx.host, 'game:finish');
  const r = (await results).results;
  assert.ok(r.players.every((p) => p.done + p.mine > 0), 'everyone pulled their weight');
  room.destroy();
});

test('a player offline when the flight starts takes a free seat when they come back', async () => {
  const ctx = await makeRoom(4);
  await call(ctx.host, 'lobby:settings', { mode: 'controlroom' });
  const away = ctx.players[3];
  away.socket.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok((await call(ctx.host, 'game:start')).ok);
  const game = ctx.room.game;
  clearInterval(game.interval);
  assert.ok(!game.crewOf(away.id), 'not seated while offline');
  const back = client();
  assert.ok((await call(back, 'room:join', { code: ctx.code, token: away.token })).ok);
  await new Promise((r) => setTimeout(r, 100));
  const crew = game.crewOf(away.id);
  assert.ok(crew, 'seated on a ship once back');
  assert.ok(crew.members.some((m) => m.id === away.id));
  ctx.room.destroy();
});

test('in teams, someone joining mid-flight whose team has no ship boards the one with most room', async () => {
  const ctx = await startCR(4, { teamMode: true, teamCount: 3 }, [0, 0, 1, 1]);
  const game = ctx.game;
  const late = client();
  const r = await call(late, 'room:join', { code: ctx.code, name: 'Late' });
  assert.ok(r.ok);
  await new Promise((res) => setTimeout(res, 100));
  const crew = game.crewOf(r.playerId);
  assert.ok(crew, 'boarded a ship instead of only watching');
  assert.strictEqual(ctx.room.players.get(r.playerId).team, crew.id, 'and is on that team now');
  ctx.room.destroy();
});
