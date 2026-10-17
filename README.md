# TeamUp 🎮

Browser party games for **up to 30 players** in one room, playable solo or in **teams** (2–5).
No installs for players: share a 4-letter room code or invite link and everyone joins from a phone or laptop.

| Mode | Inspired by | How it plays |
|------|-------------|--------------|
| 🎨 **Pictionary** | skribbl.io | One player draws, everyone guesses in chat. Rounds where everyone draws once (or a fixed number of turns), 15-240 s draw time, 1-5 word choices, 0-5 letter hints, **Normal / Hidden / Combination** word modes, custom word lists, fill bucket, 👍/👎 ratings. Team mode alternates teams and pools scores. |
| 📞 **Telephone** | Gartic Phone | Books pass round the group. Modes: **Normal** (write → draw → describe…), **Speedrun**, **Secret** (draw blind), **Knock-off** (memorise a drawing, redraw it), **Complement** (add to the last drawing). Pace and auto/host reveal options, emoji reactions, save albums as images. |
| 🏎️ **Kart Battle** | Mario Kart / Smash Karts | **3D** go-karts (Three.js) driven by 15 animal characters (bunny, bear, cat, fox, panda, frog, penguin, pig, mouse, dog, duck, raccoon, koala, lion, dino: whichever goes with your avatar, wearing its hat), with drifting + mini-turbos. **Race** on 6 big tracks with climbs, crests, bridges and jumps (Grand Prix, Desert Canyon, Snowy Peaks, Neon City, Coral Coast, Lava Peak; ~50 s laps, tricks off ramps, fall into the sea or lava and get fished back out) or fight in 4 **arenas** with health bars and respawns: Harbour Havoc, the default and the first in a new bright look (a container port at sunset: a stepped pyramid of colourful containers to fight over, forklifts working the alleys between the stacks, three finger piers over the water lined with bollards, double bascule bridges that lift in turn, jump pads from pier to pier and a gantry crane swinging a container low enough to hit you), The Cinder Bowl (a sculpted low-poly bowl: rolling hills ringed by snow-capped cliffs, a lava crater in the middle and a banked S-curve viaduct sweeping over it on pillars, under neon arches; tyre stacks to bounce off, pines, boulders and two jump pads up onto the crest), The Keep (a moated castle: drawbridges that rise in turn, wall walks, towers you reach by jump pad, a keep hall with a roof to fight on; knock someone into the moat and the kill is yours) and The Graveyard (rolling hills of headstones and acid graves round a two-storey crypt with a gallery, a scythe and a roof you can drop through). Plus a **weekly arena**: every Monday a new one is generated from the week's number (a walled courtyard, terraces round a sunken bowl, islands or open ground, dressed as a castle, desert ruins, a glacier, a volcano or a graveyard), checked so that every spawn and item box can be driven to and back, and announced in every lobby. Hop over hazards with a tap of drift; karts bump and trade momentum (hard hits are rams). 19 power-ups from a slot-machine item roulette, two held at once (Q swaps): boost, homing rocket, triple rockets, bouncer shell, banana, shield, mine, minigun, bomb (hold to aim the lob), shock wave, ghost, star power, ink splat, comet (hunts the leader), thunder, snowball (freezes; hit a frozen kart to shatter it), sticky bomb (bump someone to pass it on), spin spikes and decoy box. |
| ⛓️ **Ball & Chain** | Fall Guys | Teams of 2-6 stick figures, each tied to their team's giant beach ball by a stretchy rope, drag it through a candy-coloured **3D** obstacle course floating in the sky. **All hands:** the ball digs in unless *everyone* is pulling (holding a pressure plate or bracing counts), so one slacker leaves the team crawling at ~10% speed. **Heave** together for a sync bonus (and to launch the ball off ramps), **brace** to anchor it on slopes, belts and in gusts. 13 obstacle types (pillar slalom, airlock plates, twin keys, wobbly bridges, tilted slide, big slide, conveyors, wind tunnel, sweeper, hammers, bumpers, mud & ice, sync jump), side-by-side lanes, sabotage traps, 1/3/5 courses. |
| 🎛️ **Control Room** | Spaceteam | Crews of 2-6 each fly a ship. Every phone is a control panel of silly technobabble controls (buttons, switches, faders, dials, selectors, levers) and shows one order, usually for a crewmate's control, so you shout. Done orders fill the sector, missed ones dent the hull. Harder sectors bring asteroid fields (everyone mashes together), blackouts, panel shuffles, wormholes and ion storms. All crews fly at once; furthest sector wins. Cadet / Pilot / Ace, 5 / 10 / endless sectors, Voice or Relay comms (tap your order to flash it on your crew's screens). |

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
- **Ball & Chain:** WASD / arrows to run, Space to **heave**, hold Shift to **brace**. On phones: a thumb-stick on the left, HEAVE and BRACE buttons on the right. Teams of 2-6: with teams on, the room's teams play as they are (up to 5); with teams off, everyone is split into balanced teams automatically (2-3 players race as one team against the clock).
- **Pictionary / Telephone:** draw with mouse, finger or stylus. Pick colours, brush sizes, eraser, undo and clear.
- **Control Room:** tap buttons, switches and selectors; drag faders, dials and levers (mouse wheel and arrow keys work on desktop). Phones buzz on every press.

## How it works

```
public/                     browser client (plain HTML/CSS/JS, no build step)
  js/app.js                 home, lobby, teams, chat, results
  js/draw-board.js          shared drawing canvas (normalized coordinates)
  js/games/*.js             per-mode client UI
  js/games/kart3d.js        Three.js renderer: karts, particles, camera
  js/games/kart3d/items3d.js power-up models and effects (pooled/instanced), item boxes, kart auras
  js/games/kart3d/world.js  themes, textures, shared scenery (trees, grass, clouds...) and arenas
  js/games/kart3d/track.js  race tracks: terrain, road, bridges, rails, ramps, water, lava, landmarks
  js/games/kart3d/arena3d.js layered arenas: floors, ramps, walls, roofs that fade, movers, pads, scenery
  js/games/ballchain*.js    Ball & Chain: shared physics + course layouts (-core), client/HUD, 3D view
  js/games/ballchain3d/     course scenery (candy islands, obstacles, arches, sky) and the stick figures
  js/games/controlroom*.js  Control Room: game client, control widgets, starfield viewport, icons
  css/controlroom.css       Control Room's console styles
  js/avatars.js             the 24 SVG avatars
  js/sfx.js                 Web Audio sound effects and the generated kart engine
  js/item-icons.js          SVG power-up icons (HUD slot, roulette, lobby picker, kill feed)
  vendor/moonlit/           trees.js from GokulMV/moonlit-cove (grows the 3D trees)
  js/shared/kart-core.js    tracks (3D centerline, terrain, heightAt) + kart physics shared by server and client
  js/shared/kart-layers.js  layered arenas: floors over floors, ramps, pads, movers, rolling ground, CPU nav grid
  js/shared/kart-weekly.js  the weekly arena: ISO week seed, layout generator, reachability checks, names
server/
  index.js                  Express + Socket.IO
  rooms.js                  rooms (30 max), host controls, teams, reconnects
  games/pictionary.js       turns, word choice, hints, scoring
  games/kart.js             authoritative 30 Hz simulation: race laps or arena deathmatch, items
  games/kart-bots.js        CPU drivers: racing lines, item use, path-finding round layered arenas
  games/telephone.js        chained write/draw/describe steps + reveal
  games/ballchain.js        teams, courses, ropes/heave/brace physics at 30 Hz, checkpoints, sabotage, scoring
  games/controlroom.js      crews, panels, orders, hull/sectors, team events, relay comms
```

- **Server-authoritative**: the server owns all game state; clients send inputs and guesses. The Pictionary word is only ever sent to the drawer and players who've guessed it.
- **Ball & Chain networking**: 2D rope physics runs on the server at 30 Hz (shared with the browser in `ballchain-core.js`); snapshots go out at 15 Hz as compact arrays, rope wrap points only when they change. Your own player is predicted locally and reconciled (rope wraps always follow the server, so every screen agrees which posts a rope is bent round); everyone else and the balls are interpolated. Third-party libraries and assets are listed in [CREDITS.md](CREDITS.md).
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

- Capture the Flag in the battle arenas
- Kart customization (colors, hats, bodies)
- Custom word lists for Pictionary
- Sound effects and music
- Accounts / persistent leaderboards
