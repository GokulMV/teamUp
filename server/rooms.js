const crypto = require('crypto');
const KartCore = require('../public/js/shared/kart-core');
const { Pictionary } = require('./games/pictionary');
const { KartBattle } = require('./games/kart');
const { Telephone } = require('./games/telephone');

const MAX_PLAYERS = 30;
const AVATAR_COUNT = 24; // public/js/avatars.js
const RECONNECT_GRACE_MS = 30_000;

const TEAMS = [
  { id: 0, name: 'Red', color: '#ef4444' },
  { id: 1, name: 'Blue', color: '#3b82f6' },
  { id: 2, name: 'Green', color: '#22c55e' },
  { id: 3, name: 'Yellow', color: '#eab308' },
];

const PLAYER_COLORS = [
  '#f97316', '#06b6d4', '#a855f7', '#ec4899', '#84cc16', '#14b8a6', '#f43f5e', '#6366f1',
  '#facc15', '#10b981', '#0ea5e9', '#d946ef', '#fb7185', '#4ade80', '#38bdf8', '#c084fc',
];

const GAMES = {
  pictionary: Pictionary,
  kart: KartBattle,
  telephone: Telephone,
};

const DEFAULT_SETTINGS = {
  mode: 'pictionary',
  teamMode: false,
  teamCount: 2,
  // Pictionary (skribbl-style): rounds in which everyone draws once, or a fixed number of turns.
  pictEveryone: true,
  pictRounds: 2,
  pictionaryTurns: 8,
  drawTime: 80,
  wordChoices: 3,
  hints: 2,
  wordMode: 'normal', // normal | hidden | combo
  customWords: '',
  customOnly: false,
  kartLaps: 3,
  kartMode: 'race', // race | arena
  kartMap: 'grandprix', // a map id from kart-core MAPS matching kartMode
  arenaTime: 180, // seconds
  // Telephone (Gartic Phone-style)
  telephoneSteps: 8, // chain length (0 = everyone)
  telMode: 'normal', // normal | speedrun | knockoff | complement | secret
  telPace: 'normal', // slow | normal | fast
  telReveal: 'host', // host | auto
};

const WORD_MODES = ['normal', 'hidden', 'combo'];
const TEL_MODES = ['normal', 'speedrun', 'knockoff', 'complement', 'secret'];
const TEL_PACES = ['slow', 'normal', 'fast'];

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function cleanName(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 16);
  return s || 'Player';
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

class Room {
  constructor(manager, code) {
    this.manager = manager;
    this.io = manager.io;
    this.code = code;
    this.players = new Map(); // playerId -> player
    this.hostId = null;
    this.state = 'lobby'; // lobby | playing | results
    this.settings = { ...DEFAULT_SETTINGS };
    this.game = null;
    this.lastResults = null;
    this.colorIndex = 0;
  }

  get channel() {
    return `room:${this.code}`;
  }

  get connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  teamList() {
    return TEAMS.slice(0, this.settings.teamCount);
  }

  addPlayer(socket, name, avatar) {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    let finalName = cleanName(name);
    for (let i = 2; taken.has(finalName.toLowerCase()); i++) {
      finalName = `${cleanName(name).slice(0, 13)} ${i}`;
    }
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name: finalName,
      color: PLAYER_COLORS[this.colorIndex++ % PLAYER_COLORS.length],
      avatar: clampInt(avatar, 0, AVATAR_COUNT - 1, crypto.randomInt(AVATAR_COUNT)),
      team: this.smallestTeam(),
      socketId: socket.id,
      connected: true,
      leaveTimer: null,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.attach(socket, player);
    if (this.game) this.game.onPlayerJoin?.(player);
    return player;
  }

  attach(socket, player) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = this.code;
    socket.data.playerId = player.id;
    socket.join(this.channel);
  }

  smallestTeam() {
    const counts = this.teamList().map((t) => ({ id: t.id, n: 0 }));
    for (const p of this.players.values()) {
      const c = counts.find((x) => x.id === p.team);
      if (c) c.n++;
    }
    counts.sort((a, b) => a.n - b.n || a.id - b.id);
    return counts[0].id;
  }

  shuffleTeams() {
    const list = [...this.players.values()];
    for (let i = list.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    list.forEach((p, i) => { p.team = i % this.settings.teamCount; });
  }

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      maxPlayers: MAX_PLAYERS,
      kartMaps: KartCore.mapList(),
      teams: this.teamList(),
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, avatar: p.avatar, team: p.team, connected: p.connected,
      })),
      results: this.state === 'results' ? this.lastResults : null,
    };
  }

  broadcastState() {
    this.io.to(this.channel).emit('room:state', this.publicState());
  }

  emit(event, data) {
    this.io.to(this.channel).emit(event, data);
  }

  emitTo(playerId, event, data) {
    const p = this.players.get(playerId);
    if (p && p.connected) this.io.to(p.socketId).emit(event, data);
  }

  emitExcept(playerId, event, data) {
    const p = this.players.get(playerId);
    if (p && p.connected) this.io.to(this.channel).except(p.socketId).emit(event, data);
    else this.emit(event, data);
  }

  systemMessage(text) {
    this.emit('chat', { system: true, text });
  }

  isHost(player) {
    return player && player.id === this.hostId;
  }

  pickNewHost() {
    const next = this.connectedPlayers[0] || [...this.players.values()][0];
    this.hostId = next ? next.id : null;
  }

  handleDisconnect(player) {
    player.connected = false;
    this.game?.onPlayerDisconnect?.(player);
    if (this.hostId === player.id) this.pickNewHost();
    player.leaveTimer = setTimeout(() => this.removePlayer(player.id), RECONNECT_GRACE_MS);
    this.broadcastState();
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    clearTimeout(player.leaveTimer);
    this.players.delete(playerId);
    if (player.connected) {
      const sock = this.io.sockets.sockets.get(player.socketId);
      if (sock) {
        sock.leave(this.channel);
        sock.data.roomCode = null;
        sock.data.playerId = null;
      }
    }
    this.game?.onPlayerLeave?.(player);
    if (this.hostId === playerId) this.pickNewHost();
    if (this.players.size === 0) {
      this.destroy();
      return;
    }
    this.systemMessage(`${player.name} left`);
    this.broadcastState();
  }

  startGame() {
    const GameClass = GAMES[this.settings.mode];
    if (!GameClass) return { ok: false, error: 'Unknown game mode' };
    const min = GameClass.minPlayers || 1;
    if (this.connectedPlayers.length < min) {
      return { ok: false, error: `Need at least ${min} players for this mode` };
    }
    this.game?.stop();
    this.state = 'playing';
    this.lastResults = null;
    this.game = new GameClass(this);
    this.broadcastState();
    this.game.start();
    return { ok: true };
  }

  // Called by game instances when they are over.
  finishGame(game, results) {
    if (!this.game || this.game !== game) return;
    this.game.stop();
    this.game = null;
    this.state = 'results';
    this.lastResults = { mode: this.settings.mode, teamMode: this.settings.teamMode, ...results };
    this.broadcastState();
  }

  backToLobby() {
    this.game?.stop();
    this.game = null;
    this.state = 'lobby';
    this.broadcastState();
  }

  // Helper for games: rank players and teams from a score map.
  buildResults(scores) {
    const players = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, avatar: p.avatar, team: p.team, score: scores.get(p.id) || 0 }))
      .sort((a, b) => b.score - a.score);
    let teams = null;
    if (this.settings.teamMode) {
      teams = this.teamList()
        .map((t) => ({
          ...t,
          score: players.filter((p) => p.team === t.id).reduce((s, p) => s + p.score, 0),
          members: players.filter((p) => p.team === t.id).length,
        }))
        .sort((a, b) => b.score - a.score);
    }
    return { players, teams };
  }

  handle(player, event, data, ack) {
    const reply = typeof ack === 'function' ? ack : () => {};
    switch (event) {
      case 'chat': {
        const text = String(data?.text || '').trim().slice(0, 200);
        if (!text) return;
        if (this.game?.onChat?.(player, text)) return; // game consumed it (e.g. a correct guess)
        this.emit('chat', { from: player.name, color: player.color, avatar: player.avatar, team: player.team, text });
        return;
      }
      case 'lobby:profile': {
        // Name and avatar can be changed in the lobby.
        if (data?.avatar !== undefined) player.avatar = clampInt(data.avatar, 0, AVATAR_COUNT - 1, player.avatar);
        if (typeof data?.name === 'string' && data.name.trim()) {
          const name = cleanName(data.name);
          const taken = [...this.players.values()].some((p) => p !== player && p.name.toLowerCase() === name.toLowerCase());
          if (!taken) player.name = name;
        }
        this.broadcastState();
        return reply({ ok: true, name: player.name, avatar: player.avatar });
      }
      case 'lobby:team': {
        if (this.state === 'playing') return reply({ ok: false, error: 'Game in progress' });
        const team = clampInt(data?.team, 0, this.settings.teamCount - 1, player.team);
        player.team = team;
        this.broadcastState();
        return reply({ ok: true });
      }
      case 'lobby:settings': {
        if (!this.isHost(player)) return reply({ ok: false, error: 'Only the host can change settings' });
        if (this.state === 'playing') return reply({ ok: false, error: 'Game in progress' });
        const s = this.settings;
        if (data?.mode && GAMES[data.mode]) s.mode = data.mode;
        if (typeof data?.teamMode === 'boolean') s.teamMode = data.teamMode;
        if (data?.teamCount !== undefined) {
          s.teamCount = clampInt(data.teamCount, 2, TEAMS.length, s.teamCount);
          for (const p of this.players.values()) if (p.team >= s.teamCount) p.team = this.smallestTeam();
        }
        if (data?.pictionaryTurns !== undefined) s.pictionaryTurns = clampInt(data.pictionaryTurns, 1, 30, s.pictionaryTurns);
        if (data?.drawTime !== undefined) s.drawTime = clampInt(data.drawTime, 15, 240, s.drawTime);
        if (data?.kartMode === 'race' || data?.kartMode === 'arena') {
          s.kartMode = data.kartMode;
          if (KartCore.MAPS[s.kartMap]?.type !== s.kartMode) s.kartMap = KartCore.DEFAULT_MAP[s.kartMode];
        }
        if (typeof data?.kartMap === 'string' && KartCore.MAPS[data.kartMap]) {
          s.kartMap = data.kartMap;
          s.kartMode = KartCore.MAPS[data.kartMap].type;
        }
        if (data?.arenaTime !== undefined) s.arenaTime = clampInt(data.arenaTime, 60, 600, s.arenaTime);
        if (data?.kartLaps !== undefined) s.kartLaps = clampInt(data.kartLaps, 1, 10, s.kartLaps);
        if (data?.telephoneSteps !== undefined) s.telephoneSteps = clampInt(data.telephoneSteps, 0, 30, s.telephoneSteps);
        if (typeof data?.pictEveryone === 'boolean') s.pictEveryone = data.pictEveryone;
        if (data?.pictRounds !== undefined) s.pictRounds = clampInt(data.pictRounds, 1, 10, s.pictRounds);
        if (data?.wordChoices !== undefined) s.wordChoices = clampInt(data.wordChoices, 1, 5, s.wordChoices);
        if (data?.hints !== undefined) s.hints = clampInt(data.hints, 0, 5, s.hints);
        if (WORD_MODES.includes(data?.wordMode)) s.wordMode = data.wordMode;
        if (typeof data?.customWords === 'string') s.customWords = data.customWords.slice(0, 4000);
        if (typeof data?.customOnly === 'boolean') s.customOnly = data.customOnly;
        if (TEL_MODES.includes(data?.telMode)) s.telMode = data.telMode;
        if (TEL_PACES.includes(data?.telPace)) s.telPace = data.telPace;
        if (data?.telReveal === 'host' || data?.telReveal === 'auto') s.telReveal = data.telReveal;
        this.broadcastState();
        return reply({ ok: true });
      }
      case 'lobby:shuffle': {
        if (!this.isHost(player)) return reply({ ok: false, error: 'Only the host can shuffle teams' });
        if (this.state === 'playing') return reply({ ok: false, error: 'Game in progress' });
        this.shuffleTeams();
        this.broadcastState();
        return reply({ ok: true });
      }
      case 'lobby:kick': {
        if (!this.isHost(player)) return reply({ ok: false, error: 'Only the host can kick' });
        const target = this.players.get(data?.playerId);
        if (!target || target.id === player.id) return reply({ ok: false });
        if (target.connected) this.io.to(target.socketId).emit('room:kicked');
        this.removePlayer(target.id);
        return reply({ ok: true });
      }
      case 'game:start': {
        if (!this.isHost(player)) return reply({ ok: false, error: 'Only the host can start' });
        return reply(this.startGame());
      }
      case 'game:stop': {
        if (!this.isHost(player)) return reply({ ok: false, error: 'Only the host can stop the game' });
        this.backToLobby();
        return reply({ ok: true });
      }
      case 'room:leave': {
        this.removePlayer(player.id);
        return reply({ ok: true });
      }
      default:
        if (this.game && event.startsWith('game:')) {
          this.game.onEvent(player, event.slice(5), data, reply);
        }
    }
  }

  destroy() {
    this.game?.stop();
    this.game = null;
    for (const p of this.players.values()) clearTimeout(p.leaveTimer);
    this.manager.rooms.delete(this.code);
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  roomOf(socket) {
    const code = socket.data.roomCode;
    if (!code) return {};
    const room = this.rooms.get(code);
    const player = room?.players.get(socket.data.playerId);
    return { room, player };
  }

  sendWelcome(socket, room, player, ack) {
    ack({ ok: true, code: room.code, playerId: player.id, token: player.token });
    room.broadcastState();
    if (room.game) socket.emit('game:snapshot', room.game.snapshotFor(player));
  }

  create(socket, data, ack) {
    if (typeof ack !== 'function') return;
    this.leaveCurrent(socket);
    let code;
    do code = makeCode(); while (this.rooms.has(code));
    const room = new Room(this, code);
    this.rooms.set(code, room);
    const player = room.addPlayer(socket, data?.name, data?.avatar);
    this.sendWelcome(socket, room, player, ack);
  }

  join(socket, data, ack) {
    if (typeof ack !== 'function') return;
    const code = String(data?.code || '').toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Room not found' });

    // Reconnect with a previous session token.
    if (data?.token) {
      const existing = [...room.players.values()].find((p) => p.token === data.token);
      if (existing) {
        if (existing.connected && existing.socketId !== socket.id) {
          const old = this.io.sockets.sockets.get(existing.socketId);
          if (old) { old.data.roomCode = null; old.leave(room.channel); old.emit('room:kicked', { reason: 'Opened in another tab' }); }
        }
        this.leaveCurrent(socket);
        room.attach(socket, existing);
        room.game?.onPlayerReconnect?.(existing);
        return this.sendWelcome(socket, room, existing, ack);
      }
    }

    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: `Room is full (${MAX_PLAYERS} players max)` });
    this.leaveCurrent(socket);
    const player = room.addPlayer(socket, data?.name, data?.avatar);
    room.systemMessage(`${player.name} joined`);
    this.sendWelcome(socket, room, player, ack);
  }

  leaveCurrent(socket) {
    const { room, player } = this.roomOf(socket);
    if (room && player) room.removePlayer(player.id);
  }

  disconnect(socket) {
    const { room, player } = this.roomOf(socket);
    if (room && player && player.socketId === socket.id) room.handleDisconnect(player);
  }

  route(socket, event, data, ack) {
    const { room, player } = this.roomOf(socket);
    if (!room || !player) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Not in a room' });
      return;
    }
    try {
      room.handle(player, event, data, ack);
    } catch (err) {
      console.error(`Error handling ${event}:`, err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Server error' });
    }
  }
}

module.exports = { RoomManager, Room, MAX_PLAYERS, TEAMS };
