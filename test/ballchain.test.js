const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { server, rooms } = require('../server/index');
const B = require('../public/js/games/ballchain-core');

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// A started Ball & Chain game with its timer stopped, so tests step the simulation themselves.
async function bcGame(n, settings = {}) {
  const ctx = await makeRoom(n);
  const set = await call(ctx.host, 'lobby:settings', { mode: 'ballchain', ...settings });
  assert.ok(set.ok);
  if (ctx.beforeStart) await ctx.beforeStart(ctx);
  const init = once(ctx.host, 'game:bc:init');
  const res = await call(ctx.host, 'game:start');
  assert.ok(res.ok, res.error);
  ctx.init = await init;
  const game = ctx.room.game;
  game.stop();
  ctx.game = game;
  ctx.go = () => { game.phase = 'run'; game.phaseT = 0; game.runStart = game.time; };
  ctx.step = (k) => { for (let i = 0; i < k; i++) game.simulate(1 / 30); };
  ctx.sp = (i) => game.byId.get(ctx.players[i].id);
  ctx.teamOf = (i) => game.teams.find((t) => t.sim.players.includes(ctx.sp(i)));
  return ctx;
}

// Put a team's ball somewhere with the players gathered round it.
function teleport(game, team, x, y) {
  const s = team.sim;
  Object.assign(s.ball, { x, y, vx: 0, vy: 0, z: 0, vz: 0, air: false, state: 'ok' });
  s.players.forEach((p, i) => { if (p.state !== 'gone') { p.state = 'ok'; B.placeNearBall(s, game.course, p, i, s.players.length, game.time); } });
}

// ---------- pure physics helpers ----------
function course(...types) {
  return B.buildCourse({ name: 'Test', theme: 'candy', sections: ['start', ...types, 'goal'].map((type) => ({ type, seed: 7, mirror: false })) });
}
function makeTeam(C, n, rope = B.ROPES.normal) {
  const t = B.makeTeam(C, Array.from({ length: n }, (_, i) => ({ id: `p${i}`, idx: i })), rope);
  t.id = 0;
  return t;
}
function simulate(team, C, secs, t0 = 0, each) {
  let t = t0;
  const events = [];
  for (let i = 0; i < Math.round(secs * 30); i++) {
    each?.(t);
    for (let s = 0; s < 2; s++) { t += 1 / 60; B.stepTeam(team, C, t, 1 / 60, events); }
    B.tickTeam(team, C, t, 1 / 30, events);
  }
  return { t, events };
}
const section = (C, type) => C.sections.find((s) => s.type === type);
const place = (e, x, y) => Object.assign(e, { x, y, px: x, py: y, vx: 0, vy: 0 });

// ---------- team formation ----------
test('ball & chain: auto teams are balanced teams of 2-6 for every room size from 2 to 30', () => {
  for (let n = 2; n <= 30; n++) {
    const sizes = B.teamSizes(n);
    assert.strictEqual(sizes.reduce((a, b) => a + b, 0), n, `n=${n}`);
    assert.ok(sizes.length <= 5, `n=${n}: at most 5 teams`);
    assert.ok(sizes.every((s) => s >= 2 && s <= 6), `n=${n}: sizes ${sizes}`);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n}: balanced ${sizes}`);
    if (n <= 3) assert.strictEqual(sizes.length, 1, 'a room of 2-3 is one team');
    else assert.ok(sizes.length >= 2, `n=${n}: bigger rooms race at least two teams`);
  }
  assert.deepStrictEqual(B.teamSizes(30), [6, 6, 6, 6, 6]);
});

test('ball & chain: 30 players split into 5 teams of 6 racing side by side', async () => {
  const { init, game, room } = await bcGame(30);
  assert.strictEqual(init.teams.length, 5);
  assert.deepStrictEqual(init.teams.map((t) => t.members.length), [6, 6, 6, 6, 6]);
  assert.strictEqual(init.players.length, 30);
  assert.strictEqual(new Set(init.players.map((p) => p.id)).size, 30);
  assert.strictEqual(init.courses, 3);
  assert.ok(init.course.sections.length === 8, 'start + 6 obstacles + goal by default');
  // Every lane gets the identical course.
  assert.ok(game.teams.every((t) => t.sim.ball.y === game.teams[0].sim.ball.y));
  room.destroy();
});

test('ball & chain: team mode uses the room teams (up to 5) and refuses teams outside 2-6', async () => {
  const ctx = await makeRoom(8);
  const { host, players, room } = ctx;
  await call(host, 'lobby:settings', { mode: 'ballchain', teamMode: true, teamCount: 5 });
  assert.strictEqual(room.settings.teamCount, 5);
  assert.strictEqual(room.teamList()[4].name, 'Purple');
  // 7 Red and 1 Blue: both out of range.
  for (const p of players) room.players.get(p.id).team = 0;
  room.players.get(players[7].id).team = 1;
  let res = await call(host, 'game:start');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /2–6 players/);
  assert.match(res.error, /Red has 7/);
  assert.match(res.error, /Blue has 1/);
  assert.strictEqual(room.state, 'lobby');
  // 3 Red, 3 Blue, 2 Purple, other teams empty: fine.
  [0, 0, 0, 1, 1, 1, 4, 4].forEach((team, i) => { room.players.get(players[i].id).team = team; });
  const init = once(host, 'game:bc:init');
  res = await call(host, 'game:start');
  assert.ok(res.ok, res.error);
  const data = await init;
  assert.deepStrictEqual(data.teams.map((t) => [t.name, t.members.length]), [['Red', 3], ['Blue', 3], ['Purple', 2]]);
  const purple = data.teams[2];
  assert.deepStrictEqual(purple.members.map((i) => data.players[i].id).sort(), [players[6].id, players[7].id].sort());
  room.destroy();
});

// ---------- ropes ----------
test('ball & chain: ropes wrap around a pillar and unwrap when swung back', () => {
  const C = course('slalom');
  const post = C.posts.find((p) => p.x === -50 || p.x === 50);
  const team = makeTeam(C, 1);
  const p = team.players[0];
  const ball = place(team.ball, post.x, post.y - 120);
  place(p, post.x - 80, post.y + 100);
  B.updateWraps(C, p, ball);
  assert.deepStrictEqual(p.wraps, [], 'rope passes clear of the pillar');
  for (let x = post.x - 80; x <= post.x + 80; x += 4) { place(p, x, post.y + 100); B.updateWraps(C, p, ball); }
  assert.deepStrictEqual(p.wraps, [post.id], 'swinging across the pillar wraps the rope');
  const straight = Math.hypot(p.x - ball.x, p.y - ball.y);
  assert.ok(B.pathLen(B.ropePoints(C, p, ball)) > straight + 5, 'a wrapped rope is longer than the straight line');
  // Walking further round keeps it wrapped; swinging back releases it.
  for (let x = post.x + 80; x >= post.x - 80; x -= 4) { place(p, x, post.y + 100); B.updateWraps(C, p, ball); }
  assert.deepStrictEqual(p.wraps, [], 'swinging back unwraps');
  // The ball rolling past a pillar wraps from the other end.
  place(p, post.x - 70, post.y + 120);
  for (let x = post.x - 60; x <= post.x + 70; x += 4) { place(ball, x, post.y - 130); B.updateWraps(C, p, ball); }
  assert.deepStrictEqual(p.wraps, [post.id]);
});

test('ball & chain: a wrapped rope pulls around the post and slack never pushes', () => {
  const C = course('mudice');
  const team = makeTeam(C, 1);
  const p = team.players[0];
  const sec = section(C, 'mudice');
  place(team.ball, 0, sec.y0 + 60);
  place(p, 0, sec.y0 + 120); // slack rope, standing still
  simulate(team, C, 1);
  assert.ok(Math.hypot(team.ball.vx, team.ball.vy) < 1, 'slack rope applies no force');
  // Walking away stretches the rope past rest; it never gets longer than the hard limit.
  p.input = { x: 0, y: -1, brace: false };
  let maxLen = 0;
  simulate(team, C, 2, 0, () => { maxLen = Math.max(maxLen, B.pathLen(B.ropePoints(C, p, team.ball))); });
  assert.ok(maxLen <= team.rope.max + 1, `rope limited to ${team.rope.max}, got ${maxLen}`);
  assert.ok(team.ball.y < sec.y0 + 40, 'the ball got dragged');
});

// ---------- heave, brace, mass ----------
function heaveSetup(n) {
  const C = course('mudice');
  const team = makeTeam(C, n);
  const y = section(C, 'mudice').y0 + 40;
  place(team.ball, 0, y);
  team.players.forEach((p, i) => place(p, -60 + (120 * i) / Math.max(1, n - 1), y + 205));
  return { C, team };
}

test('ball & chain: heaves within 0.4 s stack into a sync with a bigger multiplier', () => {
  const single = heaveSetup(4);
  const r1 = B.heave(single.team, single.C, single.team.players[0], 10);
  assert.strictEqual(r1.k, 1);
  const dv1 = single.team.ball.vy;
  assert.ok(dv1 > 0, 'the ball is tugged toward the player');

  const pair = heaveSetup(4);
  B.heave(pair.team, pair.C, pair.team.players[0], 10);
  const r2 = B.heave(pair.team, pair.C, pair.team.players[1], 10.3);
  assert.strictEqual(r2.k, 2, 'second heave inside the window syncs');
  const dv2 = pair.team.ball.vy;
  assert.ok(dv2 > dv1 * 2.4, `sync x2 is worth more than two single heaves (${dv2} vs ${dv1})`);
  const r3 = B.heave(pair.team, pair.C, pair.team.players[2], 10.38);
  assert.strictEqual(r3.k, 3, 'three in the window');
  assert.strictEqual(B.heave(pair.team, pair.C, pair.team.players[3], 10.45).k, 1, 'the window runs from the first heave of the sync');
  assert.strictEqual(pair.team.players[0].stats.syncs, 1);
  assert.strictEqual(pair.team.players[2].stats.syncs, 1);

  const late = heaveSetup(4);
  B.heave(late.team, late.C, late.team.players[0], 10);
  assert.strictEqual(B.heave(late.team, late.C, late.team.players[1], 10.45).k, 1, 'too late: a new sync starts');
  // Cooldown: the same player can't heave again straight away.
  assert.strictEqual(B.heave(late.team, late.C, late.team.players[0], 10.5), null);
});

test('ball & chain: a full-team sync on a ramp launches the ball over the gap', () => {
  const C = course('ramp');
  const sec = section(C, 'ramp');
  const ramp = C.ramps[0];
  const run = (heavers) => {
    const team = makeTeam(C, 2);
    place(team.ball, 0, ramp.y1 - 8);
    place(team.players[0], -60, sec.y0 + 565);
    place(team.players[1], 60, sec.y0 + 565);
    team.players.forEach((p) => { p.input = { x: 0, y: 1, brace: false }; });
    heavers.forEach((i, k) => B.heave(team, C, team.players[i], 5 + k * 0.1));
    const launched = team.ball.air;
    const { events } = simulate(team, C, 2, 5.2);
    return { team, launched, events };
  };
  const solo = run([0]);
  assert.strictEqual(solo.launched, false, 'one heave is not enough');
  const sync = run([0, 1]);
  assert.strictEqual(sync.launched, true, 'the whole team in sync launches');
  assert.ok(sync.events.some((e) => e.type === 'land'), 'it lands');
  assert.ok(!sync.events.some((e) => e.type === 'fall' && e.ball), 'and does not fall in the gap');
  assert.ok(sync.team.ball.y > sec.y0 + 550, 'the ball is across the gap');
  // The ball can't roll over the player-only planks either.
  const team = makeTeam(C, 2);
  place(team.ball, 234, sec.y0 + 400);
  place(team.players[0], 200, sec.y0 + 300);
  place(team.players[1], 240, sec.y0 + 300);
  const { events } = simulate(team, C, 0.2);
  assert.ok(events.some((e) => e.type === 'fall' && e.ball));
});

test('ball & chain: bracing turns a player into an anchor that holds the ball on a slope', () => {
  const C = course('tilt');
  const sec = section(C, 'tilt');
  const y = sec.y0 + 380;
  const loose = makeTeam(C, 2);
  place(loose.ball, 40, y);
  place(loose.players[0], -110, y - 60);
  place(loose.players[1], -110, y + 60);
  const r1 = simulate(loose, C, 6);
  assert.ok(r1.events.some((e) => e.type === 'fall' && e.ball), 'without bracing the ball rolls off the edge');

  const held = makeTeam(C, 2);
  place(held.ball, 40, y);
  place(held.players[0], -110, y - 60);
  place(held.players[1], -110, y + 60);
  held.players.forEach((p) => { p.input = { x: 0, y: 0, brace: true }; });
  const before = held.players.map((p) => [p.x, p.y]);
  const r2 = simulate(held, C, 6);
  assert.ok(!r2.events.some((e) => e.type === 'fall'), 'braced players hold the ball');
  held.players.forEach((p, i) => {
    assert.ok(Math.hypot(p.x - before[i][0], p.y - before[i][1]) < 2, 'braced players stay planted');
    assert.ok(p.stats.brace > 5.5);
  });
});

test('ball & chain: ball mass scales with team size so a team of 2 and a team of 6 pull equally fast', () => {
  const pull = (n) => {
    const C = course('mudice', 'mudice');
    const team = makeTeam(C, n);
    place(team.ball, 0, 300);
    team.players.forEach((p, i) => { place(p, -150 + (300 * i) / (n - 1), 450); p.input = { x: 0, y: 1, brace: false }; });
    simulate(team, C, 3);
    return team.ball.y - 300;
  };
  const two = pull(2);
  const six = pull(6);
  assert.ok(two > 250, `the ball moves (${two})`);
  assert.ok(Math.abs(two - six) / two < 0.12, `team of 2 moved ${two}, team of 6 moved ${six}`);
  assert.strictEqual(B.ballMass({ players: [{}, {}], mods: { heavy: 0 } }, 0) * 3, B.ballMass({ players: Array(6).fill({}), mods: { heavy: 0 } }, 0));
});

// ---------- plates and gates ----------
test('ball & chain: a pressure plate holds the gate open; the gate blocks the ball when closed', () => {
  const C = course('plates');
  const gate = C.gates[0];
  const plateA = C.plates[gate.plates[0]];
  const team = makeTeam(C, 2, { rest: 2000, max: 3000 }); // ropes out of the way
  place(team.players[0], 0, gate.y0 - 300);
  place(team.players[1], 0, gate.y0 - 340);
  place(team.ball, 0, gate.y0 - 90);
  simulate(team, C, 1.5, 0, () => { team.ball.vy = 220; });
  assert.strictEqual(team.gates[0].open, false);
  assert.ok(team.ball.y < gate.y0 - B.PHYS.ballR + 2, 'a closed gate stops the ball');

  place(team.players[0], plateA.x, plateA.y);
  simulate(team, C, 0.1);
  assert.strictEqual(team.gates[0].open, true, 'standing on the plate opens it');
  simulate(team, C, 2, 0, () => { team.ball.vy = 220; });
  assert.ok(team.ball.y > gate.y1 + B.PHYS.ballR, 'the ball rolls through the open gate');

  place(team.players[0], 0, gate.y0 - 300);
  simulate(team, C, 0.2);
  assert.strictEqual(team.gates[0].open, true, 'the gate lingers for a moment');
  simulate(team, C, 0.6);
  assert.strictEqual(team.gates[0].open, false, 'then closes once nobody is on the plate');
});

test('ball & chain: twin plates need both keys at once', () => {
  const C = course('twin');
  const gate = C.gates[0];
  assert.strictEqual(gate.all, true);
  const team = makeTeam(C, 3, { rest: 2000, max: 3000 });
  const [a, b] = gate.plates.map((i) => C.plates[i]);
  place(team.ball, 0, gate.y0 - 100);
  place(team.players[0], a.x, a.y);
  place(team.players[1], 0, gate.y0 - 250);
  place(team.players[2], 0, gate.y0 - 290);
  simulate(team, C, 0.2);
  assert.strictEqual(team.gates[0].open, false, 'one key is not enough');
  place(team.players[1], b.x, b.y);
  simulate(team, C, 0.2);
  assert.strictEqual(team.gates[0].open, true);
});

// ---------- falls, checkpoints, sabotage (on a live game) ----------
test('ball & chain: a ball that falls goes back to the last checkpoint after a short penalty; fallen players pop back', async () => {
  const { host, game, go, step, room } = await bcGame(4, { bcSabotage: false });
  go();
  const team = game.teams[0];
  const C = game.course;
  const cp = C.checkpoints[2];
  teleport(game, team, 0, cp.spawnY);
  step(2);
  assert.strictEqual(team.sim.cp, 2, 'crossing a checkpoint saves it');
  const fell = once(host, 'game:bc:fx', (e) => e.type === 'fall' && e.ball && e.team === team.idx);
  team.sim.ball.x = 330; // just off the edge of the lane
  step(1);
  await fell;
  assert.strictEqual(team.sim.ball.state, 'fall');
  step(Math.ceil(B.PHYS.fallTime * 30) + 1);
  assert.strictEqual(team.sim.ball.state, 'frozen', 'short penalty before the team can move again');
  assert.strictEqual(team.sim.ball.x, cp.spawnX);
  assert.strictEqual(team.sim.ball.y, cp.spawnY);
  assert.ok(team.sim.players.every((p) => Math.hypot(p.x - cp.spawnX, p.y - cp.spawnY) < 200), 'the team is gathered at the checkpoint');
  step(Math.ceil(B.PHYS.respawnFreeze * 30) + 1);
  assert.strictEqual(team.sim.ball.state, 'ok');

  const p = team.sim.players[0];
  const fallsBefore = game.stats.get(p.id).falls;
  const popped = once(host, 'game:bc:fx', (e) => e.type === 'pop' && e.idx === p.idx);
  p.x = -900;
  step(1);
  assert.strictEqual(p.state, 'fall');
  step(Math.ceil(B.PHYS.playerFallTime * 30) + 1);
  await popped;
  assert.strictEqual(p.state, 'ok');
  assert.ok(Math.hypot(p.x - team.sim.ball.x, p.y - team.sim.ball.y) < 200, 'pops back next to the ball');
  assert.strictEqual(game.stats.get(p.id).falls, fallsBefore + 1);
  room.destroy();
});

test('ball & chain: the first team to a checkpoint drops a sabotage on the teams behind', async () => {
  const { host, game, go, step, room } = await bcGame(4);
  go();
  const [lead, back] = game.teams;
  const C = game.course;
  const sab = once(host, 'game:bc:fx', (e) => e.type === 'sabotage');
  teleport(game, lead, 0, C.checkpoints[2].spawnY);
  step(1);
  const e = await sab;
  assert.strictEqual(e.from, lead.idx);
  assert.deepStrictEqual(e.to, [back.idx]);
  assert.ok(['oil', 'gust', 'snarl', 'heavy'].includes(e.kind));
  const m = back.sim.mods;
  assert.ok(m.oil || m.gust || m.snarl > game.time || m.heavy > game.time, 'the trap is applied to the team behind');
  assert.ok(!lead.sim.mods.oil && !lead.sim.mods.gust && !lead.sim.mods.snarl && !lead.sim.mods.heavy, 'not to the leader');

  // Each trap does what it says.
  const t = game.time;
  back.sim.mods.heavy = t + 5;
  assert.ok(Math.abs(B.ballMass(back.sim, t) - B.PHYS.ballMassPer * 2 * 1.8) < 1e-9);
  back.sim.mods.snarl = t + 5;
  assert.ok(B.ropeFor(back.sim, t).max < back.sim.rope.max);
  back.sim.mods.oil = { x0: -100, x1: 100, y0: 0, y1: 100, until: t + 5 };
  assert.strictEqual(B.surfaceAt(C, 0, 50, t, back.sim.mods).ice, true);
  back.sim.mods.gust = { ax: 500, from: t, until: t + 3 };
  assert.strictEqual(B.surfaceAt(C, 0, 50, t + 1, back.sim.mods).wx, 500);

  // The checkpoint is claimed: the second team to arrive drops nothing.
  let more = false;
  host.on('game:bc:fx', (ev) => { if (ev.type === 'sabotage') more = true; });
  teleport(game, back, 0, C.checkpoints[2].spawnY);
  step(2);
  await wait(50);
  assert.strictEqual(more, false);
  room.destroy();
});

test('ball & chain: no sabotage when it is switched off or for a single team', async () => {
  for (const [n, settings] of [[4, { bcSabotage: false }], [3, {}]]) {
    const { host, game, go, step, room } = await bcGame(n, settings);
    go();
    let dropped = false;
    host.on('game:bc:fx', (e) => { if (e.type === 'sabotage') dropped = true; });
    for (const k of [2, 3]) {
      teleport(game, game.teams[0], 0, game.course.checkpoints[k].spawnY);
      step(1);
    }
    await wait(50);
    assert.strictEqual(dropped, false);
    assert.strictEqual(game.teams[0].sim.cp, 3);
    room.destroy();
  }
});

// ---------- scoring ----------
test('ball & chain: finishing order scores each course; results rank teams with player stats', async () => {
  const { host, game, go, step, room } = await bcGame(10, { bcCourses: 3, bcLength: 'short' });
  assert.strictEqual(game.teams.length, 3);
  const [A, Bt, Cc] = game.teams;
  const finishCourse = async (order, dnf) => {
    go();
    step(30);
    for (const t of order) {
      teleport(game, t, game.course.goal.x, game.course.goal.y);
      step(15);
      assert.ok(t.finish, `${t.name} finished`);
    }
    if (dnf) {
      // The rest run out of time.
      game.graceUntil = game.time - game.runStart;
      step(1);
    }
    assert.strictEqual(game.phase, 'end');
    const next = game.courseIdx;
    step(30 * 9);
    return next;
  };
  await finishCourse([A, Bt], true);
  assert.deepStrictEqual(game.courseResults[0].rows.map((r) => [r.team, r.points]), [[A.idx, 10], [Bt.idx, 7], [Cc.idx, 2]]);
  assert.strictEqual(game.courseResults[0].rows[2].time, null, 'DNF has no time');
  assert.strictEqual(game.courseIdx, 1, 'next course loaded');
  await finishCourse([Bt, Cc, A], false);
  const results = once(host, 'room:state', (s) => s.state === 'results', 8000);
  // Some effort for the stats.
  game.stats.get(A.memberIds[0]).syncs = 3;
  game.stats.get(Bt.memberIds[0]).pulled = 4000;
  await finishCourse([A, Cc], true);
  const final = (await results).results;
  assert.strictEqual(final.mode, 'ballchain');
  assert.deepStrictEqual(final.teams.map((t) => [t.name, t.score]), [[A.name, 25], [Bt.name, 19], [Cc.name, 16]]);
  assert.deepStrictEqual(final.teams[0].places, [1, 3, 1]);
  assert.strictEqual(final.courses.length, 3);
  assert.strictEqual(final.players.length, 10);
  assert.ok(final.players.every((p) => p.stats && typeof p.stats.brace === 'number'));
  assert.strictEqual(final.awards.find((a) => a.key === 'sync').id, A.memberIds[0]);
  assert.strictEqual(final.awards.find((a) => a.key === 'pull').id, Bt.memberIds[0]);
  assert.strictEqual(game.interval, null, 'the game loop is stopped');
  room.destroy();
});

test('ball & chain: a single team (2-3 players) plays for its best time and medals', async () => {
  const { host, init, game, go, step, room } = await bcGame(3, { bcCourses: 1 });
  assert.strictEqual(init.teams.length, 1);
  assert.strictEqual(init.teams[0].members.length, 3);
  assert.strictEqual(init.course.sections.filter((s) => s.type === 'twin').length <= 1, true);
  go();
  step(30 * 10);
  const results = once(host, 'room:state', (s) => s.state === 'results', 8000);
  teleport(game, game.teams[0], game.course.goal.x, game.course.goal.y);
  step(2);
  assert.strictEqual(game.phase, 'end', 'one team finishing ends the course');
  assert.strictEqual(game.courseResults[0].rows[0].medal, 'gold');
  step(30 * 7);
  const final = (await results).results;
  assert.strictEqual(final.single, true);
  assert.strictEqual(final.teams[0].score, 10);
  room.destroy();
});

test('ball & chain: courses time out and unfinished teams are ranked by progress', async () => {
  const { game, go, step, room } = await bcGame(4, { bcCourses: 1 });
  go();
  const [a, b] = game.teams;
  teleport(game, b, 0, game.course.checkpoints[2].spawnY);
  step(1);
  game.runStart = game.time - game.limit;
  step(1);
  assert.strictEqual(game.phase, 'end');
  assert.deepStrictEqual(game.courseResults[0].rows.map((r) => r.team), [b.idx, a.idx]);
  assert.ok(game.courseResults[0].rows.every((r) => r.time === null));
  room.destroy();
});

// ---------- networking ----------
test('ball & chain: state snapshots are compact and rope wraps are sent when they change', async () => {
  const { host, init, game, go, step, room } = await bcGame(4);
  assert.ok(init.course.sections.every((s) => typeof s.type === 'string'));
  assert.strictEqual(init.wraps.length, 4);
  go();
  const st = once(host, 'game:bc:state');
  step(2);
  const s = await st;
  assert.strictEqual(s.ph, 1);
  assert.strictEqual(s.b.length, 2);
  assert.strictEqual(s.p.length, 4);
  assert.ok(s.b.every((row) => row.length === 11 && row.every(Number.isFinite)));
  assert.ok(s.p.every((row) => row.length === 7 && row.every(Number.isFinite)));
  assert.ok(s.w, 'first snapshot carries every rope');
  const st2 = once(host, 'game:bc:state');
  step(2);
  assert.strictEqual((await st2).w, undefined, 'unchanged ropes are not resent');
  const sp = game.teams[0].sim.players[0];
  sp.wrapVer++;
  const st3 = once(host, 'game:bc:state');
  step(2);
  assert.deepStrictEqual((await st3).w, [[sp.idx, ...sp.wraps]]);
  room.destroy();
});

test('ball & chain: every client message is validated', async () => {
  const { host, players, game, go, sp, room, code } = await bcGame(4);
  const s0 = players[1].socket;
  // Heave is refused during the countdown.
  assert.strictEqual((await call(s0, 'game:heave')).ok, false);
  for (const bad of [null, 'up', 42, [1, 2], true]) {
    assert.strictEqual((await call(s0, 'game:input', bad)).ok, false, `rejects ${JSON.stringify(bad)}`);
  }
  await call(s0, 'game:input', { x: 'abc', y: {} });
  assert.deepStrictEqual(sp(1).input, { x: 0, y: 0, brace: false });
  await call(s0, 'game:input', { x: 1e9, y: -1e9, brace: 'yes' });
  assert.ok(Math.abs(Math.hypot(sp(1).input.x, sp(1).input.y) - 1) < 1e-9, 'move vector clamped to unit length');
  assert.strictEqual(sp(1).input.brace, false, 'brace must be a real boolean');
  await call(s0, 'game:input', { x: NaN, y: Infinity, brace: true });
  assert.deepStrictEqual(sp(1).input, { x: 0, y: 0, brace: true });
  await call(s0, 'game:input', { x: 0.5, y: -0.25, extra: 'ignored', __proto__: { brace: true } });
  assert.deepStrictEqual(sp(1).input, { x: 0.5, y: -0.25, brace: false });
  assert.strictEqual((await call(s0, 'game:launch', { now: true })).ok, false, 'unknown events are refused');

  go();
  // Heave spam: one per cooldown.
  assert.strictEqual((await call(s0, 'game:heave', { power: 999 })).ok, true);
  assert.strictEqual((await call(s0, 'game:heave')).ok, false);
  assert.strictEqual(sp(1).stats.heaves, 1);

  // Late joiners watch: their inputs are ignored.
  const late = client();
  const initLate = once(late, 'game:bc:init');
  const r = await call(late, 'room:join', { code, name: 'Late' });
  assert.ok(r.ok);
  const data = await initLate;
  assert.ok(!data.players.some((p) => p.id === r.playerId), 'late joiners spectate');
  assert.strictEqual((await call(late, 'game:input', { x: 1, y: 0 })).ok, false);
  assert.strictEqual((await call(late, 'game:heave')).ok, false);
  assert.ok(game.byId.size === 4);
  room.destroy();
  void host;
});

test('ball & chain: disconnects mid-game drop the rope and lighten the ball; rejoining puts you back by the ball', async () => {
  const { players, game, go, step, room, code, sp, teamOf } = await bcGame(4);
  go();
  step(10);
  const team = teamOf(3).sim;
  const massBefore = B.ballMass(team, game.time);
  players[3].socket.close();
  await wait(100);
  assert.strictEqual(sp(3).state, 'gone');
  assert.deepStrictEqual(sp(3).wraps, []);
  assert.ok(B.ballMass(team, game.time) < massBefore, 'the ball mass follows the team still playing');
  step(10); // the team keeps playing without them
  const back = client();
  const snap = once(back, 'game:snapshot');
  const res = await call(back, 'room:join', { code, token: players[3].token, name: 'ignored' });
  assert.ok(res.ok);
  const s = await snap;
  assert.strictEqual(s.mode, 'ballchain');
  assert.ok(s.init.players.some((p) => p.id === players[3].id));
  assert.strictEqual(sp(3).state, 'ok');
  assert.ok(Math.hypot(sp(3).x - team.ball.x, sp(3).y - team.ball.y) < 200);
  assert.strictEqual(B.ballMass(team, game.time), massBefore);
  // Inputs work again after rejoining.
  assert.strictEqual((await call(back, 'game:input', { x: 0, y: 1 })).ok, true);
  room.destroy();
});

test('ball & chain: only the host can end the game, and ending it stops the simulation', async () => {
  const ctx = await makeRoom(4);
  await call(ctx.host, 'lobby:settings', { mode: 'ballchain' });
  const init = once(ctx.host, 'game:bc:init');
  await call(ctx.host, 'game:start');
  await init;
  await once(ctx.host, 'game:bc:state');
  const game = ctx.room.game;
  assert.ok(game.interval, 'running');
  const denied = await call(ctx.players[1].socket, 'game:stop');
  assert.strictEqual(denied.ok, false);
  const lobby = once(ctx.host, 'room:state', (s) => s.state === 'lobby');
  assert.ok((await call(ctx.host, 'game:stop')).ok);
  await lobby;
  assert.strictEqual(ctx.room.game, null);
  assert.strictEqual(game.interval, null);
  let more = 0;
  ctx.host.on('game:bc:state', () => more++);
  await wait(200);
  assert.strictEqual(more, 0, 'no more snapshots after the host ends it');
  ctx.room.destroy();
});

test('ball & chain: lobby settings are validated', async () => {
  const { host, room } = await makeRoom(2);
  const s = room.settings;
  assert.deepStrictEqual([s.bcCourses, s.bcLength, s.bcRope, s.bcSabotage], [3, 'normal', 'normal', true]);
  await call(host, 'lobby:settings', { mode: 'ballchain', bcCourses: 2, bcLength: 'huge', bcRope: 9, bcSabotage: 'no' });
  assert.deepStrictEqual([s.mode, s.bcCourses, s.bcLength, s.bcRope, s.bcSabotage], ['ballchain', 3, 'normal', 'normal', true]);
  await call(host, 'lobby:settings', { bcCourses: '5', bcLength: 'long', bcRope: 'short', bcSabotage: false });
  assert.deepStrictEqual([s.bcCourses, s.bcLength, s.bcRope, s.bcSabotage], [5, 'long', 'short', false]);
  await call(host, 'lobby:settings', { bcCourses: 1.5 });
  assert.strictEqual(s.bcCourses, 5);
  room.destroy();
});

test('ball & chain: every section type can be played: the ball reaches the goal on each course plan', () => {
  // Plans cover every obstacle across a long match and always include a coordination section.
  const seen = new Set();
  for (let seed = 1; seed <= 6; seed++) {
    for (const def of B.planMatch(seed, 5, 'long', 4)) {
      const types = def.sections.map((s) => s.type);
      assert.strictEqual(types[0], 'start');
      assert.strictEqual(types[types.length - 1], 'goal');
      assert.strictEqual(new Set(types).size, types.length, 'no repeats inside a course');
      assert.ok(types.some((t) => B.SECTIONS[t].tags?.includes('coord')));
      types.forEach((t) => seen.add(t));
      const C = B.buildCourse(def);
      assert.ok(C.goal && C.goal.y > 0);
      // Every checkpoint spawn is on solid ground and clear of the dynamic obstacles.
      for (const cp of C.checkpoints) {
        assert.ok(B.floorAt(C, cp.spawnX, cp.spawnY, 0, true), `${def.name}: checkpoint at ${cp.y}`);
      }
    }
  }
  for (const t of B.OBSTACLES) assert.ok(seen.has(t), `section ${t} appears`);
  // Teams of two never get the twin-plate gate (it needs three).
  for (let seed = 1; seed <= 20; seed++) {
    for (const def of B.planMatch(seed, 5, 'long', 2)) assert.ok(!def.sections.some((s) => s.type === 'twin'));
  }
});
