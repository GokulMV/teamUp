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
      const payload = t.type === 'draw' ? { step, image: png } : { step, text: `text from ${i} at ${step}` };
      if (step > 0) assert.ok(t.prev, 'later steps see the previous entry');
      const r = await call(players[i].socket, 'game:submit', payload);
      assert.ok(r.ok);
    }
    current = await Promise.all(next);
  }

  let reveal = current[0];
  assert.strictEqual(reveal.bookCount, 3);
  // A new album comes with its first entry; each page after that brings only the new one.
  let album = reveal.entries.slice();
  const states = once(host, 'room:state', (s) => s.state === 'results', 10000);
  while (!reveal.last) {
    const nextReveal = once(host, 'game:tel:reveal');
    await call(host, 'game:next', { book: reveal.bookIndex, entry: reveal.entryIndex });
    reveal = await nextReveal;
    if (reveal.entries) album = reveal.entries.slice();
    else album.push(reveal.entry);
  }
  assert.strictEqual(album.length, 3);
  assert.deepStrictEqual(album.map((e) => e.type), ['write', 'draw', 'describe']);
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
  for (const p of players) await call(p.socket, 'game:submit', { step: 0, text: 'hi' });
  await Promise.all(drawTasks);
  const bad = await call(players[0].socket, 'game:submit', { step: 1, image: 'data:image/png;base64,AAA" onerror="alert(1)' });
  assert.deepStrictEqual(bad, { ok: false, error: 'bad-image' });
  const game = room.game;
  const drawn = () => game.books.flatMap((b) => b.entries).find((e) => e && e.type === 'draw' && e.by === players[0].id);
  assert.strictEqual(drawn(), undefined, 'nothing is stored, so a good picture can still be handed in');
  assert.ok((await call(players[0].socket, 'game:submit', { step: 1, image: 'data:image/png;base64,iVBORw0KGgo=' })).ok);
  assert.strictEqual(drawn().content, 'data:image/png;base64,iVBORw0KGgo=');
  room.destroy();
});

test('telephone: late hand-ins, empty prompts, drop-outs, page turns, reactions and players who left', async () => {
  const { code, host, players, room } = await makeRoom(3);
  await call(host, 'lobby:settings', { mode: 'telephone', telephoneSteps: 0, drawTime: 240 });
  const tasks = players.map((p) => once(p.socket, 'game:tel:task'));
  await call(host, 'game:start');
  const first = await Promise.all(tasks);
  const game = room.game;
  assert.strictEqual(game.stepTime(1), 90, "Pictionary's draw time doesn't change Telephone's");
  // A hand-in for another step is refused, not filed under this one.
  assert.deepStrictEqual(await call(players[0].socket, 'game:submit', { step: 1, text: 'too soon' }), { ok: false, error: 'stale' });
  // An empty prompt is the idea that was in the box.
  assert.ok((await call(players[0].socket, 'game:submit', { step: 0, text: '   ' })).ok);
  assert.strictEqual(game.bookFor(players[0].id).entries[0].content, first[0].suggestion);
  // Someone drops out mid-step: the step waits for them instead of skipping them at once.
  assert.ok((await call(players[1].socket, 'game:submit', { step: 0, text: 'a duck in a hat' })).ok);
  players[2].socket.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(game.step, 0);
  assert.ok(game.awayTimer, 'waiting for the player who dropped out');
  // They're back in time: same idea in the box, and the step carries on waiting for their answer.
  const back = client();
  const snap = once(back, 'game:snapshot');
  assert.ok((await call(back, 'room:join', { code, token: players[2].token })).ok);
  const task = (await snap).task;
  assert.strictEqual(task.step, 0);
  assert.strictEqual(task.submitted, false);
  assert.strictEqual(task.suggestion, first[2].suggestion);
  assert.strictEqual(game.awayTimer, null);
  players[2].socket = back;
  // Jump to the reveal.
  game.phase = 'play';
  game.step = game.steps - 1;
  for (const b of game.books) for (let i = 0; i < game.steps; i++) b.entries[i] = b.entries[i] || { type: game.stepType(i), by: players[2].id, content: i % 2 ? null : 'words' };
  const reveal = once(host, 'game:tel:reveal');
  game.forceAdvance();
  const rv = await reveal;
  // Two clicks on Next for the same page turn it once.
  const turns = [call(host, 'game:next', { book: rv.bookIndex, entry: rv.entryIndex }), call(host, 'game:next', { book: rv.bookIndex, entry: rv.entryIndex })];
  const [a, b] = await Promise.all(turns);
  assert.ok(a.ok);
  assert.deepStrictEqual(b, { ok: false, error: 'stale' });
  assert.strictEqual(game.reveal.entry, 1);
  // One of each reaction per player per page.
  assert.ok((await call(players[1].socket, 'game:react', { emoji: '🔥' })).ok);
  assert.strictEqual((await call(players[1].socket, 'game:react', { emoji: '🔥' })).ok, false);
  assert.ok((await call(players[1].socket, 'game:react', { emoji: '😂' })).ok);
  // Someone leaves: their entries keep their name.
  await call(players[2].socket, 'room:leave');
  const payload = game.revealPayload(true);
  assert.ok(payload.entries.every((e) => e.by !== 'Someone'), JSON.stringify(payload.entries.map((e) => e.by)));
  room.destroy();
});

test('telephone chain length: 1 steps over to 2 going up and to "everyone" going down', async () => {
  const { host, room } = await makeRoom(2);
  await call(host, 'lobby:settings', { mode: 'telephone', telephoneSteps: 0 });
  await call(host, 'lobby:settings', { telephoneSteps: 1 });
  assert.strictEqual(room.settings.telephoneSteps, 2);
  await call(host, 'lobby:settings', { telephoneSteps: 1 });
  assert.strictEqual(room.settings.telephoneSteps, 0);
  room.destroy();
});

test('pictionary: a drawer who drops out keeps the turn; accents and punctuation; fair turns; undo by id', async () => {
  const { code, host, players, room } = await makeRoom(3);
  await call(host, 'lobby:settings', { mode: 'pictionary', pictEveryone: true, pictRounds: 10, customWords: 'pokémon, straße, t-rex, a, 猫', customOnly: true, wordChoices: 2 });
  await call(host, 'game:start');
  const game = room.game;
  assert.deepStrictEqual(game.custom.sort(), ['pokémon', 'straße', 't-rex', '猫'].sort(), 'a lone "a" is not a word');
  // Nobody draws twice running, round after round.
  const order = [];
  for (let i = 0; i < 24; i++) {
    order.push(game.drawerId);
    game.chooseWord(game.options[0]);
    game.endTurn();
    game.nextTurn();
  }
  assert.ok(order.every((id, i) => i === 0 || id !== order[i - 1]), 'nobody draws twice in a row');
  // Accents, ß and punctuation don't matter in a guess; punctuation shows in the mask.
  const drawer = players.find((p) => p.id === game.drawerId);
  const guesser = players.find((p) => p.id !== game.drawerId);
  game.options = ['t-rex', 'straße'];
  game.chooseWord('t-rex');
  assert.strictEqual(game.mask(), '_-___');
  room.handle(room.players.get(guesser.id), 'chat', { text: 'T Rex!' });
  assert.ok(game.guessed.has(guesser.id), '"T Rex!" guesses "t-rex"');
  game.endTurn();
  game.nextTurn();
  game.options = ['straße', 'pokémon'];
  game.chooseWord('pokémon');
  const g2 = players.find((p) => p.id !== game.drawerId);
  room.handle(room.players.get(g2.id), 'chat', { text: 'pokemon' });
  assert.ok(game.guessed.has(g2.id), '"pokemon" guesses "pokémon"');
  // The drawer's connection drops for a moment: the turn waits for them.
  const d = players.find((p) => p.id === game.drawerId);
  d.socket.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(game.phase, 'drawing');
  assert.ok(game.awayTimer, 'waiting for the drawer');
  const back = client();
  assert.ok((await call(back, 'room:join', { code, token: d.token })).ok);
  assert.strictEqual(game.awayTimer, null);
  assert.strictEqual(game.phase, 'drawing');
  // Undo names the stroke; the drawer's own board already did it, so only the others get a redraw.
  const redraws = [];
  for (const p of players.filter((x) => x.id !== d.id)) p.socket.on('game:pict:redraw', (m) => redraws.push(m));
  let mine = 0;
  back.on('game:pict:redraw', () => mine++);
  const stroke = (id) => ({ id, color: '#000000', size: 7, pts: [0.1, 0.1, 0.2, 0.2] });
  back.emit('game:stroke', stroke('s1'));
  back.emit('game:stroke', stroke('s2'));
  back.emit('game:undo', { id: 's1' });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(game.strokes.map((x) => x.id), ['s2']);
  assert.strictEqual(redraws.length, 2);
  assert.strictEqual(mine, 0);
  room.destroy();
  void drawer;
});

test('pictionary results: teams are scored per player, and players who left keep their points', async () => {
  const { host, players, room } = await makeRoom(3);
  await call(host, 'lobby:settings', { mode: 'pictionary', teamMode: true, teamCount: 2 });
  room.players.get(players[0].id).team = 0;
  room.players.get(players[1].id).team = 0;
  room.players.get(players[2].id).team = 1;
  await call(host, 'game:start');
  const game = room.game;
  game.scores.set(players[0].id, 300);
  game.scores.set(players[1].id, 300);
  game.scores.set(players[2].id, 400);
  await call(players[1].socket, 'room:leave');
  const results = once(host, 'room:state', (s) => s.state === 'results');
  game.finish();
  const r = (await results).results;
  assert.ok(r.players.some((p) => p.id === players[1].id && p.score === 300), 'the player who left is still listed');
  assert.deepStrictEqual(r.teams.map((t) => [t.id, t.score]), [[1, 400], [0, 300]]);
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

test('the host keeps the room through a short drop-out, and gets it back after a long one', async () => {
  const { code, players, room } = await makeRoom(3);
  const [h] = players;
  h.socket.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(room.hostId, h.id, 'still host while away for a moment');
  // Away longer than the grace: someone who is here takes over...
  clearTimeout(room.hostTimer);
  room.pickNewHost();
  assert.notStrictEqual(room.hostId, h.id);
  // ...and the party's host takes it back on returning.
  const back = client();
  assert.ok((await call(back, 'room:join', { code, token: h.token })).ok);
  assert.strictEqual(room.hostId, h.id);
  // Leaving for good hands the party to whoever hosts next.
  await call(back, 'room:leave');
  assert.notStrictEqual(room.hostId, h.id);
  assert.strictEqual(room.ownerId, room.hostId);
  room.destroy();
});

test('the page carries the build it was made from, and the server says which build it runs', async () => {
  // A page left open across a deploy compares the two and reloads (public/js/app.js).
  const { renderIndex, buildId } = require('../server/assets');
  const dir = require('path').join(__dirname, '..', 'public');
  const id = buildId(dir);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.ok(renderIndex(dir).includes(`<meta name="teamup-build" content="${id}">`));
  const s = connect(url, { transports: ['websocket'], forceNew: true, autoConnect: false });
  sockets.push(s);
  const hello = once(s, 'server:hello');
  s.connect();
  assert.strictEqual((await hello).build, id);
});

test('game loops keep to real time: a busy server catches up instead of falling behind', async () => {
  const { fixedLoop } = require('../server/games/loop');
  let steps = 0;
  const loop = fixedLoop(30, () => { steps++; });
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 100));
  const busy = performance.now();
  while (performance.now() - busy < 250); // the event loop is blocked for a quarter of a second
  await new Promise((r) => setTimeout(r, 300));
  loop.stop();
  const elapsed = (performance.now() - t0) / 1000;
  // The last wake-up can be up to a step before the stop; a plain setInterval would be ~7 behind.
  assert.ok(steps >= elapsed * 30 - 3 && steps <= elapsed * 30 + 1, `${steps} steps in ${elapsed.toFixed(3)} s`);
  // A step that ends the game stops the catch-up there and then.
  let after = 0;
  const ender = fixedLoop(30, () => { after++; ender.stop(); });
  const stall = performance.now();
  while (performance.now() - stall < 200);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(after, 1);
});

test('a second start while a game runs is refused and the running game carries on', async () => {
  const { host, room } = await makeRoom(3);
  await call(host, 'lobby:settings', { mode: 'pictionary' });
  assert.ok((await call(host, 'game:start')).ok);
  const game = room.game;
  const again = await call(host, 'game:start');
  assert.strictEqual(again.ok, false);
  assert.match(again.error, /already running/);
  assert.strictEqual(room.game, game);
  room.destroy();
});

// Arena tests play on the flat Colosseum (the controlled bed: no hills, no bridges) unless they ask.
async function arenaGame(n, settings = {}) {
  const ctx = await makeRoom(n);
  await call(ctx.host, 'lobby:settings', { mode: 'kart', kartMode: 'arena', arenaTime: 60, kartMap: 'colosseum', ...settings });
  const init = once(ctx.host, 'game:kart:init');
  await call(ctx.host, 'game:start');
  ctx.init = await init;
  const game = ctx.room.game;
  game.stop();
  game.phase = 'racing';
  game.raceStart = game.time;
  ctx.game = game;
  ctx.kart = (i) => game.karts.get(ctx.players[i].id);
  // Two karts face to face in open space, nothing protecting them. Placing a kart also empties its
  // item slot: karts parked on an item box pick up random items (a held banana or mine would block
  // shells from behind and make tests flaky).
  const fresh = { speed: 0, shield: 0, invuln: 0, spin: 0, ghost: 0, angle: 0, heading: 0, item: null, ammo: 0, roulette: 0, item2: null, ammo2: 0, roulette2: 0 };
  ctx.place = (i, x, y) => Object.assign(ctx.kart(i), fresh, { x, y });
  return ctx;
}
const step = (game, n) => { for (let i = 0; i < n; i++) game.simulate(1 / 30); };

test('arena mode starts on Harbour Havoc, the default arena', async () => {
  const ctx = await makeRoom(1);
  await call(ctx.host, 'lobby:settings', { mode: 'kart', kartMode: 'arena' });
  assert.strictEqual(ctx.room.settings.kartMap, 'harbour');
  assert.strictEqual(require('../public/js/shared/kart-core').DEFAULT_MAP.arena, 'harbour');
  ctx.room.destroy();
});

test('the retired flat arenas are out of the lobby but still load by id', () => {
  const K = require('../public/js/shared/kart-core');
  const ids = K.mapList().map((m) => m.id);
  assert.ok(!ids.includes('colosseum') && !ids.includes('volcano'), ids.join());
  assert.strictEqual(ids.filter((id) => K.mapInfo(id).type === 'arena')[0], 'harbour', 'the default arena leads the list');
  assert.strictEqual(K.getMap('colosseum', 'arena').id, 'colosseum');
  assert.strictEqual(K.mapInfo('volcano').type, 'arena');
});

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

test('bombs are aimed: hold to lob them near or far, a tap throws mid-range, bots aim at their target', async () => {
  const KC = require('../public/js/shared/kart-core');
  const { room, game, kart, place, players } = await arenaGame(2);
  const [a, b] = [kart(0), kart(1)];
  place(1, 2300, 2300);
  const { near, far, tap, flight } = KC.ITEM_FX.bomb;
  const lob = (opts, speed = 0) => {
    place(0, 500, 1300); // facing +x
    Object.assign(a, { item: 'bomb', ammo: 1, speed });
    assert.ok(game.useItem(a, opts));
    const shot = game.shots.pop();
    assert.strictEqual(shot.kind, 'bomb');
    return Math.round(shot.lx - 500);
  };
  assert.strictEqual(lob({ power: 0 }), 26 + near, 'near');
  assert.strictEqual(lob({ power: 1 }), 26 + far, 'far');
  assert.strictEqual(lob({}), 26 + KC.bombLead(tap), 'a tap: the middle');
  assert.strictEqual(lob({ power: 0.25 }, 300), Math.round(26 + 300 * flight + KC.bombLead(0.25)), 'ahead of where the thrower will be');
  for (const junk of ['1', null, NaN, Infinity, {}, [0.3]]) assert.strictEqual(lob({ power: junk }), 26 + KC.bombLead(tap), `junk ${JSON.stringify(junk)}`);
  assert.strictEqual(lob({ power: 7 }), 26 + far, 'clamped');
  // Over the network: the aimed release carries the power.
  place(0, 500, 1300);
  Object.assign(a, { item: 'bomb', ammo: 1 });
  players[0].socket.emit('game:use', { power: 0.8 });
  await call(players[0].socket, 'game:ping'); // handled in order: the throw is done by now
  assert.strictEqual(Math.round(game.shots.pop().lx - 500), Math.round(26 + KC.bombLead(0.8)));
  room.destroy();

  // A bot with a bomb and a parked rival 520 units ahead lands it on them.
  const ctx = await kartGame(1, { kartMode: 'arena', kartMap: 'colosseum', kartBots: 1, kartBotSkill: 'hard', kartItems: 'none' });
  const bot = ctx.bots()[0];
  const target = ctx.game.karts.get(ctx.players[0].id);
  Object.assign(bot, { x: 700, y: 1300, angle: 0, heading: 0, speed: 0, item: 'bomb', ammo: 1, roulette: 0 });
  Object.assign(target, { x: 1220, y: 1300, speed: 0, input: { up: false, down: false, left: false, right: false, drift: false } });
  let shot = null;
  for (let i = 0; i < 90 && !shot; i++) {
    ctx.game.simulate(1 / 30);
    shot = ctx.game.shots.find((s) => s.kind === 'bomb');
    Object.assign(target, { x: bot.x + Math.cos(bot.angle) * 520, y: bot.y + Math.sin(bot.angle) * 520, speed: 0 });
  }
  assert.ok(shot, 'the bot threw it');
  const miss = Math.hypot(shot.lx - target.x, shot.ly - target.y);
  assert.ok(miss < 140, `lands within the blast (${Math.round(miss)} off)`);
  ctx.room.destroy();
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
    // The weekly arena is sent by the exact week and layout.
    if (id === 'weekly') assert.match((await init).mapId, /^weekly-\d{4}-\d{2}-a\d+$/);
    else assert.strictEqual((await init).mapId, id);
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
  for (const p of players) await call(p.socket, 'game:submit', { step: 0, image: png });
  const t2 = await Promise.all(second);
  assert.ok(t2.every((t) => t.type === 'draw' && t.memorize > 5.5 && t.memorize <= 6 && t.prev.content === png));

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
  const next = once(host, 'game:tel:reveal', (r) => r.entryIndex === 1 || r.bookIndex === 1, 6000);
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
  // Every kart has an animal driver: the one that goes with its avatar.
  const K = require('../public/js/shared/kart-core');
  for (const k of init.karts) assert.strictEqual(k.character, K.CHARACTERS[k.avatar % K.CHARACTERS.length].id, `${k.name} drives as their avatar's animal`);
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
  Object.assign(kart, { x: K.MAPS.grandprix.itemBoxes[0].x, y: K.MAPS.grandprix.itemBoxes[0].y, trackIndex: null });
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
  assert.strictEqual(high.init.respawn, 4, 'the init payload tells clients how long a respawn takes');
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
  assert.strictEqual(low.init.respawn, 1.5);
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

  const turbo = await kartGame(1, { kartMode: 'arena', kartMap: 'colosseum', kartClass: 'turbo' });
  assert.strictEqual(turbo.init.speedMul, 1.18);
  const k = turbo.game.karts.get(turbo.players[0].id);
  Object.assign(k, { x: 300, y: 1000, angle: 0, heading: 0, speed: 0 }); // open floor ahead, no boost pad
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

test('a CPU driver finishing first never cuts a human race short', async () => {
  const { room, game, bots, run, players } = await kartGame(1, { kartMap: 'grandprix', kartBots: 1, kartLaps: 1 });
  const bot = bots()[0];
  bot.lap = game.laps + 1;
  game.trackLaps(bot, bot.trackIndex);
  assert.ok(bot.finished);
  assert.strictEqual(game.firstFinishAt, null, 'no grace countdown for bots');
  const human = game.karts.get(players[0].id);
  human.lap = game.laps + 1;
  game.trackLaps(human, human.trackIndex);
  assert.ok(game.firstFinishAt !== null, 'a human finishing starts it');
  run(0.1);
  room.destroy();
});

test('arena bots never stall next to a box or a rival they are gunning for', async () => {
  for (const skill of ['easy', 'hard']) {
    // Overshot a box, facing away from it, with nobody else nearby.
    let ctx = await kartGame(1, { kartMode: 'arena', kartMap: 'colosseum', kartBots: 1, kartBotSkill: skill });
    let bot = ctx.bots()[0];
    const human = ctx.game.karts.get(ctx.players[0].id);
    const box = ctx.game.map.itemBoxes[0];
    Object.assign(human, { x: 2200, y: 2200, speed: 0 });
    Object.assign(bot, { x: box.x + 110, y: box.y, angle: 0, speed: 0, item: null });
    ctx.run(10);
    assert.ok(bot.item || bot.gun > 0 || Math.hypot(bot.x - box.x - 110, bot.y - box.y) > 200, `${skill}: bot went for the box`);
    ctx.room.destroy();

    // Holding a minigun with a parked rival just off to the side.
    ctx = await kartGame(1, { kartMode: 'arena', kartMap: 'colosseum', kartBots: 1, kartBotSkill: skill, kartItems: 'none' });
    bot = ctx.bots()[0];
    const target = ctx.game.karts.get(ctx.players[0].id);
    Object.assign(bot, { x: 1000, y: 400, angle: 0, speed: 0, item: 'minigun', ammo: 1 });
    Object.assign(target, { x: 1000, y: 550, speed: 0 });
    ctx.run(skill === 'easy' ? 20 : 15); // easy bots act on only 15% of chances, but never hold it past 16 s
    // Easy bots aim loosely and can miss a whole burst; what matters is that they don't sit on it.
    assert.ok(bot.item !== 'minigun' || target.hp < 100 || target.deaths > 0, `${skill}: bot opened fire`);
    ctx.room.destroy();
  }
});

test('nothing happens after a kill limit ends the battle', async () => {
  const { room, game, players } = await kartGame(3, { kartMode: 'arena', kartMap: 'colosseum', arenaKillLimit: 5 });
  const [a, b, c] = players.map((p) => game.karts.get(p.id));
  a.kills = 4;
  Object.assign(b, { hp: 1, x: 700, y: 1300 });
  Object.assign(c, { hp: 1, x: 760, y: 1300 });
  game.damage(b, 50, a, 'shock');
  assert.strictEqual(game.phase, 'done');
  game.damage(c, 50, a, 'shock');
  assert.strictEqual(a.kills, 5, 'no kills after the round is over');
  assert.ok(c.dead <= 0);
  a.item = 'rocket'; a.ammo = 1;
  game.useItem(a);
  assert.strictEqual(a.item, 'rocket', 'items cannot be used after the round');
  room.destroy();
});

test('fast bullets never pass through a kart', async () => {
  const { room, game, players } = await kartGame(2, { kartMode: 'arena', kartMap: 'colosseum' });
  const [a, b] = players.map((p) => game.karts.get(p.id));
  for (let range = 40; range <= 500; range += 23) {
    Object.assign(a, { x: 600, y: 1300, angle: 0, speed: 0, gun: 0, item: null, input: {} });
    Object.assign(b, { x: 600 + range, y: 1300, speed: 0, hp: 100, invuln: 0, shield: 0, input: {} });
    game.shots = [];
    game.fire('bullet', a);
    for (let i = 0; i < 15; i++) game.simulate(1 / 30);
    assert.strictEqual(b.hp, 94, `bullet hit at range ${range}`);
  }
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
  }
  // Across the road out to the wall, both ways round: no steps anywhere a kart can drive. Every
  // railed sample (bridge ends, jump run-ups) and every 3rd elsewhere, 2 units at a time.
  for (const id of raceIds()) {
    for (const reverse of [false, true]) {
      const m = K.getMap(id, 'race', { reverse });
      for (let i = 0; i < m.n; i++) {
        if (m.gap[i] || (!m.railed[i] && m.anchor[i] > 0.99 && i % 3)) continue;
        const t = m.tangents[i];
        for (const side of [1, -1]) {
          let last = null;
          for (let d = 0; d <= m.wallD[i]; d += 2) {
            const x = m.centerline[i][0] - t[1] * d * side;
            const y = m.centerline[i][1] + t[0] * d * side;
            const h = m.heightAt(x, y, i);
            if (last !== null) assert.ok(Math.abs(h - last) < 6, `${id}${reverse ? ' rev' : ''}: step of ${(h - last).toFixed(1)} across the road at ${i}, ${d}`);
            last = h;
          }
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

test('hop: a tap of drift hops the kart; holding it does not hop again; it keeps the grip of the ground', () => {
  const K = require('../public/js/shared/kart-core');
  const map = K.MAPS.grandprix;
  const ramp = map.ramps.find((r) => r.dir === 1);
  const i0 = (ramp.i + Math.floor(map.n / 2)) % map.n; // far from any ramp
  let pressed = 0;
  const hop = driveTo(K, map, i0, { steps: 40, from: 30, input: (k) => ({ drift: pressed++ < 30 && pressed > 3 }) });
  const airs = hop.log.map((l) => l.air);
  const apex = Math.max(...airs);
  const airtime = airs.filter((a) => a > 0).length / 30;
  assert.ok(apex > 22 && apex < 36, `apex ${apex.toFixed(1)}`);
  assert.ok(airtime > 0.3 && airtime < 0.5, `in the air ${airtime.toFixed(2)} s`);
  assert.strictEqual(airs.filter((a, i) => a > 0 && !(airs[i - 1] > 0)).length, 1, 'holding drift does not hop again');
  // Two taps a cooldown apart: two hops; taps closer than that: still one.
  const taps = (gap) => {
    const presses = new Set([3, 3 + gap]);
    let i = 0;
    const r = driveTo(K, map, i0, { steps: 60, from: 40, input: () => ({ drift: presses.has(i++) }) });
    return r.log.filter((l, j) => l.air > 0 && !(r.log[j - 1]?.air > 0)).length;
  };
  assert.strictEqual(taps(14), 2);
  assert.strictEqual(taps(6), 1, 'no double hop mid-air');
  // Hopping across the grass doesn't dodge it: the kart slows down just as much as without hops.
  let n = 0;
  const grass = driveTo(K, map, i0, { steps: 75, from: 30, lateral: 1.9, input: () => ({ drift: n++ % 14 === 0 }) });
  const rolled = driveTo(K, map, i0, { steps: 75, from: 30, lateral: 1.9 });
  assert.ok(grass.kart.speed < K.PHYS.offTrackMax * 1.15, `on the grass (${Math.round(grass.kart.speed)})`);
  assert.ok(grass.kart.speed <= rolled.kart.speed + 5, `hops ${Math.round(grass.kart.speed)} vs no hops ${Math.round(rolled.kart.speed)}`);
  // Hopping over a ramp's lip still launches you off it.
  const plain = driveTo(K, map, ramp.i, { steps: 40, from: 9 });
  const lipStep = plain.log.findIndex((l) => l.air > 0);
  let m = 0;
  const lip = driveTo(K, map, ramp.i, { steps: 40, from: 9, input: () => ({ drift: m++ === lipStep - 3 }) });
  assert.ok(lip.log[lipStep - 1].air > 0, 'mid-hop at the lip');
  assert.ok(Math.max(...lip.log.map((l) => l.air)) > 100, 'the ramp still launches a hopping kart');
  // Arena: a flat hop that lands again.
  const arena = K.MAPS.colosseum;
  const ak = { x: 1300, y: 1300, angle: 0, speed: 0, boost: 0, spin: 0 };
  const hs = [];
  for (let s = 0; s < 20; s++) { K.stepKart(ak, { drift: s === 1 }, 1 / 30, arena); hs.push(ak.air || 0); }
  assert.ok(Math.max(...hs) > 22 && hs[hs.length - 1] === 0, `arena hop ${Math.max(...hs).toFixed(1)}`);
});

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

test('jump kickers launch karts anywhere between the guard rails', () => {
  const K = require('../public/js/shared/kart-core');
  for (const id of ['canyon', 'frost', 'neon', 'lavapeak']) {
    for (const reverse of [false, true]) {
      const map = K.getMap(id, 'race', { reverse });
      for (const r of map.ramps.filter((x) => x.gap && x.dir === 1)) {
        // The rails close in before the lip: the kicker is the only way across.
        for (let k = -6; k <= 0; k++) assert.ok(map.railed[(r.i + k + map.n) % map.n], `${id}: rails along the kicker`);
        for (const lateral of [-1.4, -1.2, -1, 0, 1, 1.2, 1.4]) {
          for (const speed of [0.82, 1, 1.18]) {
            const { log } = driveTo(K, map, r.i, { steps: 60, from: 24, lateral, speed: K.PHYS.maxSpeed * speed, physics: { speed } });
            assert.ok(!log.some((l) => l.fall > 0), `${id}${reverse ? ' rev' : ''}: fell off the lip at lateral ${lateral}, class ${speed}`);
          }
        }
      }
    }
  }
});

test('grass and run-off never beat the road, however long you hold the throttle', () => {
  const K = require('../public/js/shared/kart-core');
  const map = K.MAPS.grandprix;
  const half = map.width / 2;
  for (const speed of [0.82, 1, 1.18]) {
    for (const [off, cap] of [[half + 100, K.PHYS.offTrackMax], [half + K.CURB + 30, K.PHYS.runoffMax]]) {
      // Ten seconds flat out beside the start straight, from full road speed.
      const { log } = driveTo(K, { ...map, boostPads: [] }, 5, { from: 40, steps: 300, lateral: off / half, speed: K.PHYS.maxSpeed * speed, physics: { speed } });
      const top = Math.max(...log.slice(90).map((l) => l.speed));
      assert.ok(top <= cap * speed * 1.12 + 1, `class ${speed}, ${off - half} off the asphalt: ${top.toFixed(0)} > cap ${(cap * speed).toFixed(0)}`);
    }
  }
});

test('jumps and landings are the same at 30, 60 and 144 frames a second', () => {
  const K = require('../public/js/shared/kart-core');
  for (const id of raceIds()) {
    const map = K.MAPS[id];
    const n = map.n;
    const nearRamp = (i) => map.ramps.some((r) => { const d = (((i - r.i) * r.dir + n * 1.5) % n) - n / 2; return d > -8 && d < 14; });
    for (const hz of [30, 60, 144]) {
      const p = map.centerline[0];
      const t = map.tangents[0];
      const kart = { x: p[0], y: p[1], angle: Math.atan2(t[1], t[0]), speed: 0, boost: 0, spin: 0, trackIndex: 0 };
      let travelled = 0;
      let last = 0;
      let time = 0;
      let decide = 0;
      let input = {};
      let hops = 0;
      let peak = 0;
      while (travelled < n && time < 90) {
        if (time >= decide) {
          decide += 1 / 30; // the same driver whatever the frame rate
          const q = map.nearestIndex(kart.x, kart.y, kart.trackIndex);
          const a = map.trackPoint(q.index + 6, 0.2);
          let e = Math.atan2(a[1] - kart.y, a[0] - kart.x) - kart.angle;
          e = Math.atan2(Math.sin(e), Math.cos(e));
          input = { up: true, left: e < -0.04, right: e > 0.04 };
        }
        const was = kart.air > 0;
        K.stepKart(kart, input, 1 / hz, map, { noFall: true });
        time += 1 / hz;
        if (kart.air > 0 && !nearRamp(kart.trackIndex)) peak = Math.max(peak, kart.air);
        if (was && !(kart.air > 0)) { if (peak >= 1) hops++; peak = 0; }
        let d = kart.trackIndex - last;
        if (d < -n / 2) d += n;
        if (d > n / 2) d -= n;
        travelled += d;
        last = kart.trackIndex;
      }
      assert.ok(travelled >= n, `${id} @${hz}Hz: finished the lap`);
      assert.strictEqual(hops, 0, `${id} @${hz}Hz: ${hops} hops away from the ramps`);
    }
  }
});

test('tricks need a real jump: no flips on little hops, and you land facing the slope', () => {
  const K = require('../public/js/shared/kart-core');
  const map = K.MAPS.grandprix;
  const i = 40;
  const [x, y] = map.centerline[i];
  const a = Math.atan2(map.tangents[i][1], map.tangents[i][0]);
  const g = map.heightAt(x, y, i);
  // A one-frame crest hop, drift held or freshly pressed: no trick.
  for (const prevDrift of [false, true]) {
    const hop = { x, y, angle: a, speed: 430, trackIndex: i, air: 1, z: g + 1, vz: 120, airTime: 0, trickable: true, prevDrift };
    K.stepKart(hop, { up: true, drift: true }, 1 / 30, map);
    assert.ok(!hop.tricked && !(hop.trick > 0), 'no trick on a hop');
  }
  // A late press just before touching down: no trick either.
  const late = { x, y, angle: a, speed: 430, trackIndex: i, air: 6, z: g + 6, vz: -300, airTime: 0.6, trickable: true, prevDrift: false };
  K.stepKart(late, { up: true, drift: true }, 1 / 30, map);
  assert.ok(!late.tricked, 'no trick just before landing');
  // Holding drift through a lap of corners only ever flips off real jumps.
  for (const [id, reverse] of [['lavapeak', false], ['neon', true], ['grandprix', true], ['frost', false]]) {
    const m = K.getMap(id, 'race', { reverse });
    const p = m.centerline[0];
    const t = m.tangents[0];
    const kart = { x: p[0], y: p[1], angle: Math.atan2(t[1], t[0]), speed: 0, boost: 0, spin: 0, trackIndex: 0 };
    let trick = null;
    for (let s = 0; s < 30 * 60; s++) {
      const q = m.nearestIndex(kart.x, kart.y, kart.trackIndex);
      const aim = m.trackPoint(q.index + 6, 0.2);
      let e = Math.atan2(aim[1] - kart.y, aim[0] - kart.x) - kart.angle;
      e = Math.atan2(Math.sin(e), Math.cos(e));
      const was = kart.tricked;
      K.stepKart(kart, { up: true, left: e < -0.04, right: e > 0.04, drift: true }, 1 / 30, m);
      if (kart.tricked && !was) trick = 0;
      if (trick !== null) trick = Math.max(trick, kart.air || 0);
      if (trick !== null && !(kart.air > 0)) {
        assert.ok(trick > 15, `${id}${reverse ? ' rev' : ''}: a trick on a ${trick.toFixed(1)}-unit hop at ${(kart.trackIndex / m.n).toFixed(3)}`);
        trick = null;
      }
    }
  }
  // Landing on a descent keeps the slope's speed instead of stopping dead (no bunny hops).
  const frost = K.MAPS.frost;
  let down = 0;
  for (let k = 0; k < frost.n; k++) if (frost.grade[k] < frost.grade[down] && !frost.ramps.some((r) => Math.abs(k - r.i) < 12)) down = k;
  const [dx, dy] = frost.centerline[down];
  const da = Math.atan2(frost.tangents[down][1], frost.tangents[down][0]);
  const land = { x: dx, y: dy, angle: da, speed: 430, trackIndex: down, air: 0.5, z: frost.heightAt(dx, dy, down) + 0.5, vz: -200, airTime: 0.5 };
  K.stepKart(land, { up: true }, 1 / 30, frost);
  assert.ok(!(land.air > 0) && land.vz < -40, `landed moving down the slope (vz ${land.vz.toFixed(0)})`);
  for (let s = 0; s < 6; s++) {
    K.stepKart(land, { up: true }, 1 / 30, frost);
    assert.ok(!(land.air > 0), 'stays on the ground going downhill');
  }
});

test('items have height: jumpers fly over bananas and mines, drops fall into gaps, no items while falling', async () => {
  const { room, game, players } = await kartGame(2, { kartMap: 'lavapeak' });
  const map = game.map;
  const [me, rival] = players.map((p) => game.karts.get(p.id));
  const r = map.ramps.find((x) => x.gap && x.dir === 1);
  const mid = (r.i + 3) % map.n;
  const [gx, gy] = map.centerline[mid];
  // A banana and an armed mine in the middle of the lava gap, and a rival far away.
  game.bananas.push({ id: 900, x: gx, y: gy, life: 40, owner: rival.id, safe: 0 });
  game.mines.push({ id: 901, x: gx + 20, y: gy, owner: rival.id, arm: 0, life: 60 });
  const far = (mid + 200) % map.n;
  Object.assign(rival, { x: map.centerline[far][0], y: map.centerline[far][1], trackIndex: far });
  const st = (r.i - 25 + map.n) % map.n;
  const t = map.tangents[st];
  Object.assign(me, { x: map.centerline[st][0], y: map.centerline[st][1], angle: Math.atan2(t[1], t[0]), heading: Math.atan2(t[1], t[0]), speed: 430, trackIndex: st, z: null, shield: 0, invuln: 0 });
  me.input = { up: true, down: false, left: false, right: false, drift: false };
  for (let s = 0; s < 60; s++) {
    const q = map.nearestIndex(me.x, me.y, me.trackIndex);
    const aim = map.trackPoint(q.index + 6, 0);
    let e = Math.atan2(aim[1] - me.y, aim[0] - me.x) - me.angle;
    e = Math.atan2(Math.sin(e), Math.cos(e));
    me.input = { up: true, down: false, left: e < -0.03, right: e > 0.03, drift: false };
    game.time += 1 / 30;
    game.simulate(1 / 30);
  }
  assert.ok(!(me.fall > 0) && me.spin === 0, 'flew over the banana and the mine and landed');
  assert.strictEqual(game.bananas.length, 1, 'banana still there');
  assert.strictEqual(game.mines.length, 1, 'mine still there');

  // Dropping a banana or mine while flying over the gap: it falls in.
  game.bananas = [];
  game.mines = [];
  for (const item of ['banana', 'mine']) {
    const over = (mid + 1) % map.n;
    const ta = map.tangents[over];
    Object.assign(me, { x: map.centerline[over][0], y: map.centerline[over][1], angle: Math.atan2(ta[1], ta[0]), trackIndex: over, air: 60, item, ammo: 1, spin: 0 });
    game.useItem(me);
    assert.strictEqual(me.item, null, `${item} used`);
  }
  assert.strictEqual(game.bananas.length + game.mines.length, 0, 'nothing left lying in the gap');

  // In the lava, waiting to be fished out: the item button does nothing.
  Object.assign(me, { x: gx, y: gy, trackIndex: mid, air: 0, z: null, speed: 0, item: 'shock', ammo: 1 });
  game.simulate(1 / 30);
  assert.ok(me.fall > 0);
  Object.assign(rival, { x: gx + 100, y: gy, spin: 0, shield: 0, invuln: 0 });
  game.useItem(me);
  assert.strictEqual(me.item, 'shock', 'no items while falling');
  assert.strictEqual(rival.spin, 0);
  room.destroy();
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
  assert.strictEqual(row.length, 20, 'air and fx appended to the kart row (then the item roulette, the reserve slot and a sticky bomb)');
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

test('after riding the curb or the grass, a fall puts you back beside where you fell in', () => {
  const K = require('../public/js/shared/kart-core');
  const coast = K.MAPS.coast;
  const n = coast.n;
  // Lateral 1.06-1.5: curb, run-off and grass; then off the beach into the sea near the end of the lap.
  for (const lateral of [1.06, 1.1, 1.5]) {
    const st = Math.floor(n * 0.5);
    const [x, y] = coast.centerline[st];
    const t = coast.tangents[st];
    const kart = { x, y, angle: Math.atan2(t[1], t[0]), speed: 300, boost: 0, spin: 0, trackIndex: st };
    let fellAt = null;
    for (let s = 0; s < 30 * 60 && fellAt === null; s++) {
      const f = kart.trackIndex / n;
      const q = coast.nearestIndex(kart.x, kart.y, kart.trackIndex);
      const a = coast.trackPoint(q.index + 6, f > 0.5 && f < 0.97 ? lateral : 3.5);
      let e = Math.atan2(a[1] - kart.y, a[0] - kart.x) - kart.angle;
      e = Math.atan2(Math.sin(e), Math.cos(e));
      K.stepKart(kart, { up: true, left: e < -0.04, right: e > 0.04 }, 1 / 30, coast);
      if (kart.fall > 0) fellAt = kart.trackIndex;
    }
    assert.ok(fellAt !== null, 'slid into the sea');
    for (let s = 0; s < 60 && kart.fall > 0; s++) K.stepKart(kart, {}, 1 / 30, coast);
    const back = (fellAt - kart.trackIndex + n) % n;
    assert.ok(back < 25, `lateral ${lateral}: put back ${back} samples behind (not half a lap)`);
  }
});

test('the finish grace scales with the lap: about three quarters of a lap, never under 25 s', async () => {
  const K = require('../public/js/shared/kart-core');
  for (const [kartClass, mul] of [['chill', 0.82], ['turbo', 1.18]]) {
    const { room, game } = await kartGame(1, { kartMap: 'neon', kartClass });
    const lap = game.map.length / (K.PHYS.maxSpeed * mul);
    assert.ok(game.finishGrace >= 25 && game.finishGrace > lap * 0.55 && game.finishGrace < lap * 1.1, `${kartClass}: ${game.finishGrace.toFixed(1)} s for a ~${lap.toFixed(0)} s lap`);
    room.destroy();
  }
  // Two humans: the second one is still out on the track when the first finishes.
  const { room, game, players } = await kartGame(2, { kartMap: 'grandprix', kartLaps: 1 });
  const human = game.karts.get(players[0].id);
  human.lap = game.laps + 1;
  game.trackLaps(human, human.trackIndex);
  game.time = game.firstFinishAt + 26;
  game.phase = 'racing';
  game.tick(0);
  assert.strictEqual(game.phase, 'racing', 'still racing 26 s after the winner');
  game.time = game.firstFinishAt + game.finishGrace + 0.1;
  game.tick(0);
  assert.notStrictEqual(game.phase, 'racing', 'over once the grace runs out');
  room.destroy();
});

test('race maps are built on first use, not when kart-core loads', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const core = path.join(__dirname, '..', 'public', 'js', 'shared', 'kart-core.js');
  const out = execFileSync(process.execPath, ['-e', `
    const K = require(${JSON.stringify(core)});
    const before = K.mapsBuilt().length;
    const list = K.mapList();
    const info = K.mapInfo('coast');
    const after = K.mapsBuilt().length;
    const m = K.getMap('coast', 'race');
    const hidden = Object.keys(K.MAPS).filter((id) => K.mapInfo(id).hidden).length;
    console.log(JSON.stringify({ before, after, n: list.length, info, built: K.mapsBuilt(), same: K.MAPS.coast === m, keys: Object.keys(K.MAPS).length - hidden }));
  `]).toString();
  const r = JSON.parse(out);
  assert.strictEqual(r.before, 0, 'nothing built on load');
  assert.strictEqual(r.after, 0, 'the catalogue and map info build nothing');
  assert.strictEqual(r.n, 14);
  assert.deepStrictEqual(r.info, { id: 'coast', name: 'Coral Coast', emoji: r.info.emoji, type: 'race', blurb: r.info.blurb });
  assert.deepStrictEqual(r.built, ['coast'], 'only the map asked for');
  assert.ok(r.same && r.keys === 14, 'MAPS still lists every map and caches what it built');
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

// ---------- Power-ups: item roulette and the five newer items ----------
const KC = require('../public/js/shared/kart-core');
const Bots = require('../server/games/kart-bots');
const CALM = { speed: 0, shield: 0, invuln: 0, spin: 0, ghost: 0, star: 0, shrink: 0, ink: 0, boost: 0, drift: 0, item: null, ammo: 0, roulette: 0, item2: null, ammo2: 0, roulette2: 0 };
// Park a race kart on lap 1 at centerline sample i (lateral -1..1), facing down the track.
function onTrack(game, k, i, lateral = 0) {
  const [x, y] = game.map.trackPoint(i, lateral);
  const t = game.map.tangents[i];
  const angle = Math.atan2(t[1], t[0]);
  Object.assign(k, CALM, { x, y, angle, heading: angle, trackIndex: i, lap: 1, progress: i, input: { up: false, down: false, left: false, right: false, drift: false } });
}
const setTeams = (ctx, teams) => ctx.players.forEach((p, i) => { ctx.room.players.get(p.id).team = teams[i]; });
const latestRow = async (ctx, idx) => {
  const state = once(ctx.host, 'game:kart:state');
  ctx.game.broadcast();
  const s = await state;
  return { row: s.k.find((r) => r[0] === idx), state: s };
};

test('item roulette: the item is decided at pickup but can only be used once the roulette stops', async () => {
  assert.deepStrictEqual(KC.ITEMS.slice(0, 10), ['boost', 'rocket', 'banana', 'shield', 'triple', 'mine', 'minigun', 'bomb', 'shock', 'ghost'], 'old wire codes are unchanged');
  assert.deepStrictEqual(KC.ITEMS.slice(10, 15), ['bouncer', 'comet', 'star', 'ink', 'thunder']);
  assert.deepStrictEqual(KC.ITEMS.slice(15), ['snowball', 'sticky', 'spikes', 'decoy'], 'new items are appended');
  const c = await kartGame(1, { kartItems: 'custom', kartItemList: ['boost'] });
  assert.deepStrictEqual(c.init.itemList, ['boost'], 'the roulette knows which items can come up');
  const k = c.game.karts.get(c.players[0].id);
  const box = c.game.map.itemBoxes[0];
  Object.assign(k, { x: box.x, y: box.y, speed: 0, trackIndex: null });
  c.run(1 / 30);
  assert.strictEqual(k.item, 'boost');
  assert.ok(k.roulette > 1 && k.roulette <= KC.ITEM_FX.roulette, `roulette started (${k.roulette})`);
  const { row } = await latestRow(c, k.idx);
  assert.strictEqual(row[7], KC.ITEMS.indexOf('boost') + 1);
  assert.strictEqual(row[15], 110, 'hundredths of a second of roulette left, at the end of the row');
  assert.strictEqual(c.game.useItem(k), false, 'cannot use the item while the roulette spins');
  c.run(0.6);
  assert.strictEqual(c.game.useItem(k), false);
  assert.strictEqual(k.item, 'boost');
  c.run(0.6);
  assert.strictEqual(k.roulette, 0);
  assert.strictEqual((await latestRow(c, k.idx)).row[15], 0);
  assert.strictEqual(c.game.useItem(k), true);
  assert.ok(k.boost > 0);
  assert.strictEqual(k.item, null);
  c.room.destroy();
});

test('two item slots: a second box fills the reserve, a full kart leaves boxes alone, swap and promotion', async () => {
  const c = await kartGame(2, { kartMap: 'grandprix' });
  const [k, other] = c.players.map((p) => c.game.karts.get(p.id));
  onTrack(c.game, other, 200);
  const rolls = ['rocket', 'banana', 'star'];
  c.game.rollItem = () => rolls.shift();
  const box = c.game.map.itemBoxes[0];
  const park = () => Object.assign(k, { x: box.x, y: box.y, speed: 0, trackIndex: null, air: 0 });
  park();
  c.run(1 / 30);
  assert.deepStrictEqual([k.item, k.ammo, k.item2], ['rocket', 1, null]);
  assert.ok(c.game.boxes[0] > 0, 'box taken');
  // A second box while still holding the first: it goes to the reserve, with its own roulette.
  c.game.boxes[0] = 0;
  park();
  c.run(1 / 30);
  assert.deepStrictEqual([k.item, k.item2, k.ammo2], ['rocket', 'banana', 1]);
  assert.ok(k.roulette2 > 1 && k.roulette2 <= KC.ITEM_FX.roulette, `reserve roulette started (${k.roulette2})`);
  assert.ok(c.game.boxes[0] > 0);
  let { row } = await latestRow(c, k.idx);
  assert.strictEqual(row.length, 20);
  assert.deepStrictEqual(row.slice(16, 18), [KC.ITEMS.indexOf('banana') + 1, 1], 'reserve item and ammo at the end of the row');
  assert.ok(row[18] > 0 && row[18] <= 110, 'reserve roulette in hundredths');
  // Full: the kart drives straight through the next box and it stays for someone else.
  c.game.boxes[0] = 0;
  park();
  c.run(1 / 30);
  assert.strictEqual(c.game.boxes[0], 0, 'the box is still there');
  assert.deepStrictEqual([k.item, k.item2, rolls.length], ['rocket', 'banana', 1], 'nothing rolled, nothing lost');
  // Swap (Q): the roulettes travel with their items.
  const swapped = once(c.host, 'game:kart:swap');
  c.players[0].socket.emit('game:swap');
  assert.strictEqual((await swapped).idx, k.idx);
  assert.deepStrictEqual([k.item, k.item2], ['banana', 'rocket']);
  assert.ok(k.roulette > 0 && k.roulette2 > 0, 'still rolling after the swap');
  assert.strictEqual(c.game.useItem(k), false, 'the swapped-in item is still rolling');
  assert.ok(c.game.swapItems(k));
  assert.deepStrictEqual([k.item, k.item2], ['rocket', 'banana']);
  c.run(1.2);
  // Using the front item moves the reserve up.
  onTrack(c.game, k, 40);
  Object.assign(k, { item: 'rocket', ammo: 1, item2: 'banana', ammo2: 1 });
  assert.ok(c.game.useItem(k));
  assert.deepStrictEqual([k.item, k.ammo, k.item2, k.ammo2], ['banana', 1, null, 0], 'reserve promoted');
  assert.strictEqual(c.game.swapItems(k), false, 'nothing to swap with');
  ({ row } = await latestRow(c, k.idx));
  assert.deepStrictEqual(row.slice(16, 19), [0, 0, 0]);
  // A triple keeps its shells in whichever slot it sits.
  Object.assign(k, { item: 'boost', ammo: 1, item2: 'triple', ammo2: 3 });
  assert.ok(c.game.useItem(k));
  assert.deepStrictEqual([k.item, k.ammo, k.item2], ['triple', 3, null]);
  c.room.destroy();

  // Arena: a wrecked kart loses both items.
  const ar = await arenaGame(2);
  ar.place(0, 1000, 400); ar.place(1, 1400, 400);
  Object.assign(ar.kart(1), { item: 'rocket', ammo: 1, item2: 'banana', ammo2: 1, roulette2: 0.4 });
  ar.game.damage(ar.kart(1), 1000, ar.kart(0), 'rocket');
  assert.ok(ar.kart(1).dead > 0);
  assert.deepStrictEqual(['item', 'item2', 'roulette', 'roulette2'].map((f) => ar.kart(1)[f]), [null, null, 0, 0]);
  ar.room.destroy();
});

test('CPU drivers follow the two-item rule and swap to the item they need', async () => {
  // Arena: a shield up front, a rocket in reserve and a rival dead ahead: swap and fire.
  const ctx = await kartGame(1, { kartMode: 'arena', kartMap: 'colosseum', kartBots: 1, kartBotSkill: 'hard', kartItems: 'none' });
  const bot = ctx.bots()[0];
  const target = ctx.game.karts.get(ctx.players[0].id);
  Object.assign(bot, { x: 1000, y: 400, angle: 0, heading: 0, speed: 0, hp: ctx.game.hpMax, item: 'shield', ammo: 1, item2: 'rocket', ammo2: 1 });
  Object.assign(target, { x: 1400, y: 400, speed: 0 });
  const fired = once(ctx.host, 'game:kart:use', (e) => e.idx === bot.idx && e.item === 'rocket');
  let used = false;
  for (let i = 0; i < 90 && !used; i++) {
    ctx.run(1 / 30);
    used = bot.item !== 'shield' && bot.item2 !== 'rocket';
    Object.assign(target, { x: bot.x + Math.cos(bot.angle) * 400, y: bot.y + Math.sin(bot.angle) * 400, speed: 0, invuln: 0 });
  }
  await fired;
  assert.strictEqual(bot.item, 'shield', 'kept the shield for later');
  ctx.room.destroy();

  // Only defensive items: it keeps hunting for boxes while a slot is free, not once both are full.
  const ar = await kartGame(1, { kartMode: 'arena', kartMap: 'colosseum', kartBots: 1, kartBotSkill: 'hard' });
  const b = ar.bots()[0];
  Object.assign(ar.game.karts.get(ar.players[0].id), { x: 2300, y: 2300, speed: 0 });
  ar.run(1 / 30);
  const goal = (items) => {
    Object.assign(b, { x: 1300, y: 1300, speed: 0, hp: ar.game.hpMax, item: null, ammo: 0, item2: null, ammo2: 0 }, items);
    b.ai.clock = 0;
    Bots.think(ar.game, b, 1 / 30);
    return b.ai.mode;
  };
  assert.strictEqual(goal({ item: 'shield', ammo: 1 }), 'box');
  assert.notStrictEqual(goal({ item: 'shield', ammo: 1, item2: 'ghost', ammo2: 1 }), 'box', 'both slots full');
  assert.notStrictEqual(goal({ item: 'shield', ammo: 1, item2: 'rocket', ammo2: 1 }), 'box', 'armed with the reserve item');
  ar.room.destroy();
});

test('bouncer: bounces off walls and obstacles, comes back for its owner, breaks after a few bounces', async () => {
  const { room, game, kart, place } = await arenaGame(3);
  const [a, b, c] = [kart(0), kart(1), kart(2)];
  place(1, 2300, 2300); place(2, 2300, 300);
  // Fired at the west wall: it bounces straight back, then off a crate.
  place(0, 300, 1000);
  Object.assign(a, { angle: Math.PI, heading: Math.PI, item: 'bouncer', ammo: 1 });
  assert.ok(game.useItem(a));
  const shell = game.shots.find((s) => s.kind === 'bouncer');
  assert.ok(Math.cos(shell.angle) < -0.99, 'fired straight ahead');
  place(0, 300, 2100); // out of its way
  step(game, 15);
  assert.ok(shell.bounced && shell.bounces === 4, `bounced off the wall (${shell.bounces} left)`);
  assert.ok(Math.cos(shell.angle) > 0.99, 'reflected back east');
  step(game, 50);
  assert.strictEqual(shell.bounces, 3, 'bounced off the crate at (1600, 1000)');
  assert.ok(Math.cos(shell.angle) < -0.99, 'heading west again');
  assert.ok(shell.x > 48 && shell.x < 1600 - 45, 'never inside the wall or the crate');
  // Out of bounces: the next wall breaks it.
  shell.bounces = 0;
  const booms = [];
  const emit = room.emit.bind(room);
  room.emit = (event, data) => { if (event === 'game:kart:boom') booms.push(data); return emit(event, data); };
  step(game, 60);
  assert.ok(!game.shots.includes(shell), 'shattered');
  assert.ok(booms.some((e) => e.kind === 'bouncer'), 'with a little blast');

  // A rival in its path takes the hit (holding nothing: a trailing banana or mine would block it).
  place(0, 1000, 400); place(1, 1250, 400);
  Object.assign(b, { item: null, ammo: 0 });
  Object.assign(a, { item: 'bouncer', ammo: 1 });
  game.useItem(a);
  step(game, 12);
  assert.strictEqual(b.hp, 100 - 50);
  assert.strictEqual(game.shots.filter((s) => s.kind === 'bouncer').length, 0);

  // Fired at a wall right in front of you, it comes back and hits you.
  place(0, 200, 1300);
  Object.assign(a, { angle: Math.PI, heading: Math.PI, item: 'bouncer', ammo: 1, hp: 100 });
  game.useItem(a);
  step(game, 20);
  assert.strictEqual(a.hp, 50, 'own shell after a bounce');

  // Braking throws it backwards.
  place(0, 1000, 1900);
  Object.assign(a, { item: 'bouncer', ammo: 1, input: { down: true } });
  game.useItem(a);
  const back = game.shots.find((s) => s.kind === 'bouncer');
  assert.ok(Math.cos(back.angle) < -0.99, 'thrown backwards');
  assert.ok(back.x < a.x);
  assert.strictEqual(c.hp, 100);
  room.destroy();

  // Race: the shell bounces off the barrier instead of leaving the track.
  const r = await kartGame(1, { kartMap: 'grandprix' });
  const k = r.game.karts.get(r.players[0].id);
  onTrack(r.game, k, 30, 0.6);
  const t = r.game.map.tangents[30];
  Object.assign(k, { angle: Math.atan2(t[0], -t[1]), item: 'bouncer', ammo: 1 }); // facing the outside barrier
  k.heading = k.angle;
  k.x -= Math.cos(k.angle) * 200; // keep the kart out of the rebound's way
  k.y -= Math.sin(k.angle) * 200;
  r.game.useItem(k);
  const rs = r.game.shots.find((s) => s.kind === 'bouncer');
  let far = 0;
  for (let i = 0; i < 30; i++) { r.run(1 / 30); far = Math.max(far, r.game.map.nearestIndex(rs.x, rs.y).dist); }
  assert.ok(rs.bounced, 'bounced off the race barrier');
  assert.ok(far <= r.game.map.width / 2 + KC.WALL_PAD + 1, `stayed inside the walls (${Math.round(far)})`);
  r.room.destroy();
});

test('comet: flies over the track to the race leader and blasts them and anyone next to them', async () => {
  const c = await kartGame(4, { kartMap: 'grandprix' });
  const [a, mid, lead, near] = c.players.map((p) => c.game.karts.get(p.id));
  onTrack(c.game, a, 10); onTrack(c.game, mid, 60, -0.6); onTrack(c.game, lead, 140); onTrack(c.game, near, 139, 0.6);
  Object.assign(a, { item: 'comet', ammo: 1 });
  assert.ok(c.game.useItem(a));
  const comet = c.game.shots.find((s) => s.kind === 'comet');
  assert.strictEqual(comet.target, lead.id, 'targets the leader');
  let maxAlt = 0;
  let offTrack = 0;
  let row = null;
  for (let i = 0; i < 30 * 10 && c.game.shots.includes(comet); i++) {
    c.run(1 / 30);
    maxAlt = Math.max(maxAlt, comet.alt);
    if (comet.age > 1 && comet.phase === 'cruise') offTrack = Math.max(offTrack, c.game.map.nearestIndex(comet.x, comet.y).dist);
    if (i === 20) row = (await latestRow(c, a.idx)).state.s.find((s) => s[1] === 5);
  }
  assert.ok(!c.game.shots.includes(comet), 'the comet landed');
  assert.ok(maxAlt > 100, `flew high (${Math.round(maxAlt)})`);
  assert.ok(offTrack < c.game.map.width / 2, `followed the track (${Math.round(offTrack)} off the centerline)`);
  assert.deepStrictEqual([row.length, row[6]], [7, lead.idx], 'snapshot: [.., altitude, target idx]');
  assert.ok(row[5] > 70, 'altitude in the snapshot');
  assert.ok(lead.spin > 0, 'leader blasted');
  assert.ok(near.spin > 0, 'the kart next to the leader is caught in the blast');
  assert.strictEqual(mid.spin, 0, 'flew over karts on the way');
  assert.strictEqual(a.spin, 0);
  c.room.destroy();

  // Arena: goes for the top scorer, skipping teammates, and blasts whoever is close to them.
  const ar = await arenaGame(4, { teamMode: true, teamCount: 2 });
  setTeams(ar, [0, 0, 1, 1]);
  const [o, mate, top, side] = [ar.kart(0), ar.kart(1), ar.kart(2), ar.kart(3)];
  ar.place(0, 400, 400); ar.place(1, 2200, 400); ar.place(2, 2200, 2200); ar.place(3, 2120, 2200);
  mate.kills = 5; top.kills = 3;
  Object.assign(o, { item: 'comet', ammo: 1 });
  ar.game.useItem(o);
  const ac = ar.game.shots.find((s) => s.kind === 'comet');
  assert.strictEqual(ac.target, top.id, 'the top scoring rival, not a teammate');
  for (let i = 0; i < 30 * 6 && ar.game.shots.includes(ac); i++) step(ar.game, 1);
  assert.ok(!ar.game.shots.includes(ac));
  assert.strictEqual(top.hp, 100 - 90);
  assert.ok(side.hp < 100 && side.hp > top.hp, `splash damage nearby (${side.hp})`);
  assert.strictEqual(mate.hp, 100);
  assert.strictEqual(o.hp, 100);
  ar.room.destroy();
});

test('karts trade momentum when they bump; a hard hit is a ram that shoves (and in the arena hurts)', async () => {
  const c = await kartGame(2, { kartMap: 'grandprix' });
  const [a, b] = c.players.map((p) => c.game.karts.get(p.id));
  // Nudging a stopped kart from behind: speed passes forward and the momentum is kept.
  const rearEnd = async (speed) => {
    onTrack(c.game, a, 60); onTrack(c.game, b, 60);
    const t = c.game.map.tangents[60];
    Object.assign(b, { x: a.x + t[0] * 26, y: a.y + t[1] * 26 });
    a.speed = speed;
    const bump = once(c.host, 'game:kart:bump');
    c.game.simulate(1 / 30);
    return bump;
  };
  let e = await rearEnd(220);
  assert.ok(b.speed > 100, `the nudged kart rolls on (${Math.round(b.speed)})`);
  assert.ok(a.speed < 140, `the nudger slows down (${Math.round(a.speed)})`);
  assert.ok(Math.abs(a.speed + b.speed - 220) < 15, `momentum kept (${Math.round(a.speed + b.speed)})`);
  assert.strictEqual(e.ram, -1, 'a nudge is no ram');
  // At 400 u/s it's a ram: the victim is shoved off harder than a plain bump would.
  e = await rearEnd(400);
  assert.strictEqual(e.ram, a.idx);
  assert.ok(b.speed > 330, `rammed (${Math.round(b.speed)})`);
  assert.deepStrictEqual(e.s.map((r) => r[0]).sort(), [a.idx, b.idx].sort(), 'shoves for both karts are sent');
  // A T-bone: the victim slides sideways, away from the hit.
  onTrack(c.game, a, 120); onTrack(c.game, b, 120);
  const n = c.game.map.tangents[120];
  const side = [-n[1], n[0]];
  Object.assign(a, { x: b.x - side[0] * 27, y: b.y - side[1] * 27, angle: Math.atan2(side[1], side[0]), heading: Math.atan2(side[1], side[0]), speed: 380 });
  const b0 = [b.x, b.y];
  c.game.simulate(1 / 30);
  assert.ok(Math.hypot(b.kx, b.ky) > 150, `sideways shove (${Math.round(Math.hypot(b.kx, b.ky))})`);
  for (let i = 0; i < 18; i++) c.game.simulate(1 / 30);
  const slid = (b.x - b0[0]) * side[0] + (b.y - b0[1]) * side[1];
  assert.ok(slid > 25, `the victim slid sideways ${Math.round(slid)} units`);
  assert.ok(Math.hypot(b.kx, b.ky) < 30, 'the shove has died away');
  // Race rams never spin anyone out.
  assert.strictEqual(b.spin, 0);
  // A boosting kart is heavier: it barely slows when it rear-ends someone.
  onTrack(c.game, a, 200); onTrack(c.game, b, 200);
  const t2 = c.game.map.tangents[200];
  Object.assign(b, { x: a.x + t2[0] * 26, y: a.y + t2[1] * 26 });
  Object.assign(a, { speed: 400, boost: 0.5 });
  c.game.simulate(1 / 30);
  assert.ok(b.speed > 250, `boosted ram pushes harder (${Math.round(b.speed)})`);
  c.room.destroy();

  // Arena: a ram costs the victim a little health, once per ram; teammates are safe.
  const ar = await arenaGame(3, { teamMode: true, teamCount: 2 });
  setTeams(ar, [0, 1, 0]);
  const [x, y, mate] = [ar.kart(0), ar.kart(1), ar.kart(2)];
  ar.place(0, 1000, 400); ar.place(1, 1027, 400); ar.place(2, 2300, 2300);
  Object.assign(x, { speed: 420 });
  const hit = once(ar.host, 'game:kart:hit', (h) => h.kind === 'ram');
  step(ar.game, 1);
  const h = await hit;
  assert.strictEqual(h.by, x.idx);
  assert.ok(y.hp < 100 && y.hp >= 84, `ram damage ${100 - y.hp}`);
  const hp1 = y.hp;
  ar.place(1, x.x + 27, x.y);
  Object.assign(x, { speed: 420 });
  step(ar.game, 1);
  assert.strictEqual(y.hp, hp1, 'no second helping within half a second');
  ar.place(2, x.x + 27, x.y); ar.place(1, 2300, 300);
  Object.assign(x, { speed: 420 });
  step(ar.game, 1);
  assert.strictEqual(mate.hp, 100, 'teammates are bumped, never hurt');
  ar.room.destroy();
});

test('snowball: freezes whoever it hits (no steering, no throttle, sliding); a hit on a frozen kart shatters the ice', async () => {
  const c = await kartGame(2, { kartMap: 'grandprix' });
  const [a, b] = c.players.map((p) => c.game.karts.get(p.id));
  onTrack(c.game, a, 40); onTrack(c.game, b, 52);
  Object.assign(a, { item: 'snowball', ammo: 1 });
  b.speed = 250;
  assert.ok(c.game.useItem(a));
  for (let i = 0; i < 30 && !(b.freeze > 0); i++) c.game.simulate(1 / 30);
  assert.ok(b.freeze > 0 && b.spin === 0, 'frozen, not spun out');
  b.input = { up: true, down: false, left: true, right: false, drift: false };
  const [ang, v0] = [b.angle, b.speed];
  for (let i = 0; i < 10; i++) c.game.simulate(1 / 30);
  assert.ok(Math.abs(b.angle - ang) < 0.01, 'steering does nothing');
  assert.ok(b.speed < v0 && b.speed > v0 - 60, `the throttle does nothing; it slides (${Math.round(v0)} -> ${Math.round(b.speed)})`);
  Object.assign(b, { item: 'rocket', ammo: 1 });
  assert.strictEqual(c.game.useItem(b), false, 'no items while frozen');
  assert.ok((await latestRow(c, b.idx)).row[9] & 32768, 'frozen flag');
  const hit = once(c.host, 'game:kart:hit', (e) => e.target === b.idx && e.kind === 'rocket');
  c.game.damage(b, 70, a, 'rocket');
  assert.strictEqual((await hit).shatter, true);
  assert.strictEqual(b.freeze, 0, 'the ice is gone');
  assert.ok(b.spin > 2, `a longer spin-out (${b.spin})`);
  c.room.destroy();
  // Arena: a little damage and the freeze; the next proper hit does half as much again.
  const ar = await arenaGame(2);
  ar.place(0, 1000, 400); ar.place(1, 1400, 400);
  ar.game.damage(ar.kart(1), 10, ar.kart(0), 'snowball');
  assert.deepStrictEqual([ar.kart(1).hp, ar.kart(1).freeze > 0], [90, true]);
  ar.game.damage(ar.kart(1), 40, ar.kart(0), 'rocket');
  assert.strictEqual(ar.kart(1).hp, 30, 'shattered: 40 x 1.5');
  ar.room.destroy();
});

test('sticky bomb: clings to the kart it hits, jumps to whoever they bump, blows up on its last carrier', async () => {
  const ar = await arenaGame(3);
  const [a, b, c] = [ar.kart(0), ar.kart(1), ar.kart(2)];
  const tick = (n) => { for (let i = 0; i < n; i++) { ar.game.time += 1 / 30; ar.game.simulate(1 / 30); } };
  ar.place(0, 900, 400); ar.place(1, 1120, 400); ar.place(2, 2300, 2300);
  Object.assign(a, { item: 'sticky', ammo: 1 });
  const stuck = once(ar.host, 'game:kart:stick', (e) => e.idx === b.idx);
  assert.ok(ar.game.useItem(a));
  for (let i = 0; i < 20 && !b.sticky; i++) tick(1);
  await stuck;
  assert.ok(b.sticky && b.hp === 100, 'stuck on b, nothing yet');
  assert.ok((await latestRow(ar, b.idx)).row[19] > 0, 'the fuse is in the snapshot');
  // Straight away a bump can't pass it on; a moment later it can.
  ar.place(2, b.x + 30, b.y);
  tick(1);
  assert.ok(b.sticky && !c.sticky, 'not passed back and forth instantly');
  ar.place(2, 2300, 2300);
  tick(15);
  const passed = once(ar.host, 'game:kart:stick', (e) => e.idx === c.idx && e.pass);
  ar.place(2, b.x + 30, b.y);
  tick(1);
  assert.strictEqual((await passed).by, b.idx);
  assert.ok(c.sticky && !b.sticky, 'c has it now');
  // c drives off; the fuse runs out on c.
  ar.place(2, 2000, 400);
  const boom = once(ar.host, 'game:kart:boom', (e) => e.kind === 'sticky');
  for (let i = 0; i < 90 && c.sticky; i++) tick(1);
  await boom;
  assert.strictEqual(c.hp, 100 - 75, 'the carrier takes the blast');
  assert.strictEqual(b.hp, 100, 'b got rid of it');
  // A throw that touches nobody lands, and clings to the next rival over it.
  ar.place(0, 900, 400); ar.place(1, 2300, 2300); ar.place(2, 2300, 300);
  Object.assign(a, { item: 'sticky', ammo: 1 });
  ar.game.useItem(a);
  tick(20);
  assert.strictEqual(ar.game.stickies.length, 1, 'lying on the ground');
  const g = ar.game.stickies[0];
  ar.place(1, g.x, g.y);
  tick(1);
  assert.ok(b.sticky && ar.game.stickies.length === 0, 'picked up by driving over it');
  ar.room.destroy();
});

test('spin spikes: rivals that touch them spin out (race) or get hurt and flung (arena); teammates are safe', async () => {
  const c = await kartGame(3, { kartMap: 'grandprix', teamMode: true, teamCount: 2 });
  setTeams(c, [0, 1, 0]);
  const [a, b, mate] = c.players.map((p) => c.game.karts.get(p.id));
  onTrack(c.game, a, 80); onTrack(c.game, b, 80, 0.27); onTrack(c.game, mate, 300);
  Object.assign(a, { item: 'spikes', ammo: 1 });
  assert.ok(c.game.useItem(a));
  assert.ok((await latestRow(c, a.idx)).row[9] & 65536, 'spikes flag');
  // b alongside, close enough for the spikes but not touching.
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(gap > 32 && gap < 46, `side by side (${Math.round(gap)})`);
  c.game.simulate(1 / 30);
  assert.ok(b.spin > 0, 'b spun out');
  Object.assign(mate, { x: a.x + (b.x - a.x) * -1, y: a.y + (b.y - a.y) * -1, spin: 0 });
  c.game.simulate(1 / 30);
  assert.strictEqual(mate.spin, 0, 'teammates are safe');
  c.room.destroy();
  const ar = await arenaGame(2);
  const [x, y] = [ar.kart(0), ar.kart(1)];
  ar.place(0, 1000, 400); ar.place(1, 1040, 400);
  Object.assign(x, { item: 'spikes', ammo: 1 });
  ar.game.useItem(x);
  step(ar.game, 1);
  assert.strictEqual(y.hp, 75);
  assert.ok(y.kx > 100, 'flung away');
  ar.place(1, 1040, 400);
  step(ar.game, 1);
  assert.strictEqual(y.hp, 75, 'once per touch');
  // The spikes snap off after their third victim.
  Object.assign(x, { spikes: 3, spikeHits: 2 });
  Object.assign(y, { spikedBy: null, hp: 100, invuln: 0 });
  ar.game.spikeHit(x, y);
  assert.strictEqual(x.spikes, 0, 'spikes gone after three hits');
  ar.room.destroy();
});

test('decoy box: an item box until a rival drives into it; its owner and teammates pass through', async () => {
  const ar = await arenaGame(3, { teamMode: true, teamCount: 2 });
  setTeams(ar, [0, 1, 0]);
  const [a, b, mate] = [ar.kart(0), ar.kart(1), ar.kart(2)];
  ar.place(0, 1000, 1300); ar.place(1, 2300, 2300); ar.place(2, 2300, 300);
  Object.assign(a, { item: 'decoy', ammo: 1 });
  assert.ok(ar.game.useItem(a));
  const d = ar.game.decoys[0];
  assert.ok(d && d.x < a.x, 'dropped behind');
  const { state } = await latestRow(ar, a.idx);
  assert.deepStrictEqual(state.d[0], [d.id, Math.round(d.x), Math.round(d.y), a.idx], 'sent with its owner');
  ar.place(0, d.x, d.y); ar.place(2, d.x, d.y + 4);
  step(ar.game, 1);
  assert.strictEqual(ar.game.decoys.length, 1, 'the owner and teammates drive through');
  ar.place(0, 1500, 1300); ar.place(2, 2300, 300);
  const boom = once(ar.host, 'game:kart:boom', (e) => e.kind === 'decoy');
  ar.place(1, d.x + 10, d.y);
  step(ar.game, 1);
  await boom;
  assert.strictEqual(b.hp, 60);
  assert.strictEqual(ar.game.decoys.length, 0);
  ar.room.destroy();
});

test('a timed hop clears a banana; driving straight on hits it', async () => {
  const run = async (hopAt) => {
    const c = await kartGame(2, { kartMap: 'grandprix' });
    const [a, owner] = c.players.map((p) => c.game.karts.get(p.id));
    onTrack(c.game, owner, 300);
    onTrack(c.game, a, 40);
    a.speed = 420;
    const t = c.game.map.tangents[40];
    // A banana 90 units dead ahead.
    c.game.bananas.push({ id: 999, x: a.x + t[0] * 90, y: a.y + t[1] * 90, owner: owner.id, life: 30, safe: 0 });
    let i = 0;
    a.input = { up: true, down: false, left: false, right: false, drift: false };
    for (; i < 20; i++) {
      a.input = { ...a.input, drift: i === hopAt };
      c.game.simulate(1 / 30);
      if (!c.game.bananas.length) break;
    }
    const spun = a.spin > 0;
    c.room.destroy();
    return spun;
  };
  assert.strictEqual(await run(-1), true, 'no hop: spun out');
  const timings = [];
  for (let at = 0; at <= 4; at++) timings.push(await run(at));
  assert.ok(timings.includes(false), `some hop timing clears it (spun: ${timings})`);
  assert.ok(timings.includes(true), 'but not any timing');
});

test('star: invincible and faster; ramming spins rivals out (race) or damages them (arena)', async () => {
  const c = await kartGame(3, { kartMap: 'grandprix' });
  const [a, b, d] = c.players.map((p) => c.game.karts.get(p.id));
  onTrack(c.game, a, 40); onTrack(c.game, b, 40); onTrack(c.game, d, 25);
  b.x += Math.cos(b.angle) * 26; // right in front of a
  b.y += Math.sin(b.angle) * 26;
  Object.assign(a, { item: 'star', ammo: 1 });
  assert.ok(c.game.useItem(a));
  assert.strictEqual(a.star, KC.ITEM_FX.starTime);
  c.run(1 / 30);
  assert.ok(b.spin > 0, 'rammed rival spins out');
  assert.strictEqual(a.spin, 0);
  assert.strictEqual(a.hits, 1);
  // Rockets do nothing to a star kart.
  onTrack(c.game, b, 90);
  Object.assign(d, { item: 'rocket', ammo: 1 });
  c.game.useItem(d);
  c.run(1);
  assert.strictEqual(a.spin, 0, 'invincible');
  assert.ok((await latestRow(c, a.idx)).row[9] & 4096, 'star flag');
  c.run(5.1);
  assert.strictEqual(a.star, 0, 'wears off');
  c.room.destroy();

  const ar = await arenaGame(3, { teamMode: true, teamCount: 2 });
  setTeams(ar, [0, 1, 0]);
  const [s, v, mate] = [ar.kart(0), ar.kart(1), ar.kart(2)];
  ar.place(0, 1000, 400); ar.place(1, 1025, 400); ar.place(2, 1000, 2200);
  Object.assign(s, { item: 'star', ammo: 1 });
  ar.game.useItem(s);
  step(ar.game, 1);
  assert.strictEqual(v.hp, 100 - 40);
  Object.assign(v, { x: s.x + 25, y: s.y }); // still touching: one ram, one hit
  step(ar.game, 3);
  assert.strictEqual(v.hp, 60);
  ar.place(2, s.x - 25, s.y);
  step(ar.game, 1);
  assert.strictEqual(mate.hp, 100, 'teammates are never rammed');
  // Faster: top speed rises by ITEM_FX.starSpeed (the browser's prediction uses the same factor).
  ar.place(0, 1300, 300); ar.place(1, 2300, 2300); ar.place(2, 300, 2300);
  Object.assign(s, { star: 6, input: { up: true } });
  step(ar.game, 45);
  assert.ok(s.speed > KC.PHYS.maxSpeed * 1.15, `star top speed (${Math.round(s.speed)})`);
  ar.room.destroy();
});

test('ink: splats only the karts ahead (race) or rivals nearby (arena), never yourself or teammates', async () => {
  const c = await kartGame(6, { kartMap: 'grandprix', teamMode: true, teamCount: 2 });
  setTeams(c, [0, 1, 1, 0, 1, 1]);
  const [a, ahead, behind, mate, ghost, shielded] = c.players.map((p) => c.game.karts.get(p.id));
  onTrack(c.game, a, 50); onTrack(c.game, ahead, 90); onTrack(c.game, behind, 20); onTrack(c.game, mate, 120);
  onTrack(c.game, ghost, 150); onTrack(c.game, shielded, 180);
  ghost.ghost = 3; shielded.shield = 3;
  Object.assign(a, { item: 'ink', ammo: 1 });
  const ev = once(c.host, 'game:kart:ink');
  c.game.useItem(a);
  assert.deepStrictEqual((await ev).hit, [ahead.idx]);
  assert.strictEqual(ahead.ink, KC.ITEM_FX.inkTime);
  for (const k of [a, behind, mate, ghost, shielded]) assert.strictEqual(k.ink, 0);
  const { state } = await latestRow(c, a.idx);
  for (const r of state.k) assert.strictEqual(!!(r[9] & 16384), r[0] === ahead.idx, 'only the inked kart carries the ink flag');
  c.run(KC.ITEM_FX.inkTime + 0.1);
  assert.strictEqual(ahead.ink, 0, 'ink wears off');
  c.room.destroy();

  const ar = await arenaGame(3);
  ar.place(0, 1000, 400); ar.place(1, 1400, 500); ar.place(2, 2300, 2300);
  Object.assign(ar.kart(0), { item: 'ink', ammo: 1 });
  ar.game.useItem(ar.kart(0));
  assert.deepStrictEqual([ar.kart(0).ink > 0, ar.kart(1).ink > 0, ar.kart(2).ink > 0], [false, true, false]);
  ar.room.destroy();
});

test('thunder: rivals spin out, shrink, slow down and lose their item; teammates, ghosts, stars and shields are spared', async () => {
  const c = await kartGame(7, { kartMap: 'grandprix', teamMode: true, teamCount: 2 });
  setTeams(c, [0, 1, 1, 0, 1, 1, 1]);
  const [a, holder, rolling, mate, ghost, star, shield] = c.players.map((p) => c.game.karts.get(p.id));
  [a, holder, rolling, mate, ghost, star, shield].forEach((k, i) => onTrack(c.game, k, 10 + i * 25));
  Object.assign(holder, { item: 'rocket', ammo: 1, item2: 'star', ammo2: 1 });
  Object.assign(rolling, { item: 'banana', ammo: 1, roulette: 0.5 });
  Object.assign(mate, { item: 'boost', ammo: 1 });
  Object.assign(ghost, { ghost: 3 });
  Object.assign(star, { star: 3 });
  Object.assign(shield, { shield: 3 });
  Object.assign(a, { item: 'thunder', ammo: 1 });
  const ev = once(c.host, 'game:kart:thunder');
  assert.ok(c.game.useItem(a));
  assert.deepStrictEqual((await ev).hit, [holder.idx, rolling.idx]);
  for (const k of [holder, rolling]) {
    assert.ok(k.spin > 0, 'spun out');
    assert.strictEqual(k.shrink, KC.ITEM_FX.shrinkTime);
    assert.strictEqual(k.item, null, 'item lost');
    assert.strictEqual(k.item2, null, 'the reserve item too');
    assert.strictEqual(k.roulette, 0);
  }
  assert.strictEqual(mate.item, 'boost');
  for (const k of [a, mate, ghost, star, shield]) { assert.strictEqual(k.spin, 0); assert.strictEqual(k.shrink, 0); }
  assert.strictEqual(shield.shield, 0, 'the shield took the strike');
  assert.ok((await latestRow(c, holder.idx)).row[9] & 8192, 'shrunk flag');
  assert.strictEqual(a.hits, 1);
  c.run(KC.ITEM_FX.shrinkTime + 0.1);
  assert.strictEqual(holder.shrink, 0, 'back to full size');
  c.room.destroy();

  // Arena: damages everyone else. Shrunk karts have a lower top speed.
  const ar = await arenaGame(3);
  ar.place(0, 1000, 400); ar.place(1, 1400, 500); ar.place(2, 2300, 2300);
  Object.assign(ar.kart(0), { item: 'thunder', ammo: 1 });
  ar.game.useItem(ar.kart(0));
  assert.deepStrictEqual([ar.kart(0).hp, ar.kart(1).hp, ar.kart(2).hp], [100, 65, 65]);
  const k = ar.kart(1);
  ar.place(1, 1300, 300);
  Object.assign(k, { shrink: 3, input: { up: true } });
  step(ar.game, 45);
  assert.ok(Math.abs(k.speed - KC.PHYS.maxSpeed * KC.ITEM_FX.shrinkSpeed) < 5, `shrunk top speed (${Math.round(k.speed)})`);
  ar.room.destroy();
});

test('a banana or mine held behind the kart blocks a shell from behind', async () => {
  const { room, game, kart, place } = await arenaGame(2);
  const [a, b] = [kart(0), kart(1)];
  place(0, 1000, 400); place(1, 1100, 400); // a fires at b's back
  Object.assign(b, { item: 'banana', ammo: 1 });
  Object.assign(a, { item: 'rocket', ammo: 1 });
  game.useItem(a);
  step(game, 6);
  assert.strictEqual(b.hp, 100);
  assert.strictEqual(b.item, null, 'the banana was used up');
  // Still rolling: no protection yet.
  place(0, 1000, 400); place(1, 1100, 400);
  Object.assign(b, { item: 'mine', ammo: 1, roulette: 0.5 });
  Object.assign(a, { item: 'rocket', ammo: 1 });
  game.useItem(a);
  step(game, 6);
  assert.strictEqual(b.hp, 30);
  // Only a hit that would have hurt uses the item up: star power, a shield or invulnerability keep it.
  for (const guard of [{ star: 3 }, { shield: 3 }, { invuln: 1 }]) {
    const what = Object.keys(guard)[0];
    place(0, 1000, 400); place(1, 1100, 400);
    Object.assign(b, { hp: 100, star: 0, item: 'banana', ammo: 1, ...guard });
    Object.assign(a, { item: 'rocket', ammo: 1 });
    game.useItem(a);
    step(game, 6);
    assert.strictEqual(game.shots.length, 0, `${what}: the rocket is gone`);
    assert.strictEqual(b.hp, 100, `${what}: no damage`);
    assert.strictEqual(b.item, 'banana', `${what}: the banana is kept`);
    if (what === 'shield') assert.strictEqual(b.shield, 0, 'the shield took the hit instead');
  }
  room.destroy();
});

test('the race leader never rolls ink or a comet (nobody ahead to hit), with or without catch-up', async () => {
  for (const kartCatchup of [true, false]) {
    const c = await kartGame(3, { kartItems: 'custom', kartItemList: ['ink', 'comet', 'banana'], kartCatchup });
    const [lead, mid, last] = c.players.map((p) => c.game.karts.get(p.id));
    lead.progress = 900; mid.progress = 500; last.progress = 0;
    const rolls = (k) => {
      const seen = new Set();
      for (let i = 0; i < 400; i++) { c.game.time += 30; seen.add(c.game.rollItem(k)); }
      return seen;
    };
    assert.deepStrictEqual([...rolls(lead)], ['banana'], `catch-up ${kartCatchup}: the leader`);
    const back = rolls(last);
    assert.ok(back.has('ink') && back.has('comet'), `catch-up ${kartCatchup}: last place rolled ${[...back]}`);
    // Only teammates ahead: you are leading as far as ink and comets are concerned.
    if (!kartCatchup) {
      c.room.settings.teamMode = true;
      setTeams(c, [0, 0, 1]);
      mid.progress = 1000;
      assert.deepStrictEqual([...rolls(lead)], ['banana'], 'only a teammate ahead');
    }
    c.room.destroy();
  }
  // A list with nothing else in it still hands out ink.
  const solo = await kartGame(2, { kartItems: 'custom', kartItemList: ['ink'] });
  const k = solo.game.karts.get(solo.players[0].id);
  k.progress = 900;
  assert.strictEqual(solo.game.rollItem(k), 'ink');
  solo.room.destroy();
});

test('arena comets go for the top scorer, picking at random between rivals tied on top', async () => {
  const ar = await arenaGame(4);
  const [o, b, c] = [0, 1, 2].map(ar.kart);
  ar.place(0, 400, 400); ar.place(1, 2200, 400); ar.place(2, 2200, 2200); ar.place(3, 400, 2200);
  // Everyone on 0 kills (the start of every battle): not always the first player who joined.
  const targets = new Set();
  for (let i = 0; i < 12; i++) {
    Object.assign(o, { item: 'comet', ammo: 1 });
    assert.ok(ar.game.useItem(o));
    targets.add(ar.game.shots.pop().target);
  }
  assert.ok(targets.size >= 2, `comets spread over the tied rivals (${targets.size} targeted)`);
  assert.ok(!targets.has(o.id), 'never the owner');
  // A clear leader is always the target; on equal kills, fewer deaths wins.
  c.kills = 2;
  for (let i = 0; i < 20; i++) assert.strictEqual(ar.game.cometTarget(o), c);
  b.kills = 2; c.deaths = 1;
  for (let i = 0; i < 20; i++) assert.strictEqual(ar.game.cometTarget(o), b);
  assert.notStrictEqual(ar.game.cometTarget(b), b);
  ar.room.destroy();
});

test('a star ram hits once per ram without making the victim immune to everyone else', async () => {
  const ar = await arenaGame(3);
  const [s, v, c] = [0, 1, 2].map(ar.kart);
  ar.place(0, 1000, 400); ar.place(1, 1025, 400); ar.place(2, 1000, 2200);
  Object.assign(s, { item: 'star', ammo: 1 });
  ar.game.useItem(s);
  step(ar.game, 1);
  assert.strictEqual(v.hp, 60, 'rammed');
  assert.strictEqual(v.invuln, 0);
  assert.ok(ar.game.damage(v, 20, c, 'rocket'), 'a follow-up hit from someone else lands');
  assert.strictEqual(v.hp, 40);
  Object.assign(v, { x: s.x + 25, y: s.y }); // still touching the same star kart: no second hit yet
  step(ar.game, 3);
  assert.strictEqual(v.hp, 40);
  ar.game.time += 1; // a moment later, a fresh ram hits again
  Object.assign(v, { x: s.x + 25, y: s.y });
  step(ar.game, 1);
  assert.strictEqual(v.hp, 0, 'second ram');
  assert.ok(v.dead > 0);
  assert.strictEqual(s.kills, 1);
  ar.room.destroy();
});

test('new items: weapons-only and custom lists, catch-up odds and rare-item cooldowns', async () => {
  for (const kartMode of ['race', 'arena']) {
    const c = await kartGame(3, { kartMode, kartItems: 'weapons' });
    [...c.game.karts.values()].forEach((k, j) => { k.progress = 300 - j * 100; }); // spread out: someone to aim at
    const seen = new Set();
    for (const k of c.game.karts.values()) for (let i = 0; i < 400; i++) { c.game.time += 1; seen.add(c.game.rollItem(k)); }
    for (const it of ['bouncer', 'comet', 'thunder']) assert.ok(seen.has(it), `${kartMode}: weapons mode rolls ${it}`);
    for (const it of ['star', 'ink', 'boost']) assert.ok(!seen.has(it), `${kartMode}: weapons mode never rolls ${it}`);
    c.room.destroy();
  }
  const custom = await kartGame(2, { kartItems: 'custom', kartItemList: ['star', 'ink', 'nope', 'thunder', 'banana'] });
  assert.deepStrictEqual(custom.room.settings.kartItemList, ['banana', 'star', 'ink', 'thunder']);
  assert.deepStrictEqual(custom.init.itemList, ['banana', 'star', 'ink', 'thunder']);
  // Catch-up: the leader never gets the comeback items (nor ink: nobody is ahead); the last kart does.
  const [lead, last] = custom.players.map((p) => custom.game.karts.get(p.id));
  lead.progress = 500; last.progress = 0;
  const leadRolls = new Set();
  const lastRolls = new Set();
  for (let i = 0; i < 300; i++) {
    custom.game.time += 30;
    leadRolls.add(custom.game.rollItem(lead));
    lastRolls.add(custom.game.rollItem(last));
  }
  assert.deepStrictEqual([...leadRolls], ['banana']);
  assert.ok(lastRolls.has('star') && lastRolls.has('thunder') && lastRolls.has('ink'));
  custom.room.destroy();
  // At most one comet per cooldown, however many boxes get hit.
  const cd = await kartGame(2, { kartMode: 'arena', kartItems: 'custom', kartItemList: ['comet', 'banana'] });
  const k = cd.game.karts.get(cd.players[0].id);
  let comets = 0;
  for (let i = 0; i < 300; i++) if (cd.game.rollItem(k) === 'comet') comets++;
  assert.ok(comets <= 1, `${comets} comets in one cooldown`);
  cd.game.time += 13;
  comets = 0;
  for (let i = 0; i < 300; i++) if (cd.game.rollItem(k) === 'comet') comets++;
  assert.strictEqual(comets, 1, 'available again after the cooldown');
  cd.room.destroy();
});

test('CPU drivers use the new items in races and battles', async () => {
  for (const kartMode of ['race', 'arena']) {
    const c = await kartGame(1, {
      kartMode, kartBots: 7, kartBotSkill: 'hard', kartBoxRespawn: 'frequent',
      kartItems: 'custom', kartItemList: ['bouncer', 'comet', 'star', 'ink', 'thunder'],
    });
    const used = new Set();
    const emit = c.room.emit.bind(c.room);
    c.room.emit = (event, data) => { if (event === 'game:kart:use') used.add(data.item); return emit(event, data); };
    c.run(45);
    assert.strictEqual(c.game.botError, false);
    for (const kk of c.game.karts.values()) assert.ok(Number.isFinite(kk.x) && Number.isFinite(kk.y));
    assert.ok(used.size >= 4, `${kartMode}: bots used ${[...used]}`);
    c.room.destroy();
  }
});

test('page assets: every kart ES module is versioned and every classic script is loaded', () => {
  const fs = require('fs');
  const path = require('path');
  const { renderIndex } = require('../server/assets');
  const pub = path.join(__dirname, '..', 'public');
  const html = renderIndex(pub);
  // Relative imports between modules don't carry the ?v= of their parent: the import map must.
  const dir = path.join(pub, 'js', 'games', 'kart3d');
  const modules = ['kart3d.js', ...fs.readdirSync(dir).map((f) => `kart3d/${f}`)];
  for (const f of modules) {
    const src = fs.readFileSync(path.join(pub, 'js', 'games', f), 'utf8');
    for (const [, rel] of src.matchAll(/from '\.\/([\w/]+\.js)'/g)) {
      const url = `/js/games/${path.posix.join(path.posix.dirname(f), rel)}`;
      assert.match(html, new RegExp(`"${url}": "${url}\\?v=[0-9a-f]{10}"`), `${url} (imported by ${f}) is in the import map`);
    }
  }
  for (const s of ['kart-hud.js', 'kart-minimap.js', 'kart.js']) assert.ok(html.includes(`/js/games/${s}?v=`), `${s} is loaded`);
  assert.ok(html.includes('/js/item-icons.js?v='), 'item-icons.js is loaded');
  assert.ok(html.indexOf('kart-hud.js') < html.indexOf('/js/games/kart.js'), 'the HUD kit loads before kart.js');
  assert.ok(html.includes('/js/shared/kart-layers.js?v='), 'kart-layers.js is loaded');
  assert.ok(html.indexOf('/js/shared/kart-layers.js') < html.indexOf('/js/shared/kart-core.js'), 'layered arenas load before kart-core, which needs them');
  assert.ok(html.includes('/js/shared/kart-weekly.js?v='), 'kart-weekly.js is loaded');
  assert.ok(html.indexOf('/js/shared/kart-layers.js') < html.indexOf('/js/shared/kart-weekly.js')
    && html.indexOf('/js/shared/kart-weekly.js') < html.indexOf('/js/shared/kart-core.js'), 'the weekly arena loads after the layers it builds on and before kart-core');
});

// ---------- kart netcode ----------
// A tiny seeded generator, so the input patterns below are the same every run.
function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('kart netcode: an input is used at the tick matching its step; a late one as soon as it can be, and the gap grows to fit', async () => {
  const c = await kartGame(1, { kartMap: 'grandprix', kartItems: 'none' });
  const g = c.game;
  const player = c.room.players.get(c.players[0].id);
  const kart = g.karts.get(player.id);
  const send = (input, step, now) => g.onEvent(player, 'input', { up: false, down: false, left: false, right: false, drift: false, ...input, c: step, n: now });
  const tickTo = (t) => { while (g.tickCount < t) g.tick(1 / 30); };
  g.tickCount = 1000;
  // Sent at step 500, starting at 501: from now on step s is used at tick s + 501 (500 to get here, one to spare).
  send({ up: true }, 501, 500);
  assert.strictEqual(kart.net.off, 501);
  tickTo(1001);
  assert.strictEqual(kart.input.up, false, 'not before its tick');
  tickTo(1002);
  assert.strictEqual(kart.input.up, true, 'on its tick');
  assert.strictEqual(kart.net.L, 501, 'this tick is the player\'s step 501');
  // An early one waits for its tick.
  send({ up: true, left: true }, 504, 503);
  tickTo(1004);
  assert.strictEqual(kart.input.left, false);
  tickTo(1005);
  assert.strictEqual(kart.input.left, true);
  // Two changes in one step: the last one counts.
  send({ up: true, right: true }, 507, 506);
  send({ up: true }, 507, 506);
  tickTo(1008);
  assert.deepStrictEqual([kart.input.left, kart.input.right], [false, false]);
  // Late: sent at step 508, due at tick 1009, but held up until tick 1014. The gap grows to 507 (506
  // to get here, one to spare), and it's used at 509 + 507 = 1016...
  tickTo(1014);
  send({ up: true, right: true }, 509, 508);
  assert.strictEqual(kart.net.off, 507);
  tickTo(1015);
  assert.strictEqual(kart.input.right, false);
  tickTo(1016);
  assert.strictEqual(kart.input.right, true);
  assert.strictEqual(kart.net.L, 509);
  // ...and an older input sent again changes nothing.
  send({ up: false }, 505, 510);
  assert.strictEqual(kart.input.up, true);
  // An input can't start before it was sent.
  send({ up: true, left: true }, 600, 511);
  assert.strictEqual(kart.net.q.at(-1).c, 512);
  // A page that starts counting again (reloaded) starts over; one without step numbers is used at once.
  send({ up: true, drift: true }, 3, 2);
  assert.strictEqual(kart.net.off, g.tickCount - 2 + 1);
  assert.strictEqual(kart.net.q.length, 1);
  g.onEvent(player, 'input', { down: true });
  assert.strictEqual(kart.input.down, true);
  c.room.destroy();
});

// Drives one player's kart through the server tick by tick with a seeded pattern of inputs, sent as
// their page would and held up 2-4 ticks on the way, and checks that the server used nearly all of
// them at exactly the page's steps, and that replaying the page's inputs from any server update
// lands exactly on a later one: the page and the server agree to the last bit.
async function replayCheck(settings, seed, ticks, place) {
  const K = require('../public/js/shared/kart-core');
  const c = await kartGame(1, { kartItems: 'none', ...settings });
  const g = c.game;
  g.time = 0;
  const player = c.room.players.get(c.players[0].id);
  const kart = g.karts.get(player.id);
  if (place) place(g, kart);
  const acks = [];
  const emitTo = c.room.emitTo.bind(c.room);
  c.room.emitTo = (id, event, data) => { if (event === 'game:kart:me') acks.push(JSON.parse(JSON.stringify(data))); emitTo(id, event, data); };
  g.tickCount = 2000;
  const rand = mulberry(seed);
  const log = [];
  let input = { up: true, down: false, left: false, right: false, drift: false };
  let step = 900; // the page's own clock
  const inFlight = [];
  const used = new Map(); // `${gap}:${step}` -> the input the server used for that step
  for (let i = 0; i < ticks; i++) {
    // The page: now and then a new input, starting at its next step.
    if (i % 4 === 0 && rand() < 0.6) {
      const r = rand();
      input = { up: r > 0.08, down: r < 0.08, left: r > 0.55 && r < 0.75, right: r >= 0.75, drift: rand() < 0.2 };
      log.push({ c: step + 1, input });
      inFlight.push({ at: i + 2 + Math.floor(rand() * 3), data: { ...input, c: step + 1, n: step } });
    }
    step++;
    for (const m of inFlight.filter((m) => m.at === i)) g.onEvent(player, 'input', m.data);
    g.tick(1 / 30);
    if (kart.net.L !== null) used.set(`${kart.net.off}:${kart.net.L}`, { ...kart.input });
  }
  const inputAt = (j) => {
    let cur = { up: false, down: false, left: false, right: false, drift: false };
    for (const e of log) if (e.c <= j) cur = e.input;
    return cur;
  };
  const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
  // How often the server used the page's input for a step (it can't when an input comes in late).
  const steps = [...used.entries()].filter(([key]) => +key.split(':')[1] > log[0].c);
  const onTime = steps.filter(([key, inp]) => same(inp, inputAt(+key.split(':')[1]))).length / steps.length;
  let compared = 0;
  for (let a = 0; a < acks.length; a++) {
    for (let b = a + 1; b < Math.min(acks.length, a + 6); b++) {
      const [A, B] = [acks[a], acks[b]];
      const gap = 121 - A.g;
      // (Not across a wreck or a fall, nor a change of gap, nor a step whose input came in late:
      // the server used the one before, so the page's replay is rightly corrected there.)
      const span = acks.slice(a, b + 1);
      if (span.some((x) => x.f & 6 || x.g !== A.g) || B.L <= A.L) continue;
      let late = false;
      for (let j = A.L + 1; j <= B.L; j++) if (!same(used.get(`${gap}:${j}`) || {}, inputAt(j))) late = true;
      if (late) continue;
      const st = K.unpackKart(A.s);
      for (let j = Math.max(A.L + 1, A.g); j <= B.L; j++) {
        K.stepNet(st, inputAt(j), 1 / 30, g.map, { speed: c.init.speedMul || 1, noFall: true, t: A.t + (j - A.L) / 30 });
      }
      const want = K.unpackKart(B.s);
      for (const f of K.NET_FIELDS) {
        const x = st[f] ?? undefined; // (unset or null: the physics reads both the same)
        const y = want[f] ?? undefined;
        if (x === undefined || y === undefined) {
          assert.strictEqual(x === undefined, y === undefined, `${settings.kartMap} ${f} set on one side only (ack ${a} to ${b})`);
          continue;
        }
        const d = typeof x === 'boolean' || typeof y === 'boolean' ? Number(x) - Number(y) : x - y;
        assert.ok(Math.abs(d) < 1e-6, `${settings.kartMap} ${f}: replay ${x} vs server ${y} (ack ${a} to ${b})`);
      }
      compared++;
    }
  }
  c.room.destroy();
  return { compared, onTime, acks: acks.length };
}

test('kart netcode: replaying a player\'s inputs from a server update lands exactly on the next ones (race track)', async () => {
  const r = await replayCheck({ kartMap: 'grandprix' }, 7, 240, (g, k) => onTrack(g, k, 30));
  assert.ok(r.compared > 300, `compared ${r.compared} pairs`);
  assert.ok(r.onTime > 0.95, `the server used the page's input for ${Math.round(r.onTime * 100)}% of its steps`);
});

test('kart netcode: replays agree on a layered arena too (moving obstacles, ramps, jump pads)', async () => {
  for (const [map, seed] of [['keep', 3], ['harbour', 5], ['skygardens', 11], ['graveyard', 2], ['cinderbowl', 4]]) {
    const r = await replayCheck({ kartMode: 'arena', kartMap: map, arenaTime: 600 }, seed, 240);
    assert.ok(r.compared > 100, `${map}: compared ${r.compared} pairs`);
    assert.ok(r.onTime > 0.95, `${map}: the server used the page's input for ${Math.round(r.onTime * 100)}% of its steps`);
  }
});
