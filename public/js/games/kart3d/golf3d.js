// Mini Golf Mayhem's scenery. kart-layers.js (theMiniGolf) lays out the course and the bright kit
// draws its greens, carpets, paths, walls and water; this adds the crazy golf props, at toy scale
// (the karts are smaller than the golf balls): the windmill's roof and turning sails, a giant
// putter swinging from its gantry across the way in, the volcano's crater puffing smoke round a
// cup full of lava, the castle's battlements, turret roofs and pennants, lily pads and a fountain
// in the pond, golf balls sat down in the turf, a numbered pin flag in every cup. Round the course:
// timber boards, then a back garden for giants: a lawn mown in stripes, towering flowers, a hedge,
// a shed, a watering can, and a gnome keeping an eye on it all.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brightMaterial, flatGeo, box, post, ball, strut, merged, glow, nearFade } from './bright3d.js';
import { toonGradient } from './toon.js';
import { rng } from './world.js';

const L = window.KartCore.Layers;
const TAU = Math.PI * 2;
const WHITE = '#fbfaf6';
const RED = '#e5484d';
const GOLD = '#f2c14e';
const CHROME = '#cfd6df';
const WOOD = '#c98c50';
const STEM = '#4f9d3a';

// A solid of revolution round a vertical axis at (x, y), from [radius, height] pairs.
function lathe(x, y, z, profile, colour, n = 20) {
  const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(Math.max(0.01, r), h)), n);
  return flatGeo(g.translate(x, z, y), colour);
}
// An ellipsoid (a leaf, a petal, a beard): a sphere stretched, then turned.
function blob(x, y, z, rx, ry, rz, colour, turn = 0, tilt = 0) {
  const g = new THREE.SphereGeometry(1, 12, 8).scale(rx, rz, ry).rotateX(tilt).rotateY(turn).translate(x, z, y);
  return flatGeo(g, colour);
}

// ---------- on the course ----------
// A giant golf ball sat down in the turf, dimpled all over (a Fibonacci spread of shallow discs).
const _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
function golfBall(d, parts) {
  const cz = d.z + d.r * 0.55;
  parts.push(flatGeo(new THREE.SphereGeometry(d.r, 30, 22).translate(d.x, cz, d.y), WHITE));
  const n = Math.round(d.r * 2.2);
  const dimple = new THREE.CircleGeometry(d.r * 0.075, 7);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const up = 1 - (i / (n - 1)) * 2;
    if (up < -0.5) break; // (the rest is in the ground)
    const rr = Math.sqrt(1 - up * up);
    _n.set(Math.cos(golden * i) * rr, up, Math.sin(golden * i) * rr);
    const g = dimple.clone().applyQuaternion(_q.setFromUnitVectors(_z, _n));
    g.translate(d.x + _n.x * d.r * 1.006, cz + _n.y * d.r * 1.006, d.y + _n.z * d.r * 1.006);
    parts.push(flatGeo(g, '#dde3ec'));
  }
}

// A golf cup: a ring of closer-mown green round it, its white liner showing at the rim, the hole.
// The volcano's is full of lava instead.
function cup(h, lava, parts, glows) {
  const flat = (g, y) => g.rotateX(-Math.PI / 2).translate(h.x, h.z + y, h.y);
  if (lava) {
    parts.push(flatGeo(flat(new THREE.RingGeometry(h.r - 2, h.r + 26, 40), 0.4), '#3d2f2a'));
    glows.push(flat(new THREE.CircleGeometry(h.r - 2, 40), 0.6));
    return;
  }
  parts.push(flatGeo(flat(new THREE.RingGeometry(h.r, h.r + 22, 40), 0.3), '#47c950'));
  parts.push(flatGeo(flat(new THREE.RingGeometry(h.r - 6, h.r, 40), 0.5), WHITE));
  parts.push(flatGeo(flat(new THREE.CircleGeometry(h.r - 6, 40), 0.5), '#0c1220'));
}

// A pin flag: a white pole (a red band, a gold knob), the cloth with its hole number rippling.
// (mirrored: for the back of the cloth, so the number reads right from both sides)
function flagTexture(n, mirrored) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = RED;
  g.fillRect(0, 0, 128, 80);
  if (mirrored) { g.translate(128, 0); g.scale(-1, 1); }
  g.fillStyle = '#ffffff';
  g.font = '800 58px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n ?? ''), 64, 44);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function pinFlag(scene, d, parts) {
  const r = d.big ? 4.5 : 3.2;
  parts.push(post(d.x, d.y, d.z - 2, d.z + d.h, r, WHITE, 8));
  parts.push(post(d.x, d.y, d.z + d.h * 0.6, d.z + d.h * 0.64, r + 0.5, RED, 8));
  parts.push(ball(d.x, d.y, d.z + d.h + 2, r + 2.5, GOLD, 8));
  const w = d.big ? 130 : 84;
  const hh = w * 0.62;
  const geo = new THREE.PlaneGeometry(w, hh, 12, 4).translate(w / 2 + r, 0, 0);
  const cloth = new THREE.Group();
  for (const back of [false, true]) {
    const m = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ map: flagTexture(d.hole, back), gradientMap: toonGradient(), side: back ? THREE.BackSide : THREE.FrontSide }));
    m.castShadow = !back;
    cloth.add(m);
  }
  cloth.position.set(d.x, d.z + d.h - hh / 2 - 6, d.y);
  scene.add(cloth);
  const rest = geo.attributes.position.array.slice();
  const pos = geo.attributes.position;
  return (t) => {
    for (let i = 0; i < pos.array.length; i += 3) {
      const u = Math.max(0, rest[i] - r) / w;
      pos.array[i + 2] = Math.sin(rest[i] * 0.07 - t * 5.5 + d.x) * 7 * u;
    }
    pos.needsUpdate = true;
    cloth.rotation.y = 0.7 + Math.sin(t * 0.6 + d.y) * 0.3;
  };
}

// The windmill: the course's lays out the tower (a tunnel through its foot); this adds a red tiled
// roof, a cornice, windows, timber frames round both doorways and the four sails turning over the
// east door (high enough to keep clear of it).
function windmill(scene, d, parts) {
  const { x, y, z, w, top, face } = d;
  const half = w / 2;
  const roof = new THREE.ConeGeometry(half * Math.SQRT2 + 18, 150, 4, 1).rotateY(Math.PI / 4).translate(x, top + 75, y);
  parts.push(flatGeo(roof, RED, 1, { id: 'bands', cell: 20, color: '#c73c41' }));
  parts.push(ball(x, y, top + 154, 10, GOLD, 10));
  parts.push(box(x - half - 7, y - half - 7, top - 8, x + half + 7, y + half + 7, top + 4, WHITE, 2));
  for (const sy of [-1, 1]) {
    for (const wx of [x - 42, x + 42]) {
      const fy = y + sy * half;
      parts.push(box(wx - 17, fy, z + 146, wx + 17, fy + sy * 3, z + 202, WHITE, 2));
      parts.push(box(wx - 12, fy + sy * 2, z + 151, wx + 12, fy + sy * 4, z + 197, '#7ec8ff', 1));
    }
  }
  for (const sx of [-1, 1]) {
    const fx = x + sx * half;
    for (const sy of [-1, 1]) parts.push(box(fx - sx * 4, y + sy * 60, z - 4, fx + sx * 5, y + sy * 72, z + 86, '#8a5530', 2));
    parts.push(box(fx - sx * 4, y - 72, z + 72, fx + sx * 5, y + 72, z + 88, '#8a5530', 2));
    // A round window over each door.
    parts.push(flatGeo(new THREE.CircleGeometry(16, 16).rotateY(sx * Math.PI / 2).translate(fx + sx * 1.2, z + 120, y), '#7ec8ff'));
  }
  const hub = new THREE.Group();
  hub.position.set(face + 16, z + 232, y);
  const sail = [];
  for (let i = 0; i < 4; i++) {
    const g = [];
    g.push(new THREE.BoxGeometry(7, 150, 7).translate(0, 80, 0));
    g.push(new THREE.BoxGeometry(3, 112, 42).translate(-2, 96, 23));
    for (let k = 0; k < 6; k++) g.push(new THREE.BoxGeometry(5, 4, 46).translate(0, 44 + k * 20, 23));
    sail.push(flatGeo(mergeGeometries(g.map((q) => q.toNonIndexed())).rotateX((i / 4) * TAU), i % 2 ? WHITE : '#ffd6d6'));
  }
  sail.push(flatGeo(new THREE.CylinderGeometry(15, 15, 20, 14).rotateZ(Math.PI / 2), '#3b4252'));
  const blades = merged(sail);
  hub.add(blades);
  scene.add(hub);
  return (t) => { blades.rotation.x = t * 0.9; };
}

// The giant putter, swinging across the way into the windmill from a gantry (the posts are the
// course's; the crossbar is drawn here): a chrome shaft, a black grip, a steel blade of a head where
// the pendulum's ball is.
function putter(scene, map, m) {
  const posts = map.solids.filter((s) => s.kind === 'gantry');
  if (posts.length === 2) scene.add(merged([box(m.x - 10, posts[0].y, m.z + 4, m.x + 10, posts[1].y, m.z + 26, RED, 5)]));
  const g = new THREE.Group();
  g.position.set(m.x, m.z, m.y);
  const club = [];
  club.push(flatGeo(new THREE.CylinderGeometry(4.5, 5, m.len - 12, 10).translate(0, -(m.len - 12) / 2, 0), CHROME));
  club.push(flatGeo(new THREE.CylinderGeometry(7.5, 6.5, 64, 12).translate(0, -40, 0), '#1f2430'));
  club.push(flatGeo(new THREE.CylinderGeometry(9, 9, 16, 12).rotateZ(Math.PI / 2), GOLD));
  // The head: a steel blade with rounded heel and toe, a gold sight line along its top, the hosel up
  // to the shaft.
  const L2 = m.r * 2.6;
  const H2 = m.r * 0.9;
  const T2 = m.r * 0.62;
  club.push(flatGeo(new THREE.BoxGeometry(L2 - T2, H2, T2).translate(0, -m.len, 0), '#b9c2cd'));
  for (const sx of [-1, 1]) club.push(flatGeo(new THREE.CylinderGeometry(T2 / 2, T2 / 2, H2, 14).translate(sx * (L2 - T2) / 2, -m.len, 0), '#b9c2cd'));
  club.push(flatGeo(new THREE.BoxGeometry(L2 * 0.5, 1.5, 3).translate(0, -m.len + H2 / 2 + 0.6, 0), GOLD));
  club.push(flatGeo(new THREE.CylinderGeometry(4.5, 5.5, H2 * 0.7, 10).translate(0, -m.len + H2 * 0.7, 0), CHROME));
  g.add(merged(club));
  scene.add(g);
  return { update(t) { g.rotation.x = -map.pendulumAt(m, t).th; } };
}

// The castle: battlements along every wall, a cone roof and a pennant on each turret, a lintel over
// the west gate.
function castle(map, d, parts, pennants) {
  const STONE = '#f7dfb0';
  for (const s of map.solids) {
    if (s.kind !== 'castle') continue;
    const alongX = s.x1 - s.x0 > s.y1 - s.y0;
    const [a0, a1] = alongX ? [s.x0, s.x1] : [s.y0, s.y1];
    for (let u = a0 + 8; u + 16 <= a1 - 6; u += 34) {
      parts.push(alongX ? box(u, s.y0, s.z1 - 2, u + 16, s.y1, s.z1 + 18, STONE, 2) : box(s.x0, u, s.z1 - 2, s.x1, u + 16, s.z1 + 18, STONE, 2));
    }
  }
  const colours = [RED, '#ffd23f', '#3fa9f5', '#ffffff'];
  map.solids.filter((s) => s.kind === 'turret').forEach((s, i) => {
    parts.push(flatGeo(new THREE.ConeGeometry(s.r + 12, 112, 20).translate(s.x, s.z1 + 56, s.y), '#3f7fd9', 1, { id: 'bands', cell: 16, color: '#3570c6' }));
    parts.push(post(s.x, s.y, s.z1 + 104, s.z1 + 156, 2.6, '#6b4a2b', 6), ball(s.x, s.y, s.z1 + 158, 4, GOLD, 8));
    pennants.push({ x: s.x, y: s.y, z: s.z1 + 152, colour: colours[i % colours.length] });
  });
  const { x, y, half, wall, h, gate } = d;
  parts.push(box(x - half - 3, y - gate - 6, h - 22, x - half + wall + 3, y + gate + 6, h, '#e9c58e', 3));
}
// Pennants: a long triangle off each pole, swaying.
function addPennants(scene, list) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 9, 0), new THREE.Vector3(0, -9, 0), new THREE.Vector3(62, 0, 0)]);
  geo.computeVertexNormals();
  const flags = list.map((p) => {
    const m = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color: p.colour, gradientMap: toonGradient(), side: THREE.DoubleSide }));
    m.position.set(p.x + 2, p.z - 10, p.y);
    scene.add(m);
    return m;
  });
  return (t) => flags.forEach((m, i) => { m.rotation.y = 0.5 + Math.sin(t * 1.3 + i * 1.7) * 0.4; });
}

// Lily pads on the pond (a notch out of each), the big ones flowering.
function lily(d, parts) {
  parts.push(flatGeo(new THREE.CircleGeometry(d.r, 22, 0.35, TAU - 0.7).rotateX(-Math.PI / 2).translate(d.x, d.z + 1.2, d.y), '#3fae57'));
  if (d.r < 40) return;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU;
    parts.push(blob(d.x + Math.cos(a) * 7, d.y + Math.sin(a) * 7, d.z + 8, 9, 4, 5, '#ff8fb8', -a, 0.5));
  }
  parts.push(ball(d.x, d.y, d.z + 9, 4.5, '#ffd23f', 8));
}
// The pond's fountain: a jet from a stone bowl, spilling back (the water fades near the camera).
function fountain(scene, d, parts) {
  parts.push(lathe(d.x, d.y, d.z - 4, [[0, 0], [26, 0], [30, 10], [28, 14], [8, 14], [6, 22], [0, 22]], '#d9d4c7', 20));
  const water = nearFade(new THREE.MeshBasicMaterial({ color: '#9be7ff', transparent: true, opacity: 0.7, depthWrite: false }));
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(2, 5, 90, 10, 1, true), water);
  jet.position.set(d.x, d.z + 62, d.y);
  const spill = new THREE.Mesh(new THREE.CylinderGeometry(9, 30, 80, 18, 1, true), water);
  spill.position.set(d.x, d.z + 60, d.y);
  scene.add(jet, spill);
  return (t) => { jet.scale.y = 1 + 0.15 * Math.sin(t * 7); spill.rotation.y = t * 0.8; };
}

// The volcano's crater: scorched rock round the lava cup (smoke and sparks come off it in ambient()).
function crater(d, parts) {
  parts.push(flatGeo(new THREE.RingGeometry(80, d.r - 6, 40).rotateX(-Math.PI / 2).translate(d.x, d.z + 0.2, d.y), '#4a3a33', 1, { id: 'slabs', cell: 34, color: '#3b2e29' }));
}

// The course's edge: timber boards along the walls karts bounce off, a white cap along the top.
function boards(map, parts) {
  const S = map.size;
  const E = L.EDGE;
  const H = 34;
  const grain = { id: 'planks', cell: 11, color: '#a8703e' };
  for (const [x0, y0, x1, y1] of [[0, 0, S, E], [0, S - E, S, S], [0, E, E, S - E], [S - E, E, S, S - E]]) {
    parts.push(box(x0, y0, -12, x1, y1, H, WOOD, 3, grain));
    parts.push(box(x0 + 4, y0 + 4, H - 1, x1 - 4, y1 - 4, H + 5, WHITE, 2));
  }
}

// ---------- the back garden round it ----------
// A sunflower: a tall stem with leaves, a big head of petals round a seed disc, turned to face in.
function sunflower(x, y, h, face, parts) {
  const s = h / 2000;
  parts.push(post(x, y, -10, h, 26 * s, STEM, 8, 20 * s));
  for (const [f, side] of [[0.35, 1], [0.55, -1], [0.72, 1]]) {
    parts.push(blob(x + Math.cos(face + side * 1.4) * 70 * s, y + Math.sin(face + side * 1.4) * 70 * s, h * f, 90 * s, 36 * s, 10 * s, '#5aa845', -(face + side * 1.4), 0.4));
  }
  const cx = x + Math.cos(face) * 40 * s;
  const cy = y + Math.sin(face) * 40 * s;
  const head = [];
  head.push(new THREE.CylinderGeometry(150 * s, 150 * s, 30 * s, 24).toNonIndexed());
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * TAU;
    head.push(new THREE.SphereGeometry(1, 8, 6).scale(110 * s, 10 * s, 46 * s).translate(250 * s, 0, 0).rotateY(a).toNonIndexed());
  }
  const petals = mergeGeometries(head.slice(1)).rotateZ(Math.PI / 2 - 0.45).rotateY(Math.PI - face).translate(cx, h + 60 * s, cy);
  const disc = head[0].rotateZ(Math.PI / 2 - 0.45).rotateY(Math.PI - face).translate(cx, h + 60 * s, cy);
  parts.push(flatGeo(petals, '#ffcc29'), flatGeo(disc, '#6b3f1f', 1, { id: 'checker', cell: 22 * s + 6, color: '#55301a' }));
}
// A tulip: a stem, two long leaves, a cup of petals.
function tulip(x, y, h, colour, parts) {
  const s = h / 1200;
  parts.push(post(x, y, -10, h, 16 * s, STEM, 8));
  parts.push(blob(x + 50 * s, y, h * 0.25, 30 * s, 16 * s, 260 * s, '#5aa845', 0, 0.35), blob(x - 50 * s, y, h * 0.22, 30 * s, 16 * s, 240 * s, '#5aa845', Math.PI, 0.35));
  parts.push(lathe(x, y, h - 20 * s, [[0, 0], [60 * s, 20 * s], [92 * s, 90 * s], [86 * s, 170 * s], [70 * s, 220 * s], [0, 200 * s]], colour, 14));
}
function shed(x, y, parts) {
  // A timber garden shed, gable end on: planked walls, a felt roof, a door and a window.
  const W = 1700;
  const D = 1100;
  const H = 1100;
  parts.push(box(x - W / 2, y - D / 2, -10, x + W / 2, y + D / 2, H, '#b98250', 6, { id: 'planks', cell: 60, color: '#9b6a3e' }));
  // (A three-sided prism along the ridge, one edge up, squashed to a gentle pitch.)
  const roof = new THREE.CylinderGeometry(D * 0.72, D * 0.72, W + 120, 3, 1).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).scale(1, 0.52, 1).translate(x, H + 150, y);
  parts.push(flatGeo(roof, '#4a5058', 1, { id: 'slabs', cell: 120, color: '#3e434a' }));
  parts.push(box(x - 200, y + D / 2, -6, x + 200, y + D / 2 + 14, 820, '#8f5d34', 4), box(x + 130, y + D / 2 + 12, 380, x + 170, y + D / 2 + 26, 420, GOLD, 4));
  parts.push(box(x + 420, y + D / 2, 480, x + 720, y + D / 2 + 12, 780, WHITE, 4), box(x + 440, y + D / 2 + 6, 500, x + 700, y + D / 2 + 16, 760, '#9fd8ff', 2));
}
function wateringCan(x, y, parts) {
  // A green watering can on its side's foot: body, a long spout with a rose, a handle over the top.
  const R = 380;
  const H = 620;
  parts.push(post(x, y, -10, H, R, '#3fae6a', 28), post(x, y, H - 4, H + 16, R + 10, '#2f8f55', 28));
  parts.push(strut([x + R * 0.8, y, 160], [x + R + 520, y, 760], 46, '#3fae6a'));
  parts.push(flatGeo(new THREE.CylinderGeometry(90, 50, 70, 16).rotateZ(-0.9).translate(x + R + 540, 790, y), '#2f8f55'));
  const handle = new THREE.TorusGeometry(300, 38, 10, 24, Math.PI).translate(x - 60, H + 10, y);
  parts.push(flatGeo(handle, '#2f8f55'));
}
function gnome(x, y, face, parts) {
  // A garden gnome, keeping an eye on the course: blue coat, black belt, white beard, red hat.
  const s = 1;
  parts.push(post(x, y, -10, 150 * s, 260 * s, '#6b4a2b', 18), post(x, y, 150, 560, 230, '#3f6fd6', 18, 280));
  parts.push(post(x, y, 400, 450, 248, '#1f2430', 18));
  parts.push(blob(x + Math.cos(face) * 120, y + Math.sin(face) * 120, 640, 170, 120, 210, WHITE, -face, 0.2));
  parts.push(ball(x + Math.cos(face) * 60, y + Math.sin(face) * 60, 760, 170, '#f6c6a4', 16));
  parts.push(ball(x + Math.cos(face) * 220, y + Math.sin(face) * 220, 760, 48, '#f0a08c', 10));
  for (const side of [-1, 1]) parts.push(ball(x + Math.cos(face) * 200 + Math.cos(face + side * 0.5) * 30, y + Math.sin(face) * 200 + Math.sin(face + side * 0.5) * 30, 820, 16, '#1f2430', 8));
  parts.push(flatGeo(new THREE.ConeGeometry(190, 520, 18).rotateZ(0.25).rotateY(-face).translate(x, 1100, y), RED));
}

function backGarden(scene, map, parts) {
  const S = map.size;
  const C = S / 2;
  const r = rng(29);
  // The lawn outside, mown in broad stripes, out to the horizon (a hole where the course is).
  const far = 12000;
  const P = (x, y) => new THREE.Vector2(x, -y);
  const shape = new THREE.Shape([P(-far, -far), P(S + far, -far), P(S + far, S + far), P(-far, S + far)]);
  shape.holes.push(new THREE.Path([P(0, 0), P(0, S), P(S, S), P(S, 0)]));
  const lawn = new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, -0.3, 0), '#6cc35a', 1, { id: 'hazard', cell: 640, color: '#63b852' }), brightMaterial());
  lawn.receiveShadow = true;
  scene.add(lawn);
  // A hedge round the garden, far off.
  const R = 5600;
  const HH = 1500;
  for (const [x0, y0, x1, y1] of [[C - R, C - R, C + R, C - R + 500], [C - R, C + R - 500, C + R, C + R], [C - R, C - R, C - R + 500, C + R], [C + R - 500, C - R, C + R, C + R]]) {
    parts.push(box(x0, y0, -10, x1, y1, HH, '#3f8f3e', 60, { id: 'tiles', cell: 140, color: '#377f36' }));
  }
  // Flowers between the course and the hedge (clear of the boards), facing the course.
  const tulips = ['#ff5d73', '#ffd23f', '#ff8fb8', '#b07cff', '#ff9a3c'];
  for (let k = 0; k < 34; k++) {
    let x;
    let y;
    do { x = C - R + 700 + r() * (2 * R - 1400); y = C - R + 700 + r() * (2 * R - 1400); } while (x > -650 && x < S + 650 && y > -650 && y < S + 650);
    const face = Math.atan2(C - y, C - x);
    if (k % 3 === 0) sunflower(x, y, 1700 + r() * 1100, face, parts);
    else tulip(x, y, 800 + r() * 700, tulips[k % tulips.length], parts);
  }
  shed(C + 400, -2600, parts);
  wateringCan(S + 1500, C - 700, parts);
  gnome(-1500, S - 500, -0.35, parts);
}

// ---------- the whole dressing ----------
export function buildMiniGolf(scene, map) {
  const parts = [];
  const glows = [];
  const pennants = [];
  const tickers = [];
  const craters = (map.deco || []).filter((d) => d.kind === 'crater');
  for (const d of map.deco || []) {
    if (d.kind === 'golfball') golfBall(d, parts);
    else if (d.kind === 'flag') tickers.push(pinFlag(scene, d, parts));
    else if (d.kind === 'windmill') tickers.push(windmill(scene, d, parts));
    else if (d.kind === 'crater') crater(d, parts);
    else if (d.kind === 'castle') castle(map, d, parts, pennants);
    else if (d.kind === 'lily') lily(d, parts);
    else if (d.kind === 'fountain') tickers.push(fountain(scene, d, parts));
  }
  for (const h of map.hazards) {
    if (h.kind === 'cup') cup(h, craters.some((c) => Math.hypot(c.x - h.x, c.y - h.y) < 10), parts, glows);
  }
  boards(map, parts);
  backGarden(scene, map, parts);
  scene.add(merged(parts));
  let lava = null;
  if (glows.length) {
    lava = glow(mergeGeometries(glows.map((g) => g.toNonIndexed())), '#ff7a1f');
    scene.add(lava);
  }
  tickers.push(addPennants(scene, pennants));
  // Smoke and sparks out of the volcano's cup.
  const vents = map.hazards.filter((h) => h.kind === 'cup' && craters.some((c) => Math.hypot(c.x - h.x, c.y - h.y) < 10));
  const smokeCol = new THREE.Color(0xd8d2cc);
  const sparkCols = [new THREE.Color(0xffb347), new THREE.Color(0xff7a1f), new THREE.Color(0xffe08a)];
  let puff = 0;
  return {
    // Drawn here instead of by the bright kit (golf balls) or arena3d (the cups).
    skip: new Set(['golfball', 'cup']),
    ownWorld: true,
    mover(m) {
      if (m.type === 'pendulum' && m.kind === 'putter') return putter(scene, map, m);
      return null;
    },
    update(t) {
      for (const f of tickers) f(t);
      if (lava) lava.material.color.setHSL(0.07, 1, 0.52 + Math.sin(t * 2.4) * 0.06);
    },
    ambient(dt, cam, fire, smoke) {
      puff -= dt;
      for (const v of vents) {
        if (Math.hypot(v.x - cam.x, v.y - cam.z) > 2600) continue;
        if (puff <= 0) smoke.emit(v.x + (Math.random() - 0.5) * 30, v.z + 6, v.y + (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 20, 70 + Math.random() * 40, (Math.random() - 0.5) * 20, smokeCol, 26, 3.2, { alpha: 0.4, grow: 2.2, drag: 0.4, rise: 12 });
        if (Math.random() < dt * 6) {
          const a = Math.random() * TAU;
          fire.emit(v.x + Math.cos(a) * 12, v.z + 4, v.y + Math.sin(a) * 12, Math.cos(a) * 40, 160 + Math.random() * 160, Math.sin(a) * 40, sparkCols[Math.floor(Math.random() * 3)], 4 + Math.random() * 3, 1, { drag: 0.5, rise: -420 });
        }
      }
      if (puff <= 0) puff = 0.32;
    },
  };
}
