const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { server, rooms } = require('../server/index');

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

test('rooms hold 30 players and reject the 31st', async () => {
  const { code, room } = await makeRoom(30);
  assert.strictEqual(room.players.size, 30);
  const extra = client();
  const r = await call(extra, 'room:join', { code, name: 'Late' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /full/);
  room.destroy();
});

test('only the host can change settings; team shuffle balances teams', async () => {
  const { host, players, room } = await makeRoom(10);
  const denied = await call(players[1].socket, 'lobby:settings', { mode: 'kart' });
  assert.strictEqual(denied.ok, false);
  await call(host, 'lobby:settings', { teamMode: true, teamCount: 3 });
  await call(host, 'lobby:shuffle');
  const counts = [0, 0, 0];
  for (const p of room.players.values()) counts[p.team]++;
  assert.deepStrictEqual(counts.sort(), [3, 3, 4]);
  room.destroy();
});

test('pictionary: drawer picks a word, strokes relay, correct guess scores', async () => {
  const { host, players, room } = await makeRoom(4);
  await call(host, 'lobby:settings', { mode: 'pictionary', pictionaryTurns: 1 });
  const optionsWaits = players.map((p) => once(p.socket, 'game:pict:options').then((d) => ({ p, d })).catch(() => null));
  const started = await call(host, 'game:start');
  assert.ok(started.ok, started.error);
  const { p: drawer, d } = (await Promise.race(optionsWaits.map((w) => w.then((v) => v || new Promise(() => {})))));
  assert.strictEqual(d.options.length, 3);
  const word = d.options[1];

  const guesser = players.find((p) => p !== drawer);
  const drawing = once(guesser.socket, 'game:pict:phase', (ph) => ph.phase === 'drawing');
  drawer.socket.emit('game:choose', { word });
  const phase = await drawing;
  assert.strictEqual(phase.word, null, 'guessers must not receive the word');
  assert.strictEqual(phase.mask.replace(/[^_]/g, '').length, word.replace(/ /g, '').length);

  const stroke = once(guesser.socket, 'game:pict:stroke');
  drawer.socket.emit('game:stroke', { id: 's1', color: '#ff0000', size: 5, pts: [0.1, 0.1, 0.5, 0.5] });
  assert.deepStrictEqual((await stroke).pts, [0.1, 0.1, 0.5, 0.5]);

  const scored = once(guesser.socket, 'game:pict:phase', (ph) => ph.guessed.includes(guesser.id));
  guesser.socket.emit('chat', { text: word.toUpperCase() });
  const after = await scored;
  assert.ok(after.scores[guesser.id] > 0);
  assert.ok(after.scores[drawer.id] > 0);
  assert.strictEqual(after.word, word);

  // Remaining guessers finish the round -> results.
  const results = once(host, 'room:state', (s) => s.state === 'results', 10000);
  for (const p of players) if (p !== drawer && p !== guesser) p.socket.emit('chat', { text: word });
  const final = await results;
  assert.strictEqual(final.results.players[0].score > 0, true);
  room.destroy();
});

test('telephone: full chain of write/draw/describe then reveal', async () => {
  const { host, players, room } = await makeRoom(3);
  await call(host, 'lobby:settings', { mode: 'telephone', telephoneSteps: 0 });
  const tasks = players.map((p) => once(p.socket, 'game:tel:task'));
  await call(host, 'game:start');
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  let current = await Promise.all(tasks);
  for (let step = 0; step < 3; step++) {
    assert.ok(current.every((t) => t.step === step));
    const next = step < 2
      ? players.map((p) => once(p.socket, 'game:tel:task'))
      : [once(host, 'game:tel:reveal')];
    for (let i = 0; i < players.length; i++) {
      const t = current[i];
      const payload = t.type === 'draw' ? { image: png } : { text: `text from ${i} at ${step}` };
      if (step > 0) assert.ok(t.prev, 'later steps see the previous entry');
      const r = await call(players[i].socket, 'game:submit', payload);
      assert.ok(r.ok);
    }
    current = await Promise.all(next);
  }

  let reveal = current[0];
  assert.strictEqual(reveal.bookCount, 3);
  const states = once(host, 'room:state', (s) => s.state === 'results', 10000);
  while (!reveal.last) {
    const nextReveal = once(host, 'game:tel:reveal');
    await call(host, 'game:next');
    reveal = await nextReveal;
  }
  assert.strictEqual(reveal.entries.length, 3);
  assert.deepStrictEqual(reveal.entries.map((e) => e.type), ['write', 'draw', 'describe']);
  await call(host, 'game:finish');
  await states;
  room.destroy();
});

test('telephone rejects image payloads that are not plain base64 data URLs', async () => {
  const { host, players, room } = await makeRoom(2);
  await call(host, 'lobby:settings', { mode: 'telephone' });
  const tasks = players.map((p) => once(p.socket, 'game:tel:task'));
  await call(host, 'game:start');
  await Promise.all(tasks);
  const drawTasks = players.map((p) => once(p.socket, 'game:tel:task'));
  for (const p of players) await call(p.socket, 'game:submit', { text: 'hi' });
  await Promise.all(drawTasks);
  await call(players[0].socket, 'game:submit', { image: 'data:image/png;base64,AAA" onerror="alert(1)' });
  const game = room.game;
  const entry = game.books.flatMap((b) => b.entries).find((e) => e && e.type === 'draw' && e.by === players[0].id);
  assert.strictEqual(entry.content, null);
  room.destroy();
});

test('kart battle: 30 karts race, inputs move karts, items and laps tracked', async () => {
  const { host, players, room } = await makeRoom(30);
  await call(host, 'lobby:settings', { mode: 'kart', kartLaps: 1 });
  const init = once(host, 'game:kart:init');
  await call(host, 'game:start');
  const data = await init;
  assert.strictEqual(data.karts.length, 30);

  await once(host, 'game:kart:state', (s) => s.phase === 'racing', 8000);
  for (const p of players) p.socket.emit('game:input', { up: true });
  await new Promise((r) => setTimeout(r, 1200));
  const s = await once(host, 'game:kart:state');
  assert.strictEqual(s.k.length, 30);
  const moving = s.k.filter((row) => row[4] > 100).length;
  assert.ok(moving >= 25, `expected karts to be moving, got ${moving}`);

  // Simulate the race to the finish line deterministically.
  const game = room.game;
  game.stop();
  const kart = game.karts.get(players[0].id);
  kart.item = 'rocket'; kart.ammo = 1;
  game.useItem(kart);
  assert.strictEqual(game.rockets.length, 1);
  assert.strictEqual(kart.item, null);
  const K = require('../public/js/shared/kart-core');
  for (const k of game.karts.values()) {
    [k.x, k.y] = K.CENTERLINE[5];
    k.lap = 2; k.trackIndex = 5;
  }
  const results = once(host, 'room:state', (st) => st.state === 'results', 8000);
  game.simulate(1 / 30);
  assert.ok([...game.karts.values()].every((k) => k.finished));
  game.endRace();
  const final = await results;
  assert.strictEqual(final.results.players.length, 30);
  room.destroy();
});

test('players can reconnect with their token and keep their identity', async () => {
  const { code, players, room } = await makeRoom(3);
  const p = players[2];
  p.socket.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(room.players.get(p.id).connected, false);
  const s = client();
  const res = await call(s, 'room:join', { code, token: p.token, name: 'ignored' });
  assert.ok(res.ok);
  assert.strictEqual(res.playerId, p.id);
  assert.strictEqual(room.players.get(p.id).connected, true);
  room.destroy();
});

test('arena battle: rocket hit is a kill, victim respawns, results rank by kills', async () => {
  const { host, players, room } = await makeRoom(4);
  await call(host, 'lobby:settings', { mode: 'kart', kartMode: 'arena', arenaTime: 60, teamMode: true, teamCount: 2 });
  const init = once(host, 'game:kart:init');
  await call(host, 'game:start');
  assert.strictEqual((await init).map, 'arena');

  const game = room.game;
  game.stop();
  game.phase = 'racing';
  game.raceStart = game.time;
  const [a, b] = [game.karts.get(players[0].id), game.karts.get(players[1].id)];
  room.players.get(players[0].id).team = 0;
  room.players.get(players[1].id).team = 1;

  // Put b right in front of a and fire.
  Object.assign(a, { x: 600, y: 1300, angle: 0, speed: 0 });
  Object.assign(b, { x: 680, y: 1300, angle: 0, speed: 0, shield: 0 });
  a.item = 'rocket'; a.ammo = 1;
  const hit = once(host, 'game:kart:hit');
  game.useItem(a);
  for (let i = 0; i < 5; i++) game.simulate(1 / 30);
  const h = await hit;
  assert.strictEqual(h.kill, true);
  assert.strictEqual(a.kills, 1);
  assert.strictEqual(b.deaths, 1);
  assert.ok(b.dead > 0);

  // Respawns with a spawn shield after the timer.
  for (let i = 0; i < 90; i++) game.simulate(1 / 30);
  assert.strictEqual(b.dead <= 0, true);
  assert.ok(b.shield > 0);

  // Teammates are immune to each other's rockets.
  room.players.get(players[1].id).team = 0;
  b.shield = 0; b.invuln = 0;
  Object.assign(a, { x: 600, y: 1300, angle: 0 });
  Object.assign(b, { x: 680, y: 1300, angle: 0, speed: 0 });
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a);
  for (let i = 0; i < 5; i++) game.simulate(1 / 30);
  assert.strictEqual(b.deaths, 1);

  const results = once(host, 'room:state', (s) => s.state === 'results', 8000);
  game.endRace();
  const final = await results;
  assert.strictEqual(final.results.map, 'arena');
  assert.strictEqual(final.results.players[0].id, players[0].id);
  assert.strictEqual(final.results.players[0].score, 100);
  room.destroy();
});

test('arena physics keeps karts inside walls and out of obstacles', () => {
  const K = require('../public/js/shared/kart-core');
  const kart = { x: 200, y: 200, angle: Math.PI * 1.25, speed: 500, boost: 0, spin: 0 };
  for (let i = 0; i < 120; i++) K.stepKart(kart, { up: true }, 1 / 30, 'arena');
  assert.ok(kart.x >= 40 && kart.y >= 40);
  const tower = K.ARENA.obstacles[0];
  const k2 = { x: tower.x - 400, y: tower.y, angle: 0, speed: 500, boost: 0, spin: 0 };
  for (let i = 0; i < 120; i++) K.stepKart(k2, { up: true }, 1 / 30, 'arena');
  assert.ok(Math.hypot(k2.x - tower.x, k2.y - tower.y) >= tower.r + K.KART_RADIUS - 0.01);
});
