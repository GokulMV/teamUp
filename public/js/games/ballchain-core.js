// Ball & Chain: course layouts and the 2D rope/ball physics, shared by the server (authoritative
// simulation) and the browser (prediction for your own player + the geometry the 3D view is built from).
// Coordinates are lane-local: x across the lane (-280..280), y along the course. Every team races an
// identical copy of the course in its own lane, so teams never touch each other's physics.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BallChainCore = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const TAU = Math.PI * 2;

  const PHYS = {
    playerR: 14,
    ballR: 54,
    moveAcc: 1400, // player drive; with moveFric this gives ~233 u/s on foot
    moveFric: 6,
    ballFric: 2, // rolling resistance (1/s)
    ballMassPer: 1.6, // ball mass per active teammate, so every team size pulls at the same speed
    ropeK: 9, // gentle spring once the rope is past its rest length
    gravity: 950,
    heaveCd: 1.0,
    heaveWindow: 0.4, // heaves within this window stack into a sync
    heaveDv: 230, // ball speed kick per heave, shared out over the team
    syncStep: 0.6, // each extra synced heave is worth this much more
    heaveAnim: 0.35,
    heaveDash: 300,
    fallTime: 1.1,
    respawnFreeze: 1.2,
    playerFallTime: 1.0,
    stunTime: 0.6,
    stepDt: 1 / 60,
    // All hands: the ball digs in unless everyone is helping. Its mass is multiplied by this for
    // 0, 1, 2+ teammates not pulling their weight, so one slacker leaves the rest crawling.
    crewDig: [1, 14, 40],
    helpTaut: 0.95, // a rope this close to its rest length (or longer) is doing some pulling
    afkTime: 25, // seconds without input before a player stops counting toward the crew
  };

  const ROPES = {
    short: { rest: 125, max: 210 },
    normal: { rest: 160, max: 260 },
    long: { rest: 195, max: 315 },
  };
  const LENGTHS = { short: 4, normal: 6, long: 8 }; // obstacle sections per course
  const COURSE_TIME = { short: 150, normal: 210, long: 270 }; // seconds before a course times out
  const LANE_SPACING = 1150;
  const HALF = 280; // half the usual lane width

  // ---------- small helpers ----------
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, r) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const cross = (ax, ay, bx, by) => ax * by - ay * bx;

  // ---------- sections ----------
  // Each builder lays out one handcrafted obstacle in local coordinates (y from 0 to len) through
  // `b`, which offsets everything along the course and can mirror it left/right for variety.
  const SECTIONS = {
    start: {
      name: 'Start', icon: '🚩', len: 380,
      build(b) {
        b.floor(-300, 300, 0, 380, 'pad');
        b.wall(-316, -300, 0, 380, 'rail'); b.wall(300, 316, 0, 380, 'rail');
        b.wall(-316, 316, -16, 0, 'rail');
      },
    },
    slalom: {
      name: 'Pillar Slalom', icon: '🎳', len: 940, diff: 1, tags: ['wrap'],
      hint: 'Weave the ball through the big gaps. Ropes snag on pillars!',
      build(b, r) {
        b.floor(-HALF, HALF, 0, 940, 'pad');
        b.wall(-HALF - 16, -HALF, 0, 940, 'rail'); b.wall(HALF, HALF + 16, 0, 940, 'rail');
        // Fences of pillars: players slip between them, the ball only fits through the one big gap.
        const left = r() < 0.5;
        [170, 340, 510, 680, 850].forEach((y, i) => {
          const gap = (i % 2 === 0) === left ? -150 : 150;
          for (const x of [-250, -150, -50, 50, 150, 250]) if (x !== gap) b.post(x, y, 28, 'pillar');
        });
      },
    },
    plates: {
      name: 'Airlock Gate', icon: '🔐', len: 740, diff: 2, tags: ['coord'],
      hint: 'Stand on a glowing plate to hold the gate open (that counts as pulling).',
      build(b) {
        b.floor(-HALF, HALF, 0, 740, 'pad');
        b.wall(-HALF, -80, 370, 402, 'wall'); b.wall(80, HALF, 370, 402, 'wall');
        const g = b.gate(-80, 80, 370, 402, { all: false, hold: 0.5 });
        b.plate(-200, 250, 44, g);
        b.plate(200, 530, 44, g);
      },
    },
    twin: {
      name: 'Twin Keys', icon: '🗝️', len: 760, diff: 3, tags: ['coord'], minTeam: 3,
      hint: 'Both plates at once open the gate, and it stays open for a few seconds.',
      build(b) {
        b.floor(-HALF, HALF, 0, 760, 'pad');
        b.wall(-HALF, -80, 430, 462, 'wall'); b.wall(80, HALF, 430, 462, 'wall');
        const g = b.gate(-80, 80, 430, 462, { all: true, hold: 2.6 });
        b.plate(-205, 300, 44, g);
        b.plate(205, 300, 44, g);
      },
    },
    bridge: {
      name: 'Wobbly Bridges', icon: '🌉', len: 800, diff: 2, tags: ['precision'],
      hint: 'Line the ball up and pull straight. It falls if it rolls off the plank.',
      build(b, r) {
        b.floor(-HALF, HALF, 0, 180, 'pad');
        b.floor(-HALF, HALF, 620, 800, 'pad');
        const sway = r() < 0.6;
        b.floor(-215, -125, 180, 620, 'bridge', { sway: sway ? { amp: 36, period: 5, phase: 0 } : null });
        b.floor(125, 215, 180, 620, 'bridge', { sway: sway ? { amp: 36, period: 5, phase: Math.PI } : null });
      },
    },
    tilt: {
      name: 'Tilted Slide', icon: '📐', len: 780, diff: 2, tags: ['brace'],
      hint: 'The floor tips toward the drop. Brace on the high side!',
      build(b) {
        b.floor(-HALF, HALF, 0, 780, 'slope');
        b.wall(-HALF - 16, -HALF, 0, 780, 'rail');
        b.zone(-HALF, HALF, 70, 710, { type: 'slope', gx: 340 });
        for (const y of [220, 420, 620]) b.post(-170, y, 26, 'pillar');
      },
    },
    downhill: {
      name: 'Big Slide', icon: '🛝', len: 840, diff: 3, tags: ['brace'],
      hint: 'Downhill with holes. Brace to slow the ball and steer around them.',
      build(b) {
        // The slide floor is cut into strips around two holes.
        b.floor(-240, 240, 0, 260, 'slope');
        b.floor(-240, -190, 260, 380, 'slope'); b.floor(-30, 240, 260, 380, 'slope');
        b.floor(-240, 240, 380, 480, 'slope');
        b.floor(-240, 30, 480, 600, 'slope'); b.floor(190, 240, 480, 600, 'slope');
        b.floor(-240, 240, 600, 840, 'pad');
        b.wall(-256, -240, 0, 840, 'rail'); b.wall(240, 256, 0, 840, 'rail');
        b.zone(-240, 240, 60, 620, { type: 'slope', gy: 330 });
        b.hole(-190, -30, 260, 380); b.hole(30, 190, 480, 600);
      },
    },
    conveyor: {
      name: 'Conveyor Chaos', icon: '🔁', len: 820, diff: 2, tags: ['brace'],
      hint: 'Belts drag everything toward the edge. Pull upstream, brace if it slips.',
      build(b) {
        b.floor(-HALF, HALF, 0, 820, 'pad');
        b.zone(-HALF, HALF, 130, 290, { type: 'belt', vx: 170 });
        b.zone(-HALF, HALF, 370, 530, { type: 'belt', vx: -170 });
        b.zone(-HALF, HALF, 610, 720, { type: 'belt', vy: -150 });
        b.post(-215, 210, 24, 'pillar');
        b.post(215, 450, 24, 'pillar');
      },
    },
    fans: {
      name: 'Wind Tunnel', icon: '🌬️', len: 840, diff: 3, tags: ['brace'],
      hint: 'Giant fans blow in gusts. Brace when they spin up, run when they stop.',
      build(b) {
        b.floor(-HALF, HALF, 0, 840, 'pad');
        b.wall(-HALF - 16, -HALF, 0, 840, 'rail');
        const z1 = b.zone(-HALF, HALF, 150, 360, { type: 'wind', ax: 470, on: 2.4, off: 2.2, phase: 0 });
        const z2 = b.zone(-HALF, HALF, 470, 680, { type: 'wind', ax: 470, on: 2.4, off: 2.2, phase: 2.3 });
        b.fan(-HALF - 40, 255, z1); b.fan(-HALF - 40, 575, z2);
      },
    },
    sweeper: {
      name: 'Sweeper Spin', icon: '🌀', len: 920, diff: 3, tags: ['timing'],
      hint: 'A giant arm sweeps the disc. Time your crossing.',
      build(b, r) {
        b.floor(-160, 160, 0, 200, 'pad');
        b.disc(0, 460, 300, 'disc');
        b.floor(-160, 160, 720, 920, 'pad');
        b.sweeper(0, 460, { len: 292, w: 20, speed: r() < 0.5 ? 1 : -1, arms: 2, phase: r() * TAU });
      },
    },
    hammers: {
      name: 'Hammer Alley', icon: '🔨', len: 880, diff: 3, tags: ['timing'],
      hint: 'Padded hammers swing across a narrow path. Wait for the gap.',
      build(b) {
        b.floor(-200, 200, 0, 880, 'pad');
        [200, 440, 680].forEach((y, i) => b.hammer(0, y, { amp: 150, period: 3.2, phase: i * 2.1, r: 48 }));
      },
    },
    bumpers: {
      name: 'Bumper Garden', icon: '🔴', len: 780, diff: 1, tags: ['chaos'],
      hint: 'Bouncy bumpers fling the ball. The right side has no rail!',
      build(b) {
        b.floor(-HALF, HALF, 0, 780, 'pad');
        b.wall(-HALF - 16, -HALF, 0, 780, 'rail');
        b.wall(HALF, HALF + 16, 0, 300, 'rail'); b.wall(HALF, HALF + 16, 520, 780, 'rail');
        for (const [x, y] of [[-150, 190], [120, 240], [-40, 370], [190, 430], [-200, 480], [60, 580], [-110, 650]]) b.post(x, y, 40, 'bumper');
      },
    },
    mudice: {
      name: 'Mud & Ice', icon: '🧊', len: 840, diff: 2, tags: ['chaos'],
      hint: 'Ice slides, mud sticks. Heave together to get through the mud.',
      build(b) {
        b.floor(-HALF, HALF, 0, 840, 'pad');
        b.zone(-HALF, HALF, 140, 400, { type: 'ice' });
        b.zone(-200, 200, 480, 760, { type: 'mud' });
      },
    },
    ramp: {
      name: 'Sync Jump', icon: '🚀', len: 880, diff: 3, tags: ['coord'],
      hint: 'Cross the planks, then HEAVE together with the ball on the ramp to launch it.',
      build(b) {
        b.floor(-HALF, HALF, 0, 340, 'pad');
        b.floor(-HALF, HALF, 550, 880, 'pad');
        b.floor(-252, -216, 340, 550, 'plank', { ball: false });
        b.floor(216, 252, 340, 550, 'plank', { ball: false });
        b.wall(-HALF - 16, -HALF, 0, 340, 'rail'); b.wall(HALF, HALF + 16, 0, 340, 'rail');
        b.ramp(-120, 120, 220, 340);
      },
    },
    goal: {
      name: 'Finish', icon: '🏁', len: 460,
      build(b) {
        b.floor(-300, 300, 0, 460, 'goal');
        b.wall(-316, -300, 0, 460, 'rail'); b.wall(300, 316, 0, 460, 'rail');
        b.wall(-316, 316, 460, 476, 'rail');
        b.goal(0, 280, 115);
      },
    },
  };
  const OBSTACLES = Object.keys(SECTIONS).filter((k) => k !== 'start' && k !== 'goal');

  const THEMES = ['candy', 'mint', 'sunset'];
  const COURSE_NAMES = {
    candy: ['Candy Canyon', 'Bubblegum Skyway', 'Jellybean Jam'],
    mint: ['Minty Mayhem', 'Marshmallow Mile', 'Seafoam Slide'],
    sunset: ['Sorbet Summit', 'Lemon Drop Loop', 'Taffy Twister'],
  };

  // ---------- course planning ----------
  // A match is a list of course definitions ({ name, theme, sections: [{ type, seed, mirror }] }),
  // small enough to send to clients, which rebuild the geometry with buildCourse().
  function planMatch(seed, count, length, minTeam = 2) {
    const r = rng(seed);
    const n = LENGTHS[length] || LENGTHS.normal;
    const pool = OBSTACLES.filter((t) => !SECTIONS[t].minTeam || minTeam >= SECTIONS[t].minTeam);
    const coord = pool.filter((t) => SECTIONS[t].tags.includes('coord'));
    let deck = [];
    const themeStart = Math.floor(r() * THEMES.length);
    const names = Object.fromEntries(THEMES.map((th) => [th, shuffle(COURSE_NAMES[th], r)]));
    const courses = [];
    for (let c = 0; c < count; c++) {
      const picked = [];
      let guard = 0;
      while (picked.length < Math.min(n, pool.length) && guard++ < 200) {
        if (!deck.length) deck = shuffle(pool, r);
        const t = deck.pop();
        if (!picked.includes(t)) picked.push(t);
      }
      // Every course needs at least one section where the team has to split up and coordinate.
      if (!picked.some((t) => coord.includes(t))) {
        const options = coord.filter((t) => !picked.includes(t));
        picked[Math.floor(r() * picked.length)] = options[Math.floor(r() * options.length)];
      }
      // Easier sections first, with a little shuffle so courses don't all feel the same.
      const order = picked.map((t) => ({ t, k: SECTIONS[t].diff + r() * 1.6 })).sort((a, b) => a.k - b.k).map((o) => o.t);
      const theme = THEMES[(themeStart + c) % THEMES.length];
      courses.push({
        name: names[theme][Math.floor(c / THEMES.length) % names[theme].length],
        theme,
        sections: ['start', ...order, 'goal'].map((type) => ({ type, seed: Math.floor(r() * 1e9), mirror: r() < 0.5 })),
      });
    }
    return courses;
  }

  function buildCourse(def) {
    const C = {
      name: def.name, theme: def.theme, len: 0, width: 640,
      floors: [], zones: [], posts: [], walls: [], gates: [], plates: [], sweepers: [], hammers: [],
      fans: [], ramps: [], holes: [], checkpoints: [], sections: [], goal: null,
    };
    let y0 = 0;
    def.sections.forEach((sd, si) => {
      const S = SECTIONS[sd.type];
      if (!S) throw new Error(`Unknown section ${sd.type}`);
      const m = sd.mirror && sd.type !== 'start' && sd.type !== 'goal' ? -1 : 1;
      const X = (x) => x * m;
      const rx = (a, b) => (m === 1 ? [a, b] : [-b, -a]);
      const b = {
        floor(xa, xb, ya, yb, kind, opts = {}) {
          const [x0, x1] = rx(xa, xb);
          const f = { x0, x1, y0: y0 + ya, y1: y0 + yb, kind, ball: opts.ball !== false, sec: si };
          if (opts.sway) f.sway = { ...opts.sway, amp: opts.sway.amp * m };
          C.floors.push(f);
        },
        disc(x, y, rad, kind) { C.floors.push({ circle: true, cx: X(x), cy: y0 + y, r: rad, kind, ball: true, sec: si, x0: X(x) - rad, x1: X(x) + rad, y0: y0 + y - rad, y1: y0 + y + rad }); },
        wall(xa, xb, ya, yb, kind) { const [x0, x1] = rx(xa, xb); C.walls.push({ x0, x1, y0: y0 + ya, y1: y0 + yb, kind }); },
        hole(xa, xb, ya, yb) { const [x0, x1] = rx(xa, xb); C.holes.push({ x0, x1, y0: y0 + ya, y1: y0 + yb }); },
        post(x, y, rad, kind) { C.posts.push({ id: C.posts.length, x: X(x), y: y0 + y, r: rad, kind }); return C.posts.length - 1; },
        zone(xa, xb, ya, yb, z) {
          const [x0, x1] = rx(xa, xb);
          C.zones.push({ ...z, gx: (z.gx || 0) * m, ax: (z.ax || 0) * m, vx: (z.vx || 0) * m, gy: z.gy || 0, vy: z.vy || 0, x0, x1, y0: y0 + ya, y1: y0 + yb });
          return C.zones.length - 1;
        },
        gate(xa, xb, ya, yb, opts) { const [x0, x1] = rx(xa, xb); C.gates.push({ x0, x1, y0: y0 + ya, y1: y0 + yb, all: !!opts.all, hold: opts.hold, plates: [] }); return C.gates.length - 1; },
        plate(x, y, rad, gate) { C.plates.push({ x: X(x), y: y0 + y, r: rad, gate }); C.gates[gate].plates.push(C.plates.length - 1); },
        sweeper(x, y, o) {
          const post = b.post(x, y, 40, 'pivot');
          C.sweepers.push({ x: X(x), y: y0 + y, len: o.len, w: o.w, speed: o.speed * m, arms: o.arms, phase: o.phase, post });
        },
        hammer(x, y, o) { C.hammers.push({ x: X(x), y: y0 + y, amp: o.amp * m, period: o.period, phase: o.phase, r: o.r }); },
        fan(x, y, zone) { C.fans.push({ x: X(x), y: y0 + y, zone, dir: m }); },
        ramp(xa, xb, ya, yb) { const [x0, x1] = rx(xa, xb); C.ramps.push({ x0, x1, y0: y0 + ya, y1: y0 + yb }); },
        goal(x, y, rad) { C.goal = { x: X(x), y: y0 + y, r: rad }; },
      };
      S.build(b, rng(sd.seed || 1));
      C.sections.push({ type: sd.type, name: S.name, icon: S.icon, hint: S.hint || '', y0, y1: y0 + S.len, mirror: m === -1 });
      // A checkpoint at the start of every obstacle section: falls send the ball back here.
      if (sd.type !== 'goal') C.checkpoints.push({ y: y0, spawnX: 0, spawnY: y0 + (si === 0 ? 210 : 95), sec: si });
      y0 += S.len;
    });
    C.len = y0;
    return C;
  }

  // ---------- time-based obstacle state (same on server and client for a given course time) ----------
  const floorOffset = (f, t) => (f.sway ? f.sway.amp * Math.sin((TAU * t) / f.sway.period + f.sway.phase) : 0);
  const windOn = (z, t) => ((((t + z.phase) % (z.on + z.off)) + (z.on + z.off)) % (z.on + z.off)) < z.on;
  // Seconds until a fan zone switches on (0 while it is on).
  function windIn(z, t) {
    const p = (((t + z.phase) % (z.on + z.off)) + (z.on + z.off)) % (z.on + z.off);
    return p < z.on ? 0 : z.on + z.off - p;
  }
  const armAngle = (s, t, k) => s.phase + s.speed * t + (k * TAU) / s.arms;
  function hammerPos(h, t) {
    const w = TAU / h.period;
    return { x: h.x + h.amp * Math.sin(w * t + h.phase), y: h.y, vx: h.amp * w * Math.cos(w * t + h.phase) };
  }

  function floorAt(C, x, y, t, isBall) {
    for (const f of C.floors) {
      if (y < f.y0 - 1 || y > f.y1 + 1) continue;
      if (isBall && !f.ball) continue;
      const ox = floorOffset(f, t);
      if (f.circle) {
        if ((x - f.cx - ox) ** 2 + (y - f.cy) ** 2 <= f.r * f.r) return f;
      } else if (x >= f.x0 + ox && x <= f.x1 + ox && y >= f.y0 && y <= f.y1) {
        return f;
      }
    }
    return null;
  }

  // Surface effects under a point: ice, mud, belts, slopes, wind (and sabotage oil/gusts).
  function surfaceAt(C, x, y, t, mods) {
    const s = { acc: 1, fric: 1, bfric: 1, sx: 0, sy: 0, gx: 0, gy: 0, wx: 0, wy: 0, ice: false, mud: false };
    for (const z of C.zones) {
      if (x < z.x0 || x > z.x1 || y < z.y0 || y > z.y1) continue;
      if (z.type === 'ice') { s.acc = 0.4; s.fric = 0.3; s.bfric = 0.22; s.ice = true; }
      else if (z.type === 'mud') { s.acc = 0.55; s.bfric = 3.4; s.mud = true; }
      else if (z.type === 'belt') { s.sx += z.vx; s.sy += z.vy; }
      else if (z.type === 'slope') { s.gx += z.gx; s.gy += z.gy; }
      else if (z.type === 'wind' && windOn(z, t)) { s.wx += z.ax; }
    }
    if (mods) {
      const o = mods.oil;
      if (o && x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1) { s.acc = 0.4; s.fric = 0.3; s.bfric = 0.22; s.ice = true; }
      const g = mods.gust;
      if (g && t >= g.from && t < g.until) s.wx += g.ax;
    }
    return s;
  }

  // ---------- teams ----------
  function makeTeam(C, members, rope) {
    const team = {
      ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, air: false, state: 'ok', t: 0, spin: 0 },
      players: members.map((m) => ({
        id: m.id, idx: m.idx, x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0,
        input: { x: 0, y: 0, brace: false }, state: 'ok', t: 0, braced: false,
        heaveT: 0, heaveCd: 0, wraps: [], dirs: [], wrapVer: 0, yank: 0, aim: Math.PI / 2,
        stats: { heaves: 0, syncs: 0, brace: 0, pulled: 0, falls: 0 },
      })),
      rope: { ...rope },
      cp: 0,
      gates: C.gates.map(() => ({ open: false, t: 0 })),
      mods: { oil: null, gust: null, snarl: 0, heavy: 0 },
      sync: { t0: -9, ids: [] },
      falls: 0,
    };
    spawnTeam(team, C, 0);
    return team;
  }

  const activePlayers = (team) => team.players.filter((p) => p.state !== 'gone');
  // The ball's weight for the team on the course (more players, heavier ball, so every team size
  // pulls at the same speed), then how deep it has dug in because someone isn't helping.
  function baseMass(team, t) {
    const n = Math.max(1, activePlayers(team).length);
    return PHYS.ballMassPer * n * (team.mods.heavy > t ? 1.8 : 1);
  }
  const ballMass = (team, t) => baseMass(team, t) * (team.crew ? team.crew.dig : 1);

  // ---------- all hands ----------
  // A player is helping when they pull on a taut rope (any pull away from the ball counts, so
  // steering from the side does too), have just heaved, brace against a taut rope, or hold a
  // pressure plate. Stunned or falling players aren't helping; offline and AFK ones don't count.
  function onAnyPlate(C, p) {
    return C.plates.some((pl) => (p.x - pl.x) ** 2 + (p.y - pl.y) ** 2 <= (pl.r + PHYS.playerR * 0.4) ** 2);
  }
  function isHelping(team, C, p, rope) {
    if (p.state !== 'ok') return false;
    if (p.heaveCd > PHYS.heaveCd - 0.8) return true;
    if (onAnyPlate(C, p)) return true;
    const pts = ropePoints(C, p, team.ball);
    if (pathLen(pts) < rope.rest * PHYS.helpTaut) return false;
    if (p.braced) return true;
    const m = Math.hypot(p.input.x, p.input.y);
    if (m < 0.3) return false;
    const [ax, ay] = dirTo(pts[pts.length - 2], pts[pts.length - 1]); // from the rope's anchor to the player
    return (p.input.x * ax + p.input.y * ay) / m > 0.1;
  }
  function crewCheck(team, C, t) {
    const rope = ropeFor(team, t);
    let n = 0;
    let h = 0;
    for (const p of team.players) {
      if (p.state === 'gone' || p.afk) { p.helping = false; continue; }
      n++;
      p.helping = isHelping(team, C, p, rope);
      if (p.helping) h++;
    }
    const missing = n - h;
    team.crew = { n, h, missing, dig: PHYS.crewDig[Math.min(PHYS.crewDig.length - 1, missing)] };
    return team.crew;
  }
  function ropeFor(team, t) {
    if (team.mods.snarl > t) return { rest: team.rope.rest * 0.62, max: team.rope.max * 0.7 };
    return team.rope;
  }

  // Ball on the checkpoint, the team fanned out behind it.
  function spawnTeam(team, C, cpIndex) {
    const cp = C.checkpoints[Math.max(0, Math.min(C.checkpoints.length - 1, cpIndex))];
    Object.assign(team.ball, { x: cp.spawnX, y: cp.spawnY, z: 0, vx: 0, vy: 0, vz: 0, air: false });
    const list = team.players;
    list.forEach((p, i) => placeNearBall(team, C, p, i, list.length, 0));
  }

  function placeNearBall(team, C, p, i, n, t) {
    const b = team.ball;
    const spread = n > 1 ? i / (n - 1) - 0.5 : 0;
    const a = -Math.PI / 2 + spread * 2.2; // behind the ball (toward -y)
    const d = PHYS.ballR + 70;
    let x = b.x + Math.cos(a) * d;
    let y = b.y + Math.sin(a) * d;
    if (!floorAt(C, x, y, t, false)) { x = b.x + (spread || 0.3) * 120; y = b.y; }
    if (!floorAt(C, x, y, t, false)) { x = b.x; y = b.y - PHYS.ballR - 20; }
    Object.assign(p, { x, y, px: x, py: y, vx: 0, vy: 0, wraps: [], dirs: [], wrapVer: p.wrapVer + 1, yank: 0 });
  }

  // ---------- ropes ----------
  // A rope runs ball -> wrap posts... -> player. Wraps are post ids; dirs remember which way it bent.
  function ropePoints(C, p, ball) {
    const pts = [{ x: ball.x, y: ball.y }];
    for (const id of p.wraps) pts.push(C.posts[id]);
    pts.push({ x: p.x, y: p.y });
    return pts;
  }
  function pathLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
  }
  // Signed distance of point C from the line P->N (positive = left).
  function sideOf(P, N, Cx, Cy) {
    const dx = N.x - P.x;
    const dy = N.y - P.y;
    const L = Math.hypot(dx, dy) || 1;
    return cross(dx, dy, Cx - P.x, Cy - P.y) / L;
  }

  // Classic 2D rope wrapping: when a rope segment sweeps onto a post, the post becomes a bend in
  // the rope; when the rope swings back past it, the bend is released.
  function updateWraps(C, p, ball) {
    let changed = false;
    // Release bends the rope has swung back off (checked from both ends inward).
    for (let guard = 0; guard < 8 && p.wraps.length; guard++) {
      let removed = false;
      const last = p.wraps.length - 1;
      const W = C.posts[p.wraps[last]];
      const P = last > 0 ? C.posts[p.wraps[last - 1]] : ball;
      if (sideOf(P, p, W.x, W.y) * p.dirs[last] < -(W.r + 3)) { p.wraps.pop(); p.dirs.pop(); removed = true; }
      if (p.wraps.length) {
        const W0 = C.posts[p.wraps[0]];
        const N = p.wraps.length > 1 ? C.posts[p.wraps[1]] : p;
        if (sideOf(ball, N, W0.x, W0.y) * p.dirs[0] < -(W0.r + 3)) { p.wraps.shift(); p.dirs.shift(); removed = true; }
      }
      if (!removed) break;
      changed = true;
    }
    // New bends on the two moving segments: anchor -> player and ball -> first point.
    const check = (A, B, atEnd) => {
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const L2 = dx * dx + dy * dy;
      if (L2 < 1) return false;
      const skipA = atEnd ? p.wraps[p.wraps.length - 1] : -1;
      const skipB = atEnd ? -1 : p.wraps[0];
      let best = null;
      let bestT = 2;
      const minX = Math.min(A.x, B.x) - 60;
      const maxX = Math.max(A.x, B.x) + 60;
      const minY = Math.min(A.y, B.y) - 60;
      const maxY = Math.max(A.y, B.y) + 60;
      for (const post of C.posts) {
        if (post.x < minX || post.x > maxX || post.y < minY || post.y > maxY) continue;
        if (post.id === skipA || post.id === skipB) continue;
        const tt = ((post.x - A.x) * dx + (post.y - A.y) * dy) / L2;
        if (tt <= 0.02 || tt >= 0.98) continue;
        const sd = cross(dx, dy, post.x - A.x, post.y - A.y) / Math.sqrt(L2);
        if (Math.abs(sd) > post.r) continue;
        // Order along the rope from the ball's side.
        const key = atEnd ? tt : -tt;
        if (key < bestT) { bestT = key; best = { post, dir: sd >= 0 ? -1 : 1 }; }
      }
      if (!best) return false;
      if (atEnd) { p.wraps.push(best.post.id); p.dirs.push(best.dir); }
      else { p.wraps.unshift(best.post.id); p.dirs.unshift(best.dir); }
      return true;
    };
    for (let guard = 0; guard < 4; guard++) {
      const anchor = p.wraps.length ? C.posts[p.wraps[p.wraps.length - 1]] : ball;
      let added = check(anchor, p, true);
      if (p.wraps.length) added = check(ball, C.posts[p.wraps[0]], false) || added;
      if (!added) break;
      changed = true;
    }
    if (p.wraps.length > 12) { p.wraps.length = 12; p.dirs.length = 12; }
    if (changed) p.wrapVer++;
    return changed;
  }

  // Unit direction from `a` toward `b`.
  function dirTo(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  }

  // ---------- collisions ----------
  function pushOutCircle(e, r, cx, cy, cr, bounce) {
    const dx = e.x - cx;
    const dy = e.y - cy;
    const min = r + cr;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return null;
    const d = Math.sqrt(d2) || 0.001;
    const nx = d2 ? dx / d : 1;
    const ny = d2 ? dy / d : 0;
    e.x = cx + nx * min;
    e.y = cy + ny * min;
    const vn = e.vx * nx + e.vy * ny;
    if (vn < 0) { e.vx -= (1 + bounce) * vn * nx; e.vy -= (1 + bounce) * vn * ny; }
    return { nx, ny, vn };
  }
  function pushOutRect(e, r, w, bounce) {
    const qx = clamp(e.x, w.x0, w.x1);
    const qy = clamp(e.y, w.y0, w.y1);
    let dx = e.x - qx;
    let dy = e.y - qy;
    let d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return null;
    let nx;
    let ny;
    if (d2 < 1e-6) {
      // Centre inside the box: leave by the nearest face.
      const opts = [[e.x - w.x0, -1, 0], [w.x1 - e.x, 1, 0], [e.y - w.y0, 0, -1], [w.y1 - e.y, 0, 1]].sort((a, b) => a[0] - b[0]);
      [, nx, ny] = opts[0];
      e.x = nx ? (nx < 0 ? w.x0 - r : w.x1 + r) : e.x;
      e.y = ny ? (ny < 0 ? w.y0 - r : w.y1 + r) : e.y;
    } else {
      const d = Math.sqrt(d2);
      nx = dx / d; ny = dy / d;
      e.x = qx + nx * r;
      e.y = qy + ny * r;
    }
    const vn = e.vx * nx + e.vy * ny;
    if (vn < 0) { e.vx -= (1 + bounce) * vn * nx; e.vy -= (1 + bounce) * vn * ny; }
    return { nx, ny, vn };
  }

  // Static scenery: posts, bumpers, rails, walls and closed gates. Returns the hardest hit.
  function collideStatic(C, e, r, gatesOpen, isBall) {
    let hit = null;
    for (const post of C.posts) {
      if (Math.abs(post.y - e.y) > post.r + r + 2 || Math.abs(post.x - e.x) > post.r + r + 2) continue;
      if (post.kind === 'bumper') {
        const h = pushOutCircle(e, r, post.x, post.y, post.r, 0.9);
        if (h) {
          const kick = isBall ? 260 : 380;
          e.vx += h.nx * kick; e.vy += h.ny * kick;
          hit = { kind: 'bumper', x: post.x + h.nx * post.r, y: post.y + h.ny * post.r, power: 1 };
        }
      } else {
        const h = pushOutCircle(e, r, post.x, post.y, post.r, isBall ? 0.55 : 0.15);
        if (h && h.vn < -60 && (!hit || hit.kind !== 'bumper')) hit = { kind: 'post', x: post.x, y: post.y, power: Math.min(1, -h.vn / 300) };
      }
    }
    for (const w of C.walls) {
      if (e.y < w.y0 - r || e.y > w.y1 + r || e.x < w.x0 - r || e.x > w.x1 + r) continue;
      pushOutRect(e, r, w, isBall ? 0.35 : 0.1);
    }
    C.gates.forEach((g, i) => {
      if (gatesOpen && gatesOpen[i]) return;
      if (e.y < g.y0 - r || e.y > g.y1 + r || e.x < g.x0 - r || e.x > g.x1 + r) return;
      pushOutRect(e, r, g, isBall ? 0.3 : 0.1);
    });
    return hit;
  }

  // Moving obstacles: sweeper arms and swinging hammers.
  function collideDynamic(C, e, r, t, isBall) {
    let hit = null;
    for (const s of C.sweepers) {
      if (Math.abs(s.y - e.y) > s.len + r + s.w || Math.abs(s.x - e.x) > s.len + r + s.w) continue;
      for (let k = 0; k < s.arms; k++) {
        const a = armAngle(s, t, k);
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const along = clamp((e.x - s.x) * ux + (e.y - s.y) * uy, 30, s.len);
        const qx = s.x + ux * along;
        const qy = s.y + uy * along;
        const h = pushOutCircle(e, r, qx, qy, s.w, 0);
        if (!h) continue;
        // Arm surface velocity at the contact point.
        const avx = -s.speed * (qy - s.y);
        const avy = s.speed * (qx - s.x);
        const an = avx * h.nx + avy * h.ny;
        const vn = e.vx * h.nx + e.vy * h.ny;
        const push = isBall ? 1.25 : 1.6;
        if (vn < an * push) { e.vx += h.nx * (an * push - vn); e.vy += h.ny * (an * push - vn); }
        if (!isBall) { e.vx += h.nx * 200; e.vy += h.ny * 200; }
        hit = { kind: 'sweep', x: qx, y: qy, power: 1 };
      }
    }
    for (const hm of C.hammers) {
      if (Math.abs(hm.y - e.y) > hm.r + r + 4) continue;
      const hp = hammerPos(hm, t);
      const h = pushOutCircle(e, r, hp.x, hp.y, hm.r, 0.3);
      if (!h) continue;
      const kick = isBall ? 1.15 : 1.5;
      e.vx += hp.vx * kick + h.nx * (isBall ? 150 : 320);
      e.vy += h.ny * (isBall ? 150 : 320);
      hit = { kind: 'hammer', x: hp.x + h.nx * hm.r, y: hp.y + h.ny * hm.r, power: Math.min(1, Math.abs(hp.vx) / 300 + 0.3) };
    }
    return hit;
  }

  // ---------- player & ball forces ----------
  const NO_INPUT = { x: 0, y: 0, brace: false };

  function drivePlayer(p, input, s, dt) {
    if (p.braced) { p.vx = 0; p.vy = 0; return; }
    const ax = input.x * PHYS.moveAcc * s.acc;
    const ay = input.y * PHYS.moveAcc * s.acc;
    const f = PHYS.moveFric * s.fric;
    p.vx += (ax - f * (p.vx - s.sx) + s.gx * 0.3 + s.wx * 0.55) * dt;
    p.vy += (ay - f * (p.vy - s.sy) + s.gy * 0.3 + s.wy * 0.55) * dt;
  }
  function driveBall(b, s, dt) {
    const f = PHYS.ballFric * s.bfric;
    b.vx += (-f * (b.vx - s.sx) + s.gx + s.wx) * dt;
    b.vy += (-f * (b.vy - s.sy) + s.gy + s.wy) * dt;
  }

  // Spring tension past the rest length; slack never pushes. Returns the rope length.
  function tension(C, p, ball, rope, invMb, dt, moveBall) {
    const pts = ropePoints(C, p, ball);
    const L = pathLen(pts);
    const stretch = L - rope.rest;
    if (stretch <= 0) return L;
    const T = PHYS.ropeK * stretch;
    if (!p.braced) {
      const [dx, dy] = dirTo(pts[pts.length - 1], pts[pts.length - 2]);
      p.vx += dx * T * dt;
      p.vy += dy * T * dt;
    }
    if (moveBall) {
      const [bx, by] = dirTo(pts[0], pts[1]);
      ball.vx += bx * T * invMb * dt;
      ball.vy += by * T * invMb * dt;
    }
    return L;
  }

  // Hard rope limit: pull the two ends together, shared by inverse mass (a braced player is an anchor).
  function limitRope(C, p, ball, rope, invMp, invMb) {
    const pts = ropePoints(C, p, ball);
    const L = pathLen(pts);
    const excess = L - rope.max;
    if (excess <= 0) return 0;
    const sum = invMp + invMb;
    if (sum <= 0) return 0;
    const [px, py] = dirTo(pts[pts.length - 1], pts[pts.length - 2]);
    const [bx, by] = dirTo(pts[0], pts[1]);
    const wp = invMp / sum;
    const wb = invMb / sum;
    p.x += px * excess * wp; p.y += py * excess * wp;
    ball.x += bx * excess * wb; ball.y += by * excess * wb;
    // Inelastic: no speed away from each other along the rope.
    const vp = -(p.vx * px + p.vy * py); // player moving away from its anchor
    const vb = -(ball.vx * bx + ball.vy * by);
    const sep = vp + vb;
    let yank = 0;
    if (sep > 0) {
      if (invMp) { p.vx += px * sep * wp; p.vy += py * sep * wp; yank = sep * wp; }
      if (invMb) { ball.vx += bx * sep * wb; ball.vy += by * sep * wb; }
    }
    return yank;
  }

  // One physics step for a whole team. `events` collects things the server announces.
  function stepTeam(team, C, t, dt, events) {
    const b = team.ball;
    const rope = ropeFor(team, t);
    crewCheck(team, C, t);
    const mB = ballMass(team, t);
    const invMb = 1 / mB;
    const ballLive = b.state === 'ok';
    const live = (p) => p.state === 'ok' || p.state === 'stun';
    const roped = (p) => ballLive && live(p);
    b.px = b.x; b.py = b.y;

    for (const p of team.players) {
      p.px = p.x; p.py = p.y;
      if (!live(p)) continue;
      const s = surfaceAt(C, p.x, p.y, t, team.mods);
      if (p.state === 'ok' && p.braced) { p.vx = 0; p.vy = 0; continue; }
      drivePlayer(p, p.state === 'ok' && b.state !== 'frozen' ? p.input : NO_INPUT, s, dt);
    }
    if (ballLive) {
      if (b.air) b.vz -= PHYS.gravity * dt;
      else driveBall(b, surfaceAt(C, b.x, b.y, t, team.mods), dt);
    } else if (b.state === 'fall') {
      b.vz -= PHYS.gravity * dt;
      b.vx *= 1 - dt * 1.5; b.vy *= 1 - dt * 1.5;
    }
    for (const p of team.players) if (roped(p)) p.len = tension(C, p, b, rope, invMb, dt, true);

    // Integrate and ride swaying bridges.
    const carry = (e, isBall) => {
      const f = floorAt(C, e.x, e.y, t, isBall);
      if (f && f.sway) e.x += floorOffset(f, t + dt) - floorOffset(f, t);
    };
    for (const p of team.players) {
      if (!live(p) || p.braced) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      carry(p, false);
    }
    if (ballLive || b.state === 'fall') {
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (ballLive && b.air && b.z <= 0 && b.vz < 0) {
        b.z = 0; b.vz = 0; b.air = false;
        events.push({ type: 'land', team: team.id, x: b.x, y: b.y });
      }
      if (ballLive && !b.air) carry(b, true);
      b.spin += Math.hypot(b.x - b.px, b.y - b.py) / PHYS.ballR;
    }

    // Collisions.
    const gatesOpen = team.gates.map((g) => g.open);
    for (const p of team.players) {
      if (!live(p)) continue;
      collideStatic(C, p, PHYS.playerR, gatesOpen, false);
      const hit = collideDynamic(C, p, PHYS.playerR, t, false);
      if (hit) {
        if (p.state !== 'stun') events.push({ type: 'hit', idx: p.idx, kind: hit.kind, x: hit.x, y: hit.y });
        p.state = 'stun'; p.t = PHYS.stunTime; p.braced = false;
      }
    }
    if (ballLive && b.z < 30) {
      const h1 = collideStatic(C, b, PHYS.ballR, gatesOpen, true);
      const h2 = collideDynamic(C, b, PHYS.ballR, t, true);
      const h = h2 || h1;
      if (h && (h.kind !== 'post' || h.power > 0.3)) events.push({ type: 'bump', team: team.id, kind: h.kind, x: h.x, y: h.y, power: h.power });
    }
    if (ballLive) {
      for (const p of team.players) {
        if (!live(p)) continue;
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        const min = PHYS.ballR + PHYS.playerR;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || b.z > 40) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d;
        const ny = dy / d;
        const invMp = p.braced ? 0.05 : 1;
        const sum = invMp + invMb;
        const over = min - d;
        p.x += nx * over * (invMp / sum); p.y += ny * over * (invMp / sum);
        b.x -= nx * over * (invMb / sum); b.y -= ny * over * (invMb / sum);
        const rel = (p.vx - b.vx) * nx + (p.vy - b.vy) * ny;
        if (rel < 0) {
          const j = -1.1 * rel / sum;
          p.vx += nx * j * invMp; p.vy += ny * j * invMp;
          b.vx -= nx * j * invMb; b.vy -= ny * j * invMb;
        }
      }
    }
    const ps = team.players;
    for (let i = 0; i < ps.length; i++) {
      if (!live(ps[i])) continue;
      for (let j = i + 1; j < ps.length; j++) {
        if (!live(ps[j])) continue;
        const dx = ps[j].x - ps[i].x;
        const dy = ps[j].y - ps[i].y;
        const d2 = dx * dx + dy * dy;
        const min = PHYS.playerR * 2;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const over = (min - d) / 2;
        const wi = ps[i].braced ? 0 : 1;
        const wj = ps[j].braced ? 0 : 1;
        const sw = wi + wj || 1;
        ps[i].x -= (dx / d) * over * 2 * (wi / sw); ps[i].y -= (dy / d) * over * 2 * (wi / sw);
        ps[j].x += (dx / d) * over * 2 * (wj / sw); ps[j].y += (dy / d) * over * 2 * (wj / sw);
      }
    }

    // Ropes: wrap around posts, then enforce the hard limit.
    for (const p of team.players) {
      if (roped(p)) updateWraps(C, p, b);
      p.yank = Math.max(0, p.yank - dt * 4);
    }
    for (let it = 0; it < 3; it++) {
      for (const p of team.players) {
        if (!roped(p)) continue;
        const invMp = p.state === 'ok' && p.braced ? 0 : 1;
        const y = limitRope(C, p, b, rope, invMp, invMb);
        if (y > 90) p.yank = Math.max(p.yank, Math.min(1, y / 300));
      }
    }
    // Credit for pulling: ball travel along taut ropes.
    if (ballLive) {
      const mvx = b.x - b.px;
      const mvy = b.y - b.py;
      for (const p of team.players) {
        if (!roped(p) || !(p.len > rope.rest)) continue;
        const pts = ropePoints(C, p, b);
        const [dx, dy] = dirTo(pts[0], pts[1]);
        const along = mvx * dx + mvy * dy;
        if (along > 0) p.stats.pulled += along;
      }
    }

    // Falling off.
    if (ballLive && !b.air && !floorAt(C, b.x, b.y, t, true)) {
      b.state = 'fall'; b.t = PHYS.fallTime; b.vz = -60; b.air = false;
      team.falls++;
      events.push({ type: 'fall', team: team.id, ball: true, x: b.x, y: b.y });
      for (const p of team.players) { p.wraps = []; p.dirs = []; p.wrapVer++; }
    }
    for (const p of team.players) {
      if (!live(p)) continue;
      if (!floorAt(C, p.x, p.y, t, false)) {
        p.state = 'fall'; p.t = PHYS.playerFallTime; p.braced = false;
        p.stats.falls++;
        p.wraps = []; p.dirs = []; p.wrapVer++;
        events.push({ type: 'fall', team: team.id, idx: p.idx, x: p.x, y: p.y });
      }
    }
  }

  // Timers that run once per server tick: stuns, falls, respawns, gates, sabotage expiry.
  function tickTeam(team, C, t, dt, events) {
    const b = team.ball;
    if (b.state === 'fall') {
      b.t -= dt;
      if (b.t <= 0) {
        spawnTeam(team, C, team.cp);
        b.state = 'frozen'; b.t = PHYS.respawnFreeze;
        for (const p of team.players) if (p.state !== 'gone') { p.state = 'ok'; p.braced = false; }
        events.push({ type: 'respawn', team: team.id, x: b.x, y: b.y });
      }
    } else if (b.state === 'frozen') {
      b.t -= dt;
      if (b.t <= 0) b.state = 'ok';
    }
    const n = team.players.length;
    team.players.forEach((p, i) => {
      p.heaveCd = Math.max(0, p.heaveCd - dt);
      p.heaveT = Math.max(0, p.heaveT - dt);
      if (p.state === 'stun' || p.state === 'fall') {
        p.t -= dt;
        if (p.t <= 0) {
          if (p.state === 'fall') {
            placeNearBall(team, C, p, i, n, t);
            events.push({ type: 'pop', idx: p.idx, x: p.x, y: p.y });
          }
          p.state = 'ok';
        }
      }
      if (p.state === 'ok') {
        p.braced = !!p.input.brace;
        if (p.braced) p.stats.brace += dt;
        if (Math.hypot(p.input.x, p.input.y) > 0.2) p.aim = Math.atan2(p.input.y, p.input.x);
      }
      // Nobody can hold a whole team hostage: after a while without any input a player stops
      // counting toward the crew (the server stamps activeAt whenever they move or heave).
      const afk = p.state !== 'gone' && p.activeAt !== undefined && t - p.activeAt > PHYS.afkTime;
      if (afk !== !!p.afk) {
        p.afk = afk;
        events.push({ type: 'afk', team: team.id, idx: p.idx, on: afk });
      }
    });
    updateGates(team, C, dt);
    const m = team.mods;
    if (m.oil && m.oil.until <= t) m.oil = null;
    if (m.gust && m.gust.until <= t) m.gust = null;
  }

  function updateGates(team, C, dt) {
    const onPlate = C.plates.map((pl) => team.players.some((p) => p.state === 'ok'
      && (p.x - pl.x) ** 2 + (p.y - pl.y) ** 2 <= (pl.r + PHYS.playerR * 0.4) ** 2));
    team.plates = onPlate;
    C.gates.forEach((g, i) => {
      const st = team.gates[i];
      const pressed = g.all ? g.plates.every((k) => onPlate[k]) : g.plates.some((k) => onPlate[k]);
      if (pressed) { st.open = true; st.t = g.hold; return; }
      if (!st.open) return;
      st.t -= dt;
      if (st.t > 0) return;
      // Like a lift door: never close on the ball or a player.
      const inside = (e, r) => e.x > g.x0 - r && e.x < g.x1 + r && e.y > g.y0 - r && e.y < g.y1 + r;
      const blocked = (team.ball.state === 'ok' && inside(team.ball, PHYS.ballR - 4))
        || team.players.some((p) => p.state !== 'gone' && p.state !== 'fall' && inside(p, PHYS.playerR - 2));
      if (!blocked) st.open = false;
    });
  }

  function inRamp(C, x, y) {
    return C.ramps.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  }

  // HEAVE: a strong tug along the rope. Heaves from teammates within the sync window stack, and a
  // big enough sync with the ball on a ramp launches it. Returns null if the heave wasn't allowed.
  function heave(team, C, p, t) {
    const b = team.ball;
    if (p.state !== 'ok' || p.heaveCd > 0 || b.state === 'frozen') return null;
    p.heaveCd = PHYS.heaveCd;
    p.heaveT = PHYS.heaveAnim;
    p.stats.heaves++;
    const act = activePlayers(team);
    const n = Math.max(1, act.length);
    const sync = team.sync;
    if (t - sync.t0 > PHYS.heaveWindow || sync.ids.includes(p.id)) { sync.t0 = t; sync.ids = []; sync.launched = false; }
    sync.ids.push(p.id);
    const k = sync.ids.length;
    if (k === 2) for (const id of sync.ids) { const q = team.players.find((pp) => pp.id === id); if (q) q.stats.syncs++; }
    else if (k > 2) p.stats.syncs++;
    const mult = 1 + PHYS.syncStep * (k - 1);
    const out = { k, launch: false, need: Math.max(1, Math.min(n, n >= 4 ? 3 : 2)) };
    if (b.state !== 'ok') return out;
    const crew = crewCheck(team, C, t); // the heave itself counts as helping
    const rope = ropeFor(team, t);
    const pts = ropePoints(C, p, b);
    const L = pathLen(pts);
    const taut = clamp((L - rope.rest * 0.6) / (rope.rest * 0.4), 0, 1);
    if (taut > 0.05) {
      const [bx, by] = dirTo(pts[0], pts[1]);
      const dv = (PHYS.heaveDv * mult * taut) / n / crew.dig;
      b.vx += bx * dv; b.vy += by * dv;
      if (!p.braced) {
        const [px, py] = dirTo(pts[pts.length - 2], pts[pts.length - 1]);
        p.vx += px * 110; p.vy += py * 110;
      }
    } else if (!p.braced) {
      // Slack rope: the heave becomes a quick dash to take up the slack.
      const mx = Math.hypot(p.input.x, p.input.y) > 0.2 ? p.input.x : Math.cos(p.aim);
      const my = Math.hypot(p.input.x, p.input.y) > 0.2 ? p.input.y : Math.sin(p.aim);
      const m = Math.hypot(mx, my) || 1;
      p.vx += (mx / m) * PHYS.heaveDash; p.vy += (my / m) * PHYS.heaveDash;
    }
    if (k >= out.need && crew.missing === 0 && !sync.launched && !b.air && b.vy > 40 && inRamp(C, b.x, b.y)) {
      const extra = k - out.need;
      b.air = true;
      b.vz = 430 + 55 * extra;
      b.vy = Math.max(b.vy, 270 + 45 * extra);
      b.vx *= 0.4;
      sync.launched = true;
      out.launch = true;
    }
    return out;
  }

  // Validate a client input message into { x, y, brace } (unit-length move vector).
  function cleanInput(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    let x = Number(data.x);
    let y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0; y = 0; }
    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { x, y, brace: data.brace === true };
  }

  // Team sizes for an automatic split: one team for 2-3 players, otherwise 2-5 balanced teams of 2-6.
  function teamSizes(n) {
    if (n < 2) return n ? [n] : [];
    let k = n <= 3 ? 1 : Math.max(2, Math.round(n / 4));
    k = Math.max(k, Math.ceil(n / 6));
    k = Math.min(k, 5, Math.floor(n / 2));
    const sizes = Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
    return sizes;
  }

  return {
    PHYS, ROPES, LENGTHS, COURSE_TIME, LANE_SPACING, SECTIONS, OBSTACLES, THEMES,
    rng, shuffle, planMatch, buildCourse,
    floorOffset, windOn, windIn, armAngle, hammerPos, floorAt, surfaceAt,
    makeTeam, spawnTeam, placeNearBall, activePlayers, baseMass, ballMass, ropeFor, crewCheck, isHelping,
    ropePoints, pathLen, updateWraps, collideStatic, collideDynamic, drivePlayer, driveBall, tension, limitRope,
    stepTeam, tickTeam, updateGates, inRamp, heave, cleanInput, teamSizes,
  };
});
