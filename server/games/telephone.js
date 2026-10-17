// Telephone (Gartic Phone style). Books pass round the group one step at a time, then
// everyone watches the albums. Modes:
//   normal     write a prompt -> draw it -> describe the drawing -> draw that -> ...
//   speedrun   the same with very short timers
//   secret     the same, but you draw blind (your ink only appears in the album)
//   knockoff   draw anything; then each player sees the last drawing for a few seconds and redraws it from memory
//   complement draw anything; each player then adds to the previous drawing
const BASE_TIME = { write: 45, draw: 90, describe: 45 };
const PACE = { slow: 1.5, normal: 1, fast: 0.65 };
const SPEEDRUN = 0.4;
const MEMORIZE_S = 6;
const GRACE_MS = 3000; // allow late auto-submits after the client timer hits zero
const AWAY_WAIT_MS = 15000; // how long a step waits for players who dropped out to come back
const AUTO_REVEAL_MS = 3500;
const MAX_IMAGE_BYTES = 1_500_000;
const REACTIONS = ['❤️', '😂', '😮', '🔥', '👏'];
const MODES = ['normal', 'speedrun', 'secret', 'knockoff', 'complement'];

const STARTER_PROMPTS = [
  'A cat running a pizza shop', 'Grandma on a skateboard', 'A dragon at the dentist',
  'Robots having a picnic', 'A snowman on vacation', 'An astronaut walking a dog',
  'A shark playing guitar', 'Aliens stealing a cow', 'A wizard stuck in traffic',
  'A penguin DJ', 'A haunted bouncy castle', 'Two snails racing', 'A volcano making pancakes',
];

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Telephone {
  static minPlayers = 2;

  constructor(room) {
    const s = room.settings;
    this.room = room;
    this.mode = MODES.includes(s.telMode) ? s.telMode : 'normal';
    this.pace = (PACE[s.telPace] || 1) * (this.mode === 'speedrun' ? SPEEDRUN : 1);
    this.autoReveal = s.telReveal === 'auto';
    this.step = -1;
    this.steps = 0;
    this.groups = []; // arrays of player ids; books circulate within a group
    this.books = []; // { owner, group, entries: [{ type, by, content }], reactions: {} }
    this.timer = null;
    this.awayTimer = null; // a step waiting for players who dropped out
    this.deadline = 0;
    this.stepStart = 0;
    this.phase = 'idle';
    this.reveal = { book: 0, entry: -1 };
    this.people = new Map(); // everyone who started: albums keep their names after they leave
    this.suggestions = new Map(); // the prompt idea each writer was shown (used if they write nothing)
    this.reacted = new Set(); // one of each emoji per player per page
  }

  start() {
    const players = shuffle(this.room.connectedPlayers);
    const s = this.room.settings;
    let groups = [players];
    if (s.teamMode) {
      // In team mode each team passes its books around inside the team.
      const byTeam = new Map();
      for (const p of players) {
        if (!byTeam.has(p.team)) byTeam.set(p.team, []);
        byTeam.get(p.team).push(p);
      }
      const teamGroups = [...byTeam.values()];
      if (teamGroups.every((g) => g.length >= 2)) groups = teamGroups;
    }
    this.groups = groups.map((g) => g.map((p) => p.id));
    for (const p of players) this.people.set(p.id, { name: p.name, avatar: p.avatar, color: p.color, team: p.team });
    const minGroup = Math.min(...this.groups.map((g) => g.length));
    this.steps = s.telephoneSteps > 0 ? Math.min(s.telephoneSteps, minGroup) : minGroup;
    this.books = [];
    this.groups.forEach((g, gi) => g.forEach((id) => this.books.push({ owner: id, group: gi, entries: [], reactions: {} })));
    this.nextStep();
  }

  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.awayTimer);
    this.awayTimer = null;
  }

  // Name, avatar and colour: from the room while they're in it, else as they were at the start.
  person(id) {
    const p = this.room.players.get(id) || this.people.get(id);
    return { name: p?.name || 'Someone', avatar: p?.avatar ?? 0, color: p?.color || '#888', team: p?.team ?? null };
  }

  drawOnly() {
    return this.mode === 'knockoff' || this.mode === 'complement';
  }

  stepType(step) {
    if (this.drawOnly()) return 'draw';
    if (step === 0) return 'write';
    return step % 2 === 1 ? 'draw' : 'describe';
  }

  stepTime(step) {
    const base = BASE_TIME[this.stepType(step)];
    const memorize = this.mode === 'knockoff' && step > 0 ? MEMORIZE_S : 0;
    return Math.max(12, Math.round(base * this.pace)) + memorize;
  }

  // Which book does `playerId` work on at the current step?
  bookFor(playerId) {
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      const i = g.indexOf(playerId);
      if (i < 0) continue;
      const ownerIdx = (i - this.step + g.length * 100) % g.length;
      return this.books.find((b) => b.owner === g[ownerIdx] && b.group === gi);
    }
    return null;
  }

  participants() {
    return this.groups.flat();
  }

  nextStep() {
    this.step++;
    if (this.step >= this.steps) {
      this.startReveal();
      return;
    }
    this.phase = 'play';
    this.submitted = new Set();
    const time = this.stepTime(this.step);
    clearTimeout(this.timer);
    clearTimeout(this.awayTimer);
    this.awayTimer = null;
    this.stepStart = Date.now();
    this.deadline = Date.now() + time * 1000;
    if (this.stepType(this.step) === 'write') {
      const ideas = shuffle(STARTER_PROMPTS);
      this.participants().forEach((id, i) => this.suggestions.set(id, ideas[i % ideas.length]));
    }
    this.timer = setTimeout(() => this.forceAdvance(), time * 1000 + GRACE_MS);
    for (const id of this.participants()) this.sendTask(id);
    this.broadcastProgress();
  }

  taskFor(playerId) {
    const book = this.bookFor(playerId);
    if (!book) return null;
    const prev = book.entries[this.step - 1] || null;
    // Knock-off: the drawing shows for the first seconds of the step only, reloads included.
    const memorize = this.mode === 'knockoff' && prev ? Math.max(0, MEMORIZE_S - (Date.now() - this.stepStart) / 1000) : 0;
    const hide = this.mode === 'knockoff' && prev && memorize <= 0;
    return {
      step: this.step,
      steps: this.steps,
      mode: this.mode,
      type: this.stepType(this.step),
      timeLeft: Math.max(0, (this.deadline - Date.now()) / 1000),
      total: this.stepTime(this.step),
      prev: prev ? { type: prev.type, content: hide ? null : prev.content, hidden: hide || undefined } : null,
      memorize,
      blind: this.mode === 'secret',
      submitted: this.submitted.has(playerId),
      suggestion: this.suggestions.get(playerId) || STARTER_PROMPTS[0],
    };
  }

  sendTask(playerId) {
    const task = this.taskFor(playerId);
    if (task) this.room.emitTo(playerId, 'game:tel:task', task);
  }

  broadcastProgress() {
    const parts = this.participants();
    this.room.emit('game:tel:progress', {
      done: parts.filter((id) => this.submitted.has(id)).length,
      total: parts.length,
      ids: parts, // who plays this round (late joiners only watch)
      doneIds: parts.filter((id) => this.submitted.has(id)),
    });
  }

  submit(playerId, content) {
    if (this.phase !== 'play' || this.submitted.has(playerId)) return false;
    const book = this.bookFor(playerId);
    if (!book) return false;
    const type = this.stepType(this.step);
    book.entries[this.step] = { type, by: playerId, content };
    this.submitted.add(playerId);
    this.broadcastProgress();
    return true;
  }

  // Move on once everyone still playing has handed in. Someone who dropped out (a phone locked, a
  // page reloading) gets a little while to come back before the step goes on without them; someone
  // who left the room isn't waited for at all.
  checkAllSubmitted() {
    if (this.phase !== 'play') return;
    const pending = this.participants().filter((id) => !this.submitted.has(id));
    const here = pending.filter((id) => this.room.players.get(id)?.connected);
    const away = pending.filter((id) => this.room.players.has(id) && !this.room.players.get(id).connected);
    if (here.length) {
      clearTimeout(this.awayTimer);
      this.awayTimer = null;
      return;
    }
    if (!away.length) { this.forceAdvance(); return; }
    if (!this.awayTimer) {
      const wait = Math.min(AWAY_WAIT_MS, Math.max(0, this.deadline + GRACE_MS - Date.now()));
      this.awayTimer = setTimeout(() => { this.awayTimer = null; this.forceAdvance(); }, wait);
    }
  }

  // The entry for a step nobody handed in: the prompt idea they were shown, nothing to describe, or
  // (complement) the drawing as it was.
  placeholder(id, book) {
    const type = this.stepType(this.step);
    if (type === 'write') return this.suggestions.get(id) || STARTER_PROMPTS[0];
    if (type === 'describe') return null;
    return this.mode === 'complement' ? book.entries[this.step - 1]?.content || null : null;
  }

  forceAdvance() {
    if (this.phase !== 'play') return;
    for (const id of this.participants()) {
      if (this.submitted.has(id)) continue;
      const book = this.bookFor(id);
      if (!book) continue;
      book.entries[this.step] = { type: this.stepType(this.step), by: id, content: this.placeholder(id, book) };
    }
    this.nextStep();
  }

  onEvent(player, event, data, reply) {
    if (event === 'submit') {
      // Every hand-in names its step: a late one (a slow upload, a phone waking up) must not land
      // in the next step's book, nor stop the real answer being taken.
      if (this.phase !== 'play' || data?.step !== this.step) return reply({ ok: false, error: 'stale' });
      const type = this.stepType(this.step);
      let content;
      if (type === 'draw') {
        const img = data?.image;
        if (img === null || img === undefined) content = null; // nothing drawn
        else if (typeof img === 'string' && img.length < MAX_IMAGE_BYTES && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) content = img;
        else return reply({ ok: false, error: img && img.length >= MAX_IMAGE_BYTES ? 'too-big' : 'bad-image' });
        // Complement: handing in nothing keeps the drawing as it was.
        if (content === null && this.mode === 'complement') content = this.placeholder(player.id, this.bookFor(player.id) || { entries: [] });
      } else {
        const text = String(data?.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        content = text || (type === 'write' ? this.suggestions.get(player.id) || STARTER_PROMPTS[0] : null);
      }
      const ok = this.submit(player.id, content);
      // Acknowledge before advancing so the client doesn't get the next task first.
      reply({ ok });
      if (ok) this.checkAllSubmitted();
      return;
    }
    if (event === 'react' && this.phase === 'reveal') {
      const emoji = REACTIONS.includes(data?.emoji) ? data.emoji : null;
      const key = `${this.reveal.book}:${this.reveal.entry}:${player.id}:${emoji}`;
      if (!emoji || this.reacted.has(key)) return reply({ ok: false });
      this.reacted.add(key);
      const book = this.books[this.reveal.book];
      book.reactions[emoji] = (book.reactions[emoji] || 0) + 1;
      this.room.emit('game:tel:react', { emoji, from: player.name, avatar: player.avatar, entry: this.reveal.entry });
      return reply({ ok: true });
    }
    if ((event === 'next' || event === 'finish') && this.phase === 'reveal') {
      if (!this.room.isHost(player)) return reply({ ok: false });
      // Says which page it turns from: a double click (or two hosts in a row) turns only one.
      if (data && (data.book !== this.reveal.book || data.entry !== this.reveal.entry)) return reply({ ok: false, error: 'stale' });
      if (event === 'next') this.advanceReveal();
      else this.finish();
      return reply({ ok: true });
    }
    return reply({ ok: false });
  }

  startReveal() {
    clearTimeout(this.timer);
    this.phase = 'reveal';
    this.reveal = { book: 0, entry: 0 };
    this.sendReveal();
  }

  advanceReveal() {
    clearTimeout(this.timer);
    if (this.reveal.entry < this.steps - 1) {
      this.reveal.entry++;
    } else if (this.reveal.book < this.books.length - 1) {
      this.reveal.book++;
      this.reveal.entry = 0;
    } else {
      this.finish();
      return;
    }
    this.sendReveal();
  }

  // The album page on show. `full`: every entry so far (a fresh album, a reload, a late joiner);
  // otherwise only the newest, which the screens add to the album they already show.
  revealPayload(full = true) {
    const book = this.books[this.reveal.book];
    const owner = this.person(book.owner);
    const entry = (e) => {
      const by = this.person(e.by);
      return { type: e.type, by: by.name, avatar: by.avatar, color: by.color, content: e.content };
    };
    const shown = book.entries.slice(0, this.reveal.entry + 1).map(entry);
    return {
      bookIndex: this.reveal.book,
      bookCount: this.books.length,
      entryIndex: this.reveal.entry,
      steps: this.steps,
      mode: this.mode,
      auto: this.autoReveal,
      owner: owner.name,
      ownerAvatar: owner.avatar,
      team: this.groups.length > 1 ? owner.team : null,
      entries: full || this.reveal.entry === 0 ? shown : undefined,
      entry: shown[shown.length - 1],
      reactions: book.reactions,
      last: this.reveal.book === this.books.length - 1 && this.reveal.entry === this.steps - 1,
    };
  }

  sendReveal() {
    this.room.emit('game:tel:reveal', this.revealPayload(false));
    if (this.autoReveal) {
      // Linger a little longer at the end of each album.
      const endOfBook = this.reveal.entry === this.steps - 1;
      this.timer = setTimeout(() => this.advanceReveal(), AUTO_REVEAL_MS * (endOfBook ? 2 : 1));
    }
  }

  snapshotFor(player) {
    if (this.phase === 'reveal') return { mode: 'telephone', reveal: this.revealPayload(true) };
    const task = this.participants().includes(player.id) ? this.taskFor(player.id) : null;
    return { mode: 'telephone', task, spectating: !task };
  }

  onPlayerJoin(player) {
    this.room.emitTo(player.id, 'game:snapshot', this.snapshotFor(player));
  }

  onPlayerDisconnect() {
    if (this.phase === 'play') { this.broadcastProgress(); this.checkAllSubmitted(); }
  }

  onPlayerReconnect() {
    // Back in time: the step waits for them again (the room sends them their task).
    if (this.phase === 'play') { this.checkAllSubmitted(); this.broadcastProgress(); }
  }

  onPlayerLeave() {
    this.onPlayerDisconnect();
  }

  finish() {
    this.stop();
    this.phase = 'done';
    // Telephone is cooperative: no scores. Results list the albums with the most reactions.
    const results = this.room.buildResults(new Map());
    results.albums = this.books.length;
    results.favorites = this.books
      .map((b) => ({ owner: this.person(b.owner).name, avatar: this.person(b.owner).avatar, reactions: Object.values(b.reactions).reduce((a, n) => a + n, 0) }))
      .filter((b) => b.reactions > 0)
      .sort((a, b) => b.reactions - a.reactions)
      .slice(0, 3);
    this.room.finishGame(this, results);
  }
}

module.exports = { Telephone, MODES };
