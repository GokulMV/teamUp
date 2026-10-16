/* global KartCore, KartHud, KartMinimap, ItemIcons */
window.Games = window.Games || {};

// Kart Battle client: networking, input, prediction and HUD.
// The 3D world is drawn by Kart3D (js/games/kart3d.js).
window.Games.kart = {
  mount(el, api) {
    const K = KartCore;
    const Sfx = window.Sfx;
    // Indexed by item code (K.ITEMS index + 1).
    const ITEM_ICONS = ['', '⚡', '🚀', '🍌', '🛡️', '🚀', '🧨', '🔫', '💣', '🌩️', '👻'];
    const ITEM_NAMES = ['', 'Boost', 'Homing rocket', 'Banana', 'Shield', 'Triple rockets', 'Mine', 'Minigun', 'Bomb', 'Shock wave', 'Ghost'];
    const INTERP_DELAY = 110; // ms behind the server for smooth remote karts
    const touch = matchMedia('(pointer: coarse)').matches;
    const I = KartHud.ICONS;
    const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" class="tc-ic" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

    el.innerHTML = `
      <div class="game-wrap">
        <div class="stage kart-stage" data-stage>
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
            <div class="kart-item empty" data-item><span data-item-icon></span><small data-item-ammo></small><kbd class="kart-key">Space</kbd></div>
          </div>
          <div class="kart-item-name" data-item-name></div>
          <div class="kart-intro kart-panel" data-intro></div>
          <div class="kart-board kart-panel" data-board></div>
          <div class="kart-feed" data-feed></div>
          <div class="kart-callout" data-callout></div>
          <div class="kart-speedlines" data-speedlines></div>
          <div class="kart-vignette" data-vignette></div>
          <div class="kart-hit" data-hit><svg viewBox="0 0 28 28"><path d="M4 4l7 7M24 4l-7 7M4 24l7-7M24 24l-7-7"/></svg></div>
          <div class="kart-dead kart-panel" data-dead></div>
          <canvas class="kart-minimap" data-minimap></canvas>
          <div class="kart-help kart-panel" data-help>${touch ? '<b>Tap any button to start</b>Your kart accelerates by itself' : '<kbd>WASD</kbd> drive <kbd>Shift</kbd> drift <span class="kh-item"><kbd>Space</kbd> use item</span>'}</div>
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
    const prev = { item: 0, boost: false, drift: 0, count: null, finished: false };
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
        if (k === 'use') { if (v) useItem(); } else input[k] = v;
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
      stage.classList.toggle('mode-arena', map.type === 'arena');
      stage.classList.toggle('mode-race', map.type !== 'arena');
      stage.classList.toggle('no-items', data.items === false);
      stage.classList.toggle('spectating', myIdx < 0);
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
      const [, x, y, a1000, speed, , , , , flags] = row;
      const angle = a1000 / 1000;
      if (!local || flags & 32) {
        local = { x, y, angle, heading: angle, speed, boost: 0, spin: 0, trackIndex: null, dead: !!(flags & 32) };
        return;
      }
      if (local.dead) { local.dead = false; Object.assign(local, { x, y, angle, heading: angle, speed }); snapCamera = true; return; }
      // Server state is ~half an RTT old; project it forward before comparing.
      const lead = Math.min(0.25, rtt / 2000);
      const sx = x + Math.cos(angle) * speed * lead;
      const sy = y + Math.sin(angle) * speed * lead;
      const ex = sx - local.x;
      const ey = sy - local.y;
      const err = Math.hypot(ex, ey);
      const spinning = flags & 1;
      if (spinning) local.spin = Math.max(local.spin, 0.15);
      if (flags & 2) local.boost = Math.max(local.boost, 0.15);
      if (err > 140 || spinning || s.phase !== 'racing') {
        Object.assign(local, { x: sx, y: sy, angle, heading: angle, speed });
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
        };
      });
      const prevS = new Map((a.data.s || []).map((r) => [r[0], r]));
      const shots = (b.data.s || []).map((r) => {
        const p = prevS.get(r[0]);
        if (!p) return [r[0], r[1], r[2], r[3], r[4] / 1000, r[5]];
        return [r[0], r[1], p[2] + (r[2] - p[2]) * f, p[3] + (r[3] - p[3]) * f, r[4] / 1000, p[5] + (r[5] - p[5]) * f];
      });
      return { karts, shots, mines: b.data.m || [], bananas: b.data.b || [], boxes: b.data.x };
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
        karts: karts.map((k) => ({ x: k.x, y: k.y, angle: k.angle, color: colorOf(kartsByIdx.get(k.idx)), me: k.idx === myIdx, dead: !!(k.flags & 32), place: placeOf.get(k.idx) })),
        boxes: latest?.x,
        deaths: deathMarks.map((d) => ({ x: d.x, y: d.y, color: d.color, age: (now - d.t) / 1000 })),
        time: now / 1000,
      });
    }

    function updateHud(now, karts) {
      if (!latest || !info) return;
      const row = latest.k.find((r) => r[0] === myIdx);
      hud.update(now, latest, row, { finishTime, death });
      if (row) {
        const [, , , , , , , item, ammo, flags] = row;
        if (item && !prev.item) Sfx.pickup();
        prev.item = item;
        const boosting = !!(flags & 2);
        const driftLvl = flags & 256 ? 2 : flags & 128 ? 1 : 0;
        if (boosting && !prev.boost) (prev.drift > 0 && !(flags & 64) ? Sfx.miniTurbo(prev.drift) : Sfx.boost());
        prev.boost = boosting;
        prev.drift = flags & 64 ? driftLvl : 0;
        if (flags & 8 && !prev.finished) Sfx.finish();
        prev.finished = !!(flags & 8);
        q('[data-speedlines]').classList.toggle('on', boosting);
        q('[data-item-icon]').textContent = item ? ITEM_ICONS[item] : '';
        q('[data-item-ammo]').textContent = ammo > 1 ? `x${ammo}` : '';
        q('[data-item]').classList.toggle('empty', !item);
        q('[data-item-name]').textContent = item ? `${ITEM_NAMES[item]} · Space` : '';
        if (touch && prev.fire !== item) {
          // The touch fire button shows what you're holding.
          prev.fire = item;
          const id = item ? K.ITEMS[item - 1] : null;
          q('[data-fire-icon]').innerHTML = id && ItemIcons.ids.includes(id) ? ItemIcons.svg(id) : '';
          q('.tc-fire').classList.toggle('armed', !!item);
        }
      } else {
        q('[data-item]').style.display = 'none';
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

      // Predict my kart locally so steering feels instant.
      const myRow = latest?.k.find((r) => r[0] === myIdx);
      if (local && !local.dead && latest?.phase === 'racing') {
        K.stepKart(local, input, dt, map, { speed: info.speedMul || 1 });
      }
      if (local && myRow && latest?.phase === 'racing' && !(myRow[9] & 32)) {
        Sfx.engine(Math.abs(local.speed) / K.PHYS.maxSpeed, !!(myRow[9] & 2), !!(myRow[9] & 64), local.surface);
      } else {
        Sfx.engineStop();
      }

      const wrecked = !!(myRow && myRow[9] & 32);
      if (wrecked && !death) death = { at: now, by: -1, kind: null, watching: -1 };
      if (!wrecked && wasWrecked) death = null;
      wasWrecked = wrecked;
      const view = interpolated();
      const karts = view ? view.karts : [];
      const me = karts.find((k) => k.idx === myIdx);
      if (local && me && !(me.flags & 32)) {
        me.x = local.x; me.y = local.y; me.angle = local.angle; me.speed = local.speed;
      }

      // Camera follows me; while I'm wrecked it follows whoever smashed me (or circles the wreck);
      // spectators follow the leader. It snaps whenever it switches target, except between leaders:
      // a new leader takes over after holding P1 for 1.5 s, and the camera glides over unless
      // they're far away.
      let focusKart = me && !(me.flags & 32) ? me : null;
      let mode = focusKart ? 'me' : '';
      if (!focusKart && me && myRow) {
        const killer = death && death.by >= 0 ? karts.find((k) => k.idx === death.by && !(k.flags & 32)) : null;
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
          countdown: grid,
          focus: focusKart ? {
            idx: focusKart.idx, x: focusKart.x, y: focusKart.y, angle: focusKart.angle, grid,
            spinning: !!(focusKart.flags & 1), boost: !!(focusKart.flags & 2), snap: snapCamera,
          } : mode === 'orbit' ? { idx: -1, x: myRow[1], y: myRow[2], angle: orbitAngle, snap: snapCamera } : null,
        }, dt, now);
        if (mode) snapCamera = false;
      }
      updateHud(now, karts);
    }
    raf = requestAnimationFrame(frame);

    const ITEM_SOUND = { rocket: 'rocket', triple: 'rocket', bomb: 'rocket', banana: 'banana', mine: 'banana', shield: 'shield', ghost: 'shield' };

    return {
      onSnapshot(snap) { onInit(snap.init); },
      onEvent(event, data) {
        if (event === 'game:kart:init') onInit(data);
        else if (event === 'game:kart:state') onState(data);
        else if (event === 'game:kart:use') {
          if (data.idx === myIdx && ITEM_SOUND[data.item]) Sfx[ITEM_SOUND[data.item]]();
          if (data.idx === myIdx && data.item === 'minigun') Sfx.minigun?.();
        } else if (event === 'game:kart:boom') {
          view3d?.explode(data.x, data.y, data.kind, data.r);
          Sfx.explosion(volumeAt(data.x, data.y) * (data.kind === 'rocket' ? 0.5 : 1));
        } else if (event === 'game:kart:shock') {
          view3d?.shock(data.x, data.y, data.r);
          Sfx.shock?.(volumeAt(data.x, data.y));
        } else if (event === 'game:kart:block') {
          const k = latest?.k.find((r) => r[0] === data.idx);
          if (k) view3d?.block(k[1], k[2]);
          if (data.idx === myIdx) hud.callout('BLOCKED', { kind: 'small', hold: 700 });
        } else if (event === 'game:kart:hit') {
          const kind = data.kill ? 'kill' : data.kind === 'bullet' ? 'bullet' : 'hit';
          const victim = kartsByIdx.get(data.target);
          if (!['mine', 'bomb', 'shock', 'lava'].includes(data.kind) || data.kill) view3d?.explode(data.x, data.y, kind, data.kill ? 90 : 50, colorOf(victim));
          if (data.kind !== 'bullet') Sfx.explosion(volumeAt(data.x, data.y) * (data.kill ? 1 : 0.4));
          if (data.kill || (map?.type === 'race' && data.kind !== 'bullet' && data.by >= 0)) hud.smash(data);
          if (data.kill) deathMarks.push({ x: data.x, y: data.y, color: colorOf(victim), t: performance.now() });
          if (data.target === myIdx) {
            if (data.kill) death = { at: performance.now(), by: data.by, kind: data.kind, watching: -1 };
            if (data.kind !== 'bullet') Sfx.hit();
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
        } else if (event === 'game:kart:finish' && data.idx === myIdx) {
          finishTime = data.time;
        }
      },
      unmount() {
        cancelAnimationFrame(raf);
        mmResize.disconnect();
        clearTimeout(rotateTip);
        Sfx.engineStop();
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
