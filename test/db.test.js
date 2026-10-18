// The database's record of play, against a real Postgres: set TEST_DATABASE_URL to run these
// (they're skipped without it). Every table is emptied first.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Database, deviceOf, slim } = require('../server/db');
const { RoomManager } = require('../server/rooms');

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run the database tests';

// A room manager on fake sockets (no network): just enough for rooms to run.
const io = { to: () => ({ emit() {}, except: () => ({ emit() {} }) }), sockets: { sockets: new Map() } };
let n = 0;
function socket(ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1') {
  return { id: `s${++n}`, data: {}, join() {}, leave() {}, emit() {}, handshake: { headers: { 'user-agent': ua, 'cf-ipcountry': 'IN' } } };
}
const call = (fn) => new Promise((resolve) => fn(resolve));

let db;
before(async () => {
  if (skip) return;
  db = new Database(URL);
  assert.strictEqual(await db.start(), true);
  await db.query('truncate profiles, rooms, room_players, games, game_players, game_events, weekly_arenas, client_errors cascade');
});
after(async () => { await db?.close(); });

test('db: the tables are made once (starting again changes nothing)', { skip }, async () => {
  const again = new Database(URL);
  assert.strictEqual(await again.start(), true);
  const { rows } = await again.query('select version, name from schema_migrations order by version');
  assert.ok(rows.length >= 1 && rows[0].name === '001_initial.sql');
  await again.close();
});

test('db: rooms, players, a game with its results and events, and each browser\'s totals', { skip }, async () => {
  const rooms = new RoomManager(io, db);
  const host = crypto.randomUUID();
  const guest = crypto.randomUUID();
  const a = socket();
  const res = await call((ack) => rooms.create(a, { name: 'Ana', avatar: 2, profile: host }, ack));
  assert.ok(res.ok);
  const room = rooms.rooms.get(res.code);
  const b = socket('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36');
  await call((ack) => rooms.join(b, { code: res.code, name: 'Ben', profile: guest }, ack));
  await call((ack) => rooms.join(socket(), { code: res.code, name: 'NoProfile', profile: 'not-a-uuid' }, ack));
  room.handle(room.players.get(res.playerId), 'chat', { text: 'hi all' }, null);

  Object.assign(room.settings, { mode: 'kart', kartMode: 'arena', kartMap: 'minigolf', kartBots: 1 });
  assert.ok(room.startGame().ok);
  const game = room.game;
  game.stop();
  const [ana, ben] = [...room.players.values()];
  room.record('kart_kill', ana.id, { victim: ben.id, kind: 'rocket' });
  room.finishGame(game, room.buildResults(new Map([[ana.id, 300], [ben.id, 100]])));
  room.removePlayer(ben.id);
  await db.flush();

  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const [r] = await q('select * from rooms where id = $1', [room.dbId]);
  assert.strictEqual(r.code, res.code);
  assert.strictEqual(r.owner_profile, host);
  const members = await q('select * from room_players where room_id = $1 order by joined_at', [room.dbId]);
  assert.deepStrictEqual(members.map((m) => m.name), ['Ana', 'Ben', 'NoProfile']);
  assert.deepStrictEqual([members[0].device, members[0].browser, members[0].country, members[0].chat_messages], ['phone', 'safari', 'IN', 0]);
  assert.strictEqual(members[1].browser, 'chrome');
  assert.ok(members[1].left_at, 'Ben left');
  assert.strictEqual(members[2].profile_id, null, 'a malformed profile id is not kept');

  const [g] = await q('select * from games where room_id = $1', [room.dbId]);
  assert.deepStrictEqual([g.mode, g.variant, g.map_id, g.outcome, g.humans, g.bots], ['kart', 'arena', 'minigolf', 'finished', 3, 1]);
  assert.ok(g.duration_ms >= 0 && g.results.players.length >= 3);
  const gp = await q('select * from game_players where game_id = $1 order by place', [g.id]);
  assert.deepStrictEqual(gp.slice(0, 2).map((p) => [p.name, p.place, p.score, p.profile_id]), [['Ana', 1, 300, host], ['Ben', 2, 100, guest]]);
  const ev = await q('select * from game_events where game_id = $1', [g.id]);
  assert.deepStrictEqual([ev[0].type, ev[0].player_id, ev[0].data.kind], ['kart_kill', ana.id, 'rocket']);

  const [p] = await q('select * from profile_stats where id = $1', [host]);
  assert.deepStrictEqual([p.name, Number(p.games_played), Number(p.wins), Number(p.kart_games)], ['Ana', 1, 1, 1]);

  // A game stopped half way, then the room closing.
  assert.ok(room.startGame().ok);
  room.backToLobby();
  [...room.players.keys()].forEach((id) => room.removePlayer(id));
  await db.flush();
  const games = await q('select outcome from games where room_id = $1 order by started_at', [room.dbId]);
  assert.deepStrictEqual(games.map((x) => x.outcome), ['finished', 'stopped']);
  const [closed] = await q('select * from rooms where id = $1', [room.dbId]);
  assert.ok(closed.closed_at);
  assert.deepStrictEqual([closed.peak_players, closed.games, closed.chat_messages], [3, 2, 1]);
});

test('db: a database that can\'t be reached records nothing and never gets in the way', async () => {
  const off = new Database('postgres://nobody@127.0.0.1:1/none');
  const t = Date.now();
  assert.strictEqual(await off.start(), false);
  off.write('select 1');
  off.profileSeen(crypto.randomUUID(), 'x', 0);
  assert.ok(Date.now() - t < 12000);
  clearTimeout(off.retry);
  await off.pool.end();
  const none = new Database(null);
  assert.strictEqual(none.enabled, false);
  none.write('select 1');
  assert.strictEqual(none.queue.length, 0);
});

test('db: helpers: devices, and big strings trimmed out of results', () => {
  assert.deepStrictEqual(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0) Safari/604.1'), { device: 'tablet', browser: 'safari' });
  assert.deepStrictEqual(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile Safari/537.36'), { device: 'phone', browser: 'chrome' });
  const out = slim({ a: 'x'.repeat(5000), b: [{ c: 'data:image/png;base64,' + 'A'.repeat(9000) }], d: 3 });
  assert.ok(out.a.length < 100 && out.b[0].c.length < 100 && out.d === 3);
});
