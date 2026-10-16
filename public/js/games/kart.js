/* global KartCore */
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

    el.innerHTML = `
      <div class="game-wrap">
        <div class="stage kart-stage" data-stage>
          <div class="kart-hud">
            <div class="place" data-place></div><div class="lap" data-lap></div><div data-time></div>
            <div class="kart-hp hidden" data-hp><i data-hp-fill></i><span data-hp-text></span></div>
          </div>
          <div class="kart-timer hidden" data-timer></div>
          <div class="kart-item empty" data-item><span data-item-icon></span><small data-item-ammo></small></div>
          <div class="kart-item-name" data-item-name></div>
          <div class="kart-board" data-board></div>
          <div class="kart-feed" data-feed></div>
          <div class="kart-mapname" data-mapname></div>
          <div class="kart-big" data-big></div>
          <div class="kart-speedlines" data-speedlines></div>
          <div class="kart-announce" data-announce></div>
          <div class="kart-dead hidden" data-dead><h2>💥 Destroyed!</h2><p data-dead-by></p><p class="muted">Respawning…</p></div>
          <canvas class="kart-minimap" data-minimap width="180" height="180"></canvas>
          <div class="kart-help">Arrows / WASD drive · Shift drift · Space fire</div>
          <div class="touch-controls">
            <div class="grp"><button data-key="left">◀</button><button data-key="right">▶</button></div>
            <div class="grp"><button data-key="drift">↯</button><button data-key="down">▼</button><button data-key="use">🔥</button><button data-key="up">▲</button></div>
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
    const prev = { item: 0, boost: false, drift: 0, count: null, finished: false };
    const teamMode = () => !!api.room()?.settings.teamMode;
    const colorOf = (meta) => (teamMode() ? api.teamById(meta?.team)?.color : meta?.color) || '#fff';

    // ---------- 3D renderer (ES module, may finish loading after mount) ----------
    function createRenderer() {
      if (!info || view3d || !window.Kart3D) return;
      try {
        view3d = new window.Kart3D(stage, { mapId: info.mapId, type: info.map });
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
      const sameRound = info && info.mapId === data.mapId && info.karts.length === data.karts.length;
      info = data;
      map = K.getMap(data.mapId, data.map);
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
        if (k.flags & 32) continue;
        const meta = kartsByIdx.get(k.idx);
        const me = k.idx === myIdx;
        ctx.fillStyle = colorOf(meta);
        ctx.beginPath(); ctx.arc(k.x, k.y, me ? 110 : 65, 0, Math.PI * 2); ctx.fill();
        if (me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 40; ctx.stroke(); }
      }
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
        const [, , , , , lap, place, item, ammo, flags, kills, deaths, hp] = row;
        if (arena) {
          q('[data-place]').textContent = `#${place}`;
          q('[data-lap]').textContent = `💥 ${kills} kills`;
          q('[data-time]').textContent = `☠️ ${deaths} deaths`;
          q('[data-hp-fill]').style.width = `${hp}%`;
          q('[data-hp-fill]').style.background = hp > 50 ? '#22c55e' : hp > 25 ? '#facc15' : '#ef4444';
          q('[data-hp-text]').textContent = `${hp} HP`;
        } else {
          q('[data-place]').textContent = flags & 8 ? `🏁 #${place}` : `#${place}`;
          q('[data-lap]').textContent = `Lap ${lap}/${info.laps}`;
          q('[data-time]').textContent = latest.phase === 'racing' ? `${latest.elapsed.toFixed(1)}s` : '';
        }
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
        q('[data-dead]').classList.toggle('hidden', !(flags & 32));
      } else {
        q('[data-place]').textContent = '👀';
        q('[data-lap]').textContent = 'Spectating';
        q('[data-item]').style.display = 'none';
      }

      if (now - boardUpdate > 300) {
        boardUpdate = now;
        drawMinimap(karts);
        const rows = [...latest.k].sort((a, b) => a[6] - b[6]);
        const shown = rows.slice(0, 8);
        if (row && row[6] > 8) shown.push(row);
        q('[data-board]').innerHTML = shown.map((r) => {
          const meta = kartsByIdx.get(r[0]);
          const tail = arena ? `<b>${r[10]}</b>` : (r[9] & 8 ? '🏁' : '');
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

      // Predict my kart locally so steering feels instant.
      const myRow = latest?.k.find((r) => r[0] === myIdx);
      if (local && !local.dead && latest?.phase === 'racing') {
        const finished = myRow && myRow[9] & 8;
        K.stepKart(local, finished ? { down: true } : input, dt, map);
      }
      if (local && myRow && latest?.phase === 'racing' && !(myRow[9] & 32)) {
        Sfx.engine(Math.abs(local.speed) / K.PHYS.maxSpeed, !!(myRow[9] & 2), !!(myRow[9] & 64));
      } else {
        Sfx.engineStop();
      }

      const view = interpolated();
      const karts = view ? view.karts : [];
      const me = karts.find((k) => k.idx === myIdx);
      if (local && me && !(me.flags & 32)) {
        me.x = local.x; me.y = local.y; me.angle = local.angle; me.speed = local.speed;
      }

      // Camera follows me, or the leader when spectating.
      let focusKart = me && !(me.flags & 32) ? me : null;
      if (!focusKart && !me && latest) {
        const leader = latest.k.find((r) => r[6] === 1);
        focusKart = karts.find((k) => leader && k.idx === leader[0]);
      }
      if (view3d && view) {
        view3d.update({
          ...view,
          karts,
          focus: focusKart ? {
            x: focusKart.x, y: focusKart.y, angle: focusKart.angle,
            spinning: !!(focusKart.flags & 1), boost: !!(focusKart.flags & 2), snap: snapCamera,
          } : (me && myRow ? { x: myRow[1], y: myRow[2], angle: myRow[3] / 1000, spinning: true } : null),
        }, dt, now);
        if (focusKart) snapCamera = false;
      }
      updateHud(now, karts);
    }
    raf = requestAnimationFrame(frame);

    const STREAKS = { 2: 'DOUBLE KILL!', 3: 'TRIPLE KILL!', 4: 'MULTI KILL!', 5: 'RAMPAGE!', 7: 'UNSTOPPABLE!', 10: 'GODLIKE!' };
    const nameTag = (m) => `<b style="color:${colorOf(m)}">${api.escapeHtml(m?.name || '?')}</b>`;
    const KILL_ICON = { rocket: '🚀', bullet: '🔫', banana: '🍌', mine: '🧨', bomb: '💣', shock: '🌩️', lava: '🌋' };
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
          if (data.idx === myIdx) api.toast('🛡️ Shield blocked a hit!');
        } else if (event === 'game:kart:hit') {
          const kind = data.kill ? 'kill' : data.kind === 'bullet' ? 'bullet' : 'hit';
          if (!['mine', 'bomb', 'shock', 'lava'].includes(data.kind) || data.kill) view3d?.explode(data.x, data.y, kind, data.kill ? 90 : 50);
          if (data.kind !== 'bullet') Sfx.explosion(volumeAt(data.x, data.y) * (data.kill ? 1 : 0.4));
          const victim = kartsByIdx.get(data.target);
          const killer = data.by >= 0 ? kartsByIdx.get(data.by) : null;
          if (data.kill) feed(killer ? `${nameTag(killer)} ${KILL_ICON[data.kind] || '💥'} ${nameTag(victim)}` : `${nameTag(victim)} ${KILL_ICON[data.kind] || '💥'}`);
          if (data.streak >= 3 && STREAKS[data.streak] && killer) feed(`🔥 ${nameTag(killer)} ${STREAKS[data.streak].toLowerCase().replace('!', '')}`);
          if (data.target === myIdx) {
            q('[data-dead-by]').innerHTML = killer ? `by ${nameTag(killer)}` : '';
            if (data.kind !== 'bullet') Sfx.hit();
            if (!data.kill && map?.type === 'race' && data.kind !== 'bullet') api.toast('💥 You got hit!');
          } else if (data.by === myIdx && data.kind !== 'bullet') {
            Sfx.kill();
            if (data.kill && STREAKS[data.streak]) { announce(STREAKS[data.streak]); Sfx.streak(); }
            else if (data.kill || map?.type === 'race') api.toast(`🎯 You ${data.kill ? 'destroyed' : 'hit'} ${victim?.name || 'someone'}!`);
          }
        } else if (event === 'game:kart:finish' && data.idx === myIdx) {
          api.toast(`🏁 You finished #${data.place} in ${data.time.toFixed(1)}s!`);
        }
      },
      unmount() {
        cancelAnimationFrame(raf);
        Sfx.engineStop();
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
