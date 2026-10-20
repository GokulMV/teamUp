/* global KartCore, KartHud, KartMinimap */
window.Games = window.Games || {};

// Kart Battle client: networking, input, prediction and HUD.
// The 3D world is drawn by Kart3D (js/games/kart3d.js).
window.Games.kart = {
  mount(el, api) {
    const K = KartCore;
    const Sfx = window.Sfx;
    const Icons = window.ItemIcons;
    const SNAP_MS = 1000 / 15; // the server sends a snapshot every other 30 Hz tick
    const touch = matchMedia('(pointer: coarse)').matches;
    // Snapshot flag bits (see broadcast() in server/games/kart.js).
    const F = { spin: 1, boost: 2, shield: 4, finished: 8, invuln: 16, dead: 32, drift: 64, ghost: 1024, gun: 2048, star: 4096, shrunk: 8192, inked: 16384, frozen: 32768, spikes: 65536 };
    // Snapshot kart row: [idx, x, y, angle*1000, speed, lap, place, item, ammo, flags, kills, deaths, hp, air, fx, roulette,
    //   item2, ammo2, roulette2 (the reserve slot), sticky (tenths of a second on a sticky bomb's fuse)]
    const I = KartHud.ICONS;
    const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" class="tc-ic" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
    const STEP = 1 / 30; // prediction runs at the server's tick, so both agree on every jump and landing

    el.innerHTML = `
      <div class="game-wrap">
        <div class="stage kart-stage" data-stage>
          <div class="kart-loader" data-loader>
            <div class="kl-art" data-loader-art></div>
            <div class="kl-body">
              <span class="kl-kicker" data-loader-mode></span>
              <h2 class="kl-name" data-loader-name></h2>
              <div class="kl-bar"><i data-loader-bar></i></div>
              <span class="kl-step" data-loader-step></span>
              <p class="kl-tip" data-loader-tip></p>
            </div>
          </div>
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
              <div class="kart-reserve empty" data-reserve title="Reserve item (Q to swap)">
                <div class="kart-reserve-icon" data-reserve-icon></div><b data-reserve-ammo></b><kbd class="kart-rkey">Q</kbd>
              </div>
            </div>
            <div class="kart-top-sub">
              <div class="kart-item-name kart-panel" data-item-name></div>
              <div class="kart-warn hidden" data-warn>${Icons.svg('comet', 'item-icon')}<span>Comet incoming!</span></div>
              <div class="kart-warn sticky hidden" data-sticky>${Icons.svg('sticky', 'item-icon')}<span>Sticky bomb! Bump someone <b data-sticky-t></b></span></div>
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
          <div class="kart-help kart-panel" data-help>${touch ? '<b>Tap any button to start</b>Your kart accelerates by itself' : '<kbd>WASD</kbd> drive <kbd>Shift</kbd> hop/drift <span class="kh-item"><kbd>Space</kbd> use item (hold to aim bombs) <kbd>Q</kbd> swap <kbd>S</kbd>+<kbd>Space</kbd> throw back</span>'}</div>
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
              <button class="tc-swap empty" data-key="swap" aria-label="Swap to the reserve item"><span data-swap-icon></span><i class="tc-swap-badge">${svg('<path d="M6 9h12l-4-4M18 15H6l4 4"/>', 'stroke-width="3"')}</i></button>
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
    let clockOffset = null; // localNow - serverT for the fastest snapshot of the last few seconds
    // Everyone else's kart is drawn a little in the past, so there is always a newer snapshot to
    // glide toward. How far back adapts to the connection: the spread of arrival times over the
    // last few seconds (Wi-Fi and phone networks bunch packets up), widening at once when packets
    // come late and narrowing slowly. The drawn time runs up to 10% fast or slow to get there
    // rather than jumping, and past the newest snapshot karts carry on for a moment instead of
    // freezing.
    const clock = { hist: [], delay: 110, drawT: null, at: 0 };
    let latest = null;
    let myIdx = -1;
    // My own kart runs here first, in the server's 30 Hz steps, so it answers the keys at once.
    // Every input says which of my steps it starts at; the server uses it at the matching tick
    // (see onInput in server/games/kart.js) and sends my kart back in full after each of my steps,
    // and this screen replays its newer inputs from there. So the two agree all the time, and
    // when something only the server knows about moves my kart (a bump, a hit), it glides over.
    let local = null; // predicted state of my kart
    // My steps count real time from here, 30 a second, whatever my kart is doing (and however
    // late the frames are): the server times my inputs by them.
    const clock0 = performance.now();
    const stepClock = (t) => (t - clock0) / 1000 / STEP;
    let stepNo = 0; // the last step run
    let stepAcc = 0; // how far into the next step this frame is (seconds, under one STEP)
    let predPrev = null; // my kart one STEP ago, to draw it smoothly between steps
    const inputLog = [{ c: 0, input: { up: false, down: false, left: false, right: false, drift: false } }]; // input changes: { c: the step it starts at, input }
    let ack = null; // the server's latest word on my kart: { L: my step, t: game time, s: kart, f }
    let pendingAck = null;
    const fix = { x: 0, y: 0, a: 0, z: 0 }; // corrections still gliding away
    const netStats = { acks: 0, replays: 0, snaps: 0, err: 0, maxErr: 0 };
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
    const bulletDmg = new Map(); // target idx -> minigun damage not shown yet
    const deathMarks = []; // arena minimap: where karts were just smashed

    // ---------- Loading screen ----------
    // Shown from the start of a round until the 3D world has drawn its first frame: the map's
    // picture and name, what's happening (the 3D engine loading, then the world being built) and
    // a tip or two.
    const loader = q('[data-loader]');
    const TIPS = touch ? [
      'Hold Drift through a corner, then let go for a mini-turbo.',
      'Tap Drift to hop: it clears banana peels and lava edges.',
      'The big button fires your item; the small one swaps in your spare.',
      'Hold fire with a bomb to aim how far it flies.',
      'Ram karts from behind at full speed to knock them flying.',
    ] : [
      'Hold Shift or X through a corner, then let go for a mini-turbo.',
      'Tap Shift to hop: it clears banana peels and lava edges.',
      'Space fires your item, Q swaps in the one in reserve.',
      'Hold Space with a bomb to aim how far it flies.',
      'Ram karts from behind at full speed to knock them flying.',
    ];
    let loaderTip = 0;
    let loaderTimer = 0;
    let loaderShown = false;
    function loaderStep(text, pct) {
      q('[data-loader-step]').textContent = text;
      q('[data-loader-bar]').style.width = `${pct}%`;
    }
    function showLoader(data) {
      const entry = (api.room()?.kartMaps || []).find((m) => m.id === data.mapId);
      const name = entry?.name || K.mapInfo?.(data.mapId)?.name || 'Kart Battle';
      const arena = data.map === 'arena';
      q('[data-loader-mode]').textContent = arena ? 'Battle arena' : `Race${data.laps ? ` · ${data.laps} laps` : ''}${data.reverse ? ' · reversed' : ''}`;
      q('[data-loader-name]').textContent = name;
      q('[data-loader-art]').style.setProperty('--art', `url("/img/maps/${encodeURIComponent(data.mapId)}.jpg")`);
      loaderTip = Math.floor(Math.random() * TIPS.length);
      q('[data-loader-tip]').textContent = TIPS[loaderTip];
      clearInterval(loaderTimer);
      loaderTimer = setInterval(() => { q('[data-loader-tip]').textContent = TIPS[(loaderTip = (loaderTip + 1) % TIPS.length)]; }, 3500);
      loader.classList.remove('done');
      loaderShown = true;
      loaderStep(window.Kart3D ? `Building ${name}` : 'Loading the 3D engine', window.Kart3D ? 55 : 20);
    }
    function hideLoader() {
      if (!loaderShown) return;
      loaderShown = false;
      loaderStep('Ready', 100);
      clearInterval(loaderTimer);
      setTimeout(() => loader.classList.add('done'), 150);
    }

    // ---------- 3D renderer (ES module, may finish loading after mount) ----------
    let building = false;
    function createRenderer() {
      if (!info || view3d || !window.Kart3D || building) return;
      // Building the world holds up the page for a moment: say so on the loading screen first,
      // and give it two frames to show before starting.
      if (loaderShown) {
        building = true;
        loaderStep(`Building ${q('[data-loader-name]').textContent}`, 60);
        requestAnimationFrame(() => requestAnimationFrame(() => { building = false; buildRenderer(); }));
        return;
      }
      buildRenderer();
    }
    function buildRenderer() {
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
        hideLoader();
      }
    }
    const onReady = () => createRenderer();
    window.addEventListener('kart3d-ready', onReady);
    // For automated checks: what this screen is showing.
    window.__kartStats = { get view3d() { return view3d; }, get local() { return local; }, net: netStats, fix, get stepNo() { return stepNo; } };

    // ---------- Input ----------
    const keyMap = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
      ShiftLeft: 'drift', ShiftRight: 'drift', KeyX: 'drift', ControlLeft: 'drift',
    };
    // c: the step the input starts at; n: the step it is now (the server times its inputs by it).
    function sendInput(change = true) {
      const last = inputLog[inputLog.length - 1];
      const n = Math.floor(stepClock(performance.now()));
      if (change && Object.keys(input).some((k) => input[k] !== last.input[k])) {
        const c = Math.max(n, stepNo) + 1;
        if (last.c === c) last.input = { ...input };
        else inputLog.push({ c, input: { ...input } });
        while (inputLog.length > 2 && inputLog[1].c <= stepNo - 150) inputLog.shift();
      }
      const cur = inputLog[inputLog.length - 1];
      api.socket.emit('game:input', { ...cur.input, c: cur.c, n });
    }
    // The input in force at step j.
    function inputAt(j) {
      for (let i = inputLog.length - 1; i > 0; i--) if (inputLog[i].c <= j) return inputLog[i].input;
      return inputLog[0].input;
    }
    // The game time the server runs my step j at (moving obstacles are where they'll be then).
    const tAt = (j) => ack.t + (j - ack.L) * STEP;
    function useItem() { if (!local?.falling) api.socket.emit('game:use'); }
    // Bombs are aimed: hold fire and the landing ring sweeps out to far, back to near and out again;
    // let go to throw. A quick tap throws it at the middle distance, like any other item.
    const aim = { on: false, start: 0 };
    const bombReady = () => slotState.mode === 'ready' && itemId(slotState.code) === 'bomb';
    const aimPower = (now) => 0.5 + 0.5 * Math.sin((2 * Math.PI * (now - aim.start)) / 2400);
    function pressFire() {
      if (bombReady()) { aim.on = true; aim.start = performance.now(); } else useItem();
    }
    function releaseFire(cancel) {
      if (!aim.on) return;
      aim.on = false;
      view3d?.setAim?.(null);
      if (!cancel && bombReady() && !local?.falling) api.socket.emit('game:use', { power: Math.round(aimPower(performance.now()) * 100) / 100 });
    }
    // Two items at most: the one Space fires and one in reserve, which Q (or the touch bubble) swaps in.
    function swapItems() { if (reserve.code && !local?.falling) api.socket.emit('game:swap'); }
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    function onKey(e, down) {
      // Key releases still count while typing in chat, or a held key would stay down for good.
      if (typing(e) && (down || !keyMap[e.code])) return;
      if (e.code === 'Space' || e.code === 'KeyE') {
        if (down && !e.repeat) pressFire();
        else if (!down) releaseFire(false);
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyQ') {
        if (down && !e.repeat) swapItems();
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
      releaseFire(true);
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
        if (k === 'use') {
          if (v && slotState.mode === 'ready') pressFire();
          else if (!v) releaseFire(e.type === 'pointercancel');
        } else if (k === 'swap') { if (v) swapItems(); } else input[k] = v;
        input.up = autoGas && !input.down;
        sendInput();
      };
      b.addEventListener('pointerdown', (e) => {
        // The fire button keeps the finger while a bomb is aimed, even if it slides off the button.
        if (k === 'use') b.setPointerCapture?.(e.pointerId);
        set(true)(e);
      });
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
    const resend = setInterval(() => sendInput(false), 500);
    const pinger = setInterval(() => {
      const t0 = performance.now();
      api.emit('game:ping').then(() => { rtt = rtt * 0.7 + (performance.now() - t0) * 0.3; });
    }, 2000);

    // ---------- Network ----------
    function onInit(data) {
      // A map this page doesn't know (or knows as another kind) means the page is older than the
      // server: reload instead of driving round some other map against the server's.
      const known = K.mapInfo(data.mapId);
      if ((!known || known.type !== data.map) && window.TeamUpStale?.()) return;
      const sameRound = info && info.round === data.round && info.mapId === data.mapId && !!info.reverse === !!data.reverse && info.items === data.items && info.karts.length === data.karts.length;
      // A new round's clock starts again at 0: forget the last one's snapshots and timing.
      if (!sameRound) {
        snapshots.length = 0; latest = null; clockOffset = null; Object.assign(clock, { hist: [], delay: 110, drawT: null });
        ack = null; pendingAck = null;
      }
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
      if (!view3d) showLoader(data);
      minimap = null;
      createRenderer();
      q('[data-timer]').classList.toggle('hidden', map.type !== 'arena');
      slot.style.display = myIdx < 0 ? 'none' : '';
      stage.classList.toggle('spectating', myIdx < 0);
      stage.classList.toggle('mode-arena', map.type === 'arena');
      stage.classList.toggle('mode-race', map.type !== 'arena');
      stage.classList.toggle('no-items', data.items === false);
      hud.setRound(data, map, myIdx);
      Object.assign(fix, { x: 0, y: 0, a: 0, z: 0 });
      if (myIdx >= 0) sendInput(false);
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
      const want = Math.max(90, Math.min(320, SNAP_MS + late[Math.floor((late.length - 1) * 0.9)] + 20));
      clock.delay += (want - clock.delay) * (want > clock.delay ? 0.5 : 0.03);
      snapshots.push({ t: s.t, data: s });
      while (snapshots.length > 30) snapshots.shift();
      latest = s;
      // A fresh roulette shows as the time left going back up. Checked per snapshot, not per frame,
      // so a slow frame rate can't miss a short roulette for the same item as before.
      const row = s.k.find((r) => r[0] === myIdx);
      const cs = (row && row[15]) || 0; // 15: roulette time left
      if (cs > slotState.cs) slotState.again = true;
      slotState.cs = cs;
      const cs2 = (row && row[18]) || 0; // 18: the reserve slot's roulette
      if (cs2 > reserve.cs) reserve.again = true;
      reserve.cs = cs2;
    }

    // The server's word on my kart (the newest one is used once per frame, see frame()): its kart
    // after my step a.L. `upTo`: the step this frame runs to; `skipped`: steps went unrun.
    function reconcile(a, upTo, skipped) {
      ack = a;
      netStats.acks++;
      // Frames behind my clock (a slow one): the server's kart is where my steps carry on from.
      if (a.L > stepNo) {
        if (a.L <= upTo) stepNo = a.L;
        skipped = true;
      }
      const server = K.unpackKart(a.s);
      if (a.f & 2) { local = Object.assign(server, { dead: true }); predPrev = null; return; }
      // Falls into water/lava/gaps are the server's call: hold on its kart until it's fished out.
      if (a.f & 4) { local = Object.assign(server, { falling: true, speed: 0 }); predPrev = null; return; }
      const was = local;
      predPrev = null;
      // Replay my inputs since that step on top of it, from the start of the race on (not after a
      // long stall: the server's kart as it is).
      if (!(a.f & 8) && a.L <= stepNo && stepNo - a.L <= 90) {
        netStats.replays++;
        for (let j = Math.max(a.L + 1, a.g); j <= stepNo; j++) {
          if (j === stepNo) predPrev = { x: server.x, y: server.y, angle: server.angle, air: server.air || 0, z: server.z };
          K.stepNet(server, inputAt(j), STEP, map, { speed: info.speedMul || 1, noFall: true, t: tAt(j) });
        }
      }
      server.padded = 0; server.bumper = 0; server.whacked = 0; // their sounds played when they happened
      local = server;
      if (!was || was.dead || was.falling || skipped) {
        if (was && !skipped) snapCamera = true; // back on the road
        Object.assign(fix, { x: 0, y: 0, a: 0, z: 0 });
        return;
      }
      // Glide over the difference from what this screen showed (a jump across the map: no glide).
      let da = was.angle - local.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const dx = was.x - local.x;
      const dy = was.y - local.y;
      const err = Math.hypot(dx, dy);
      // (For automated checks: every correction, when a probe asks for them.)
      window.__kartNetLog?.push([a.L, stepNo, Math.round(dx * 10) / 10, Math.round(dy * 10) / 10, Math.round(da * 1000) / 1000, Math.round(performance.now())]);
      netStats.err += err;
      netStats.maxErr = Math.max(netStats.maxErr, err);
      if (err > 160 || Math.abs(da) > 1.2) {
        netStats.snaps++;
        Object.assign(fix, { x: 0, y: 0, a: 0, z: 0 });
        return;
      }
      fix.x += dx;
      fix.y += dy;
      fix.a += da;
      if (Number.isFinite(was.z) && Number.isFinite(local.z)) fix.z += was.z - local.z;
    }

    // Interpolated positions for rendering.
    function interpolated() {
      if (!snapshots.length || clockOffset === null) return null;
      const now = performance.now();
      const goal = now - clockOffset - clock.delay;
      if (clock.drawT === null || Math.abs(goal - clock.drawT) > 400) clock.drawT = goal;
      else clock.drawT += (now - clock.at) * Math.max(0.9, Math.min(1.1, 1 + (goal - clock.drawT) / 600));
      clock.at = now;
      const target = clock.drawT;
      let a = snapshots[0];
      let b = snapshots[snapshots.length - 1];
      for (let i = 0; i < snapshots.length - 1; i++) {
        if (snapshots[i].t <= target && snapshots[i + 1].t >= target) { a = snapshots[i]; b = snapshots[i + 1]; break; }
      }
      if (target >= b.t) a = b;
      const span = b.t - a.t;
      const f = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
      const prevK = new Map(a.data.k.map((r) => [r[0], r]));
      // Past the newest snapshot (a late packet): karts carry on at the velocity of the last two
      // snapshots for up to 0.15 s, rather than stopping dead until the next one turns up.
      const before = target > b.t && snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
      const ahead = before ? Math.min(target - b.t, 150) / 1000 : 0;
      const gap = before ? (b.t - before.t) / 1000 : 0;
      const beforeK = before && gap > 0 ? new Map(before.data.k.map((r) => [r[0], r])) : null;
      const karts = b.data.k.map((r) => {
        const p = prevK.get(r[0]) || r;
        // Don't slide across the map when a kart respawns.
        const jump = Math.hypot(r[1] - p[1], r[2] - p[2]) > 200;
        const ff = jump ? 1 : f;
        let da = (r[3] - p[3]) / 1000;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        let vx = 0;
        let vy = 0;
        const q = beforeK && beforeK.get(r[0]);
        if (q && !(r[9] & F.dead) && !((r[14] || 0) & 1) && Math.hypot(r[1] - q[1], r[2] - q[2]) < 200) {
          vx = (r[1] - q[1]) / gap;
          vy = (r[2] - q[2]) / gap;
        }
        return {
          idx: r[0], x: p[1] + (r[1] - p[1]) * ff + vx * ahead, y: p[2] + (r[2] - p[2]) * ff + vy * ahead,
          angle: p[3] / 1000 + da * ff, speed: r[4], flags: r[9], hp: r[12],
          air: (p[13] || 0) + ((r[13] || 0) - (p[13] || 0)) * ff, fx: r[14] || 0,
          item: r[7], ammo: r[8], roulette: r[15] || 0, sticky: r[19] || 0,
          z: r[20] === undefined ? undefined : p[20] + (r[20] - p[20]) * ff, // layered arenas
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
        const out = [r[0], r[1], p[2] + (r[2] - p[2]) * f, p[3] + (r[3] - p[3]) * f, ang, p[5] + (r[5] - p[5]) * f, ...r.slice(6)];
        // Layered arenas: the height at the end of the row glides too.
        if (map?.layered) out[out.length - 1] = p[p.length - 1] + (r[r.length - 1] - p[p.length - 1]) * f;
        return out;
      });
      // Decoys show red to their owner's team: [id, x, y, owner idx, ours].
      const ours = (idx) => idx === myIdx || (teamMode() && kartsByIdx.get(idx)?.team === kartsByIdx.get(myIdx)?.team);
      const decoys = (b.data.d || []).map((r) => [r[0], r[1], r[2], r[3], ours(r[3]), r[4]]);
      return { karts, shots, mines: b.data.m || [], bananas: b.data.b || [], boxes: b.data.x, stickies: b.data.g || [], decoys };
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
    // mode: empty | rolling | ready; cs: roulette time left in the last snapshot; again: a new roulette started
    const slotState = { code: 0, ammo: -1, mode: 'empty', cs: 0, again: false };
    const roulette = { start: 0, end: 0, cells: 0, last: -1, cell: 60, strip: [] };
    let nameTimer = 0;

    // Each copy gets its own SVG: an icon's gradient ids are unique per call, and a copy whose ids
    // resolve into a hidden twin paints without its gradients.
    const iconHtml = (id) => (id ? Icons.svg(id, 'item-icon') : '');
    function showIcon(code) {
      iconBox.innerHTML = iconHtml(code && itemId(code));
      fireIcon.innerHTML = iconHtml(code && itemId(code));
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
      // A new roulette starts when the item changes, or when the same item comes up again from the
      // next box (used and replaced within one snapshot): see onState().
      const again = !!code && slotState.again;
      slotState.again = false;
      if (code !== slotState.code || again) {
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

    // The reserve slot: a smaller glass box beside the main one (the swap bubble by the fire button
    // on touch). Its roulette is a quick flicker of icons, not a second reel.
    const reserveEl = q('[data-reserve]');
    const reserveIcon = q('[data-reserve-icon]');
    const swapBtn = q('.tc-swap');
    const swapIcon = q('[data-swap-icon]');
    const reserve = { code: 0, ammo: -1, mode: 'empty', cs: 0, again: false, start: 0, end: 0, strip: [], last: -1 };
    function showReserve(id) {
      reserveIcon.innerHTML = iconHtml(id);
      swapIcon.innerHTML = iconHtml(id);
    }
    function setReserveMode(mode) {
      reserve.mode = mode;
      for (const node of [reserveEl, swapBtn]) {
        node.classList.toggle('empty', mode === 'empty');
        node.classList.toggle('rolling', mode === 'rolling');
        node.classList.toggle('ready', mode === 'ready');
      }
    }
    function landReserve() {
      showReserve(itemId(reserve.code));
      setReserveMode('ready');
      reserveEl.classList.remove('landed');
      void reserveEl.offsetWidth; // restart the pop animation
      reserveEl.classList.add('landed');
    }
    function updateReserve(now, code, ammo, rouletteCs) {
      const again = !!code && reserve.again;
      reserve.again = false;
      if (code !== reserve.code || again) {
        reserve.code = code;
        if (!code) { showReserve(null); setReserveMode('empty'); } else if (rouletteCs > 0) {
          const age = clockOffset === null ? rtt / 2 : Math.max(0, now - clockOffset - latest.t);
          const pool = (info?.itemList?.length ? info.itemList : K.ITEMS).filter((id) => K.ITEMS.includes(id));
          reserve.strip = Array.from({ length: 11 }, () => pool[Math.floor(Math.random() * pool.length)]).concat(itemId(code));
          Object.assign(reserve, { start: now, end: now + Math.max(300, rouletteCs * 10 - age), last: -1 });
          setReserveMode('rolling');
        } else landReserve();
      }
      if (reserve.mode === 'rolling') {
        const p = Math.min(1, (now - reserve.start) / (reserve.end - reserve.start));
        const idx = Math.round((1 - (1 - p) ** 3) * (reserve.strip.length - 1));
        if (idx !== reserve.last) { reserve.last = idx; showReserve(reserve.strip[idx]); }
        if (p >= 1) {
          landReserve();
          Sfx.rouletteDing?.();
        }
      }
      if (ammo !== reserve.ammo) {
        reserve.ammo = ammo;
        q('[data-reserve-ammo]').textContent = code && ammo > 1 ? `×${ammo}` : '';
      }
    }

    // ---------- HUD: ink, thunder flash, comet warning ----------
    const inkEl = q('[data-ink]');
    let inkUntil = 0; // when the ink on my screen is gone
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
      inkUntil = now + K.ITEM_FX.inkTime * 1000;
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
    // The game:kart:ink event splats (every time, so a second ink refreshes it); the snapshot flag
    // covers late joiners and ends the ink early (e.g. on respawn).
    function updateInk(now, inked) {
      if (inked && !prev.inked && now >= inkUntil) splatInk(now);
      if (!inked && prev.inked) inkUntil = Math.min(inkUntil, now);
      prev.inked = inked;
      if (!inkEl.classList.contains('on')) return;
      if (now >= inkUntil) inkEl.classList.remove('on', 'fading');
      else if (now > inkUntil - 1000) inkEl.classList.add('fading'); // fade over the last second
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
        karts: karts.map((k) => ({ x: k.x, y: k.y, z: k.z, angle: k.angle, color: colorOf(kartsByIdx.get(k.idx)), me: k.idx === myIdx, dead: !!(k.flags & F.dead), place: placeOf.get(k.idx) })),
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
        // 13 air, 14 fall/trick bits, 15 roulette, 16-18 the reserve slot
        const [, , , , , , , item, ammo, flags, , , , , , rouletteCs, item2 = 0, ammo2 = 0, roulette2Cs = 0] = row;
        updateSlot(now, item, ammo, rouletteCs || 0);
        updateReserve(now, item2, ammo2, roulette2Cs);
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
        // A sticky bomb on my kart: the countdown, and a beep that speeds up.
        const fuse = row[19] || 0;
        q('[data-sticky]').classList.toggle('hidden', !fuse);
        if (fuse) {
          q('[data-sticky-t]').textContent = (fuse / 10).toFixed(1);
          if (now - (prev.beep || 0) > (fuse < 8 ? 120 : fuse < 16 ? 260 : 460)) { prev.beep = now; Sfx.stickyBeep?.(); }
        }
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

    // Drawbridges ring a bell two seconds before they go up, and whoever is close by gets told.
    const bridgeRang = new Map(); // drawbridge -> when the rise it rang for starts
    function warnBridges(t) {
      let loudest = 0;
      let near = false;
      for (const m of map.movers) {
        if (m.type !== 'drawbridge') continue;
        const st = map.bridgeAt(m, t);
        if (!st.down || st.rise > 2) continue;
        const at = Math.round((t + st.rise) * 4);
        if (bridgeRang.get(m) === at) continue;
        bridgeRang.set(m, at);
        const x = (m.x0 + m.x1) / 2;
        const y = (m.y0 + m.y1) / 2;
        loudest = Math.max(loudest, volumeAt(x, y));
        if (Math.hypot(local.x - x, local.y - y) < 420) near = true;
      }
      if (loudest > 0.08) Sfx.bell?.(loudest);
      if (near) hud.callout('DRAWBRIDGE RISING', { kind: 'small', hold: 1100, sub: 'Get across or get off' });
    }

    // ---------- Frame loop ----------
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const elapsed = (now - lastFrame) / 1000;
      const dt = Math.min(0.05, elapsed); // effects and the camera
      lastFrame = now;
      if (!info) return;
      const chatOpen = document.body.classList.contains('chat-open');
      if (chatOpen && !chatWasOpen) release(); // the chat sheet covers the controls
      chatWasOpen = chatOpen;

      // Steps to run up to now (back from a hidden tab: only the last second's, the server's word on
      // my kart fills the gap).
      const clockNow = stepClock(now);
      const target = Math.max(stepNo, Math.floor(clockNow));
      stepAcc = Math.min(1, clockNow - target) * STEP;
      const skip = target - stepNo > 30;
      if (skip) stepNo = target - 30;
      if (pendingAck && map) { reconcile(pendingAck, target, skip); pendingAck = null; }
      const steps = target - stepNo;
      const myRow = latest?.k.find((r) => r[0] === myIdx);
      // The game clock the moving obstacles run on: the one my steps run at (so they line up with my
      // kart; everyone else is drawn a little behind). Spectators: the server's.
      const mapTime = ack && local ? tAt(stepNo) + stepAcc : clockOffset === null ? 0 : (now - clockOffset + rtt / 2) / 1000;
      if (map?.layered && local && !local.dead && latest?.phase === 'racing') warnBridges(mapTime);
      // Predict my kart: the same steps as the server, with the same item speed and ice, from the
      // very step the race starts at.
      const predicting = local && !local.dead && !local.falling && ack && !(ack.f & 8);
      for (let i = 0; i < steps; i++) {
        stepNo++;
        if (!predicting || stepNo < ack.g) continue;
        predPrev = { x: local.x, y: local.y, angle: local.angle, air: local.air || 0, z: local.z };
        K.stepNet(local, inputAt(stepNo), STEP, map, { speed: info.speedMul || 1, noFall: true, t: tAt(stepNo) });
        // Layered arenas: my own jump pads and bumpers sound right away (the server sends the rest).
        if (local.padded) { local.padded = 0; Sfx.pad?.(1); }
        if (local.bumper) { local.bumper = 0; Sfx.boing?.(1); }
        if (local.whacked) { local.whacked = 0; Sfx.bump?.(1); }
        // Hops, tricks and landings feel instant for your own kart.
        if (local.hopping && !prev.hopping) Sfx.hop?.();
        prev.hopping = !!local.hopping;
        if (local.trick > 0 && !prev.trick) Sfx.trick?.();
        prev.trick = local.trick > 0;
        if (prev.air > 12 && !(local.air > 0)) {
          Sfx.land?.(Math.min(1, prev.air / 90));
          if (local.boost > 0 && prev.trickBoost) hud.callout('TRICK BOOST!', { kind: 'small gold', hold: 800 });
        }
        prev.trickBoost = !!local.tricked;
        prev.air = local.air || 0;
      }
      if (!predicting) predPrev = null;
      // Corrections glide away (most of one in a tenth of a second).
      const keep = Math.exp(-dt * 12);
      fix.x *= keep; fix.y *= keep; fix.a *= keep; fix.z *= keep;
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
      if (local && ack && me && !(me.flags & F.dead) && !(me.fx & 1) && !local.dead && !local.falling) {
        // Carry the last step's motion on for the time since it (no added input lag).
        const pp = predPrev || local;
        const f = predPrev ? stepAcc / STEP : 0;
        let da = local.angle - pp.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        me.x = local.x + (local.x - pp.x) * f + fix.x;
        me.y = local.y + (local.y - pp.y) * f + fix.y;
        me.angle = local.angle + da * f + fix.a;
        me.speed = local.speed;
        me.air = Math.max(0, (local.air || 0) + ((local.air || 0) - pp.air) * f);
        if (map.layered && Number.isFinite(local.z)) me.z = local.z + (local.z - (Number.isFinite(pp.z) ? pp.z : local.z)) * f + fix.z;
        me.fx = (me.fx & ~2) | (local.trick > 0 ? 2 : 0);
      }
      // Aiming a bomb: the ring shows where it comes down (ahead of where I'll be by then).
      if (aim.on) {
        if (!bombReady() || !me || me.flags & F.dead || me.fx & 1) releaseFire(true);
        else {
          const lead = 26 + Math.max(0, local ? local.speed : me.speed) * K.ITEM_FX.bomb.flight + K.bombLead(aimPower(now));
          const ax = me.x + Math.cos(me.angle) * lead;
          const az = me.y + Math.sin(me.angle) * lead;
          // Layered arenas: the floor it comes down on (a deck a little above me, or anything below).
          let y;
          if (map.layered) { const f = map.floorAt(ax, az, (me.z || 0) + 60, mapTime); y = Number.isFinite(f) ? f : map.deathZ; }
          view3d?.setAim?.({ x: ax, z: az, y, fromX: me.x, fromZ: me.y, fromY: map.layered ? me.z : undefined, t: now / 1000 });
        }
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
        if (loaderShown) requestAnimationFrame(hideLoader); // the frame below is the world's first
        view3d.update({
          ...view,
          karts,
          myIdx,
          countdown: grid,
          mapTime,
          focus: focusKart ? {
            idx: focusKart.idx, x: focusKart.x, y: focusKart.y, z: focusKart.z, angle: focusKart.angle, air: focusKart.air || 0, grid,
            spinning: !!(focusKart.flags & F.spin) || !!(focusKart.fx & 1), boost: !!(focusKart.flags & F.boost), star: !!(focusKart.flags & F.star), snap: snapCamera,
            speed: focusKart.speed || 0,
          } : mode === 'orbit' ? { idx: -1, x: myRow[1], y: myRow[2], z: myRow[20], angle: orbitAngle, snap: snapCamera } : null,
        }, dt, now);
        if (mode) snapCamera = false;
      }
      updateHud(now, karts);
    }
    raf = requestAnimationFrame(frame);

    const ITEM_SOUND = { rocket: 'rocket', triple: 'rocket', bomb: 'rocket', banana: 'banana', mine: 'banana', shield: 'shield', ghost: 'shield', bouncer: 'bouncer', ink: 'ink',
      snowball: 'snowThrow', sticky: 'banana', spikes: 'spikes', decoy: 'banana' };
    const QUIET_HITS = ['mine', 'bomb', 'shock', 'lava', 'water', 'void', 'acid', 'cup', 'comet', 'thunder', 'ram', 'snowball', 'spikes', 'sticky', 'decoy']; // their own effect covers it
    const nameOf = (idx) => api.escapeHtml(kartsByIdx.get(idx)?.name || 'Someone');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    return {
      onSnapshot(snap) { onInit(snap.init); },
      onEvent(event, data) {
        if (event === 'game:kart:init') onInit(data);
        else if (event === 'game:kart:state') onState(data);
        else if (event === 'game:kart:me') pendingAck = data;
        else if (event === 'game:kart:stick') {
          if (data.idx === myIdx) {
            Sfx.stick?.();
            hud.callout('STICKY BOMB!', { kind: 'small', hold: 1100, sub: 'Bump a rival to pass it on' });
          } else if (data.pass && data.by === myIdx) {
            Sfx.swap?.();
            hud.callout('PASSED IT ON!', { kind: 'small gold', hold: 900, sub: nameOf(data.idx) });
          }
        } else if (event === 'game:kart:bump') {
          // (My own kart's shove arrives with the server's word on it, see reconcile.)
          const mine = data.s.find((r) => r[0] === myIdx);
          Sfx.bump(Math.min(1, 0.2 + data.p) * (mine ? 1 : volumeAt(data.x, data.y)));
          view3d?.bumpFx?.(data.x, data.y, data.p, data.ram >= 0, data.z);
          if (mine && data.ram >= 0) hud.callout(data.ram === myIdx ? 'RAM!' : 'RAMMED!', { kind: 'small', hold: 650 });
        } else if (event === 'game:kart:swap') {
          if (data.idx === myIdx) Sfx.swap?.();
        } else if (event === 'game:kart:pad') {
          // Layered arenas: a jump pad fired (my own kart's whoosh already played in prediction).
          view3d?.padFx?.(data.i);
          const k = latest?.k.find((r) => r[0] === data.idx);
          if (data.idx !== myIdx && k) Sfx.pad?.(volumeAt(k[1], k[2]) * 0.7);
        } else if (event === 'game:kart:bumper') {
          const k = latest?.k.find((r) => r[0] === data.idx);
          const b = map?.bumpers?.[data.i];
          view3d?.bumperFx?.(data.i, b?.x, b?.y, b ? b.z + b.h * 0.6 : undefined);
          if (data.idx !== myIdx && k) Sfx.boing?.(volumeAt(k[1], k[2]));
        } else if (event === 'game:kart:whack') {
          view3d?.bumpFx?.(data.x, data.y, 1, true, data.z);
          if (data.idx !== myIdx) Sfx.bump(volumeAt(data.x, data.y));
        } else if (event === 'game:kart:use') {
          if (data.idx === myIdx && ITEM_SOUND[data.item]) Sfx[ITEM_SOUND[data.item]]?.();
          if (data.idx === myIdx && data.item === 'minigun') Sfx.minigun?.();
          if (data.item === 'comet') Sfx.comet?.();
          view3d?.itemUsed?.(data.idx, data.item);
        } else if (event === 'game:kart:boom') {
          view3d?.explode(data.x, data.y, data.kind, data.r, null, data.z);
          const v = volumeAt(data.x, data.y);
          if (data.kind === 'bouncer') Sfx.bump(v * 0.5);
          else Sfx.explosion(v * (data.kind === 'rocket' ? 0.5 : 1));
          if (data.kind === 'comet') Sfx.thunder?.(v * 0.6);
        } else if (event === 'game:kart:shock') {
          view3d?.shock(data.x, data.y, data.r, data.z);
          Sfx.shock?.(volumeAt(data.x, data.y));
        } else if (event === 'game:kart:thunder') {
          // Bolts on every victim (where their kart is drawn); everyone's screen flashes.
          view3d?.thunderHit(data.hit, new Map((latest?.k || []).map((r) => [r[0], [r[1], r[2]]])));
          flash();
          Sfx.thunder?.(1);
          if (data.hit.includes(myIdx)) hud.callout('THUNDERSTRUCK', { kind: 'small', hold: 900, sub: `by ${nameOf(data.idx)}` });
          else if (data.idx === myIdx && data.hit.length) hud.callout('THUNDER!', { kind: 'small gold', hold: 900, sub: `Struck ${plural(data.hit.length, 'rival')}` });
        } else if (event === 'game:kart:ink') {
          if (data.idx === myIdx) hud.callout(data.hit.length ? 'SPLAT!' : 'NOBODY TO INK', { kind: 'small', hold: 800, sub: data.hit.length ? `Inked ${plural(data.hit.length, 'rival')}` : '' });
          if (data.hit.includes(myIdx)) splatInk(performance.now());
          if (map?.type === 'race') for (const idx of data.hit.slice(0, 2)) hud.smash({ by: data.idx, target: idx, kind: 'ink' });
          view3d?.inkBurst?.(data.idx, data.hit);
        } else if (event === 'game:kart:block') {
          const k = latest?.k.find((r) => r[0] === data.idx);
          if (k) view3d?.block(k[1], k[2], data.kind, k[20]);
          if (data.idx === myIdx) {
            Sfx.block?.();
            hud.callout('BLOCKED', { kind: 'small', hold: 700, sub: data.kind === 'trail' ? 'Your item took the hit' : '' });
          }
        } else if (event === 'game:kart:hit') {
          const kind = data.kill ? 'kill' : data.kind === 'bullet' ? 'bullet' : 'hit';
          // A blast or shell threw the kart: it bucks up into the air (drawn only; the throw itself
          // arrives with the server's word on my kart).
          if (data.kx !== undefined) view3d?.buck?.(data.target, Math.hypot(data.kx, data.ky));
          const victim = kartsByIdx.get(data.target);
          if (data.kind === 'water' || data.kind === 'acid' || data.kind === 'cup') {
            // Into the moat, an open grave full of acid or a golf cup: a splash (green and fizzing
            // for acid; turf and confetti, and a polite round of applause, for a hole in one).
            view3d?.fallFx(data.x, data.y, data.kind, data.z);
            ({ acid: Sfx.sizzle, cup: Sfx.holeOut }[data.kind] || Sfx.splash)?.(data.target === myIdx ? 1 : volumeAt(data.x, data.y));
          } else if (!QUIET_HITS.includes(data.kind) || data.kill) view3d?.explode(data.x, data.y, kind, data.kill ? 90 : 50, colorOf(victim), data.z);
          if (!['bullet', 'thunder', 'ram', 'snowball', 'spikes', 'sticky', 'decoy'].includes(data.kind) || data.kill) Sfx.explosion(volumeAt(data.x, data.y) * (data.kill ? 1 : 0.4));
          if (data.kind === 'snowball') Sfx.freeze?.(data.target === myIdx ? 1 : volumeAt(data.x, data.y));
          if (data.kind === 'spikes') view3d?.bumpFx?.(data.x, data.y, 1, true, data.z);
          if (data.shatter) {
            view3d?.shatter?.(data.x, data.y, data.z);
            Sfx.shatter?.(data.target === myIdx || data.by === myIdx ? 1 : volumeAt(data.x, data.y));
            if (data.by === myIdx) hud.callout('SHATTER!', { kind: 'small gold', hold: 900 });
          }
          if (data.target === myIdx && data.kind === 'snowball') hud.callout('FROZEN!', { kind: 'small', hold: 900, sub: 'Hit again and the ice shatters' });
          if (data.kill || (map?.type === 'race' && data.kind !== 'bullet' && data.by >= 0)) hud.smash(data);
          // Damage numbers float off your victims (your own health bar shows what you take);
          // minigun bullets add up into one number per 18 or so.
          if (data.dmg > 0 && data.by === myIdx && data.target !== myIdx) {
            let amount = data.dmg;
            if (data.kind === 'bullet' && !data.kill) {
              const sum = (bulletDmg.get(data.target) || 0) + amount;
              amount = sum >= 18 ? sum : 0;
              bulletDmg.set(data.target, amount ? 0 : sum);
            }
            if (amount) view3d?.damageNumber?.(data.target, amount, amount >= 50 || data.kill ? 'big' : 'deal');
          }
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
        clearInterval(loaderTimer);
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
