// Before a weekly arena goes live, CPU drivers play it for a while. A layout they can't get round
// (too few item boxes picked up, too many of them driving into the water by themselves, too long
// stuck) is thrown out and the generator's next one tried. Their dice are loaded with the arena's
// id, so the same layout always gets the same verdict, whenever and wherever it is played (but the
// layout itself is what's played: a changed def under the same id gets its own test).
const K = require('../../public/js/shared/kart-core');
const { KartBattle } = require('./kart');
const Bots = require('./kart-bots');

const SECS = 40;
const BOTS = 6;
// Per CPU driver per minute (The Keep: about 11 boxes, a stall well under 10% of the time).
const MIN_BOXES = 4.5;
const MAX_DROWNED = 0.5;
const MAX_STALLED = 0.12;

// def: the layout; map: it made already (or it is made here).
function playtest(def, map = K.Layers.makeLayeredArena(def)) {
  const real = Math.random;
  Math.random = K.Weekly.random(K.Weekly.hash(`playtest:${def.id}`)).next;
  try {
    const events = [];
    const room = {
      settings: { kartMode: 'arena', kartMap: def.id, arenaTime: 600, kartItems: 'all', kartBots: BOTS, kartBotSkill: 'normal' },
      players: new Map(), connectedPlayers: [], emit: (e, d) => events.push([e, d]), emitTo() {}, teamList: () => [], systemMessage() {},
      buildResults: () => ({ players: [] }), finishGame() {},
    };
    const game = new KartBattle(room, { map });
    Bots.makeBots(BOTS, { skill: 'normal' }).forEach((b, i) => game.addKart(b, i));
    game.phase = 'racing';
    game.raceStart = 0;
    let boxes = 0;
    let stalled = 0;
    for (let i = 0; i < SECS * 30; i++) {
      game.time += 1 / 30;
      const before = game.boxes.filter((b) => b > 0).length;
      game.simulate(1 / 30);
      boxes += Math.max(0, game.boxes.filter((b) => b > 0).length - before);
      for (const k of game.karts.values()) if (k.dead <= 0 && !(k.air > 0) && Math.abs(k.speed) < 30) stalled += 1 / 30;
    }
    const drowned = events.filter(([e, d]) => e === 'game:kart:hit' && d.kill && d.by < 0).length;
    const minutes = (BOTS * SECS) / 60;
    const stats = { boxes: boxes / minutes, drowned: drowned / minutes, stalled: stalled / (BOTS * SECS) };
    const why = [];
    if (game.botError) why.push('a CPU driver crashed');
    if (stats.boxes < MIN_BOXES) why.push(`CPU drivers picked up ${stats.boxes.toFixed(1)} boxes a minute`);
    if (stats.drowned > MAX_DROWNED) why.push(`CPU drivers fell in ${stats.drowned.toFixed(1)} times a minute`);
    if (stats.stalled > MAX_STALLED) why.push(`CPU drivers were stuck ${Math.round(stats.stalled * 100)}% of the time`);
    return { ok: !why.length, why, stats };
  } finally {
    Math.random = real;
  }
}

module.exports = { playtest };
