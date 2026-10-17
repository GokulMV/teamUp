// The weekly arena's surroundings in the bright look (shared/kart-weekly.js makes the layout; its
// look picks the palette): ground out to the horizon, a low wall round the field, hills, and the
// look's own scatter of props outside it (round trees for a castle, dunes and palms for desert
// ruins, snowy pines and ice crystals on a glacier, rock spires and glowing vents on basalt,
// crooked trees and old graves round a graveyard). Sweepers turn as quintains (or a scythe in a
// graveyard) and the crown spins over the centrepiece.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brightMaterial, flatGeo, box, post, ball, strut, merged, glow } from './bright3d.js';
import { rng } from './world.js';
import { quintain, crown } from './keep3d.js';
import { scythe, deadTree, headstone, fence } from './graveyard3d.js';

const TAU = Math.PI * 2;
// Per look: ground (two tones), the field's wall (stone, cap), hills (two tones).
const OUTSKIRTS = {
  keep: { ground: ['#74c45a', '#6ebe54'], wall: ['#f2dbb2', '#e3c899'], hills: ['#6cbf55', '#5fb34e'] },
  ruins: { ground: ['#efcd90', '#e7c282'], wall: ['#e9a066', '#cc7c42'], hills: ['#e2ae70', '#d69c5e'] },
  glacier: { ground: ['#e4effa', '#d6e6f6'], wall: ['#a6d9f3', '#6db3e0'], hills: ['#dcebf8', '#c6dcf0'] },
  basalt: { ground: ['#4d4756', '#463f50'], wall: ['#7a7088', '#585066'], hills: ['#3e3848', '#4a3f4f'] },
  graveyard: { ground: ['#2a6a52', '#2f7356'], wall: ['#cec6e3', '#aaa1c6'], hills: ['#2c4f5e', '#33465e'] },
};

// ---------- props, one look at a time ----------
function roundTree(x, y, s, r, parts) {
  const leaf = ['#4fae4a', '#5cbf55', '#43a046', '#6cc85e'][Math.floor(r() * 4)];
  parts.push(post(x, y, 0, 46 * s, 8 * s, '#8f5d34', 6), ball(x, y, 70 * s, 34 * s, leaf, 8), ball(x + 18 * s, y + 8 * s, 56 * s, 22 * s, leaf, 7));
}
function palm(x, y, s, r, parts) {
  let p = [x, y, 0];
  const lean = r() * TAU;
  for (let k = 1; k <= 4; k++) {
    const q = [x + Math.cos(lean) * k * k * 2.5 * s, y + Math.sin(lean) * k * k * 2.5 * s, k * 34 * s];
    parts.push(strut(p, q, (7 - k) * s, k % 2 ? '#b98a5a' : '#a8784a'));
    p = q;
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + r() * 0.3;
    const tip = [p[0] + Math.cos(a) * 60 * s, p[1] + Math.sin(a) * 60 * s, p[2] - 18 * s];
    parts.push(strut(p, tip, 4 * s, i % 2 ? '#3f9e4d' : '#4fb35a'));
  }
}
function dune(x, y, s, parts) {
  parts.push(flatGeo(new THREE.SphereGeometry(140 * s, 12, 6, 0, TAU, 0, Math.PI / 2).scale(1.6, 0.35, 1).rotateY(x).translate(x, -2, y), '#ecc98c'));
}
function snowPine(x, y, s, parts) {
  parts.push(post(x, y, 0, 26 * s, 7 * s, '#7a5232', 6));
  for (let k = 0; k < 3; k++) parts.push(flatGeo(new THREE.ConeGeometry((46 - k * 11) * s, 58 * s, 8).translate(x, (44 + k * 30) * s, y), k === 2 ? '#ffffff' : '#3f8f6a'));
}
function crystal(x, y, s, parts) {
  parts.push(flatGeo(new THREE.OctahedronGeometry(30 * s, 0).scale(0.6, 1.8, 0.6).rotateY(x).translate(x, 40 * s, y), '#9fdcff'));
}
function spire(x, y, s, parts) {
  parts.push(flatGeo(new THREE.ConeGeometry(48 * s, 190 * s, 6).rotateY(x).translate(x, 90 * s, y), '#3e3848'));
}

// ---------- the whole dressing ----------
export function buildWeekly(scene, map) {
  const S = map.size;
  const theme = OUTSKIRTS[map.theme] ? map.theme : 'keep';
  const look = OUTSKIRTS[theme];
  const parts = [];
  const lanterns = [];
  const vents = [];
  // Ground out to the horizon, with a square hole where the field is.
  const far = 9000;
  const P = (x, y) => new THREE.Vector2(x, -y);
  const shape = new THREE.Shape([P(-far, -far), P(S + far, -far), P(S + far, S + far), P(-far, S + far)]);
  shape.holes.push(new THREE.Path([P(0, 0), P(0, S), P(S, S), P(S, 0)]));
  const ground = new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, -0.2, 0), look.ground[0], 1, { id: 'checker', cell: 520, color: look.ground[1] }), brightMaterial());
  ground.receiveShadow = true;
  scene.add(ground);
  // The wall round the field (an iron railing round a graveyard).
  const E = 40;
  if (theme === 'graveyard') {
    for (let k = 0; k < 16; k++) {
      const a = E / 2 + (k / 16) * (S - E);
      const b = E / 2 + ((k + 1) / 16) * (S - E);
      for (const [x0, y0, x1, y1] of [[a, E / 2 - 4, b, E / 2 + 4], [a, S - E / 2 - 4, b, S - E / 2 + 4], [E / 2 - 4, a, E / 2 + 4, b], [S - E / 2 - 4, a, S - E / 2 + 4, b]]) {
        fence({ x0, y0, x1, y1, z0: -24, z1: 56 }, parts);
      }
    }
  } else {
    for (const [x0, y0, x1, y1] of [[0, 0, S, E], [0, S - E, S, S], [0, E, E, S - E], [S - E, E, S, S - E]]) {
      parts.push(box(x0, y0, -2, x1, y1, 30, look.wall[0], 3), box(x0 - 2, y0 - 2, 30, x1 + 2, y1 + 2, 36, look.wall[1], 2));
    }
    for (let k = 0; k <= 16; k++) {
      const u = (S * k) / 16;
      for (const [x, y] of [[u, E / 2], [u, S - E / 2], [E / 2, u], [S - E / 2, u]]) parts.push(post(x, y, 0, 50, 13, look.wall[1], 10), ball(x, y, 54, 9, look.wall[0], 8));
    }
  }
  // The look's props, scattered round outside the field.
  const r = rng(4040 + S);
  for (let i = 0; i < 150; i++) {
    const a = r() * TAU;
    const d = S * 0.72 + 150 + Math.pow(r(), 0.7) * 3000;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    if (x > -150 && x < S + 150 && y > -150 && y < S + 150) continue;
    const s = 0.8 + r() * 0.8;
    if (theme === 'keep') roundTree(x, y, s, r, parts);
    else if (theme === 'ruins') { if (i % 3) palm(x, y, s, r, parts); else dune(x, y, s, parts); }
    else if (theme === 'glacier') { if (i % 4) snowPine(x, y, s, parts); else crystal(x, y, s, parts); }
    else if (theme === 'basalt') { if (i % 3) spire(x, y, s, parts); else vents.push(new THREE.CircleGeometry(26 * s, 12).rotateX(-Math.PI / 2).translate(x, 0.5, y)); }
    else if (i % 3) deadTree({ x, y, r: 14 + r() * 8, z0: -24, z1: 120 + r() * 120 }, parts, lanterns);
    else headstone({ x0: x - 17, x1: x + 17, y0: y - 7, y1: y + 7, z0: -24, z1: 36 + r() * 16 }, parts);
  }
  // Hills on the horizon.
  const hills = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + r() * 0.2;
    const d = 5000 + r() * 1800;
    const rad = 900 + r() * 900;
    hills.push(flatGeo(new THREE.SphereGeometry(rad, 16, 8, 0, TAU, 0, Math.PI / 2).scale(1, 0.32 + r() * 0.2, 1).translate(S / 2 + Math.cos(a) * d, -10, S / 2 + Math.sin(a) * d), look.hills[i % 2]));
  }
  scene.add(new THREE.Mesh(mergeGeometries(hills), brightMaterial()));
  scene.add(merged(parts));
  if (vents.length) scene.add(glow(mergeGeometries(vents), '#ff7a2a'));
  if (lanterns.length) scene.add(glow(mergeGeometries(lanterns.map(([x, y, z]) => new THREE.SphereGeometry(6, 10, 8).translate(x, z, y))), '#ffd08a'));
  const tickers = [];
  for (const d of map.deco || []) if (d.kind === 'crown') tickers.push(crown(scene, d));
  return {
    skip: new Set(),
    ownWorld: true,
    mover(m) {
      if (m.type !== 'sweeper') return null;
      return theme === 'graveyard' ? scythe(scene, m) : quintain(scene, m);
    },
    update(t) { for (const f of tickers) f(t); },
  };
}
