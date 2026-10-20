/* global DrawBoard */
window.Games = window.Games || {};

window.Games.telephone = {
  mount(el, api) {
    const esc = api.escapeHtml;
    const RING = 2 * Math.PI * 22;
    const MODE_LABEL = { normal: '✍️ Normal', speedrun: '⚡ Speedrun', secret: '🙈 Secret', knockoff: '🧠 Knock-off', complement: '🧩 Complement' };
    const REACTIONS = ['❤️', '😂', '😮', '🔥', '👏'];
    el.innerHTML = `
      <svg width="0" height="0" style="position:absolute"><defs><linearGradient id="timer-grad" x1="0" x2="1">
        <stop offset="0" stop-color="#40d2be"/><stop offset="0.5" stop-color="#ffd27a"/><stop offset="1" stop-color="#ffb547"/></linearGradient></defs></svg>
      <div class="game-wrap tel-wrap">
        <div class="game-bar glass">
          <div class="timer-ring" data-ring><svg viewBox="0 0 52 52"><circle class="bg" cx="26" cy="26" r="22"/><circle class="fg" cx="26" cy="26" r="22" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><b data-timer>–</b></div>
          <div class="word-tiles"><span class="plain tel-title" data-title></span></div>
          <div class="info" data-info></div>
        </div>
        <div class="stage glass tel-stage" data-stage></div>
      </div>`;
    const q = (s) => el.querySelector(s);
    const stage = q('[data-stage]');
    let board = null;
    let task = null; // the step on screen
    let editing = false; // its editor (text box or canvas) is up
    let deadline = 0;
    let total = 60;
    let submitted = false;
    let pending = null; // { step, payload } handed in but not yet confirmed by the server
    let progress = { doneIds: [], ids: [] };
    let memoTimer = null;
    let revealData = null; // the album on show: { ...payload, entries }
    let nextSent = false;

    function clearStage() {
      clearInterval(memoTimer);
      board?.destroy();
      board = null;
      editing = false;
      stage.innerHTML = '';
    }

    function waitingAvatars() {
      // Only the players in this round (late joiners watch).
      const ids = progress.ids?.length ? progress.ids : api.room()?.players.filter((p) => p.connected).map((p) => p.id) || [];
      return `<div class="waiting-avatars">${ids.map((id) => {
        const p = api.playerById(id);
        if (!p) return '';
        const done = progress.doneIds.includes(id);
        return `<span title="${esc(p.name)}" class="${done ? 'done' : ''} ${p.connected ? '' : 'away'}" style="display:inline-block">${api.avatarHtml(p.avatar, done ? 'done' : '')}</span>`;
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

    // Hand the step in. The answer is kept until the server confirms it: sent while the connection
    // was down (a phone switching networks), it goes again as soon as the room says the step is
    // still open for us.
    async function send() {
      if (!pending) return;
      const mine = pending;
      const res = await api.emit('game:submit', { step: mine.step, ...mine.payload });
      if (pending !== mine) return;
      if (res.ok || res.error === 'stale') { pending = null; return; }
      if (res.error === 'too-big' && mine.payload.image && board) {
        // Very dense drawings: try again as a smaller JPEG.
        mine.payload = { image: board.exportImage(900_000, true) };
        send();
      }
      // Anything else (not in the room yet): wait for the next task message and resend.
    }

    function submit() {
      if (!task || submitted) return;
      submitted = true;
      let payload;
      if (task.type === 'draw') payload = { image: board && !board.isBlank() ? board.exportImage(1_400_000) : null };
      else payload = { text: stage.querySelector('input')?.value || '' };
      pending = { step: task.step, payload };
      // Show the waiting screen before sending: the next task may arrive before the ack.
      waiting('Done! Waiting for the others…');
      window.Sfx.pop();
      send();
    }

    function textTask(t, heading, placeholder, showPrev) {
      let img = '';
      if (showPrev) {
        img = t.prev?.content
          ? `<div class="tel-prev"><img src="${esc(t.prev.content)}" alt="drawing"></div>`
          : '<p class="muted">(They didn’t draw anything. Make something up!)</p>';
      }
      stage.innerHTML = `<div class="tel-center">
        <span class="tel-step">Step ${t.step + 1} of ${t.steps}</span>
        <div class="tel-prompt">${heading}</div>
        ${img}
        <form class="tel-form"><input maxlength="140" placeholder="${esc(placeholder)}" aria-label="${esc(heading)}"><button class="btn primary">Done</button></form>
        ${t.type === 'write' ? '<p class="muted small tel-hint">Leave it empty to use the idea in the box.</p>' : ''}
      </div>`;
      const form = stage.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); submit(); };
      // Don't take the keyboard away from someone typing in the chat.
      const active = document.activeElement;
      if (!active || !/^(INPUT|TEXTAREA)$/.test(active.tagName)) form.querySelector('input').focus();
      editing = true;
    }

    function drawTask(t) {
      const host = document.createElement('div');
      host.className = 'tel-board';
      stage.appendChild(host);
      board = new DrawBoard(host, {
        editable: true,
        blind: t.blind,
        onTools: (extra) => {
          extra.innerHTML = '<button class="btn primary tool-done" data-done><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Done</button>';
          extra.querySelector('[data-done]').onclick = submit;
        },
      });
      if (t.mode === 'complement' && t.prev?.content) board.setBackground(t.prev.content);
      editing = true;
    }

    function setTitle(html, long) {
      const title = q('[data-title]');
      title.innerHTML = html;
      title.classList.toggle('long', !!long);
    }

    function showTask(t) {
      const same = task && task.step === t.step;
      if (!same) window.Sfx.pop();
      deadline = Date.now() + t.timeLeft * 1000;
      total = Math.max(1, t.total || t.timeLeft);
      q('[data-info]').textContent = `${MODE_LABEL[t.mode] || ''} · ${t.step + 1}/${t.steps}`;
      if (same && !t.submitted) {
        task = t;
        // Our hand-in for this step never arrived (sent while reconnecting): send it again.
        if (pending && pending.step === t.step) { send(); return; }
        // Still drawing or typing (a reconnect): keep the work, only the clock changes.
        if (editing && !submitted) return;
      }
      task = t;
      if (!same && pending && pending.step !== t.step) pending = null;
      submitted = t.submitted || !!(pending && pending.step === t.step);
      if (submitted) { waiting('Done! Waiting for the others…'); return; }
      clearStage();

      const prevText = t.prev?.type !== 'draw' ? t.prev?.content : null;
      if (t.type === 'write') {
        setTitle('✍️ Write a prompt');
        textTask(t, 'Write something funny for the next player to draw', t.suggestion, false);
      } else if (t.type === 'describe') {
        setTitle('🔍 What is this?');
        textTask(t, 'Describe this drawing', 'What is this?', true);
      } else if (t.mode === 'knockoff' && t.prev && (t.prev.hidden || !t.prev.content || t.memorize <= 0)) {
        // Knock-off, the memorising is over (a reload): straight to the redraw.
        setTitle('🎨 Now redraw it from memory');
        drawTask(t);
      } else if (t.mode === 'knockoff' && t.prev?.content) {
        // Knock-off: memorise the drawing, then it disappears and you redraw it.
        setTitle('🧠 Memorise this drawing!');
        stage.innerHTML = `<div class="tel-center tel-memo"><div class="tel-prev"><img src="${esc(t.prev.content)}" alt="drawing to memorise"></div><div class="count" data-count>${Math.ceil(t.memorize)}</div></div>`;
        const until = Date.now() + t.memorize * 1000;
        memoTimer = setInterval(() => {
          const left = Math.ceil((until - Date.now()) / 1000);
          const c = stage.querySelector('[data-count]');
          if (c) c.textContent = Math.max(0, left);
          if (left <= 0) {
            clearInterval(memoTimer);
            stage.innerHTML = '';
            setTitle('🎨 Now redraw it from memory');
            drawTask(t);
          }
        }, 200);
      } else if (t.mode === 'complement' && t.prev) {
        setTitle('🧩 Add to this drawing');
        drawTask(t);
      } else {
        setTitle(`🎨 Draw: <b>${prevText ? esc(prevText) : 'anything you like'}</b>`, prevText && prevText.length > 40);
        drawTask(t);
      }
    }

    // ---------- Reveal ----------
    // Lines of text that fit `width` on the canvas (long words broken where they have to be).
    function wrapText(ctx, text, width) {
      const lines = [];
      let line = '';
      for (const word of String(text).split(' ')) {
        let w = word;
        while (ctx.measureText(w).width > width) {
          let cut = w.length - 1;
          while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > width) cut--;
          if (line) { lines.push(line); line = ''; }
          lines.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        const next = line ? `${line} ${w}` : w;
        if (ctx.measureText(next).width > width && line) { lines.push(line); line = w; } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    }

    function albumImage(r) {
      // Render the album to a single tall PNG for saving.
      const W = 800;
      const pad = 30;
      const imgs = r.entries.map((e) => {
        if (e.type !== 'draw' || !e.content) return Promise.resolve(null);
        return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = e.content; });
      });
      return Promise.all(imgs).then((loaded) => {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        ctx.font = 'bold 30px sans-serif';
        const texts = r.entries.map((e, i) => (loaded[i] ? null : wrapText(ctx, e.type === 'draw' ? '(blank drawing)' : e.content || '(no answer)', W - pad * 2)));
        const heights = r.entries.map((e, i) => 34 + (loaded[i] ? 420 : texts[i].length * 38 + 20) + 16);
        c.width = W;
        c.height = 120 + heights.reduce((a, b) => a + b, 0);
        const g = ctx.createLinearGradient(0, 0, W, c.height);
        g.addColorStop(0, '#1b1446'); g.addColorStop(1, '#3b1452');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, c.height);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 34px sans-serif';
        ctx.fillText(`${r.owner}'s album · TeamUp Telephone`, pad, 64, W - pad * 2);
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
            texts[i].forEach((line, k) => ctx.fillText(line, pad, y + 36 + k * 38));
            y += texts[i].length * 38 + 20;
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

    const entryHtml = (e) => `
      <div class="tel-entry">${api.avatarHtml(e.avatar)}
        <div><div class="who">${esc(e.by)}</div>
        <div class="bubble">${e.type === 'draw'
          ? (e.content ? `<img src="${esc(e.content)}" alt="drawing">` : '<i class="muted">(blank drawing)</i>')
          : e.content ? esc(e.content) : '<i class="muted">(no answer)</i>'}</div></div></div>`;

    // The Next button belongs to whoever is host right now (it moves when the host drops out).
    function renderRevealActions() {
      const r = revealData;
      const box = stage.querySelector('[data-host-actions]');
      if (!r || !box) return;
      const host = api.isHost();
      const albumDone = r.entryIndex >= r.steps - 1;
      stage.querySelector('[data-save]')?.classList.toggle('hidden', !albumDone);
      if (r.auto) { box.innerHTML = '<span class="muted small">Auto-playing…</span>'; return; }
      box.innerHTML = host
        ? `<button class="btn primary" data-next ${nextSent ? 'disabled' : ''}>${r.last ? 'Finish' : albumDone ? 'Next album ▶' : 'Next ▶'}</button>`
        : '<span class="muted small">The host is flipping through the albums…</span>';
      box.querySelector('[data-next]')?.addEventListener('click', () => {
        if (nextSent) return;
        nextSent = true;
        renderRevealActions();
        api.emit(r.last ? 'game:finish' : 'game:next', { book: r.bookIndex, entry: r.entryIndex }).then((res) => {
          // Refused (someone else turned the page first): the button comes back with the next page.
          if (!res.ok && revealData === r) { nextSent = false; renderRevealActions(); }
        });
      });
    }

    function showReveal(r) {
      task = null;
      editing = false;
      pending = null;
      deadline = 0;
      nextSent = false;
      q('[data-ring]').classList.remove('urgent');
      q('[data-timer]').textContent = '📖';
      q('.timer-ring .fg').style.strokeDashoffset = '0';
      q('[data-info]').textContent = `Album ${r.bookIndex + 1}/${r.bookCount}`;
      const team = r.team !== null && r.team !== undefined ? api.teamById(r.team) : null;
      setTitle(`${esc(r.owner)}'s album${team ? ` <small style="color:${team.color}">(${team.name})</small>` : ''}`);
      // The same album one page on: add the new entry to what's already on screen.
      const album = stage.querySelector('.tel-album');
      const sameBook = revealData && album && revealData.bookIndex === r.bookIndex && r.entryIndex === revealData.entryIndex + 1 && !r.entries;
      if (sameBook) {
        revealData = { ...r, entries: [...revealData.entries, r.entry] };
        album.insertAdjacentHTML('beforeend', entryHtml(r.entry));
      } else {
        revealData = { ...r, entries: r.entries || (r.entry ? [r.entry] : []) };
        clearStage();
        stage.innerHTML = `<div class="floaters"></div><div class="tel-center tel-reveal">
          <div class="tel-album">${revealData.entries.map(entryHtml).join('')}</div>
          <div class="tel-actions">
            <div class="reactions">${REACTIONS.map((em) => `<button data-react="${em}" aria-label="React ${em}">${em}</button>`).join('')}</div>
            <button class="btn small hidden" data-save>⬇️ Save album</button>
            <span data-host-actions></span>
          </div>
        </div>`;
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
      }
      renderRevealActions();
      const center = stage.querySelector('.tel-center');
      const scroll = () => { center.scrollTop = center.scrollHeight; };
      center.querySelectorAll('img').forEach((i) => { if (!i.complete) i.addEventListener('load', scroll, { once: true }); });
      scroll();
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
      if (left <= 0 && !submitted && editing) submit(); // auto-submit whatever you have
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
      // The room changed (a new host, someone dropped out): refresh what depends on it.
      onRoomState() {
        if (revealData && !task) renderRevealActions();
        renderProgress();
      },
      unmount() {
        clearInterval(tick);
        clearStage();
      },
    };
  },
};
