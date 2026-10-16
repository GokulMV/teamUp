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

  // Settings shown in the lobby for each game, rendered by renderSettings().
  //   type: toggle | stepper | seg | slider | cards | maps | items | text
  //   block: full-width control under its label (otherwise a compact row: label left, control right)
  //   adv: shown under "More options"; show(s): only when it applies; def: value until the server sends one
  const ITEM_IDS = ['boost', 'rocket', 'triple', 'banana', 'shield', 'mine', 'minigun', 'bomb', 'shock', 'ghost'];
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
      { key: 'kartClass', type: 'seg', label: 'Speed', def: 'standard', options: [['chill', 'Chill'], ['standard', 'Standard'], ['turbo', 'Turbo']] },
      { key: 'kartItems', type: 'seg', label: 'Items', def: 'all', adv: true, block: true, options: [['all', 'All items'], ['weapons', 'Weapons only'], ['none', 'No items'], ['custom', 'Custom']] },
      { key: 'kartItemList', type: 'items', label: 'Pick items', def: ITEM_IDS, adv: true, block: true, show: (s) => (s.kartItems ?? 'all') === 'custom' },
      { key: 'kartBoxRespawn', type: 'seg', label: 'Item boxes', def: 'normal', adv: true, options: [['rare', 'Rare'], ['normal', 'Normal'], ['frequent', 'Lots']], show: (s) => (s.kartItems ?? 'all') !== 'none' },
      { key: 'kartCatchup', type: 'toggle', label: 'Catch-up items', hint: 'Racers at the back get stronger items', def: true, adv: true, show: (s) => s.kartMode === 'race' },
      { key: 'kartReverse', type: 'toggle', label: 'Reverse direction', hint: 'Drive the circuit backwards', def: false, adv: true, show: (s) => s.kartMode === 'race' },
      { key: 'arenaRespawn', type: 'seg', label: 'Respawn', def: 'normal', adv: true, options: [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']], show: (s) => s.kartMode === 'arena' },
      { key: 'arenaHealth', type: 'seg', label: 'Health', def: 'normal', adv: true, options: [['low', 'Glass'], ['normal', 'Normal'], ['high', 'Tank']], show: (s) => s.kartMode === 'arena' },
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
  $('team-count').innerHTML = [2, 3, 4].map((n) => `<button data-n="${n}">${n} teams</button>`).join('');

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
    return `<svg viewBox="0 0 100 100" class="map-outline" aria-hidden="true">
      <rect x="${r(40)}" y="${r(40)}" width="${r(map.size - 80)}" height="${r(map.size - 80)}" rx="2" class="mo-floor"/>
      ${map.hazards.map((h) => `<circle cx="${r(h.x)}" cy="${r(h.y)}" r="${r(h.r)}" class="mo-lava"/>`).join('')}
      ${map.obstacles.map((o) => `<circle cx="${r(o.x)}" cy="${r(o.y)}" r="${r(o.r)}" class="mo-block"/>`).join('')}</svg>`;
  }

  function mapStats(m) {
    const map = window.KartCore?.MAPS?.[m.id];
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
    return `<div class="map-overview" style="--art:url('/img/maps/${cur.id}.jpg')">
        <div class="mo-art">${mapOutline(cur)}</div>
        <div class="mo-info">
          <span class="mo-kicker">${cur.type === 'race' ? 'Race track' : 'Battle arena'}</span>
          <h4>${cur.emoji} ${escapeHtml(cur.name)}</h4>
          <p>${escapeHtml(cur.blurb || '')}</p>
          <div class="mo-chips">${mapStats(cur).map((t) => `<span>${t}</span>`).join('')}</div>
        </div>
      </div>
      <div class="map-thumbs">${maps.map((m) => `<button class="map-thumb ${m.id === cur.id ? 'on' : ''}" data-key="kartMap" data-value="${m.id}" ${host ? '' : 'disabled'} style="--art:url('/img/maps/${m.id}.jpg')" title="${escapeHtml(m.name)}">
        <span class="mt-name">${m.emoji} ${escapeHtml(m.name)}</span></button>`).join('')}</div>`;
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
    const sig = `${p.name}|${p.avatar}`;
    const nameInput = card.querySelector('input');
    if (sig === meSig || (nameInput && document.activeElement === nameInput)) return;
    meSig = sig;
    card.innerHTML = `
      <span title="Change avatar" data-avatar>${avatarHtml(p.avatar)}</span>
      <div class="me-info"><small>You</small><input maxlength="16" value="${escapeHtml(p.name)}" aria-label="Your name"></div>
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
