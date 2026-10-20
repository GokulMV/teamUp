/* global DrawBoard */
window.Games = window.Games || {};

window.Games.pictionary = {
  mount(el, api) {
    const esc = api.escapeHtml;
    const RING = 2 * Math.PI * 22;
    el.innerHTML = `
      <svg width="0" height="0" style="position:absolute"><defs><linearGradient id="timer-grad" x1="0" x2="1">
        <stop offset="0" stop-color="#40d2be"/><stop offset="0.5" stop-color="#ffd27a"/><stop offset="1" stop-color="#ffb547"/></linearGradient></defs></svg>
      <div class="game-wrap">
        <div class="game-bar glass pict-bar">
          <div class="timer-ring" data-ring><svg viewBox="0 0 52 52"><circle class="bg" cx="26" cy="26" r="22"/><circle class="fg" cx="26" cy="26" r="22" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><b data-timer>–</b></div>
          <div class="info" data-info></div>
          <div class="word-tiles" data-word></div>
          <div class="rate hidden" data-rate><button data-like="1" title="I like this drawing">👍 <span data-likes>0</span></button><button data-like="0" title="Not my favourite">👎</button></div>
        </div>
        <div class="stage glass" data-stage style="padding:12px"><div class="floaters" data-floaters></div></div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');
    let phase = null;
    let overlay = null;
    let deadline = 0;
    let total = 80;

    const board = new DrawBoard(stage, {
      editable: false,
      onStroke: (s) => api.socket.emit('game:stroke', s),
      onUndo: (id) => api.socket.emit('game:undo', { id }),
      onClear: () => api.socket.emit('game:clear'),
    });
    const coarse = matchMedia('(pointer: coarse)').matches;
    // Phones: bring the game into view (the page may be scrolled down to the chat).
    const intoView = () => { if (coarse) stage.closest('.game-wrap')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };

    function setOverlay(html) {
      overlay?.remove();
      overlay = null;
      if (!html) return;
      overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = html;
      stage.appendChild(overlay);
    }

    function float(emoji) {
      const span = document.createElement('span');
      span.textContent = emoji;
      span.style.left = `${10 + Math.random() * 80}%`;
      q('[data-floaters]').appendChild(span);
      setTimeout(() => span.remove(), 2300);
    }

    function showOptions(options) {
      setOverlay(`${api.avatarHtml(api.me()?.avatar)}<h2>Your turn! Pick a word to draw</h2><div class="choices">${options
        .map((w) => `<button class="btn primary" data-choose="${esc(w)}">${esc(w)}</button>`).join('')}</div>
        <p class="muted small">Picks the first one in <b data-autopick>${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}</b> s</p>`);
      overlay.querySelectorAll('[data-choose]').forEach((b) => {
        b.onclick = () => api.socket.emit('game:choose', { word: b.dataset.choose });
      });
      intoView();
      navigator.vibrate?.(120);
    }

    function wordTiles(p) {
      const amDrawer = p.drawerId === api.myId();
      if (p.phase === 'choosing') return `<span class="plain">${amDrawer ? 'Choose a word' : `${esc(p.drawerName)} is choosing…`}</span>`;
      const text = p.word || p.mask;
      if (p.wordMode === 'hidden' && !p.word) return '<span class="plain">??? <span class="muted small">hidden word</span></span>';
      // One group per word, so a line never breaks in the middle of one; punctuation shows as it is.
      let i = 0;
      const tile = (c) => {
        const k = i++;
        if (c !== '_' && !/[\p{L}\p{N}]/u.test(c)) return `<i class="punct">${esc(c)}</i>`;
        const shown = c !== '_';
        return `<i class="${shown && !p.word ? 'shown' : ''}" style="animation-delay:${k * 20}ms">${shown ? esc(c) : ''}</i>`;
      };
      const words = text.split(' ').map((w) => `<span class="tile-word">${[...w].map(tile).join('')}</span>`).join('<i class="space"></i>');
      const letters = [...text].filter((c) => c === '_' || /[\p{L}\p{N}]/u.test(c)).length;
      return `${words}<span class="count">${letters}</span>`;
    }

    function applyPhase(p) {
      const prevPhase = phase?.phase;
      phase = p;
      deadline = Date.now() + p.timeLeft * 1000;
      total = p.phase === 'drawing' ? p.drawTime : p.phase === 'choosing' ? 15 : 6;
      const amDrawer = p.drawerId === api.myId();
      const drawerTeam = p.drawerTeam !== null && api.room()?.settings.teamMode ? api.teamById(p.drawerTeam) : null;
      q('[data-info]').textContent = p.round ? `Round ${p.round}/${p.rounds}` : `Turn ${p.turn}/${p.totalTurns}`;
      q('[data-word]').innerHTML = wordTiles(p);

      // 👍/👎 for guessers while drawing and at the reveal.
      const canRate = !amDrawer && (p.phase === 'drawing' || p.phase === 'reveal');
      q('[data-rate]').classList.toggle('hidden', !canRate);
      q('[data-likes]').textContent = p.likes;
      q('[data-like="1"]').classList.toggle('on', p.myVote > 0);
      q('[data-like="0"]').classList.toggle('on', p.myVote < 0);

      board.setEditable(amDrawer && p.phase === 'drawing');

      if (p.phase === 'choosing') {
        if (prevPhase !== 'choosing') board.setStrokes([]);
        if (!amDrawer) {
          setOverlay(`${api.avatarHtml(p.drawerAvatar)}<h2>${esc(p.drawerName)} is picking a word</h2>
            ${drawerTeam ? `<p style="color:${drawerTeam.color};font-weight:800">Team ${drawerTeam.name} is drawing</p>` : ''}
            <p class="muted">Get ready to guess in the chat!</p>`);
        }
      } else if (p.phase === 'drawing') {
        setOverlay(null);
        if (prevPhase !== 'drawing' && !amDrawer) api.focusChat();
        if (prevPhase !== 'drawing' && amDrawer) { board.resetTool(); intoView(); api.toast('✏️ Draw! Others guess in the chat'); }
      } else if (p.phase === 'reveal') {
        const guessed = p.guessed.length;
        setOverlay(`<p class="muted">The word was</p><div class="big-word">${esc(p.word || '')}</div>
          <p>${guessed ? `${guessed} player${guessed > 1 ? 's' : ''} guessed it` : 'Nobody guessed it 😅'} · 👍 ${p.likes}</p>`);
      }

      const info = {};
      for (const pl of api.room()?.players || []) {
        info[pl.id] = { score: p.scores[pl.id] || 0, guessed: p.guessed.includes(pl.id), drawing: pl.id === p.drawerId };
      }
      api.setSideInfo(info);
    }

    q('[data-rate]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-like]');
      if (!b) return;
      const like = b.dataset.like === '1';
      api.emit('game:rate', { like });
    });

    let lastLeft = null;
    const tick = setInterval(() => {
      if (!phase) return;
      const leftExact = Math.max(0, (deadline - Date.now()) / 1000);
      const left = Math.ceil(leftExact);
      if (left !== lastLeft && left <= 10 && left > 0 && phase.phase === 'drawing') window.Sfx.tick();
      lastLeft = left;
      q('[data-timer]').textContent = left;
      const auto = stage.querySelector('[data-autopick]');
      if (auto) auto.textContent = left;
      q('.timer-ring .fg').style.strokeDashoffset = `${RING * (1 - Math.min(1, leftExact / total))}`;
      q('[data-ring]').classList.toggle('urgent', phase.phase === 'drawing' && left <= 10);
    }, 250);

    return {
      onSnapshot(snap) {
        applyPhase(snap.phase);
        board.setStrokes(snap.strokes || []);
        if (snap.options) showOptions(snap.options);
      },
      onEvent(event, data) {
        if (event === 'game:pict:phase') applyPhase(data);
        else if (event === 'game:pict:options') showOptions(data.options);
        else if (event === 'game:pict:stroke') board.addStroke(data);
        else if (event === 'game:pict:redraw') board.setStrokes(data.strokes);
        else if (event === 'game:pict:like') float('👍');
        else if (event === 'game:pict:guessed') float('✅');
      },
      unmount() {
        clearInterval(tick);
        board.destroy();
        api.setSideInfo({});
      },
    };
  },
};
