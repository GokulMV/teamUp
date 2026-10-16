/* global ItemIcons, Avatars */
// Kart Battle HUD kit: the glass panels over the 3D view (place/health card, leaderboard, kill
// feed, callouts, death card, hit marker, low-health vignette). All icons are inline SVG, never
// emoji, so they look the same on every device. kart.js owns the markup and feeds this the state.
(function () {
  const ICONS = {
    heart: '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8.2 3.2 4.5 7 4.5c2.1 0 3.6 1.1 5 3 1.4-1.9 2.9-3 5-3 3.8 0 6 3.7 4.5 7.3C19.5 16.4 12 21 12 21z" fill="#ff4f6d" stroke="#fff" stroke-width="1.6"/></svg>',
    cross: '<svg viewBox="0 0 24 24" class="hud-ic" fill="none" stroke="#ffb547" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
    skull: '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M12 3C7 3 4 6.4 4 10.6c0 2.6 1.2 4.4 3 5.4V19a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3c1.8-1 3-2.8 3-5.4C20 6.4 17 3 12 3z" fill="#e5e7eb"/><circle cx="9" cy="11" r="2.2" fill="#160f35"/><circle cx="15" cy="11" r="2.2" fill="#160f35"/><path d="M10 17v2M12 17v2M14 17v2" stroke="#160f35" stroke-width="1.2"/></svg>',
    lava: '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M3 20h18l-5.5-9-2 3-2.5-6-3 6-1.5-2z" fill="#ff6a1a"/><path d="M8 20c1-2 2.5-2 3.5 0M13 20c1-2.4 3-2.4 4 0" stroke="#ffd166" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="17" cy="6" r="1.6" fill="#ffb547"/><circle cx="7" cy="4.5" r="1.2" fill="#ffb547"/></svg>',
    flag: '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M5 3v18" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M6 4h13l-2.5 4.5L19 13H6z" fill="#fff"/><path d="M6 4h3.25v3H6zM12.5 4h3.25v3H12.5zM9.25 7h3.25v3H9.25zM15.75 7h1.9l-.9 1.5.9 1.5h-1.9zM6 10h3.25v3H6zM12.5 10h3.25v3H12.5z" fill="#160f35"/></svg>',
    eye: '<svg viewBox="0 0 24 24" class="hud-ic" fill="none" stroke="#fff" stroke-width="2"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="#fff"/></svg>',
    flame: '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 1.5-4.5 2.5-5.5.2 1.8 1 3 2 3.5C10 8 11 5 12 2z" fill="#ff7a1a"/><path d="M12 12c.5 2 3 2.6 3 5a3 3 0 0 1-6 0c0-1.2.6-2 1.2-2.5.2.9.6 1.3 1 1.5-.2-1.6.2-2.9.8-4z" fill="#ffd166"/></svg>',
    boom: '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M12 1.5l2.2 5.6 5.4-2.6-2.4 5.5 5.3 2.3-5.6 1.8 2 5.7-5.3-2.8L12 22.5l-1.6-5.5-5.3 2.8 2-5.7L1.5 12.3l5.3-2.3-2.4-5.5 5.4 2.6z" fill="#ffb547" stroke="#ff4f1f" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  };
  ICONS.water = '<svg viewBox="0 0 24 24" class="hud-ic"><path d="M12 2.5c3 4.2 6 7.4 6 11a6 6 0 0 1-12 0c0-3.6 3-6.8 6-11z" fill="#38bdf8"/><path d="M9.2 14.5a3 3 0 0 0 2.6 3" stroke="#e0f2fe" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M2 21c1.7-1.3 3.3-1.3 5 0s3.3 1.3 5 0 3.3-1.3 5 0 3.3 1.3 5 0" stroke="#7dd3fc" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
  ICONS.drop = '<svg viewBox="0 0 24 24" class="hud-ic" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h7M14 9h7" stroke="#e5e7eb" stroke-width="2.4"/><path d="M12 6v10M8 12.5l4 4 4-4" stroke="#ffb547" stroke-width="2.6"/><path d="M8 21h8" stroke="#ffb547" stroke-width="2" opacity="0.5"/></svg>';
  // Weapon that did it -> ItemIcons id (items not listed use their own id when an icon exists).
  const KIND_ICON = {
    bullet: 'minigun', triple: 'triple', rocket: 'rocket', banana: 'banana', mine: 'mine', bomb: 'bomb', shock: 'shock',
    bouncer: 'bouncer', comet: 'comet', star: 'star', ink: 'ink', thunder: 'thunder',
  };
  const STREAKS = { 2: 'DOUBLE SMASH!', 3: 'TRIPLE SMASH!', 4: 'MULTI SMASH!', 5: 'RAMPAGE!', 7: 'UNSTOPPABLE!', 10: 'GODLIKE!' };
  const PLACE_CLASS = { 1: 'p1', 2: 'p2', 3: 'p3' };

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }
  const clock = (sec, tenths) => {
    const t = Math.max(0, sec);
    const m = Math.floor(t / 60);
    const rest = t - m * 60;
    return tenths ? `${m}:${rest.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(rest)).padStart(2, '0')}`;
  };
  function weaponIcon(kind, cls = 'item-icon') {
    if (kind === 'lava') return ICONS.lava;
    if (kind === 'water') return ICONS.water;
    if (kind === 'void' || kind === 'gap' || kind === 'fall') return ICONS.drop;
    const id = KIND_ICON[kind] || kind;
    return window.ItemIcons && ItemIcons.ids.includes(id) ? ItemIcons.svg(id, cls) : ICONS.boom;
  }
  const avatarCache = new Map();
  const avatar = (id) => {
    let s = avatarCache.get(id);
    if (!s) { s = window.Avatars ? Avatars.svg(id ?? 0) : ''; avatarCache.set(id, s); }
    return s;
  };

  // ctx: { stage, escape(text), colorOf(meta), metaOf(idx), touch }
  function create(ctx) {
    const q = (s) => ctx.stage.querySelector(s);
    const el = {
      card: q('[data-card]'), place: q('[data-place]'), lap: q('[data-lap]'), time: q('[data-time]'),
      hpFill: q('[data-hp-fill]'), hpText: q('[data-hp-text]'), kills: q('[data-kills]'), deaths: q('[data-deaths]'), rank: q('[data-rank]'),
      timer: q('[data-timer]'), board: q('[data-board]'), feed: q('[data-feed]'), callout: q('[data-callout]'),
      intro: q('[data-intro]'), help: q('[data-help]'), dead: q('[data-dead]'), hit: q('[data-hit]'), vignette: q('[data-vignette]'),
    };
    const shown = {}; // last text written to each element, so the DOM is only touched on change
    const set = (key, value, html) => {
      if (shown[key] === value) return;
      shown[key] = value;
      if (html) el[key].innerHTML = value; else el[key].textContent = value;
    };
    const tag = (meta) => `<span class="av">${avatar(meta?.avatar)}</span><b style="color:${ctx.colorOf(meta)}">${ctx.escape(meta?.name || '?')}</b>`;

    // ----- callouts: one big line at a time (3-2-1, GO, FINAL LAP, streaks, FINISH) -----
    const queue = [];
    let calloutTimer = 0;
    let calloutBusy = false;
    function showCallout(c) {
      calloutBusy = true;
      el.callout.className = `kart-callout ${c.kind || ''}`;
      el.callout.innerHTML = `<b>${ctx.escape(c.text)}</b>${c.sub ? `<small>${c.sub}</small>` : ''}`;
      el.callout.style.setProperty('--hold', `${c.hold}ms`);
      void el.callout.offsetWidth; // restart the animation
      el.callout.classList.add('show');
      clearTimeout(calloutTimer);
      calloutTimer = setTimeout(() => {
        calloutBusy = false;
        el.callout.classList.remove('show');
        if (queue.length) showCallout(queue.shift());
      }, c.hold + 380);
    }
    function callout(text, opts = {}) {
      const c = { text, sub: opts.sub || '', kind: opts.kind || '', hold: opts.hold || 900 };
      if (opts.now) { queue.length = 0; showCallout(c); return; }
      if (calloutBusy) { if (queue.length < 3) queue.push(c); } else showCallout(c);
    }

    // ----- round setup -----
    let round = { arena: false, laps: 3, myIdx: -1, respawn: 2.5, touch: !!ctx.touch };
    function setRound(info, map, myIdx) {
      round = { arena: map.type === 'arena', laps: info.laps, myIdx, respawn: info.respawn || 2.5, touch: !!ctx.touch, count: null, lap: 1, finished: false, phase: null };
      el.card.className = `kart-card kart-panel ${myIdx < 0 ? 'spec' : round.arena ? 'arena' : 'race'}`;
      const kicker = round.arena
        ? `Battle arena · ${clock(info.duration || 0)}${info.killLimit ? ` · first to ${info.killLimit}` : ''}`
        : `Race · ${info.laps} lap${info.laps === 1 ? '' : 's'}${info.reverse ? ' · reversed' : ''}`;
      el.intro.innerHTML = `<small>${kicker}</small><b>${ctx.escape(map.name)}</b>`;
      for (const k of Object.keys(shown)) delete shown[k];
      el.feed.innerHTML = '';
    }

    // ----- per frame -----
    let boardAt = 0;
    let deathShown = false;
    let deathRing = null;
    let lastBeat = 0;
    function update(now, latest, row, extra) {
      const { phase } = latest;
      const racing = phase === 'racing';
      // Countdown: the map intro first, then 3-2-1, then GO when the race really starts.
      if (phase === 'countdown') {
        const n = Math.ceil(latest.countdown);
        if (n !== round.count && n <= 3 && n > 0) { callout(String(n), { kind: 'count', hold: 520, now: true }); window.Sfx.beep(); }
        round.count = n;
      } else if (racing && round.count !== 'go') {
        if (round.count !== null) { callout('GO!', { kind: 'count go', hold: 520, now: true }); window.Sfx.go(); }
        round.count = 'go';
      }
      if (phase === 'done' && round.phase !== 'done') {
        if (round.arena) callout(latest.timeLeft !== null && latest.timeLeft < 0.5 ? 'TIME!' : 'GAME!', { now: true, hold: 1600 });
        else if (!round.finished) callout('RACE OVER', { now: true, hold: 1600 });
      }
      round.phase = phase;
      el.intro.classList.toggle('show', phase === 'countdown');
      // Desktop: the keys for the first few seconds. Touch: the "tap to start" caption stays until
      // the first press (the stage gets .engaged), since nothing moves before it.
      el.help.classList.toggle('show', phase === 'countdown' || (racing && (round.touch || latest.elapsed < 6)));

      if (round.arena && latest.timeLeft !== null) {
        set('timer', clock(Math.ceil(latest.timeLeft)));
        el.timer.classList.toggle('urgent', latest.timeLeft <= 10 && racing);
      }

      if (row) {
        const [, , , , , lap, place, , , flags, kills, deaths, hp] = row;
        if (round.arena) {
          const h = Math.max(0, Math.min(100, hp));
          if (shown.hp !== h) {
            shown.hp = h;
            el.hpFill.style.width = `${h}%`;
            el.hpFill.className = h > 50 ? '' : h > 25 ? 'mid' : 'low';
            el.hpText.textContent = h;
          }
          set('kills', String(kills));
          set('deaths', String(deaths));
          set('rank', round.touch ? `#${place}/${latest.k.length}` : `#${place} of ${latest.k.length}`);
          const low = h <= 30 && !(flags & 32) && racing;
          el.vignette.classList.toggle('show', low);
          if (low && now - lastBeat > 1000) { lastBeat = now; window.Sfx.heartbeat?.(); }
        } else {
          set('place', `<b class="${PLACE_CLASS[place] || ''}">${place}<sup>${ordinal(place)}</sup></b>`, true);
          const done = !!(flags & 8);
          if (done && !round.finished) {
            round.finished = true;
            callout('FINISH!', { sub: `${place}${ordinal(place)} place · ${clock(extra.finishTime ?? latest.elapsed, true)}`, hold: 1800 });
          }
          if (!done && racing && lap === round.laps && round.lap !== lap && round.laps > 1) callout('FINAL LAP', { kind: 'gold', hold: 1200 });
          round.lap = lap;
          set('lap', done ? `${ICONS.flag}Finished` : `Lap ${Math.max(1, lap)}/${round.laps}`, true);
          set('time', clock(done ? extra.finishTime ?? latest.elapsed : racing ? latest.elapsed : 0, true));
        }
        deathCard(now, flags & 32 ? extra.death : null);
      } else {
        deathCard(now, null);
      }

      if (now - boardAt > 300) {
        boardAt = now;
        board(latest);
      }
    }

    function board(latest) {
      const rows = [...latest.k].sort((a, b) => a[6] - b[6]);
      const mine = rows.find((r) => r[0] === round.myIdx);
      const top = rows.slice(0, 5);
      const html = top.map(boardRow).join('') + (mine && mine[6] > 5 ? `<i class="kb-gap"></i>${boardRow(mine)}` : '');
      set('board', html, true);
    }
    function boardRow(r) {
      const meta = ctx.metaOf(r[0]);
      const tail = round.arena ? `<b>${r[10]}</b>` : r[9] & 8 ? ICONS.flag : '';
      return `<div class="kb-row${r[0] === round.myIdx ? ' me' : ''}"><span class="rk">${r[6]}</span><span class="av" style="--c:${ctx.colorOf(meta)}">${avatar(meta?.avatar)}</span><span class="nm">${ctx.escape(meta?.name || '?')}</span>${tail}</div>`;
    }

    // ----- death card: who got you, who you're watching, and when you're back -----
    function deathCard(now, d) {
      if (!d) {
        if (deathShown) { deathShown = false; el.dead.classList.remove('show'); ctx.stage.classList.remove('is-dead'); }
        return;
      }
      if (!deathShown) {
        deathShown = true;
        const killer = d.by >= 0 ? ctx.metaOf(d.by) : null;
        const title = killer ? `<span class="kd-kicker">Smashed by</span><span class="kd-who">${tag(killer)}${weaponIcon(d.kind)}</span>`
          : `<span class="kd-kicker">Wiped out</span><span class="kd-who">${weaponIcon(d.kind || 'boom')}<b>${d.kind === 'lava' ? 'Into the lava' : 'Destroyed'}</b></span>`;
        el.dead.innerHTML = `<div class="kd-ring"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" class="bg"/><circle cx="22" cy="22" r="19" class="fg" pathLength="100"/></svg><b></b></div>
          <div class="kd-text">${title}<span class="kd-watch"></span></div>`;
        deathRing = { fg: el.dead.querySelector('.fg'), num: el.dead.querySelector('.kd-ring b'), watch: el.dead.querySelector('.kd-watch'), last: null, watching: undefined };
        el.dead.classList.add('show');
        ctx.stage.classList.add('is-dead');
      }
      const left = Math.max(0, round.respawn - (now - d.at) / 1000);
      deathRing.fg.style.strokeDashoffset = String(100 * (left / round.respawn));
      const secs = String(Math.ceil(left));
      if (deathRing.last !== secs) { deathRing.last = secs; deathRing.num.textContent = left > 0 ? secs : ''; }
      if (deathRing.watching !== d.watching) {
        deathRing.watching = d.watching;
        const m = d.watching >= 0 ? ctx.metaOf(d.watching) : null;
        deathRing.watch.innerHTML = m ? `${ICONS.eye}Watching ${ctx.escape(m.name)}` : 'Respawning';
      }
    }

    // ----- feed and hit markers -----
    function feed(html) {
      const div = document.createElement('div');
      div.className = 'kf-row kart-panel';
      div.innerHTML = html;
      el.feed.prepend(div);
      while (el.feed.children.length > 4) el.feed.lastChild.remove();
      setTimeout(() => { div.classList.add('out'); setTimeout(() => div.remove(), 300); }, 4000);
    }
    function smash({ by, target, kind, streak }) {
      const killer = by >= 0 ? ctx.metaOf(by) : null;
      const victim = ctx.metaOf(target);
      const mine = by === round.myIdx || target === round.myIdx;
      feed(`${killer ? `${tag(killer)}` : ''}${weaponIcon(kind)}${tag(victim)}`);
      if (mine) el.feed.firstChild.classList.add('mine');
      if (streak >= 3 && STREAKS[streak] && killer && by !== round.myIdx) feed(`${ICONS.flame}${tag(killer)}<em>${STREAKS[streak].replace('!', '')}</em>`);
    }
    // A race kart fell into water or lava, or off a jump.
    function fall(idx, kind) {
      feed(`${tag(ctx.metaOf(idx))}${weaponIcon(kind || 'void')}`);
      if (idx === round.myIdx) el.feed.firstChild.classList.add('mine');
    }
    let hitTimer = 0;
    function hitMarker(kill) {
      el.hit.className = `kart-hit${kill ? ' kill' : ''}`;
      void el.hit.offsetWidth;
      el.hit.classList.add('show');
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => el.hit.classList.remove('show'), kill ? 260 : 180);
    }

    return { setRound, update, callout, smash, fall, feed, hitMarker, tag, streakName: (n) => STREAKS[n] };
  }

  window.KartHud = { create, ICONS, ordinal, weaponIcon };
})();
