// Control Room panel widgets: push buttons, toggle switches, faders (0-5), rotary dials (0-9),
// multi-position switches and pull levers. Each widget shows its value instantly (optimistic) and
// tells the game through ctx.act(); server updates win once the local change has settled.
(function () {
  const PALETTE = ['#ff4fa3', '#ffb547', '#22d3ee', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#facc15', '#f472b6'];
  const CHIPS = { Red: '#ef4444', Green: '#22c55e', Blue: '#3b82f6', Pink: '#ec4899', Cyan: '#06b6d4', Lime: '#84cc16', Gold: '#eab308' };
  const HOLD_MS = 700; // ignore server echoes this long after a local change

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function hueOf(name) {
    let h = 7;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function shell(c, inner) {
    const el = document.createElement('div');
    el.className = `cr-mod t-${c.type}`;
    el.dataset.id = c.id;
    el.dataset.label = c.name;
    el.style.setProperty('--hue', hueOf(c.name));
    el.innerHTML = `<div class="cr-plate"><span class="cr-name" data-name>${esc(c.name)}</span><i class="cr-led"></i></div>
      <div class="cr-body">${inner}</div><i class="cr-screw a"></i><i class="cr-screw b"></i>`;
    return el;
  }

  // Shared optimistic-value bookkeeping for stateful controls.
  function valueState(c, render) {
    const st = { value: c.value, server: c.value, holdUntil: 0, dragging: false };
    st.local = (v) => { st.value = v; st.holdUntil = performance.now() + HOLD_MS; render(); };
    st.update = (nc) => {
      st.server = nc.value;
      if (st.dragging || performance.now() < st.holdUntil) return;
      if (st.value !== nc.value) { st.value = nc.value; render(); }
    };
    st.revert = () => { st.holdUntil = 0; st.value = st.server; render(); };
    return st;
  }

  function sendWith(ctx, c, st) {
    return (v) => {
      Promise.resolve(ctx.act(c, v)).then((res) => { if (res && res.ok === false) st.revert(); });
    };
  }

  function keyActivate(el, fn) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
    });
  }

  // ---------- Push button ----------
  function button(c, ctx) {
    const el = shell(c, `<div class="cr-btn" role="button" tabindex="0" aria-label="${esc(c.name)}"><span class="cr-btn-cap"></span></div><span class="cr-engrave">Push</span>`);
    const btn = el.querySelector('.cr-btn');
    let upTimer = 0;
    let downAt = 0;
    const press = (e) => {
      e.preventDefault?.();
      clearTimeout(upTimer);
      downAt = performance.now();
      btn.classList.add('down');
      el.classList.add('lit');
      ctx.act(c);
      ctx.feel('button');
    };
    const release = () => {
      const wait = Math.max(0, 110 - (performance.now() - downAt));
      upTimer = setTimeout(() => { btn.classList.remove('down'); el.classList.remove('lit'); }, wait);
    };
    btn.addEventListener('pointerdown', press);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => btn.addEventListener(ev, release));
    keyActivate(btn, (e) => { press(e); release(); });
    ctx.haptic(btn);
    return { el, update() {} };
  }

  // ---------- Toggle switch ----------
  function toggle(c, ctx) {
    const el = shell(c, `<div class="cr-toggle" role="switch" tabindex="0" aria-label="${esc(c.name)}">
      <span class="cr-tg-lbl on">On</span><span class="cr-tg-well"><span class="cr-tg-nut"></span><span class="cr-tg-bat"></span></span><span class="cr-tg-lbl off">Off</span></div>`);
    const sw = el.querySelector('.cr-toggle');
    const render = () => {
      el.classList.toggle('on', !!st.value);
      sw.setAttribute('aria-checked', String(!!st.value));
    };
    const st = valueState(c, render);
    const send = sendWith(ctx, c, st);
    const flip = (e) => {
      e.preventDefault?.();
      st.local(!st.value);
      send(st.value);
      ctx.feel('toggle');
    };
    sw.addEventListener('pointerdown', flip);
    keyActivate(sw, flip);
    ctx.haptic(sw);
    render();
    return { el, update: st.update };
  }

  // ---------- Vertical fader (0-5) ----------
  function slider(c, ctx) {
    const n = c.max - c.min;
    const ticks = Array.from({ length: n + 1 }, (_, i) => c.max - i).map((v) => `<span data-v="${v}">${v}</span>`).join('');
    const el = shell(c, `<div class="cr-fader" style="--n:${n}">
      <div class="cr-fader-scale">${ticks}</div>
      <div class="cr-fader-track"><i class="cr-fader-fill"></i><div class="cr-fader-cap"><i></i></div></div>
      <div class="cr-fader-scale ticks">${ticks}</div></div>`);
    const fader = el.querySelector('.cr-fader');
    const track = el.querySelector('.cr-fader-track');
    const cap = el.querySelector('.cr-fader-cap');
    const labels = [...el.querySelectorAll('.cr-fader-scale:not(.ticks) span')];
    const render = () => {
      fader.style.setProperty('--pos', (st.value - c.min) / n);
      labels.forEach((s) => s.classList.toggle('on', Number(s.dataset.v) === st.value));
    };
    const st = valueState(c, render);
    const send = sendWith(ctx, c, st);
    const valueAt = (y) => {
      const r = track.getBoundingClientRect();
      const pad = cap.offsetHeight / 2;
      const frac = 1 - (y - r.top - pad) / Math.max(1, r.height - pad * 2);
      return c.min + clamp(Math.round(frac * n), 0, n);
    };
    const move = (e) => {
      const v = valueAt(e.clientY);
      if (v !== st.value) { st.value = v; render(); ctx.feel('slider'); }
    };
    fader.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fader.setPointerCapture?.(e.pointerId);
      st.dragging = true;
      el.classList.add('grab');
      move(e);
    });
    fader.addEventListener('pointermove', (e) => { if (st.dragging) move(e); });
    const end = () => {
      if (!st.dragging) return;
      st.dragging = false;
      el.classList.remove('grab');
      if (st.value !== st.server) { st.local(st.value); send(st.value); }
    };
    fader.addEventListener('pointerup', end);
    fader.addEventListener('pointercancel', end);
    let wheelTimer = 0;
    fader.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = clamp(st.value + (e.deltaY < 0 ? 1 : -1), c.min, c.max);
      if (v === st.value) return;
      st.local(v);
      ctx.feel('slider');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => send(st.value), 220);
    }, { passive: false });
    fader.tabIndex = 0;
    fader.setAttribute('role', 'slider');
    fader.setAttribute('aria-label', c.name);
    fader.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const v = clamp(st.value + d, c.min, c.max);
      if (v !== st.value) { st.local(v); send(v); ctx.feel('slider'); }
    });
    render();
    return { el, update: st.update };
  }

  // ---------- Rotary dial (0-9) ----------
  function dial(c, ctx) {
    const n = c.max - c.min;
    const angleOf = (v) => -135 + ((v - c.min) / n) * 270;
    const pt = (deg, r) => {
      const a = ((deg - 90) * Math.PI) / 180;
      return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r];
    };
    let face = '';
    for (let v = c.min; v <= c.max; v++) {
      const [x, y] = pt(angleOf(v), 45);
      const [tx, ty] = pt(angleOf(v), 36.5);
      face += `<circle class="cr-dot" data-v="${v}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.6"/>`;
      face += `<text class="cr-num" data-v="${v}" x="${tx.toFixed(2)}" y="${(ty + 2.6).toFixed(2)}">${v}</text>`;
    }
    const el = shell(c, `<div class="cr-dial" role="slider" tabindex="0" aria-label="${esc(c.name)}">
      <svg class="cr-dial-face" viewBox="0 0 100 100" aria-hidden="true">${face}</svg>
      <div class="cr-knob"><i class="cr-knob-mark"></i></div></div>`);
    const box = el.querySelector('.cr-dial');
    const dots = [...el.querySelectorAll('.cr-dot')];
    const nums = [...el.querySelectorAll('.cr-num')];
    const render = () => {
      box.style.setProperty('--rot', `${angleOf(st.value)}deg`);
      dots.forEach((d) => d.classList.toggle('on', Number(d.dataset.v) <= st.value));
      nums.forEach((d) => d.classList.toggle('on', Number(d.dataset.v) === st.value));
      box.setAttribute('aria-valuenow', st.value);
    };
    const st = valueState(c, render);
    const send = sendWith(ctx, c, st);
    const move = (e) => {
      const r = box.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * 0.08) return;
      if (ctx.mirrored()) dx = -dx;
      let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (deg > 135) deg = deg > 157 && st.value <= c.min + 1 ? -135 : 135;
      if (deg < -135) deg = deg < -157 && st.value >= c.max - 1 ? 135 : -135;
      const v = c.min + clamp(Math.round(((deg + 135) / 270) * n), 0, n);
      if (v !== st.value) { st.value = v; render(); ctx.feel('dial'); }
    };
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      box.setPointerCapture?.(e.pointerId);
      st.dragging = true;
      el.classList.add('grab');
      move(e);
    });
    box.addEventListener('pointermove', (e) => { if (st.dragging) move(e); });
    const end = () => {
      if (!st.dragging) return;
      st.dragging = false;
      el.classList.remove('grab');
      if (st.value !== st.server) { st.local(st.value); send(st.value); }
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    let wheelTimer = 0;
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = clamp(st.value + (e.deltaY < 0 ? 1 : -1), c.min, c.max);
      if (v === st.value) return;
      st.local(v);
      ctx.feel('dial');
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => send(st.value), 220);
    }, { passive: false });
    box.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const v = clamp(st.value + d, c.min, c.max);
      if (v !== st.value) { st.local(v); send(v); ctx.feel('dial'); }
    });
    render();
    return { el, update: st.update };
  }

  // ---------- Multi-position switch ----------
  function multi(c, ctx) {
    const keys = c.options.map((o, i) => `<div class="cr-key" role="radio" tabindex="0" data-i="${i}"${CHIPS[o] ? ` style="--chip:${CHIPS[o]}"` : ''}>
      <i class="cr-key-light"></i><span>${esc(o)}</span></div>`).join('');
    const el = shell(c, `<div class="cr-multi n${c.options.length}${CHIPS[c.options[0]] ? ' colors' : ''}" role="radiogroup" aria-label="${esc(c.name)}">${keys}</div>`);
    const btns = [...el.querySelectorAll('.cr-key')];
    const render = () => btns.forEach((b, i) => {
      b.classList.toggle('on', i === st.value);
      b.setAttribute('aria-checked', String(i === st.value));
    });
    const st = valueState(c, render);
    const send = sendWith(ctx, c, st);
    btns.forEach((b, i) => {
      const choose = (e) => {
        e.preventDefault?.();
        ctx.feel('multi');
        if (st.value === i) return;
        st.local(i);
        send(i);
      };
      b.addEventListener('pointerdown', choose);
      keyActivate(b, choose);
      ctx.haptic(b);
    });
    render();
    return { el, update: st.update };
  }

  // ---------- Pull lever ----------
  function lever(c, ctx) {
    const el = shell(c, `<div class="cr-lever" role="button" tabindex="0" aria-label="Pull ${esc(c.name)}">
      <div class="cr-lever-slot"></div><i class="cr-lever-arm"></i><i class="cr-lever-base"></i><b class="cr-lever-knob"></b></div><span class="cr-engrave">Pull ▾</span>`);
    const box = el.querySelector('.cr-lever');
    let drag = null;
    let busy = false;
    const setPull = (p) => box.style.setProperty('--pull', p.toFixed(3));
    const fire = () => {
      ctx.act(c);
      ctx.feel('lever');
      el.classList.add('lit');
      setTimeout(() => el.classList.remove('lit'), 260);
    };
    const auto = () => {
      if (busy) return;
      busy = true;
      box.classList.add('auto');
      setPull(1);
      fire();
      setTimeout(() => { box.classList.remove('auto'); setPull(0); busy = false; }, 240);
    };
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (busy) return;
      box.setPointerCapture?.(e.pointerId);
      drag = { y: e.clientY, travel: box.getBoundingClientRect().height * 0.55, pull: 0, fired: false, moved: false };
      box.classList.add('grab');
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = clamp((e.clientY - drag.y) / drag.travel, 0, 1);
      if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
      drag.pull = p;
      setPull(p);
      if (p >= 0.85 && !drag.fired) { drag.fired = true; fire(); }
    });
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      box.classList.remove('grab');
      if (!d.moved && !d.fired) { auto(); return; }
      setPull(0);
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    keyActivate(box, auto);
    return { el, update() {} };
  }

  const BUILDERS = { button, toggle, slider, dial, multi, lever };

  window.CrControls = {
    create(c, ctx) {
      const make = BUILDERS[c.type];
      if (!make) return null;
      return make(c, ctx);
    },
    hueOf,
  };
})();
