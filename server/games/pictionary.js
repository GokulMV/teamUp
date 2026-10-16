const { pickWords } = require('./words');

const CHOOSE_TIME = 15;
const REVEAL_TIME = 5;
const MAX_STROKES = 4000;

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

function sanitizeStroke(data) {
  if (!data || typeof data !== 'object') return null;
  const color = /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : '#000000';
  const size = Math.max(1, Math.min(60, Number(data.size) || 4));
  const pts = Array.isArray(data.pts) ? data.pts.slice(0, 400).map((n) => Math.max(0, Math.min(1, Number(n) || 0))) : [];
  if (pts.length < 2 || pts.length % 2) return null;
  const id = String(data.id || '').slice(0, 40);
  if (!id) return null;
  return { id, color, size, pts, erase: !!data.erase };
}

class Pictionary {
  static minPlayers = 2;

  constructor(room) {
    this.room = room;
    this.totalTurns = room.settings.pictionaryTurns;
    this.drawTime = room.settings.drawTime;
    this.turn = 0;
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

  pickDrawer() {
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

  nextTurn() {
    clearInterval(this.hintTimer);
    if (this.turn >= this.totalTurns || this.room.connectedPlayers.length < 2) {
      this.finish();
      return;
    }
    const drawer = this.pickDrawer();
    if (!drawer) { this.finish(); return; }
    this.turn++;
    this.drawerId = drawer.id;
    this.lastTeam = drawer.team;
    this.drawnCount.set(drawer.id, (this.drawnCount.get(drawer.id) || 0) + 1);
    this.phase = 'choosing';
    this.word = null;
    this.strokes = [];
    this.guessed = new Set();
    this.revealed = new Set();
    this.options = pickWords(3, this.usedWords);
    this.setTimer(CHOOSE_TIME, () => this.chooseWord(this.options[0]));
    this.broadcastPhase();
    this.room.emitTo(drawer.id, 'game:pict:options', { options: this.options });
  }

  chooseWord(word) {
    if (this.phase !== 'choosing' || !this.options.includes(word)) return;
    this.word = word;
    this.usedWords.add(word);
    this.phase = 'drawing';
    this.turnStart = Date.now();
    this.setTimer(this.drawTime, () => this.endTurn());
    // Reveal hint letters over time.
    const letters = [...word].map((c, i) => (c === ' ' ? -1 : i)).filter((i) => i >= 0);
    const hints = Math.min(3, Math.max(1, Math.floor(letters.length / 3)));
    let given = 0;
    this.hintTimer = setInterval(() => {
      if (given >= hints) return clearInterval(this.hintTimer);
      const hidden = letters.filter((i) => !this.revealed.has(i));
      if (hidden.length <= 1) return;
      this.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
      given++;
      this.broadcastPhase();
    }, (this.drawTime * 1000 * 0.75) / (hints + 1));
    this.broadcastPhase();
  }

  mask() {
    if (!this.word) return '';
    return [...this.word].map((c, i) => (c === ' ' ? ' ' : this.revealed.has(i) ? c : '_')).join('');
  }

  phasePayload(forPlayer) {
    const drawer = this.room.players.get(this.drawerId);
    const isDrawer = forPlayer && forPlayer.id === this.drawerId;
    const knows = isDrawer || (forPlayer && this.guessed.has(forPlayer.id)) || this.phase === 'reveal';
    return {
      phase: this.phase,
      turn: this.turn,
      totalTurns: this.totalTurns,
      drawerId: this.drawerId,
      drawerName: drawer ? drawer.name : '?',
      drawerTeam: drawer ? drawer.team : null,
      word: knows ? this.word : null,
      mask: this.mask(),
      wordLength: this.word ? this.word.length : 0,
      timeLeft: Math.max(0, (this.deadline - Date.now()) / 1000),
      guessed: [...this.guessed],
      scores: Object.fromEntries(this.scores),
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
        this.room.emitTo(id, 'chat', { from: player.name, color: player.color, team: player.team, text, secret: true });
      }
      return true;
    }

    if (guess === answer) {
      this.guessed.add(player.id);
      const elapsed = (Date.now() - this.turnStart) / 1000;
      const frac = Math.max(0, 1 - elapsed / this.drawTime);
      const orderBonus = Math.max(0, 50 - (this.guessed.size - 1) * 10);
      const pts = Math.round(50 + 250 * frac + orderBonus);
      this.scores.set(player.id, (this.scores.get(player.id) || 0) + pts);
      // Drawer earns points for each correct guess (diminishing so big rooms stay fair).
      const drawerPts = Math.max(10, 60 - this.guessed.size * 5);
      this.scores.set(this.drawerId, (this.scores.get(this.drawerId) || 0) + drawerPts);
      this.room.emit('chat', { system: true, good: true, text: `${player.name} guessed the word! (+${pts})` });
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

module.exports = { Pictionary };
