const { pickWords } = require('./words');

const CHOOSE_TIME = 15;
const REVEAL_TIME = 6;
const MAX_STROKES = 6000;
const LIKE_POINTS = 10;

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Drawing operations: a stroke segment, or a flood fill at a point.
function sanitizeStroke(data) {
  if (!data || typeof data !== 'object') return null;
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : '#000000';
  const id = String(data.id || '').slice(0, 40);
  if (!id) return null;
  if (data.fill) {
    const x = Math.max(0, Math.min(1, Number(data.x) || 0));
    const y = Math.max(0, Math.min(1, Number(data.y) || 0));
    return { id, fill: true, x, y, color };
  }
  const size = Math.max(1, Math.min(60, Number(data.size) || 4));
  const pts = Array.isArray(data.pts) ? data.pts.slice(0, 400).map((n) => Math.max(0, Math.min(1, Number(n) || 0))) : [];
  if (pts.length < 2 || pts.length % 2) return null;
  return { id, color, size, pts, erase: !!data.erase };
}

// Custom words from the lobby: comma or newline separated, 1-30 characters each.
function parseCustomWords(text) {
  return [...new Set(String(text || '').split(/[,\n]/).map((w) => w.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((w) => w.length >= 1 && w.length <= 30 && /[a-z0-9]/.test(w)))];
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Pictionary {
  static minPlayers = 2;

  constructor(room) {
    const s = room.settings;
    this.room = room;
    this.everyone = s.pictEveryone;
    this.rounds = s.pictRounds;
    this.drawTime = s.drawTime;
    this.choices = s.wordChoices;
    this.hintCount = s.hints;
    this.wordMode = s.wordMode;
    this.custom = parseCustomWords(s.customWords);
    this.customOnly = s.customOnly && this.custom.length >= this.choices;
    // With "everyone draws", the turn count is worked out per round as people join or leave.
    this.totalTurns = this.everyone ? this.rounds * room.connectedPlayers.length : s.pictionaryTurns;
    this.turn = 0;
    this.round = 0;
    this.queue = []; // drawers left in this round
    this.scores = new Map();
    this.usedWords = new Set();
    this.drawnCount = new Map(); // playerId -> times drawn, for fair rotation
    this.lastTeam = -1;
    this.phase = 'idle';
    this.drawerId = null;
    this.word = null;
    this.options = [];
    this.strokes = [];
    this.guessed = new Set();
    this.revealed = new Set();
    this.votes = new Map(); // playerId -> 1 (like) | -1 (dislike)
    this.timer = null;
    this.deadline = 0;
  }

  start() {
    this.nextTurn();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.hintTimer);
  }

  setTimer(seconds, fn) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setTimeout(fn, seconds * 1000);
  }

  // Next drawer in a team-interleaved order (A1, B1, A2, B2, ...).
  orderForRound() {
    const players = shuffle(this.room.connectedPlayers);
    if (!this.room.settings.teamMode) return players.map((p) => p.id);
    const byTeam = new Map();
    for (const p of players) {
      if (!byTeam.has(p.team)) byTeam.set(p.team, []);
      byTeam.get(p.team).push(p.id);
    }
    const lists = [...byTeam.values()];
    const out = [];
    for (let i = 0; lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i]) out.push(l[i]);
    return out;
  }

  pickDrawer() {
    if (this.everyone) {
      while (true) {
        if (!this.queue.length) {
          if (this.round >= this.rounds) return null;
          this.round++;
          this.queue = this.orderForRound();
          this.room.systemMessage(`Round ${this.round} of ${this.rounds}`);
        }
        const id = this.queue.shift();
        const p = this.room.players.get(id);
        if (p && p.connected) return p;
        if (!this.queue.length && this.round >= this.rounds) return null;
      }
    }
    const players = this.room.connectedPlayers;
    if (!players.length) return null;
    let candidates = players;
    if (this.room.settings.teamMode) {
      // Alternate teams so every team gets turns drawing.
      const teams = [...new Set(players.map((p) => p.team))].sort((a, b) => a - b);
      const nextTeam = teams.find((t) => t > this.lastTeam) ?? teams[0];
      candidates = players.filter((p) => p.team === nextTeam);
    }
    const min = Math.min(...candidates.map((p) => this.drawnCount.get(p.id) || 0));
    const pool = candidates.filter((p) => (this.drawnCount.get(p.id) || 0) === min);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  wordOptions() {
    const fromCustom = (n) => shuffle(this.custom.filter((w) => !this.usedWords.has(w))).slice(0, n);
    const pick = (n) => {
      if (this.customOnly) {
        const c = fromCustom(n);
        return c.length >= n ? c : [...c, ...pickWords(n - c.length, this.usedWords)];
      }
      if (this.custom.length) {
        // Mix custom words in with the built-in list.
        const c = fromCustom(Math.ceil(n / 2));
        return shuffle([...c, ...pickWords(n - c.length, new Set([...this.usedWords, ...c]))]);
      }
      return pickWords(n, this.usedWords);
    };
    if (this.wordMode === 'combo') {
      const a = pick(this.choices * 2);
      return Array.from({ length: this.choices }, (_, i) => `${a[i * 2]} ${a[i * 2 + 1] || a[0]}`);
    }
    return pick(this.choices);
  }

  nextTurn() {
    clearInterval(this.hintTimer);
    const enoughPlayers = this.room.connectedPlayers.length >= 2;
    const turnsLeft = this.everyone ? true : this.turn < this.totalTurns;
    const drawer = enoughPlayers && turnsLeft ? this.pickDrawer() : null;
    if (!drawer) { this.finish(); return; }
    this.turn++;
    if (this.everyone) this.totalTurns = Math.max(this.turn, this.turn + this.queue.length + (this.rounds - this.round) * this.room.connectedPlayers.length);
    this.drawerId = drawer.id;
    this.lastTeam = drawer.team;
    this.drawnCount.set(drawer.id, (this.drawnCount.get(drawer.id) || 0) + 1);
    this.phase = 'choosing';
    this.word = null;
    this.strokes = [];
    this.guessed = new Set();
    this.revealed = new Set();
    this.votes = new Map();
    this.options = this.wordOptions();
    this.setTimer(CHOOSE_TIME, () => this.chooseWord(this.options[0]));
    this.broadcastPhase();
    this.room.emitTo(drawer.id, 'game:pict:options', { options: this.options });
  }

  chooseWord(word) {
    if (this.phase !== 'choosing' || !this.options.includes(word)) return;
    this.word = word;
    this.usedWords.add(word);
    for (const w of word.split(' ')) this.usedWords.add(w);
    this.phase = 'drawing';
    this.turnStart = Date.now();
    this.setTimer(this.drawTime, () => this.endTurn());
    // Reveal hint letters over time (never in hidden mode, never the whole word).
    const letters = [...word].map((c, i) => (c === ' ' ? -1 : i)).filter((i) => i >= 0);
    const hints = this.wordMode === 'hidden' ? 0 : Math.min(this.hintCount, Math.max(0, letters.length - 2));
    let given = 0;
    if (hints > 0) {
      this.hintTimer = setInterval(() => {
        if (given >= hints) return clearInterval(this.hintTimer);
        const hidden = letters.filter((i) => !this.revealed.has(i));
        if (hidden.length <= 1) return;
        this.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
        given++;
        this.broadcastPhase();
      }, (this.drawTime * 1000 * 0.8) / (hints + 1));
    }
    this.broadcastPhase();
  }

  mask() {
    if (!this.word) return '';
    if (this.wordMode === 'hidden') return '? ? ?';
    return [...this.word].map((c, i) => (c === ' ' ? ' ' : this.revealed.has(i) ? c : '_')).join('');
  }

  phasePayload(forPlayer) {
    const drawer = this.room.players.get(this.drawerId);
    const isDrawer = forPlayer && forPlayer.id === this.drawerId;
    const knows = isDrawer || (forPlayer && this.guessed.has(forPlayer.id)) || this.phase === 'reveal';
    let likes = 0;
    let dislikes = 0;
    for (const v of this.votes.values()) (v > 0 ? likes++ : dislikes++);
    return {
      phase: this.phase,
      turn: this.turn,
      totalTurns: this.totalTurns,
      round: this.everyone ? this.round : null,
      rounds: this.everyone ? this.rounds : null,
      drawerId: this.drawerId,
      drawerName: drawer ? drawer.name : '?',
      drawerAvatar: drawer ? drawer.avatar : 0,
      drawerTeam: drawer ? drawer.team : null,
      word: knows ? this.word : null,
      mask: this.mask(),
      wordMode: this.wordMode,
      wordLength: this.word && this.wordMode !== 'hidden' ? this.word.length : 0,
      timeLeft: Math.max(0, (this.deadline - Date.now()) / 1000),
      drawTime: this.drawTime,
      guessed: [...this.guessed],
      scores: Object.fromEntries(this.scores),
      likes,
      dislikes,
      myVote: forPlayer ? this.votes.get(forPlayer.id) || 0 : 0,
    };
  }

  broadcastPhase() {
    // Payload differs per player (the word is only sent to those who know it).
    for (const p of this.room.connectedPlayers) {
      this.room.emitTo(p.id, 'game:pict:phase', this.phasePayload(p));
    }
  }

  snapshotFor(player) {
    const snap = { mode: 'pictionary', phase: this.phasePayload(player), strokes: this.strokes };
    if (this.phase === 'choosing' && player.id === this.drawerId) snap.options = this.options;
    return snap;
  }

  addScore(id, pts) {
    this.scores.set(id, (this.scores.get(id) || 0) + pts);
  }

  onEvent(player, event, data, reply) {
    const isDrawer = player.id === this.drawerId;
    switch (event) {
      case 'choose':
        if (isDrawer) this.chooseWord(data?.word);
        return reply({ ok: true });
      case 'stroke': {
        if (!isDrawer || this.phase !== 'drawing') return;
        const stroke = sanitizeStroke(data);
        if (!stroke || this.strokes.length >= MAX_STROKES) return;
        this.strokes.push(stroke);
        this.room.emitExcept(player.id, 'game:pict:stroke', stroke);
        return;
      }
      case 'undo': {
        if (!isDrawer || this.phase !== 'drawing') return;
        const last = this.strokes[this.strokes.length - 1];
        if (!last) return;
        this.strokes = this.strokes.filter((s) => s.id !== last.id);
        this.room.emit('game:pict:redraw', { strokes: this.strokes });
        return;
      }
      case 'clear':
        if (!isDrawer || this.phase !== 'drawing') return;
        this.strokes = [];
        this.room.emit('game:pict:redraw', { strokes: [] });
        return;
      case 'rate': {
        // 👍 / 👎 on the current drawing; likes give the drawer a few points.
        if (isDrawer || (this.phase !== 'drawing' && this.phase !== 'reveal')) return reply({ ok: false });
        const vote = data?.like ? 1 : -1;
        const before = this.votes.get(player.id) || 0;
        if (before === vote) return reply({ ok: true });
        if (before > 0) this.addScore(this.drawerId, -LIKE_POINTS);
        if (vote > 0) this.addScore(this.drawerId, LIKE_POINTS);
        this.votes.set(player.id, vote);
        this.broadcastPhase();
        if (vote > 0) this.room.emit('game:pict:like', { from: player.name, avatar: player.avatar });
        return reply({ ok: true });
      }
      default:
    }
  }

  // Returns true if the chat message was consumed.
  onChat(player, text) {
    if (this.phase !== 'drawing' || !this.word) return false;
    const isDrawer = player.id === this.drawerId;
    const knows = isDrawer || this.guessed.has(player.id);
    const guess = normalize(text);
    const answer = normalize(this.word);

    if (knows) {
      // People who know the word can only chat among themselves, and never say it.
      if (guess.includes(answer)) return true;
      const recipients = [this.drawerId, ...this.guessed];
      for (const id of recipients) {
        this.room.emitTo(id, 'chat', { from: player.name, color: player.color, avatar: player.avatar, team: player.team, text, secret: true });
      }
      return true;
    }

    if (guess === answer) {
      this.guessed.add(player.id);
      const elapsed = (Date.now() - this.turnStart) / 1000;
      const frac = Math.max(0, 1 - elapsed / this.drawTime);
      const orderBonus = Math.max(0, 50 - (this.guessed.size - 1) * 10);
      const pts = Math.round(50 + 250 * frac + orderBonus);
      this.addScore(player.id, pts);
      // Drawer earns points for each correct guess (diminishing so big rooms stay fair).
      this.addScore(this.drawerId, Math.max(10, 60 - this.guessed.size * 5));
      this.room.emit('chat', { system: true, good: true, text: `${player.name} guessed the word! (+${pts})` });
      this.room.emit('game:pict:guessed', { id: player.id, name: player.name, avatar: player.avatar, pts });
      this.broadcastPhase();
      const guessers = this.room.connectedPlayers.filter((p) => p.id !== this.drawerId);
      if (guessers.every((p) => this.guessed.has(p.id))) this.endTurn();
      return true;
    }

    if (answer.length > 3 && levenshtein(guess, answer) === 1) {
      this.room.emitTo(player.id, 'chat', { system: true, text: `"${text}" is very close!` });
    }
    return false;
  }

  endTurn() {
    if (this.phase !== 'drawing') return;
    clearInterval(this.hintTimer);
    this.phase = 'reveal';
    this.setTimer(REVEAL_TIME, () => this.nextTurn());
    this.room.systemMessage(`The word was "${this.word}"`);
    this.broadcastPhase();
  }

  onPlayerJoin(player) {
    this.room.emitTo(player.id, 'game:snapshot', this.snapshotFor(player));
  }

  onPlayerDisconnect(player) {
    this.handleGone(player);
  }

  onPlayerLeave(player) {
    this.handleGone(player);
  }

  handleGone(player) {
    if (player.id !== this.drawerId) {
      const guessers = this.room.connectedPlayers.filter((p) => p.id !== this.drawerId);
      if (this.phase === 'drawing' && guessers.length && guessers.every((p) => this.guessed.has(p.id))) this.endTurn();
      return;
    }
    if (this.phase === 'choosing') {
      this.room.systemMessage('The drawer left, skipping turn');
      this.nextTurn();
    } else if (this.phase === 'drawing') {
      this.room.systemMessage('The drawer left');
      this.endTurn();
    }
  }

  finish() {
    this.stop();
    this.phase = 'done';
    this.room.finishGame(this, this.room.buildResults(this.scores));
  }
}

module.exports = { Pictionary, parseCustomWords };
