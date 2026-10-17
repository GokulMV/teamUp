/* global BallChainCore */
window.Games = window.Games || {};

// Ball & Chain client: HUD, input (keyboard, touch joystick), networking, prediction for your own
// player and interpolation for everyone else. The 3D view (js/games/ballchain3d.js) loads on demand.
(function () {
  const SNAP_MS = 1000 / 15; // the server sends a snapshot every other 30 Hz tick
  const PH = { countdown: 0, run: 1, end: 2 };
  const SABOTAGE = {
    oil: ['🛢️', 'Oil slick!', 'The floor ahead is slippery'],
    gust: ['🌪️', 'Gust incoming!', 'Brace! Wind is about to hit'],
    snarl: ['🪢', 'Rope snarl!', 'Ropes knotted short for 10 s'],
    heavy: ['🏋️', 'Heavy ball!', 'Your ball weighs a ton for 10 s'],
  };
  const PLACES = ['1st', '2nd', '3rd', '4th', '5th'];
  const MOBILE = matchMedia('(pointer: coarse)').matches;

  let rendererModule = null;
  const loadRenderer = () => (rendererModule ||= import('/js/games/ballchain3d.js'));
  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }
  const fmt = (s) => {
    const t = Math.max(0, Math.ceil(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  // Writes only when the text changes: the HUD runs every frame, and each write costs a layout.
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const fmtTime = (s) => (s === null || s === undefined ? 'DNF' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);

  window.Games.ballchain = {
    mount(el, api) {
      const B = window.BallChainCore;
      const Sfx = window.Sfx;
      const esc = api.escapeHtml;
      const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" class="tc-ic" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
      el.innerHTML = `
        <div class="game-wrap">
          <div class="stage bc-stage" data-stage>
            <div class="bc-hud">
              <div class="bc-topleft">
                <div class="bc-course"><small data-course-no></small><b data-course-name></b></div>
                <div class="bc-section" data-section><i data-sec-icon></i><span data-sec-name></span></div>
              </div>
              <div class="bc-timer" data-timer><small>TIME</small><b data-timer-val>0:00</b></div>
              <div class="bc-race" data-race></div>
              <div class="bc-callout" data-callout></div>
              <div class="bc-banner" data-banner><i data-banner-icon></i><div><b data-banner-title></b><small data-banner-text></small></div></div>
              <div class="bc-alerts" data-alerts></div>
              <div class="bc-roster" data-roster></div>
              <div class="bc-sync" data-sync><div class="bc-pips" data-pips></div><span data-sync-label>SYNC</span></div>
              <div class="bc-crew" data-crew></div>
              <div class="bc-keys" data-keys><span><kbd>WASD</kbd>move</span><span><kbd>Space</kbd>heave</span><span><kbd>Shift</kbd>brace (hold)</span></div>
              <div class="bc-spectate hidden" data-spectate>👀 Spectating · you’ll join the next match</div>
            </div>
            <div class="bc-touch" data-touch>
              <div class="bc-stick" data-stick></div>
              <div class="bc-buttons">
                <button class="bc-btn brace" data-brace aria-label="Brace"><span>⚓</span><small>BRACE</small></button>
                <button class="bc-btn heave" data-heave aria-label="Heave"><svg viewBox="0 0 100 100" class="bc-cd"><circle cx="50" cy="50" r="46" data-cd/></svg><span>💪</span><small>HEAVE</small></button>
              </div>
            </div>
            <div class="bc-tools">
              <button class="kart-tool" data-fullscreen title="Full screen" aria-label="Full screen">${svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>
              <button class="kart-tool tool-chat" data-chat title="Chat" aria-label="Chat">${svg('<path d="M4 5h16v11H9l-5 4z"/>')}</button>
              <button class="kart-tool tool-menu" data-menu title="Menu" aria-label="Menu">${svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', 'stroke-width="3"')}</button>
            </div>
            <div class="bc-overlay hidden" data-intro></div>
            <div class="bc-overlay hidden" data-board></div>
            <div class="bc-loading" data-loading><i></i>Building the course…</div>
          </div>
        </div>`;
      const q = (s) => el.querySelector(s);
      const stage = q('[data-stage]');
      stage.classList.toggle('touch', MOBILE);

      let info = null;
      let courseKey = '';
      let C = null;
      let players = [];
      let byIdx = new Map();
      let myIdx = -1;
      let myTeam = null;
      let view3d = null;
      let raf = 0;
      let lastFrame = performance.now();
      const snaps = [];
      let latest = null;
      let latestAt = 0;
      let clockOffset = null; // localNow - serverT for the fastest snapshot of the last few seconds
      // Everyone else is drawn a little in the past, so there is always a newer snapshot to glide
      // toward. How far back adapts to the connection (the spread of arrival times over the last
      // few seconds: Wi-Fi and phones bunch packets up), and the drawn time runs up to 10% fast or
      // slow to get there rather than jumping. Past the newest snapshot things carry on at their
      // velocity for a moment instead of freezing.
      const clock = { hist: [], delay: 120, drawT: null, at: 0 };
      let rtt = 80;
      let local = null;
      // Rope wraps (post ids per player): what the server last said, and what gets drawn (the same,
      // except my own rope, which follows my predicted player).
      const srvWraps = new Map();
      const wraps = new Map();
      const mods = new Map();
      const input = { x: 0, y: 0, brace: false };
      const keys = new Set();
      let stick = { x: 0, y: 0 };
      let lastHeave = -9;
      const sync = { team: null, ids: new Set(), at: 0, k: 0 };
      const prev = { phase: null, section: -1, count: null, cp: 0, ballState: 0, courseIdx: -1, tl: null };
      let snapCam = true;
      const frameTimes = [];
      window.__bcStats = { frameTimes };

      // ---------- renderer ----------
      function setupRenderer() {
        if (!info || !C || !window.BallChain3D) return;
        try {
          const t0 = performance.now();
          if (!view3d) view3d = new window.BallChain3D(stage);
          view3d.setMatch({ C, theme: info.course.theme, teams: info.teams, players, myIdx, rope: info.rope });
          window.__bcStats.setupMs = performance.now() - t0;
          window.__bcStats.view3d = view3d;
          snapCam = true;
          q('[data-loading]').classList.remove('hidden');
        } catch (err) {
          console.error(err);
          window.reportError?.(err);
          q('[data-loading]').innerHTML = '<b>3D graphics are turned off</b><span>Ball & Chain needs WebGL. Try Chrome, Edge, Firefox or Safari with hardware acceleration on.</span>';
        }
      }
      loadRenderer().then(() => setupRenderer()).catch((err) => {
        console.error(err);
        q('[data-loading]').textContent = 'Could not load the 3D view. Refresh to try again.';
      });
      Sfx.bcPreload?.();

      // ---------- input ----------
      const KEYS = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
      let sentAt = 0;
      let sentKey = '';
      let pendingSend = 0;
      function computeInput() {
        let x = stick.x;
        let y = stick.y;
        for (const k of keys) { const d = KEYS[k]; if (d) { x += d[0]; y += d[1]; } }
        const m = Math.hypot(x, y);
        if (m > 1) { x /= m; y /= m; }
        input.x = Math.round(x * 100) / 100;
        input.y = Math.round(y * 100) / 100;
      }
      function sendInput(force) {
        computeInput();
        const key = `${input.x},${input.y},${input.brace}`;
        const now = performance.now();
        if (!force && key === sentKey) return;
        if (!force && now - sentAt < 45) {
          if (!pendingSend) pendingSend = setTimeout(() => { pendingSend = 0; sendInput(false); }, 50);
          return;
        }
        sentKey = key;
        sentAt = now;
        api.socket.emit('game:input', { x: input.x, y: input.y, brace: input.brace });
      }
      function heave() {
        if (myIdx < 0 || !latest || latest.ph !== PH.run) return;
        const now = performance.now() / 1000;
        if (now - lastHeave < 1.05) return; // the server's cooldown is 1 s, counted in 1/30 s ticks
        lastHeave = now;
        q('[data-heave]').classList.add('fired');
        setTimeout(() => q('[data-heave]')?.classList.remove('fired'), 180);
        api.emit('game:heave').then((res) => { if (!res.ok) lastHeave = -9; });
      }
      const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      function onKey(e, down) {
        // Typing in the chat starts no moves, but a key let go still counts (or W stays held).
        if (typing(e) && down) return;
        if (e.code === 'Space') {
          e.preventDefault();
          if (down && !e.repeat) heave();
          return;
        }
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
          e.preventDefault();
          if (input.brace !== down) { input.brace = down; sendInput(true); }
          return;
        }
        if (!KEYS[e.code]) return;
        e.preventDefault();
        if (down) keys.add(e.code); else keys.delete(e.code);
        sendInput(false);
      }
      const kd = (e) => onKey(e, true);
      const ku = (e) => onKey(e, false);
      const blur = () => { keys.clear(); stick = { x: 0, y: 0 }; input.brace = false; sendInput(true); };
      window.addEventListener('keydown', kd);
      window.addEventListener('keyup', ku);
      window.addEventListener('blur', blur);
      const keepAlive = setInterval(() => sendInput(true), 1000);
      const pinger = setInterval(() => {
        const t0 = performance.now();
        api.emit('game:ping').then(() => { rtt = rtt * 0.7 + (performance.now() - t0) * 0.3; });
      }, 2000);

      // Touch: nipplejs joystick on the left, HEAVE and BRACE buttons on the right.
      let joystick = null;
      if (MOBILE) {
        loadScript('/vendor/nipplejs/index.js').then(() => {
          if (!el.isConnected || !window.nipplejs) return;
          joystick = window.nipplejs.create({
            zone: q('[data-stick]'), mode: 'dynamic', size: 120, threshold: 0.05, fadeTime: 120,
            color: { front: 'radial-gradient(circle at 35% 30%, #ffffff, #ffd1e8)', back: 'rgba(255,255,255,0.22)' },
          });
          joystick.on('move', (evt) => {
            // nipplejs passes { type, target, data }; data.vector is the stick offset (y up), up to 1.
            const v = evt?.data?.vector || { x: 0, y: 0 };
            const m = Math.hypot(v.x, v.y);
            const k = m > 1 ? 1 / m : 1;
            stick = { x: v.x * k, y: v.y * k };
            sendInput(false);
          });
          joystick.on('end', () => { stick = { x: 0, y: 0 }; sendInput(true); });
        }).catch(() => {});
      }
      const braceBtn = q('[data-brace]');
      const setBrace = (v) => (e) => { e.preventDefault(); braceBtn.classList.toggle('on', v); if (input.brace !== v) { input.brace = v; sendInput(true); } };
      braceBtn.addEventListener('pointerdown', setBrace(true));
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) braceBtn.addEventListener(ev, setBrace(false));
      q('[data-heave]').addEventListener('pointerdown', (e) => { e.preventDefault(); heave(); });
      // Stage tools: full screen everywhere; chat and menu when the top bar is hidden (landscape phones).
      q('[data-fullscreen]').onclick = (e) => {
        e.currentTarget.blur(); // Space is HEAVE: it must not toggle full screen again
        if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
        Promise.resolve(document.documentElement.requestFullscreen?.()).catch(() => {});
      };
      if (!document.fullscreenEnabled) q('[data-fullscreen]').classList.add('hidden'); // e.g. iPhone Safari
      q('[data-chat]').onclick = () => api.toggleChat?.();
      q('[data-menu]').onclick = (e) => api.openMenu?.(e.currentTarget);

      // ---------- network ----------
      function onInit(data) {
        const key = `${data.courseIdx}:${JSON.stringify(data.course)}`;
        const newCourse = key !== courseKey;
        courseKey = key;
        info = data;
        players = data.players;
        byIdx = new Map(players.map((p) => [p.idx, p]));
        const mine = players.find((p) => p.id === api.myId());
        myIdx = mine ? mine.idx : -1;
        myTeam = mine ? mine.team : null;
        srvWraps.clear();
        wraps.clear();
        for (const [idx, ...ids] of data.wraps || []) { srvWraps.set(idx, ids); wraps.set(idx, ids); }
        mods.clear();
        data.teams.forEach((t) => { if (t.mods) mods.set(t.idx, t.mods); });
        if (newCourse) {
          C = B.buildCourse(data.course);
          snaps.length = 0;
          latest = null;
          local = null;
          prev.section = -1;
          prev.cp = 0;
          setupRenderer();
        }
        q('[data-course-no]').textContent = `Course ${data.courseIdx + 1} of ${data.courses}`;
        q('[data-course-name]').textContent = data.course.name;
        q('[data-spectate]').classList.toggle('hidden', myIdx >= 0);
        stage.classList.toggle('spectating', myIdx < 0);
        renderRoster(true);
        renderIntro();
        if (data.phase !== PH.end) q('[data-board]').classList.add('hidden');
      }

      function onState(s) {
        const now = performance.now();
        const hist = clock.hist;
        hist.push([now, now - s.t]);
        while (now - hist[0][0] > 3000) hist.shift();
        let fastest = Infinity;
        for (const h of hist) fastest = Math.min(fastest, h[1]);
        clockOffset = fastest;
        const late = hist.map((h) => h[1] - fastest).sort((a, b) => a - b);
        const want = Math.max(100, Math.min(320, SNAP_MS + late[Math.floor((late.length - 1) * 0.9)] + 25));
        clock.delay += (want - clock.delay) * (want > clock.delay ? 0.5 : 0.03);
        snaps.push({ t: s.t, s });
        while (snaps.length > 30) snaps.shift();
        latest = s;
        latestAt = now;
        if (s.w) for (const [idx, ...ids] of s.w) { srvWraps.set(idx, ids); wraps.set(idx, ids); }
        reconcile(s, now);
      }

      const myBall = (s = latest) => s?.b.find((r) => r[0] === myTeam);
      function reconcile(s, now) {
        if (myIdx < 0) return;
        const row = s.p.find((r) => r[0] === myIdx);
        if (!row) return;
        const [, x, y, vx, vy, flags] = row;
        const special = flags & (4 | 8 | 32 | 128) || s.ph !== PH.run;
        // My rope bends round the posts the server says it does. Guessing wraps locally drifted:
        // a bend guessed differently stuck, and with it a different rope length and position.
        const serverWraps = srvWraps.get(myIdx) || [];
        if (!local || special) {
          local = { x, y, px: x, py: y, vx, vy, wraps: serverWraps.slice(), dirs: [], wrapVer: 0, braced: !!(flags & 1), input, offSince: 0 };
          return;
        }
        local.wraps = serverWraps.slice();
        const lead = Math.min(0.2, rtt / 2000);
        const sx = x + vx * lead;
        const sy = y + vy * lead;
        const ex = sx - local.x;
        const ey = sy - local.y;
        const err = Math.hypot(ex, ey);
        // Small errors melt away; a big one, or a medium one that won't go away, snaps back to the
        // server so everyone sees you where you really are.
        local.offSince = err > 30 ? local.offSince || now : 0;
        if (err > 100 || (local.offSince && now - local.offSince > 300)) {
          Object.assign(local, { x: sx, y: sy, vx, vy, offSince: 0 });
        } else {
          local.x += ex * 0.25; local.y += ey * 0.25;
          local.vx += (vx - local.vx) * 0.25; local.vy += (vy - local.vy) * 0.25;
        }
      }
      // Predict my own player with the shared physics so moving feels instant.
      function predict(dt) {
        if (!local || !latest || latest.ph !== PH.run || myIdx < 0) return;
        const row = latest.p.find((r) => r[0] === myIdx);
        const ball = myBall();
        if (!row || !ball || row[5] & (4 | 8 | 32 | 128) || ball[6] === 1 || ball[6] === 2) return;
        const age = Math.min(0.25, (performance.now() - latestAt) / 1000);
        const tc = latest.tc + age;
        const b = { x: ball[1] + ball[4] * age, y: ball[2] + ball[5] * age, z: ball[3] };
        const gatesOpen = C.gates.map((_, i) => !!(ball[7] & (1 << i)));
        const teamMods = mods.get(myTeam);
        const rope = teamMods && teamMods.snarl > tc ? { rest: info.rope.rest * 0.62, max: info.rope.max * 0.7 } : info.rope;
        const h = 1 / 60;
        local.acc = (local.acc || 0) + dt;
        let steps = 0;
        while (local.acc >= h && steps < 6) {
          local.acc -= h;
          steps++;
          const s = B.surfaceAt(C, local.x, local.y, tc, teamMods);
          local.braced = input.brace;
          B.drivePlayer(local, input, s, h);
          B.tension(C, local, b, rope, 0, h, false);
          if (!local.braced) {
            local.x += local.vx * h;
            local.y += local.vy * h;
            const f = B.floorAt(C, local.x, local.y, tc, false);
            if (f && f.sway) local.x += B.floorOffset(f, tc + h) - B.floorOffset(f, tc);
          }
          B.collideStatic(C, local, B.PHYS.playerR, gatesOpen, false);
          const dx = local.x - b.x;
          const dy = local.y - b.y;
          const d = Math.hypot(dx, dy);
          const min = B.PHYS.ballR + B.PHYS.playerR;
          if (d < min && d > 0.01 && b.z < 40) { local.x = b.x + (dx / d) * min; local.y = b.y + (dy / d) * min; }
          B.limitRope(C, local, b, rope, local.braced ? 0 : 1, 0);
        }
        if (local.acc > h) local.acc = 0;
      }

      // Everything else, drawn INTERP_DELAY behind the server.
      function interpolated() {
        if (!snaps.length || clockOffset === null) return null;
        const now = performance.now();
        const goal = now - clockOffset - clock.delay;
        if (clock.drawT === null || Math.abs(goal - clock.drawT) > 400) clock.drawT = goal;
        else clock.drawT += (now - clock.at) * Math.max(0.9, Math.min(1.1, 1 + (goal - clock.drawT) / 600));
        clock.at = now;
        const target = clock.drawT;
        let a = snaps[0];
        let b = snaps[snaps.length - 1];
        for (let i = 0; i < snaps.length - 1; i++) {
          if (snaps[i].t <= target && snaps[i + 1].t >= target) { a = snaps[i]; b = snaps[i + 1]; break; }
        }
        if (target >= b.t) a = b;
        const span = b.t - a.t;
        const f = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
        // A late packet: carry on at the last velocity for up to 0.15 s (still players, falls and
        // respawns excepted) rather than stopping dead until the next one turns up.
        const ahead = target > b.t ? Math.min(target - b.t, 150) / 1000 : 0;
        const pa = new Map(a.s.p.map((r) => [r[0], r]));
        const playersV = b.s.p.map((r) => {
          const p = pa.get(r[0]) || r;
          const jump = Math.hypot(r[1] - p[1], r[2] - p[2]) > 150;
          const k = jump ? 1 : f;
          const meta = byIdx.get(r[0]);
          const coast = ahead && !(r[5] & (4 | 8 | 32 | 128)) ? ahead : 0;
          return { idx: r[0], team: meta ? meta.team : 0, x: p[1] + (r[1] - p[1]) * k + r[3] * coast, y: p[2] + (r[2] - p[2]) * k + r[4] * coast, vx: r[3], vy: r[4], flags: r[5] };
        });
        const ba = new Map(a.s.b.map((r) => [r[0], r]));
        const balls = b.s.b.map((r) => {
          const p = ba.get(r[0]) || r;
          const jump = Math.hypot(r[1] - p[1], r[2] - p[2]) > 200;
          const k = jump ? 1 : f;
          const coast = ahead && (r[6] === 0 || r[6] === 3) ? ahead : 0; // rolling or flying, not falling or frozen
          return { team: r[0], x: p[1] + (r[1] - p[1]) * k + r[4] * coast, y: p[2] + (r[2] - p[2]) * k + r[5] * coast, z: p[3] + (r[3] - p[3]) * k, vx: r[4], vy: r[5], state: r[6], gates: r[7], cp: r[8], plates: r[9], progress: r[10] };
        });
        return { t: a.s.tc + (b.s.tc - a.s.tc) * f, players: playersV, balls };
      }

      // ---------- HUD ----------
      function callout(text, cls = '') {
        const c = q('[data-callout]');
        c.innerHTML = `<span class="${cls}">${text}</span>`;
        c.classList.remove('show');
        void c.offsetWidth;
        c.classList.add('show');
      }
      let bannerTimer = 0;
      function banner(icon, title, text, cls = '', ms = 3200) {
        const b = q('[data-banner]');
        q('[data-banner-icon]').textContent = icon;
        q('[data-banner-title]').textContent = title;
        q('[data-banner-text]').textContent = text;
        b.className = `bc-banner show ${cls}`;
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
      }
      const teamName = (i) => info?.teams[i]?.name || '?';
      const teamColor = (i) => info?.teams[i]?.color || '#fff';

      function renderIntro() {
        const box = q('[data-intro]');
        if (!info || info.phase !== PH.countdown) { box.classList.add('hidden'); return; }
        const mine = myTeam !== null ? info.teams[myTeam] : null;
        const mates = mine ? mine.members.map((i) => byIdx.get(i)).filter(Boolean) : [];
        const secs = info.course.sections.slice(1, -1).map((s) => B.SECTIONS[s.type]);
        box.innerHTML = `<div class="bc-intro">
          <span class="bc-kicker">Course ${info.courseIdx + 1} of ${info.courses}</span>
          <h2>${esc(info.course.name)}</h2>
          <div class="bc-chips">${secs.map((s, i) => `<span style="--d:${i * 0.06}s"><i>${s.icon}</i>${esc(s.name)}</span>`).join('')}</div>
          ${mine ? `<div class="bc-myteam" style="--team:${mine.color}"><b>${esc(mine.name)} team</b>${mates.map((p) => `<span>${api.avatarHtml(p.avatar)}${esc(p.name)}</span>`).join('')}</div>` : ''}
          ${info.courseIdx === 0 ? `<div class="bc-howto">
            <div><i>🕹️</i><b>Move</b><small>${MOBILE ? 'Left thumb stick' : 'WASD / arrows'}</small></div>
            <div><i>💪</i><b>Heave</b><small>${MOBILE ? 'HEAVE button' : 'Space'} · sync with your team for a big pull</small></div>
            <div><i>⚓</i><b>Brace</b><small>${MOBILE ? 'Hold BRACE' : 'Hold Shift'} · become an anchor</small></div>
            <div><i>⛓️</i><b>All hands</b><small>The ball digs in unless <em>everyone</em> pulls</small></div>
          </div>` : ''}
          <div class="bc-count" data-count></div>
        </div>`;
        box.classList.remove('hidden');
      }

      function renderBoard(e) {
        const box = q('[data-board]');
        const single = info.teams.length === 1;
        const rows = e.rows.map((r) => {
          const t = info.teams[r.team];
          const medal = r.medal ? { gold: '🥇', silver: '🥈', bronze: '🥉' }[r.medal] : '';
          return `<div class="bc-row${r.team === myTeam ? ' me' : ''}" style="--team:${t.color}">
            <span class="pl">${single ? medal || '—' : PLACES[r.place - 1]}</span><b>${esc(t.name)}</b>
            <span class="tm">${r.time !== null ? fmtTime(r.time) : `DNF · ${r.progress}%`}</span><span class="pts">+${r.points}</span></div>`;
        }).join('');
        const standings = [...e.standings].sort((a, b) => b.points - a.points || a.time - b.time).map((s, i) => {
          const t = info.teams[s.idx];
          return `<span class="${s.idx === myTeam ? 'me' : ''}" style="--team:${t.color}"><i>${i + 1}</i>${esc(t.name)}<b>${s.points}</b></span>`;
        }).join('');
        box.innerHTML = `<div class="bc-board">
          <span class="bc-kicker">${e.last ? 'Final course' : `Course ${e.courseIdx + 1} of ${info.courses}`} · ${esc(info.course.name)}</span>
          <h2>${single ? (e.rows[0].time !== null ? 'Course complete!' : 'Out of time!') : `${esc(teamName(e.rows[0].team))} wins the course!`}</h2>
          <div class="bc-rows">${rows}</div>
          ${single ? `<p class="bc-par">Par ${fmtTime(info.par)} · 🥇 under par · 🥈 within 35%</p>` : `<div class="bc-standings"><small>Overall</small>${standings}</div>`}
          <p class="bc-next">${e.last ? 'Final results coming up…' : 'Next course in a few seconds…'}</p>
        </div>`;
        box.classList.remove('hidden');
      }

      let rosterSig = '';
      function renderRoster(force) {
        if (myTeam === null || !info) { q('[data-roster]').innerHTML = ''; return; }
        const t = info.teams[myTeam];
        const rows = latest ? new Map(latest.p.map((r) => [r[0], r])) : new Map();
        const items = t.members.map((i) => {
          const p = byIdx.get(i);
          const f = rows.get(i)?.[5] || 0;
          const running = latest?.ph === PH.run;
          const st = f & 32 ? ['💤', 'offline'] : f & 512 ? ['😴', 'away'] : f & 4 ? ['☁️', 'fell'] : f & 8 ? ['💫', 'dizzy']
            : f & 1 ? ['⚓', 'brace'] : f & 2 ? ['💪', 'heave'] : !running ? ['', ''] : f & 256 ? ['✅', 'pulling']
              : crewWarn.slack.has(i) ? ['⚠️', 'slack'] : ['', ''];
          return { p, st, me: i === myIdx };
        });
        const sig = JSON.stringify(items.map((x) => [x.p?.idx, x.st[1]]));
        if (!force && sig === rosterSig) return;
        rosterSig = sig;
        q('[data-roster]').innerHTML = `<div class="bc-roster-head" style="--team:${t.color}">${esc(t.name)} team</div>${items.map(({ p, st, me }) => `
          <div class="bc-mate ${st[1]}${me ? ' me' : ''}">${api.avatarHtml(p.avatar)}<span>${esc(me ? 'You' : p.name)}</span><i>${st[0]}</i></div>`).join('')}`;
      }

      // One pip per teammate who's here (not offline or asleep), lit for a moment when they heave:
      // heaves landing together light up together and stack into a sync.
      function renderSync(now) {
        if (myTeam === null || !info) return;
        const rows = latest ? new Map(latest.p.map((r) => [r[0], r[5]])) : new Map();
        const crew = info.teams[myTeam].members.filter((i) => !((rows.get(i) || 0) & (32 | 512)));
        const live = now - sync.at < 450;
        if (!live) { sync.ids.clear(); sync.k = 0; }
        const pips = q('[data-pips]');
        const sig = crew.join(',');
        if (pips.dataset.sig !== sig) { pips.dataset.sig = sig; pips.innerHTML = crew.map(() => '<i></i>').join(''); }
        [...pips.children].forEach((pip, k) => pip.classList.toggle('on', sync.ids.has(crew[k])));
        q('[data-sync]').classList.toggle('active', sync.k >= 2);
        const need = crew.length >= 4 ? 3 : 2;
        setText(q('[data-sync-label]'), sync.k >= 2 ? `SYNC x${sync.k}!` : crew.length > 1 ? `HEAVE TOGETHER · ${need}` : 'HEAVE');
        // Heave cooldown ring.
        const cd = Math.max(0, Math.min(1, (now / 1000 - lastHeave) / 1));
        const ring = q('[data-cd]');
        if (ring) ring.style.strokeDashoffset = `${(1 - cd) * 289}`;
        q('[data-heave]').classList.toggle('ready', cd >= 1);
      }

      let raceAt = 0;
      let alertsAt = 0;
      function renderRace(now, balls) {
        if (now - raceAt < 150 || !info) return;
        raceAt = now;
        const total = C.goal.y;
        const cps = C.checkpoints.slice(1).map((cp) => `<i class="cp" style="left:${(cp.y / total) * 100}%"></i>`).join('');
        const finishes = new Map(info.teams.map((t) => [t.idx, t.finish]));
        q('[data-race]').innerHTML = info.teams.map((t) => {
          const b = balls.find((x) => x.team === t.idx);
          const p = b ? Math.max(0, Math.min(1, b.y / total)) : 0;
          const fin = finishes.get(t.idx);
          return `<div class="bc-lane${t.idx === myTeam ? ' me' : ''}" style="--team:${t.color}">
            <span class="nm">${esc(t.name)}</span>
            <div class="trk">${cps}<i class="fill" style="width:${p * 100}%"></i><b class="dot${b && b.state === 1 ? ' fall' : ''}" style="left:${p * 100}%"></b><i class="flag">🏁</i></div>
            <em>${fin ? PLACES[fin.place - 1] : `${Math.round(p * 100)}%`}</em></div>`;
        }).join('');
      }

      function renderAlerts() {
        const tm = mods.get(myTeam);
        const tc = latest ? latest.tc : 0;
        const list = [];
        if (tm) {
          if (tm.oil && tm.oil.until > tc) list.push(['oil', tm.oil.until - tc]);
          if (tm.gust && tm.gust.until > tc) list.push(['gust', tm.gust.until - tc]);
          if (tm.snarl > tc) list.push(['snarl', tm.snarl - tc]);
          if (tm.heavy > tc) list.push(['heavy', tm.heavy - tc]);
        }
        q('[data-alerts]').innerHTML = list.map(([k, left]) => `<span class="bc-alert ${k}"><i>${SABOTAGE[k][0]}</i>${SABOTAGE[k][1].replace('!', '')}<b>${Math.ceil(left)}s</b></span>`).join('');
      }

      // All hands: when anyone on my team isn't pulling, the ball digs in. Say who, after a moment
      // (so a rope going slack for a blink doesn't flash a warning).
      const crewWarn = { since: 0, show: false, sig: '', slack: new Set() };
      function renderCrew(now) {
        const box = q('[data-crew]');
        crewWarn.slack.clear();
        let slackers = [];
        if (myTeam !== null && latest && info && latest.ph === PH.run) {
          const rows = new Map(latest.p.map((r) => [r[0], r]));
          const ball = myBall();
          const members = info.teams[myTeam].members;
          const finished = (rows.get(myIdx)?.[5] || 0) & 64;
          slackers = members.filter((i) => {
            const f = rows.get(i)?.[5] || 0;
            return !(f & (32 | 512 | 256));
          });
          if (!ball || ball[6] !== 0 || finished) slackers = [];
        }
        if (slackers.length) crewWarn.since ||= now;
        else crewWarn.since = 0;
        crewWarn.show = !!crewWarn.since && now - crewWarn.since > 700;
        if (crewWarn.show) slackers.forEach((i) => crewWarn.slack.add(i));
        const meSlack = crewWarn.show && slackers.includes(myIdx);
        const others = slackers.filter((i) => i !== myIdx).map((i) => byIdx.get(i)?.name || '?');
        const sig = crewWarn.show ? `${meSlack}|${others.join(',')}` : '';
        if (sig === crewWarn.sig) return;
        crewWarn.sig = sig;
        box.classList.toggle('show', crewWarn.show);
        box.classList.toggle('me', meSlack);
        if (!crewWarn.show) return;
        const list = others.length > 2 ? `${others.slice(0, 2).map(esc).join(', ')} +${others.length - 2}` : others.map(esc).join(' & ');
        box.innerHTML = meSlack
          ? `<b>💪 PULL!</b><span>The ball won't budge unless you pull too</span>`
          : `<b>⛓️ Ball stuck</b><span>Waiting for ${list}</span>`;
      }

      function updateHud(now, viewState) {
        if (!latest || !info) return;
        const s = latest;
        // Countdown, then GO.
        if (s.ph === PH.countdown) {
          const n = Math.ceil(s.pt);
          const count = q('[data-count]');
          if (count) {
            count.textContent = n <= 3 ? n : '';
            count.classList.toggle('on', n <= 3);
          }
          if (n !== prev.count && n <= 3 && n > 0) Sfx.beep();
          prev.count = n;
        }
        if (s.ph !== prev.phase) {
          if (s.ph === PH.run && prev.phase === PH.countdown) { q('[data-intro]').classList.add('hidden'); callout('GO!', 'go'); Sfx.go(); }
          if (s.ph === PH.run) q('[data-intro]').classList.add('hidden');
          if (s.ph === PH.end) { Sfx.bcRumbleStop?.(); }
          prev.phase = s.ph;
        }
        // Timer.
        const timer = q('[data-timer]');
        if (s.ph === PH.run && s.tl !== null) {
          setText(q('[data-timer-val]'), fmt(s.tl));
          timer.classList.toggle('urgent', s.tl <= 15);
          if (prev.tl !== null && Math.ceil(s.tl) !== Math.ceil(prev.tl) && s.tl <= 10 && s.tl > 0) Sfx.tick();
          prev.tl = s.tl;
        } else if (s.ph === PH.countdown) {
          setText(q('[data-timer-val]'), fmt(info.limit));
          timer.classList.remove('urgent');
        }
        // Section banner when my ball enters a new section.
        const ball = viewState ? viewState.balls.find((b) => b.team === (myTeam ?? leadTeam())) : null;
        if (ball) {
          let si = 0;
          C.sections.forEach((sec, i) => { if (ball.y >= sec.y0) si = i; });
          const sec = C.sections[si];
          setText(q('[data-sec-icon]'), sec.icon);
          setText(q('[data-sec-name]'), sec.name);
          if (si !== prev.section) {
            if (prev.section >= 0 && s.ph === PH.run && sec.hint && myTeam !== null) banner(sec.icon, sec.name, sec.hint);
            prev.section = si;
          }
        }
        renderRace(now, viewState ? viewState.balls : []);
        renderSync(now);
        renderCrew(now);
        if (now - alertsAt > 300) { alertsAt = now; renderAlerts(); }
        renderRoster(false);
      }

      const leadTeam = () => {
        if (!latest) return 0;
        const best = [...latest.b].sort((a, b) => b[10] - a[10])[0];
        return best ? best[0] : 0;
      };

      // ---------- frame loop ----------
      let rumbleT = 0;
      function frame(now) {
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, (now - lastFrame) / 1000);
        frameTimes.push(now - lastFrame);
        if (frameTimes.length > 600) frameTimes.shift();
        lastFrame = now;
        if (!info || !C) return;
        predict(dt);
        const v = interpolated();
        window.__bcStats.view = v; // what this screen shows (tests compare it across players)
        window.__bcStats.local = local;
        if (v) {
          const meV = v.players.find((p) => p.idx === myIdx);
          if (meV && local && latest?.ph === PH.run && !(meV.flags & (4 | 8 | 32))) {
            meV.x = local.x; meV.y = local.y; meV.vx = local.vx; meV.vy = local.vy;
            if (local.braced) meV.flags |= 1;
            wraps.set(myIdx, local.wraps);
          }
          for (const p of v.players) p.slack = crewWarn.slack.has(p.idx);
          const focusTeam = myTeam ?? leadTeam();
          const fb = v.balls.find((b) => b.team === focusTeam);
          const intro = latest && latest.ph === PH.countdown ? Math.max(0, Math.min(1, 1 - (latest.pt - 0.4) / ((info.courseIdx === 0 ? 7 : 5) - 1.4))) : 1;
          if (view3d?.ready && !q('[data-loading]').classList.contains('hidden')) q('[data-loading]').classList.add('hidden');
          if (view3d && fb) {
            const u0 = performance.now();
            view3d.update({
              t: v.t, phase: latest?.ph, intro, balls: v.balls, players: v.players, wraps, mods,
              focus: {
                team: focusTeam, x: fb.x, y: Math.max(fb.y, 0), mx: meV?.x, my: meV?.y, snap: snapCam,
                // Everyone on the team who's on the course: the camera keeps them all in shot.
                crew: v.players.filter((p) => p.team === focusTeam && !(p.flags & (4 | 32))).map((p) => ({ x: p.x, y: p.y })),
              },
              rope: info.rope,
            }, dt, now);
            snapCam = false;
            window.__bcStats.updateMs = performance.now() - u0;
            window.__bcStats.renderMs = view3d.renderMs;
          }
          const h0 = performance.now();
          updateHud(now, v);
          window.__bcStats.hudMs = performance.now() - h0;
          const mb = v.balls.find((b) => b.team === myTeam);
          // The rope creaks when it snaps tight or strains near its limit.
          const myRow = latest?.p.find((r) => r[0] === myIdx);
          const yank = myRow ? !!(myRow[5] & 16) : false;
          if (yank && !prev.yank) Sfx.bcCreak?.(0.9);
          prev.yank = yank;
          if (local && mb && latest?.ph === PH.run && now - (prev.creakAt || 0) > 1400) {
            const len = B.pathLen(B.ropePoints(C, local, { x: mb.x, y: mb.y }));
            if (len > info.rope.rest + (info.rope.max - info.rope.rest) * 0.75) { prev.creakAt = now; Sfx.bcCreak?.(0.5); }
          }
          // Ball rumble follows how fast my team's ball rolls.
          rumbleT += dt;
          if (mb && latest?.ph === PH.run && rumbleT > 0.1) {
            rumbleT = 0;
            Sfx.bcRumble?.(mb.state === 0 && mb.z < 5 ? Math.min(1, Math.hypot(mb.vx, mb.vy) / 260) : 0);
          }
        }
      }
      raf = requestAnimationFrame(frame);

      // ---------- events ----------
      const ballAt = (team) => latest?.b.find((r) => r[0] === team);
      function onFx(e) {
        const mineTeam = e.team === myTeam;
        switch (e.type) {
          case 'go': break;
          case 'heave': {
            const p = latest?.p.find((r) => r[0] === e.idx);
            if (p) view3d?.fx({ type: 'heave', team: e.team, x: p[1], y: p[2] });
            if (e.idx === myIdx) Sfx.bcHeave?.();
            if (mineTeam) {
              if (performance.now() - sync.at > 450) sync.ids.clear();
              sync.ids.add(e.idx);
              sync.k = e.k;
              sync.at = performance.now();
            }
            if (e.k >= 2 || e.launch) {
              const b = ballAt(e.team);
              if (b) view3d?.fx({ type: e.launch ? 'launch' : 'sync', team: e.team, x: b[1], y: b[2], k: e.k });
              if (mineTeam) {
                Sfx.bcSync?.(e.k);
                callout(e.launch ? 'LAUNCH!' : `SYNC x${e.k}!`, e.launch ? 'launch' : `sync k${Math.min(6, e.k)}`);
                if (e.launch) Sfx.bcLaunch?.();
              }
            }
            break;
          }
          case 'checkpoint':
            view3d?.fx(e);
            if (mineTeam) { callout('CHECKPOINT!', 'cp'); Sfx.bcCheckpoint?.(); }
            break;
          case 'finish': {
            view3d?.fx(e);
            const t = info.teams[e.team];
            if (t) t.finish = { place: e.place, time: e.time };
            if (mineTeam) {
              callout(info.teams.length > 1 ? `${PLACES[e.place - 1].toUpperCase()}!` : 'FINISHED!', 'finish');
              Sfx.finish();
              if (window.confetti) window.confetti({ particleCount: 160, spread: 90, origin: { y: 0.65 }, zIndex: 50 });
              else loadScript('/vendor/confetti/confetti.browser.js').then(() => window.confetti?.({ particleCount: 160, spread: 90, origin: { y: 0.65 }, zIndex: 50 })).catch(() => {});
            } else {
              banner('🏁', `${t?.name || 'A team'} finished ${PLACES[e.place - 1]}`, `${fmtTime(e.time)}`, 'info', 2400);
            }
            break;
          }
          case 'fall':
            view3d?.fx(e);
            if (e.ball && mineTeam) { callout('BALL OVERBOARD!', 'fall'); Sfx.bcFall?.(true); }
            else if (e.idx === myIdx) Sfx.bcFall?.(false);
            break;
          case 'respawn': view3d?.fx(e); if (mineTeam) Sfx.pop(); break;
          case 'pop': view3d?.fx({ ...e, team: byIdx.get(e.idx)?.team }); if (e.idx === myIdx) Sfx.pop(); break;
          case 'land': view3d?.fx(e); if (mineTeam) Sfx.bcThump?.(0.8); break;
          case 'bump':
            view3d?.fx(e);
            if (mineTeam) (e.kind === 'bumper' ? Sfx.bcBoing?.(e.power) : Sfx.bcThump?.(e.power));
            break;
          case 'hit': {
            const team = byIdx.get(e.idx)?.team;
            view3d?.fx({ ...e, team });
            if (e.idx === myIdx) { Sfx.bcThump?.(1); api.toast(e.kind === 'hammer' ? '🔨 Bonk!' : '🌀 Swept!'); }
            break;
          }
          case 'sabotage': {
            e.to.forEach((t, i) => mods.set(t, e.mods[i]));
            const [icon, title, text] = SABOTAGE[e.kind];
            if (e.to.includes(myTeam)) {
              banner(icon, title, `${teamName(e.from)} reached the checkpoint first. ${text}`, 'warn', 4200);
              Sfx.bcAlarm?.();
            } else if (e.from === myTeam) {
              banner(icon, `You dropped: ${title.replace('!', '')}`, `on ${e.to.map(teamName).join(', ')}`, 'good', 3000);
            }
            renderAlerts();
            break;
          }
          case 'courseEnd':
            Sfx.bcRumbleStop?.();
            renderBoard(e);
            info.teams.forEach((t) => { const st = e.standings.find((s) => s.idx === t.idx); if (st) t.points = st.points; });
            break;
          case 'gone': case 'back': renderRoster(true); break;
          case 'afk':
            if (e.team === myTeam && e.on && e.idx !== myIdx) banner('😴', `${byIdx.get(e.idx)?.name || 'A teammate'} is away`, 'The ball stops waiting for them until they move again', 'warn');
            else if (e.idx === myIdx && e.on) banner('😴', 'You went quiet', 'Your team carries on without you. Move to join back in.', 'warn');
            renderRoster(true);
            break;
          default: break;
        }
      }

      return {
        onSnapshot(snap) { if (snap.init) onInit(snap.init); },
        onEvent(event, data) {
          if (event === 'game:bc:init') onInit(data);
          else if (event === 'game:bc:state') onState(data);
          else if (event === 'game:bc:fx') onFx(data);
        },
        unmount() {
          cancelAnimationFrame(raf);
          clearInterval(keepAlive);
          clearInterval(pinger);
          clearTimeout(bannerTimer);
          clearTimeout(pendingSend);
          Sfx.bcRumbleStop?.();
          joystick?.destroy();
          view3d?.dispose();
          window.removeEventListener('keydown', kd);
          window.removeEventListener('keyup', ku);
          window.removeEventListener('blur', blur);
        },
      };
    },

    // Results screen: team ranking, per-course places, awards and fun player stats.
    renderResults(r, ui) {
      const { $, avatarHtml, escapeHtml: esc } = ui;
      const teams = r.teams || [];
      const byId = new Map((r.players || []).map((p) => [p.id, p]));
      const winner = teams[0];
      $('results-title').innerHTML = r.single
        ? `⛓️ ${winner ? `${esc(winner.name)} team` : 'Team'} · ${winner?.score || 0} pts`
        : `🏆 ${esc(winner?.name || '')} team wins Ball & Chain!`;
      $('results-teams').innerHTML = `<div class="bc-res-teams">${teams.map((t, i) => `
        <div class="bc-res-team${i === 0 ? ' win' : ''}" style="--team:${t.color};--d:${i * 0.08}s">
          <span class="rk">${i === 0 ? '🏆' : i + 1}</span>
          <div class="nm"><b>${esc(t.name)}</b><span class="mem">${t.members.map((id) => byId.get(id)).filter(Boolean).map((p) => avatarHtml(p.avatar)).join('')}</span></div>
          <div class="cs">${(t.places || []).map((pl, ci) => `<i title="Course ${ci + 1}">${r.single ? (r.courses[ci]?.rows[0]?.medal ? { gold: '🥇', silver: '🥈', bronze: '🥉' }[r.courses[ci].rows[0].medal] : '✖') : pl}</i>`).join('')}</div>
          <div class="sc"><b>${t.score}</b><small>pts · ${fmtTime(t.time)}</small></div>
        </div>`).join('')}</div>`;
      $('podium').innerHTML = (r.awards || []).length ? `<div class="bc-awards">${r.awards.map((a, i) => {
        const p = byId.get(a.id);
        return p ? `<div class="bc-award" style="--team:${p.teamColor};--d:${0.2 + i * 0.08}s"><i>${a.icon}</i>${avatarHtml(p.avatar)}<b>${esc(a.title)}</b><span>${esc(p.name)}</span><small>${a.value} ${esc(a.unit)}</small></div>` : '';
      }).join('')}</div>` : '';
      $('results-players').innerHTML = (r.players || []).map((p) => `<li class="bc-res-player" style="--team:${p.teamColor}">
        ${avatarHtml(p.avatar)}<span class="nm">${esc(p.name)}</span>
        <span class="extra"><span title="Sync heaves">⚡ ${p.stats.syncs}</span><span title="Seconds braced">⚓ ${p.stats.brace}s</span><span title="Distance pulled">💪 ${p.stats.pulled} m</span><span title="Falls">🫠 ${p.stats.falls}</span></span>
        <span class="pts">${p.score}</span></li>`).join('');
    },
  };
})();
