/* global DrawBoard */
window.Games = window.Games || {};

window.Games.telephone = {
  mount(el, api) {
    el.innerHTML = `
      <div class="game-wrap">
        <div class="game-bar">
          <div class="timer" data-timer>--</div>
          <div class="word" data-title style="letter-spacing:0;font-family:inherit"></div>
          <div class="info" data-info></div>
        </div>
        <div class="stage" data-stage></div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');
    const esc = api.escapeHtml;
    let board = null;
    let task = null;
    let deadline = 0;
    let submitted = false;

    function clearStage() {
      board?.destroy();
      board = null;
      stage.innerHTML = '';
    }

    function waiting(text) {
      clearStage();
      stage.innerHTML = `<div class="tel-center"><h2>${esc(text)}</h2><p class="muted" data-progress></p></div>`;
    }

    async function submit() {
      if (!task || submitted) return;
      submitted = true;
      let payload;
      if (task.type === 'draw') payload = { image: board ? board.toDataURL() : null };
      else payload = { text: stage.querySelector('input')?.value || '' };
      // Show the waiting screen before sending: the next task may arrive before the ack.
      waiting('Done! Waiting for the others…');
      await api.emit('game:submit', payload);
    }

    function showTask(t) {
      if (!task || task.step !== t.step) window.Sfx.pop();
      task = t;
      submitted = t.submitted;
      deadline = Date.now() + t.timeLeft * 1000;
      q('[data-info]').textContent = `Step ${t.step + 1}/${t.steps}`;
      if (submitted) { waiting('Done! Waiting for the others…'); return; }
      clearStage();

      if (t.type === 'write') {
        q('[data-title]').textContent = '✍️ Write a funny prompt';
        stage.innerHTML = `<div class="tel-center">
          <h2>Write something for the next player to draw</h2>
          <form class="tel-form"><input maxlength="140" placeholder="${esc(t.suggestion)}" autofocus>
          <button class="btn primary">Done</button></form></div>`;
      } else if (t.type === 'describe') {
        q('[data-title]').textContent = '🔍 Describe this drawing';
        const img = t.prev?.content
          ? `<img src="${esc(t.prev.content)}" alt="drawing">`
          : '<p class="muted">(They didn’t draw anything. Make something up!)</p>';
        stage.innerHTML = `<div class="tel-center"><div class="tel-prev">${img}</div>
          <form class="tel-form"><input maxlength="140" placeholder="What is this?" autofocus>
          <button class="btn primary">Done</button></form></div>`;
      } else {
        q('[data-title]').innerHTML = `🎨 Draw: <b>${esc(t.prev?.content || 'anything you like')}</b>`;
        board = new DrawBoard(stage, { editable: true });
        const done = document.createElement('button');
        done.className = 'tool-btn';
        done.style.background = 'var(--accent)';
        done.style.color = '#fff';
        done.textContent = '✅ Done';
        done.onclick = submit;
        board.tools.appendChild(done);
      }
      const form = stage.querySelector('form');
      if (form) {
        form.onsubmit = (e) => { e.preventDefault(); submit(); };
        form.querySelector('input').focus();
      }
    }

    function showReveal(r) {
      task = null;
      deadline = 0;
      q('[data-timer]').textContent = '📖';
      q('[data-info]').textContent = `Album ${r.bookIndex + 1}/${r.bookCount}`;
      const team = r.team !== null && r.team !== undefined ? api.teamById(r.team) : null;
      q('[data-title]').innerHTML = `${esc(r.owner)}'s album${team ? ` <small style="color:${team.color}">(${team.name})</small>` : ''}`;
      clearStage();
      const host = api.isHost();
      stage.innerHTML = `<div class="tel-center" style="justify-content:flex-start">
        <div class="tel-album">${r.entries.map((e) => `
          <div class="tel-entry"><div class="who" style="color:${e.color}">${esc(e.by)}</div>
            <div class="bubble">${e.type === 'draw'
              ? (e.content ? `<img src="${esc(e.content)}" alt="drawing">` : '<i class="muted">(blank drawing)</i>')
              : esc(e.content)}</div></div>`).join('')}
        </div>
        ${host
          ? `<button class="btn primary" data-next>${r.last ? 'Finish' : 'Next ▶'}</button>`
          : '<p class="muted">The host is flipping through the albums…</p>'}
      </div>`;
      const center = stage.querySelector('.tel-center');
      const imgs = center.querySelectorAll('img');
      const scroll = () => { center.scrollTop = center.scrollHeight; };
      imgs.forEach((i) => i.addEventListener('load', scroll));
      scroll();
      stage.querySelector('[data-next]')?.addEventListener('click', () => api.emit(r.last ? 'game:finish' : 'game:next'));
    }

    const tick = setInterval(() => {
      if (!task) return;
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      q('[data-timer]').textContent = left;
      if (left <= 0 && !submitted) submit(); // auto-submit whatever you have
    }, 250);

    waiting('Get ready…');

    return {
      onSnapshot(snap) {
        if (snap.reveal) showReveal(snap.reveal);
        else if (snap.task) showTask(snap.task);
        else waiting('You joined mid-game. You’ll play the next round!');
      },
      onEvent(event, data) {
        if (event === 'game:tel:task') showTask(data);
        else if (event === 'game:tel:reveal') showReveal(data);
        else if (event === 'game:tel:progress') {
          const p = stage.querySelector('[data-progress]');
          if (p) p.textContent = `${data.done}/${data.total} players done`;
        }
      },
      unmount() {
        clearInterval(tick);
        clearStage();
      },
    };
  },
};
