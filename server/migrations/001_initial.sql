-- TeamUp's record of play. Ids are made by the server (UUIDs), so nothing waits for the database.

-- A browser that has played here (kept in its localStorage; no account, no personal data).
create table profiles (
  id uuid primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  name text,                       -- the last name it played under
  avatar int,
  visits int not null default 1,   -- rooms created or joined
  games_played int not null default 0,
  wins int not null default 0,     -- games finished in first place
  xp bigint not null default 0,    -- (levels and coins: coming)
  coins bigint not null default 0
);

create table rooms (
  id uuid primary key,
  code text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  owner_profile uuid references profiles(id),
  peak_players int not null default 1,
  games int not null default 0,
  chat_messages int not null default 0
);
create index rooms_created on rooms (created_at);

-- Everyone who was in a room: when they came and went, on what.
create table room_players (
  id uuid primary key,             -- the player's id in the room
  room_id uuid not null references rooms(id) on delete cascade,
  profile_id uuid references profiles(id),
  name text not null,
  avatar int,
  color text,
  device text,                     -- phone | tablet | desktop
  browser text,
  country text,                    -- from Cloudflare (CF-IPCountry), when proxied
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  reconnects int not null default 0,
  chat_messages int not null default 0
);
create index room_players_room on room_players (room_id);
create index room_players_profile on room_players (profile_id);

-- Every game started: its settings, who played, how it ended and the full results.
create table games (
  id uuid primary key,
  room_id uuid references rooms(id) on delete set null,
  mode text not null,              -- pictionary | kart | telephone | ballchain | controlroom
  variant text,                    -- kart: race | arena
  map_id text,                     -- kart: the track or arena
  team_mode boolean not null default false,
  settings jsonb not null,
  humans int not null,
  bots int not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,                    -- finished | stopped | abandoned | failed
  duration_ms int,
  results jsonb
);
create index games_started on games (started_at);
create index games_mode_map on games (mode, map_id);

-- How each player (and CPU driver) did in a game.
create table game_players (
  game_id uuid not null references games(id) on delete cascade,
  player_id text not null,
  profile_id uuid references profiles(id),
  name text,
  team int,
  is_bot boolean not null default false,
  place int,
  score double precision,
  stats jsonb,                     -- per game: kart kills, deaths, hits, finish time...
  primary key (game_id, player_id)
);
create index game_players_profile on game_players (profile_id);

-- Things that happen during a game (kart kills and finishes, Pictionary rounds...).
create table game_events (
  id bigserial primary key,
  game_id uuid not null references games(id) on delete cascade,
  at timestamptz not null default now(),
  t_ms int,                        -- since the game started
  type text not null,
  player_id text,
  data jsonb
);
create index game_events_game on game_events (game_id);
create index game_events_type on game_events (type, at);

-- Each week's generated arena.
create table weekly_arenas (
  week text primary key,
  map_id text not null,
  name text,
  theme text,
  emoji text,
  made_at timestamptz not null default now(),
  build_ms int,
  rejected int not null default 0  -- layouts turned down by the play test first
);

-- Errors from players' browsers.
create table client_errors (
  id bigserial primary key,
  at timestamptz not null default now(),
  build text,
  message text not null
);
create index client_errors_at on client_errors (at);

-- Per browser, across every game.
create view profile_stats as
select p.id, p.name, p.first_seen, p.last_seen, p.visits, p.games_played, p.wins,
  count(gp.game_id) filter (where g.mode = 'kart') as kart_games,
  coalesce(sum((gp.stats->>'kills')::int) filter (where g.mode = 'kart'), 0) as kart_kills,
  coalesce(sum((gp.stats->>'deaths')::int) filter (where g.mode = 'kart'), 0) as kart_deaths,
  count(gp.game_id) filter (where g.mode = 'pictionary') as pictionary_games,
  count(gp.game_id) filter (where g.mode = 'telephone') as telephone_games,
  count(gp.game_id) filter (where g.mode = 'ballchain') as ballchain_games,
  count(gp.game_id) filter (where g.mode = 'controlroom') as controlroom_games
from profiles p
left join game_players gp on gp.profile_id = p.id
left join games g on g.id = gp.game_id
group by p.id;
