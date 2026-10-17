// Ball & Chain: every team is roped to one big ball and drags it through an obstacle course into
// the goal. Teams race identical copies of the course side by side; the server runs the physics
// (shared with the browser in public/js/games/ballchain-core.js) at 30 Hz and sends snapshots at 15 Hz.
const B = require('../../public/js/games/ballchain-core');
const { fixedLoop } = require('./loop');

const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const SEND_EVERY = 2;
const SUBSTEPS = 2;
const COUNTDOWN_S = 5;
const FIRST_COUNTDOWN_S = 7; // the first course also shows how to play
const INTERMISSION_S = 8;
const FINISH_GRACE_S = 40; // after the first team finishes, the others get this long
const POINTS = [10, 7, 5, 3, 1];
const SABOTAGES = ['oil', 'gust', 'snarl', 'heavy'];
const SABOTAGE_FROM_CP = 2; // the dash off the start line doesn't count
const PHASES = { countdown: 0, run: 1, end: 2, done: 3 };
const BUMP_GAP_S = 0.3;
const AUTO_TEAMS = [
  { name: 'Red', color: '#ef4444' }, { name: 'Blue', color: '#3b82f6' }, { name: 'Green', color: '#22c55e' },
  { name: 'Yellow', color: '#eab308' }, { name: 'Purple', color: '#a855f7' },
];
// Rough par time per section (seconds) for the solo-team medals.
const PAR = {
  start: 6, goal: 8, slalom: 26, plates: 32, twin: 34, bridge: 26, tilt: 24, downhill: 26, conveyor: 24,
  fans: 28, sweeper: 24, hammers: 26, bumpers: 20, mudice: 28, ramp: 32,
};
const COURSE_OPTIONS = [1, 3, 5];
const LENGTH_OPTIONS = ['short', 'normal', 'long'];
const ROPE_OPTIONS = ['short', 'normal', 'long'];

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class BallChain {
  static minPlayers = 2;

  // Team mode uses the room's teams as they are, so check them before starting.
  static canStart(room) {
    const players = room.connectedPlayers;
    if (players.length < 2) return 'Ball & Chain needs at least 2 players';
    if (!room.settings.teamMode) return null;
    const bad = room.teamList()
      .map((t) => ({ t, n: players.filter((p) => p.team === t.id).length }))
      .filter(({ n }) => n > 0 && (n < 2 || n > 6));
    if (!bad.length) return null;
    return `Ball & Chain teams need 2–6 players: ${bad.map(({ t, n }) => `${t.name} has ${n}`).join(', ')}. Move players, or turn teams off to split automatically.`;
  }

  constructor(room) {
    this.room = room;
    const s = room.settings;
    this.courseCount = COURSE_OPTIONS.includes(s.bcCourses) ? s.bcCourses : 3;
    this.length = LENGTH_OPTIONS.includes(s.bcLength) ? s.bcLength : 'normal';
    this.ropeKind = ROPE_OPTIONS.includes(s.bcRope) ? s.bcRope : 'normal';
    this.sabotage = s.bcSabotage !== false;
    this.teams = [];
    this.players = []; // idx -> { id, name, color, avatar, team }
    this.byId = new Map(); // player id -> sim player
    this.phase = 'countdown';
    this.phaseT = 0;
    this.time = 0; // course time: drives every moving obstacle
    this.runStart = 0;
    this.courseIdx = -1;
    this.courseResults = [];
    this.tickCount = 0;
    this.interval = null;
    this.events = [];
  }

  // ---------- setup ----------
  formTeams() {
    const players = this.room.connectedPlayers;
    let groups;
    if (this.room.settings.teamMode) {
      groups = this.room.teamList()
        .map((t) => ({ name: t.name, color: t.color, members: players.filter((p) => p.team === t.id) }))
        .filter((g) => g.members.length);
    } else {
      const list = shuffle(players);
      const sizes = B.teamSizes(list.length);
      let k = 0;
      groups = sizes.map((n, i) => ({ ...AUTO_TEAMS[i], members: list.slice(k, (k += n)) }));
    }
    this.teams = groups.map((g, ti) => ({
      idx: ti, name: g.name, color: g.color, memberIds: g.members.map((p) => p.id),
      points: 0, totalTime: 0, places: [], sim: null, finish: null, progress: 0,
    }));
    this.players = [];
    this.teams.forEach((t, ti) => {
      for (const id of t.memberIds) {
        const p = this.room.players.get(id);
        this.players.push({ idx: this.players.length, id, name: p.name, color: p.color, avatar: p.avatar, team: ti });
      }
    });
    this.stats = new Map(this.players.map((p) => [p.id, { heaves: 0, syncs: 0, brace: 0, pulled: 0, falls: 0 }]));
  }

  start() {
    this.formTeams();
    const minTeam = Math.min(...this.teams.map((t) => t.memberIds.length));
    this.seed = Math.floor(Math.random() * 1e9);
    this.plan = B.planMatch(this.seed, this.courseCount, this.length, minTeam);
    this.beginCourse(0);
    this.interval = fixedLoop(TICK_HZ, () => this.tick());
  }

  stop() {
    this.interval?.stop?.();
    this.interval = null;
  }

  beginCourse(i) {
    this.courseIdx = i;
    this.def = this.plan[i];
    this.course = B.buildCourse(this.def);
    this.par = this.def.sections.reduce((s, sec) => s + (PAR[sec.type] || 25), 0);
    this.limit = Math.max(B.COURSE_TIME[this.length], Math.round(this.par * 1.9));
    this.time = 0;
    this.phase = 'countdown';
    this.phaseT = i === 0 ? FIRST_COUNTDOWN_S : COUNTDOWN_S;
    this.finishCount = 0;
    this.graceUntil = null;
    this.cpClaimed = new Set();
    this.byId.clear();
    for (const t of this.teams) {
      const members = this.players.filter((p) => p.team === t.idx);
      t.sim = B.makeTeam(this.course, members.map((m) => ({ id: m.id, idx: m.idx })), B.ROPES[this.ropeKind]);
      t.sim.id = t.idx;
      t.finish = null;
      t.progress = 0;
      for (const sp of t.sim.players) {
        this.byId.set(sp.id, sp);
        sp.stats = this.stats.get(sp.id);
        if (!this.room.players.get(sp.id)?.connected) this.setGone(sp, true);
      }
    }
    this.sentWraps = new Map();
    this.lastBump = new Map();
    this.room.emit('game:bc:init', this.initPayload());
  }

  // ---------- network payloads ----------
  initPayload() {
    return {
      courseIdx: this.courseIdx,
      courses: this.plan.length,
      course: this.def,
      rope: B.ROPES[this.ropeKind],
      phase: PHASES[this.phase],
      phaseT: this.phaseT,
      time: this.time,
      limit: this.limit,
      par: this.par,
      sabotage: this.sabotage,
      teams: this.teams.map((t) => ({
        idx: t.idx, name: t.name, color: t.color, points: t.points, time: t.totalTime, places: t.places,
        members: this.players.filter((p) => p.team === t.idx).map((p) => p.idx),
        finish: t.finish, mods: t.sim ? this.modsOf(t.sim) : null,
      })),
      players: this.players,
      wraps: this.teams.flatMap((t) => t.sim.players.map((p) => [p.idx, ...p.wraps])),
      results: this.courseResults,
    };
  }

  modsOf(sim) {
    const m = sim.mods;
    return { oil: m.oil, gust: m.gust, snarl: m.snarl > this.time ? m.snarl : 0, heavy: m.heavy > this.time ? m.heavy : 0 };
  }

  snapshotFor() {
    return { mode: 'ballchain', init: this.initPayload() };
  }

  stateMessage() {
    const r = (v) => Math.round(v);
    const balls = [];
    const players = [];
    const wraps = [];
    for (const t of this.teams) {
      const s = t.sim;
      const b = s.ball;
      const state = b.state === 'fall' ? 1 : b.state === 'frozen' ? 2 : b.air ? 3 : 0;
      const gates = s.gates.reduce((m, g, i) => m | (g.open ? 1 << i : 0), 0);
      const plates = (s.plates || []).reduce((m, on, i) => m | (on ? 1 << i : 0), 0);
      balls.push([t.idx, r(b.x), r(b.y), r(b.z), r(b.vx), r(b.vy), state, gates, s.cp, plates, Math.round(t.progress * 1000)]);
      for (const p of s.players) {
        let f = 0;
        if (p.braced && p.state === 'ok') f |= 1;
        if (p.heaveT > 0) f |= 2;
        if (p.state === 'fall') f |= 4;
        if (p.state === 'stun') f |= 8;
        if (p.yank > 0.25) f |= 16;
        if (p.state === 'gone') f |= 32;
        if (t.finish) f |= 64;
        if (b.state === 'frozen') f |= 128;
        if (p.helping) f |= 256;
        if (p.afk) f |= 512;
        players.push([p.idx, r(p.x), r(p.y), r(p.vx), r(p.vy), f, r((p.aim * 180) / Math.PI)]);
        if (this.sentWraps.get(p.idx) !== p.wrapVer) {
          this.sentWraps.set(p.idx, p.wrapVer);
          wraps.push([p.idx, ...p.wraps]);
        }
      }
    }
    const el = this.phase === 'run' || this.phase === 'end' ? this.time - this.runStart : 0;
    const msg = {
      t: Date.now(), tc: Math.round(this.time * 1000) / 1000, ph: PHASES[this.phase], pt: Math.round(this.phaseT * 10) / 10,
      el: Math.round(el * 10) / 10, tl: this.timeLeft(), b: balls, p: players,
    };
    if (wraps.length) msg.w = wraps;
    return msg;
  }

  timeLeft() {
    if (this.phase !== 'run') return null;
    const el = this.time - this.runStart;
    const end = this.graceUntil !== null ? Math.min(this.limit, this.graceUntil) : this.limit;
    return Math.max(0, Math.round((end - el) * 10) / 10);
  }

  fx(data) {
    this.room.emit('game:bc:fx', data);
  }

  // ---------- simulation ----------
  tick() {
    try {
      this.simulate(DT);
    } catch (err) {
      console.error('Ball & Chain tick failed:', err);
    }
  }

  simulate(dt) {
    this.tickCount++;
    this.time += dt;
    if (this.phase === 'countdown') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        this.phase = 'run';
        this.runStart = this.time;
        for (const t of this.teams) for (const sp of t.sim.players) sp.activeAt = this.time;
        this.fx({ type: 'go' });
      }
    } else if (this.phase === 'run') {
      this.runPhysics(dt);
      this.checkCourseEnd();
    } else if (this.phase === 'end') {
      // Teams can still wander about while the scores are up.
      this.runPhysics(dt, true);
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        if (this.courseIdx + 1 < this.plan.length) this.beginCourse(this.courseIdx + 1);
        else this.finish();
        return;
      }
    }
    if (this.tickCount % SEND_EVERY === 0 && this.phase !== 'done') this.room.emit('game:bc:state', this.stateMessage());
  }

  runPhysics(dt, idle = false) {
    const C = this.course;
    const sub = dt / SUBSTEPS;
    for (const t of this.teams) {
      const events = [];
      const s = t.sim;
      const t0 = this.time - dt;
      for (let i = 0; i < SUBSTEPS; i++) B.stepTeam(s, C, t0 + sub * (i + 1), sub, events);
      B.tickTeam(s, C, this.time, dt, events);
      if (t.finish) {
        // Parked in the goal: the ball stays put while the team celebrates.
        s.ball.vx *= 0.8; s.ball.vy *= 0.8;
      } else if (!idle) {
        this.checkProgress(t);
      }
      for (const e of events) {
        // A ball resting against a sweeper arm would report a bump every step: a few a second is plenty.
        if (e.type === 'bump') {
          const key = `${t.idx}:${e.kind}`;
          if (this.time - (this.lastBump.get(key) ?? -9) < BUMP_GAP_S) continue;
          this.lastBump.set(key, this.time);
        }
        this.fx(e);
      }
    }
  }

  checkProgress(t) {
    const C = this.course;
    const s = t.sim;
    const b = s.ball;
    if (b.state !== 'ok' || b.air) return;
    t.progress = Math.max(0, Math.min(1, b.y / C.goal.y));
    for (let k = C.checkpoints.length - 1; k > s.cp; k--) {
      if (b.y < C.checkpoints[k].y) continue;
      s.cp = k;
      this.fx({ type: 'checkpoint', team: t.idx, cp: k });
      if (!this.cpClaimed.has(k)) {
        this.cpClaimed.add(k);
        if (k >= SABOTAGE_FROM_CP) this.dropSabotage(t, k);
      }
      break;
    }
    const g = C.goal;
    if ((b.x - g.x) ** 2 + (b.y - g.y) ** 2 <= g.r * g.r) {
      t.finish = { time: Math.round((this.time - this.runStart) * 100) / 100, place: ++this.finishCount };
      t.progress = 1;
      this.fx({ type: 'finish', team: t.idx, place: t.finish.place, time: t.finish.time });
      if (this.graceUntil === null && this.liveTeams().length > 1) this.graceUntil = this.time - this.runStart + FINISH_GRACE_S;
    }
  }

  // First team to reach a checkpoint drops a random trap on every team behind it.
  dropSabotage(from, cp) {
    if (!this.sabotage) return;
    const victims = this.teams.filter((t) => t !== from && !t.finish && t.sim.cp < cp && this.isLive(t));
    if (!victims.length) return;
    const kind = SABOTAGES[Math.floor(Math.random() * SABOTAGES.length)];
    const now = this.time;
    for (const v of victims) {
      const m = v.sim.mods;
      const b = v.sim.ball;
      if (kind === 'oil') m.oil = { x0: b.x - 170, x1: b.x + 170, y0: b.y + 40, y1: b.y + 320, until: now + 12 };
      else if (kind === 'gust') m.gust = { ax: (b.x > 0 ? 1 : -1) * 520, from: now + 1.5, until: now + 4.5 };
      else if (kind === 'snarl') m.snarl = now + 10;
      else if (kind === 'heavy') m.heavy = now + 10;
    }
    this.fx({ type: 'sabotage', kind, from: from.idx, to: victims.map((v) => v.idx), mods: victims.map((v) => this.modsOf(v.sim)) });
  }

  isLive(t) {
    return t.sim.players.some((p) => p.state !== 'gone');
  }

  liveTeams() {
    return this.teams.filter((t) => this.isLive(t));
  }

  checkCourseEnd() {
    const el = this.time - this.runStart;
    const live = this.liveTeams();
    const allDone = live.length > 0 && live.every((t) => t.finish);
    const timeUp = el >= this.limit || (this.graceUntil !== null && el >= this.graceUntil);
    if (allDone || timeUp || !live.length) this.endCourse();
  }

  endCourse() {
    const single = this.teams.length === 1;
    const ranked = [...this.teams].sort((a, b) => {
      if (a.finish && b.finish) return a.finish.time - b.finish.time;
      if (a.finish || b.finish) return a.finish ? -1 : 1;
      return b.progress - a.progress;
    });
    const rows = ranked.map((t, rank) => {
      let points;
      let medal = null;
      if (single) {
        medal = !t.finish ? null : t.finish.time <= this.par ? 'gold' : t.finish.time <= this.par * 1.35 ? 'silver' : 'bronze';
        points = { gold: 10, silver: 7, bronze: 5 }[medal] || 0;
      } else {
        points = t.finish ? POINTS[rank] || 0 : Math.floor((POINTS[rank] || 0) / 2);
      }
      const time = t.finish ? t.finish.time : this.limit + 30;
      t.points += points;
      t.totalTime = Math.round((t.totalTime + time) * 100) / 100;
      t.places[this.courseIdx] = rank + 1;
      return { team: t.idx, place: rank + 1, time: t.finish ? t.finish.time : null, progress: Math.round(t.progress * 100), points, medal };
    });
    this.courseResults.push({ name: this.def.name, theme: this.def.theme, par: this.par, rows });
    this.phase = 'end';
    const last = this.courseIdx + 1 >= this.plan.length;
    this.phaseT = last ? 6 : INTERMISSION_S;
    this.fx({
      type: 'courseEnd', courseIdx: this.courseIdx, last, rows,
      standings: this.teams.map((t) => ({ idx: t.idx, points: t.points, time: t.totalTime, places: t.places })),
    });
  }

  finish() {
    this.stop();
    this.phase = 'done';
    const teams = this.teams
      .map((t) => ({
        id: t.idx, name: t.name, color: t.color, score: t.points, time: t.totalTime, places: t.places,
        finished: t.places.length ? this.courseResults.filter((c) => c.rows.some((r) => r.team === t.idx && r.time !== null)).length : 0,
        members: this.players.filter((p) => p.team === t.idx).map((p) => p.id),
      }))
      .sort((a, b) => b.score - a.score || a.time - b.time);
    teams.forEach((t, i) => { t.rank = i + 1; });
    const teamOf = new Map(this.teams.map((t) => [t.idx, t]));
    const players = this.players.map((p) => {
      const st = this.stats.get(p.id);
      const cur = this.room.players.get(p.id);
      return {
        id: p.id, name: cur?.name || p.name, color: p.color, avatar: cur?.avatar ?? p.avatar, team: p.team,
        teamColor: teamOf.get(p.team).color, score: teamOf.get(p.team).points,
        stats: { heaves: st.heaves, syncs: st.syncs, brace: Math.round(st.brace * 10) / 10, pulled: Math.round(st.pulled / 20), falls: st.falls },
      };
    }).sort((a, b) => b.score - a.score || (b.stats.pulled - a.stats.pulled));
    const award = (key, title, icon, unit, pick) => {
      const best = [...players].sort((a, b) => pick(b) - pick(a))[0];
      return best && pick(best) > 0 ? { key, title, icon, unit, id: best.id, value: pick(best) } : null;
    };
    const awards = [
      award('sync', 'Sync Master', '⚡', 'sync heaves', (p) => p.stats.syncs),
      award('anchor', 'Iron Anchor', '⚓', 's braced', (p) => p.stats.brace),
      award('pull', 'Workhorse', '💪', 'm pulled', (p) => p.stats.pulled),
      award('falls', 'Butterfingers', '🫠', 'falls', (p) => p.stats.falls),
    ].filter(Boolean);
    this.room.finishGame(this, {
      players, teams, awards, courses: this.courseResults, single: this.teams.length === 1,
    });
  }

  // ---------- players ----------
  setGone(sp, gone) {
    if (gone) {
      sp.state = 'gone'; sp.braced = false; sp.input = { x: 0, y: 0, brace: false };
      sp.wraps = []; sp.dirs = []; sp.wrapVer++;
      return;
    }
    if (sp.state !== 'gone') return;
    const team = this.teams.find((t) => t.sim.players.includes(sp));
    sp.state = 'ok';
    sp.activeAt = this.time;
    B.placeNearBall(team.sim, this.course, sp, team.sim.players.indexOf(sp), team.sim.players.length, this.time);
  }

  onPlayerDisconnect(player) {
    const sp = this.byId.get(player.id);
    if (sp && sp.state !== 'gone') { this.setGone(sp, true); this.fx({ type: 'gone', idx: sp.idx }); }
  }

  onPlayerLeave(player) {
    this.onPlayerDisconnect(player);
  }

  onPlayerReconnect(player) {
    const sp = this.byId.get(player.id);
    if (sp && sp.state === 'gone') { this.setGone(sp, false); this.fx({ type: 'back', idx: sp.idx }); }
  }

  onPlayerJoin(player) {
    // Late joiners watch this match and play in the next one.
    this.room.emitTo(player.id, 'game:bc:init', this.initPayload());
  }

  onEvent(player, event, data, reply) {
    if (event === 'ping') return reply({ ok: true });
    const sp = this.byId.get(player.id);
    if (event === 'input') {
      if (!sp || sp.state === 'gone') return reply({ ok: false });
      const input = B.cleanInput(data);
      if (!input) return reply({ ok: false });
      sp.input = input;
      if (input.brace || Math.hypot(input.x, input.y) > 0.2) sp.activeAt = this.time;
      return reply({ ok: true });
    }
    if (event === 'heave') {
      if (!sp || this.phase !== 'run') return reply({ ok: false });
      const team = this.teams.find((t) => t.sim.players.includes(sp));
      if (team.finish) return reply({ ok: false });
      sp.activeAt = this.time;
      const res = B.heave(team.sim, this.course, sp, this.time);
      if (!res) return reply({ ok: false });
      this.fx({ type: 'heave', idx: sp.idx, team: team.idx, k: res.k, need: res.need, launch: res.launch });
      return reply({ ok: true, k: res.k });
    }
    return reply({ ok: false });
  }
}

module.exports = { BallChain, POINTS, PAR };
