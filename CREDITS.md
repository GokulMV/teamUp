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

## Kart Battle

### Sounds

| File (`public/audio/kart/`) | Used for | Licence | Source |
|------|----------|---------|--------|
| `skid.wav` (from `audio/skid.ogg`, by [Landeplage](https://github.com/Landeplage)) | Tyre skid while drifting | CC0 1.0 | Kenney, [Starter Kit Racing](https://github.com/KenneyNL/Starter-Kit-Racing) |
| `impact.mp3` (from `audio/impact.ogg`) | Bumps, hits, landings | CC0 1.0 | Kenney, [Starter Kit Racing](https://github.com/KenneyNL/Starter-Kit-Racing) |
| `explode.mp3`, `hurt.mp3`, `blaster.mp3`, `repeater.mp3`, `swap.mp3`, `hop.mp3`, `land.mp3`, `whoosh.mp3` (from `enemy_destroy`, `enemy_hurt`, `blaster`, `blaster_repeater`, `weapon_change`, `jump_b`, `land`, `enemy_attack`) | Explosions, taking a hit, rockets, the minigun, swapping items, hops, landings, boosts and pads | CC0 1.0 | Kenney, [Starter Kit FPS](https://github.com/KenneyNL/Starter-Kit-FPS) |
| `coin.mp3`, `break.mp3`, `fall.mp3` | Item box and roulette, ice shattering, falling off | CC0 1.0 | Kenney, [Starter Kit 3D Platformer](https://github.com/KenneyNL/Starter-Kit-3D-Platformer) |
| `tick.mp3`, `drop.mp3`, `clunk.mp3`, `spin.mp3` (from `toggle`, `placement-a`, `placement-c`, `rotate`) | Roulette ticks and hit ticks, bananas and ink, shells and sticky bombs, shields and spikes | CC0 1.0 | Kenney, [Starter Kit City Builder](https://github.com/KenneyNL/Starter-Kit-City-Builder) |

| `rev0.wav` … `rev5.wav` (`loop_0` … `loop_5`) | Every kart's engine: six recordings at rising revs, blended by each kart's speed | CC0 1.0 | domasx2, [Racing car engine sound loops](https://opengameart.org/content/racing-car-engine-sound-loops) (OpenGameArt) |
| `engine-moto.wav` (from `audio/engine-motorcycle.ogg`, looped), `engine-car.wav` (from `audio/engine.ogg`, looped) | The recorded engine choices (the default cartoon kart is made in code, `public/js/sfx.js`) | CC0 1.0 | Kenney, [Starter Kit Racing](https://github.com/KenneyNL/Starter-Kit-Racing) |

The two loops were cut to a few seconds, crossfaded end into start so they loop without a click, and saved as 22 kHz mono WAV (gapless in every browser); the rest are small mono MP3s. The countdown, mini-turbo and item jingles are still synthesized (`public/js/sfx.js`), layered over these where noted there.


| What | Used for | Licence | Source |
|------|----------|---------|--------|
| [three.js](https://threejs.org) r169 and its addons (EffectComposer, UnrealBloomPass, OutputPass, RoomEnvironment, RoundedBoxGeometry, BufferGeometryUtils) | The 3D tracks, karts, drivers, items and effects | MIT | npm `three`, served from `/vendor/three` |

Everything in Kart Battle (the go-karts and their 15 animal drivers, tracks, item models, icons, sounds) is original and drawn or synthesized in code: the karts and drivers in `public/js/games/kart3d/gokart.js`.

## Control Room

| What | Used for | Licence | Source |
|------|----------|---------|--------|
| [ios-haptics](https://github.com/tijnjh/ios-haptics) 3.2.0 | Native haptic ticks on iPhones when you press a control (iOS Safari has no `navigator.vibrate`). Served from `node_modules` at `/vendor/ios-haptics/`. | MIT, Copyright (c) 2025 tijn | npm `ios-haptics` |
| [Lucide](https://lucide.dev) icons, 32 of them (lucide-static 1.58.0) | HUD, order card, team events, fleet board and mission report icons. The SVG paths are inlined in `public/js/games/controlroom-icons.js`. | ISC, Copyright (c) Lucide Icons and Contributors. The `x` icon comes from Feather: MIT, Copyright (c) 2013-present Cole Bemis | npm `lucide-static` |
| [Chakra Petch](https://fonts.google.com/specimen/Chakra+Petch) font | Console labels, LED readouts and the warp titles. Loaded from Google Fonts like the site's other fonts. | SIL Open Font License 1.1, Copyright Cadson Demak | Google Fonts |

Control Room's sounds (control clicks, chimes, buzzers, klaxon, warp) are synthesized with the Web Audio API in `public/js/sfx.js`, so no audio files are bundled.

### Licence notices

**ios-haptics** (MIT)

> MIT License Copyright (c) 2025 tijn
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

**Lucide** (ISC)

> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

**Feather** (MIT, for Lucide icons derived from Feather)

> Copyright (c) 2013-present Cole Bemis
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
