// The Graveyard's own pieces (kart-layers.js's theGraveyard), in the bright look (kart3d/bright3d.js):
// headstones of every shape, wrought-iron fences with gold spear tips, twisted dead trees with
// lanterns hanging from them, the crypt dressed as a gothic chapel (buttresses, pinnacles, pointed
// arches glowing over its doors, rose windows), lanterns and braziers, bats round the roof, mist on
// the hills, and the country round about: an iron railing round the field, dark hills, more
// graves, and a haunted manor up on a hill.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brightMaterial, flatGeo, box, post, ball, strut, merged, darker, glow } from './bright3d.js';
import { tex, rng } from './world.js';

const TAU = Math.PI * 2;
const STONE = '#d6d0e6';
const STONE2 = '#bdb5d3';
const MOSS = '#5fa36b';
const IRON = '#2b2840';
const GOLD = '#f6c544';
const BARK = '#4f4462';
const VIOLET = '#7a5ad0';
const WARM = '#ffd08a';

// A little hash for picking shapes and tints that stay put.
const pick = (x, y, k) => Math.abs(Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453) % 1;

// ---------- headstones ----------
// Each tomb block becomes a headstone of one of three shapes, facing along its thin side, a shade of
// stone of its own, some of them mossy: a round-topped slab, a cross, or an obelisk.
function headstone(s, parts) {
  const w = s.x1 - s.x0;
  const d = s.y1 - s.y0;
  const alongX = w >= d;
  const cx = (s.x0 + s.x1) / 2;
  const cy = (s.y0 + s.y1) / 2;
  const width = Math.max(w, d);
  const thick = Math.min(w, d);
  const h = s.z1 - s.z0 - 24; // (the block runs 24 down into the ground)
  const z = s.z0 + 24;
  const tint = pick(cx, cy, 1) < 0.5 ? STONE : STONE2;
  const kind = pick(cx, cy, 2);
  const lean = (pick(cx, cy, 3) - 0.5) * 0.18;
  const g = [];
  if (kind < 0.55) {
    g.push(new THREE.BoxGeometry(width, h * 0.72, thick).translate(0, h * 0.36, 0));
    g.push(new THREE.CylinderGeometry(width / 2, width / 2, thick, 16, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, h * 0.72, 0));
  } else if (kind < 0.8) {
    g.push(new THREE.BoxGeometry(width * 0.32, h, thick).translate(0, h / 2, 0));
    g.push(new THREE.BoxGeometry(width, width * 0.3, thick).translate(0, h * 0.68, 0));
  } else {
    g.push(new THREE.CylinderGeometry(width * 0.22, width * 0.36, h * 0.85, 4).rotateY(Math.PI / 4).translate(0, h * 0.42, 0));
    g.push(new THREE.ConeGeometry(width * 0.24, h * 0.22, 4).rotateY(Math.PI / 4).translate(0, h * 0.95, 0));
  }
  g.push(new THREE.BoxGeometry(width + 8, 6, thick + 10).translate(0, 3, 0)); // its plinth
  const geo = mergeGeometries(g.map((q) => (q.index ? q.toNonIndexed() : q))).rotateZ(lean);
  if (!alongX) geo.rotateY(Math.PI / 2);
  geo.translate(cx, z, cy);
  parts.push(flatGeo(geo, tint));
  if (pick(cx, cy, 4) < 0.4) parts.push(ball(cx + (pick(cx, cy, 5) - 0.5) * width * 0.5, cy, z + h * 0.25, 5 + pick(cx, cy, 6) * 4, MOSS, 6));
}

// ---------- iron fences ----------
// Spear railings along each fence block: a top and bottom rail, bars every 14 with gold tips, a
// stone pier at each end.
function fence(s, parts) {
  const w = s.x1 - s.x0;
  const d = s.y1 - s.y0;
  const alongX = w >= d;
  const [a0, a1] = alongX ? [s.x0, s.x1] : [s.y0, s.y1];
  const mid = alongX ? (s.y0 + s.y1) / 2 : (s.x0 + s.x1) / 2;
  const z = s.z0 + 24;
  const top = s.z1;
  const at = (u) => (alongX ? [u, mid] : [mid, u]);
  for (const zz of [z + 8, top - 10]) {
    const [ax, ay] = at(a0);
    const [bx, by] = at(a1);
    parts.push(strut([ax, ay, zz], [bx, by, zz], 1.6, IRON));
  }
  for (let u = a0 + 7; u < a1 - 4; u += 14) {
    const [x, y] = at(u);
    parts.push(post(x, y, z, top - 2, 1.2, IRON, 5));
    parts.push(flatGeo(new THREE.ConeGeometry(2.6, 7, 5).translate(x, top + 1.5, y), GOLD));
  }
  for (const u of [a0, a1]) {
    const [x, y] = at(u);
    parts.push(box(x - 7, y - 7, z - 2, x + 7, y + 7, top + 4, STONE2, 2), ball(x, y, top + 9, 5.5, STONE, 8));
  }
}

// ---------- dead trees ----------
// A twisted trunk splitting into crooked branches, each forking again; a lantern hanging from one.
function deadTree(c, parts, lanterns) {
  const r = rng(Math.round(c.x * 7 + c.y * 3));
  const z = c.z0 + 24;
  const H = (c.z1 - z) * 0.9;
  const pts = [[c.x, c.y, z]];
  for (let k = 1; k <= 3; k++) {
    const p = pts[k - 1];
    pts.push([p[0] + (r() - 0.5) * 22, p[1] + (r() - 0.5) * 22, z + (H * 0.55 * k) / 3]);
  }
  for (let k = 0; k < 3; k++) parts.push(strut(pts[k], pts[k + 1], c.r * (0.62 - k * 0.12), BARK));
  const fork = pts[3];
  const branches = 4 + Math.floor(r() * 3);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * TAU + r() * 0.6;
    const len = H * (0.35 + r() * 0.25);
    const tip = [fork[0] + Math.cos(a) * len * 0.8, fork[1] + Math.sin(a) * len * 0.8, fork[2] + len * (0.45 + r() * 0.4)];
    parts.push(strut(fork, tip, c.r * 0.22, BARK));
    for (let j = 0; j < 2; j++) {
      const b = a + (j ? 0.7 : -0.7) * (0.5 + r());
      const l2 = len * (0.35 + r() * 0.2);
      parts.push(strut(tip, [tip[0] + Math.cos(b) * l2, tip[1] + Math.sin(b) * l2, tip[2] + l2 * (0.2 + r() * 0.5)], c.r * 0.1, BARK));
    }
    if (i === 0) {
      // A lantern on a short chain from this branch.
      const hx = fork[0] + Math.cos(a) * len * 0.55;
      const hy = fork[1] + Math.sin(a) * len * 0.55;
      const hz = fork[2] + len * 0.3;
      parts.push(strut([hx, hy, hz], [hx, hy, hz - 22], 0.8, IRON));
      parts.push(box(hx - 6, hy - 6, hz - 38, hx + 6, hy + 6, hz - 22, IRON, 1));
      lanterns.push([hx, hy, hz - 30]);
    }
  }
}

// ---------- the crypt ----------
// Buttresses down the outside of its walls, a violet cornice, a pinnacle on each corner, a pointed
// arch glowing round every door, a rose window over each.
function crypt(map, parts, glows) {
  const walls = map.solids.filter((s) => s.kind === 'crypt' && s.z0 < 0);
  if (!walls.length) return;
  const x0 = Math.min(...walls.map((s) => s.x0));
  const x1 = Math.max(...walls.map((s) => s.x1));
  const y0 = Math.min(...walls.map((s) => s.y0));
  const y1 = Math.max(...walls.map((s) => s.y1));
  const top = Math.max(...walls.map((s) => s.z1));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // Buttresses: along each side, stepping in as they rise, kept clear of the doors (the middle).
  const sides = [[x0, x1, y0, -1, 'y'], [x0, x1, y1, 1, 'y'], [y0, y1, x0, -1, 'x'], [y0, y1, x1, 1, 'x']];
  for (const [a0, a1, face, n, ax] of sides) {
    for (let u = a0 + 60; u < a1 - 40; u += 120) {
      if (Math.abs(u - (ax === 'y' ? cx : cy)) < 120) continue;
      const B = (lo, hi, out, z0, z1) => (ax === 'y'
        ? box(u - lo, face, z0, u + hi, face + n * out, z1, STONE2, 2)
        : box(face, u - lo, z0, face + n * out, u + hi, z1, STONE2, 2));
      parts.push(B(14, 14, 26, 0, 70), B(12, 12, 18, 70, 120), B(10, 10, 10, 120, top - 6));
    }
  }
  // A darker base course round the foot of the walls (doors left open).
  for (const [a0, a1, face, n, ax] of sides) {
    const mid = ax === 'y' ? cx : cy;
    for (const [u0, u1] of [[a0, mid - 72], [mid + 72, a1]]) {
      parts.push(ax === 'y' ? box(u0, face, -10, u1, face + n * 4, 22, STONE2, 1) : box(face, u0, -10, face + n * 4, u1, 22, STONE2, 1));
    }
  }
  // Cornice and corner pinnacles.
  parts.push(box(x0 - 6, y0 - 6, top - 14, x1 + 6, y0 + 4, top - 2, VIOLET, 2), box(x0 - 6, y1 - 4, top - 14, x1 + 6, y1 + 6, top - 2, VIOLET, 2));
  parts.push(box(x0 - 6, y0, top - 14, x0 + 4, y1, top - 2, VIOLET, 2), box(x1 - 4, y0, top - 14, x1 + 6, y1, top - 2, VIOLET, 2));
  // (Just outside the roof's corners: karts drive about up there.)
  for (const [x, y] of [[x0 - 16, y0 - 16], [x1 + 16, y0 - 16], [x0 - 16, y1 + 16], [x1 + 16, y1 + 16]]) {
    parts.push(box(x - 16, y - 16, 0, x + 16, y + 16, top + 40, STONE, 3));
    parts.push(flatGeo(new THREE.ConeGeometry(15, 70, 4).rotateY(Math.PI / 4).translate(x, top + 75, y), VIOLET));
    parts.push(ball(x, y, top + 114, 5, GOLD, 8));
  }
  // Doors: the pointed arches (deco 'arch' marks each door) and a rose window over each.
  for (const d of map.deco || []) {
    if (d.kind !== 'arch') continue;
    const ca = Math.cos(d.angle || 0);
    const sa = Math.sin(d.angle || 0);
    // Along the wall (u) and out of it (v): the arch stands in the plane of the wall.
    const P = (u, z) => [d.x + ca * u, d.y + sa * u, z];
    const span = d.w / 2 + 10;
    for (const sd of [-1, 1]) {
      parts.push(strut(P(sd * span, 0), P(sd * span, 58), 8, STONE));
      parts.push(strut(P(sd * span, 58), P(sd * span * 0.5, 96), 7, STONE));
      parts.push(strut(P(sd * span * 0.5, 96), P(0, 112), 7, STONE));
    }
    parts.push(ball(...P(0, 112), 9, GOLD, 8));
    // The rose window: a violet disc ringed in stone, glowing warm.
    const [rx, ry, rz] = P(0, 128);
    glows.push(new THREE.CircleGeometry(16, 20).rotateY(-(d.angle || 0)).translate(rx, rz, ry));
    parts.push(flatGeo(new THREE.TorusGeometry(17, 3, 6, 20).rotateY(-(d.angle || 0)).translate(rx, rz, ry), STONE));
  }
}

// ---------- lights ----------
// A lantern on a post, or (up on a wall) on a bracket.
function lanternPost(map, x, y, z, parts, lanterns) {
  const ground = map.land ? map.land.at(x, y) : 0;
  if (z - ground > 20) {
    // A cap and a base with the glow between them (open sides).
    parts.push(box(x - 8, y - 8, z + 8, x + 8, y + 8, z + 13, IRON, 1), box(x - 7, y - 7, z - 13, x + 7, y + 7, z - 8, IRON, 1));
    parts.push(flatGeo(new THREE.ConeGeometry(10, 9, 4).rotateY(Math.PI / 4).translate(x, z + 17, y), IRON));
    lanterns.push([x, y, z]);
    return;
  }
  parts.push(post(x, y, z, z + 70, 2.6, IRON, 6), box(x - 7, y - 7, z + 62, x + 7, y + 7, z + 82, IRON, 1));
  parts.push(flatGeo(new THREE.ConeGeometry(10, 9, 4).rotateY(Math.PI / 4).translate(x, z + 86, y), IRON));
  lanterns.push([x, y, z + 72]);
}
// A brazier: a stone bowl on its foot (solid in the physics), flames flickering out of it.
function brazier(scene, d, parts) {
  parts.push(post(d.x, d.y, d.z, d.z + 40, 12, STONE2, 10, 16));
  parts.push(post(d.x, d.y, d.z + 40, d.z + 52, 24, STONE, 14, 14));
  const flames = [];
  const mat = new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, toneMapped: false });
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(7 + (i % 2) * 3, 26, 6), mat);
    const a = (i / 4) * TAU;
    f.position.set(d.x + Math.cos(a) * 7, d.z + 64, d.y + Math.sin(a) * 7);
    scene.add(f);
    flames.push(f);
  }
  return (t) => flames.forEach((f, i) => { f.scale.y = 0.8 + 0.35 * Math.abs(Math.sin(t * 7 + i * 1.7)); f.rotation.y = t * 2 + i; });
}

// ---------- the scythe ----------
// The atrium's sweeper: a violet post with a gold cap, two long handles turning on top, a silver
// crescent blade on the end of each.
function scythe(scene, m) {
  const parts = [];
  parts.push(post(m.x, m.y, m.z, m.z + m.hi + 30, m.hub * 0.75, '#4b3a7a', 14, m.hub * 0.6));
  parts.push(post(m.x, m.y, m.z + m.hi + 22, m.z + m.hi + 30, m.hub * 0.85, GOLD, 14));
  parts.push(ball(m.x, m.y, m.z + m.hi + 38, m.hub * 0.45, GOLD, 12));
  scene.add(merged(parts));
  const spin = new THREE.Group();
  spin.position.set(m.x, m.z + (m.lo + m.hi) / 2, m.y);
  const arm = [];
  for (let i = 0; i < m.arms; i++) {
    const a = (i / m.arms) * TAU;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    arm.push(strut([c * m.hub, sn * m.hub, 0], [c * (m.len - 6), sn * (m.len - 6), 0], m.w * 0.45, '#8a5a36'));
    // The blade: an arc swept back from the handle's end, lying flat.
    const blade = new THREE.TorusGeometry(46, 5, 4, 14, Math.PI * 0.75).scale(1, 1, 0.35).rotateX(Math.PI / 2).rotateY(-a + Math.PI * 0.55).translate(c * (m.len - 40), 0, sn * (m.len - 40));
    arm.push(flatGeo(blade, '#e8ecf7'));
  }
  spin.add(merged(arm));
  scene.add(spin);
  return { update(t) { spin.rotation.y = -(m.phase + m.speed * t); } };
}

// ---------- the night round about ----------
function surroundings(scene, map, parts, lanterns) {
  const S = map.size;
  const far = 9000;
  const P = (x, y) => new THREE.Vector2(x, -y);
  const shape = new THREE.Shape([P(-far, -far), P(S + far, -far), P(S + far, S + far), P(-far, S + far)]);
  shape.holes.push(new THREE.Path([P(0, 0), P(0, S), P(S, S), P(S, 0)]));
  const ground = new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, -1, 0), '#2a6a52'), brightMaterial());
  ground.receiveShadow = true;
  scene.add(ground);
  // An iron railing round the field on stone piers, a lantern on every fourth pier.
  const E = 40;
  for (let k = 0; k < 16; k++) {
    for (const [ax, ay, bx, by] of [[k / 16, 0, (k + 1) / 16, 0], [k / 16, 1, (k + 1) / 16, 1], [0, k / 16, 0, (k + 1) / 16], [1, k / 16, 1, (k + 1) / 16]]) {
      const x0 = E / 2 + ax * (S - E);
      const y0 = E / 2 + ay * (S - E);
      const x1 = E / 2 + bx * (S - E);
      const y1 = E / 2 + by * (S - E);
      fence({ x0: Math.min(x0, x1) - (x0 === x1 ? 4 : 0), x1: Math.max(x0, x1) + (x0 === x1 ? 4 : 0), y0: Math.min(y0, y1) - (y0 === y1 ? 4 : 0), y1: Math.max(y0, y1) + (y0 === y1 ? 4 : 0), z0: -24, z1: 56 }, parts);
    }
  }
  for (let k = 0; k <= 16; k += 4) {
    const u = E / 2 + (k / 16) * (S - E);
    for (const [x, y] of [[u, E / 2], [u, S - E / 2], [E / 2, u], [S - E / 2, u]]) lanterns.push([x, y, 84]);
  }
  // Dark hills, crooked trees and old graves out beyond it, a manor on a hill to the north.
  const r = rng(666);
  const hills = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + r() * 0.2;
    const d = 3800 + r() * 1800;
    const rad = 900 + r() * 800;
    hills.push(flatGeo(new THREE.SphereGeometry(rad, 14, 7, 0, TAU, 0, Math.PI / 2).scale(1, 0.35 + r() * 0.25, 1).translate(S / 2 + Math.cos(a) * d, -20, S / 2 + Math.sin(a) * d), i % 2 ? '#2c4f5e' : '#33465e'));
  }
  scene.add(new THREE.Mesh(mergeGeometries(hills), brightMaterial()));
  for (let i = 0; i < 60; i++) {
    const a = r() * TAU;
    const d = S * 0.72 + 200 + r() * 1800;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    if (x > -150 && x < S + 150 && y > -150 && y < S + 150) continue;
    if (i % 3) deadTree({ x, y, r: 14 + r() * 8, z0: -24, z1: 120 + r() * 120 }, parts, []);
    else headstone({ x0: x - 17, x1: x + 17, y0: y - 7, y1: y + 7, z0: -24, z1: 36 + r() * 16 }, parts);
  }
  // The manor: a dark house with a tower, its windows lit.
  const mx = S / 2 + 300;
  const my = -1500;
  parts.push(flatGeo(new THREE.SphereGeometry(900, 16, 8, 0, TAU, 0, Math.PI / 2).scale(1, 0.4, 0.7).translate(mx, -30, my), '#2c4f5e'));
  parts.push(box(mx - 220, my - 90, 300, mx + 220, my + 90, 470, '#4a4166', 3));
  parts.push(flatGeo(new THREE.ConeGeometry(260, 140, 4).rotateY(Math.PI / 4).scale(1, 1, 0.45).translate(mx, 540, my), '#2f2848'));
  parts.push(box(mx + 140, my - 60, 300, mx + 240, my + 40, 640, '#4a4166', 3));
  parts.push(flatGeo(new THREE.ConeGeometry(78, 150, 4).rotateY(Math.PI / 4).translate(mx + 190, 715, my - 10), '#2f2848'));
  const windows = [];
  for (let k = 0; k < 6; k++) windows.push(new THREE.BoxGeometry(24, 34, 4).translate(mx - 180 + k * 64, 380 + (k % 2) * 40, my + 92));
  windows.push(new THREE.BoxGeometry(24, 34, 4).translate(mx + 190, 560, my + 42));
  scene.add(glow(mergeGeometries(windows), WARM));
}

// Bats wheeling round the crypt's roof, wings beating.
function bats(scene, map) {
  const S = map.size;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-14, 4, 0, 0, 0, 4, 0, 0, -4, 14, 4, 0, 0, 0, -4, 0, 0, 4, -6, 1, 0, 6, 1, 0, 0, 2, 3], 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color: '#1b1730', side: THREE.DoubleSide });
  const r = rng(13);
  const list = [];
  for (let i = 0; i < 12; i++) {
    const b = new THREE.Mesh(geo, mat);
    b.userData = { ring: 300 + r() * 500, y: 230 + r() * 160, a0: r() * TAU, sp: (0.35 + r() * 0.3) * (i % 2 ? 1 : -1), ph: r() * TAU };
    scene.add(b);
    list.push(b);
  }
  return (t) => {
    for (const b of list) {
      const u = b.userData;
      const a = u.a0 + t * u.sp;
      b.position.set(S / 2 + Math.cos(a) * u.ring, u.y + Math.sin(t * 1.7 + u.ph) * 26, S / 2 + Math.sin(a) * u.ring);
      b.rotation.y = -a + (u.sp > 0 ? 0 : Math.PI);
      b.scale.set(1, 1 + Math.sin(t * 14 + u.ph) * 1.1, 1);
    }
  };
}
// Mist: soft lilac puffs lying low over the hills, drifting.
function mist(scene, map) {
  const S = map.size;
  const r = rng(77);
  const puffs = [];
  for (let i = 0; i < 18; i++) {
    const m = new THREE.SpriteMaterial({ map: tex.cloud(i % 6), transparent: true, opacity: 0.15, depthWrite: false, color: '#cdbfff' });
    const sp = new THREE.Sprite(m);
    const w = 700 + r() * 600;
    sp.scale.set(w, w * 0.18, 1);
    sp.position.set(r() * S, 30 + r() * 30, r() * S);
    sp.userData.sp = 10 + r() * 14;
    scene.add(sp);
    puffs.push(sp);
  }
  let last = null;
  return (t) => {
    const dt = last === null ? 0 : Math.min(0.1, Math.max(0, t - last));
    last = t;
    for (const p of puffs) { p.position.x += p.userData.sp * dt; if (p.position.x > S + 300) p.position.x -= S + 600; }
  };
}

// ---------- the whole dressing ----------
export function buildGraveyard(scene, map) {
  const parts = [];
  const lanterns = [];
  const glows = [];
  const tickers = [];
  for (const s of map.solids) {
    if (s.kind === 'tomb') headstone(s, parts);
    else if (s.kind === 'fence') fence(s, parts);
    else if (s.kind === 'deadtree') deadTree(s, parts, lanterns);
  }
  crypt(map, parts, glows);
  for (const d of map.deco || []) {
    if (d.kind === 'lantern') lanternPost(map, d.x, d.y, d.z, parts, lanterns);
    else if (d.kind === 'brazier') tickers.push(brazier(scene, d, parts));
  }
  surroundings(scene, map, parts, lanterns);
  scene.add(merged(parts));
  // Every lantern and window glows warm (one mesh for the lot).
  const lamp = lanterns.map(([x, y, z]) => new THREE.SphereGeometry(6, 10, 8).translate(x, z, y));
  if (lamp.length) scene.add(glow(mergeGeometries(lamp), WARM));
  if (glows.length) {
    const windows = glow(mergeGeometries(glows), '#ffb86b');
    windows.material.side = THREE.DoubleSide;
    scene.add(windows);
  }
  tickers.push(bats(scene, map), mist(scene, map));
  return {
    skip: new Set(['tomb', 'fence', 'deadtree']),
    ownWorld: true,
    mover(m) { return m.type === 'sweeper' ? scythe(scene, m) : null; },
    update(t) { for (const f of tickers) f(t); },
  };
}
