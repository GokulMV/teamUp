/* global KartCore */
window.Games = window.Games || {};

window.Games.kart = {
  mount(el, api) {
    const K = KartCore;
    const ITEM_ICONS = ['', '⚡', '🚀', '🍌', '🛡️', '🚀'];
    const INTERP_DELAY = 110; // ms behind the server for smooth remote karts

    el.innerHTML = `
      <div class="game-wrap">
        <div class="stage kart-stage" data-stage>
          <canvas></canvas>
          <div class="kart-hud"><div class="place" data-place></div><div class="lap" data-lap></div><div data-time></div></div>
          <div class="kart-item" data-item></div>
          <div class="kart-board" data-board></div>
          <div class="kart-big" data-big></div>
          <div class="kart-help">Arrows / WASD to drive · Space to use item</div>
          <div class="touch-controls">
            <div class="grp"><button data-key="left">◀</button><button data-key="right">▶</button></div>
            <div class="grp"><button data-key="down">▼</button><button data-key="use">⚡</button><button data-key="up">▲</button></div>
          </div>
        </div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const canvas = q('canvas');
    const ctx = canvas.getContext('2d');

    let info = null; // init payload
    let kartsByIdx = new Map();
    const snapshots = []; // { t, recv, data }
    let clockOffset = null; // localNow - serverT (minimum observed)
    let latest = null;
    let myIdx = -1;
    let local = null; // predicted state of my kart
    let rtt = 80;
    let lastFrame = performance.now();
    let raf = 0;
    let hitFlash = 0;
    const input = { up: false, down: false, left: false, right: false };

    // ---------- Track geometry (built once) ----------
    const trackPath = new Path2D();
    K.CENTERLINE.forEach(([x, y], i) => (i ? trackPath.lineTo(x, y) : trackPath.moveTo(x, y)));
    trackPath.closePath();

    // ---------- Input ----------
    const keyMap = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    };
    function sendInput() { api.socket.emit('game:input', input); }
    function useItem() { api.socket.emit('game:use'); }
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    function onKey(e, down) {
      if (typing(e)) return;
      if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'ShiftLeft') {
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
      info = data;
      kartsByIdx = new Map(data.karts.map((k) => [k.idx, k]));
      const mine = data.karts.find((k) => k.id === api.myId());
      myIdx = mine ? mine.idx : -1;
      local = null;
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
      if (!local) {
        local = { x, y, angle, speed, boost: 0, spin: 0, trackIndex: null };
        return;
      }
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
        local.x = sx; local.y = sy; local.angle = angle; local.speed = speed;
      } else {
        local.x += ex * 0.2;
        local.y += ey * 0.2;
        let da = angle - local.angle;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        local.angle += da * 0.2;
        local.speed += (speed - local.speed) * 0.2;
      }
    }

    // Interpolated kart rows for rendering.
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
      const prev = new Map(a.data.k.map((r) => [r[0], r]));
      const karts = b.data.k.map((r) => {
        const p = prev.get(r[0]) || r;
        let da = (r[3] - p[3]) / 1000;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        return { idx: r[0], x: p[1] + (r[1] - p[1]) * f, y: p[2] + (r[2] - p[2]) * f, angle: p[3] / 1000 + da * f, flags: r[9] };
      });
      const prevR = new Map(a.data.r.map((r) => [r[0], r]));
      const rockets = b.data.r.map((r) => {
        const p = prevR.get(r[0]);
        return p ? [p[1] + (r[1] - p[1]) * f, p[2] + (r[2] - p[2]) * f, r[3] / 1000] : [r[1], r[2], r[3] / 1000];
      });
      return { karts, rockets };
    }

    // ---------- Rendering ----------
    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function drawTrack() {
      ctx.fillStyle = '#2f6d2b';
      ctx.fillRect(-500, -500, K.WORLD.w + 1000, K.WORLD.h + 1000);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#4c9a44';
      ctx.lineWidth = K.TRACK_WIDTH + 320;
      ctx.stroke(trackPath);
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = K.TRACK_WIDTH + 18;
      ctx.stroke(trackPath);
      ctx.setLineDash([40, 40]);
      ctx.strokeStyle = '#dc2626';
      ctx.stroke(trackPath);
      ctx.setLineDash([]);
      ctx.strokeStyle = '#4b5563';
      ctx.lineWidth = K.TRACK_WIDTH;
      ctx.stroke(trackPath);
      ctx.setLineDash([30, 40]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 4;
      ctx.stroke(trackPath);
      ctx.setLineDash([]);

      // Checkered start/finish line at sample 0.
      const t = K.TANGENTS[0];
      const c = K.CENTERLINE[0];
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate(Math.atan2(t[1], t[0]));
      const sq = 13;
      for (let i = -K.TRACK_WIDTH / 2; i < K.TRACK_WIDTH / 2; i += sq) {
        for (let j = 0; j < 2; j++) {
          ctx.fillStyle = (Math.round(i / sq) + j) % 2 ? '#fff' : '#111';
          ctx.fillRect(j * sq - sq, i, sq, sq);
        }
      }
      ctx.restore();
    }

    function drawBoxes(boxes, now) {
      K.ITEM_BOXES.forEach((b, i) => {
        if (boxes && !boxes[i]) return;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(now / 600 + i);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(-15, -15, 30, 30);
        const g = ctx.createLinearGradient(-12, -12, 12, 12);
        g.addColorStop(0, '#facc15'); g.addColorStop(0.5, '#ec4899'); g.addColorStop(1, '#3b82f6');
        ctx.fillStyle = g;
        ctx.fillRect(-11, -11, 22, 22);
        ctx.rotate(-(now / 600 + i));
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, 1);
        ctx.restore();
      });
    }

    function drawKart(k, meta, isMe, now) {
      const teamMode = api.room()?.settings.teamMode;
      const team = teamMode ? api.teamById(meta.team) : null;
      ctx.save();
      ctx.translate(k.x, k.y);
      // Name label (unrotated).
      ctx.font = `${isMe ? 'bold ' : ''}14px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      const label = isMe ? 'YOU' : meta.name;
      const w = ctx.measureText(label).width + 10;
      ctx.fillRect(-w / 2, -42, w, 18);
      ctx.fillStyle = team ? team.color : '#fff';
      ctx.fillText(label, 0, -28);

      if (k.flags & 4) { // shield
        ctx.strokeStyle = 'rgba(96,165,250,0.9)';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(0, 0, 28 + Math.sin(now / 100) * 2, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.rotate(k.angle);
      if (k.flags & 2) { // boost flame
        ctx.fillStyle = Math.random() > 0.5 ? '#f97316' : '#facc15';
        ctx.beginPath(); ctx.moveTo(-18, -7); ctx.lineTo(-38 - Math.random() * 12, 0); ctx.lineTo(-18, 7); ctx.fill();
      }
      if ((k.flags & 16) && !(k.flags & 1) && Math.floor(now / 100) % 2) ctx.globalAlpha = 0.5;
      // Wheels
      ctx.fillStyle = '#111';
      ctx.fillRect(-15, -14, 9, 5); ctx.fillRect(-15, 9, 9, 5);
      ctx.fillRect(7, -13, 8, 4); ctx.fillRect(7, 9, 8, 4);
      // Body
      ctx.fillStyle = meta.color;
      ctx.strokeStyle = team ? team.color : (isMe ? '#fff' : '#111');
      ctx.lineWidth = team || isMe ? 3 : 1.5;
      ctx.beginPath();
      ctx.roundRect(-17, -10, 34, 20, 6);
      ctx.fill(); ctx.stroke();
      // Driver
      ctx.fillStyle = '#fde68a';
      ctx.beginPath(); ctx.arc(-2, 0, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillRect(10, -6, 5, 12);
      ctx.restore();
      if (k.flags & 1) {
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('💫', k.x, k.y - 50);
      }
    }

    function drawMinimap(karts, cw, ch, dpr) {
      const size = Math.min(170, Math.min(cw, ch) / dpr * 0.28) * dpr;
      const pad = 12 * dpr;
      const s = size / K.WORLD.w;
      ctx.save();
      ctx.translate(cw - size - pad, ch - size - pad);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.roundRect(-6 * dpr, -6 * dpr, size + 12 * dpr, size + 12 * dpr, 10 * dpr); ctx.fill();
      ctx.scale(s, s);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = K.TRACK_WIDTH * 0.6;
      ctx.lineJoin = 'round';
      ctx.stroke(trackPath);
      for (const k of karts) {
        const meta = kartsByIdx.get(k.idx);
        if (!meta) continue;
        const me = k.idx === myIdx;
        const team = api.room()?.settings.teamMode ? api.teamById(meta.team) : null;
        ctx.fillStyle = team ? team.color : meta.color;
        ctx.beginPath(); ctx.arc(k.x, k.y, me ? 110 : 70, 0, Math.PI * 2); ctx.fill();
        if (me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 40; ctx.stroke(); }
      }
      ctx.restore();
    }

    let boardUpdate = 0;
    function updateHud(now) {
      if (!latest || !info) return;
      const big = q('[data-big]');
      if (latest.phase === 'countdown') {
        const n = Math.ceil(latest.countdown - 1);
        big.textContent = n > 0 ? n : 'GO!';
      } else if (latest.phase === 'racing' && latest.elapsed < 1) big.textContent = 'GO!';
      else big.textContent = '';

      const row = latest.k.find((r) => r[0] === myIdx);
      if (row) {
        const [, , , , , lap, place, item, ammo, flags] = row;
        q('[data-place]').textContent = flags & 8 ? `🏁 #${place}` : `#${place}`;
        q('[data-lap]').textContent = `Lap ${lap}/${info.laps}`;
        q('[data-item]').innerHTML = item ? `${ITEM_ICONS[item]}${ammo > 1 ? `<small>x${ammo}</small>` : ''}` : '';
        q('[data-item]').style.opacity = item ? '1' : '0.35';
      } else {
        q('[data-place]').textContent = '👀';
        q('[data-lap]').textContent = 'Spectating';
        q('[data-item]').style.display = 'none';
      }
      q('[data-time]').textContent = latest.phase === 'racing' ? `${latest.elapsed.toFixed(1)}s` : '';

      if (now - boardUpdate > 300) {
        boardUpdate = now;
        const rows = [...latest.k].sort((a, b) => a[6] - b[6]);
        const shown = rows.slice(0, 10);
        if (row && row[6] > 10) shown.push(row);
        q('[data-board]').innerHTML = shown.map((r) => {
          const meta = kartsByIdx.get(r[0]);
          const team = api.room()?.settings.teamMode ? api.teamById(meta?.team) : null;
          return `<div class="${r[0] === myIdx ? 'me' : ''}">${r[6]}. <span style="color:${team ? team.color : meta?.color}">●</span> ${api.escapeHtml(meta?.name || '?')}${r[9] & 8 ? ' 🏁' : ''}</div>`;
        }).join('');
      }
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      const cw = canvas.width;
      const ch = canvas.height;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#2f6d2b';
      ctx.fillRect(0, 0, cw, ch);
      if (!info) return;

      // Predict my kart locally so steering feels instant.
      if (local && latest?.phase === 'racing') {
        const row = latest.k.find((r) => r[0] === myIdx);
        const finished = row && row[9] & 8;
        K.stepKart(local, finished ? { down: true } : input, dt);
      }

      const view = interpolated();
      const karts = view ? view.karts : [];
      if (local) {
        const me = karts.find((k) => k.idx === myIdx);
        if (me) { me.x = local.x; me.y = local.y; me.angle = local.angle; }
      }

      // Camera: follow me, or the leader when spectating.
      let focus = karts.find((k) => k.idx === myIdx);
      if (!focus && latest) {
        const leader = latest.k.find((r) => r[6] === 1);
        focus = karts.find((k) => leader && k.idx === leader[0]);
      }
      const fx = focus ? focus.x : K.WORLD.w / 2;
      const fy = focus ? focus.y : K.WORLD.h / 2;
      const zoom = Math.min(cw, ch) / 1000;
      ctx.setTransform(zoom, 0, 0, zoom, cw / 2 - fx * zoom, ch / 2 - fy * zoom);

      drawTrack();
      drawBoxes(latest?.x, now);
      if (latest) {
        ctx.font = '26px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const b of latest.b) ctx.fillText('🍌', b[1], b[2]);
      }
      if (view) {
        for (const [x, y, a] of view.rockets) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(a);
          ctx.fillStyle = '#ef4444';
          ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-10, -7); ctx.lineTo(-10, 7); ctx.fill();
          ctx.fillStyle = '#facc15';
          ctx.beginPath(); ctx.moveTo(-10, -4); ctx.lineTo(-20 - Math.random() * 8, 0); ctx.lineTo(-10, 4); ctx.fill();
          ctx.restore();
        }
      }
      ctx.textBaseline = 'alphabetic';
      // Draw me last so I'm always on top.
      const ordered = [...karts].sort((a, b) => (a.idx === myIdx) - (b.idx === myIdx));
      for (const k of ordered) {
        const meta = kartsByIdx.get(k.idx);
        if (meta) drawKart(k, meta, k.idx === myIdx, now);
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (hitFlash > 0) {
        hitFlash -= dt;
        ctx.fillStyle = `rgba(239,68,68,${Math.max(0, hitFlash) * 0.5})`;
        ctx.fillRect(0, 0, cw, ch);
      }
      drawMinimap(karts, cw, ch, dpr);
      updateHud(now);
    }
    raf = requestAnimationFrame(frame);

    return {
      onSnapshot(snap) { onInit(snap.init); },
      onEvent(event, data) {
        if (event === 'game:kart:init') onInit(data);
        else if (event === 'game:kart:state') onState(data);
        else if (event === 'game:kart:hit') {
          if (data.target === myIdx) { hitFlash = 0.8; api.toast('💥 You got hit!'); }
          else if (data.by === myIdx) api.toast(`🎯 You hit ${kartsByIdx.get(data.target)?.name || 'someone'}!`);
        } else if (event === 'game:kart:finish' && data.idx === myIdx) {
          api.toast(`🏁 You finished #${data.place} in ${data.time.toFixed(1)}s!`);
        }
      },
      unmount() {
        cancelAnimationFrame(raf);
        clearInterval(resend);
        clearInterval(pinger);
        ro.disconnect();
        window.removeEventListener('keydown', kd);
        window.removeEventListener('keyup', ku);
        window.removeEventListener('blur', blur);
      },
    };
  },
};
