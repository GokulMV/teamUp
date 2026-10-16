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
  await call(host, 'lobby:settings', { mode: 'pictionary', pictEveryone: false, pictionaryTurns: 1 });
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
  assert.strictEqual(game.shots.filter((s) => s.kind === 'rocket').length, 1);
  assert.strictEqual(kart.item, null);
  const K = require('../public/js/shared/kart-core');
  for (const k of game.karts.values()) {
    [k.x, k.y] = K.MAPS.grandprix.centerline[5];
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

async function arenaGame(n, settings = {}) {
  const ctx = await makeRoom(n);
  await call(ctx.host, 'lobby:settings', { mode: 'kart', kartMode: 'arena', arenaTime: 60, ...settings });
  const init = once(ctx.host, 'game:kart:init');
  await call(ctx.host, 'game:start');
  ctx.init = await init;
  const game = ctx.room.game;
  game.stop();
  game.phase = 'racing';
  game.raceStart = game.time;
  ctx.game = game;
  ctx.kart = (i) => game.karts.get(ctx.players[i].id);
  // Two karts face to face in open space, nothing protecting them.
  const fresh = { speed: 0, shield: 0, invuln: 0, spin: 0, ghost: 0, angle: 0, heading: 0 };
  ctx.place = (i, x, y) => Object.assign(ctx.kart(i), fresh, { x, y });
  return ctx;
}
const step = (game, n) => { for (let i = 0; i < n; i++) game.simulate(1 / 30); };

test('arena battle: rockets take health, two hits destroy, victim respawns, results rank by kills', async () => {
  const { host, players, room, game, kart, place, init } = await arenaGame(4, { teamMode: true, teamCount: 2 });
  assert.strictEqual(init.map, 'arena');
  assert.strictEqual(init.mapId, 'colosseum');
  const [a, b] = [kart(0), kart(1)];
  room.players.get(players[0].id).team = 0;
  room.players.get(players[1].id).team = 1;

  place(0, 600, 1000); place(1, 680, 1000);
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a);
  step(game, 5);
  assert.strictEqual(b.hp, 30, 'a rocket takes 70 hp');
  assert.strictEqual(b.dead, 0);

  place(0, 600, 1000); place(1, 680, 1000);
  a.item = 'rocket'; a.ammo = 1;
  const kill = once(host, 'game:kart:hit', (h) => h.kill);
  game.useItem(a);
  step(game, 5);
  const h = await kill;
  assert.strictEqual(h.by, a.idx);
  assert.strictEqual(a.kills, 1);
  assert.strictEqual(b.deaths, 1);
  assert.ok(b.dead > 0);

  // Respawns at full health with a spawn shield.
  step(game, 90);
  assert.ok(b.dead <= 0);
  assert.strictEqual(b.hp, 100);
  assert.ok(b.shield > 0);

  // Teammates are immune to each other's weapons.
  room.players.get(players[1].id).team = 0;
  place(0, 600, 1000); place(1, 680, 1000);
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a);
  step(game, 5);
  assert.strictEqual(b.hp, 100);

  const results = once(host, 'room:state', (s) => s.state === 'results', 8000);
  game.endRace();
  const final = await results;
  assert.strictEqual(final.results.map, 'arena');
  assert.strictEqual(final.results.players[0].id, players[0].id);
  assert.strictEqual(final.results.players[0].score, 100);
  room.destroy();
});

test('power-ups: mine, bomb, shock, minigun, shield and ghost', async () => {
  const { room, game, kart, place } = await arenaGame(3);
  const [a, b, c] = [kart(0), kart(1), kart(2)];
  place(2, 2300, 2300); // keep c out of the way

  // Mine: dropped behind, arms, explodes under a rival.
  place(0, 1000, 400); place(1, 1300, 400);
  a.item = 'mine'; a.ammo = 1;
  game.useItem(a);
  assert.strictEqual(game.mines.length, 1);
  step(game, 30); // arm
  Object.assign(b, { x: game.mines[0].x, y: game.mines[0].y });
  step(game, 1);
  assert.strictEqual(game.mines.length, 0);
  assert.ok(b.dead > 0, 'a mine is a one-shot kill');
  step(game, 90);

  // Bomb: lobbed forward, area damage where it lands.
  place(0, 900, 400); place(1, 1450, 400);
  a.item = 'bomb'; a.ammo = 1;
  game.useItem(a);
  step(game, 30);
  assert.ok(b.hp < 100 || b.dead > 0, 'bomb hurt b');

  // Shock: hurts everyone nearby, not far away karts.
  step(game, 90);
  place(0, 1000, 400); place(1, 1200, 400); place(2, 2300, 2300);
  Object.assign(b, { dead: 0, hp: 100 });
  const cHp = c.hp;
  a.item = 'shock'; a.ammo = 1;
  game.useItem(a);
  assert.ok(b.hp <= 55, `shock hit b (${b.hp})`);
  assert.strictEqual(c.hp, cHp);

  // Shield blocks one hit; ghost ignores everything.
  place(0, 1000, 400); place(1, 1080, 400);
  Object.assign(b, { dead: 0, hp: 100, shield: 3 });
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a); step(game, 5);
  assert.strictEqual(b.hp, 100);
  assert.strictEqual(b.shield, 0);
  place(0, 1000, 400); place(1, 1080, 400);
  b.ghost = 3;
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a); step(game, 5);
  assert.strictEqual(b.hp, 100);

  // Minigun: a burst of bullets chips away health.
  place(0, 1000, 400); place(1, 1150, 400);
  a.item = 'minigun'; a.ammo = 1;
  game.useItem(a);
  step(game, 12);
  assert.ok(game.shots.some((s) => s.kind === 'bullet') || b.hp < 100);
  step(game, 30);
  assert.ok(b.hp < 100, `bullets hit b (${b.hp})`);
  room.destroy();
});

test('volcano lava burns karts and credits the last attacker', async () => {
  const { room, game, kart, place } = await arenaGame(2, { kartMap: 'volcano' });
  assert.strictEqual(game.map.id, 'volcano');
  const [a, b] = [kart(0), kart(1)];
  const lava = game.map.hazards[0];
  place(0, 400, 1000); place(1, 480, 1000);
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a); step(game, 5);
  assert.strictEqual(b.hp, 30);
  Object.assign(b, { x: lava.x, y: lava.y, speed: 0 });
  step(game, 1);
  assert.ok(b.dead > 0, 'lava blows b up instantly');
  assert.strictEqual(a.kills, 1, 'the kill goes to whoever hit b last');
  // Full health and a ghost power-up don't save you either.
  step(game, 120);
  assert.ok(b.dead <= 0 && b.hp === 100, 'b respawned');
  Object.assign(a, { x: lava.x, y: lava.y, speed: 0, ghost: 3 });
  step(game, 1);
  assert.ok(a.dead > 0, 'ghosts burn too');
  room.destroy();
});

test('curbs keep full speed and walls are slid along, not stuck to', () => {
  const K = require('../public/js/shared/kart-core');
  const map = K.getMap('grandprix', 'race');
  const dt = 1 / 30;
  const i = 10;
  const [cx, cy] = map.centerline[i];
  const [tx, ty] = (() => { const q = map.centerline[i + 1]; const l = Math.hypot(q[0] - cx, q[1] - cy); return [(q[0] - cx) / l, (q[1] - cy) / l]; })();
  const along = Math.atan2(ty, tx);
  // Riding the curb at full speed: no slowdown.
  const lateral = map.width / 2 + K.CURB - 4;
  const onCurb = { x: cx - ty * lateral, y: cy + tx * lateral, angle: along, speed: K.PHYS.maxSpeed, trackIndex: i };
  for (let n = 0; n < 15; n++) K.stepKart(onCurb, { up: true }, dt, map);
  assert.ok(onCurb.speed > K.PHYS.maxSpeed * 0.97, `curb speed ${onCurb.speed}`);
  // Steering into the outer wall at a shallow angle while holding the throttle keeps most of the speed.
  const wallD = map.width / 2 + K.WALL_PAD - 2;
  const scraper = { x: cx - ty * wallD, y: cy + tx * wallD, angle: along + 0.25, speed: 330, trackIndex: i };
  let minSpeed = Infinity;
  for (let n = 0; n < 30; n++) { K.stepKart(scraper, { up: true }, dt, map); minSpeed = Math.min(minSpeed, scraper.speed); }
  assert.ok(minSpeed > 280, `kart kept moving along the wall (min ${Math.round(minSpeed)})`);
  // Head-on into an arena wall bounces you back a little instead of pinning you.
  const arena = K.getMap('colosseum', 'arena');
  const head = { x: 60, y: 300, angle: Math.PI, speed: 400 };
  K.stepKart(head, {}, dt, arena);
  assert.ok(head.speed < 0 && head.speed > -150, `bounce ${head.speed}`);
});

test('map selection follows the kart mode and every map can be played', async () => {
  const K = require('../public/js/shared/kart-core');
  const { host, room } = await makeRoom(2);
  await call(host, 'lobby:settings', { mode: 'kart', kartMap: 'volcano' });
  assert.strictEqual(room.settings.kartMode, 'arena');
  await call(host, 'lobby:settings', { kartMode: 'race' });
  assert.strictEqual(room.settings.kartMap, 'grandprix');
  await call(host, 'lobby:settings', { kartMap: 'not-a-map' });
  assert.strictEqual(room.settings.kartMap, 'grandprix');

  for (const id of Object.keys(K.MAPS)) {
    await call(host, 'lobby:settings', { kartMap: id });
    const init = once(host, 'game:kart:init');
    await call(host, 'game:start');
    assert.strictEqual((await init).mapId, id);
    const game = room.game;
    game.stop();
    game.phase = 'racing';
    game.raceStart = 0;
    for (const k of game.karts.values()) k.input = { up: true, right: true, drift: true };
    for (let i = 0; i < 300; i++) game.simulate(1 / 30);
    for (const k of game.karts.values()) assert.ok(Number.isFinite(k.x) && Number.isFinite(k.y), `${id}: kart position is finite`);
    room.backToLobby();
  }
  room.destroy();
});

test('physics keeps karts inside arena walls and out of obstacles', () => {
  const K = require('../public/js/shared/kart-core');
  const arena = K.MAPS.colosseum;
  const kart = { x: 200, y: 200, angle: Math.PI * 1.25, speed: 500, boost: 0, spin: 0 };
  for (let i = 0; i < 120; i++) K.stepKart(kart, { up: true }, 1 / 30, arena);
  assert.ok(kart.x >= 40 && kart.y >= 40);
  const tower = arena.obstacles[0];
  const k2 = { x: tower.x - 400, y: tower.y, angle: 0, speed: 500, boost: 0, spin: 0 };
  for (let i = 0; i < 120; i++) K.stepKart(k2, { up: true }, 1 / 30, arena);
  assert.ok(Math.hypot(k2.x - tower.x, k2.y - tower.y) >= tower.r + K.KART_RADIUS - 0.01);
});

test('drifting charges a mini-turbo', () => {
  const K = require('../public/js/shared/kart-core');
  const map = K.MAPS.colosseum;
  const kart = { x: 900, y: 1050, angle: 0, speed: 500, boost: 0, spin: 0 };
  for (let i = 0; i < 60; i++) K.stepKart(kart, { up: true, right: true, drift: true }, 1 / 30, map);
  assert.ok(kart.drift, 'drifting');
  assert.ok(K.driftLevel(kart.driftTime) >= 2);
  K.stepKart(kart, { up: true }, 1 / 30, map);
  assert.ok(!kart.drift);
  assert.ok(kart.boost > 0.8, 'released into a mini-turbo');
});

test('profiles: players pick an avatar on join and can change name/avatar in the lobby', async () => {
  const host = client();
  const res = await call(host, 'room:create', { name: 'Host', avatar: 5 });
  const room = rooms.rooms.get(res.code);
  assert.strictEqual(room.players.get(res.playerId).avatar, 5);
  const guest = client();
  const g = await call(guest, 'room:join', { code: res.code, name: 'Guest', avatar: 999 });
  assert.ok(room.players.get(g.playerId).avatar >= 0 && room.players.get(g.playerId).avatar < 24, 'out-of-range avatars are clamped');
  const r = await call(guest, 'lobby:profile', { avatar: 11, name: 'Renamed' });
  assert.deepStrictEqual([r.avatar, r.name], [11, 'Renamed']);
  const clash = await call(guest, 'lobby:profile', { name: 'host' });
  assert.strictEqual(clash.name, 'Renamed', 'names stay unique');
  room.destroy();
});

test('pictionary options: everyone draws each round, custom words, combo and hidden modes, ratings', async () => {
  const { host, players, room } = await makeRoom(3);
  await call(host, 'lobby:settings', {
    mode: 'pictionary', pictEveryone: true, pictRounds: 2, wordChoices: 2, hints: 0,
    customWords: 'teamup, moonlit cove, karting', customOnly: true,
  });
  await call(host, 'game:start');
  const game = room.game;
  assert.strictEqual(game.totalTurns, 6, '2 rounds x 3 players');
  assert.strictEqual(game.options.length, 2);
  assert.ok(game.options.every((w) => ['teamup', 'moonlit cove', 'karting'].includes(w)), `custom words only: ${game.options}`);

  // Everyone draws once in round 1.
  const drawers = new Set();
  for (let i = 0; i < 3; i++) {
    drawers.add(game.drawerId);
    game.chooseWord(game.options[0]);
    // Rate the drawing from a guesser.
    const rater = players.find((p) => p.id !== game.drawerId);
    const before = game.scores.get(game.drawerId) || 0;
    const r = await call(rater.socket, 'game:rate', { like: true });
    assert.ok(r.ok);
    assert.strictEqual(game.scores.get(game.drawerId), before + 10);
    game.endTurn();
    clearTimeout(game.timer);
    if (i < 2) game.nextTurn();
  }
  assert.strictEqual(drawers.size, 3, 'each player drew once in the round');
  room.destroy();

  // Combo and hidden word modes.
  const ctx2 = await makeRoom(2);
  await call(ctx2.host, 'lobby:settings', { mode: 'pictionary', wordMode: 'combo', wordChoices: 3 });
  await call(ctx2.host, 'game:start');
  assert.ok(ctx2.room.game.options.every((w) => w.split(' ').length >= 2), 'combination words');
  ctx2.room.backToLobby();
  await call(ctx2.host, 'lobby:settings', { wordMode: 'hidden' });
  await call(ctx2.host, 'game:start');
  const g2 = ctx2.room.game;
  g2.chooseWord(g2.options[0]);
  assert.strictEqual(g2.mask(), '? ? ?', 'hidden mode never shows the length');
  ctx2.room.destroy();
});

test('pictionary fill operations are accepted and relayed', async () => {
  const { host, players, room } = await makeRoom(2);
  await call(host, 'lobby:settings', { mode: 'pictionary', pictEveryone: false, pictionaryTurns: 1 });
  await call(host, 'game:start');
  const game = room.game;
  game.chooseWord(game.options[0]);
  const drawer = players.find((p) => p.id === game.drawerId);
  const other = players.find((p) => p.id !== game.drawerId);
  const got = once(other.socket, 'game:pict:stroke');
  drawer.socket.emit('game:stroke', { id: 'f1', fill: true, x: 0.5, y: 0.5, color: '#22c55e' });
  const op = await got;
  assert.deepStrictEqual(op, { id: 'f1', fill: true, x: 0.5, y: 0.5, color: '#22c55e' });
  room.destroy();
});

test('telephone modes: knock-off is all drawing with a memorise time; speedrun is fast; auto reveal and reactions', async () => {
  const { host, players, room } = await makeRoom(3);
  await call(host, 'lobby:settings', { mode: 'telephone', telMode: 'knockoff', telReveal: 'auto' });
  const tasks = players.map((p) => once(p.socket, 'game:tel:task'));
  await call(host, 'game:start');
  const first = await Promise.all(tasks);
  assert.ok(first.every((t) => t.type === 'draw' && t.memorize === 0));
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const second = players.map((p) => once(p.socket, 'game:tel:task'));
  for (const p of players) await call(p.socket, 'game:submit', { image: png });
  const t2 = await Promise.all(second);
  assert.ok(t2.every((t) => t.type === 'draw' && t.memorize === 6 && t.prev.content === png));

  // Jump to the reveal and react.
  const game = room.game;
  game.step = game.steps - 1;
  game.phase = 'play';
  for (const b of game.books) for (let i = 0; i < game.steps; i++) b.entries[i] = b.entries[i] || { type: 'draw', by: b.owner, content: png };
  const reveal = once(host, 'game:tel:reveal');
  game.forceAdvance();
  const rv = await reveal;
  assert.strictEqual(rv.auto, true);
  const react = once(host, 'game:tel:react');
  await call(players[1].socket, 'game:react', { emoji: '😂' });
  assert.strictEqual((await react).emoji, '😂');
  const next = once(host, 'game:tel:reveal', (r) => r.entries.length === 2 || r.bookIndex === 1, 6000);
  await next; // advanced on its own
  room.destroy();

  const ctx2 = await makeRoom(2);
  await call(ctx2.host, 'lobby:settings', { mode: 'telephone', telMode: 'speedrun' });
  await call(ctx2.host, 'game:start');
  assert.ok(ctx2.room.game.stepTime(0) <= 20, `speedrun write step is short (${ctx2.room.game.stepTime(0)}s)`);
  ctx2.room.destroy();
});

// ---------- Kart options and CPU drivers ----------
async function kartGame(n, settings = {}) {
  const ctx = await makeRoom(n);
  const r = await call(ctx.host, 'lobby:settings', { mode: 'kart', ...settings });
  assert.ok(r.ok, r.error);
  const init = once(ctx.host, 'game:kart:init');
  const started = await call(ctx.host, 'game:start');
  assert.ok(started.ok, started.error);
  ctx.init = await init;
  const game = ctx.room.game;
  game.stop();
  game.phase = 'racing';
  game.raceStart = game.time;
  ctx.game = game;
  ctx.bots = () => [...game.karts.values()].filter((k) => k.bot);
  ctx.run = (seconds) => { for (let i = 0; i < seconds * 30; i++) { game.time += 1 / 30; game.simulate(1 / 30); } };
  return ctx;
}

test('kart settings: defaults and strict validation (bad values are ignored)', async () => {
  const K = require('../public/js/shared/kart-core');
  const { host, room } = await makeRoom(2);
  const s = room.settings;
  const snapshot = () => [s.kartBots, s.kartBotSkill, s.kartClass, s.kartItems, s.kartBoxRespawn, s.kartCatchup, s.kartReverse,
    s.arenaKillLimit, s.arenaRespawn, s.arenaHealth];
  assert.deepStrictEqual(snapshot(), [0, 'normal', 'standard', 'all', 'normal', true, false, 0, 'normal', 'normal']);
  assert.deepStrictEqual(s.kartItemList, K.ITEMS);

  await call(host, 'lobby:settings', {
    kartBots: 7, kartBotSkill: 'hard', kartClass: 'turbo', kartItems: 'custom', kartItemList: ['rocket', 'nope', 'banana', 'rocket', 42],
    kartBoxRespawn: 'frequent', kartCatchup: false, kartReverse: true, arenaKillLimit: 10, arenaRespawn: 'fast', arenaHealth: 'high',
  });
  const expected = [7, 'hard', 'turbo', 'custom', 'frequent', false, true, 10, 'fast', 'high'];
  assert.deepStrictEqual(snapshot(), expected);
  assert.deepStrictEqual(s.kartItemList, ['rocket', 'banana'], 'unknown ids dropped, no duplicates');

  for (const bad of [
    { kartBots: 16 }, { kartBots: -1 }, { kartBots: 2.5 }, { kartBots: 'lots' }, { kartBots: null },
    { kartBotSkill: 'insane' }, { kartClass: 'warp' }, { kartClass: 3 }, { kartItems: 'some' },
    { kartItemList: 'rocket' }, { kartBoxRespawn: 'never' }, { kartCatchup: 'no' }, { kartReverse: 1 },
    { arenaKillLimit: 7 }, { arenaKillLimit: 100 }, { arenaKillLimit: 'ten' }, { arenaRespawn: 'instant' }, { arenaHealth: 9000 },
  ]) {
    await call(host, 'lobby:settings', bad);
  }
  assert.deepStrictEqual(snapshot(), expected);
  assert.deepStrictEqual(s.kartItemList, ['rocket', 'banana']);
  await call(host, 'lobby:settings', { kartBots: '3', arenaKillLimit: 0, kartItemList: [] });
  assert.strictEqual(s.kartBots, 3, 'numeric strings from <select>s are accepted');
  assert.strictEqual(s.arenaKillLimit, 0);
  assert.deepStrictEqual(s.kartItemList, []);
  room.destroy();
});

test('CPU drivers join the race and lap the grand prix at hard', async () => {
  const { room, init, game, bots, run, players } = await kartGame(1, { kartMap: 'grandprix', kartBots: 5, kartBotSkill: 'hard', kartLaps: 3 });
  assert.strictEqual(init.karts.length, 6);
  const human = init.karts.find((k) => k.id === players[0].id);
  assert.ok(Number.isInteger(human.avatar), 'humans carry their avatar');
  assert.ok(!human.bot);
  const botMeta = init.karts.filter((k) => k.bot);
  assert.strictEqual(botMeta.length, 5);
  for (const b of botMeta) {
    assert.match(b.id, /^bot:\d+$/);
    assert.ok(b.name && b.color && Number.isInteger(b.avatar) && b.avatar >= 0 && b.avatar < 24);
  }
  assert.strictEqual(new Set(botMeta.map((b) => b.name)).size, 5, 'bot names are unique');

  const start = new Map(bots().map((k) => [k.id, [k.x, k.y]]));
  run(75);
  assert.strictEqual(game.botError, false);
  for (const k of bots()) {
    assert.ok(Number.isFinite(k.x) && Number.isFinite(k.y), `${k.name} position is finite`);
    const [x0, y0] = start.get(k.id);
    assert.ok(Math.hypot(k.x - x0, k.y - y0) > 100 || k.lap > 1, `${k.name} moved`);
    assert.ok(k.lap >= 2, `${k.name} completed a lap within 75 s (lap ${k.lap})`);
  }
  room.destroy();
});

test('CPU drivers fight in the arena without errors and stay balanced across teams', async () => {
  const { room, init, game, bots, run } = await kartGame(2, {
    kartMode: 'arena', kartMap: 'volcano', kartBots: 8, kartBotSkill: 'hard', teamMode: true, teamCount: 2, arenaTime: 300,
  });
  assert.strictEqual(init.karts.length, 10);
  const perTeam = [0, 0];
  for (const k of init.karts) perTeam[k.team]++;
  assert.deepStrictEqual(perTeam, [5, 5], 'bots fill the smaller team first');
  run(60);
  assert.strictEqual(game.botError, false);
  for (const k of game.karts.values()) assert.ok(Number.isFinite(k.x) && Number.isFinite(k.y) && Number.isFinite(k.hp));
  const kills = bots().reduce((sum, k) => sum + k.kills, 0);
  assert.ok(kills > 0, 'bots destroyed someone');
  room.destroy();
});

test('kart items: none removes the boxes, weapons only rolls weapons, custom list is respected', async () => {
  const K = require('../public/js/shared/kart-core');
  const ctx = await kartGame(2, { kartMap: 'grandprix', kartItems: 'none' });
  assert.strictEqual(ctx.init.items, false);
  assert.strictEqual(ctx.game.boxes.length, 0);
  const state = once(ctx.host, 'game:kart:state');
  ctx.game.broadcast();
  assert.deepStrictEqual((await state).x, []);
  const kart = ctx.game.karts.get(ctx.players[0].id);
  Object.assign(kart, { x: K.MAPS.grandprix.itemBoxes[0].x, y: K.MAPS.grandprix.itemBoxes[0].y });
  ctx.run(0.2);
  assert.strictEqual(kart.item, null);
  ctx.room.destroy();

  for (const kartMode of ['race', 'arena']) {
    const c = await kartGame(3, { kartMode, kartItems: 'weapons' });
    const seen = new Set();
    for (const k of c.game.karts.values()) for (let i = 0; i < 400; i++) seen.add(c.game.rollItem(k));
    for (const banned of ['boost', 'shield', 'ghost', 'banana']) assert.ok(!seen.has(banned), `${kartMode}: weapons mode rolled ${banned}`);
    assert.ok(seen.has('rocket') && seen.has('minigun'));
    c.room.destroy();
  }

  const c2 = await kartGame(2, { kartMode: 'arena', kartItems: 'custom', kartItemList: ['ghost', 'shock'] });
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(c2.game.rollItem(c2.game.karts.get(c2.players[0].id)));
  assert.deepStrictEqual([...seen].sort(), ['ghost', 'shock']);
  c2.room.destroy();

  const c3 = await kartGame(2, { kartItems: 'custom', kartItemList: [] });
  assert.strictEqual(c3.game.boxes.length, 0, 'an empty custom list means no item boxes');
  assert.strictEqual(c3.init.items, false);
  c3.room.destroy();
});

test('kart catch-up off: item odds no longer depend on race position', async () => {
  const roll = async (kartCatchup) => {
    const c = await kartGame(2, { kartItems: 'custom', kartItemList: ['triple', 'banana'], kartCatchup });
    const [a, b] = [c.game.karts.get(c.players[0].id), c.game.karts.get(c.players[1].id)];
    a.progress = 500; b.progress = 0; // a leads
    let triples = 0;
    for (let i = 0; i < 400; i++) if (c.game.rollItem(a) === 'triple') triples++;
    c.room.destroy();
    return triples;
  };
  assert.strictEqual(await roll(true), 0, 'the leader never gets triple rockets with catch-up');
  assert.ok(await roll(false) > 0, 'without catch-up the leader can get them');
});

test('arena kill limit ends the battle (per player and per team)', async () => {
  const solo = await kartGame(2, { kartMode: 'arena', arenaKillLimit: 5 });
  assert.strictEqual(solo.init.killLimit, 5);
  const [a, b] = solo.players.map((p) => solo.game.karts.get(p.id));
  a.kills = 4;
  Object.assign(b, { shield: 0, invuln: 0, ghost: 0 });
  const results = once(solo.host, 'room:state', (st) => st.state === 'results', 8000);
  solo.game.damage(b, 999, a, 'rocket');
  assert.strictEqual(a.kills, 5);
  assert.strictEqual(solo.game.phase, 'done');
  assert.strictEqual((await results).results.players[0].id, solo.players[0].id);
  solo.room.destroy();

  const team = await kartGame(4, { kartMode: 'arena', arenaKillLimit: 5, teamMode: true, teamCount: 2 });
  const k = team.players.map((p) => team.game.karts.get(p.id));
  team.players.forEach((p, i) => { team.room.players.get(p.id).team = i < 2 ? 0 : 1; });
  k[0].kills = 2; k[1].kills = 2;
  Object.assign(k[2], { shield: 0, invuln: 0, ghost: 0 });
  team.game.damage(k[2], 999, k[0], 'rocket');
  assert.strictEqual(k[0].kills, 3);
  assert.strictEqual(team.game.phase, 'done', 'team total reached 5');
  team.room.destroy();
});

test('arena health and respawn options', async () => {
  const high = await kartGame(2, { kartMode: 'arena', arenaHealth: 'high', arenaRespawn: 'slow' });
  const [a, b] = high.players.map((p) => high.game.karts.get(p.id));
  assert.strictEqual(b.hp, 150);
  assert.strictEqual(high.init.hpMax, 150);
  Object.assign(b, { shield: 0, invuln: 0 });
  high.game.damage(b, 70, a, 'rocket');
  assert.strictEqual(b.hp, 80, 'a rocket no longer takes half your health');
  const state = once(high.host, 'game:kart:state');
  high.game.broadcast();
  const row = (await state).k.find((r) => r[0] === b.idx);
  assert.strictEqual(row[12], 53, 'hp is sent as a percentage');
  b.invuln = 0;
  high.game.damage(b, 999, a, 'rocket');
  assert.strictEqual(b.dead, 4, 'slow respawn');
  high.run(4.1);
  assert.strictEqual(b.hp, 150, 'respawns at full (high) health');
  high.room.destroy();

  const low = await kartGame(2, { kartMode: 'arena', arenaHealth: 'low', arenaRespawn: 'fast' });
  const [c, d] = low.players.map((p) => low.game.karts.get(p.id));
  assert.strictEqual(d.hp, 60);
  Object.assign(d, { shield: 0, invuln: 0 });
  low.game.damage(d, 70, c, 'rocket');
  assert.ok(d.dead > 0, 'one rocket destroys a low-health kart');
  assert.strictEqual(d.dead, 1.5);
  low.room.destroy();
});

test('kart speed class scales top speed on the server and in shared physics', async () => {
  const K = require('../public/js/shared/kart-core');
  const flat = { type: 'arena', size: 1e6, obstacles: [], hazards: [], boostPads: [] };
  const top = (speed) => {
    const kart = { x: 1000, y: 1000, angle: 0, speed: 0, boost: 0, spin: 0 };
    for (let i = 0; i < 300; i++) K.stepKart(kart, { up: true }, 1 / 30, flat, speed === undefined ? undefined : { speed });
    return kart.speed;
  };
  assert.ok(Math.abs(top() - K.PHYS.maxSpeed) < 1);
  assert.ok(Math.abs(top(1) - K.PHYS.maxSpeed) < 1);
  assert.ok(Math.abs(top(0.82) - K.PHYS.maxSpeed * 0.82) < 1);
  assert.ok(Math.abs(top(1.18) - K.PHYS.maxSpeed * 1.18) < 1);

  const turbo = await kartGame(1, { kartMode: 'arena', kartClass: 'turbo' });
  assert.strictEqual(turbo.init.speedMul, 1.18);
  const k = turbo.game.karts.get(turbo.players[0].id);
  Object.assign(k, { x: 1300, y: 300, angle: 0, heading: 0, speed: 0 });
  k.input = { up: true };
  turbo.run(1.2);
  assert.ok(k.speed > K.PHYS.maxSpeed * 1.05, `turbo karts go faster (${Math.round(k.speed)})`);
  turbo.room.destroy();
  const chill = await kartGame(1, { kartClass: 'chill' });
  assert.strictEqual(chill.init.speedMul, 0.82);
  chill.room.destroy();
});

test('reverse races: mirrored map, laps count the other way round', async () => {
  const K = require('../public/js/shared/kart-core');
  const fwd = K.getMap('grandprix', 'race');
  const rev = K.getMap('grandprix', 'race', { reverse: true });
  assert.strictEqual(rev, K.getMap('grandprix', 'race', { reverse: true }), 'cached');
  assert.strictEqual(K.MAPS.grandprix, fwd, 'the catalogue keeps the forward map');
  assert.ok(rev.reverse && !fwd.reverse);
  assert.deepStrictEqual(rev.centerline[0], fwd.centerline[0], 'start line stays put');
  assert.deepStrictEqual(rev.centerline[1], fwd.centerline[fwd.n - 1]);
  assert.ok(rev.tangents[5][0] * fwd.tangents[fwd.n - 6][0] + rev.tangents[5][1] * fwd.tangents[fwd.n - 6][1] < -0.99);
  assert.strictEqual(rev.itemBoxes.length, fwd.itemBoxes.length);
  for (const b of rev.itemBoxes) assert.ok(!rev.offTrack(b.x, b.y), 'item boxes on the track');
  for (const p of rev.boostPads) assert.ok(!rev.offTrack(p.x, p.y), 'boost pads on the track');
  assert.strictEqual(K.getMap('colosseum', 'arena', { reverse: true }), K.MAPS.colosseum, 'arenas ignore reverse');

  const { room, init, game, players, run, bots } = await kartGame(1, { kartMap: 'grandprix', kartReverse: true, kartLaps: 1, kartBots: 3, kartBotSkill: 'hard' });
  assert.strictEqual(init.reverse, true);
  assert.strictEqual(game.map, rev);
  // The grid sits just behind the start line and faces the reversed direction.
  const me = game.karts.get(players[0].id);
  const t = rev.tangents[me.trackIndex];
  assert.ok(Math.cos(me.angle) * t[0] + Math.sin(me.angle) * t[1] > 0.99);
  assert.ok(me.trackIndex > rev.n - 20);
  // Bots drive the reversed circuit and finish the lap (~50 s laps on the big tracks).
  run(75);
  assert.ok(bots().every((k) => k.finished), `bots finished: ${bots().map((k) => k.lap)}`);
  // Driving the forward direction across the line does not count as a lap.
  Object.assign(me, { lap: 1, finished: false });
  me.trackIndex = rev.n - 3;
  game.trackLaps(me, 3);
  assert.strictEqual(me.lap, 0);
  room.destroy();
});

test('results include CPU drivers with their stats and team scores', async () => {
  const { host, room, game, bots } = await kartGame(2, { kartMode: 'arena', kartBots: 3, teamMode: true, teamCount: 2 });
  const [b1] = bots();
  b1.kills = 3;
  const results = once(host, 'room:state', (st) => st.state === 'results', 8000);
  game.endRace();
  const final = (await results).results;
  assert.strictEqual(final.players.length, 5);
  const botRows = final.players.filter((p) => p.bot);
  assert.strictEqual(botRows.length, 3);
  for (const p of botRows) assert.ok(p.name && p.color && Number.isInteger(p.avatar) && Number.isInteger(p.team));
  assert.strictEqual(final.players[0].id, b1.id);
  assert.strictEqual(final.players[0].score, 300);
  assert.strictEqual(final.players[0].kills, 3);
  const team = final.teams.find((tm) => tm.id === b1.team);
  assert.strictEqual(team.score, 300);
  assert.strictEqual(final.teams.reduce((sum, tm) => sum + tm.members, 0), 5);
  room.destroy();
});

// ---------- Race tracks: scale, heights, jumps, falls ----------
const raceIds = () => {
  const K = require('../public/js/shared/kart-core');
  return Object.keys(K.MAPS).filter((id) => K.MAPS[id].type === 'race');
};

test('race tracks are long, wide and never cross or crowd themselves', () => {
  const K = require('../public/js/shared/kart-core');
  const ids = raceIds();
  assert.ok(ids.length >= 6, 'six race tracks');
  for (const id of ['coast', 'lavapeak']) {
    const m = K.MAPS[id];
    assert.ok(m && m.type === 'race' && m.name && m.emoji && m.theme && m.blurb, `${id} is a full race map`);
  }
  for (const id of ids) {
    for (const reverse of [false, true]) {
      const m = K.getMap(id, 'race', { reverse });
      assert.ok(m.length >= 16000 && m.length <= 22000, `${id}: lap ${Math.round(m.length)} units`);
      assert.ok(m.width >= 260, `${id}: width ${m.width}`);
      assert.ok(m.spacing > 24 && m.spacing < 40, `${id}: sample spacing ${m.spacing}`);
      // Stretches that are far apart along the lap are far apart on the ground: walls never meet.
      const skip = Math.ceil(2600 / m.spacing);
      for (let i = 0; i < m.n; i += 2) {
        for (let j = i + skip; j < m.n; j += 2) {
          if (m.n - (j - i) < skip) continue;
          const d = Math.hypot(m.centerline[i][0] - m.centerline[j][0], m.centerline[i][1] - m.centerline[j][1]);
          assert.ok(d > m.wallD[i] + m.wallD[j] + 60, `${id}: samples ${i}/${j} only ${Math.round(d)} apart`);
        }
      }
      const heights = Array.from(m.heights);
      assert.ok(Math.max(...heights) - Math.min(...heights) > 150, `${id}: real elevation changes`);
      // Item boxes and boost pads sit on solid road, never over a gap.
      for (const b of [...m.itemBoxes, ...m.boostPads]) {
        const q = m.nearestIndex(b.x, b.y);
        assert.ok(q.dist <= m.width / 2 && !m.gap[q.index], `${id}: box/pad on the road`);
      }
    }
  }
});

test('heightAt is smooth along and across the road; arenas are flat', () => {
  const K = require('../public/js/shared/kart-core');
  for (const id of raceIds()) {
    const m = K.MAPS[id];
    let hint = 0;
    let prev = null;
    // Along the centre line, 4 units at a time (gaps are meant to be jumped).
    for (let i = 0; i < m.n; i++) {
      const [ax, ay] = m.centerline[i];
      const [bx, by] = m.centerline[(i + 1) % m.n];
      for (let s = 0; s < 8; s++) {
        const x = ax + ((bx - ax) * s) / 8;
        const y = ay + ((by - ay) * s) / 8;
        const q = m.nearestIndex(x, y, hint);
        hint = q.index;
        const h = m.surfaceAt(x, y, q) - m.bumpAt(q); // ramps are meant to be steep
        assert.ok(Number.isFinite(h), `${id}: finite height`);
        if (prev !== null && !m.gap[q.index]) assert.ok(Math.abs(h - prev) < 3, `${id}: height jumps ${(h - prev).toFixed(1)} at sample ${i}`);
        prev = h;
      }
    }
    // Across the road out to the wall: no steps.
    for (let i = 0; i < m.n; i += 7) {
      if (m.bridge[i] || m.gap[i] || m.railed[i]) continue;
      const t = m.tangents[i];
      for (const side of [1, -1]) {
        let last = null;
        for (let d = 0; d <= m.wallD[i]; d += 4) {
          const x = m.centerline[i][0] - t[1] * d * side;
          const y = m.centerline[i][1] + t[0] * d * side;
          const h = m.heightAt(x, y, i);
          if (last !== null) assert.ok(Math.abs(h - last) < 8, `${id}: step of ${(h - last).toFixed(1)} across the road at ${i}, ${d}`);
          last = h;
        }
      }
    }
  }
  assert.strictEqual(K.MAPS.colosseum.heightAt(500, 500), 0);
  assert.strictEqual(K.getMap('volcano', 'arena').heightAt(1300, 1300), 0);
});

// Drive a kart along the road from `from` samples before sample `i0`.
function driveTo(K, map, i0, opts = {}) {
  const n = map.n;
  const start = (i0 - (opts.from || 20) + n) % n;
  const p = map.centerline[start];
  const t = map.tangents[start];
  const kart = { x: p[0], y: p[1], angle: Math.atan2(t[1], t[0]), speed: opts.speed || K.PHYS.maxSpeed, boost: 0, spin: 0, trackIndex: start };
  const log = [];
  for (let s = 0; s < (opts.steps || 90); s++) {
    if (kart.fall > 0) { log.push({ air: 0, boost: 0, trick: 0, fall: kart.fall, speed: 0 }); break; }
    const q = map.nearestIndex(kart.x, kart.y, kart.trackIndex);
    const ahead = map.trackPoint(q.index + 6, opts.lateral || 0);
    let err = Math.atan2(ahead[1] - kart.y, ahead[0] - kart.x) - kart.angle;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const input = { up: true, left: err < -0.03, right: err > 0.03, drift: !!(opts.trick && kart.air > 0) };
    if (opts.input) Object.assign(input, opts.input(kart));
    K.stepKart(kart, input, 1 / 30, map, opts.physics);
    log.push({ air: kart.air || 0, boost: kart.boost, trick: kart.trick || 0, fall: kart.fall || 0, speed: kart.speed });
  }
  return { kart, log };
}

test('ramps launch karts; a trick in the air pays out a mini boost; reversed they are just bumps', () => {
  const K = require('../public/js/shared/kart-core');
  const map = K.MAPS.grandprix;
  const ramp = map.ramps.find((r) => r.dir === 1);
  const plain = driveTo(K, map, ramp.i, { steps: 70 });
  const airtime = plain.log.filter((l) => l.air > 0).length / 30;
  assert.ok(Math.max(...plain.log.map((l) => l.air)) > 50, 'big air off the ramp');
  assert.ok(airtime > 0.5, `airtime ${airtime.toFixed(2)} s`);
  assert.ok(!plain.log.some((l) => l.trick > 0), 'no trick without pressing drift');
  const landed = plain.log.findIndex((l, i) => i > 0 && plain.log[i - 1].air > 0 && l.air === 0);
  assert.ok(landed > 0 && plain.log[landed].boost === 0, 'no boost without a trick');

  const trick = driveTo(K, map, ramp.i, { steps: 70, trick: true });
  assert.ok(trick.log.some((l) => l.trick > 0), 'drift in the air = trick');
  const land2 = trick.log.findIndex((l, i) => i > 0 && trick.log[i - 1].air > 0 && l.air === 0);
  assert.ok(land2 > 0 && trick.log[land2].boost > 0.4, `trick landing boost ${trick.log[land2] && trick.log[land2].boost}`);

  // Steering is reduced in the air.
  const [px, py] = map.centerline[ramp.i];
  const flying = { x: px, y: py, angle: 0, speed: 400, air: 50, z: 300, vz: 300, trackIndex: ramp.i };
  const driving = { x: px, y: py, angle: 0, speed: 400, trackIndex: ramp.i };
  K.stepKart(flying, { right: true }, 1 / 30, map);
  K.stepKart(driving, { right: true }, 1 / 30, map);
  assert.ok(Math.abs(flying.angle) < Math.abs(driving.angle) * 0.6, 'less steering in the air');

  // Driven backwards the same ramp is only a bump.
  const rev = K.getMap('grandprix', 'race', { reverse: true });
  const back = rev.ramps.find((r) => r.dir === -1 && !r.gap);
  const bump = driveTo(K, rev, (back.i + 6) % rev.n, { steps: 50 });
  assert.ok(Math.max(...bump.log.map((l) => l.air)) < 25, `reverse ramp hop ${Math.max(...bump.log.map((l) => l.air)).toFixed(1)}`);
});

test('gap jumps are cleared at speed in every class; slopes slow climbs and speed descents', () => {
  const K = require('../public/js/shared/kart-core');
  for (const id of ['canyon', 'neon', 'lavapeak']) {
    for (const reverse of [false, true]) {
      const map = K.getMap(id, 'race', { reverse });
      const gaps = map.ramps.filter((x) => x.gap && x.dir === 1);
      assert.ok(gaps.length >= 1, `${id}: has gap jumps`);
      for (const r of gaps) {
        for (const speed of [0.82, 1, 1.18]) {
          const { log } = driveTo(K, map, r.i, { steps: 60, speed: K.PHYS.maxSpeed * speed, physics: { speed } });
          assert.ok(!log.some((l) => l.fall > 0), `${id}${reverse ? ' rev' : ''}: cleared the gap at class ${speed}`);
        }
        // Crawling up to it: you drop in.
        const slow = driveTo(K, { ...map, boostPads: [] }, r.i, { steps: 60, speed: 150, from: 1 });
        assert.ok(slow.log.some((l) => l.fall > 0), `${id}: too slow to clear the gap`);
      }
    }
  }
  // Uphill top speed < flat < downhill top speed.
  const map = K.MAPS.frost;
  let up = 0;
  let down = 0;
  for (let i = 0; i < map.n; i++) {
    if (map.grade[i] > map.grade[up]) up = i;
    if (map.grade[i] < map.grade[down]) down = i;
  }
  const top = (i) => {
    const p = map.centerline[i];
    const t = map.tangents[i];
    const k = { x: p[0], y: p[1], angle: Math.atan2(t[1], t[0]), speed: K.PHYS.maxSpeed, boost: 0, spin: 0, trackIndex: i };
    for (let s = 0; s < 4; s++) K.stepKart(k, { up: true }, 1 / 30, map);
    return k.speed;
  };
  assert.ok(top(up) < K.PHYS.maxSpeed - 5, `uphill ${top(up)}`);
  assert.ok(top(down) > K.PHYS.maxSpeed + 5, `downhill ${top(down)}`);
});

test('falling into water, lava or a gap fishes you back onto the road', async () => {
  const K = require('../public/js/shared/kart-core');
  // Shared physics: steer off the beach into the sea.
  const coast = K.MAPS.coast;
  const i0 = Math.floor(coast.n * 0.05);
  const { kart } = driveTo(K, coast, i0, { from: 2, steps: 80, lateral: 3.5 });
  assert.strictEqual(kart.fallKind, 'water');
  for (let s = 0; s < 60 && kart.fall > 0; s++) K.stepKart(kart, {}, 1 / 30, coast);
  assert.ok(!(kart.fall > 0), 'fished out after ~1.5 s');
  const q = coast.nearestIndex(kart.x, kart.y, kart.trackIndex);
  assert.ok(q.dist < 2 && kart.speed === 0, 'back on the centre of the road, stopped');
  const t = coast.tangents[q.index];
  assert.ok(Math.cos(kart.angle) * t[0] + Math.sin(kart.angle) * t[1] > 0.99, 'facing the right way');
  const off = (q.index - i0 + coast.n) % coast.n;
  assert.ok(Math.min(off, coast.n - off) < 25, `near where it fell in (${off})`);
  // Client prediction never starts a fall on its own.
  const pred = driveTo(K, coast, i0, { from: 2, steps: 80, lateral: 3.5, physics: { noFall: true } });
  assert.ok(!(pred.kart.fall > 0));

  // Server: event, snapshot fields, invulnerability, no hits while falling.
  const { room, game, players, host } = await kartGame(1, { kartMap: 'lavapeak' });
  const me = game.karts.get(players[0].id);
  const lavaRamp = game.map.ramps.find((r) => r.gap && r.dir === 1);
  const gapAt = (lavaRamp.i + 2) % game.map.n;
  const fall = once(host, 'game:kart:fall');
  Object.assign(me, { x: game.map.centerline[gapAt][0], y: game.map.centerline[gapAt][1], speed: 0, trackIndex: gapAt, air: 0, z: null, safeIndex: (lavaRamp.i - 30 + game.map.n) % game.map.n });
  game.simulate(1 / 30);
  const ev = await fall;
  assert.strictEqual(ev.kind, 'lava');
  assert.ok(me.fall > 0);
  const state = once(host, 'game:kart:state');
  game.broadcast();
  const row = (await state).k.find((r) => r[0] === me.idx);
  assert.strictEqual(row.length, 15, 'air and fx appended to the kart row');
  assert.ok(row[14] & 1 && row[14] & 4, 'falling into lava');
  Object.assign(me, { shield: 0, invuln: 0, ghost: 0 });
  game.damage(me, 50, null, 'rocket');
  assert.strictEqual(me.spin, 0, 'no hits while falling');
  for (let s = 0; s < 60 && me.fall > 0; s++) game.simulate(1 / 30);
  assert.ok(!(me.fall > 0) && me.invuln > 0, 'respawned with a moment of invulnerability');
  const back = game.map.nearestIndex(me.x, me.y);
  assert.ok(back.dist < 2 && !game.map.gap[back.index]);
  for (let a = 1; a <= 16; a++) assert.ok(!game.map.gap[(back.index + a) % game.map.n], 'a run-up of road before the gap');
  room.destroy();
});

test('CPU drivers lap every race track, forward and reversed', async () => {
  for (const id of raceIds()) {
    for (const kartReverse of [false, true]) {
      const { room, game, bots } = await kartGame(1, { kartMap: id, kartReverse, kartBots: 4, kartBotSkill: 'normal', kartLaps: 1, kartItems: 'none' });
      assert.strictEqual(game.map.id, id);
      for (let i = 0; i < 30 * 80 && !bots().every((k) => k.finished); i++) { game.time += 1 / 30; game.simulate(1 / 30); }
      assert.strictEqual(game.botError, false);
      for (const k of bots()) {
        assert.ok(k.finished, `${id}${kartReverse ? ' (reversed)' : ''}: ${k.name} finished (lap ${k.lap}, at ${(k.trackIndex / game.map.n).toFixed(2)})`);
        assert.ok(k.finishTime > 30 && k.finishTime < 80, `${id}: ${k.name} took ${k.finishTime.toFixed(1)} s`);
      }
      room.destroy();
    }
  }
});
