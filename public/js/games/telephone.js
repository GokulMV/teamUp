/* global DrawBoard */
window.Games = window.Games || {};

window.Games.telephone = {
  mount(el, api) {
    const esc = api.escapeHtml;
    const RING = 2 * Math.PI * 22;
    const MODE_LABEL = { normal: '✍️ Normal', speedrun: '⚡ Speedrun', secret: '🙈 Secret', knockoff: '🧠 Knock-off', complement: '🧩 Complement' };
    el.innerHTML = `
      <svg width="0" height="0" style="position:absolute"><defs><linearGradient id="timer-grad" x1="0" x2="1">
        <stop offset="0" stop-color="#7c5cff"/><stop offset="0.5" stop-color="#ff4fa3"/><stop offset="1" stop-color="#ffb547"/></linearGradient></defs></svg>
      <div class="game-wrap">
        <div class="game-bar glass">
          <div class="timer-ring" data-ring><svg viewBox="0 0 52 52"><circle class="bg" cx="26" cy="26" r="22"/><circle class="fg" cx="26" cy="26" r="22" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><b data-timer>–</b></div>
          <div class="word-tiles"><span class="plain" data-title></span></div>
          <div class="info" data-info></div>
        </div>
        <div class="stage glass" data-stage style="padding:12px"></div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');
    let board = null;
    let task = null;
    let deadline = 0;
    let total = 60;
    let submitted = false;
    let progress = { doneIds: [] };
    let memoTimer = null;
    let revealData = null;

    function clearStage() {
      clearInterval(memoTimer);
      board?.destroy();
      board = null;
      stage.innerHTML = '';
    }

    function waitingAvatars() {
      const ids = api.room()?.players.filter((p) => p.connected).map((p) => p.id) || [];
      return `<div class="waiting-avatars">${ids.map((id) => {
        const p = api.playerById(id);
        return `<span title="${esc(p.name)}" class="${progress.doneIds.includes(id) ? 'done' : ''}" style="display:inline-block">${api.avatarHtml(p.avatar, progress.doneIds.includes(id) ? 'done' : '')}</span>`;
      }).join('')}</div>`;
    }

    function waiting(text) {
      clearStage();
      stage.innerHTML = `<div class="tel-center"><h2>${esc(text)}</h2><p class="muted" data-progress></p><div data-waiting>${waitingAvatars()}</div></div>`;
      renderProgress();
    }

    function renderProgress() {
      const p = stage.querySelector('[data-progress]');
      if (p && progress.total) p.textContent = `${progress.done}/${progress.total} players done`;
      const w = stage.querySelector('[data-waiting]');
      if (w) w.innerHTML = waitingAvatars();
    }

    async function submit() {
      if (!task || submitted) return;
      submitted = true;
      let payload;
      if (task.type === 'draw') payload = { image: board ? board.toDataURL() : null };
      else payload = { text: stage.querySelector('input')?.value || '' };
      // Show the waiting screen before sending: the next task may arrive before the ack.
      waiting('Done! Waiting for the others…');
      window.Sfx.pop();
      await api.emit('game:submit', payload);
    }

    function textTask(t, heading, placeholder, showPrev) {
      const img = showPrev && t.prev?.content
        ? `<div class="tel-prev"><img src="${esc(t.prev.content)}" alt="drawing"></div>`
        : showPrev ? '<p class="muted">(They didn’t draw anything. Make something up!)</p>' : '';
      stage.innerHTML = `<div class="tel-center">
        <span class="tel-step">Step ${t.step + 1} of ${t.steps}</span>
        <div class="tel-prompt">${heading}</div>
        ${img}
        <form class="tel-form"><input maxlength="140" placeholder="${esc(placeholder)}"><button class="btn primary">Done</button></form>
      </div>`;
      const form = stage.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); submit(); };
      form.querySelector('input').focus();
    }

    function drawTask(t) {
      const host = document.createElement('div');
      host.style.cssText = 'height:100%;width:100%';
      stage.appendChild(host);
      board = new DrawBoard(host, {
        editable: true,
        blind: t.blind,
        onTools: (extra) => {
          extra.innerHTML = '<button class="tool-btn done" data-done>✅ Done</button>';
          extra.querySelector('[data-done]').onclick = submit;
        },
      });
      if (t.mode === 'complement' && t.prev?.content) board.setBackground(t.prev.content);
    }

    function showTask(t) {
      if (!task || task.step !== t.step) window.Sfx.pop();
      task = t;
      submitted = t.submitted;
      deadline = Date.now() + t.timeLeft * 1000;
      total = Math.max(1, t.timeLeft);
      q('[data-info]').textContent = `${MODE_LABEL[t.mode] || ''} · ${t.step + 1}/${t.steps}`;
      if (submitted) { waiting('Done! Waiting for the others…'); return; }
      clearStage();

      const prevText = t.prev?.type !== 'draw' ? t.prev?.content : null;
      if (t.type === 'write') {
        q('[data-title]').textContent = '✍️ Write a prompt';
        textTask(t, 'Write something funny for the next player to draw', t.suggestion, false);
      } else if (t.type === 'describe') {
        q('[data-title]').textContent = '🔍 What is this?';
        textTask(t, 'Describe this drawing', 'What is this?', true);
      } else if (t.mode === 'knockoff' && t.prev?.content && t.memorize) {
        // Knock-off: memorise the drawing, then it disappears and you redraw it.
        q('[data-title]').textContent = '🧠 Memorise this drawing!';
        stage.innerHTML = `<div class="tel-center tel-memo"><div class="tel-prev"><img src="${esc(t.prev.content)}" alt="drawing to memorise"></div><div class="count" data-count>${t.memorize}</div></div>`;
        let left = t.memorize;
        memoTimer = setInterval(() => {
          left--;
          const c = stage.querySelector('[data-count]');
          if (c) c.textContent = left;
          if (left <= 0) {
            clearInterval(memoTimer);
            stage.innerHTML = '';
            q('[data-title]').textContent = '🎨 Now redraw it from memory';
            drawTask(t);
          }
        }, 1000);
      } else {
        let title = 'anything you like';
        if (t.mode === 'complement' && t.prev?.content) title = 'add to this drawing';
        else if (prevText) title = esc(prevText);
        q('[data-title]').innerHTML = t.mode === 'complement' && t.prev ? '🧩 Add to this drawing' : `🎨 Draw: <b>${title}</b>`;
        drawTask(t);
      }
    }

    // ---------- Reveal ----------
    function albumImage(r) {
      // Render the album to a single tall PNG for saving.
      const W = 800;
      const pad = 30;
      const imgs = r.entries.map((e) => {
        if (e.type !== 'draw' || !e.content) return Promise.resolve(null);
        return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = e.content; });
      });
      return Promise.all(imgs).then((loaded) => {
        const heights = r.entries.map((e, i) => (loaded[i] ? 420 : 90));
        const H = 120 + heights.reduce((a, b) => a + b + 50, 0);
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#1b1446'); g.addColorStop(1, '#3b1452');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 34px sans-serif';
        ctx.fillText(`${r.owner}'s album · TeamUp Telephone`, pad, 64);
        let y = 110;
        r.entries.forEach((e, i) => {
          ctx.fillStyle = '#c4b5fd'; ctx.font = 'bold 20px sans-serif';
          ctx.fillText(e.by, pad, y + 20);
          y += 34;
          if (loaded[i]) {
            ctx.fillStyle = '#fff'; ctx.fillRect(pad, y, 520, 390);
            ctx.drawImage(loaded[i], pad, y, 520, 390);
            y += 420;
          } else {
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px sans-serif';
            ctx.fillText(e.type === 'draw' ? '(blank drawing)' : e.content, pad, y + 36, W - pad * 2);
            y += 90;
          }
          y += 16;
        });
        return c.toDataURL('image/png');
      });
    }

    function float(emoji) {
      const box = stage.querySelector('.floaters');
      if (!box) return;
      const span = document.createElement('span');
      span.textContent = emoji;
      span.style.left = `${10 + Math.random() * 80}%`;
      box.appendChild(span);
      setTimeout(() => span.remove(), 2300);
    }

    function showReveal(r) {
      task = null;
      deadline = 0;
      revealData = r;
      q('[data-timer]').textContent = '📖';
      q('.timer-ring .fg').style.strokeDashoffset = '0';
      q('[data-info]').textContent = `Album ${r.bookIndex + 1}/${r.bookCount}`;
      const team = r.team !== null && r.team !== undefined ? api.teamById(r.team) : null;
      q('[data-title]').innerHTML = `${esc(r.owner)}'s album${team ? ` <small style="color:${team.color}">(${team.name})</small>` : ''}`;
      clearStage();
      const host = api.isHost();
      stage.innerHTML = `<div class="floaters"></div><div class="tel-center" style="justify-content:flex-start">
        <div class="tel-album">${r.entries.map((e, i) => `
          <div class="tel-entry" style="animation-delay:${i === r.entries.length - 1 ? 0 : 0}s">${api.avatarHtml(e.avatar)}
            <div><div class="who">${esc(e.by)}</div>
            <div class="bubble">${e.type === 'draw'
              ? (e.content ? `<img src="${esc(e.content)}" alt="drawing">` : '<i class="muted">(blank drawing)</i>')
              : esc(e.content)}</div></div></div>`).join('')}
        </div>
        <div class="tel-actions">
          <div class="reactions">${['❤️', '😂', '😮', '🔥', '👏'].map((em) => `<button data-react="${em}">${em}</button>`).join('')}</div>
          <button class="btn small" data-save>⬇️ Save album</button>
          ${host && !r.auto ? `<button class="btn primary" data-next>${r.last ? 'Finish' : 'Next ▶'}</button>` : ''}
          ${!host && !r.auto ? '<span class="muted small">The host is flipping through the albums…</span>' : ''}
          ${r.auto ? '<span class="muted small">Auto-playing…</span>' : ''}
        </div>
      </div>`;
      const center = stage.querySelector('.tel-center');
      const scroll = () => { center.scrollTop = center.scrollHeight; };
      center.querySelectorAll('img').forEach((i) => i.addEventListener('load', scroll));
      scroll();
      stage.querySelector('[data-next]')?.addEventListener('click', () => api.emit(r.last ? 'game:finish' : 'game:next'));
      stage.querySelector('.reactions').addEventListener('click', (e) => {
        const b = e.target.closest('[data-react]');
        if (b) api.emit('game:react', { emoji: b.dataset.react });
      });
      stage.querySelector('[data-save]').onclick = async () => {
        const url = await albumImage(revealData);
        const a = document.createElement('a');
        a.href = url;
        a.download = `teamup-album-${revealData.owner.replace(/[^a-z0-9]+/gi, '-')}.png`;
        a.click();
      };
      window.Sfx.pop();
    }

    let lastLeft = null;
    const tick = setInterval(() => {
      if (!task) return;
      const leftExact = Math.max(0, (deadline - Date.now()) / 1000);
      const left = Math.ceil(leftExact);
      q('[data-timer]').textContent = left;
      q('.timer-ring .fg').style.strokeDashoffset = `${RING * (1 - Math.min(1, leftExact / total))}`;
      q('[data-ring]').classList.toggle('urgent', !submitted && left <= 10);
      if (left !== lastLeft && left <= 5 && left > 0 && !submitted) window.Sfx.tick();
      lastLeft = left;
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
        else if (event === 'game:tel:progress') { progress = data; renderProgress(); } else if (event === 'game:tel:react') float(data.emoji);
      },
      unmount() {
        clearInterval(tick);
        clearStage();
      },
    };
  },
};
