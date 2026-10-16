/* global KartCore */
window.Games = window.Games || {};

// Kart Battle client: networking, input, prediction and HUD.
// The 3D world is drawn by Kart3D (js/games/kart3d.js).
window.Games.kart = {
  mount(el, api) {
    const K = KartCore;
    const Sfx = window.Sfx;
    const Icons = window.ItemIcons;
    const INTERP_DELAY = 110; // ms behind the server for smooth remote karts
    const TOUCH = matchMedia('(pointer: coarse)').matches;
    // Snapshot flag bits (see broadcast() in server/games/kart.js).
    const F = { spin: 1, boost: 2, shield: 4, finished: 8, invuln: 16, dead: 32, drift: 64, ghost: 1024, gun: 2048, star: 4096, shrunk: 8192, inked: 16384 };

    el.innerHTML = `
      <div class="game-wrap">
        <div class="stage kart-stage" data-stage>
          <div class="kart-ink" data-ink></div>
          <div class="kart-flash" data-flash></div>
          <div class="kart-hud">
            <div class="place" data-place></div><div class="lap" data-lap></div><div data-time></div>
            <div class="kart-hp hidden" data-hp><i data-hp-fill></i><span data-hp-text></span></div>
          </div>
          <div class="kart-timer hidden" data-timer></div>
          <div class="kart-item empty" data-item>
            <div class="kart-reel" data-reel></div>
            <div class="kart-item-icon" data-item-icon></div>
            <b class="kart-ammo" data-item-ammo></b>
          </div>
          <div class="kart-item-name" data-item-name></div>
          <div class="kart-warn hidden" data-warn>${Icons.svg('comet', 'item-icon')}<span>Comet incoming!</span></div>
          <div class="kart-board" data-board></div>
          <div class="kart-feed" data-feed></div>
          <div class="kart-mapname" data-mapname></div>
          <div class="kart-big" data-big></div>
          <div class="kart-speedlines" data-speedlines></div>
          <div class="kart-announce" data-announce></div>
          <div class="kart-dead hidden" data-dead><h2>💥 Destroyed!</h2><p data-dead-by></p><p class="muted">Respawning…</p></div>
          <canvas class="kart-minimap" data-minimap width="180" height="180"></canvas>
          <div class="kart-help">Arrows / WASD drive · Shift drift · Space fire (hold ↓ to throw back)</div>
          <div class="touch-controls">
            <div class="grp"><button data-key="left">◀</button><button data-key="right">▶</button></div>
            <div class="grp"><button data-key="drift">↯</button><button data-key="down">▼</button><button data-key="use" class="use">🔥</button><button data-key="up">▲</button></div>
          </div>
        </div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');

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
    const prev = { boost: false, drift: 0, count: null, finished: false, star: false, shrunk: false, inked: false, warn: 0 };
    const teamMode = () => !!api.room()?.settings.teamMode;
    const colorOf = (meta) => (teamMode() ? api.teamById(meta?.team)?.color : meta?.color) || '#fff';

    // ---------- 3D renderer (ES module, may finish loading after mount) ----------
    function createRenderer() {
      if (!info || view3d || !window.Kart3D) return;
      try {
        view3d = new window.Kart3D(stage, { mapId: info.mapId, type: info.map, reverse: !!info.reverse, items: info.items !== false });
        view3d.setKarts(info.karts, myIdx, (meta) => (teamMode() ? api.teamById(meta.team)?.color : null));
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
      if (typing(e)) return;
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
    const blur = () => { Object.keys(input).forEach((k) => { input[k] = false; }); sendInput(); };
    window.addEventListener('blur', blur);

    el.querySelectorAll('[data-key]').forEach((b) => {
      const k = b.dataset.key;
      const set = (v) => (e) => {
        e.preventDefault();
        b.classList.toggle('on', v);
        if (k === 'use') { if (v) useItem(); return; }
        if (input[k] !== v) { input[k] = v; sendInput(); }
      };
      b.addEventListener('pointerdown', set(true));
      b.addEventListener('pointerup', set(false));
      b.addEventListener('pointercancel', set(false));
      b.addEventListener('pointerleave', set(false));
    });
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
      if (view3d && !sameRound) { view3d.dispose(); view3d = null; }
      createRenderer();
      q('[data-timer]').classList.toggle('hidden', map.type !== 'arena');
      q('[data-hp]').classList.toggle('hidden', map.type !== 'arena' || myIdx < 0);
      q('[data-mapname]').textContent = `${map.emoji} ${map.name}`;
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
      if (!local || flags & F.dead) {
        local = { x, y, angle, heading: angle, speed, boost: 0, spin: 0, trackIndex: null, dead: !!(flags & F.dead) };
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
      const spinning = flags & F.spin;
      if (spinning) local.spin = Math.max(local.spin, 0.15);
      if (flags & F.boost) local.boost = Math.max(local.boost, 0.15);
      local.flags = flags; // star / shrink change the top speed in prediction too
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
          item: r[7], ammo: r[8], roulette: r[13] || 0,
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
    const slot = q('[data-item]');
    const reel = q('[data-reel]');
    const iconBox = q('[data-item-icon]');
    const useBtn = q('[data-key="use"]');
    const itemId = (code) => K.ITEMS[code - 1];
    const slotState = { code: 0, ammo: -1, mode: 'empty' }; // mode: empty | rolling | ready
    const roulette = { start: 0, end: 0, cells: 0, last: -1, cell: 68 };

    function showIcon(code) {
      iconBox.innerHTML = code ? Icons.svg(itemId(code), 'item-icon') : '';
      useBtn.innerHTML = code ? Icons.svg(itemId(code), 'item-icon') : '🔥';
    }
    function setSlotMode(mode) {
      slotState.mode = mode;
      slot.classList.toggle('empty', mode === 'empty');
      slot.classList.toggle('rolling', mode === 'rolling');
      slot.classList.toggle('ready', mode === 'ready');
      useBtn.classList.toggle('ready', mode === 'ready');
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
      roulette.cell = reel.firstElementChild?.offsetHeight || 68;
      Object.assign(roulette, { start: now, end: now + remainingMs, cells, last: -1 });
      reel.style.transform = 'translateY(0)';
      iconBox.innerHTML = '';
      setSlotMode('rolling');
      Sfx.pop();
    }
    function landRoulette(code, ding) {
      showIcon(code);
      setSlotMode('ready');
      slot.classList.remove('landed');
      void slot.offsetWidth; // restart the pop animation
      slot.classList.add('landed');
      if (ding) Sfx.rouletteDing?.();
    }
    function updateSlot(now, code, ammo, rouletteCs) {
      if (code !== slotState.code) {
        // Time left on the server's roulette, minus how old this snapshot already is.
        const age = clockOffset === null ? rtt / 2 : Math.max(0, now - clockOffset - latest.t);
        if (!code) { showIcon(0); setSlotMode('empty'); } else if (rouletteCs > 0) startRoulette(code, Math.max(350, rouletteCs * 10 - age), now);
        else landRoulette(code, slotState.code === 0);
        slotState.code = code;
      }
      if (slotState.mode === 'rolling') {
        const p = Math.min(1, (now - roulette.start) / (roulette.end - roulette.start));
        const pos = (1 - (1 - p) ** 3) * (roulette.cells - 1); // ease out: fast spin, slow landing
        reel.style.transform = `translateY(${-pos * roulette.cell}px)`;
        const idx = Math.round(pos);
        if (idx !== roulette.last) { roulette.last = idx; Sfx.rouletteTick?.(idx); }
        if (p >= 1) landRoulette(code, true);
      }
      if (ammo !== slotState.ammo) {
        slotState.ammo = ammo;
        q('[data-item-ammo]').textContent = code && ammo > 1 ? `×${ammo}` : '';
      }
      const name = q('[data-item-name]');
      const label = slotState.mode === 'ready'
        ? `${Icons.name(itemId(code))} <kbd>${TOUCH ? 'TAP' : 'SPACE'}</kbd>`
        : slotState.mode === 'rolling' ? '<span class="muted">…</span>' : '';
      if (name.dataset.label !== label) { name.dataset.label = label; name.innerHTML = label; }
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
    function drawMinimap(karts) {
      const c = q('[data-minimap]');
      const ctx = c.getContext('2d');
      const W = c.width;
      ctx.clearRect(0, 0, W, W);
      ctx.fillStyle = 'rgba(15,10,35,0.55)';
      ctx.beginPath(); ctx.roundRect(0, 0, W, W, 14); ctx.fill();
      const pad = 12;
      const bnd = map.bounds;
      const size = Math.max(bnd.maxX - bnd.minX, bnd.maxY - bnd.minY);
      const s = (W - pad * 2) / size;
      ctx.save();
      ctx.translate(pad, pad);
      ctx.scale(s, s);
      ctx.translate(-bnd.minX, -bnd.minY);
      if (map.type === 'arena') {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 40;
        ctx.strokeRect(20, 20, map.size - 40, map.size - 40);
        ctx.fillStyle = 'rgba(255,120,40,0.75)';
        for (const h of map.hazards) { ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (const o of map.obstacles) { ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill(); }
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = map.width * 0.6;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        map.centerline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      }
      for (const k of karts) {
        if (k.flags & F.dead) continue;
        const meta = kartsByIdx.get(k.idx);
        const me = k.idx === myIdx;
        ctx.fillStyle = colorOf(meta);
        ctx.beginPath(); ctx.arc(k.x, k.y, me ? 110 : 65, 0, Math.PI * 2); ctx.fill();
        if (me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 40; ctx.stroke(); }
      }
      // Comets in flight show up as bright dots.
      ctx.fillStyle = '#a5b4fc';
      for (const sh of latest?.s || []) if (sh[1] === 5) { ctx.beginPath(); ctx.arc(sh[2], sh[3], 80, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }

    let boardUpdate = 0;
    function updateHud(now, karts) {
      if (!latest || !info) return;
      const arena = map.type === 'arena';
      const big = q('[data-big]');
      if (latest.phase === 'countdown') {
        const n = Math.ceil(latest.countdown - 1);
        big.textContent = n > 0 ? n : 'GO!';
        if (n !== prev.count && n > 0 && n <= 3) Sfx.beep();
        prev.count = n;
      } else {
        if (latest.phase === 'racing' && prev.count !== 'go') {
          if (prev.count !== null) Sfx.go();
          prev.count = 'go';
        }
        if (latest.phase === 'racing' && latest.elapsed < 1) big.textContent = 'GO!';
        else if (latest.phase === 'done') big.textContent = arena ? 'TIME!' : 'FINISH!';
        else big.textContent = '';
      }

      if (arena && latest.timeLeft !== null) {
        const t = Math.ceil(latest.timeLeft);
        q('[data-timer]').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        q('[data-timer]').classList.toggle('urgent', t <= 10);
      }

      const row = latest.k.find((r) => r[0] === myIdx);
      if (row) {
        const [, , , , , lap, place, item, ammo, flags, kills, deaths, hp, rouletteCs] = row;
        if (arena) {
          q('[data-place]').textContent = `#${place}`;
          q('[data-lap]').textContent = `💥 ${kills} kills`;
          q('[data-time]').textContent = `☠️ ${deaths} deaths`;
          q('[data-hp-fill]').style.width = `${hp}%`;
          q('[data-hp-fill]').style.background = hp > 50 ? '#22c55e' : hp > 25 ? '#facc15' : '#ef4444';
          q('[data-hp-text]').textContent = `${hp} HP`;
        } else {
          q('[data-place]').textContent = flags & F.finished ? `🏁 #${place}` : `#${place}`;
          q('[data-lap]').textContent = `Lap ${lap}/${info.laps}`;
          q('[data-time]').textContent = latest.phase === 'racing' ? `${latest.elapsed.toFixed(1)}s` : '';
        }
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
        q('[data-dead]').classList.toggle('hidden', !(flags & F.dead));
        // Is a comet coming for me?
        const comet = (latest.s || []).find((sh) => sh[1] === 5 && sh[6] === myIdx);
        q('[data-warn]').classList.toggle('hidden', !comet);
        if (comet && now - prev.warn > 520) { prev.warn = now; Sfx.cometWarn?.(); }
      } else {
        q('[data-place]').textContent = '👀';
        q('[data-lap]').textContent = 'Spectating';
        slot.style.display = 'none';
      }

      if (now - boardUpdate > 300) {
        boardUpdate = now;
        drawMinimap(karts);
        const rows = [...latest.k].sort((a, b) => a[6] - b[6]);
        const shown = rows.slice(0, 8);
        if (row && row[6] > 8) shown.push(row);
        q('[data-board]').innerHTML = shown.map((r) => {
          const meta = kartsByIdx.get(r[0]);
          const tail = arena ? `<b>${r[10]}</b>` : (r[9] & F.finished ? '🏁' : '');
          return `<div class="${r[0] === myIdx ? 'me' : ''}"><span>${r[6]}. <i style="color:${colorOf(meta)}">●</i> ${api.escapeHtml(meta?.name || '?')}</span>${tail}</div>`;
        }).join('');
      }
    }

    function volumeAt(x, y) {
      if (!local) return 0.5;
      return Math.max(0.08, 1 - Math.hypot(local.x - x, local.y - y) / 1400);
    }

    function announce(text) {
      const a = q('[data-announce]');
      a.textContent = text;
      a.classList.remove('show');
      void a.offsetWidth; // restart the animation
      a.classList.add('show');
    }

    function feed(html) {
      const f = q('[data-feed]');
      const div = document.createElement('div');
      div.innerHTML = html;
      f.prepend(div);
      while (f.children.length > 5) f.lastChild.remove();
      setTimeout(() => div.remove(), 5000);
    }

    // ---------- Frame loop ----------
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      if (!info) return;

      // Predict my kart locally so steering feels instant (same item speed factors as the server).
      const myRow = latest?.k.find((r) => r[0] === myIdx);
      if (local && !local.dead && latest?.phase === 'racing') {
        const fl = local.flags || 0;
        K.stepKart(local, input, dt, map, { speed: (info.speedMul || 1) * K.itemSpeed(fl & F.star, fl & F.shrunk) });
      }
      if (local && myRow && latest?.phase === 'racing' && !(myRow[9] & F.dead)) {
        Sfx.engine(Math.abs(local.speed) / K.PHYS.maxSpeed, !!(myRow[9] & (F.boost | F.star)), !!(myRow[9] & F.drift));
      } else {
        Sfx.engineStop();
      }

      const view = interpolated();
      const karts = view ? view.karts : [];
      const me = karts.find((k) => k.idx === myIdx);
      if (local && me && !(me.flags & F.dead)) {
        me.x = local.x; me.y = local.y; me.angle = local.angle; me.speed = local.speed;
      }

      // Camera follows me, or the leader when spectating.
      let focusKart = me && !(me.flags & F.dead) ? me : null;
      if (!focusKart && !me && latest) {
        const leader = latest.k.find((r) => r[6] === 1);
        focusKart = karts.find((k) => leader && k.idx === leader[0]);
      }
      if (view3d && view) {
        view3d.update({
          ...view,
          karts,
          myIdx,
          focus: focusKart ? {
            x: focusKart.x, y: focusKart.y, angle: focusKart.angle,
            spinning: !!(focusKart.flags & F.spin), boost: !!(focusKart.flags & F.boost), star: !!(focusKart.flags & F.star), snap: snapCamera,
          } : (me && myRow ? { x: myRow[1], y: myRow[2], angle: myRow[3] / 1000, spinning: true } : null),
        }, dt, now);
        if (focusKart) snapCamera = false;
      }
      updateHud(now, karts);
    }
    raf = requestAnimationFrame(frame);

    const STREAKS = { 2: 'DOUBLE KILL!', 3: 'TRIPLE KILL!', 4: 'MULTI KILL!', 5: 'RAMPAGE!', 7: 'UNSTOPPABLE!', 10: 'GODLIKE!' };
    const nameTag = (m) => `<b style="color:${colorOf(m)}">${api.escapeHtml(m?.name || '?')}</b>`;
    // Kill feed icons (SVG, like the item slot).
    const FEED_ICON = { bullet: 'minigun', lava: 'lava' };
    const feedIcon = (kind) => Icons.svg(FEED_ICON[kind] || (K.ITEMS.includes(kind) ? kind : 'boom'), 'feed-icon');
    const ITEM_SOUND = { rocket: 'rocket', triple: 'rocket', bomb: 'rocket', banana: 'banana', mine: 'banana', shield: 'shield', ghost: 'shield', bouncer: 'bouncer', ink: 'ink' };
    const QUIET_HITS = ['mine', 'bomb', 'shock', 'lava', 'comet', 'thunder']; // their own blast effect covers it

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
          const by = kartsByIdx.get(data.idx);
          if (data.hit.includes(myIdx)) api.toast(`⚡ ${by?.name || 'Someone'} struck you with thunder!`);
          else if (data.idx === myIdx && data.hit.length) api.toast(`⚡ Thunder struck ${data.hit.length} rival${data.hit.length > 1 ? 's' : ''}!`);
        } else if (event === 'game:kart:ink') {
          if (data.idx === myIdx) api.toast(data.hit.length ? `Ink splatted ${data.hit.length} rival${data.hit.length > 1 ? 's' : ''}!` : 'Nobody to ink…');
          view3d?.inkBurst?.(data.idx, data.hit);
        } else if (event === 'game:kart:block') {
          const k = latest?.k.find((r) => r[0] === data.idx);
          if (k) view3d?.block(k[1], k[2], data.kind);
          if (data.idx === myIdx) {
            Sfx.block?.();
            api.toast(data.kind === 'trail' ? 'Your item blocked a hit from behind!' : '🛡️ Shield blocked a hit!');
          }
        } else if (event === 'game:kart:hit') {
          const kind = data.kill ? 'kill' : data.kind === 'bullet' ? 'bullet' : 'hit';
          if (!QUIET_HITS.includes(data.kind) || data.kill) view3d?.explode(data.x, data.y, kind, data.kill ? 90 : 50);
          if (data.kind !== 'bullet' && data.kind !== 'thunder') Sfx.explosion(volumeAt(data.x, data.y) * (data.kill ? 1 : 0.4));
          const victim = kartsByIdx.get(data.target);
          const killer = data.by >= 0 ? kartsByIdx.get(data.by) : null;
          if (data.kill) feed(killer ? `${nameTag(killer)} ${feedIcon(data.kind)} ${nameTag(victim)}` : `${nameTag(victim)} ${feedIcon(data.kind)}`);
          if (data.streak >= 3 && STREAKS[data.streak] && killer) feed(`🔥 ${nameTag(killer)} ${STREAKS[data.streak].toLowerCase().replace('!', '')}`);
          if (data.target === myIdx) {
            q('[data-dead-by]').innerHTML = killer ? `by ${nameTag(killer)}` : '';
            if (data.kind !== 'bullet') Sfx.hit();
            if (!data.kill && map?.type === 'race' && !['bullet', 'thunder'].includes(data.kind)) api.toast(data.kind === 'comet' ? '💥 The comet got you!' : '💥 You got hit!');
          } else if (data.by === myIdx && data.kind !== 'bullet') {
            Sfx.kill();
            if (data.kill && STREAKS[data.streak]) { announce(STREAKS[data.streak]); Sfx.streak(); }
            else if (data.kind !== 'thunder' && (data.kill || map?.type === 'race')) api.toast(`🎯 You ${data.kill ? 'destroyed' : 'hit'} ${victim?.name || 'someone'}!`);
          }
        } else if (event === 'game:kart:finish' && data.idx === myIdx) {
          api.toast(`🏁 You finished #${data.place} in ${data.time.toFixed(1)}s!`);
        }
      },
      unmount() {
        cancelAnimationFrame(raf);
        Sfx.engineStop();
        Sfx.starStop?.();
        clearInterval(resend);
        clearInterval(pinger);
        view3d?.dispose();
        window.removeEventListener('kart3d-ready', onReady);
        window.removeEventListener('keydown', kd);
        window.removeEventListener('keyup', ku);
        window.removeEventListener('blur', blur);
      },
    };
  },
};
