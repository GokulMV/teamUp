# Credits

TeamUp is built on open-source libraries and openly licensed assets. Thank you to their authors.

## Ball & Chain

| What | Used for | Licence | Source |
|------|----------|---------|--------|
| [three.js](https://threejs.org) r169 and its addons (EffectComposer, UnrealBloomPass, OutputPass, RoundedBoxGeometry, BufferGeometryUtils) | 3D course, stick figures, ropes, particles, bloom | MIT | npm `three`, served from `/vendor/three` |
| [nipplejs](https://github.com/yoannmoinet/nipplejs) 1.0.4 | Virtual thumb-stick on phones and tablets | MIT | npm `nipplejs`, served from `/vendor/nipplejs` |
| [canvas-confetti](https://github.com/catdad/canvas-confetti) 1.9.4 | Confetti burst when your team crosses the finish | ISC | npm `canvas-confetti`, served from `/vendor/confetti` |
| `impact.mp3` (from `audio/impact.ogg`) | Heavy thumps: hammers, landings, hard hits | CC0 1.0 | Kenney, [Starter Kit Racing](https://github.com/KenneyNL/Starter-Kit-Racing) |
| `coin.mp3` (from `sounds/coin.ogg`) | Checkpoint chime (layered with a synthesized fanfare) | CC0 1.0 | Kenney, [Starter Kit 3D Platformer](https://github.com/KenneyNL/Starter-Kit-3D-Platformer) |
| `jump.mp3` (from `sounds/jump.ogg`) | The "hup!" under each heave | CC0 1.0 | Kenney, [Starter Kit 3D Platformer](https://github.com/KenneyNL/Starter-Kit-3D-Platformer) |

The three Kenney sounds were converted from Ogg Vorbis to small mono MP3s (so every browser, Safari included, can decode them) and live in `public/audio/ballchain/`. Kenney's assets are public domain (CC0); credit is given gladly, not because it is required.

Everything else in Ball & Chain (course pieces, stick figures, textures, the other sound effects) is drawn or synthesized in code. The cloud sprites and particle texture reuse helpers from `public/js/games/kart3d/world.js`.
