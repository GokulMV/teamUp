// The database: Postgres, when DATABASE_URL is set (Railway's Postgres service sets it). It keeps a
// record of play: browsers (profiles), rooms and who was in them, every game with its settings and
// results, how each player did, events during games, the weekly arenas and browser errors. See
// server/migrations for the tables.
//
// Writes never hold up a game: they go into a queue that is written in the background, in order,
// one statement at a time (so one bad row loses nothing else). With no database, or one that is
// down, nothing is recorded and the games carry on as if nothing happened.
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, 'migrations');
const MAX_QUEUE = 20000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Big strings (a drawing as a data URL) don't belong in the results kept.
function slim(value, depth = 0) {
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 60)}…(${value.length} chars)` : value;
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => slim(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) if (typeof v !== 'function' && v !== undefined) out[k] = slim(v, depth + 1);
  return out;
}

// What a browser says about itself, roughly (for the record: phones or desktops, which browsers).
function deviceOf(ua = '') {
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'desktop';
  const browser = /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /Firefox\//.test(ua) ? 'firefox'
    : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  return { device, browser };
}

class Database {
  constructor(url = process.env.DATABASE_URL) {
    this.url = url || null;
    this.pool = null;
    this.ready = false;
    this.queue = [];
    this.draining = null;
    this.dropped = 0;
    this.errors = 0;
    this.lastError = 0;
  }

  get enabled() { return !!this.url; }

  // Connect and bring the tables up to date. Resolves once ready (or with false: no database, or
  // it can't be reached; then it tries again in a while, and records nothing meanwhile).
  async start() {
    if (!this.url) return false;
    if (!this.pool) {
      const { Pool } = require('pg');
      this.pool = new Pool({ connectionString: this.url, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
      this.pool.on('error', (err) => this.log('pool', err));
    }
    try {
      await this.migrate();
      this.ready = true;
      console.log('[db] ready');
      this.kick();
      return true;
    } catch (err) {
      this.log('start', err);
      if (!this.retry) {
        this.retry = setTimeout(() => { this.retry = null; this.start(); }, 30_000);
        this.retry.unref?.();
      }
      return false;
    }
  }

  async migrate() {
    const client = await this.pool.connect();
    try {
      // One server at a time (a deploy can overlap the old one).
      await client.query('select pg_advisory_lock(7438291)');
      await client.query('create table if not exists schema_migrations (version int primary key, name text not null, applied_at timestamptz not null default now())');
      const done = new Set((await client.query('select version from schema_migrations')).rows.map((r) => r.version));
      const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
      for (const file of files) {
        const version = parseInt(file, 10);
        if (done.has(version)) continue;
        await client.query('begin');
        try {
          await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
          await client.query('insert into schema_migrations (version, name) values ($1, $2)', [version, file]);
          await client.query('commit');
          console.log(`[db] applied ${file}`);
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock(7438291)').catch(() => {});
      client.release();
    }
  }

  // Queue a statement (in the background, in order).
  write(sql, params = []) {
    if (!this.url) return;
    if (this.queue.length >= MAX_QUEUE) { this.queue.shift(); this.dropped++; }
    this.queue.push([sql, params]);
    this.kick();
  }

  kick() {
    if (!this.ready || this.draining || !this.queue.length) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length) this.kick();
    });
  }

  async drain() {
    let client;
    try {
      client = await this.pool.connect();
    } catch (err) {
      this.log('connect', err);
      await new Promise((r) => setTimeout(r, 5000));
      return;
    }
    try {
      while (this.queue.length) {
        const [sql, params] = this.queue.shift();
        try {
          await client.query(sql, params);
        } catch (err) {
          this.log('write', err, sql);
          if (err.code === 'ECONNRESET' || err.code === '57P01' || /terminat|Connection/i.test(err.message)) break;
        }
      }
    } finally {
      client.release();
    }
  }

  // Everything queued so far written (shutdown, tests). Gives up after `ms`.
  async flush(ms = 5000) {
    const until = Date.now() + ms;
    while ((this.queue.length || this.draining) && Date.now() < until) {
      this.kick();
      await (this.draining || new Promise((r) => setTimeout(r, 20)));
    }
  }

  async query(sql, params) {
    if (!this.ready) return null;
    return this.pool.query(sql, params);
  }

  async close() {
    clearTimeout(this.retry);
    await this.flush();
    await this.pool?.end().catch(() => {});
    this.pool = null;
    this.ready = false;
  }

  log(what, err, sql = '') {
    this.errors++;
    if (Date.now() - this.lastError < 10_000) return;
    this.lastError = Date.now();
    console.warn(`[db] ${what} failed: ${err.message}${sql ? ` (${sql.slice(0, 60)}…)` : ''}`);
  }

  // ---------- what gets recorded ----------
  profileSeen(id, name, avatar) {
    if (!UUID.test(id || '')) return;
    this.write(`insert into profiles (id, name, avatar) values ($1, $2, $3)
      on conflict (id) do update set last_seen = now(), name = excluded.name, avatar = excluded.avatar, visits = profiles.visits + 1`, [id, name, avatar]);
  }

  roomOpened(room, ownerProfile) {
    this.write('insert into rooms (id, code, owner_profile) values ($1, $2, $3)', [room.dbId, room.code, UUID.test(ownerProfile || '') ? ownerProfile : null]);
  }

  roomClosed(room) {
    this.write('update rooms set closed_at = now(), peak_players = $2, games = $3, chat_messages = $4 where id = $1',
      [room.dbId, room.peakPlayers, room.gamesStarted, room.chatMessages]);
  }

  playerJoined(room, player, socket) {
    const h = socket?.handshake?.headers || {};
    const { device, browser } = deviceOf(h['user-agent']);
    const country = typeof h['cf-ipcountry'] === 'string' ? h['cf-ipcountry'].slice(0, 2) : null;
    this.write(`insert into room_players (id, room_id, profile_id, name, avatar, color, device, browser, country)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do nothing`,
    [player.id, room.dbId, UUID.test(player.profile || '') ? player.profile : null, player.name, player.avatar, player.color, device, browser, country]);
  }

  playerReconnected(player) {
    this.write('update room_players set reconnects = reconnects + 1 where id = $1', [player.id]);
  }

  playerLeft(player) {
    this.write('update room_players set left_at = now(), chat_messages = $2 where id = $1', [player.id, player.chatCount || 0]);
  }

  gameStarted(room, rec, settings) {
    const s = settings;
    const kart = s.mode === 'kart';
    this.write(`insert into games (id, room_id, mode, variant, map_id, team_mode, settings, humans, bots)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [rec.id, room.dbId, s.mode, kart ? s.kartMode || 'race' : null, kart ? s.kartMap || null : null, !!s.teamMode,
      JSON.stringify(slim(s)), room.connectedPlayers.length, kart ? s.kartBots || 0 : 0]);
  }

  // How a game ended: outcome finished | stopped | abandoned | failed; results when it finished.
  gameEnded(room, rec, outcome, results) {
    const ms = Date.now() - rec.startedAt;
    this.write('update games set ended_at = now(), outcome = $2, duration_ms = $3, results = $4 where id = $1',
      [rec.id, outcome, ms, results ? JSON.stringify(slim(results)) : null]);
    if (!results || !Array.isArray(results.players)) return;
    results.players.forEach((p, i) => {
      const { id, name, team, score, bot, place, color, avatar, ...rest } = p;
      const profile = !bot ? rec.profiles.get(id) || null : null;
      const rank = Number.isFinite(place) ? place : i + 1;
      this.write(`insert into game_players (game_id, player_id, profile_id, name, team, is_bot, place, score, stats)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [rec.id, String(id), UUID.test(profile || '') ? profile : null, name, Number.isFinite(team) ? team : null, !!bot, rank,
        Number.isFinite(score) ? score : null, JSON.stringify(slim(rest))]);
      if (UUID.test(profile || '')) {
        this.write('update profiles set games_played = games_played + 1, wins = wins + $2 where id = $1', [profile, rank === 1 ? 1 : 0]);
      }
    });
  }

  gameEvent(rec, type, playerId, data) {
    this.write('insert into game_events (game_id, t_ms, type, player_id, data) values ($1, $2, $3, $4, $5)',
      [rec.id, Date.now() - rec.startedAt, type, playerId === null || playerId === undefined ? null : String(playerId), data ? JSON.stringify(slim(data)) : null]);
  }

  weeklyArena(map, ms, rejected) {
    this.write(`insert into weekly_arenas (week, map_id, name, theme, emoji, build_ms, rejected) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (week) do update set map_id = excluded.map_id, name = excluded.name, theme = excluded.theme, emoji = excluded.emoji`,
    [map.week || map.id, map.id, map.name, map.theme, map.emoji, ms, rejected]);
  }

  clientError(message, build) {
    this.write('insert into client_errors (build, message) values ($1, $2)', [build || null, String(message).slice(0, 4000)]);
  }
}

module.exports = { Database, deviceOf, slim, UUID };
