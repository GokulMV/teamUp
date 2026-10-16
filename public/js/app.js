/* global io, Games, Avatars */
(function () {
  const $ = (id) => document.getElementById(id);

  // ---------- Error reporting: browser errors go to the server log (e.g. Railway deploy logs) ----------
  const reported = new Set();
  function beacon(text) {
    if (reported.size > 20 || reported.has(text)) return;
    reported.add(text);
    try { navigator.sendBeacon('/api/client-error', text); } catch { /* ignore */ }
  }
  window.addEventListener('error', (e) => beacon(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno} | ${e.error?.stack?.split('\n').slice(0, 4).join(' / ') || ''} | ${navigator.userAgent}`));
  window.addEventListener('unhandledrejection', (e) => beacon(`unhandled rejection: ${e.reason?.stack || e.reason} | ${navigator.userAgent}`));

  const socket = io({ transports: ['websocket', 'polling'] });

  const MODE_NAMES = { pictionary: 'Pictionary', kart: 'Kart Battle', telephone: 'Telephone' };
  const MODE_ICONS = { pictionary: '🎨', kart: '🏎️', telephone: '📞' };

  // Settings shown in the lobby for each game. Rendered generically by renderSettings().
  const SETTINGS = {
    pictionary: [
      { key: 'pictEveryone', type: 'toggle', label: 'Everyone draws once per round' },
      { key: 'pictRounds', type: 'stepper', label: 'Rounds', min: 1, max: 10, show: (s) => s.pictEveryone },
      { key: 'pictionaryTurns', type: 'stepper', label: 'Drawing turns', min: 1, max: 30, show: (s) => !s.pictEveryone },
      { key: 'drawTime', type: 'seg', label: 'Draw time', options: [30, 45, 60, 80, 100, 120, 180].map((v) => [v, `${v}s`]) },
      { key: 'wordChoices', type: 'seg', label: 'Word choices', options: [1, 2, 3, 4, 5].map((v) => [v, `${v}`]) },
      { key: 'hints', type: 'seg', label: 'Letter hints', options: [0, 1, 2, 3, 4, 5].map((v) => [v, `${v}`]), show: (s) => s.wordMode !== 'hidden' },
      {
        key: 'wordMode', type: 'cards', label: 'Word mode', wide: true, options: [
          ['normal', '🔤', 'Normal', 'Letter blanks and hints'],
          ['hidden', '🙈', 'Hidden', 'No length, no hints'],
          ['combo', '🔗', 'Combination', 'Two words at once'],
        ],
      },
      { key: 'customWords', type: 'text', label: 'Custom words', wide: true, placeholder: 'Comma separated, e.g. moon pizza, karate cat, office chair race', hint: 'Mixed in with the built-in words unless you only use these.' },
      { key: 'customOnly', type: 'toggle', label: 'Only use my custom words' },
    ],
    telephone: [
      {
        key: 'telMode', type: 'cards', label: 'Mode', wide: true, options: [
          ['normal', '✍️', 'Normal', 'Write, draw, describe, repeat'],
          ['speedrun', '⚡', 'Speedrun', 'Same game, tiny timers'],
          ['secret', '🙈', 'Secret', 'Draw blind, you can’t see your ink'],
          ['knockoff', '🧠', 'Knock-off', 'Memorise a drawing, redraw it'],
          ['complement', '🧩', 'Complement', 'Add to the last drawing'],
        ],
      },
      { key: 'telPace', type: 'seg', label: 'Pace', options: [['slow', 'Relaxed'], ['normal', 'Normal'], ['fast', 'Fast']] },
      { key: 'telReveal', type: 'seg', label: 'Album reveal', options: [['host', 'Host clicks'], ['auto', 'Auto-play']] },
      { key: 'telephoneSteps', type: 'stepper', label: 'Chain length', min: 0, max: 30, format: (v) => (v ? v : 'All') },
    ],
    kart: [
      { key: 'kartMode', type: 'seg', label: 'Mode', options: [['race', '🏁 Race'], ['arena', '💥 Arena battle']] },
      { key: 'kartLaps', type: 'stepper', label: 'Laps', min: 1, max: 10, show: (s) => s.kartMode === 'race' },
      { key: 'arenaTime', type: 'seg', label: 'Battle time', options: [[60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']], show: (s) => s.kartMode === 'arena' },
      { key: 'kartMap', type: 'maps', label: 'Map', wide: true },
    ],
  };

  const state = {
    me: null, // { playerId, token, code }
    room: null,
    game: null, // { mode, instance }
    sideInfo: {}, // per-player extras shown in the player list: { score, guessed, drawing }
    avatar: null,
    lastResultsKey: null,
  };

  // ---------- Helpers ----------
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
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

  function avatarHtml(id, extra = '', teamColor = null) {
    const style = teamColor ? ` style="--team:${teamColor}"` : '';
    return `<span class="av${teamColor ? ' team' : ''} ${extra}"${style}>${Avatars.svg(id ?? 0)}</span>`;
  }

  function emit(event, data) {
    return new Promise((resolve) => socket.emit(event, data, (res) => resolve(res || {})));
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const savedSession = () => { try { return JSON.parse(store.get('teamup-session') || 'null'); } catch { return null; } };
  const saveSession = (s) => store.set('teamup-session', s ? JSON.stringify(s) : null);

  const me = () => state.room?.players.find((p) => p.id === state.me?.playerId);
  const isHost = () => state.room && state.me && state.room.hostId === state.me.playerId;
  const playerById = (id) => state.room?.players.find((p) => p.id === id);
  const teamById = (id) => state.room?.teams.find((t) => t.id === id);
  const teamColor = (p) => (state.room?.settings.teamMode ? teamById(p.team)?.color : null);

  // API handed to game modules.
  const api = {
    socket,
    emit,
    toast,
    escapeHtml,
    avatarHtml,
    me: () => me(),
    myId: () => state.me?.playerId,
    room: () => state.room,
    isHost,
    playerById,
    teamById,
    setSideInfo(info) { state.sideInfo = info || {}; renderPlayerList(); },
    focusChat() { if (matchMedia('(pointer: fine)').matches) $('chat-input').focus(); },
  };

  // ---------- Avatars ----------
  state.avatar = Number.parseInt(store.get('teamup-avatar'), 10);
  if (!(state.avatar >= 0 && state.avatar < Avatars.COUNT)) state.avatar = Avatars.random();

  function setAvatar(id) {
    state.avatar = ((id % Avatars.COUNT) + Avatars.COUNT) % Avatars.COUNT;
    store.set('teamup-avatar', String(state.avatar));
    $('av-current').innerHTML = Avatars.svg(state.avatar);
    if (state.me) emit('lobby:profile', { avatar: state.avatar });
  }
  $('av-prev').onclick = () => setAvatar(state.avatar - 1);
  $('av-next').onclick = () => setAvatar(state.avatar + 1);

  function openAvatarModal() {
    const grid = $('avatar-grid');
    grid.innerHTML = Array.from({ length: Avatars.COUNT }, (_, i) => `<button class="${i === state.avatar ? 'on' : ''}" data-av="${i}" aria-label="Avatar ${i + 1}">${Avatars.svg(i)}</button>`).join('');
    $('avatar-modal').classList.remove('hidden');
  }
  $('av-current').onclick = openAvatarModal;
  $('av-all').onclick = openAvatarModal;
  $('avatar-modal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-av]');
    if (b) setAvatar(Number(b.dataset.av));
    if (b || e.target.closest('[data-close]') || e.target.id === 'avatar-modal') $('avatar-modal').classList.add('hidden');
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('avatar-modal').classList.add('hidden'); });
  setAvatar(state.avatar);

  // ---------- Home ----------
  const params = new URLSearchParams(location.search);
  $('name-input').value = store.get('teamup-name') || '';
  const codeInputs = [...document.querySelectorAll('#code-boxes input')];
  const getCode = () => codeInputs.map((i) => i.value).join('').toUpperCase();
  function setCode(code) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    codeInputs.forEach((inp, i) => { inp.value = c[i] || ''; });
  }
  codeInputs.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.toUpperCase().replace(/[^A-Z]/g, '').slice(-1);
      if (inp.value && codeInputs[i + 1]) codeInputs[i + 1].focus();
      if (getCode().length === 4 && i === 3) $('btn-join').focus();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && codeInputs[i - 1]) codeInputs[i - 1].focus();
      if (e.key === 'Enter') join();
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      setCode(e.clipboardData.getData('text'));
      codeInputs[Math.min(3, getCode().length)].focus();
    });
  });
  if (params.get('room')) setCode(params.get('room'));

  function getName() {
    const name = $('name-input').value.trim();
    if (!name) { $('home-error').textContent = 'Enter your name first'; $('name-input').focus(); return null; }
    store.set('teamup-name', name);
    return name;
  }

  async function enterRoom(res) {
    if (!res.ok) { $('home-error').textContent = res.error || 'Could not join'; return false; }
    $('home-error').textContent = '';
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
    enterRoom(await emit('room:create', { name, avatar: state.avatar }));
  };

  async function join() {
    const name = getName();
    const code = getCode();
    if (!name) return;
    if (code.length !== 4) { $('home-error').textContent = 'Room codes are 4 letters'; codeInputs[code.length]?.focus(); return; }
    const saved = savedSession();
    const token = saved && saved.code === code ? saved.token : undefined;
    enterRoom(await emit('room:join', { name, code, token, avatar: state.avatar }));
  }
  $('btn-join').onclick = join;
  $('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (getCode().length === 4 ? join() : $('btn-create').click());
  });

  // Auto-rejoin after a refresh / reconnect.
  socket.on('connect', async () => {
    const saved = state.me || savedSession();
    if (!saved) return;
    const urlCode = new URLSearchParams(location.search).get('room');
    if (urlCode && urlCode.toUpperCase() !== saved.code) return;
    const res = await emit('room:join', { code: saved.code, token: saved.token, name: $('name-input').value || 'Player', avatar: state.avatar });
    if (res.ok) enterRoom(res);
    else if (state.me) { leaveLocal(); toast('That room has closed'); }
    else saveSession(null);
  });

  function leaveLocal() {
    unmountGame();
    document.body.classList.remove('in-lobby');
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
    try { await navigator.clipboard.writeText(url); toast('🔗 Invite link copied!'); } catch { toast(url); }
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
    const online = room.players.filter((p) => p.connected).length;
    $('player-count').textContent = `${online}/${room.maxPlayers} players`;
    $('side-count').textContent = `${online}`;
    $('btn-stop').classList.toggle('hidden', !(isHost() && room.state === 'playing'));
    document.body.classList.toggle('in-lobby', room.state === 'lobby');

    if (room.state === 'lobby') {
      unmountGame();
      state.sideInfo = {};
      state.lastResultsKey = null;
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
      const cls = [p.id === state.me?.playerId ? 'me' : '', p.connected ? '' : 'offline', i.guessed ? 'guessed' : '', i.drawing ? 'drawing' : ''].join(' ');
      return `<li class="${cls}">
        ${avatarHtml(p.avatar, '', teamColor(p))}
        <span class="name">${escapeHtml(p.name)}</span>
        ${p.id === room.hostId ? '<span class="tag">HOST</span>' : ''}
        ${i.drawing ? '✏️' : ''}${i.guessed ? '✅' : ''}
        ${i.score !== undefined ? `<span class="score">${i.score}</span>` : ''}
        ${isHost() && p.id !== state.me.playerId && room.state !== 'playing' ? `<button class="kick" data-kick="${p.id}" title="Remove ${escapeHtml(p.name)}">✕</button>` : ''}
      </li>`;
    }).join('');
  }

  $('player-list').addEventListener('click', (e) => {
    const id = e.target.dataset?.kick;
    if (id && confirm('Remove this player from the room?')) emit('lobby:kick', { playerId: id });
  });

  // ---------- Lobby ----------
  let settingsSig = '';
  function renderLobby() {
    const room = state.room;
    const s = room.settings;
    const host = isHost();
    document.querySelectorAll('.game-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.mode === s.mode);
      c.disabled = !host;
    });
    $('host-note').textContent = host ? 'You’re the host' : 'The host picks the game';
    $('settings-title').textContent = `${MODE_ICONS[s.mode]} ${MODE_NAMES[s.mode]} settings`;
    renderSettings(room, host);

    $('set-teams').checked = s.teamMode;
    $('set-teams').disabled = !host;
    $('team-count').innerHTML = [2, 3, 4].map((n) => `<button data-n="${n}" class="${s.teamCount === n ? 'on' : ''}" ${host ? '' : 'disabled'}>${n} teams</button>`).join('');
    document.querySelectorAll('.team-only').forEach((el) => el.classList.toggle('hidden', !s.teamMode));
    $('btn-shuffle').disabled = !host;
    $('btn-start').classList.toggle('hidden', !host);
    $('lobby-wait').classList.toggle('hidden', host);

    renderMe();
    renderPeople(room);
  }

  function controlHtml(def, s, host) {
    const dis = host ? '' : 'disabled';
    const v = s[def.key];
    switch (def.type) {
      case 'toggle':
        return `<label class="switch"><input type="checkbox" data-key="${def.key}" ${v ? 'checked' : ''} ${dis}><span class="track"><span class="thumb"></span></span><span>${def.label}</span></label>`;
      case 'stepper':
        return `<span class="label">${def.label}</span>
          <div class="stepper"><button data-key="${def.key}" data-step="-1" ${host && v > def.min ? '' : 'disabled'}>−</button><b>${def.format ? def.format(v) : v}</b><button data-key="${def.key}" data-step="1" ${host && v < def.max ? '' : 'disabled'}>+</button></div>`;
      case 'seg':
        return `<span class="label">${def.label}</span>
          <div class="seg">${def.options.map(([val, text]) => `<button data-key="${def.key}" data-value="${val}" class="${String(v) === String(val) ? 'on' : ''}" ${dis}>${text}</button>`).join('')}</div>`;
      case 'cards':
        return `<span class="label">${def.label}</span>
          <div class="option-cards">${def.options.map(([val, icon, name, desc]) => `<button class="option-card ${v === val ? 'on' : ''}" data-key="${def.key}" data-value="${val}" ${dis}><span class="oc-icon">${icon}</span><b>${name}</b><small>${desc}</small></button>`).join('')}</div>`;
      case 'maps': {
        const maps = (state.room.kartMaps || []).filter((m) => m.type === s.kartMode);
        return `<span class="label">${def.label}</span>
          <div class="option-cards">${maps.map((m) => `<button class="option-card ${v === m.id ? 'on' : ''}" data-key="kartMap" data-value="${m.id}" ${dis}><span class="oc-icon">${m.emoji}</span><b>${escapeHtml(m.name)}</b><small>${escapeHtml(m.blurb || '')}</small></button>`).join('')}</div>`;
      }
      case 'text':
        return `<span class="label">${def.label}</span>
          <textarea data-key="${def.key}" maxlength="4000" placeholder="${escapeHtml(def.placeholder || '')}" ${dis}>${escapeHtml(v || '')}</textarea>
          ${def.hint ? `<span class="hint">${def.hint}</span>` : ''}`;
      default:
        return '';
    }
  }

  function renderSettings(room, host) {
    const s = room.settings;
    const defs = (SETTINGS[s.mode] || []).filter((d) => !d.show || d.show(s));
    const sig = JSON.stringify([s, host, defs.map((d) => d.key), room.kartMaps?.length]);
    const body = $('settings-body');
    // Don't rebuild while someone is typing custom words.
    if (sig === settingsSig || (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA')) return;
    settingsSig = sig;
    body.innerHTML = defs.map((d) => `<div class="setting${d.wide ? ' wide' : ''}">${controlHtml(d, s, host)}</div>`).join('');
  }

  const updateSettings = async (patch) => {
    const res = await emit('lobby:settings', patch);
    $('lobby-error').textContent = res.ok ? '' : res.error || '';
  };
  const parseValue = (key, raw) => (typeof state.room.settings[key] === 'number' ? Number(raw) : raw);

  $('settings-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b || !isHost()) return;
    const key = b.dataset.key;
    if (b.dataset.step) updateSettings({ [key]: state.room.settings[key] + Number(b.dataset.step) });
    else updateSettings({ [key]: parseValue(key, b.dataset.value) });
  });
  $('settings-body').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.key || !isHost()) return;
    if (el.type === 'checkbox') updateSettings({ [el.dataset.key]: el.checked });
    else updateSettings({ [el.dataset.key]: el.value });
  });

  document.querySelectorAll('.game-card').forEach((c) => {
    c.onclick = () => isHost() && updateSettings({ mode: c.dataset.mode });
  });
  $('set-teams').onchange = (e) => updateSettings({ teamMode: e.target.checked });
  $('team-count').onclick = (e) => { const n = e.target.dataset?.n; if (n) updateSettings({ teamCount: Number(n) }); };
  $('btn-shuffle').onclick = () => emit('lobby:shuffle');
  $('btn-start').onclick = async () => {
    $('lobby-error').textContent = '';
    $('btn-start').disabled = true;
    const res = await emit('game:start');
    $('btn-start').disabled = false;
    if (!res.ok) $('lobby-error').textContent = res.error || 'Could not start';
  };
  $('btn-stop').onclick = () => { if (confirm('End the current game for everyone?')) emit('game:stop'); };

  function renderMe() {
    const p = me();
    if (!p) return;
    const card = $('me-card');
    const nameInput = card.querySelector('input');
    if (nameInput && document.activeElement === nameInput) return;
    card.innerHTML = `
      <span title="Change avatar" data-avatar>${avatarHtml(p.avatar)}</span>
      <div class="me-info"><small>You</small><input maxlength="16" value="${escapeHtml(p.name)}" aria-label="Your name"></div>
      <button class="btn small" data-avatar>Change avatar</button>`;
    card.querySelectorAll('[data-avatar]').forEach((el) => { el.onclick = () => { state.avatar = p.avatar; openAvatarModal(); }; });
    const input = card.querySelector('input');
    input.onchange = async () => {
      const res = await emit('lobby:profile', { name: input.value });
      if (res.name && res.name !== input.value.trim()) toast('That name is taken');
      if (res.name) store.set('teamup-name', res.name);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
  }

  function renderPeople(room) {
    const s = room.settings;
    const el = $('teams');
    $('people-count').textContent = `${room.players.length}/${room.maxPlayers}`;
    if (s.teamMode) {
      $('people-title').textContent = 'Teams';
      el.className = 'people';
      el.innerHTML = room.teams.map((t) => {
        const members = room.players.filter((p) => p.team === t.id);
        const mine = me()?.team === t.id;
        return `<div class="team-col" data-team="${t.id}" style="--team:${t.color}">
          <h4>${t.name} <span class="join">${mine ? 'Your team' : 'Click to join'} · ${members.length}</span></h4>
          <div class="members">${members.map((p) => `<span class="member">${avatarHtml(p.avatar)}${escapeHtml(p.name)}</span>`).join('') || '<span class="muted small">Nobody yet</span>'}</div>
        </div>`;
      }).join('');
    } else {
      $('people-title').textContent = 'Players';
      el.className = 'people solo';
      el.innerHTML = room.players.map((p) => `<div class="person${p.id === state.me.playerId ? ' me' : ''}">${avatarHtml(p.avatar)}<span>${escapeHtml(p.name)}</span></div>`).join('');
    }
  }
  $('teams').addEventListener('click', (e) => {
    const team = e.target.closest('.team-col');
    if (team) emit('lobby:team', { team: Number(team.dataset.team) });
  });

  // ---------- Results ----------
  function confetti() {
    const box = document.querySelector('#view-results .confetti');
    const colors = ['#ff4fa3', '#7c5cff', '#ffb547', '#22d3ee', '#34d399'];
    box.innerHTML = Array.from({ length: 70 }, (_, i) => `<i style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 1.2}s;transform:rotate(${Math.random() * 360}deg)"></i>`).join('');
  }

  function renderResults() {
    const r = state.room.results;
    if (!r) return;
    const host = isHost();
    $('btn-again').classList.toggle('hidden', !host);
    $('results-wait').classList.toggle('hidden', host);
    const key = JSON.stringify(r).length + r.mode;
    if (key !== state.lastResultsKey) { state.lastResultsKey = key; confetti(); window.Sfx?.finish?.(); }

    if (r.mode === 'telephone') {
      $('results-title').textContent = `📞 That's a wrap! ${r.albums} albums`;
      $('results-teams').innerHTML = '';
      $('podium').innerHTML = (r.favorites || []).length
        ? `<div class="muted" style="width:100%">Most loved albums</div>${r.favorites.map((f, i) => `<div class="step ${['first', 'second', 'third'][i]}">${avatarHtml(f.avatar)}<span class="nm">${escapeHtml(f.owner)}</span><span class="pts">${f.reactions} reactions</span></div>`).join('')}`
        : '';
      $('results-players').innerHTML = '';
      return;
    }
    $('results-title').textContent = r.map === 'arena' ? '💥 Arena battle results' : `${MODE_ICONS[r.mode]} ${MODE_NAMES[r.mode]} results`;
    $('results-teams').innerHTML = (r.teams || []).map((t, i) => `
      <div class="team-score" style="--team:${t.color}">${i === 0 ? '🏆 ' : ''}${t.name}<b>${t.score}</b></div>`).join('');

    const extraFor = (p) => {
      if (r.mode === 'kart' && r.map === 'arena') return `${p.kills} kills · ${p.deaths} deaths`;
      if (r.mode === 'kart') return `${p.finished ? `${p.time.toFixed(1)}s` : 'DNF'}${p.hits ? ` · ${p.hits} hits` : ''}`;
      return '';
    };
    const top = r.players.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    $('podium').innerHTML = order.map((p, i) => {
      if (!p) return '';
      const cls = ['second', 'first', 'third'][i];
      const rank = { first: 1, second: 2, third: 3 }[cls];
      return `<div class="step ${cls}">${avatarHtml(p.avatar, '', r.teamMode ? teamById(p.team)?.color : null)}
        <span class="nm">${escapeHtml(p.name)}</span><span class="pts">${p.score} pts</span><div class="block">${rank}</div></div>`;
    }).join('');
    $('results-players').innerHTML = r.players.slice(3).map((p, i) => `<li><span class="rank">${i + 4}</span>${avatarHtml(p.avatar)}
      <span class="nm">${escapeHtml(p.name)}</span><span class="extra">${extraFor(p)}</span><span class="pts">${p.score}</span></li>`).join('');
    if (r.mode === 'kart') {
      // Kart details for the podium too.
      $('podium').querySelectorAll('.step').forEach((el, i) => {
        const p = order.filter(Boolean)[i];
        if (p) el.querySelector('.pts').textContent = `${p.score} pts · ${extraFor(p)}`;
      });
    }
  }
  $('btn-again').onclick = () => emit('game:stop');

  // ---------- Sound toggle ----------
  const muteBtn = $('btn-mute');
  const syncMute = () => { muteBtn.textContent = window.Sfx.muted ? '🔇' : '🔊'; };
  muteBtn.onclick = () => { window.Sfx.setMuted(!window.Sfx.muted); syncMute(); };
  syncMute();

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
      if (m.good) { div.classList.add('good'); window.Sfx.correct(); }
      div.textContent = m.text;
    } else {
      const team = state.room?.settings.teamMode ? teamById(m.team) : null;
      div.innerHTML = `${avatarHtml(m.avatar ?? 0)}<div class="body"><b style="color:${team ? team.color : m.color}">${escapeHtml(m.from)}</b>${escapeHtml(m.text)}</div>`;
      if (m.secret) div.classList.add('secret');
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.appendChild(div);
    while (log.children.length > 200) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  });

  // ---------- Game modules ----------
  function showGameError(err) {
    console.error(err);
    beacon(`game mount failed: ${err?.stack || err} | ${navigator.userAgent}`);
    $('view-game').innerHTML = `<div class="overlay" style="position:relative;height:100%"><h2>😵 This game couldn’t load</h2>
      <p class="muted">Try refreshing the page. If it keeps happening, the host can end the game and start again.</p>
      <button class="btn primary" onclick="location.reload()">Refresh</button></div>`;
  }

  function mountGame(mode) {
    if (state.game && state.game.mode === mode) return;
    unmountGame();
    const el = $('view-game');
    el.innerHTML = '';
    try {
      state.game = { mode, instance: Games[mode].mount(el, api) };
    } catch (err) {
      state.game = { mode, instance: {}, failed: true };
      showGameError(err);
    }
  }

  function unmountGame() {
    if (!state.game) return;
    try { state.game.instance.unmount?.(); } catch (err) { console.error(err); }
    state.game = null;
    $('view-game').innerHTML = '';
  }

  socket.on('game:snapshot', (snap) => {
    if (!state.game || state.game.mode !== snap.mode) {
      if (state.room?.state !== 'playing') return;
      mountGame(snap.mode);
    }
    try { state.game.instance.onSnapshot?.(snap); } catch (err) { console.error(err); beacon(`snapshot: ${err?.stack || err}`); }
  });

  socket.onAny((event, data) => {
    if (!event.startsWith('game:') || event === 'game:snapshot') return;
    try { state.game?.instance.onEvent?.(event, data); } catch (err) { console.error(err); beacon(`${event}: ${err?.stack || err}`); }
  });
})();
