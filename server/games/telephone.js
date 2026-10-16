// Telephone (Gartic Phone style): write a prompt -> next player draws it ->
// next player describes the drawing -> ... then everyone watches the albums.
const WRITE_TIME = 45;
const DRAW_TIME = 90;
const DESCRIBE_TIME = 45;
const GRACE_MS = 3000; // allow late auto-submits after the client timer hits zero
const MAX_IMAGE_BYTES = 1_500_000;

const STARTER_PROMPTS = [
  'A cat running a pizza shop', 'Grandma on a skateboard', 'A dragon at the dentist',
  'Robots having a picnic', 'A snowman on vacation', 'An astronaut walking a dog',
  'A shark playing guitar', 'Aliens stealing a cow', 'A wizard stuck in traffic',
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
    this.room = room;
    this.step = -1;
    this.steps = 0;
    this.groups = []; // arrays of player ids; books circulate within a group
    this.books = []; // { owner, group, entries: [{ type, by, content }] }
    this.timer = null;
    this.deadline = 0;
    this.phase = 'idle';
    this.reveal = { book: 0, entry: -1 };
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
    const minGroup = Math.min(...this.groups.map((g) => g.length));
    this.steps = s.telephoneSteps > 0 ? Math.min(s.telephoneSteps, minGroup) : minGroup;
    this.books = [];
    this.groups.forEach((g, gi) => g.forEach((id) => this.books.push({ owner: id, group: gi, entries: [] })));
    this.nextStep();
  }

  stop() {
    clearTimeout(this.timer);
  }

  stepType(step) {
    if (step === 0) return 'write';
    return step % 2 === 1 ? 'draw' : 'describe';
  }

  stepTime(step) {
    const type = this.stepType(step);
    if (type === 'write') return WRITE_TIME;
    if (type === 'draw') return Math.max(DRAW_TIME, this.room.settings.drawTime);
    return DESCRIBE_TIME;
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
    this.deadline = Date.now() + time * 1000;
    this.timer = setTimeout(() => this.forceAdvance(), time * 1000 + GRACE_MS);
    for (const id of this.participants()) this.sendTask(id);
    this.broadcastProgress();
  }

  taskFor(playerId) {
    const book = this.bookFor(playerId);
    if (!book) return null;
    const prev = book.entries[this.step - 1] || null;
    return {
      step: this.step,
      steps: this.steps,
      type: this.stepType(this.step),
      timeLeft: Math.max(0, (this.deadline - Date.now()) / 1000),
      prev: prev ? { type: prev.type, content: prev.content } : null,
      submitted: this.submitted.has(playerId),
      suggestion: STARTER_PROMPTS[Math.floor(Math.random() * STARTER_PROMPTS.length)],
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
      waitingOn: parts.filter((id) => !this.submitted.has(id) && this.room.players.get(id)?.connected).length,
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

  checkAllSubmitted() {
    const pending = this.participants().filter((id) => !this.submitted.has(id));
    // Don't wait on disconnected players; their entries get placeholders.
    if (pending.every((id) => !this.room.players.get(id)?.connected)) this.forceAdvance();
  }

  forceAdvance() {
    if (this.phase !== 'play') return;
    for (const id of this.participants()) {
      if (this.submitted.has(id)) continue;
      const book = this.bookFor(id);
      const type = this.stepType(this.step);
      if (book) book.entries[this.step] = { type, by: id, content: type === 'draw' ? null : '(no answer)' };
    }
    this.nextStep();
  }

  onEvent(player, event, data, reply) {
    if (event === 'submit') {
      const type = this.stepType(this.step);
      let content;
      if (type === 'draw') {
        const img = data?.image;
        const valid = typeof img === 'string' && img.length < MAX_IMAGE_BYTES
          && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img);
        content = valid ? img : null;
      } else {
        content = String(data?.text || '').trim().slice(0, 140) || '(no answer)';
      }
      const ok = this.submit(player.id, content);
      // Acknowledge before advancing so the client doesn't get the next task first.
      reply({ ok });
      if (ok) this.checkAllSubmitted();
      return;
    }
    if (event === 'next' && this.phase === 'reveal') {
      if (!this.room.isHost(player)) return reply({ ok: false });
      this.advanceReveal();
      return reply({ ok: true });
    }
    if (event === 'finish' && this.phase === 'reveal') {
      if (!this.room.isHost(player)) return reply({ ok: false });
      this.finish();
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
    const book = this.books[this.reveal.book];
    if (book && this.reveal.entry < this.steps - 1) {
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

  revealPayload() {
    const book = this.books[this.reveal.book];
    const nameOf = (id) => this.room.players.get(id)?.name || 'Someone';
    const colorOf = (id) => this.room.players.get(id)?.color || '#888';
    return {
      bookIndex: this.reveal.book,
      bookCount: this.books.length,
      owner: nameOf(book.owner),
      team: this.groups.length > 1 ? this.room.players.get(book.owner)?.team ?? null : null,
      entries: book.entries.slice(0, this.reveal.entry + 1).map((e) => ({
        type: e.type, by: nameOf(e.by), color: colorOf(e.by), content: e.content,
      })),
      last: this.reveal.book === this.books.length - 1 && this.reveal.entry === this.steps - 1,
    };
  }

  sendReveal() {
    this.room.emit('game:tel:reveal', this.revealPayload());
  }

  snapshotFor(player) {
    if (this.phase === 'reveal') return { mode: 'telephone', reveal: this.revealPayload() };
    const task = this.participants().includes(player.id) ? this.taskFor(player.id) : null;
    return { mode: 'telephone', task, spectating: !task };
  }

  onPlayerJoin(player) {
    this.room.emitTo(player.id, 'game:snapshot', this.snapshotFor(player));
  }

  onPlayerDisconnect() {
    if (this.phase === 'play') { this.broadcastProgress(); this.checkAllSubmitted(); }
  }

  onPlayerLeave() {
    this.onPlayerDisconnect();
  }

  finish() {
    this.stop();
    this.phase = 'done';
    // Telephone is cooperative: no scores, everyone gets a participation result.
    const scores = new Map();
    const results = this.room.buildResults(scores);
    results.albums = this.books.length;
    this.room.finishGame(this, results);
  }
}

module.exports = { Telephone };
