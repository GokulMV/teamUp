/* global KartCore, KartHud, KartMinimap */
window.Games = window.Games || {};

// Kart Battle client: networking, input, prediction and HUD.
// The 3D world is drawn by Kart3D (js/games/kart3d.js).
window.Games.kart = {
  mount(el, api) {
    const K = KartCore;
    const Sfx = window.Sfx;
    const Icons = window.ItemIcons;
    const INTERP_DELAY = 110; // ms behind the server for smooth remote karts
    const touch = matchMedia('(pointer: coarse)').matches;
    // Snapshot flag bits (see broadcast() in server/games/kart.js).
    const F = { spin: 1, boost: 2, shield: 4, finished: 8, invuln: 16, dead: 32, drift: 64, ghost: 1024, gun: 2048, star: 4096, shrunk: 8192, inked: 16384 };
    // Snapshot kart row: [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags, kills, deaths, hp, air, fx, roulette]
    const I = KartHud.ICONS;
    const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" class="tc-ic" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

    el.innerHTML = `
      <div class="game-wrap">
        <div class="stage kart-stage" data-stage>
          <div class="kart-ink" data-ink></div>
          <div class="kart-flash" data-flash></div>
          <div class="kart-card kart-panel" data-card>
            <div class="kc-race"><span class="kc-place" data-place></span><div class="kc-meta"><span class="kc-kicker" data-lap></span><span class="kc-num" data-time></span></div></div>
            <div class="kc-arena">
              <div class="kc-hp">${I.heart}<div class="kc-bar"><i data-hp-fill></i></div><span class="kc-num" data-hp-text>100</span></div>
              <div class="kc-stats"><span class="kc-chip">${I.cross}<b data-kills>0</b></span><span class="kc-chip">${I.skull}<b data-deaths>0</b></span><span class="kc-chip kc-muted" data-rank></span></div>
            </div>
            <div class="kc-spec">${I.eye}<span>Spectating</span></div>
          </div>
          <div class="kart-top">
            <div class="kart-timer kart-panel hidden" data-timer></div>
            <div class="kart-item empty" data-item>
              <div class="kart-slot"><div class="kart-reel" data-reel></div><div class="kart-item-icon" data-item-icon></div></div>
              <small data-item-ammo></small><kbd class="kart-key">Space</kbd>
            </div>
            <div class="kart-top-sub">
              <div class="kart-item-name kart-panel" data-item-name></div>
              <div class="kart-warn hidden" data-warn>${Icons.svg('comet', 'item-icon')}<span>Comet incoming!</span></div>
            </div>
          </div>
          <div class="kart-intro kart-panel" data-intro></div>
          <div class="kart-board kart-panel" data-board></div>
          <div class="kart-feed" data-feed></div>
          <div class="kart-callout" data-callout></div>
          <div class="kart-speedlines" data-speedlines></div>
          <div class="kart-vignette" data-vignette></div>
          <div class="kart-hit" data-hit><svg viewBox="0 0 28 28"><path d="M4 4l7 7M24 4l-7 7M4 24l7-7M24 24l-7-7"/></svg></div>
          <div class="kart-dead kart-panel" data-dead></div>
          <canvas class="kart-minimap" data-minimap></canvas>
          <div class="kart-help kart-panel" data-help>${touch ? '<b>Tap any button to start</b>Your kart accelerates by itself' : '<kbd>WASD</kbd> drive <kbd>Shift</kbd> drift <span class="kh-item"><kbd>Space</kbd> use item <kbd>S</kbd>+<kbd>Space</kbd> throw back</span>'}</div>
          <div class="kart-rotate kart-panel hidden" data-rotate>${svg('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M21 14a8 8 0 0 1-6 6.5M3 10a8 8 0 0 1 6-6.5"/>')}Turn your phone for a wider view</div>
          <div class="kart-tools">
            <button class="kart-tool" data-fullscreen title="Full screen" aria-label="Full screen">${svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>
            <button class="kart-tool tool-chat" data-chat title="Chat" aria-label="Chat">${svg('<path d="M4 5h16v11H9l-5 4z"/>')}</button>
            <button class="kart-tool tool-menu" data-menu title="Menu" aria-label="Menu">${svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', 'stroke-width="3"')}</button>
          </div>
          <div class="touch-controls">
            <div class="tc-steer"><button data-key="left" aria-label="Steer left">${svg('<path d="M15 5l-7 7 7 7"/>')}</button><button data-key="right" aria-label="Steer right">${svg('<path d="M9 5l7 7-7 7"/>')}</button></div>
            <div class="tc-act">
              <button class="tc-drift" data-key="drift" aria-label="Drift">${svg('<path d="M5 17c3-1 4.5-3 5.5-6S14 6 19 6"/><path d="M15 3l4 3-3 4"/>')}<small>Drift</small></button>
              <button class="tc-brake" data-key="down" aria-label="Brake">${svg('<path d="M12 5v12M6 12l6 6 6-6"/>')}</button>
              <button class="tc-fire" data-key="use" aria-label="Use item"><span data-fire-icon></span></button>
            </div>
          </div>
        </div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');
    stage.classList.toggle('touch', touch);

    let info = null; // init payload
    let map = null;
    let kartsByIdx = new Map();
    const snapshots = []; // { t, data }
    let clockOffset = null; // localNow - serverT (minimum observed)
    let latest = null;
    let myIdx = -1;
    let local = null; // predicted state of my kart
    let rtt = 80;
    let lastFrame = performance.now();
    let raf = 0;
    let view3d = null;
    let snapCamera = true;
    const input = { up: false, down: false, left: false, right: false, drift: false };
    const prev = { boost: false, drift: 0, count: null, finished: false, star: false, shrunk: false, inked: false, warn: 0, air: 0, trick: false };
    const teamMode = () => !!api.room()?.settings.teamMode;
    const colorOf = (meta) => (teamMode() ? api.teamById(meta?.team)?.color : meta?.color) || '#fff';
    const hud = KartHud.create({ stage, escape: api.escapeHtml, colorOf, metaOf: (idx) => kartsByIdx.get(idx), touch });
    let death = null; // { at, by, kind, watching } while my kart is wrecked
    let wasWrecked = false;
    let camMode = '';
    let orbitAngle = 0;
    const spec = { idx: -1, next: -1, since: 0 }; // spectator cam: who it follows, who's taking over
    let finishTime = null;
    let bulletHits = 0;
    const deathMarks = []; // arena minimap: where karts were just smashed

    // ---------- 3D renderer (ES module, may finish loading after mount) ----------
    function createRenderer() {
      if (!info || view3d || !window.Kart3D) return;
      try {
        view3d = new window.Kart3D(stage, { mapId: info.mapId, type: info.map, reverse: !!info.reverse, items: info.items !== false });
        view3d.setKarts(info.karts, myIdx, (meta) => (teamMode() ? api.teamById(meta.team)?.color : null));
        minimap = null; // rebuild with the 3D world's curb colour
      } catch (err) {
        console.error(err);
        window.reportError?.(err);
        if (!stage.querySelector('.kart-nogl')) {
          const box = document.createElement('div');
          box.className = 'overlay kart-nogl';
          box.innerHTML = `<h2>3D graphics are turned off</h2>
            <p class="muted">Your browser couldn’t start WebGL, which Kart Battle needs.<br>
            Try Chrome, Edge, Firefox or Safari with hardware acceleration switched on, then rejoin the room.</p>`;
          stage.appendChild(box);
        }
      }
    }
    const onReady = () => createRenderer();
    window.addEventListener('kart3d-ready', onReady);

    // ---------- Input ----------
    const keyMap = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
      ShiftLeft: 'drift', ShiftRight: 'drift', KeyX: 'drift', ControlLeft: 'drift',
    };
    function sendInput() { api.socket.emit('game:input', input); }
    function useItem() { api.socket.emit('game:use'); }
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    function onKey(e, down) {
      // Key releases still count while typing in chat, or a held key would stay down for good.
      if (typing(e) && (down || !keyMap[e.code])) return;
      if (e.code === 'Space' || e.code === 'KeyE') {
        if (down && !e.repeat) useItem();
        e.preventDefault();
        return;
      }
      const k = keyMap[e.code];
      if (!k) return;
      e.preventDefault();
      if (input[k] !== down) { input[k] = down; sendInput(); }
    }
    const kd = (e) => onKey(e, true);
    const ku = (e) => onKey(e, false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    let autoGas = false; // touch: set by the first button press
    // Leaving the page (or opening chat) lets go of everything, auto-gas included: the next button
    // press starts it again. Otherwise a phone in a pocket keeps driving into the lava.
    function release() {
      autoGas = false;
      stage.classList.remove('engaged');
      Object.keys(input).forEach((k) => { input[k] = false; });
      el.querySelectorAll('[data-key].on').forEach((b) => b.classList.remove('on'));
      sendInput();
    }
    const blur = () => release();
    const onVisibility = () => { if (document.hidden) release(); };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', onVisibility);
    let chatWasOpen = false;

    // Touch: once you press any button the kart accelerates by itself (not before, so nobody
    // rolls off the start into the lava); the brake button slows down and reverses.
    el.querySelectorAll('[data-key]').forEach((b) => {
      const k = b.dataset.key;
      const set = (v) => (e) => {
        e.preventDefault();
        b.classList.toggle('on', v);
        if (v && !autoGas) { autoGas = true; stage.classList.add('engaged'); }
        // The fire button only works once the roulette has landed (the server would refuse it anyway).
        if (k === 'use') { if (v && slotState.mode === 'ready') useItem(); } else input[k] = v;
        input.up = autoGas && !input.down;
        sendInput();
      };
      b.addEventListener('pointerdown', set(true));
      b.addEventListener('pointerup', set(false));
      b.addEventListener('pointercancel', set(false));
      b.addEventListener('pointerleave', set(false));
    });
    q('[data-fullscreen]').onclick = () => {
      const root = document.documentElement;
      if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
      Promise.resolve(root.requestFullscreen?.()).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
    };
    if (!document.fullscreenEnabled) q('[data-fullscreen]').classList.add('hidden'); // e.g. iPhone Safari
    q('[data-chat]').onclick = () => api.toggleChat?.();
    q('[data-menu]').onclick = (e) => api.openMenu?.(e.currentTarget);
    // One-time tip in portrait.
    let rotateTip = 0;
    try {
      if (touch && matchMedia('(orientation: portrait)').matches && !localStorage.getItem('teamup-rotate-tip')) {
        localStorage.setItem('teamup-rotate-tip', '1');
        q('[data-rotate]').classList.remove('hidden');
        rotateTip = setTimeout(() => q('[data-rotate]').classList.add('hidden'), 6000);
        q('[data-rotate]').onclick = () => q('[data-rotate]').classList.add('hidden');
      }
    } catch { /* storage blocked: skip the tip */ }
    const resend = setInterval(sendInput, 1000);
    const pinger = setInterval(() => {
      const t0 = performance.now();
      api.emit('game:ping').then(() => { rtt = rtt * 0.7 + (performance.now() - t0) * 0.3; });
    }, 2000);

    // ---------- Network ----------
    function onInit(data) {
      const sameRound = info && info.mapId === data.mapId && !!info.reverse === !!data.reverse && info.items === data.items && info.karts.length === data.karts.length;
      info = data;
      map = K.getMap(data.mapId, data.map, { reverse: !!data.reverse });
      kartsByIdx = new Map(data.karts.map((k) => [k.idx, k]));
      const mine = data.karts.find((k) => k.id === api.myId());
      myIdx = mine ? mine.idx : -1;
      local = null;
      snapCamera = true;
      death = null;
      spec.idx = -1;
      if (!sameRound) { finishTime = null; deathMarks.length = 0; }
      if (view3d && !sameRound) { view3d.dispose(); view3d = null; }
      minimap = null;
      createRenderer();
      q('[data-timer]').classList.toggle('hidden', map.type !== 'arena');
      slot.style.display = myIdx < 0 ? 'none' : '';
      stage.classList.toggle('spectating', myIdx < 0);
      stage.classList.toggle('mode-arena', map.type === 'arena');
      stage.classList.toggle('mode-race', map.type !== 'arena');
      stage.classList.toggle('no-items', data.items === false);
      hud.setRound(data, map, myIdx);
    }

    function onState(s) {
      const now = performance.now();
      const off = now - s.t;
      clockOffset = clockOffset === null ? off : Math.min(clockOffset + 0.5, off); // drift slowly upward
      snapshots.push({ t: s.t, data: s });
      while (snapshots.length > 30) snapshots.shift();
      latest = s;
      reconcile(s);
    }

    function reconcile(s) {
      const row = s.k.find((r) => r[0] === myIdx);
      if (!row) return;
      const [, x, y, a1000, speed, , , , , flags, , , , air = 0, fx = 0] = row;
      const angle = a1000 / 1000;
      if (!local || flags & F.dead) {
        local = { x, y, angle, heading: angle, speed, boost: 0, spin: 0, trackIndex: null, dead: !!(flags & F.dead), air: 0, z: null };
        return;
      }
      if (local.dead) { local.dead = false; Object.assign(local, { x, y, angle, heading: angle, speed, air: 0, z: null }); snapCamera = true; return; }
      // Falls into water/lava/gaps are the server's call: freeze on its position until we are fished out.
      if (fx & 1) { Object.assign(local, { x, y, angle, heading: angle, speed: 0, falling: true, air: 0, z: null, drift: 0 }); return; }
      if (local.falling) {
        Object.assign(local, { x, y, angle, heading: angle, speed, falling: false, air, z: null, vz: 0, trackIndex: null });
        snapCamera = true;
        return;
      }
      // Server state is ~half an RTT old; project it forward before comparing.
      const lead = Math.min(0.25, rtt / 2000);
      const sx = x + Math.cos(angle) * speed * lead;
      const sy = y + Math.sin(angle) * speed * lead;
      const ex = sx - local.x;
      const ey = sy - local.y;
      const err = Math.hypot(ex, ey);
      const spinning = flags & F.spin;
      if (spinning) local.spin = Math.max(local.spin, 0.15);
      if (flags & F.boost) local.boost = Math.max(local.boost, 0.15);
      local.flags = flags; // star / shrink change the top speed in prediction too
      if (err > 140 || spinning || s.phase !== 'racing') {
        Object.assign(local, { x: sx, y: sy, angle, heading: angle, speed });
        if (err > 140) Object.assign(local, { air, z: null, vz: 0, trackIndex: null });
      } else {
        local.x += ex * 0.2;
        local.y += ey * 0.2;
        let da = angle - local.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        local.angle += da * 0.2;
        local.speed += (speed - local.speed) * 0.2;
      }
    }

    // Interpolated positions for rendering.
    function interpolated() {
      if (!snapshots.length || clockOffset === null) return null;
      const target = performance.now() - clockOffset - INTERP_DELAY;
      let a = snapshots[0];
      let b = snapshots[snapshots.length - 1];
      for (let i = 0; i < snapshots.length - 1; i++) {
        if (snapshots[i].t <= target && snapshots[i + 1].t >= target) { a = snapshots[i]; b = snapshots[i + 1]; break; }
      }
      if (target >= b.t) a = b;
      const span = b.t - a.t;
      const f = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
      const prevK = new Map(a.data.k.map((r) => [r[0], r]));
      const karts = b.data.k.map((r) => {
        const p = prevK.get(r[0]) || r;
        // Don't slide across the map when a kart respawns.
        const jump = Math.hypot(r[1] - p[1], r[2] - p[2]) > 200;
        const ff = jump ? 1 : f;
        let da = (r[3] - p[3]) / 1000;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        return {
          idx: r[0], x: p[1] + (r[1] - p[1]) * ff, y: p[2] + (r[2] - p[2]) * ff,
          angle: p[3] / 1000 + da * ff, speed: r[4], flags: r[9], hp: r[12],
          air: (p[13] || 0) + ((r[13] || 0) - (p[13] || 0)) * ff, fx: r[14] || 0,
          item: r[7], ammo: r[8], roulette: r[15] || 0,
        };
      });
      // Shots: [id, kind, x, y, angle, progress/altitude, ...kind-specific extras]
      const prevS = new Map((a.data.s || []).map((r) => [r[0], r]));
      const shots = (b.data.s || []).map((r) => {
        const p = prevS.get(r[0]);
        if (!p) return [r[0], r[1], r[2], r[3], r[4] / 1000, r[5], ...r.slice(6)];
        let da = (r[4] - p[4]) / 1000;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        // Bouncers turn sharply at a wall: snap the angle instead of sweeping through it.
        const ang = Math.abs(da) > 0.6 ? r[4] / 1000 : p[4] / 1000 + da * f;
        return [r[0], r[1], p[2] + (r[2] - p[2]) * f, p[3] + (r[3] - p[3]) * f, ang, p[5] + (r[5] - p[5]) * f, ...r.slice(6)];
      });
      return { karts, shots, mines: b.data.m || [], bananas: b.data.b || [], boxes: b.data.x };
    }

    // ---------- HUD: item slot and roulette ----------
    // The slot lives in the glass top cluster; the touch fire button mirrors it (reel included).
    const slot = q('[data-item]');
    const reel = q('[data-reel]');
    const iconBox = q('[data-item-icon]');
    const useBtn = q('.tc-fire');
    const fireIcon = q('[data-fire-icon]');
    const nameEl = q('[data-item-name]');
    const itemId = (code) => K.ITEMS[code - 1];
    const slotState = { code: 0, ammo: -1, mode: 'empty' }; // mode: empty | rolling | ready
    const roulette = { start: 0, end: 0, cells: 0, last: -1, cell: 60, strip: [] };
    let nameTimer = 0;

    function showIcon(code) {
      const html = code ? Icons.svg(itemId(code), 'item-icon') : '';
      iconBox.innerHTML = html;
      fireIcon.innerHTML = html;
    }
    function setSlotMode(mode) {
      slotState.mode = mode;
      slot.classList.toggle('empty', mode === 'empty');
      slot.classList.toggle('rolling', mode === 'rolling');
      slot.classList.toggle('ready', mode === 'ready');
      useBtn.classList.toggle('armed', mode === 'ready');
      useBtn.classList.toggle('rolling', mode === 'rolling');
    }
    // A slot-machine strip of icons that decelerates onto the item the server picked.
    function startRoulette(code, remainingMs, now) {
      const pool = (info?.itemList?.length ? info.itemList : K.ITEMS).filter((id) => K.ITEMS.includes(id));
      const strip = [];
      const cells = 18;
      for (let i = 0; i < cells - 1; i++) {
        let id = pool[Math.floor(Math.random() * pool.length)];
        if (pool.length > 1) while (id === strip[i - 1]) id = pool[Math.floor(Math.random() * pool.length)];
        strip.push(id);
      }
      strip.push(itemId(code));
      reel.innerHTML = strip.map((id) => `<div class="cell">${Icons.svg(id, 'item-icon')}</div>`).join('');
      setSlotMode('rolling'); // shows the reel, so its cells have a size
      roulette.cell = reel.firstElementChild?.offsetHeight || 60;
      Object.assign(roulette, { start: now, end: now + remainingMs, cells, last: -1, strip });
      reel.style.transform = 'translateY(0)';
      showIcon(0);
      showName('');
      Sfx.pop();
    }
    function landRoulette(code, ding) {
      showIcon(code);
      setSlotMode('ready');
      slot.classList.remove('landed');
      void slot.offsetWidth; // restart the pop animation
      slot.classList.add('landed');
      showName(Icons.name(itemId(code)), 1800);
      if (ding) Sfx.rouletteDing?.();
    }
    // The item's name shows under the slot for a moment when it lands.
    function showName(text, ms) {
      clearTimeout(nameTimer);
      nameEl.textContent = text;
      nameEl.classList.toggle('show', !!text);
      if (text && ms) nameTimer = setTimeout(() => nameEl.classList.remove('show'), ms);
    }
    function updateSlot(now, code, ammo, rouletteCs) {
      if (code !== slotState.code) {
        // Time left on the server's roulette, minus how old this snapshot already is.
        const age = clockOffset === null ? rtt / 2 : Math.max(0, now - clockOffset - latest.t);
        if (!code) { showIcon(0); showName(''); setSlotMode('empty'); } else if (rouletteCs > 0) startRoulette(code, Math.max(350, rouletteCs * 10 - age), now);
        else landRoulette(code, slotState.code === 0);
        slotState.code = code;
      }
      if (slotState.mode === 'rolling') {
        const p = Math.min(1, (now - roulette.start) / (roulette.end - roulette.start));
        const pos = (1 - (1 - p) ** 3) * (roulette.cells - 1); // ease out: fast spin, slow landing
        reel.style.transform = `translateY(${-pos * roulette.cell}px)`;
        const idx = Math.round(pos);
        if (idx !== roulette.last) {
          roulette.last = idx;
          Sfx.rouletteTick?.(idx);
          if (touch) fireIcon.innerHTML = Icons.svg(roulette.strip[idx], 'item-icon');
        }
        if (p >= 1) landRoulette(code, true);
      }
      if (ammo !== slotState.ammo) {
        slotState.ammo = ammo;
        q('[data-item-ammo]').textContent = code && ammo > 1 ? `×${ammo}` : '';
      }
    }

    // ---------- HUD: ink, thunder flash, comet warning ----------
    const inkEl = q('[data-ink]');
    let inkAt = 0;
    // A random ink blot: a lumpy disc with drips and droplets around it.
    function blob() {
      const pts = [];
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = 34 + Math.random() * 12 + (i % 3 === 0 ? 6 : 0);
        pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
      }
      let d = '';
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const nx = pts[(i + 1) % n];
        const mid = [(p[0] + nx[0]) / 2, (p[1] + nx[1]) / 2];
        d += `${i ? '' : `M${mid[0].toFixed(1)} ${mid[1].toFixed(1)} `}Q${nx[0].toFixed(1)} ${nx[1].toFixed(1)} ${((nx[0] + pts[(i + 2) % n][0]) / 2).toFixed(1)} ${((nx[1] + pts[(i + 2) % n][1]) / 2).toFixed(1)} `;
      }
      const drops = [0, 1, 2, 3].map(() => {
        const a = Math.random() * Math.PI * 2;
        const r = 50 + Math.random() * 14;
        return `<circle cx="${(50 + Math.cos(a) * r).toFixed(1)}" cy="${(50 + Math.sin(a) * r).toFixed(1)}" r="${(2 + Math.random() * 4).toFixed(1)}"/>`;
      }).join('');
      const drips = [0, 1].map(() => {
        const x = 30 + Math.random() * 40;
        const len = 18 + Math.random() * 22;
        return `<path d="M${x - 4} 75 Q${x - 3} ${80 + len} ${x} ${82 + len} Q${x + 3} ${80 + len} ${x + 4} 75Z"/>`;
      }).join('');
      return `<svg viewBox="-20 -20 140 160" aria-hidden="true"><g fill="#140a26">${drips}<path d="${d}Z"/>${drops}</g>
        <ellipse cx="38" cy="34" rx="12" ry="6" fill="#8b7bd8" opacity="0.28" transform="rotate(-30 38 34)"/></svg>`;
    }
    function splatInk(now) {
      inkAt = now;
      const blots = 6 + Math.floor(Math.random() * 3);
      let html = '';
      for (let i = 0; i < blots; i++) {
        const size = 26 + Math.random() * 22; // % of the stage width
        const x = 8 + Math.random() * 84;
        const y = 12 + Math.random() * 70;
        html += `<div class="blot" style="width:${size}%;left:${x}%;top:${y}%;--r:${Math.round(Math.random() * 360)}deg;animation-delay:${(i * 0.06).toFixed(2)}s">${blob()}</div>`;
      }
      inkEl.innerHTML = html;
      inkEl.classList.remove('fading');
      inkEl.classList.add('on');
      Sfx.inked?.();
    }
    function updateInk(now, inked) {
      if (inked && !prev.inked) splatInk(now);
      prev.inked = inked;
      // Fade over the last second (or at once if the ink is gone early, e.g. on respawn).
      if (inkEl.classList.contains('on') && (!inked || now > inkAt + (K.ITEM_FX.inkTime - 1) * 1000)) {
        inkEl.classList.add('fading');
        if (!inked) inkEl.classList.remove('on');
      }
    }
    function flash() {
      const f = q('[data-flash]');
      f.classList.remove('on');
      void f.offsetWidth;
      f.classList.add('on');
    }

    // ---------- HUD ----------
    // Minimap: rebuilt for each map, size (CSS px and devicePixelRatio) and renderer.
    let minimap = null;
    let minimapKey = '';
    const mmCanvas = q('[data-minimap]');
    const mmResize = new ResizeObserver(() => { minimap = null; });
    mmResize.observe(mmCanvas);
    function drawMinimap(now, karts) {
      const css = mmCanvas.clientWidth;
      if (!css) return;
      const key = `${map.id}|${!!map.reverse}|${css}|${window.devicePixelRatio}`;
      if (!minimap || key !== minimapKey) {
        minimapKey = key;
        minimap = KartMinimap.create(mmCanvas, map, { theme: map.theme, cssSize: css, dpr: window.devicePixelRatio, curb: view3d?.theme?.curb?.[0], night: !!view3d?.theme?.night });
      }
      while (deathMarks.length && now - deathMarks[0].t > 2000) deathMarks.shift();
      const placeOf = new Map(latest.k.map((r) => [r[0], r[6]]));
      minimap.draw({
        karts: karts.map((k) => ({ x: k.x, y: k.y, angle: k.angle, color: colorOf(kartsByIdx.get(k.idx)), me: k.idx === myIdx, dead: !!(k.flags & F.dead), place: placeOf.get(k.idx) })),
        boxes: latest?.x,
        deaths: deathMarks.map((d) => ({ x: d.x, y: d.y, color: d.color, age: (now - d.t) / 1000 })),
        comets: (latest?.s || []).filter((sh) => sh[1] === 5).map((sh) => ({ x: sh[2], y: sh[3] })), // comets in flight
        time: now / 1000,
      });
    }

    function updateHud(now, karts) {
      if (!latest || !info) return;
      const row = latest.k.find((r) => r[0] === myIdx);
      hud.update(now, latest, row, { finishTime, death });
      if (row) {
        // Place, lap, health and kills are drawn by the HUD kit; the item slot, ink and warnings here.
        const [, , , , , , , item, ammo, flags, , , , , , rouletteCs] = row; // 13 air, 14 fall/trick bits, 15 roulette
        updateSlot(now, item, ammo, rouletteCs || 0);
        const boosting = !!(flags & F.boost);
        const driftLvl = flags & 256 ? 2 : flags & 128 ? 1 : 0;
        if (boosting && !prev.boost) (prev.drift > 0 && !(flags & F.drift) ? Sfx.miniTurbo(prev.drift) : Sfx.boost());
        prev.boost = boosting;
        prev.drift = flags & F.drift ? driftLvl : 0;
        if (flags & F.finished && !prev.finished) Sfx.finish();
        prev.finished = !!(flags & F.finished);
        const star = !!(flags & F.star);
        if (star && !prev.star) Sfx.starStart?.(K.ITEM_FX.starTime);
        else if (!star && prev.star) Sfx.starStop?.();
        prev.star = star;
        const shrunk = !!(flags & F.shrunk);
        if (shrunk && !prev.shrunk) Sfx.shrink?.();
        prev.shrunk = shrunk;
        updateInk(now, !!(flags & F.inked));
        q('[data-speedlines]').classList.toggle('on', boosting || star);
        q('[data-speedlines]').classList.toggle('star', star);
        // Is a comet coming for me?
        const comet = (latest.s || []).find((sh) => sh[1] === 5 && sh[6] === myIdx);
        q('[data-warn]').classList.toggle('hidden', !comet);
        if (comet && now - prev.warn > 520) { prev.warn = now; Sfx.cometWarn?.(); }
      } else {
        slot.style.display = 'none';
        stage.classList.add('spectating');
      }
      drawMinimap(now, karts);
    }

    function volumeAt(x, y) {
      if (!local) return 0.5;
      return Math.max(0.08, 1 - Math.hypot(local.x - x, local.y - y) / 1400);
    }

    // ---------- Frame loop ----------
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      if (!info) return;
      const chatOpen = document.body.classList.contains('chat-open');
      if (chatOpen && !chatWasOpen) release(); // the chat sheet covers the controls
      chatWasOpen = chatOpen;

      // Predict my kart locally so steering feels instant (same item speed factors as the server).
      const myRow = latest?.k.find((r) => r[0] === myIdx);
      if (local && !local.dead && !local.falling && latest?.phase === 'racing') {
        const fl = local.flags || 0;
        K.stepKart(local, input, dt, map, { speed: (info.speedMul || 1) * K.itemSpeed(fl & F.star, fl & F.shrunk), noFall: true });
        // Tricks and landings feel instant for your own kart.
        if (local.trick > 0 && !prev.trick) Sfx.trick?.();
        prev.trick = local.trick > 0;
        if (prev.air > 12 && !(local.air > 0)) {
          Sfx.land?.(Math.min(1, prev.air / 90));
          if (local.boost > 0 && prev.trickBoost) hud.callout('TRICK BOOST!', { kind: 'small gold', hold: 800 });
        }
        prev.trickBoost = !!local.tricked;
        prev.air = local.air || 0;
      }
      if (local && myRow && latest?.phase === 'racing' && !(myRow[9] & F.dead)) {
        Sfx.engine(Math.abs(local.speed) / K.PHYS.maxSpeed, !!(myRow[9] & (F.boost | F.star)), !!(myRow[9] & F.drift), local.falling ? 0 : local.surface);
      } else {
        Sfx.engineStop();
      }

      const wrecked = !!(myRow && myRow[9] & F.dead);
      if (wrecked && !death) death = { at: now, by: -1, kind: null, watching: -1 };
      if (!wrecked && wasWrecked) death = null;
      wasWrecked = wrecked;
      const view = interpolated();
      const karts = view ? view.karts : [];
      const me = karts.find((k) => k.idx === myIdx);
      if (local && me && !(me.flags & F.dead) && !(me.fx & 1)) {
        me.x = local.x; me.y = local.y; me.angle = local.angle; me.speed = local.speed;
        me.air = local.air || 0;
        me.fx = (me.fx & ~2) | (local.trick > 0 ? 2 : 0);
      }

      // Camera follows me; while I'm wrecked it follows whoever smashed me (or circles the wreck);
      // spectators follow the leader. It snaps whenever it switches target, except between leaders:
      // a new leader takes over after holding P1 for 1.5 s, and the camera glides over unless
      // they're far away.
      let focusKart = me && !(me.flags & F.dead) ? me : null;
      let mode = focusKart ? 'me' : '';
      if (!focusKart && me && myRow) {
        const killer = death && death.by >= 0 ? karts.find((k) => k.idx === death.by && !(k.flags & F.dead)) : null;
        if (killer) { focusKart = killer; mode = `killer${killer.idx}`; }
        else {
          if (camMode !== 'orbit') orbitAngle = myRow[3] / 1000;
          orbitAngle += dt * 0.6;
          mode = 'orbit';
        }
        if (death) death.watching = killer ? killer.idx : -1;
      } else if (!me && latest) {
        const alive = (idx) => karts.find((k) => k.idx === idx && !(k.flags & 32));
        const lead = [...latest.k].sort((a, b) => a[6] - b[6]).find((r) => !(r[9] & 32))?.[0] ?? -1;
        let watched = alive(spec.idx);
        if (!watched) {
          if (spec.idx >= 0) snapCamera = true; // the one we watched was smashed
          spec.idx = lead;
          watched = alive(lead);
        } else if (lead !== spec.idx && lead >= 0) {
          if (spec.next !== lead) { spec.next = lead; spec.since = now; }
          const next = alive(lead);
          if (next && now - spec.since > 1500) {
            if (Math.hypot(next.x - watched.x, next.y - watched.y) > 600) snapCamera = true;
            spec.idx = lead;
            watched = next;
          }
        } else {
          spec.next = -1;
        }
        focusKart = watched || null;
        if (focusKart) mode = 'leader';
      }
      if (mode !== camMode) { camMode = mode; snapCamera = true; }
      if (view3d && view) {
        const grid = latest?.phase === 'countdown';
        view3d.update({
          ...view,
          karts,
          myIdx,
          countdown: grid,
          focus: focusKart ? {
            idx: focusKart.idx, x: focusKart.x, y: focusKart.y, angle: focusKart.angle, air: focusKart.air || 0, grid,
            spinning: !!(focusKart.flags & F.spin) || !!(focusKart.fx & 1), boost: !!(focusKart.flags & F.boost), star: !!(focusKart.flags & F.star), snap: snapCamera,
          } : mode === 'orbit' ? { idx: -1, x: myRow[1], y: myRow[2], angle: orbitAngle, snap: snapCamera } : null,
        }, dt, now);
        if (mode) snapCamera = false;
      }
      updateHud(now, karts);
    }
    raf = requestAnimationFrame(frame);

    const ITEM_SOUND = { rocket: 'rocket', triple: 'rocket', bomb: 'rocket', banana: 'banana', mine: 'banana', shield: 'shield', ghost: 'shield', bouncer: 'bouncer', ink: 'ink' };
    const QUIET_HITS = ['mine', 'bomb', 'shock', 'lava', 'comet', 'thunder']; // their own blast effect covers it
    const nameOf = (idx) => api.escapeHtml(kartsByIdx.get(idx)?.name || 'Someone');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    return {
      onSnapshot(snap) { onInit(snap.init); },
      onEvent(event, data) {
        if (event === 'game:kart:init') onInit(data);
        else if (event === 'game:kart:state') onState(data);
        else if (event === 'game:kart:use') {
          if (data.idx === myIdx && ITEM_SOUND[data.item]) Sfx[ITEM_SOUND[data.item]]?.();
          if (data.idx === myIdx && data.item === 'minigun') Sfx.minigun?.();
          if (data.item === 'comet') Sfx.comet?.();
          view3d?.itemUsed?.(data.idx, data.item);
        } else if (event === 'game:kart:boom') {
          view3d?.explode(data.x, data.y, data.kind, data.r);
          const v = volumeAt(data.x, data.y);
          if (data.kind === 'bouncer') Sfx.bump(v * 0.5);
          else Sfx.explosion(v * (data.kind === 'rocket' ? 0.5 : 1));
          if (data.kind === 'comet') Sfx.thunder?.(v * 0.6);
        } else if (event === 'game:kart:shock') {
          view3d?.shock(data.x, data.y, data.r);
          Sfx.shock?.(volumeAt(data.x, data.y));
        } else if (event === 'game:kart:thunder') {
          // Bolts on every victim; everyone's screen flashes.
          const pos = (idx) => latest?.k.find((r) => r[0] === idx);
          view3d?.thunder(data.hit.map(pos).filter(Boolean).map((r) => [r[1], r[2]]));
          flash();
          Sfx.thunder?.(1);
          if (data.hit.includes(myIdx)) hud.callout('THUNDERSTRUCK', { kind: 'small', hold: 900, sub: `by ${nameOf(data.idx)}` });
          else if (data.idx === myIdx && data.hit.length) hud.callout('THUNDER!', { kind: 'small gold', hold: 900, sub: `Struck ${plural(data.hit.length, 'rival')}` });        } else if (event === 'game:kart:ink') {
          if (data.idx === myIdx) hud.callout(data.hit.length ? 'SPLAT!' : 'NOBODY TO INK', { kind: 'small', hold: 800, sub: data.hit.length ? `Inked ${plural(data.hit.length, 'rival')}` : '' });
          if (map?.type === 'race') for (const idx of data.hit.slice(0, 2)) hud.smash({ by: data.idx, target: idx, kind: 'ink' });
          view3d?.inkBurst?.(data.idx, data.hit);
        } else if (event === 'game:kart:block') {
          const k = latest?.k.find((r) => r[0] === data.idx);
          if (k) view3d?.block(k[1], k[2], data.kind);
          if (data.idx === myIdx) {
            Sfx.block?.();
            hud.callout('BLOCKED', { kind: 'small', hold: 700, sub: data.kind === 'trail' ? 'Your item took the hit' : '' });
          }
        } else if (event === 'game:kart:hit') {
          const kind = data.kill ? 'kill' : data.kind === 'bullet' ? 'bullet' : 'hit';
          const victim = kartsByIdx.get(data.target);
          if (!QUIET_HITS.includes(data.kind) || data.kill) view3d?.explode(data.x, data.y, kind, data.kill ? 90 : 50, colorOf(victim));
          if (data.kind !== 'bullet' && data.kind !== 'thunder') Sfx.explosion(volumeAt(data.x, data.y) * (data.kill ? 1 : 0.4));
          if (data.kill || (map?.type === 'race' && data.kind !== 'bullet' && data.by >= 0)) hud.smash(data);
          if (data.kill) deathMarks.push({ x: data.x, y: data.y, color: colorOf(victim), t: performance.now() });
          if (data.target === myIdx) {
            if (data.kill) death = { at: performance.now(), by: data.by, kind: data.kind, watching: -1 };
            if (data.kind !== 'bullet') Sfx.hit();
            if (!data.kill && data.kind === 'comet') hud.callout('COMET HIT!', { kind: 'small', hold: 800 });
          } else if (data.by === myIdx) {
            // Hit marker: every rocket/banana/blast, every third minigun bullet.
            if (data.kind === 'bullet' && !data.kill && ++bulletHits % 3) return;
            hud.hitMarker(data.kill);
            if (data.kill) {
              Sfx.kill();
              const streak = hud.streakName(data.streak);
              if (streak) { hud.callout(streak, { kind: 'gold', hold: 1100 }); Sfx.streak(); }
              else hud.callout(`SMASHED ${victim?.name || ''}`.trim(), { kind: 'small', hold: 800 });
            } else {
              Sfx.hitConfirm?.();
            }
          }
        } else if (event === 'game:kart:fall') {
          const v = data.idx === myIdx ? 1 : volumeAt(data.x, data.y) * 0.6;
          if (data.kind === 'water') Sfx.splash?.(v);
          else if (data.kind === 'lava') Sfx.sizzle?.(v);
          else Sfx.fall?.(v);
          hud.fall(data.idx, data.kind);
          if (data.idx === myIdx) {
            const [title, sub] = data.kind === 'water' ? ['SPLASH!', 'Fishing you out…'] : data.kind === 'lava' ? ['TOO HOT!', 'Fishing you out…'] : ['MISSED THE JUMP', 'Back on the road…'];
            hud.callout(title, { kind: 'small', hold: 1000, sub });
          }
        } else if (event === 'game:kart:finish' && data.idx === myIdx) {
          finishTime = data.time;
        }
      },
      unmount() {
        cancelAnimationFrame(raf);
        mmResize.disconnect();
        clearTimeout(rotateTip);
        Sfx.engineStop();
        Sfx.starStop?.();
        clearInterval(resend);
        clearInterval(pinger);
        view3d?.dispose();
        window.removeEventListener('kart3d-ready', onReady);
        window.removeEventListener('keydown', kd);
        window.removeEventListener('keyup', ku);
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  },
};
