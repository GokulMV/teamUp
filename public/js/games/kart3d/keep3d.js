// The Keep's own pieces (kart-layers.js's theKeep), in the bright look (kart3d/bright3d.js): striped
// pavilion tents and trebuchets in the siege camps, the drawbridges (planks, iron bands, chains up
// to the gatehouse, warning lamps), the quintains turning in the courtyard, pennants on the towers,
// banners down the walls, the crown over the keep, a low wall round the field, and the country
// round about: meadows, round trees, hills.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brightMaterial, flatGeo, box, post, ball, strut, merged, darker, glow } from './bright3d.js';
import { rng } from './world.js';

const TAU = Math.PI * 2;
const RED = '#e5484d';
const WHITE = '#fbf7ef';
const BLUE = '#3f72d8';
const GOLD = '#f6c544';
const WOOD = '#c98c50';
const DARKWOOD = '#8f5d34';
const IRON = '#3a3f48';
const SAND = '#f2dbb2';
const LEAF = ['#4fae4a', '#5cbf55', '#43a046', '#6cc85e'];
const HERALDRY = [[BLUE, GOLD], [RED, WHITE], ['#2f9e6a', WHITE], ['#8a55d6', GOLD]];

// ---------- the siege camp ----------
// A pavilion over each tent's footprint: striped walls, a pitched roof, a pennant at each end.
function tent(s, i, parts, pennants) {
  const w = s.x1 - s.x0;
  const d = s.y1 - s.y0;
  const alongX = w >= d;
  const [a0, a1] = alongX ? [s.x0, s.x1] : [s.y0, s.y1];
  const [b0, b1] = alongX ? [s.y0, s.y1] : [s.x0, s.x1];
  const wall = 32;
  const c1 = i % 2 ? BLUE : RED;
  const c2 = WHITE;
  const n = Math.max(4, Math.round((a1 - a0) / 16));
  for (let k = 0; k < n; k++) {
    const u0 = a0 + ((a1 - a0) * k) / n;
    const u1 = a0 + ((a1 - a0) * (k + 1)) / n;
    const col = k % 2 ? c2 : c1;
    if (alongX) parts.push(box(u0, b0, s.z0, u1, b1, s.z0 + wall, col));
    else parts.push(box(b0, u0, s.z0, b1, u1, s.z0 + wall, col));
  }
  // The roof: a triangular prism along the long side, overhanging a little.
  const span = b1 - b0 + 14;
  const len = a1 - a0 + 10;
  const rise = 40;
  // (A three-sided cylinder lying along x, turned so one corner points up: apex 1 above its axis,
  // base 0.5 below, 1.732 across.)
  const prism = new THREE.CylinderGeometry(1, 1, len, 3, 1).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2);
  prism.scale(1, rise / 1.5, span / 1.732);
  const cx = (a0 + a1) / 2;
  const cb = (b0 + b1) / 2;
  const roofZ = s.z0 + wall + rise / 3;
  const g = alongX ? prism.translate(cx, roofZ, cb) : prism.rotateY(Math.PI / 2).translate(cb, roofZ, cx);
  parts.push(flatGeo(g, c1));
  for (const end of [a0, a1]) {
    const [px, py] = alongX ? [end, cb] : [cb, end];
    parts.push(post(px, py, s.z0 + wall, s.z0 + wall + rise + 34, 2, DARKWOOD, 6));
    pennants.push({ x: px, y: py, z: s.z0 + wall + rise + 30, colour: GOLD, len: 26 });
  }
}
// A trebuchet: an A-frame on a wooden base, the long arm cocked back, a counterweight box, a sling.
function trebuchet(d, parts) {
  const ca = Math.cos(d.angle);
  const sa = Math.sin(d.angle);
  // Local (u along the throw, v across) to physics.
  const P = (u, v, z) => [d.x + ca * u - sa * v, d.y + sa * u + ca * v, d.z + z];
  const beam = (a, b, r, colour) => parts.push(strut(P(...a), P(...b), r, colour));
  for (const v of [-34, 34]) {
    beam([-70, v, 8], [70, v, 8], 7, DARKWOOD);
    beam([-55, v, 8], [0, v * 0.6, 110], 6, WOOD);
    beam([55, v, 8], [0, v * 0.6, 110], 6, WOOD);
  }
  for (const u of [-60, 60]) beam([u, -34, 8], [u, 34, 8], 6, DARKWOOD);
  beam([0, -26, 110], [0, 26, 110], 5, IRON);
  // The arm, cocked back and up: long end towards the back.
  beam([-120, 0, 40], [44, 0, 140], 5.5, WOOD);
  parts.push(box(...P(36, -18, 96), ...P(60, 18, 132), DARKWOOD, 3));
  beam([-120, 0, 40], [-136, 0, 6], 1.2, IRON);
  parts.push(ball(...P(-136, 0, 6), 9, '#9a9488', 8));
  for (const [u, v] of [[-70, -34], [70, -34], [-70, 34], [70, 34]]) {
    const [wx, wy, wz] = P(u, v, 12);
    parts.push(flatGeo(new THREE.CylinderGeometry(12, 12, 6, 12).rotateX(Math.PI / 2).rotateY(-d.angle).translate(wx, wz, wy), DARKWOOD));
  }
}

// ---------- drawbridges ----------
// Planks (as boards, not painted on: the deck moves), iron bands, chains up to the gatehouse and two
// lamps beside the gate that flash while it's coming up or about to.
function drawbridge(scene, map, m) {
  const [axis, sign, h, len] = map.bridgeFrame(m);
  const w = axis ? m.x1 - m.x0 : m.y1 - m.y0;
  const outer = new THREE.Group();
  const hingeX = axis ? (m.x0 + m.x1) / 2 : h;
  const hingeY = axis ? h : (m.y0 + m.y1) / 2;
  outer.position.set(hingeX, m.z, hingeY);
  outer.rotation.y = axis ? (sign > 0 ? Math.PI : 0) : (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
  const pivot = new THREE.Group();
  outer.add(pivot);
  // Local frame: the deck reaches out along -z from the hinge at the origin; +x across it.
  const parts = [];
  const boards = Math.round(len / 20);
  for (let k = 0; k < boards; k++) {
    const z0 = -(len * k) / boards;
    const z1 = -(len * (k + 1)) / boards;
    parts.push(flatGeo(new THREE.BoxGeometry(w, m.thick, Math.abs(z1 - z0) - 1.2).translate(0, -m.thick / 2, (z0 + z1) / 2), k % 2 ? WOOD : '#d49a5c'));
  }
  for (const f of [0.12, 0.5, 0.88]) parts.push(flatGeo(new THREE.BoxGeometry(w + 2, 2, 9).translate(0, 0.6, -len * f), IRON));
  for (const sd of [-1, 1]) parts.push(flatGeo(new THREE.BoxGeometry(6, 8, len).translate(sd * (w / 2 - 3), 2, -len / 2), DARKWOOD));
  const deck = merged(parts);
  pivot.add(deck);
  scene.add(outer);
  const chainMat = new THREE.MeshBasicMaterial({ color: IRON });
  const chains = [-1, 1].map(() => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 1, 6), chainMat);
    scene.add(c);
    return c;
  });
  const lampMat = new THREE.MeshBasicMaterial({ color: '#5a1a14', toneMapped: false });
  for (const sd of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), lampMat);
    lamp.position.set(sd * (w / 2 + 14), 116 - m.z, 10);
    outer.add(lamp);
  }
  const up = new THREE.Vector3(0, 1, 0);
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const warmOff = new THREE.Color('#5a1a14');
  const warmOn = new THREE.Color('#ff3b2a');
  return {
    bridge: true,
    state(t) { const st = map.bridgeAt(m, t); return { rise: st.rise, up: !st.down, a: st.a }; },
    update(t) {
      const st = map.bridgeAt(m, t);
      pivot.rotation.x = st.a;
      const warn = st.a > 0 || st.rise < 3;
      lampMat.color.copy(warn && Math.floor(t * 4) % 2 ? warmOn : warmOff);
      chains.forEach((c, i) => {
        const sd = i ? 1 : -1;
        a3.set(sd * w * 0.4, 0, -len);
        pivot.localToWorld(a3);
        b3.set(sd * w * 0.4, 108 - m.z, 4);
        outer.localToWorld(b3);
        const dv = b3.clone().sub(a3);
        const l = dv.length();
        c.position.copy(a3).addScaledVector(dv, 0.5);
        c.scale.set(1, l, 1);
        c.quaternion.setFromUnitVectors(up, dv.normalize());
      });
    },
  };
}

// ---------- quintains ----------
// A striped post with an arm turning on top: a red shield with a gold boss on one end, a sack of
// sand on the other.
function quintain(scene, m) {
  const parts = [];
  for (let k = 0; k < 4; k++) parts.push(post(m.x, m.y, m.z + k * 14, m.z + (k + 1) * 14, m.hub * (0.95 - k * 0.04), k % 2 ? WHITE : RED, 16, m.hub * (0.95 - (k + 1) * 0.04)));
  parts.push(ball(m.x, m.y, m.z + m.hi + 30, m.hub * 0.5, GOLD, 12));
  scene.add(merged(parts));
  const spin = new THREE.Group();
  spin.position.set(m.x, m.z + (m.lo + m.hi) / 2, m.y);
  const arm = [];
  const h = m.hi - m.lo;
  arm.push(flatGeo(new THREE.BoxGeometry(m.len - m.hub + 8, h * 0.55, m.w * 1.3).translate((m.len + m.hub) / 2, 0, 0), WOOD));
  arm.push(flatGeo(new THREE.CylinderGeometry(h * 1.1, h * 1.1, 6, 20).rotateZ(Math.PI / 2).translate(m.len - 8, 0, 0), RED));
  arm.push(flatGeo(new THREE.TorusGeometry(h * 1.1, 2.2, 6, 20).rotateY(Math.PI / 2).translate(m.len - 8, 0, 0), GOLD));
  arm.push(flatGeo(new THREE.SphereGeometry(h * 0.35, 10, 8).translate(m.len - 4, 0, 0), GOLD));
  const sack = new THREE.SphereGeometry(m.w * 1.8, 12, 10).scale(1, 1.3, 1).rotateY(Math.PI).translate(-(m.len - 10), -4, 0);
  arm.push(flatGeo(new THREE.BoxGeometry(m.len - m.hub, h * 0.5, m.w * 1.2).translate(-(m.len + m.hub) / 2, 0, 0), WOOD));
  arm.push(flatGeo(sack, '#e6cf9c'));
  spin.add(merged(arm));
  scene.add(spin);
  return { update(t) { spin.rotation.y = -(m.phase + m.speed * t); } };
}

// ---------- flags, banners, the crown ----------
// Pennants: a pole and a swallow-tailed flag, waving.
function pennantGeometry(len) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, len, -len * 0.18, 0, 0, -len * 0.5, 0], 3));
  g.computeVertexNormals();
  return g;
}
function addPennants(scene, list) {
  const flags = [];
  for (const p of list) {
    const mesh = new THREE.Mesh(pennantGeometry(p.len), new THREE.MeshBasicMaterial({ color: p.colour, side: THREE.DoubleSide }));
    mesh.position.set(p.x, p.z, p.y);
    mesh.userData.ph = p.x * 0.01 + p.y * 0.013;
    scene.add(mesh);
    flags.push(mesh);
  }
  return (t) => { for (const f of flags) f.rotation.y = 0.6 + Math.sin(t * 2.2 + f.userData.ph) * 0.35; };
}
function crown(scene, d) {
  const g = new THREE.Group();
  const parts = [flatGeo(new THREE.CylinderGeometry(26, 24, 16, 24, 1, true), GOLD)];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    parts.push(flatGeo(new THREE.ConeGeometry(5, 16, 6).translate(Math.cos(a) * 25, 15, Math.sin(a) * 25), GOLD));
    parts.push(flatGeo(new THREE.SphereGeometry(3.6, 10, 8).translate(Math.cos(a) * 25, 24, Math.sin(a) * 25), [RED, BLUE, '#22c55e'][i % 3]));
  }
  const mesh = merged(parts);
  mesh.material = brightMaterial();
  g.add(mesh);
  g.position.set(d.x, d.z + 70, d.y);
  scene.add(g);
  return (t) => { g.rotation.y = t * 0.8; g.position.y = d.z + 70 + Math.sin(t * 1.6) * 6; };
}

// ---------- the country round about ----------
// Meadow out to the horizon (with a square hole where the field is), a low wall round the field,
// round trees and soft hills.
function countryside(scene, map, parts) {
  const S = map.size;
  const far = 9000;
  const P = (x, y) => new THREE.Vector2(x, -y);
  const shape = new THREE.Shape([P(-far, -far), P(S + far, -far), P(S + far, S + far), P(-far, S + far)]);
  shape.holes.push(new THREE.Path([P(0, 0), P(0, S), P(S, S), P(S, 0)]));
  const meadow = new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, -0.2, 0), '#74c45a', 1, { id: 'checker', cell: 520, color: '#6ebe54' }), brightMaterial());
  meadow.receiveShadow = true;
  scene.add(meadow);
  // The wall round the field: sandstone, a coping, round posts at intervals and the corners.
  const E = 40;
  for (const [x0, y0, x1, y1] of [[0, 0, S, E], [0, S - E, S, S], [0, E, E, S - E], [S - E, E, S, S - E]]) {
    parts.push(box(x0, y0, -2, x1, y1, 30, SAND, 3));
    parts.push(box(x0 - 2, y0 - 2, 30, x1 + 2, y1 + 2, 36, '#e3c899', 2));
  }
  for (let k = 0; k <= 16; k++) {
    const u = (S * k) / 16;
    for (const [x, y] of [[u, E / 2], [u, S - E / 2], [E / 2, u], [S - E / 2, u]]) parts.push(post(x, y, 0, 50, 13, '#e3c899', 10), ball(x, y, 54, 9, k % 4 === 0 ? RED : SAND, 8));
  }
  // Trees: a trunk and a few balls of leaves, scattered round outside.
  const r = rng(321);
  for (let i = 0; i < 170; i++) {
    const a = r() * TAU;
    const d = S * 0.72 + 150 + Math.pow(r(), 0.7) * 3200;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    if (x > -120 && x < S + 120 && y > -120 && y < S + 120) continue;
    const s = 0.8 + r() * 0.8;
    parts.push(post(x, y, 0, 46 * s, 8 * s, '#8f5d34', 6));
    const leaf = LEAF[i % LEAF.length];
    parts.push(ball(x, y, 70 * s, 34 * s, leaf, 8));
    parts.push(ball(x + 20 * s, y + 8 * s, 56 * s, 22 * s, darker(leaf, 0.92), 7));
    parts.push(ball(x - 16 * s, y - 12 * s, 58 * s, 20 * s, darker(leaf, 1.06), 7));
  }
  // Hills on the horizon.
  const hills = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * TAU + r() * 0.2;
    const d = 5200 + r() * 1800;
    const rad = 900 + r() * 900;
    hills.push(flatGeo(new THREE.SphereGeometry(rad, 16, 8, 0, TAU, 0, Math.PI / 2).scale(1, 0.32 + r() * 0.2, 1).translate(S / 2 + Math.cos(a) * d, -10, S / 2 + Math.sin(a) * d), i % 2 ? '#6cbf55' : '#5fb34e'));
  }
  const h = new THREE.Mesh(mergeGeometries(hills), brightMaterial());
  scene.add(h);
}

// ---------- the whole dressing ----------
export function buildKeep(scene, map) {
  const parts = [];
  const pennants = [];
  const tickers = [];
  map.solids.filter((s) => s.kind === 'tent').forEach((s, i) => tent(s, i, parts, pennants));
  for (const d of map.deco || []) {
    if (d.kind === 'trebuchet') trebuchet(d, parts);
    else if (d.kind === 'crown') tickers.push(crown(scene, d));
  }
  // Towers: a pole and a big pennant on each, flying out over the moat; banners down the outer
  // faces of the curtain walls either side of each gate.
  const S = map.size;
  map.solids.filter((s) => s.kind === 'tower').forEach((s, i) => {
    const out = Math.atan2(s.y - S / 2, s.x - S / 2);
    const px = s.x + Math.cos(out) * (s.r - 16);
    const py = s.y + Math.sin(out) * (s.r - 16);
    parts.push(post(px, py, s.z1, s.z1 + 120, 2.6, DARKWOOD, 8), ball(px, py, s.z1 + 122, 4.5, GOLD, 8));
    pennants.push({ x: px, y: py, z: s.z1 + 116, colour: HERALDRY[i % HERALDRY.length][0], len: 70 });
  });
  for (const s of map.solids) {
    if (s.kind !== 'wall') continue;
    const w = s.x1 - s.x0;
    const d = s.y1 - s.y0;
    const alongX = w > d;
    // The outer face: the side further from the middle.
    const outerFace = alongX ? (Math.abs(s.y0 - S / 2) > Math.abs(s.y1 - S / 2) ? s.y0 : s.y1) : (Math.abs(s.x0 - S / 2) > Math.abs(s.x1 - S / 2) ? s.x0 : s.x1);
    const n = alongX ? Math.sign(outerFace - S / 2) : Math.sign(outerFace - S / 2);
    const [a0, a1] = alongX ? [s.x0, s.x1] : [s.y0, s.y1];
    for (const f of [0.3, 0.7]) {
      const u = a0 + (a1 - a0) * f;
      const [c1, c2] = HERALDRY[Math.round(u / 400) % HERALDRY.length];
      const face = outerFace + n * 1.5;
      if (alongX) {
        parts.push(box(u - 22, face, s.z1 - 92, u + 22, face + n * 2, s.z1 - 6, c1, 1));
        parts.push(box(u - 6, face + n * 2, s.z1 - 92, u + 6, face + n * 3, s.z1 - 6, c2, 1));
      } else {
        parts.push(box(face, u - 22, s.z1 - 92, face + n * 2, u + 22, s.z1 - 6, c1, 1));
        parts.push(box(face + n * 2, u - 6, s.z1 - 92, face + n * 3, u + 6, s.z1 - 6, c2, 1));
      }
    }
  }
  countryside(scene, map, parts);
  scene.add(merged(parts));
  tickers.push(addPennants(scene, pennants));
  return {
    skip: new Set(['tent', 'trebuchet']),
    ownWorld: true,
    mover(m) {
      if (m.type === 'drawbridge') return drawbridge(scene, map, m);
      if (m.type === 'sweeper') return quintain(scene, m);
      return null;
    },
    update(t) { for (const f of tickers) f(t); },
  };
}
