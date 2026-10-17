// The weekly arena (shared/kart-weekly.js): the week's number, the generator, its checks, and how
// kart-core, the server and the lobby serve it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const W = require('../public/js/shared/kart-weekly');
const K = require('../public/js/shared/kart-core');
const { KartBattle } = require('../server/games/kart');
const Bots = require('../server/games/kart-bots');
const { server, rooms } = require('../server/index');

const DAY = 86400000;
const at = (iso) => Date.parse(iso);

test('weekly: ISO weeks in UTC, and when the next one starts', () => {
  assert.deepStrictEqual(W.weekOf(at('2026-01-01T12:00:00Z')), { year: 2026, week: 1 }); // a Thursday
  assert.deepStrictEqual(W.weekOf(at('2027-01-01T12:00:00Z')), { year: 2026, week: 53 }); // a Friday: 2026's last week
  assert.deepStrictEqual(W.weekOf(at('2024-12-30T00:00:00Z')), { year: 2025, week: 1 }); // the Monday of 2025's first week
  assert.deepStrictEqual(W.weekOf(at('2026-10-18T23:59:59Z')), { year: 2026, week: 42 }); // Sunday night...
  assert.deepStrictEqual(W.weekOf(at('2026-10-19T00:00:00Z')), { year: 2026, week: 43 }); // ...and Monday
  assert.strictEqual(W.mondayOf({ year: 2026, week: 42 }), at('2026-10-12T00:00:00Z'));
  assert.strictEqual(W.nextWeekAt(at('2026-10-17T10:00:00Z')), at('2026-10-19T00:00:00Z'));
  assert.strictEqual(W.weekKey({ year: 2026, week: 7 }), '2026-07');
  assert.strictEqual(W.parseKey('2026-7'), null);
});

test('weekly: a week makes the same arena on every machine, and the looks take turns', () => {
  const a = W.weeklyDef('2026-42', 0);
  assert.strictEqual(JSON.stringify(W.weeklyDef('2026-42', 0)), JSON.stringify(a));
  assert.notStrictEqual(JSON.stringify(W.weeklyDef('2026-42', 1)), JSON.stringify(a), 'another attempt, another layout');
  assert.notStrictEqual(JSON.stringify(W.weeklyDef('2026-43', 0)), JSON.stringify(a), 'another week, another layout');
  assert.strictEqual(a.id, 'weekly-2026-42-a0');
  assert.match(a.name, /^The [A-Z]\w+ [A-Z]\w+$/);
  assert.strictEqual(W.weeklyInfo('2026-42').name, a.name, 'the name needs no layout');
  // Five looks, and never the same one two weeks running.
  const looks = [];
  for (let i = 0; i < 10; i++) looks.push(W.weeklyInfo(W.weekKey(W.weekOf(at('2026-03-04T12:00:00Z') + i * 7 * DAY))).theme);
  assert.strictEqual(new Set(looks).size, 5);
  for (let i = 1; i < looks.length; i++) assert.notStrictEqual(looks[i], looks[i - 1]);
  // And no name comes back for years.
  const names = new Set();
  for (let i = 0; i < 5 * 64; i++) names.add(W.weeklyInfo(W.weekKey(W.weekOf(at('2026-03-04T12:00:00Z') + i * 7 * DAY))).name);
  assert.strictEqual(names.size, 5 * 64);
});

test('weekly: half a year of weeks all make an arena that passes the checks, nearly always first time', () => {
  let first = 0;
  const plans = new Set();
  const start = W.mondayOf({ year: 2026, week: 27 });
  for (let i = 0; i < 26; i++) {
    const key = W.weekKey(W.weekOf(start + i * 7 * DAY + 3600000));
    const res = W.weeklyArena(key);
    assert.ok(res, `${key}: a layout passed`);
    if (res.attempt === 0) first++;
    plans.add(res.def.weekly.plan);
    const def = res.def;
    assert.ok(def.spawns.length >= 16 && def.boxes.length >= 16, `${key}: ${def.spawns.length} spawns, ${def.boxes.length} boxes`);
    assert.ok(res.stats.connected >= 0.85, `${key}: ${res.stats.connected} of the floor connected`);
    for (const p of def.spawns) assert.strictEqual(res.map.floorAt(p.x, p.y, p.z + 10, 0), p.z);
  }
  assert.ok(first >= 22, `${first} of 26 weeks passed first time`);
  assert.ok(plans.size >= 3, `${[...plans].join(', ')}: the arenas come in different shapes`);
});

test('weekly: the checker throws out a layout with a spawn walled in or a jump pad to nowhere', () => {
  const def = W.weeklyDef('2026-42', 0);
  assert.strictEqual(W.check(def).ok, true);
  const s = def.spawns[3];
  const wall = (x0, y0, x1, y1) => ({ x0: s.x + x0, y0: s.y + y0, x1: s.x + x1, y1: s.y + y1, z0: -40, z1: 300, kind: 'wall' });
  const boxedIn = { ...def, blocks: [...def.blocks, wall(-130, -130, 130, -110), wall(-130, 110, 130, 130), wall(-130, -110, -110, 110), wall(110, -110, 130, 110)] };
  const res = W.check(boxedIn);
  assert.strictEqual(res.ok, false);
  assert.ok(res.why.some((w) => w.startsWith('spawn 3 ')), res.why.join('; '));
  const pad = { x: 600, y: 600, z: 0, r: 40, to: [5, 5, 0], t: 1 };
  const nowhere = W.check({ ...def, pads: [...def.pads, pad] });
  assert.strictEqual(nowhere.ok, false);
  assert.ok(nowhere.why.some((w) => /lands nowhere/.test(w)), nowhere.why.join('; '));
});

test('weekly: kart-core serves this week as "weekly" and any week by its exact id', () => {
  const listed0 = K.mapList().find((m) => m.id === 'weekly');
  assert.ok(listed0 && listed0.type === 'arena' && listed0.weekly.week, 'listed before it is made');
  const map = K.getMap('weekly', 'arena');
  assert.ok(map.layered && map.weekly);
  assert.match(map.id, /^weekly-\d{4}-\d{2}-a\d+$/);
  assert.strictEqual(K.getMap(map.id, 'arena'), map, 'the exact id gives the same arena');
  const listed = K.mapList().find((m) => m.id === 'weekly');
  assert.strictEqual(listed.weekly.mapId, map.id);
  assert.strictEqual(listed.name, map.name);
  assert.strictEqual(listed.blurb, map.blurb);
  assert.ok(listed.weekly.next > Date.now() && listed.weekly.next <= Date.now() + 7 * DAY);
  // An exact id builds that layout without checking it: what players load when the server says so.
  const past = K.getMap('weekly-2026-30-a0', 'arena');
  assert.strictEqual(past.id, 'weekly-2026-30-a0');
  assert.strictEqual(past.spawns.length, W.weeklyDef('2026-30', 0).spawns.length);
  assert.strictEqual(K.mapInfo('weekly-2026-30-a0').name, W.weeklyInfo('2026-30').name);
  assert.strictEqual(K.getMap('weekly-1999-99-a0', 'arena').id, K.DEFAULT_MAP.arena, 'nonsense falls back to the default arena');
});

test('weekly: CPU drivers play-test every layout before it goes live, the same way every time', () => {
  const { playtest } = require('../server/games/kart-playtest');
  const def = W.weeklyDef('2026-42', 0);
  const a = playtest(def);
  assert.deepStrictEqual(playtest(def), a, 'loaded dice: the same verdict every time');
  assert.ok(a.stats.boxes > 0 && a.stats.stalled >= 0);
  // An arena with nothing to pick up is turned down.
  const bare = playtest({ ...def, id: 'weekly-2026-42-a0', boxes: [] });
  assert.strictEqual(bare.ok, false);
  assert.ok(bare.why.some((w) => /boxes a minute/.test(w)), bare.why.join('; '));
  // This week's arena passed it (the server installs the play test).
  const map = K.getMap('weekly', 'arena');
  assert.strictEqual(playtest(W.weeklyDef(map.weekly.key, map.weekly.attempt)).ok, true);
});

test('weekly: CPU drivers find their way round this week\'s arena', () => {
  const room = {
    settings: { kartMode: 'arena', kartMap: 'weekly', arenaTime: 600, kartItems: 'none', kartBots: 6, kartBotSkill: 'normal' },
    players: new Map(), connectedPlayers: [], emit() {}, emitTo() {}, teamList: () => [], systemMessage() {},
    buildResults: () => ({ players: [] }), finishGame() {},
  };
  const game = new KartBattle(room);
  assert.ok(game.layered && game.map.weekly);
  Bots.makeBots(6, { skill: 'normal' }).forEach((b, i) => game.addKart(b, i));
  game.items = ['rocket'];
  game.boxes = game.map.itemBoxes.map(() => 0);
  game.rollItem = () => null;
  game.phase = 'racing';
  game.raceStart = 0;
  let boxes = 0;
  for (let i = 0; i < 45 * 30; i++) {
    game.time += 1 / 30;
    const before = game.boxes.filter((b) => b > 0).length;
    game.simulate(1 / 30);
    boxes += Math.max(0, game.boxes.filter((b) => b > 0).length - before);
  }
  assert.strictEqual(game.botError, false);
  assert.ok(boxes >= 12, `${boxes} boxes picked up`);
});

// ---------- through the server ----------
let url;
const sockets = [];
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});
after(async () => {
  sockets.forEach((s) => s.close());
  rooms.stopWeekly();
  for (const room of rooms.rooms.values()) room.destroy();
  await new Promise((resolve) => server.close(resolve));
});
function client() {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}
const call = (s, event, data) => new Promise((resolve) => s.emit(event, data, resolve));
const once = (s, event, pred = () => true, timeout = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
  const fn = (data) => {
    if (!pred(data)) return;
    clearTimeout(t);
    s.off(event, fn);
    resolve(data);
  };
  s.on(event, fn);
});

test('weekly: the lobby lists it, a game on it sends its exact id, and each new week is announced', async () => {
  rooms.startWeekly();
  const host = client();
  const made = await call(host, 'room:create', { name: 'Host' });
  assert.ok(made.ok);
  const room = rooms.rooms.get(made.code);
  const entry = room.publicState().kartMaps.find((m) => m.id === 'weekly');
  assert.ok(entry && entry.weekly.mapId, 'the lobby has this week\'s arena, made already');
  await call(host, 'lobby:settings', { mode: 'kart', kartMap: 'weekly' });
  assert.strictEqual(room.settings.kartMode, 'arena');
  assert.strictEqual(room.settings.kartMap, 'weekly');
  const init = once(host, 'game:kart:init');
  await call(host, 'game:start');
  const data = await init;
  assert.strictEqual(data.mapId, entry.weekly.mapId, 'players are told the exact layout');
  assert.strictEqual(K.getMap(data.mapId, data.map), room.game.map);
  room.backToLobby();
  // Monday comes round: the new arena is made and every room hears about it.
  const said = once(host, 'chat', (m) => m.system && /New weekly arena/.test(m.text));
  const next = rooms.refreshWeekly(true, W.nextWeekAt() + 1000);
  assert.ok(next && next.id !== entry.weekly.mapId);
  assert.match((await said).text, new RegExp(next.name));
  room.destroy();
});
