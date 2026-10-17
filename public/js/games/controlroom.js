/* global CrSky, CrControls, CrIcons */
window.Games = window.Games || {};

// Control Room client: ship viewport + HUD, the order card, your control panel, team events,
// relay comms and the mission report. The server owns everything; this renders it and sends
// control actions (game:act), asteroid mashes (game:mash) and relays (game:relay).
(function () {
  const EVENT_INFO = {
    asteroid: { icon: 'shield-alert', title: 'Asteroid field', sub: 'Everyone mash DEFLECT, together!', tone: 'danger' },
    blackout: { icon: 'power-off', title: 'Blackout', sub: 'Panels offline: work from memory', tone: 'dark' },
    shuffle: { icon: 'shuffle', title: 'Panel shuffle', sub: 'Your controls swapped places', tone: 'warn' },
    wormhole: { icon: 'orbit', title: 'Wormhole', sub: 'Your panel is mirrored', tone: 'violet' },
    ionstorm: { icon: 'cloud-lightning', title: 'Ion storm', sub: 'Static is scrambling the labels', tone: 'cyan' },
  };
  const GLYPHS = '▚▞▙▟#%&@$?!/\\<>~*';
  const DIFF_LABEL = { cadet: 'Cadet', pilot: 'Pilot', ace: 'Ace' };

  // iOS Safari has no navigator.vibrate; ios-haptics (MIT) gets a native tick out of a hidden switch.
  let hapticLib = null;
  const hapticWaiting = new Set();
  function loadHaptics() {
    if (loadHaptics.started) return;
    loadHaptics.started = true;
    import('/vendor/ios-haptics/dist/index.js').then((m) => {
      hapticLib = m;
      hapticWaiting.forEach((el) => { if (el.isConnected) m.hapticTrigger(el); });
      hapticWaiting.clear();
    }).catch(() => {});
  }
  function attachHaptic(el) {
    if (hapticLib) hapticLib.hapticTrigger(el);
    else hapticWaiting.add(el);
  }
  const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* not allowed yet */ } };

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function mount(el, api) {
    loadHaptics();
    const esc = api.escapeHtml;
    const ico = (n, cls) => CrIcons.svg(n, cls);
    const Sfx = window.Sfx;
    const myId = () => api.myId();

    el.innerHTML = `
      <div class="cr-root" data-root>
        <section class="cr-ship" data-ship>
          <canvas class="cr-sky" data-sky></canvas>
          <div class="cr-glass" aria-hidden="true"></div>
          <div class="cr-banner" data-banner></div>
          <div class="cr-relays" data-relays></div>
          <button class="cr-end cr-end-hud hidden" data-finish-hud title="End the flight for everyone and show the results">${ico('flag')} End flight</button>
          <div class="cr-hud">
            <div class="cr-hud-row">
              <div class="cr-sector" data-sectorbox><small>Sector</small><b data-sector>1</b><i data-sectors></i></div>
              <div class="cr-shipname"><b data-shipname>Control Room</b><small data-crewname></small></div>
              <div class="cr-hull" data-hull>${ico('shield')}<span class="cr-hull-bar"><i data-hullfill></i></span><b data-hullnum>100</b></div>
            </div>
            <div class="cr-hud-chips" data-chips></div>
            <div class="cr-hud-bottom">
              <div class="cr-progress" data-progress><i data-progfill></i><span data-proglabel></span></div>
              <div class="cr-fleet-strip" data-strip></div>
            </div>
          </div>
        </section>
        <section class="cr-order" data-order>
          <div class="cr-card" data-card>
            <div class="cr-card-top"><i class="cr-led"></i><span data-tag>Stand by</span><b class="cr-secs" data-secs></b></div>
            <div class="cr-card-text" data-text>Crew assembling…</div>
            <div class="cr-card-foot" data-foot></div>
            <div class="cr-timer"><i data-timer></i></div>
          </div>
        </section>
        <section class="cr-console" data-console>
          <div class="cr-panel" data-panel></div>
          <div class="cr-dark" aria-hidden="true"><span>${ico('power-off')} Power failure</span></div>
          <div class="cr-mash hidden" data-mash></div>
          <div class="cr-overlay hidden" data-overlay></div>
        </section>
        <aside class="cr-side" data-side>
          <div class="cr-side-block"><h4>${ico('users')} Your crew</h4><div class="cr-crewlist" data-crewlist></div></div>
          <div class="cr-side-block"><h4>${ico('radar')} Fleet<button class="cr-end hidden" data-finish title="End the flight for everyone and show the results">${ico('flag')} End flight</button></h4>
            <div class="cr-board" data-fleet></div></div>
        </aside>
        <div class="cr-vignette" aria-hidden="true"></div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const root = q('[data-root]');
    const panelEl = q('[data-panel]');
    const consoleEl = q('[data-console]');
    const card = q('[data-card]');
    const sky = new CrSky(q('[data-sky]'));

    let S = null; // last state from the server
    const modules = new Map(); // control id -> widget
    let panelIds = [];
    let cardKey = '';
    let deadline = 0;
    let duration = 1;
    let timerMode = 'none'; // order | briefing | warp | event | none
    let lastHull = null;
    let lastEvent = null;
    let lastSector = null;
    let mashLocal = 0;
    let relayedOrder = null;
    let overlayKey = '';
    let alarmAt = 0;
    let raf = 0;
    let scrambleTimer = 0;
    let bannerTimer = 0;
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

    const playerName = (id) => api.playerById(id)?.name || 'Crew';

    // ---------- Panel ----------
    const ctx = {
      act(c, v) { return api.emit('game:act', v === undefined ? { c: c.id } : { c: c.id, v }); },
      feel(type) {
        Sfx.crPress?.(type);
        buzz(type === 'slider' || type === 'dial' ? 5 : type === 'lever' ? 24 : 12);
      },
      mirrored: () => panelEl.classList.contains('mirrored'),
      haptic: attachHaptic,
    };

    function layoutPanel() {
      const n = panelIds.length;
      if (!n) return;
      root.classList.toggle('dense', n >= 6);
      const r = panelEl.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      let best = { cols: 2, score: -Infinity };
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const w = (r.width - (cols - 1) * 10) / cols;
        const h = (r.height - (rows - 1) * 10) / rows;
        // Biggest roughly-square module wins; empty cells cost a little, and modules too short to
        // fit their name and a control cost a lot.
        const score = Math.min(w, h * 1.2) - (cols * rows - n) * 6 - Math.max(0, 118 - h) * 2;
        if (score > best.score) best = { cols, rows, score };
      }
      panelEl.style.setProperty('--cols', best.cols);
      panelEl.style.setProperty('--rows', best.rows);
      // No hole in the grid: the last module stretches over any empty cells.
      const mods = [...panelEl.children];
      mods.forEach((m, i) => { m.style.gridColumn = i === mods.length - 1 && best.cols * best.rows > n ? `span ${best.cols * best.rows - n + 1}` : ''; });
    }
    const ro = new ResizeObserver(() => layoutPanel());
    ro.observe(panelEl);

    function renderPanel(list) {
      const ids = list.map((c) => c.id);
      const sameSet = ids.length === panelIds.length && ids.every((id) => modules.has(id));
      if (!sameSet) {
        const fresh = !panelIds.some((id) => ids.includes(id));
        const keep = new Map();
        for (const [id, m] of modules) if (ids.includes(id)) keep.set(id, m);
        modules.clear();
        panelEl.textContent = '';
        list.forEach((c, i) => {
          let m = keep.get(c.id);
          if (!m) {
            m = CrControls.create(c, ctx);
            if (!m) return;
            if (fresh) { m.el.classList.add('enter'); m.el.style.setProperty('--i', i); later(() => m.el.classList.remove('enter'), 900 + i * 60); } else {
              m.el.classList.add('arrive');
              later(() => m.el.classList.remove('arrive'), 1200);
            }
          }
          modules.set(c.id, m);
          panelEl.appendChild(m.el);
        });
        panelIds = ids;
        layoutPanel();
        scrambleNames(S?.crew?.event?.type === 'ionstorm');
      } else if (ids.join() !== panelIds.join()) {
        // Panel shuffle: slide every module from its old spot to the new one (FLIP).
        const before = new Map(ids.map((id) => [id, modules.get(id).el.getBoundingClientRect()]));
        ids.forEach((id) => panelEl.appendChild(modules.get(id).el));
        panelIds = ids;
        layoutPanel();
        ids.forEach((id) => {
          const m = modules.get(id).el;
          const a = before.get(id);
          const b = m.getBoundingClientRect();
          const dx = a.left - b.left;
          const dy = a.top - b.top;
          if (!dx && !dy) return;
          m.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(${(Math.random() - 0.5) * 16}deg)` }, { transform: 'none' }],
            { duration: 650, easing: 'cubic-bezier(.2, 1.3, .4, 1)' });
        });
      }
      for (const c of list) modules.get(c.id)?.update(c);
    }

    function scrambleNames(on) {
      clearInterval(scrambleTimer);
      const names = [...panelEl.querySelectorAll('[data-name]')];
      const restore = () => names.forEach((n) => {
        const id = n.closest('.cr-mod')?.dataset.id;
        const c = S?.panel.find((x) => x.id === id);
        if (c) n.textContent = c.name;
      });
      if (!on) { restore(); return; }
      scrambleTimer = setInterval(() => {
        names.forEach((n) => {
          const id = n.closest('.cr-mod')?.dataset.id;
          const c = S?.panel.find((x) => x.id === id);
          if (!c) return;
          n.textContent = [...c.name].map((ch) => (ch !== ' ' && Math.random() < 0.42 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : ch)).join('');
        });
      }, 130);
    }

    // ---------- HUD ----------
    function renderHud(s) {
      const crew = s.crew;
      root.style.setProperty('--crew', crew?.color || '#7c5cff');
      if (crew) {
        q('[data-sector]').textContent = crew.sector;
        q('[data-sectors]').textContent = s.sectors ? `/${s.sectors}` : '∞';
        q('[data-shipname]').textContent = crew.ship;
        q('[data-crewname]').innerHTML = `${esc(crew.name)} crew<span class="cr-diff"> · ${DIFF_LABEL[s.difficulty] || ''}</span>`;
        const hull = Math.round(crew.hull);
        q('[data-hullnum]').textContent = hull;
        q('[data-hullfill]').style.transform = `scaleX(${hull / 100})`;
        root.classList.toggle('hull-low', hull <= 30 && crew.status === 'flying');
        root.classList.toggle('hull-mid', hull > 30 && hull <= 60);
        const pct = crew.goal ? crew.progress / crew.goal : 0;
        q('[data-progfill]').style.transform = `scaleX(${crew.status === 'warping' || crew.status === 'done' ? 1 : pct})`;
        q('[data-proglabel]').textContent = crew.status === 'warping' ? 'Warp drive engaged'
          : crew.status === 'done' ? 'All sectors cleared'
            : `${crew.progress} / ${crew.goal} orders to warp`;
      } else if (s.fleet.length) {
        q('[data-shipname]').textContent = 'Fleet view';
        q('[data-crewname]').textContent = 'Spectating';
        q('[data-sector]').textContent = Math.max(...s.fleet.map((x) => x.sector));
        q('[data-sectors]').textContent = s.sectors ? `/${s.sectors}` : '∞';
      }
      renderChips(s);
      renderStrip(s.fleet);
      renderCrewList(s);
      renderBoard(q('[data-fleet]'), s.fleet);
    }

    let finalEnds = 0;
    function renderChips(s) {
      if (s.finalIn !== null && s.finalIn !== undefined) {
        const want = performance.now() + s.finalIn;
        if (Math.abs(want - finalEnds) > 1000) finalEnds = want;
      }
      const chips = [];
      const ev = s.crew?.event;
      if (ev) {
        const info = EVENT_INFO[ev.type];
        chips.push(`<span class="cr-chip ev-${ev.type}">${ico(info.icon)}${info.title}<b data-evsecs></b></span>`);
      }
      if (s.finalIn !== null && s.finalIn !== undefined) {
        chips.push(`<span class="cr-chip final">${ico('flag')}Final countdown <b data-finalsecs></b></span>`);
      }
      if (s.comms === 'relay') chips.push(`<span class="cr-chip comms">${ico('radio-tower')}Relay comms</span>`);
      const html = chips.join('');
      const box = q('[data-chips]');
      if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
    }

    function renderStrip(fleet) {
      const mine = S?.crew?.id;
      const box = q('[data-strip]');
      const html = fleet.length > 1 ? fleet.map((c) => `<span class="cr-strip-item ${c.id === mine ? 'me' : ''} st-${c.status}" style="--c:${c.color}" title="${esc(c.ship)}: sector ${c.sector}">
        <b>${c.status === 'destroyed' ? '✕' : c.sector}</b><i style="transform:scaleX(${c.status === 'done' ? 1 : c.progress})"></i></span>`).join('') : '';
      if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
    }

    function boardHtml(fleet) {
      const mine = S?.crew?.id;
      const ranked = [...fleet].sort((a, b) => (b.status === 'done') - (a.status === 'done') || b.sector - a.sector || b.progress - a.progress);
      return ranked.map((c, i) => {
        const status = { flying: c.event ? EVENT_INFO[c.event]?.title || 'Flying' : 'Flying', warping: 'Warping', done: 'Cleared!', destroyed: 'Destroyed', abandoned: 'Abandoned' }[c.status];
        return `<div class="cr-board-row st-${c.status} ${c.id === mine ? 'me' : ''}" style="--c:${c.color}">
          <span class="cr-rank">${i + 1}</span>
          <div class="cr-board-main"><b>${esc(c.ship)}</b><small>${esc(c.name)} · ${c.online}/${c.crew} aboard · ${status}</small>
            <div class="cr-board-bar"><i style="transform:scaleX(${c.status === 'done' ? 1 : c.progress})"></i></div></div>
          <div class="cr-board-stats"><b>S${c.sector}</b><small>${ico('shield')}${Math.round(c.hull)}</small></div>
        </div>`;
      }).join('');
    }

    function renderBoard(box, fleet) {
      if (!box) return;
      const html = boardHtml(fleet);
      if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
    }

    function renderCrewList(s) {
      const box = q('[data-crewlist]');
      if (!s.crew) { box.innerHTML = '<p class="muted small">You’re watching this flight.</p>'; return; }
      const html = s.crew.members.map((m) => `<div class="cr-mate ${m.connected ? '' : 'off'} ${m.id === myId() ? 'me' : ''}">
        ${api.avatarHtml(m.avatar)}<span class="cr-mate-name">${esc(m.name)}${m.id === myId() ? ' <small>(you)</small>' : ''}</span>
        <i class="cr-mate-dot"></i><small class="cr-mate-n">${m.connected ? `${m.controls} controls` : 'offline'}</small></div>`).join('');
      if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
    }

    // ---------- Order card ----------
    function setCard(key, { tag, text, foot = '', tone = '', mode = 'none', ms = 0, total = 1 }) {
      timerMode = mode;
      if (mode !== 'none') {
        // Re-sync the countdown only when it drifted, so the bar stays smooth.
        const want = performance.now() + ms;
        if (key !== cardKey || Math.abs(want - deadline) > 300) deadline = want;
        duration = Math.max(1, total);
      }
      if (key === cardKey) return;
      const isNewOrder = key.startsWith('o:') && cardKey !== key;
      cardKey = key;
      // Keep a green/red flash that is still playing (the order's result arrives just before the
      // card moves on to the next one).
      const flash = ['success', 'fail'].filter((c) => card.classList.contains(c));
      card.className = `cr-card ${tone}`;
      for (const c of flash) card.classList.add(c);
      q('[data-tag]').innerHTML = tag;
      q('[data-text]').innerHTML = text;
      q('[data-foot]').innerHTML = foot;
      if (isNewOrder) {
        card.classList.add('incoming');
        later(() => card.classList.remove('incoming'), 600);
      }
    }

    function renderOrder(s) {
      const crew = s.crew;
      const crewNames = crew ? crew.members.filter((m) => m.id !== myId()).map((m) => esc(m.name)).join(', ') : '';
      if (!crew) {
        setCard('spec', { tag: `${ico('satellite')} Spectating`, text: 'Watching the fleet', foot: 'You’ll get a seat in the next game.', tone: 'idle' });
        return;
      }
      if (crew.status === 'destroyed') { setCard('dead', { tag: `${ico('skull')} Ship lost`, text: 'Your ship was destroyed', tone: 'bad' }); return; }
      if (crew.status === 'done') { setCard('done', { tag: `${ico('trophy')} Mission complete`, text: 'Every sector cleared!', tone: 'good' }); return; }
      if (crew.status === 'warping') {
        setCard(`warp:${crew.sector}`, { tag: `${ico('rocket')} Warp drive`, text: `Jumping to <b>sector ${crew.sector + 1}</b>`, tone: 'warp', mode: 'warp', ms: crew.warpIn, total: 3800 });
        return;
      }
      if (s.phase === 'briefing') {
        setCard('brief', {
          tag: `${ico('users')} Briefing`,
          text: 'Get to know your panel. <b>Orders incoming!</b>',
          foot: s.comms === 'relay' ? `Read orders out, or tap your order to flash it on your crew’s screens.${crewNames ? ` Crew: ${crewNames}` : ''}`
            : `Shout the orders you get. Whoever has that control does it!${crewNames ? ` Crew: ${crewNames}` : ''}`,
          tone: 'idle', mode: 'briefing', ms: s.briefingIn, total: 5000,
        });
        return;
      }
      if (crew.event?.type === 'asteroid') {
        setCard('ast', { tag: `${ico('siren')} Red alert`, text: 'Asteroids! <b>Mash DEFLECT</b>', tone: 'bad', mode: 'event', ms: crew.event.endsIn, total: crew.event.duration });
        return;
      }
      const o = s.order;
      if (!o) { setCard('idle', { tag: `${ico('activity')} Standing by`, text: 'Next order incoming…', tone: 'idle' }); return; }
      const relay = s.comms === 'relay';
      const relayed = relayedOrder === o.id || !!o.relayed;
      setCard(`o:${o.id}:${relayed}`, {
        tag: `${ico('megaphone')} ${relay ? 'Order' : 'Shout it!'}`,
        text: `${esc(o.pre)} <b class="cr-target">${esc(o.name)}</b>${o.post ? ` ${esc(o.post)}` : ''}`,
        foot: relay ? (relayed ? `${ico('circle-check')} Relayed to your crew` : `${ico('radio-tower')} Tap to relay to your crew`) : '',
        tone: `order${relay ? ' relay' : ''}${relayed ? ' relayed' : ''}`,
        mode: 'order',
        ms: o.expiresIn,
        total: o.duration,
      });
    }

    card.addEventListener('pointerdown', async () => {
      if (S?.comms !== 'relay' || !S?.order || relayedOrder === S.order.id) return;
      const id = S.order.id;
      const res = await api.emit('game:relay');
      if (res.ok) {
        relayedOrder = id;
        buzz(10);
        renderOrder(S);
      } else if (res.error) api.toast(res.error);
    });
    attachHaptic(card);

    const bar = q('[data-timer]');
    const secs = q('[data-secs]');
    const chipsBox = q('[data-chips]');
    // Only touch the DOM when a value actually changes.
    const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
    function timerFrame() {
      raf = requestAnimationFrame(timerFrame);
      if (timerMode === 'none') {
        bar.style.transform = 'scaleX(0)';
        setText(secs, '');
        card.classList.remove('urgent');
      } else {
        const left = Math.max(0, deadline - performance.now());
        const frac = Math.min(1, left / duration);
        bar.style.transform = `scaleX(${frac})`;
        if (timerMode === 'order') {
          bar.style.setProperty('--h', `${Math.round(frac * 130)}`);
          card.classList.toggle('urgent', frac < 0.3);
        } else {
          bar.style.setProperty('--h', timerMode === 'event' ? '0' : '200');
          card.classList.remove('urgent');
        }
        setText(secs, timerMode === 'order' || timerMode === 'briefing' || timerMode === 'event' ? `${Math.ceil(left / 1000)}s` : '');
      }
      // The event and final countdowns and the hull alarm run with or without an order on the card.
      const ev = chipsBox.querySelector('[data-evsecs]');
      if (ev && S?.crew?.event) setText(ev, `${Math.max(0, Math.ceil(((S.crew.event._localEnds || 0) - performance.now()) / 1000))}s`);
      const fin = chipsBox.querySelector('[data-finalsecs]');
      if (fin) setText(fin, fmtTime(finalEnds - performance.now()));
      // Hull alarm.
      if (root.classList.contains('hull-low') && performance.now() > alarmAt) {
        alarmAt = performance.now() + 5200;
        Sfx.crAlarm?.();
      }
    }
    raf = requestAnimationFrame(timerFrame);

    // ---------- Events, mash, overlays ----------
    function banner(iconName, title, sub, tone, ms = 2400) {
      const b = q('[data-banner]');
      b.className = `cr-banner show ${tone}`;
      b.innerHTML = `<span class="cr-banner-ico">${ico(iconName)}</span><div><b>${title}</b><small>${sub}</small></div>`;
      clearTimeout(bannerTimer);
      bannerTimer = later(() => b.classList.remove('show'), ms);
    }

    function renderEvent(s) {
      const crew = s.crew;
      const ev = crew && crew.status === 'flying' ? crew.event : null;
      const type = ev?.type || null;
      if (ev) ev._localEnds = performance.now() + ev.endsIn;
      root.dataset.event = type || '';
      consoleEl.classList.toggle('blackout', type === 'blackout');
      panelEl.classList.toggle('mirrored', type === 'wormhole');
      if (type !== lastEvent) {
        if (lastEvent === 'ionstorm' || type === 'ionstorm') scrambleNames(type === 'ionstorm');
        if (type === 'asteroid') mashLocal = 0;
        lastEvent = type;
      }
      sky.setMode({ warp: crew?.status === 'warping', event: type, dead: crew?.status === 'destroyed' });
      renderMash(s);
    }

    function renderMash(s) {
      const box = q('[data-mash]');
      const ev = s.crew?.status === 'flying' ? s.crew.event : null;
      if (ev?.type !== 'asteroid') { box.classList.add('hidden'); box.dataset.built = ''; return; }
      const mineServer = ev.mash?.[myId()] || 0;
      mashLocal = Math.max(mashLocal, mineServer);
      if (!box.dataset.built) {
        box.dataset.built = '1';
        box.innerHTML = `<div class="cr-mash-inner">
          <div class="cr-mash-head">${ico('siren')}<b>Asteroid field</b><span>Everyone mash until your bar is full!</span></div>
          <div class="cr-mash-btn" role="button" tabindex="0" data-mashbtn><svg viewBox="0 0 100 100" class="cr-mash-ring"><circle cx="50" cy="50" r="46"/><circle class="fg" cx="50" cy="50" r="46" data-mashring/></svg><span>Deflect</span><small data-mashcount></small></div>
          <div class="cr-mash-crew" data-mashcrew></div></div>`;
        const btn = box.querySelector('[data-mashbtn]');
        const hit = (e) => {
          e.preventDefault?.();
          mashLocal++;
          btn.classList.remove('pop');
          void btn.offsetWidth;
          btn.classList.add('pop');
          Sfx.crPress?.('button');
          buzz(9);
          api.emit('game:mash');
          renderMash(S);
        };
        btn.addEventListener('pointerdown', hit);
        btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') hit(e); });
        attachHaptic(btn);
      }
      box.classList.remove('hidden');
      const quota = ev.quota || 1;
      const mine = Math.min(quota, mashLocal);
      const ring = box.querySelector('[data-mashring]');
      ring.style.strokeDashoffset = `${289 * (1 - mine / quota)}`;
      box.querySelector('[data-mashcount]').textContent = mine >= quota ? 'Done! Help them out' : `${quota - mine} more`;
      box.classList.toggle('full', mine >= quota);
      box.querySelector('[data-mashcrew]').innerHTML = s.crew.members.filter((m) => m.connected).map((m) => {
        const n = m.id === myId() ? mine : Math.min(quota, ev.mash?.[m.id] || 0);
        return `<div class="cr-mash-mate ${n >= quota ? 'full' : ''}">${api.avatarHtml(m.avatar)}<span><i style="transform:scaleX(${n / quota})"></i></span></div>`;
      }).join('');
    }

    async function endFlight() {
      if (!confirm('End the flight for everyone and show the results?')) return;
      const res = await api.emit('game:finish');
      if (!res.ok && res.error) api.toast(res.error);
    }
    q('.cr-end').addEventListener('click', endFlight);
    q('[data-finish-hud]').addEventListener('click', endFlight);

    function renderOverlay(s) {
      const box = q('[data-overlay]');
      const crew = s.crew;
      let key = '';
      let html = '';
      const host = api.isHost();
      const endBtn = host && s.phase !== 'over' ? `<button class="btn small" data-finish>${ico('flag')} End the flight and show results</button>` : '';
      // The button is the host's: a new host gets it too.
      const hostKey = host ? ':host' : '';
      const others = s.fleet.filter((c) => c.status === 'flying' || c.status === 'warping').length;
      if (!crew) {
        key = 'spec';
        html = `<div class="cr-ov-card"><div class="cr-ov-ico">${ico('satellite')}</div><h2>Watching the fleet</h2>
          <p>This flight is already underway. You’ll get a seat on a ship next game.</p><div class="cr-board big" data-ovboard></div>${endBtn}</div>`;
      } else if (crew.status === 'destroyed' || crew.status === 'abandoned') {
        key = 'dead';
        html = `<div class="cr-ov-card bad"><div class="cr-ov-ico">${ico('skull')}</div><h2>Ship destroyed</h2>
          <p>The ${esc(crew.ship)} broke apart in sector ${crew.sector}.${others ? ' Watch the rest of the fleet:' : ''}</p><div class="cr-board big" data-ovboard></div>${others ? endBtn : ''}</div>`;
      } else if (crew.status === 'done') {
        key = 'done';
        html = `<div class="cr-ov-card good"><div class="cr-ov-ico">${ico('trophy')}</div><h2>Mission complete!</h2>
          <p>All ${s.sectors} sectors cleared.${others ? ' The others have a final minute to catch up:' : ''}</p><div class="cr-board big" data-ovboard></div>${others ? endBtn : ''}</div>`;
      } else if (crew.status === 'warping') {
        key = `warp${crew.sector}`;
        html = `<div class="cr-warp"><div class="cr-warp-lines"></div><small>Warp drive engaged</small><h2>Sector ${crew.sector + 1}</h2><p>${ico('wrench')} Hull patched up · new controls coming online</p></div>`;
      }
      const fullKey = key ? key + hostKey : '';
      if (fullKey !== overlayKey) {
        overlayKey = fullKey;
        box.innerHTML = html;
        box.classList.toggle('hidden', !key);
        box.querySelector('[data-finish]')?.addEventListener('click', endFlight);
      }
      renderBoard(box.querySelector('[data-ovboard]'), s.fleet);
      root.classList.toggle('overlaid', !!key);
    }

    // ---------- State ----------
    function apply(s) {
      S = s;
      const crew = s.crew;
      if (crew) sky.setTheme(crew.sector, crew.color);
      renderHud(s);
      renderPanel(crew && (crew.status === 'flying' || crew.status === 'warping') ? s.panel : []);
      renderEvent(s);
      renderOrder(s);
      renderOverlay(s);
      if (crew) {
        if (lastHull !== null && crew.hull > lastHull) floater(`+${crew.hull - lastHull}`, 'good', q('[data-hull]'));
        lastHull = crew.hull;
        if (lastSector !== null && crew.sector !== lastSector && crew.status === 'flying') {
          banner('rocket', `Sector ${crew.sector}`, `${s.panel.length} controls each · faster orders`, 'violet', 2200);
        }
        lastSector = crew.sector;
      }
      root.classList.toggle('briefing', s.phase === 'briefing');
      q('.cr-end').classList.toggle('hidden', !api.isHost());
      q('[data-finish-hud]').classList.toggle('hidden', !api.isHost() || s.phase === 'over');
    }

    function floater(text, tone, anchor) {
      const r = anchor.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      const f = document.createElement('div');
      f.className = `cr-floater ${tone}`;
      f.textContent = text;
      f.style.left = `${r.left - rr.left + r.width / 2}px`;
      f.style.top = `${r.top - rr.top}px`;
      root.appendChild(f);
      later(() => f.remove(), 1300);
    }

    function hitFx(strength = 1) {
      root.classList.remove('hit', 'soft');
      void root.offsetWidth;
      root.classList.add('hit');
      root.classList.toggle('soft', strength < 1);
      later(() => root.classList.remove('hit', 'soft'), 500);
      sky.hit('255,50,70', strength);
    }

    function relayToast(d) {
      const box = q('[data-relays]');
      const t = document.createElement('div');
      t.className = 'cr-relay';
      t.style.setProperty('--ms', `${d.ms}ms`);
      t.innerHTML = `${api.avatarHtml(d.avatar)}<div><small>${ico('radio-tower')} ${esc(d.name || 'Crew')} needs</small>
        <b>${esc(d.pre)} <em>${esc(d.control)}</em>${d.post ? ` ${esc(d.post)}` : ''}</b></div><i class="cr-relay-bar"></i>`;
      box.prepend(t);
      while (box.children.length > 3) box.lastChild.remove();
      later(() => { t.classList.add('out'); later(() => t.remove(), 300); }, d.ms);
    }

    function onFx(d) {
      const me = myId();
      switch (d.kind) {
        case 'done': {
          if (d.holder === me) {
            card.classList.remove('success');
            void card.offsetWidth;
            card.classList.add('success');
            later(() => card.classList.remove('success'), 900);
            Sfx.crGood?.();
            buzz([12, 50, 22]);
            if (d.by !== me) banner('circle-check', `${esc(playerName(d.by))} did it!`, esc(d.text), 'good', 1500);
          } else if (d.by === me) {
            Sfx.crGood?.();
            buzz(16);
          }
          const m = modules.get(d.control);
          if (m && d.by === me) {
            m.el.classList.remove('hit');
            void m.el.offsetWidth;
            m.el.classList.add('hit');
            later(() => m.el.classList.remove('hit'), 900);
            floater('+1', 'good', m.el);
          }
          floater('+1', 'good', q('[data-progress]'));
          break;
        }
        case 'expired':
          if (d.holder === me) {
            card.classList.remove('fail');
            void card.offsetWidth;
            card.classList.add('fail');
            later(() => card.classList.remove('fail'), 900);
            buzz([70, 40, 70]);
          }
          Sfx.crFail?.();
          hitFx(d.holder === me ? 1 : 0.55);
          floater(`−${d.damage}`, 'bad', q('[data-hull]'));
          break;
        case 'event': {
          const info = EVENT_INFO[d.type];
          banner(info.icon, info.title, info.sub, info.tone, 2600);
          Sfx.crEvent?.();
          if (d.type === 'blackout') Sfx.crPowerDown?.();
          if (d.type === 'asteroid') { Sfx.crAlarm?.(); buzz([40, 60, 40]); }
          if (d.type === 'shuffle') buzz([10, 30, 10, 30, 10]);
          break;
        }
        case 'eventEnd':
          if (d.type === 'asteroid') {
            if (d.success) { banner('shield', 'Asteroids deflected!', 'Great teamwork, crew', 'good', 1800); Sfx.crGood?.(); } else {
              banner('triangle-alert', 'Asteroid impact!', `Hull breach −${d.damage}`, 'danger', 2000);
              Sfx.explosion?.(0.6);
              hitFx(1.4);
              floater(`−${d.damage}`, 'bad', q('[data-hull]'));
              buzz([120, 50, 120]);
            }
          }
          break;
        case 'warp':
          Sfx.crWarp?.();
          buzz([20, 80, 20, 80, 160]);
          break;
        case 'complete':
          Sfx.finish?.();
          banner('trophy', 'Mission complete!', 'Every sector cleared', 'good', 3000);
          break;
        case 'destroyed':
          Sfx.explosion?.(1);
          hitFx(2.4);
          sky.hit('255,180,120', 1.6);
          buzz([200, 80, 300]);
          break;
        case 'relay':
          if (d.from !== me) { relayToast(d); Sfx.crRelay?.(); buzz(14); }
          break;
        default:
      }
    }

    function onFleet(d) {
      if (!S) return;
      S.fleet = d.fleet;
      S.finalIn = d.finalIn;
      renderChips(S);
      renderStrip(d.fleet);
      renderBoard(q('[data-fleet]'), d.fleet);
      renderBoard(q('[data-ovboard]'), d.fleet);
      if (!S.crew) {
        q('[data-sector]').textContent = Math.max(...d.fleet.map((x) => x.sector));
      }
    }

    // Phones: the game fills the screen below the top bar (the chat scrolls in underneath).
    const setTop = () => {
      const bar = document.querySelector('.topbar');
      if (bar) document.documentElement.style.setProperty('--cr-top', `${bar.offsetHeight + 8}px`);
    };
    setTop();
    // If you'd scrolled down the lobby (players, chat) on a phone, bring the console into view.
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'instant' });
    const onResize = () => { setTop(); layoutPanel(); };
    window.addEventListener('resize', onResize);

    return {
      onSnapshot(snap) { apply(snap); },
      onEvent(event, data) {
        if (event === 'game:cr:state') apply(data);
        else if (event === 'game:cr:fx') onFx(data);
        else if (event === 'game:cr:fleet') onFleet(data);
      },
      // A new host gets the End flight buttons at once.
      onRoomState() { if (S) apply(S); },
      unmount() {
        cancelAnimationFrame(raf);
        clearInterval(scrambleTimer);
        timers.forEach((t) => clearTimeout(t));
        ro.disconnect();
        sky.destroy();
        window.removeEventListener('resize', onResize);
      },
    };
  }

  // ---------- Mission report (results view) ----------
  function renderResults(r, els, api) {
    const esc = api.escapeHtml;
    const ico = (n, cls) => CrIcons.svg(n, cls);
    const len = r.sectors ? `${r.sectors} sectors` : 'Endless';
    els.title.innerHTML = `<span class="cr-res-kicker">Control Room · ${DIFF_LABEL[r.difficulty] || ''} · ${len}</span>Mission report`;
    const crews = r.crews || [];
    const statusText = (c) => ({
      done: `${ico('trophy')} Cleared all ${r.sectors} sectors in ${fmtTime(c.time)}`,
      destroyed: `${ico('skull')} Destroyed in sector ${c.sector}`,
      abandoned: `${ico('satellite')} Abandoned in sector ${c.sector}`,
      flying: `${ico('rocket')} Still flying in sector ${c.sector}`,
    }[c.status] || '');
    els.teams.innerHTML = `<div class="cr-res-crews">${crews.map((c) => `
      <div class="cr-res-crew ${c.rank === 1 ? 'win' : ''} st-${c.status}" style="--c:${c.color}">
        <div class="cr-res-rank">${c.rank === 1 && crews.length > 1 ? ico('crown') : `#${c.rank}`}</div>
        <div class="cr-res-main">
          <b>${esc(c.ship)}</b><small><span>${esc(c.name)} crew</span><span>${statusText(c)}</span></small>
          <div class="cr-res-bar"><i style="transform:scaleX(${r.sectors ? Math.min(1, (c.cleared + (c.status === 'done' ? 0 : c.progress)) / r.sectors) : Math.min(1, c.progress)})"></i></div>
          <div class="cr-res-mates">${c.members.map((m) => `<span>${api.avatarHtml(m.avatar)}${esc(m.name)}</span>`).join('')}</div>
        </div>
        <div class="cr-res-big"><b>${c.sector}</b><small>${c.status === 'done' ? 'sectors' : `sector · ${Math.round(c.progress * 100)}%`}</small></div>
      </div>`).join('')}</div>`;
    els.podium.innerHTML = (r.awards || []).length ? `<div class="cr-awards">${r.awards.map((a) => `
      <div class="cr-award">${api.avatarHtml(a.who.avatar)}<div><small>${esc(a.title)}</small><b>${esc(a.who.name)}</b><span>${a.who.value} ${esc(a.who.value === 1 && a.one ? a.one : a.desc)}</span></div></div>`).join('')}</div>` : '';
    const crewOf = (p) => crews.find((c) => c.id === p.crew);
    els.list.innerHTML = `<li class="cr-res-row head"><span></span><span>Crew member</span><span title="Orders completed">Done</span><span title="Your orders your crewmates completed">Heard</span><span title="Presses that did nothing">Panic</span></li>${(r.players || []).map((p, i) => `
      <li class="cr-res-row"><span class="rank">${i + 1}</span><span class="nm">${api.avatarHtml(p.avatar, '', crewOf(p)?.color || null)}${esc(p.name)}</span>
      <span class="num">${p.done}</span><span class="num">${p.mine}</span><span class="num muted">${p.panic}</span></li>`).join('')}`;
  }

  window.Games.controlroom = { mount, renderResults };
})();
