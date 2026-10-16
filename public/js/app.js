/* global io, Games */
(function () {
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });

  const MODE_HELP = {
    pictionary: 'Each turn one player draws while everyone else guesses in chat. Faster guesses earn more points. In team mode, teams take turns drawing and scores are pooled per team.',
    kart: 'Arrow keys / WASD to drive, Space to use items. Item boxes give boosts, rockets, bananas, shields and triple rockets. In team mode rockets don’t hit teammates and team points are combined.',
    telephone: 'Everyone writes a prompt, then books pass around: draw what you read, describe what you see. In team mode, books stay inside each team. No scores, just laughs.',
  };
  const MODE_NAMES = { pictionary: 'Pictionary', kart: 'Kart Battle', telephone: 'Telephone' };

  const state = {
    me: null, // { playerId, token, code }
    room: null,
    game: null, // { mode, instance }
    sideInfo: {}, // per-player extras shown in the player list: { score, guessed, drawing }
  };

  // ---------- Helpers ----------
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function emit(event, data) {
    return new Promise((resolve) => socket.emit(event, data, (res) => resolve(res || {})));
  }

  function savedSession() {
    try { return JSON.parse(localStorage.getItem('teamup-session') || 'null'); } catch { return null; }
  }

  function saveSession(s) {
    try {
      if (s) localStorage.setItem('teamup-session', JSON.stringify(s));
      else localStorage.removeItem('teamup-session');
    } catch { /* storage unavailable */ }
  }

  const me = () => state.room?.players.find((p) => p.id === state.me?.playerId);
  const isHost = () => state.room && state.me && state.room.hostId === state.me.playerId;
  const playerById = (id) => state.room?.players.find((p) => p.id === id);
  const teamById = (id) => state.room?.teams.find((t) => t.id === id);

  // API handed to game modules.
  const api = {
    socket,
    emit,
    toast,
    escapeHtml,
    me: () => me(),
    myId: () => state.me?.playerId,
    room: () => state.room,
    isHost,
    playerById,
    teamById,
    setSideInfo(info) { state.sideInfo = info || {}; renderPlayerList(); },
    focusChat() { $('chat-input').focus(); },
  };

  // ---------- Home ----------
  const params = new URLSearchParams(location.search);
  $('name-input').value = (() => { try { return localStorage.getItem('teamup-name') || ''; } catch { return ''; } })();
  if (params.get('room')) $('code-input').value = params.get('room').toUpperCase();

  function getName() {
    const name = $('name-input').value.trim();
    if (!name) { $('home-error').textContent = 'Enter your name first'; $('name-input').focus(); return null; }
    try { localStorage.setItem('teamup-name', name); } catch { /* ignore */ }
    return name;
  }

  async function enterRoom(res) {
    if (!res.ok) { $('home-error').textContent = res.error || 'Could not join'; return false; }
    state.me = { playerId: res.playerId, token: res.token, code: res.code };
    saveSession(state.me);
    history.replaceState(null, '', `?room=${res.code}`);
    $('chat-log').innerHTML = '';
    showScreen('screen-room');
    render();
    return true;
  }

  $('btn-create').onclick = async () => {
    const name = getName();
    if (!name) return;
    enterRoom(await emit('room:create', { name }));
  };

  async function join() {
    const name = getName();
    const code = $('code-input').value.trim().toUpperCase();
    if (!name) return;
    if (code.length !== 4) { $('home-error').textContent = 'Room codes are 4 letters'; return; }
    const saved = savedSession();
    const token = saved && saved.code === code ? saved.token : undefined;
    enterRoom(await emit('room:join', { name, code, token }));
  }
  $('btn-join').onclick = join;
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('code-input').value.trim() ? join() : $('btn-create').click());
  });

  // Auto-rejoin after a refresh / reconnect.
  socket.on('connect', async () => {
    const saved = state.me || savedSession();
    if (!saved) return;
    const urlCode = new URLSearchParams(location.search).get('room');
    if (urlCode && urlCode.toUpperCase() !== saved.code) return;
    const res = await emit('room:join', { code: saved.code, token: saved.token, name: $('name-input').value || 'Player' });
    if (res.ok) enterRoom(res);
    else if (state.me) { leaveLocal(); toast('That room has closed'); }
    else saveSession(null);
  });

  function leaveLocal() {
    unmountGame();
    state.me = null;
    state.room = null;
    saveSession(null);
    history.replaceState(null, '', location.pathname);
    showScreen('screen-home');
  }

  $('btn-leave').onclick = async () => {
    await emit('room:leave');
    leaveLocal();
  };

  socket.on('room:kicked', (data) => {
    leaveLocal();
    $('home-error').textContent = data?.reason || 'You were removed from the room';
  });

  $('btn-copy').onclick = async () => {
    const url = `${location.origin}/?room=${state.room.code}`;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied!'); } catch { toast(url); }
  };

  // ---------- Room state ----------
  socket.on('room:state', (room) => {
    state.room = room;
    render();
  });

  function render() {
    const room = state.room;
    if (!room || !state.me) return;
    $('room-code').textContent = room.code;
    $('player-count').textContent = `${room.players.filter((p) => p.connected).length}/${room.maxPlayers} players`;
    $('btn-stop').classList.toggle('hidden', !(isHost() && room.state === 'playing'));

    if (room.state === 'lobby') {
      unmountGame();
      state.sideInfo = {};
      showView('view-lobby');
      renderLobby();
    } else if (room.state === 'playing') {
      showView('view-game');
      mountGame(room.settings.mode);
    } else if (room.state === 'results') {
      unmountGame();
      showView('view-results');
      renderResults();
    }
    renderPlayerList();
  }

  function renderPlayerList() {
    const room = state.room;
    if (!room) return;
    const players = [...room.players];
    const info = state.sideInfo;
    if (Object.keys(info).length) players.sort((a, b) => (info[b.id]?.score || 0) - (info[a.id]?.score || 0));
    $('player-list').innerHTML = players.map((p) => {
      const i = info[p.id] || {};
      const team = room.settings.teamMode ? teamById(p.team) : null;
      const cls = [p.id === state.me?.playerId ? 'me' : '', p.connected ? '' : 'offline', i.guessed ? 'guessed' : ''].join(' ');
      return `<li class="${cls}">
        <span class="dot" style="background:${team ? team.color : p.color}"></span>
        <span>${escapeHtml(p.name)}</span>
        ${p.id === room.hostId ? '<span class="tag">host</span>' : ''}
        ${i.drawing ? '✏️' : ''}${i.guessed ? '✅' : ''}
        ${i.score !== undefined ? `<span class="score">${i.score}</span>` : ''}
        ${isHost() && p.id !== state.me.playerId && room.state !== 'playing' ? `<button class="kick" data-kick="${p.id}" title="Kick">✕</button>` : ''}
      </li>`;
    }).join('');
  }

  $('player-list').addEventListener('click', (e) => {
    const id = e.target.dataset?.kick;
    if (id && confirm('Kick this player?')) emit('lobby:kick', { playerId: id });
  });

  // ---------- Lobby ----------
  function renderLobby() {
    const room = state.room;
    const s = room.settings;
    const host = isHost();
    document.querySelectorAll('.mode-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.mode === s.mode);
      c.disabled = !host;
    });
    const setIfIdle = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    $('set-teams').checked = s.teamMode;
    setIfIdle('set-team-count', s.teamCount);
    setIfIdle('set-turns', s.pictionaryTurns);
    setIfIdle('set-drawtime', s.drawTime);
    setIfIdle('set-laps', s.kartLaps);
    setIfIdle('set-steps', s.telephoneSteps);
    document.querySelectorAll('.settings input, .settings select, #btn-shuffle').forEach((el) => { el.disabled = !host; });
    document.querySelectorAll('.team-only').forEach((el) => el.classList.toggle('hidden', !s.teamMode));
    document.querySelectorAll('.setting[class*="mode-"]').forEach((el) => el.classList.toggle('hidden', !el.classList.contains(`mode-${s.mode}`)));
    $('mode-help').textContent = MODE_HELP[s.mode];
    $('btn-start').classList.toggle('hidden', !host);
    $('lobby-wait').classList.toggle('hidden', host);

    const teamsEl = $('teams');
    if (s.teamMode) {
      $('teams-panel').querySelector('h2').innerHTML = 'Teams <small class="muted">(click a team to join it)</small>';
      teamsEl.className = 'teams';
      teamsEl.innerHTML = room.teams.map((t) => {
        const members = room.players.filter((p) => p.team === t.id);
        return `<div class="team" data-team="${t.id}" style="border-color:${t.color}">
          <h4 style="color:${t.color}">${t.name} <span>${members.length}</span></h4>
          <ul>${members.map((p) => `<li>${p.id === state.me.playerId ? '<b>' : ''}${escapeHtml(p.name)}${p.id === state.me.playerId ? '</b>' : ''}</li>`).join('')}</ul>
        </div>`;
      }).join('');
    } else {
      $('teams-panel').querySelector('h2').innerHTML = `Players <small class="muted">(free for all)</small>`;
      teamsEl.className = 'solo-list';
      teamsEl.innerHTML = room.players.map((p) => `<span class="chip" style="background:${p.color}">${escapeHtml(p.name)}</span>`).join('');
    }
  }

  async function updateSettings(patch) {
    const res = await emit('lobby:settings', patch);
    if (!res.ok) $('lobby-error').textContent = res.error || '';
  }

  document.querySelectorAll('.mode-card').forEach((c) => {
    c.onclick = () => isHost() && updateSettings({ mode: c.dataset.mode });
  });
  $('set-teams').onchange = (e) => updateSettings({ teamMode: e.target.checked });
  $('set-team-count').onchange = (e) => updateSettings({ teamCount: e.target.value });
  $('set-turns').onchange = (e) => updateSettings({ pictionaryTurns: e.target.value });
  $('set-drawtime').onchange = (e) => updateSettings({ drawTime: e.target.value });
  $('set-laps').onchange = (e) => updateSettings({ kartLaps: e.target.value });
  $('set-steps').onchange = (e) => updateSettings({ telephoneSteps: e.target.value });
  $('btn-shuffle').onclick = () => emit('lobby:shuffle');
  $('teams').addEventListener('click', (e) => {
    const team = e.target.closest('.team');
    if (team) emit('lobby:team', { team: Number(team.dataset.team) });
  });
  $('btn-start').onclick = async () => {
    $('lobby-error').textContent = '';
    const res = await emit('game:start');
    if (!res.ok) $('lobby-error').textContent = res.error || 'Could not start';
  };
  $('btn-stop').onclick = () => { if (confirm('End the current game for everyone?')) emit('game:stop'); };

  // ---------- Results ----------
  function renderResults() {
    const r = state.room.results;
    if (!r) return;
    const host = isHost();
    $('btn-again').classList.toggle('hidden', !host);
    $('results-wait').classList.toggle('hidden', host);
    if (r.mode === 'telephone') {
      $('results-title').textContent = `📞 That's a wrap! ${r.albums} albums revealed`;
      $('results-teams').innerHTML = '';
      $('results-players').innerHTML = '';
      return;
    }
    $('results-title').textContent = `${r.mode === 'kart' ? '🏁' : '🎨'} ${MODE_NAMES[r.mode]} results`;
    $('results-teams').innerHTML = (r.teams || []).map((t, i) => `
      <div class="team-score" style="background:${t.color}">${i === 0 ? '🏆 ' : ''}${t.name}<b>${t.score}</b></div>`).join('');
    const medal = ['🥇', '🥈', '🥉'];
    $('results-players').innerHTML = r.players.map((p, i) => {
      let extra = '';
      if (r.mode === 'kart') {
        extra = p.finished ? `${p.time.toFixed(1)}s` : 'DNF';
        if (p.hits) extra += ` · ${p.hits} hit${p.hits > 1 ? 's' : ''}`;
      }
      const team = r.teamMode ? teamById(p.team) : null;
      return `<li>${medal[i] || ''} <b style="color:${team ? team.color : p.color}">${escapeHtml(p.name)}</b>
        <span class="extra">${extra}</span><span class="pts">${p.score}</span></li>`;
    }).join('');
  }
  $('btn-again').onclick = () => emit('game:stop');

  // ---------- Chat ----------
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    $('chat-input').value = '';
  };

  socket.on('chat', (m) => {
    const log = $('chat-log');
    const div = document.createElement('div');
    div.className = 'msg';
    if (m.system) {
      div.classList.add('sys');
      if (m.good) div.classList.add('good');
      div.textContent = m.text;
    } else {
      const team = state.room?.settings.teamMode ? teamById(m.team) : null;
      div.innerHTML = `<b style="color:${team ? team.color : m.color}">${escapeHtml(m.from)}:</b>${escapeHtml(m.text)}`;
      if (m.secret) div.classList.add('secret');
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(div);
    while (log.children.length > 200) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  });

  // ---------- Game modules ----------
  function mountGame(mode) {
    if (state.game && state.game.mode === mode) return;
    unmountGame();
    const el = $('view-game');
    el.innerHTML = '';
    const Game = Games[mode];
    state.game = { mode, instance: Game.mount(el, api) };
  }

  function unmountGame() {
    if (!state.game) return;
    state.game.instance.unmount?.();
    state.game = null;
    $('view-game').innerHTML = '';
  }

  socket.on('game:snapshot', (snap) => {
    if (!state.game || state.game.mode !== snap.mode) {
      if (state.room?.state !== 'playing') return;
      mountGame(snap.mode);
    }
    state.game.instance.onSnapshot?.(snap);
  });

  socket.onAny((event, data) => {
    if (!event.startsWith('game:') || event === 'game:snapshot') return;
    state.game?.instance.onEvent?.(event, data);
  });
})();
