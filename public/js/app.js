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

  // A page left open across a deploy would play the old code against the new server: other maps,
  // another snapshot format, karts jumping about. The server says which build it runs; when it is
  // not this page's, reload (the saved session puts the player straight back in their room). Only
  // once per build, so a stale cache somewhere can't make it loop.
  const BUILD = document.querySelector('meta[name="teamup-build"]')?.content || null;
  function staleReload(build) {
    let done = null;
    try { done = sessionStorage.getItem('teamup-reloaded-for'); } catch { /* storage blocked */ }
    if (done === String(build)) return false;
    try { sessionStorage.setItem('teamup-reloaded-for', String(build)); } catch { /* storage blocked */ }
    location.reload();
    return true;
  }
  socket.on('server:hello', (data) => {
    const build = data && data.build;
    if (BUILD && build && build !== BUILD && !staleReload(build)) toast('TeamUp was updated: refresh the page to get the new version');
  });
  window.TeamUpStale = () => staleReload(`unknown-map-${BUILD}`); // a game that meets something this code doesn't know

  const MODE_NAMES = { pictionary: 'Pictionary', kart: 'Kart Battle', telephone: 'Telephone', ballchain: 'Ball & Chain', controlroom: 'Control Room' };
  const MODE_ICONS = { pictionary: '🎨', kart: '🏎️', telephone: '📞', ballchain: '⛓️', controlroom: '🎛️' };

  // Settings shown in the lobby for each game, rendered by renderSettings().
  //   type: toggle | stepper | seg | slider | cards | maps | items | text
  //   block: full-width control under its label (otherwise a compact row: label left, control right)
  //   adv: shown under "More options"; show(s): only when it applies; def: value until the server sends one
  const ITEM_IDS = ['boost', 'rocket', 'triple', 'bouncer', 'banana', 'shield', 'mine', 'minigun', 'bomb', 'shock', 'ghost', 'star', 'ink', 'comet', 'thunder'];
  const SETTINGS = {
    pictionary: [
      {
        key: 'wordMode', type: 'cards', label: 'Word mode', block: true, options: [
          ['normal', '🔤', 'Normal', 'Letter blanks with hints'],
          ['hidden', '🙈', 'Hidden', 'No length, no hints'],
          ['combo', '🔗', 'Combination', 'Two words at once'],
        ],
      },
      { key: 'drawTime', type: 'slider', label: 'Draw time', min: 15, max: 240, step: 5, unit: 's', block: true },
      { key: 'pictEveryone', type: 'toggle', label: 'Everyone draws', hint: 'Each player draws once per round' },
      { key: 'pictRounds', type: 'stepper', label: 'Rounds', min: 1, max: 10, show: (s) => s.pictEveryone },
      { key: 'pictionaryTurns', type: 'stepper', label: 'Drawing turns', min: 1, max: 30, show: (s) => !s.pictEveryone },
      { key: 'wordChoices', type: 'stepper', label: 'Word choices', hint: 'Words the drawer picks from', min: 2, max: 5 },
      { key: 'hints', type: 'stepper', label: 'Letter hints', hint: 'Letters revealed over time', min: 0, max: 5, show: (s) => s.wordMode !== 'hidden' },
      { key: 'customWords', type: 'text', label: 'Custom words', block: true, adv: true, placeholder: 'Comma separated, e.g. moon pizza, karate cat, office chair race', hint: 'Mixed in with the built-in words unless you only use these.' },
      { key: 'customOnly', type: 'toggle', label: 'Only my custom words', hint: 'Needs at least as many words as word choices', adv: true },
    ],
    telephone: [
      {
        key: 'telMode', type: 'cards', label: 'Mode', block: true, options: [
          ['normal', '✍️', 'Normal', 'Write, draw, describe, repeat'],
          ['speedrun', '⚡', 'Speedrun', 'Same game, tiny timers'],
          ['secret', '🙈', 'Secret', 'Draw blind: no ink on screen'],
          ['knockoff', '🧠', 'Knock-off', 'Memorise a drawing, redraw it'],
          ['complement', '🧩', 'Complement', 'Add to the last drawing'],
        ],
      },
      { key: 'telPace', type: 'seg', label: 'Pace', options: [['slow', 'Relaxed'], ['normal', 'Normal'], ['fast', 'Fast']] },
      { key: 'telReveal', type: 'seg', label: 'Album reveal', options: [['host', 'Host'], ['auto', 'Auto']] },
      { key: 'telephoneSteps', type: 'stepper', label: 'Chain length', hint: 'Steps per album', min: 0, max: 30, format: (v) => (v ? v : 'All') },
    ],
    kart: [
      { key: 'kartMode', type: 'seg', label: 'Mode', block: true, options: [['race', '🏁 Race'], ['arena', '💥 Battle arena']] },
      { key: 'kartMap', type: 'maps', label: 'Map', block: true },
      { key: 'kartLaps', type: 'stepper', label: 'Laps', min: 1, max: 10, show: (s) => s.kartMode === 'race' },
      { key: 'arenaTime', type: 'seg', label: 'Match length', options: [[60, '1m'], [120, '2m'], [180, '3m'], [300, '5m']], show: (s) => s.kartMode === 'arena' },
      { key: 'arenaKillLimit', type: 'seg', label: 'Kill limit', def: 0, options: [[0, 'Off'], [5, '5'], [10, '10'], [15, '15'], [25, '25']], show: (s) => s.kartMode === 'arena' },
      { key: 'kartBots', type: 'stepper', label: 'CPU drivers', hint: 'Fill the grid with AI', def: 0, min: 0, max: 15 },
      { key: 'kartBotSkill', type: 'seg', label: 'CPU skill', def: 'normal', options: [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], show: (s) => (s.kartBots ?? 0) > 0 },
      { key: 'kartClass', type: 'seg', label: 'Speed', def: 'standard', options: [['chill', 'Chill'], ['standard', 'Std'], ['turbo', 'Turbo']] },
      { key: 'kartItems', type: 'seg', label: 'Items', def: 'all', adv: true, block: true, options: [['all', 'All items'], ['weapons', 'Weapons only'], ['none', 'No items'], ['custom', 'Custom']] },
      { key: 'kartItemList', type: 'items', label: 'Pick items', def: ITEM_IDS, adv: true, block: true, show: (s) => (s.kartItems ?? 'all') === 'custom' },
      { key: 'kartBoxRespawn', type: 'seg', label: 'Item boxes', def: 'normal', adv: true, options: [['rare', 'Rare'], ['normal', 'Normal'], ['frequent', 'Lots']], show: (s) => (s.kartItems ?? 'all') !== 'none' },
      { key: 'kartCatchup', type: 'toggle', label: 'Catch-up items', hint: 'Racers at the back get stronger items', def: true, adv: true, show: (s) => s.kartMode === 'race' },
      { key: 'kartReverse', type: 'toggle', label: 'Reverse direction', hint: 'Drive the circuit backwards', def: false, adv: true, show: (s) => s.kartMode === 'race' },
      { key: 'arenaRespawn', type: 'seg', label: 'Respawn', def: 'normal', adv: true, options: [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']], show: (s) => s.kartMode === 'arena' },
      { key: 'arenaHealth', type: 'seg', label: 'Health', def: 'normal', adv: true, options: [['low', 'Glass'], ['normal', 'Normal'], ['high', 'Tank']], show: (s) => s.kartMode === 'arena' },
    ],
    ballchain: [
      {
        key: 'bcLength', type: 'cards', label: 'Course length', block: true, def: 'normal', options: [
          ['short', '⚡', 'Short', '4 obstacles · about 1½ min'],
          ['normal', '⛓️', 'Normal', '6 obstacles · about 2½ min'],
          ['long', '🏔️', 'Long', '8 obstacles · about 3½ min'],
        ],
      },
      { key: 'bcCourses', type: 'seg', label: 'Courses', hint: 'Per match', def: 3, options: [[1, '1'], [3, '3'], [5, '5']] },
      { key: 'bcRope', type: 'seg', label: 'Rope length', def: 'normal', options: [['short', 'Short'], ['normal', 'Normal'], ['long', 'Long']] },
      { key: 'bcSabotage', type: 'toggle', label: 'Sabotage', hint: 'First team to a checkpoint drops a trap on the teams behind', def: true },
    ],
    controlroom: [
      {
        key: 'crDifficulty', type: 'cards', label: 'Difficulty', block: true, def: 'pilot', options: [
          ['cadet', '🛰️', 'Cadet', 'Long timers, gentle events'],
          ['pilot', '🚀', 'Pilot', 'The classic shouting match'],
          ['ace', '☄️', 'Ace', 'Short fuses, chaos from sector 1'],
        ],
      },
      { key: 'crSectors', type: 'seg', label: 'Sectors', hint: 'Endless: fly until your ship breaks', def: 5, options: [[5, '5'], [10, '10'], [0, 'Endless']] },
      { key: 'crComms', type: 'seg', label: 'Comms', block: true, hint: 'Voice: shout across the room or call. Relay: tap your order to flash it on your crew’s screens.', def: 'voice', options: [['voice', '🗣️ Voice'], ['relay', '📡 Relay']] },
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
  // The room session (code + token) is kept per tab, so a reload puts this tab back as the same
  // player while another tab (a second player on the same computer) stays someone else.
  const tabStore = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  store.set('teamup-session', null); // where older builds kept it, shared by every tab
  const savedSession = () => { try { return JSON.parse(tabStore.get('teamup-session') || 'null'); } catch { return null; } };
  const saveSession = (s) => tabStore.set('teamup-session', s ? JSON.stringify(s) : null);

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
    toggleChat: () => toggleChat(),
    openMenu: (anchor) => openMenu(anchor),
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
    structureSig = ''; peopleSig = ''; meSig = '';
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
    // Kart games (and Ball & Chain) take over the screen: on phones the page jumps back to the top and chat becomes a sheet.
    const kartPlaying = room.state === 'playing' && (room.settings.mode === 'kart' || room.settings.mode === 'ballchain');
    if (kartPlaying && !document.body.classList.contains('kart-playing') && matchMedia('(pointer: coarse), (max-width: 980px)').matches) window.scrollTo(0, 0);
    document.body.classList.toggle('kart-playing', kartPlaying);
    if (!kartPlaying) { toggleChat(false); closeMenu(); setUnread(0); $('chat-ticker').innerHTML = ''; }
    $('chat-input').placeholder = room.state === 'playing' && room.settings.mode === 'pictionary' ? 'Chat or type your guess…' : 'Chat…';

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
  // Rendering is incremental: a control is only redrawn when its own value changes, and the player
  // list only when the players change, so clicking an option never makes the lobby jump or re-animate.
  let advancedOpen = store.get('teamup-adv') === '1';
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
    $('team-count').querySelectorAll('button').forEach((b) => { b.classList.toggle('on', Number(b.dataset.n) === s.teamCount); b.disabled = !host; });
    document.querySelectorAll('.team-only').forEach((el) => el.classList.toggle('hidden', !s.teamMode));
    $('btn-shuffle').disabled = !host;
    $('btn-start').classList.toggle('hidden', !host);
    $('lobby-wait').classList.toggle('hidden', host);

    renderMe();
    renderPeople(room);
  }
  $('team-count').innerHTML = [2, 3, 4, 5].map((n) => `<button data-n="${n}">${n} teams</button>`).join('');

  const valueOf = (def, s) => (s[def.key] !== undefined ? s[def.key] : def.def);

  // ----- maps: overview art, layout outline and stats -----
  function mapOutline(m) {
    const map = window.KartCore?.MAPS?.[m.id];
    if (!map) return '';
    const b = map.bounds;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const ox = b.minX - (size - (b.maxX - b.minX)) / 2;
    const oy = b.minY - (size - (b.maxY - b.minY)) / 2;
    const P = (x, y) => `${(((x - ox) / size) * 100).toFixed(2)},${(((y - oy) / size) * 100).toFixed(2)}`;
    if (map.type === 'race') {
      const d = `M${map.centerline.filter((_, i) => i % 3 === 0).map(([x, y]) => P(x, y)).join('L')}Z`;
      const [sx, sy] = map.centerline[0];
      return `<svg viewBox="0 0 100 100" class="map-outline" aria-hidden="true">
        <path d="${d}" class="mo-road-edge" style="stroke-width:${((map.width / size) * 100 * 0.9).toFixed(2)}"/>
        <path d="${d}" class="mo-road" style="stroke-width:${((map.width / size) * 100 * 0.55).toFixed(2)}"/>
        <circle cx="${P(sx, sy).split(',')[0]}" cy="${P(sx, sy).split(',')[1]}" r="2.6" class="mo-start"/></svg>`;
    }
    const r = (v) => ((v / size) * 100).toFixed(2);
    if (map.layered) return `<svg viewBox="0 0 100 100" class="map-outline" aria-hidden="true"><rect x="0" y="0" width="100" height="100" rx="2" class="mo-floor"/></svg>`;
    return `<svg viewBox="0 0 100 100" class="map-outline" aria-hidden="true">
      <rect x="${r(40)}" y="${r(40)}" width="${r(map.size - 80)}" height="${r(map.size - 80)}" rx="2" class="mo-floor"/>
      ${map.hazards.map((h) => `<circle cx="${r(h.x)}" cy="${r(h.y)}" r="${r(h.r)}" class="mo-lava"/>`).join('')}
      ${map.obstacles.map((o) => `<circle cx="${r(o.x)}" cy="${r(o.y)}" r="${r(o.r)}" class="mo-block"/>`).join('')}</svg>`;
  }

  // The overview's inset is the in-game minimap (same colours and outline), drawn once per map.
  // The weekly arena's entry names the exact layout the server made this week.
  const mapIdOf = (m) => (m.weekly && m.weekly.mapId) || m.id;
  const insetCache = new Map();
  function mapInset(m) {
    const id = mapIdOf(m);
    let url = insetCache.get(id);
    if (!url) {
      try {
        const c = document.createElement('canvas');
        window.KartMinimap.create(c, window.KartCore.getMap(id, m.type), { cssSize: m.weekly ? 200 : 132, dpr: 2 }).draw({ time: 0 });
        url = c.toDataURL();
        insetCache.set(id, url);
      } catch {
        return mapOutline(m);
      }
    }
    return `<img class="map-inset" src="${url}" alt="">`;
  }

  // "3d 4h" until the next weekly arena.
  function untilNext(ms) {
    const h = Math.max(0, Math.floor((ms - Date.now()) / 3600000));
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h >= 1 ? `${h}h` : 'under an hour';
  }

  function mapStats(m) {
    if (m.weekly && !m.weekly.mapId) return [];
    const map = m.weekly ? window.KartCore?.getMap(mapIdOf(m), 'arena') : window.KartCore?.MAPS?.[m.id];
    if (!map) return [];
    const stats = [];
    if (map.type === 'race') {
      let len = 0;
      for (let i = 0; i < map.n; i++) {
        const a = map.centerline[i];
        const c = map.centerline[(i + 1) % map.n];
        len += Math.hypot(c[0] - a[0], c[1] - a[1]);
      }
      stats.push(`📏 ${Math.round(len / 20)} m lap`);
      stats.push(`⏱️ ~${Math.round(len / (window.KartCore.PHYS.maxSpeed * 0.85))} s`);
      if (map.climb > 100) stats.push(`⛰️ ${Math.round(map.climb / 20)} m climb`);
      const jumps = (map.ramps || []).filter((r) => r.dir === 1).length;
      if (jumps) stats.push(`🦘 ${jumps} jump${jumps > 1 ? 's' : ''}`);
      if (map.water !== null && map.water !== undefined) stats.push('🌊 Water');
      if ((map.liquids || []).some((l) => l.kind === 'lava')) stats.push('🔥 Lava');
      if (map.grip && map.grip < 1) stats.push('🧊 Slippery');
    } else if (map.layered) {
      // Layered arenas: how many floors, and what moves or launches you.
      const levels = new Set(map.solids.filter((sd) => sd.z1 >= -1 && sd.kind !== 'merlon').map((sd) => Math.round(sd.z1 / 20)));
      stats.push(`📐 ${Math.round(map.size / 20)} m arena`);
      stats.push(`🏯 ${levels.size} levels`);
      if (map.pads.length) stats.push(`🚀 ${map.pads.length} jump pads`);
      const bridges = map.movers.filter((mv) => mv.type === 'drawbridge').length;
      if (bridges) stats.push(`🌉 ${bridges} drawbridges`);
      if (map.liquid) stats.push(map.liquid.kind === 'lava' ? '🔥 Lava moat' : '🌊 Moat');
      else if (map.edge === 'void') stats.push('🕳️ Open edges');
    } else {
      stats.push(`📐 ${Math.round(map.size / 20)} m arena`);
      if (map.hazards.length) stats.push(`🌋 ${map.hazards.length} lava pools`);
      stats.push(`🧱 ${map.obstacles.length} obstacles`);
    }
    if (map.boostPads.length) stats.push(`⚡ ${map.boostPads.length} boost pads`);
    stats.push(`🎁 ${map.itemBoxes.length} item boxes`);
    return stats;
  }

  function mapsHtml(def, v, host) {
    const maps = (state.room.kartMaps || []).filter((m) => m.type === (state.room.settings.kartMode || 'race'));
    const cur = maps.find((m) => m.id === v) || maps[0];
    if (!cur) return '';
    const wk = cur.weekly;
    return `<div class="map-overview" style="--art:url('/img/maps/${cur.id}.jpg')">
        <div class="mo-art ${wk ? `weekly wk-${wk.theme}` : ''}">${mapInset(cur)}${wk ? `<span class="mo-ribbon">New this week · ${escapeHtml(wk.week.slice(5))}</span>` : ''}</div>
        <div class="mo-info">
          <span class="mo-kicker">${wk ? `Weekly arena · next one in ${untilNext(wk.next)}` : cur.type === 'race' ? 'Race track' : 'Battle arena'}</span>
          <h4>${cur.emoji} ${escapeHtml(cur.name)}</h4>
          <p>${escapeHtml(cur.blurb || '')}</p>
          <div class="mo-chips">${mapStats(cur).map((t) => `<span>${t}</span>`).join('')}</div>
        </div>
      </div>
      <div class="map-thumbs">${maps.map((m) => `<button class="map-thumb ${m.id === cur.id ? 'on' : ''} ${m.weekly ? `weekly wk-${m.weekly.theme}` : ''}" data-key="kartMap" data-value="${m.id}" ${host ? '' : 'disabled'} style="--art:url('/img/maps/${m.id}.jpg')" title="${escapeHtml(m.name)}">
        ${m.weekly ? '<span class="mt-tag">Weekly</span>' : ''}<span class="mt-name">${m.emoji} ${escapeHtml(m.name)}</span></button>`).join('')}</div>`;
  }

  function controlInner(def, s, host) {
    const dis = host ? '' : 'disabled';
    const v = valueOf(def, s);
    const label = `<div class="lbl"><b>${def.label}</b>${def.hint ? `<small>${def.hint}</small>` : ''}</div>`;
    switch (def.type) {
      case 'toggle':
        return `${label}<label class="switch"><input type="checkbox" data-key="${def.key}" ${v ? 'checked' : ''} ${dis} aria-label="${def.label}"><span class="track"><span class="thumb"></span></span></label>`;
      case 'stepper':
        return `${label}<div class="stepper"><button data-key="${def.key}" data-step="-1" ${host && v > def.min ? '' : 'disabled'} aria-label="Less">−</button><b>${def.format ? def.format(v) : v}</b><button data-key="${def.key}" data-step="1" ${host && v < def.max ? '' : 'disabled'} aria-label="More">+</button></div>`;
      case 'seg':
        return `${label}<div class="seg" style="--n:${def.options.length}">${def.options.map(([val, text]) => `<button data-key="${def.key}" data-value="${val}" class="${String(v) === String(val) ? 'on' : ''}" ${dis}>${text}</button>`).join('')}</div>`;
      case 'slider': {
        const pct = ((v - def.min) / (def.max - def.min)) * 100;
        return `<div class="lbl"><b>${def.label}</b></div><output class="slider-val">${v}${def.unit || ''}</output>
          <input type="range" class="slider" data-key="${def.key}" min="${def.min}" max="${def.max}" step="${def.step}" value="${v}" style="--pct:${pct}%" ${dis}>`;
      }
      case 'cards':
        return `${label}<div class="option-cards">${def.options.map(([val, icon, name, desc]) => `<button class="option-card ${v === val ? 'on' : ''}" data-key="${def.key}" data-value="${val}" ${dis}><span class="oc-icon">${icon}</span><span class="oc-text"><b>${name}</b><small>${desc}</small></span></button>`).join('')}</div>`;
      case 'maps':
        return mapsHtml(def, v, host);
      case 'items': {
        const list = Array.isArray(v) ? v : ITEM_IDS;
        return `${label}<div class="item-picks">${ITEM_IDS.map((id) => `<button class="item-pick ${list.includes(id) ? 'on' : ''}" data-key="${def.key}" data-item="${id}" ${dis} title="${window.ItemIcons.description(id)}">
          ${window.ItemIcons.svg(id)}<span>${window.ItemIcons.name(id)}</span></button>`).join('')}</div>`;
      }
      case 'text':
        return `${label}<textarea data-key="${def.key}" maxlength="4000" placeholder="${escapeHtml(def.placeholder || '')}" ${dis}>${escapeHtml(v || '')}</textarea>`;
      default:
        return '';
    }
  }

  const ROW_TYPES = new Set(['toggle', 'stepper', 'seg']);
  const settingHtml = (def, s, host) => {
    const layout = def.block || !ROW_TYPES.has(def.type) ? 'block' : 'row';
    return `<div class="setting ${layout} t-${def.type}" data-setting="${def.key}">${controlInner(def, s, host)}</div>`;
  };

  let structureSig = '';
  let shownValues = {};
  function renderSettings(room, host) {
    const s = room.settings;
    const defs = (SETTINGS[s.mode] || []).filter((d) => !d.show || d.show(s));
    const basic = defs.filter((d) => !d.adv);
    const adv = defs.filter((d) => d.adv);
    const sig = JSON.stringify([s.mode, host, defs.map((d) => d.key), (room.kartMaps || []).map((m) => m.id)]);
    const body = $('settings-body');
    const valueKey = (d) => JSON.stringify([valueOf(d, s), d.type === 'maps' ? s.kartMode : 0]);
    if (sig !== structureSig) {
      structureSig = sig;
      body.innerHTML = `<div class="settings-grid">${basic.map((d) => settingHtml(d, s, host)).join('')}</div>
        ${adv.length ? `<button class="adv-toggle ${advancedOpen ? 'open' : ''}" type="button" data-adv><span>More options</span><small>${adv.length}</small><i>⌄</i></button>
        <div class="settings-grid adv ${advancedOpen ? '' : 'hidden'}">${adv.map((d) => settingHtml(d, s, host)).join('')}</div>` : ''}`;
      shownValues = Object.fromEntries(defs.map((d) => [d.key, valueKey(d)]));
      return;
    }
    // Same controls: only redraw the ones whose value changed (keep focus/typing intact).
    for (const d of defs) {
      const vk = valueKey(d);
      if (shownValues[d.key] === vk) continue;
      shownValues[d.key] = vk;
      const el = body.querySelector(`[data-setting="${d.key}"]`);
      if (!el) continue;
      if (d.type === 'text' && document.activeElement === el.querySelector('textarea')) continue;
      if (d.type === 'slider' && document.activeElement === el.querySelector('input')) continue;
      el.innerHTML = controlInner(d, s, host);
    }
  }

  const updateSettings = async (patch) => {
    const res = await emit('lobby:settings', patch);
    $('lobby-error').textContent = res.ok ? '' : res.error || '';
  };
  const defFor = (key) => (SETTINGS[state.room.settings.mode] || []).find((d) => d.key === key);
  const parseValue = (key, raw) => {
    const cur = valueOf(defFor(key) || { key }, state.room.settings);
    return typeof cur === 'number' ? Number(raw) : raw;
  };

  $('settings-body').addEventListener('click', (e) => {
    if (e.target.closest('[data-adv]')) {
      advancedOpen = !advancedOpen;
      store.set('teamup-adv', advancedOpen ? '1' : '0');
      e.target.closest('[data-adv]').classList.toggle('open', advancedOpen);
      $('settings-body').querySelector('.settings-grid.adv')?.classList.toggle('hidden', !advancedOpen);
      return;
    }
    const b = e.target.closest('button[data-key]');
    if (!b || !isHost()) return;
    const key = b.dataset.key;
    if (b.dataset.item) {
      const cur = valueOf(defFor(key), state.room.settings);
      const list = new Set(Array.isArray(cur) ? cur : ITEM_IDS);
      if (list.has(b.dataset.item)) list.delete(b.dataset.item); else list.add(b.dataset.item);
      updateSettings({ [key]: ITEM_IDS.filter((id) => list.has(id)) });
      return;
    }
    if (b.dataset.step) updateSettings({ [key]: valueOf(defFor(key), state.room.settings) + Number(b.dataset.step) });
    else updateSettings({ [key]: parseValue(key, b.dataset.value) });
  });
  $('settings-body').addEventListener('input', (e) => {
    const el = e.target;
    if (el.type !== 'range') return;
    const def = defFor(el.dataset.key);
    el.style.setProperty('--pct', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
    const out = el.parentElement.querySelector('.slider-val');
    if (out) out.textContent = `${el.value}${def?.unit || ''}`;
  });
  $('settings-body').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.key || !isHost()) return;
    if (el.type === 'checkbox') updateSettings({ [el.dataset.key]: el.checked });
    else if (el.type === 'range') updateSettings({ [el.dataset.key]: Number(el.value) });
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

  let meSig = '';
  function renderMe() {
    const p = me();
    if (!p) return;
    const card = $('me-card');
    const kart = state.room.settings.mode === 'kart';
    const sig = `${p.name}|${p.avatar}|${kart}`;
    const nameInput = card.querySelector('input');
    if (sig === meSig || (nameInput && document.activeElement === nameInput)) return;
    meSig = sig;
    card.innerHTML = `
      <span title="Change avatar" data-avatar>${avatarHtml(p.avatar)}</span>
      <div class="me-info"><small>${kart ? 'Your driver' : 'You'}</small><input maxlength="16" value="${escapeHtml(p.name)}" aria-label="Your name"></div>
      <button class="icon-btn" data-avatar title="Change avatar" aria-label="Change avatar">🎭</button>`;
    card.querySelectorAll('[data-avatar]').forEach((el) => { el.onclick = () => { state.avatar = p.avatar; openAvatarModal(); }; });
    const input = card.querySelector('input');
    input.onchange = async () => {
      const res = await emit('lobby:profile', { name: input.value });
      if (res.name && res.name !== input.value.trim()) toast('That name is taken');
      if (res.name) store.set('teamup-name', res.name);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
  }

  let peopleSig = '';
  const seenPeople = new Set();
  function renderPeople(room) {
    const s = room.settings;
    const el = $('teams');
    $('people-count').textContent = `${room.players.length}/${room.maxPlayers}`;
    const sig = JSON.stringify([s.teamMode, s.teamMode ? s.teamCount : 0, state.me.playerId,
      room.players.map((p) => [p.id, p.name, p.avatar, p.team, p.connected])]);
    if (sig === peopleSig) return;
    peopleSig = sig;
    // Only players we haven't shown before animate in.
    const enter = (p) => (seenPeople.has(p.id) ? '' : ' enter');
    if (s.teamMode) {
      $('people-title').textContent = 'Teams';
      el.className = 'people';
      el.innerHTML = room.teams.map((t) => {
        const members = room.players.filter((p) => p.team === t.id);
        const mine = me()?.team === t.id;
        return `<div class="team-col${mine ? ' mine' : ''}" data-team="${t.id}" style="--team:${t.color}">
          <h4>${t.name} <span class="join">${mine ? 'Your team' : 'Join'} · ${members.length}</span></h4>
          <div class="members">${members.map((p) => `<span class="member${enter(p)}${p.connected ? '' : ' offline'}">${avatarHtml(p.avatar)}${escapeHtml(p.name)}</span>`).join('') || '<span class="muted small">Nobody yet</span>'}</div>
        </div>`;
      }).join('');
    } else {
      $('people-title').textContent = 'Players';
      el.className = 'people solo';
      el.innerHTML = room.players.map((p) => `<div class="person${p.id === state.me.playerId ? ' me' : ''}${enter(p)}${p.connected ? '' : ' offline'}">${avatarHtml(p.avatar)}<span>${escapeHtml(p.name)}</span>${p.id === room.hostId ? '<i class="crown" title="Host">👑</i>' : ''}</div>`).join('');
    }
    room.players.forEach((p) => seenPeople.add(p.id));
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

    // Games can draw their own results (Control Room's mission report, Ball & Chain's standings).
    // A renderer that throws falls back to the plain ranking below, never a blank screen.
    const custom = window.Games?.[r.mode]?.renderResults;
    if (custom) {
      try {
        custom(r, { title: $('results-title'), teams: $('results-teams'), podium: $('podium'), list: $('results-players'), $, avatarHtml, escapeHtml, teamById }, api);
        return;
      } catch (err) {
        console.error(err);
        window.reportError?.(err);
      }
    }

    if (r.mode === 'telephone') {
      $('results-title').textContent = `📞 That's a wrap! ${r.albums} albums`;
      $('results-teams').innerHTML = '';
      $('podium').innerHTML = (r.favorites || []).length
        ? `<div class="muted" style="width:100%">Most loved albums</div>${r.favorites.map((f, i) => `<div class="step ${['first', 'second', 'third'][i]}">${avatarHtml(f.avatar)}<span class="nm">${escapeHtml(f.owner)}</span><span class="pts">${f.reactions} reactions</span></div>`).join('')}`
        : '';
      $('results-players').innerHTML = '';
      return;
    }
    const arena = r.mode === 'kart' && r.map === 'arena';
    // Kart titles use the HUD's SVG icons; "Nobody got smashed!" only when nobody died at all.
    const nobody = arena && r.players.every((p) => !p.score && !p.deaths);
    if (r.mode === 'kart') {
      const icon = (arena ? window.KartHud?.ICONS.boom : window.KartHud?.ICONS.flag) || '';
      $('results-title').innerHTML = `${icon.replace('class="hud-ic"', 'class="res-ic"')}<span>${nobody ? 'Nobody got smashed!' : arena ? 'Battle results' : 'Race results'}</span>`;
    } else {
      $('results-title').textContent = `${MODE_ICONS[r.mode]} ${MODE_NAMES[r.mode]} results`;
    }
    $('results-teams').innerHTML = (r.teams || []).map((t, i) => `
      <div class="team-score" style="--team:${t.color}">${i === 0 ? '🏆 ' : ''}${t.name}<b>${t.score}</b></div>`).join('');

    // Kart players who joined mid-round only watched: they have no race or battle details.
    const watched = (p) => r.mode === 'kart' && p.place === undefined;
    const extraFor = (p) => {
      if (watched(p)) return 'Spectated';
      if (arena) return `${p.kills} KO${p.kills === 1 ? '' : 's'} · ${p.deaths} death${p.deaths === 1 ? '' : 's'}`;
      if (r.mode === 'kart') return `${p.finished ? `${p.time.toFixed(1)}s` : 'DNF'}${p.hits ? ` · ${p.hits} hit${p.hits === 1 ? '' : 's'}` : ''}`;
      return '';
    };
    // Players with the same score (and, in the arena, the same deaths) share a rank: "=1".
    const ranks = [];
    r.players.forEach((p, i) => {
      const q = r.players[i - 1];
      ranks.push(q && q.score === p.score && (!arena || q.deaths === p.deaths) ? ranks[i - 1] : i + 1);
    });
    const rankLabel = (i) => (ranks.filter((x) => x === ranks[i]).length > 1 ? `=${ranks[i]}` : `${ranks[i]}`);
    // Races are ranked by points (placing plus hits), so the podium shows them next to the time.
    const podiumText = (p) => {
      if (arena || watched(p)) return extraFor(p);
      if (r.mode === 'kart') return `${p.score} pts · ${p.finished ? `${p.time.toFixed(1)}s` : 'DNF'}`;
      return `${p.score} pts`;
    };
    const me = (p) => (p.id === state.me?.playerId ? 'me' : '');
    const order = [1, 0, 2];
    $('podium').innerHTML = order.map((i, slot) => {
      const p = r.players[i];
      if (!p) return '';
      const cls = ['second', 'first', 'third'][slot];
      return `<div class="step ${cls} ${me(p)}">${avatarHtml(p.avatar, '', r.teamMode ? teamById(p.team)?.color : null)}
        <span class="nm">${escapeHtml(p.name)}</span><span class="pts">${podiumText(p)}</span><div class="block">${rankLabel(i)}</div></div>`;
    }).join('');
    // Arena KOs already say it all; other modes label their points.
    $('results-players').innerHTML = r.players.slice(3).map((p, i) => `<li class="${me(p)}"><span class="rank">${rankLabel(i + 3)}</span>${avatarHtml(p.avatar)}
      <span class="nm">${escapeHtml(p.name)}</span><span class="extra">${extraFor(p)}</span>${arena || watched(p) ? '' : `<span class="pts">${p.score}<small>pts</small></span>`}</li>`).join('');
  }
  $('btn-again').onclick = () => emit('game:stop');

  // ---------- Sound toggle ----------
  const muteBtn = $('btn-mute');
  const syncMute = () => { muteBtn.textContent = window.Sfx.muted ? '🔇' : '🔊'; };
  muteBtn.onclick = () => { window.Sfx.setMuted(!window.Sfx.muted); syncMute(); };
  syncMute();

  // ---------- Chat drawer/sheet and game menu (kart games) ----------
  // During a kart game chat is closed by default: a drawer on desktop (button or Enter), a sheet on
  // phones. Messages that arrive meanwhile bump an unread count and, on desktop, show in a ticker.
  const desktop = matchMedia('(min-width: 981px) and (pointer: fine)');
  let unread = 0;
  function setUnread(n) {
    unread = n;
    if (n) $('btn-chat').dataset.unread = n > 9 ? '9+' : String(n); else delete $('btn-chat').dataset.unread;
    document.body.classList.toggle('chat-unread', n > 0);
  }
  function toggleChat(open = !document.body.classList.contains('chat-open'), focus = false) {
    document.body.classList.toggle('chat-open', open);
    if (open) {
      closeMenu();
      setUnread(0);
      $('chat-ticker').innerHTML = '';
      setTimeout(() => $('chat-log').scrollTo(0, $('chat-log').scrollHeight), 0);
      if (focus) $('chat-input').focus();
    } else if (document.activeElement === $('chat-input')) {
      $('chat-input').blur();
    }
  }
  $('btn-chat').onclick = () => toggleChat(undefined, desktop.matches);
  $('chat-close').onclick = () => toggleChat(false);
  $('chat-backdrop').onclick = () => toggleChat(false);
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('kart-playing')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Enter' && !typing && !document.body.classList.contains('chat-open')) { e.preventDefault(); toggleChat(true, true); }
    else if (e.key === 'Escape' && document.body.classList.contains('chat-open')) toggleChat(false);
  });
  function tickerAdd(m) {
    const box = $('chat-ticker');
    const div = document.createElement('div');
    div.innerHTML = m.system ? `<span>${escapeHtml(m.text)}</span>`
      : `${avatarHtml(m.avatar ?? 0)}<span><b style="color:${m.color}">${escapeHtml(m.from)}</b> ${escapeHtml(m.text)}</span>`;
    box.appendChild(div);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { div.classList.add('out'); setTimeout(() => div.remove(), 400); }, 6000);
  }
  function closeMenu() { $('game-menu').classList.add('hidden'); }
  const SOUND_ICONS = {
    on: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    off: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
  };
  function openMenu(anchor) {
    const menu = $('game-menu');
    if (!menu.classList.contains('hidden')) { closeMenu(); return; }
    const r = anchor.getBoundingClientRect();
    // Says what tapping it will do, with an icon for the current state.
    menu.querySelector('[data-act="sound"]').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${SOUND_ICONS[window.Sfx.muted ? 'off' : 'on']}</svg><span>${window.Sfx.muted ? 'Unmute sound' : 'Mute sound'}</span>`;
    menu.querySelector('[data-act="stop"]').classList.toggle('hidden', !(isHost() && state.room?.state === 'playing'));
    menu.classList.remove('hidden');
    // Drops down from a button at the top, opens upwards from one at the bottom (short desktop
    // windows put the stage buttons bottom-left), and lines up with the button's nearer edge.
    const h = menu.offsetHeight;
    menu.style.top = `${r.bottom + 6 + h <= window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
    const left = r.left + r.width / 2 < window.innerWidth / 2;
    menu.style.left = left ? `${Math.max(8, r.left)}px` : 'auto';
    menu.style.right = left ? 'auto' : `${Math.max(8, window.innerWidth - r.right)}px`;
  }
  $('game-menu').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'chat') toggleChat(true);
    else if (act === 'sound') muteBtn.click();
    else if (act === 'stop') $('btn-stop').click();
    else if (act === 'leave') $('btn-leave').click();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#game-menu, [data-menu]')) closeMenu();
  });

  // ---------- Chat ----------
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    // Desktop kart: Enter sends and hands the keyboard back to the game (Enter on empty just closes).
    const backToGame = document.body.classList.contains('kart-playing') && desktop.matches;
    if (text) {
      socket.emit('chat', { text });
      $('chat-input').value = '';
    }
    if (backToGame) toggleChat(false);
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
    if (document.body.classList.contains('kart-playing') && !document.body.classList.contains('chat-open')) {
      if (!m.system) setUnread(unread + 1);
      if (desktop.matches) tickerAdd({ ...m, color: m.system ? null : div.querySelector('b')?.style.color });
    }
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
