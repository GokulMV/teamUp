# TeamUp 🎮

Browser party games for **up to 30 players** in one room, playable solo or in **teams** (2–4).
No installs for players: share a 4-letter room code or invite link and everyone joins from a phone or laptop.

| Mode | Inspired by | How it plays |
|------|-------------|--------------|
| 🎨 **Pictionary** | skribbl.io | One player draws, everyone guesses in chat. Rounds where everyone draws once (or a fixed number of turns), 15-240 s draw time, 1-5 word choices, 0-5 letter hints, **Normal / Hidden / Combination** word modes, custom word lists, fill bucket, 👍/👎 ratings. Team mode alternates teams and pools scores. |
| 📞 **Telephone** | Gartic Phone | Books pass round the group. Modes: **Normal** (write → draw → describe…), **Speedrun**, **Secret** (draw blind), **Knock-off** (memorise a drawing, redraw it), **Complement** (add to the last drawing). Pace and auto/host reveal options, emoji reactions, save albums as images. |
| 🏎️ **Kart Battle** | Mario Kart / Smash Karts | **3D** karts (Three.js) with drifting + mini-turbos. **Race** on 6 big tracks with climbs, crests, bridges and jumps (Grand Prix, Desert Canyon, Snowy Peaks, Neon City, Coral Coast, Lava Peak; ~50 s laps, tricks off ramps, fall into the sea or lava and get fished back out) or fight in 2 **arenas** (Colosseum, Volcano Crater) with health bars and respawns. 10 power-ups: boost, homing rocket, triple rockets, banana, shield, mine, minigun, bomb, shock wave, ghost. |

Everyone picks one of 24 avatars, shown in the lobby, chat, player list and on the podium.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open the page, create a room, and share the invite link (`/?room=ABCD`). For friends outside your network, deploy it (see below) or use a tunnel such as `ngrok http 3000`.

```bash
npm test           # integration tests: 30-player rooms, all three modes, reconnects
npm run dev        # auto-restart on server changes
```

## Controls

- **Kart Battle:** Arrow keys / WASD to drive, Space (or E / Shift) to use an item. On phones, on-screen buttons appear automatically.
- **Pictionary / Telephone:** draw with mouse, finger or stylus. Pick colours, brush sizes, eraser, undo and clear.

## How it works

```
public/                     browser client (plain HTML/CSS/JS, no build step)
  js/app.js                 home, lobby, teams, chat, results
  js/draw-board.js          shared drawing canvas (normalized coordinates)
  js/games/*.js             per-mode client UI
  js/games/kart3d.js        Three.js renderer: karts, power-ups, particles, camera
  js/games/kart3d/world.js  themes, textures, shared scenery (trees, grass, clouds...) and arenas
  js/games/kart3d/track.js  race tracks: terrain, road, bridges, rails, ramps, water, lava, landmarks
  js/avatars.js             the 24 SVG avatars
  js/sfx.js                 Web Audio sound effects and the generated kart engine
  vendor/moonlit/           trees.js from GokulMV/moonlit-cove (grows the 3D trees)
  js/shared/kart-core.js    tracks (3D centerline, terrain, heightAt) + kart physics shared by server and client
server/
  index.js                  Express + Socket.IO
  rooms.js                  rooms (30 max), host controls, teams, reconnects
  games/pictionary.js       turns, word choice, hints, scoring
  games/kart.js             authoritative 30 Hz simulation: race laps or arena deathmatch, items
  games/telephone.js        chained write/draw/describe steps + reveal
```

- **Server-authoritative**: the server owns all game state; clients send inputs and guesses. The Pictionary word is only ever sent to the drawer and players who've guessed it.
- **Kart networking**: the server simulates at 30 Hz and broadcasts at 15 Hz in a compact array format (~30 karts fits easily). Other karts are interpolated ~110 ms behind; your own kart is predicted locally with the same physics code and smoothly corrected, so steering feels instant.
- **Reconnects**: refresh or drop and you're put back in your seat (30 s grace period) with the current game state.
- **Host**: the room creator picks the mode and settings, shuffles teams, kicks players and can end a game. If they leave, host passes to the next player.

## Deploying

### Railway (one click from GitHub)

The repo includes `railway.json` and a `Dockerfile`, so Railway needs no extra setup:

1. In Railway, **New Project → Deploy from GitHub repo** and pick this repository (and the branch you want).
2. Railway builds the `Dockerfile` and starts the server. It checks `/health` before switching traffic over.
3. Open the service's **Settings → Networking → Generate Domain** to get a public URL, then share `https://<your-domain>/?room=CODE` with friends.

Nothing else is needed: no database and no environment variables (Railway sets `PORT` itself).
Errors from players' browsers are logged by the server as `[client error] ...`, so they show up in Railway's **Deploy Logs**.
Game rooms live in memory, so keep the service at **1 replica** (already set in `railway.json`), and expect rooms to reset when you redeploy.

### Anywhere else

Any Node 18+ host or container platform that supports WebSockets works (Render, Fly.io, a VPS): `docker build -t teamup . && docker run -p 3000:3000 teamup`, or `npm ci --omit=dev && npm start`. Set `PORT` if needed.

## Ideas for next steps

- More kart tracks and arenas, plus a picker
- Kart customization (colors, hats, bodies)
- Custom word lists for Pictionary
- Sound effects and music
- Accounts / persistent leaderboards
