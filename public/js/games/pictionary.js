/* global DrawBoard */
window.Games = window.Games || {};

window.Games.pictionary = {
  mount(el, api) {
    el.innerHTML = `
      <div class="game-wrap">
        <div class="game-bar">
          <div class="timer" data-timer>--</div>
          <div class="word" data-word></div>
          <div class="info" data-info></div>
        </div>
        <div class="stage" data-stage></div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');
    let phase = null;
    let overlay = null;
    let deadline = 0;

    const board = new DrawBoard(stage, {
      editable: false,
      onStroke: (s) => api.socket.emit('game:stroke', s),
      onUndo: () => api.socket.emit('game:undo'),
      onClear: () => api.socket.emit('game:clear'),
    });

    function setOverlay(html) {
      overlay?.remove();
      overlay = null;
      if (!html) return;
      overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = html;
      stage.appendChild(overlay);
    }

    function showOptions(options) {
      setOverlay(`<h2>Pick a word to draw</h2><div class="choices">${options
        .map((w) => `<button class="btn primary" data-choose="${api.escapeHtml(w)}">${api.escapeHtml(w)}</button>`).join('')}</div>`);
      overlay.querySelectorAll('[data-choose]').forEach((b) => {
        b.onclick = () => api.socket.emit('game:choose', { word: b.dataset.choose });
      });
    }

    function applyPhase(p) {
      phase = p;
      deadline = Date.now() + p.timeLeft * 1000;
      const amDrawer = p.drawerId === api.myId();
      const drawerTeam = p.drawerTeam !== null && api.room()?.settings.teamMode ? api.teamById(p.drawerTeam) : null;
      q('[data-info]').innerHTML = `Turn ${p.turn}/${p.totalTurns}`;

      const wordEl = q('[data-word]');
      if (p.phase === 'choosing') wordEl.textContent = amDrawer ? 'Choose a word' : `${p.drawerName} is choosing…`;
      else if (p.word) wordEl.textContent = p.word;
      else wordEl.textContent = p.mask;

      board.setEditable(amDrawer && p.phase === 'drawing');

      if (p.phase === 'choosing') {
        board.setStrokes([]);
        if (!amDrawer) {
          setOverlay(`<h2>${api.escapeHtml(p.drawerName)} is picking a word</h2>
            ${drawerTeam ? `<p style="color:${drawerTeam.color};font-weight:800">Team ${drawerTeam.name} is drawing</p>` : ''}
            <p>Get ready to guess in the chat!</p>`);
        }
      } else if (p.phase === 'drawing') {
        setOverlay(null);
        if (!amDrawer && !p.guessed.includes(api.myId())) api.focusChat();
      } else if (p.phase === 'reveal') {
        setOverlay(`<h2>The word was</h2><div class="word" style="font-size:2.4rem">${api.escapeHtml(p.word || '')}</div>`);
      }

      const info = {};
      for (const pl of api.room()?.players || []) {
        info[pl.id] = { score: p.scores[pl.id] || 0, guessed: p.guessed.includes(pl.id), drawing: pl.id === p.drawerId };
      }
      api.setSideInfo(info);
    }

    let lastLeft = null;
    const tick = setInterval(() => {
      if (!phase) return;
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (left !== lastLeft && left <= 10 && left > 0 && phase.phase === 'drawing') window.Sfx.tick();
      lastLeft = left;
      q('[data-timer]').textContent = left;
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
      },
      unmount() {
        clearInterval(tick);
        board.destroy();
        api.setSideInfo({});
      },
    };
  },
};
