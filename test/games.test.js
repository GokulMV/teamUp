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
