// Funfair Frenzy's scenery. kart-layers.js (theFunfair) lays out the fair and the bright kit draws
// its boards, ramps, slide, rails and the helter-skelter; this adds the rides and the lights: the
// carousel (its deck and canopy turning, painted horses bobbing up and down their brass poles), the
// pirate ship swinging from its A-frame, dodgem cars, the big top's striped peaks and the circus
// cannon, logs bobbing in the flume's lagoon, striped stalls, bunting and bulbs everywhere; and out
// beyond the fence a big wheel turning against the sunset, a roller coaster and a sea of tents.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brightMaterial, flatGeo, box, post, ball, strut, merged, glow } from './bright3d.js';
import { rng } from './world.js';

const L = window.KartCore.Layers;
const TAU = Math.PI * 2;
const WHITE = '#fbfaf6';
const RED = '#e5484d';
const GOLD = '#f2c14e';
const BRASS = '#d9a441';
const CANDY = ['#ff6f91', '#ffd23f', '#3fa9f5', '#8fe388', '#b07cff', '#ff9a3c'];
const BULB = '#fff1b8';

// A disc or ring split into wedges of alternating colours (they show it turning, where a pattern
// painted in world space would stay put). y: its height (three-space, round the origin).
function wedges(r0, r1, y, n, colours, thick = 0) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const g = thick
      ? new THREE.CylinderGeometry(r1, r1, thick, 3, 1, false, (i / n) * TAU, TAU / n).translate(0, y - thick / 2, 0)
      : new THREE.RingGeometry(r0, r1, 3, 1, (i / n) * TAU, TAU / n).rotateX(-Math.PI / 2).translate(0, y, 0);
    parts.push(flatGeo(g, colours[i % colours.length]));
  }
  return parts;
}
// A cone of stripes (a canopy, a tent peak): n wedges of alternating colours.
function stripedCone(r, h, y, n, colours) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(flatGeo(new THREE.ConeGeometry(r, h, 3, 1, true, (i / n) * TAU, TAU / n).translate(0, y + h / 2, 0), colours[i % colours.length]));
  }
  return parts;
}
// A ring of bulbs (three-space round the origin).
function bulbs(r, y, n, out, size = 4) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push(new THREE.SphereGeometry(size, 6, 4).translate(Math.cos(a) * r, y, Math.sin(a) * r));
  }
}

// ---------- the carousel ----------
// A horse, built facing +x round the origin (its middle at y = 0): body, neck and head, legs
// prancing, a saddle, a mane and tail.
function horse(colour, mane) {
  const g = [];
  const e = (rx, ry, rz, x, y, z, rotZ = 0) => g.push(flatGeo(new THREE.SphereGeometry(1, 12, 8).scale(rx, ry, rz).rotateZ(rotZ).translate(x, y, z), colour));
  e(26, 13, 10, 0, 0, 0);
  e(8, 16, 7, 22, 14, -0, -0.6);
  e(13, 7, 6, 32, 26, 0, -0.35);
  for (const [x, z, a] of [[16, 6, 0.8], [16, -6, 0.5], [-16, 6, -0.6], [-16, -6, -0.9]]) {
    g.push(flatGeo(new THREE.CylinderGeometry(2.6, 2.2, 22, 6).rotateZ(a).translate(x + Math.sin(a) * 8, -16, z), colour));
  }
  g.push(flatGeo(new THREE.BoxGeometry(18, 4, 22).translate(-2, 12, 0), RED));
  g.push(flatGeo(new THREE.SphereGeometry(1, 8, 6).scale(18, 5, 3).rotateZ(-0.9).translate(18, 24, 0), mane));
  g.push(flatGeo(new THREE.SphereGeometry(1, 8, 6).scale(12, 4, 3).rotateZ(0.9).translate(-28, 2, 0), mane));
  return mergeGeometries(g);
}
function carousel(scene, map, d, lights) {
  const turn = new THREE.Group();
  turn.position.set(d.x, 0, d.y);
  // The deck: wedges of gold and cream, a painted skirt round its edge, mirrored panels.
  const deck = [...wedges(0, d.r, d.z + 0.4, 32, ['#ffe08a', '#ffd04d']), ...wedges(0, d.r, d.z, 32, [RED, WHITE], d.z + 10)];
  deck.push(...wedges(d.r - 14, d.r - 4, d.z + 0.8, 64, [WHITE, RED]));
  // The canopy: a striped cone over the deck, a scalloped valance, a gold crown on top.
  const roofY = d.top;
  deck.push(...stripedCone(d.r + 30, 110, roofY, 24, [RED, WHITE]));
  // Its ceiling, seen from the deck and from across the fair: sunburst panels round a mirror boss.
  for (let i = 0; i < 24; i++) {
    deck.push(flatGeo(new THREE.RingGeometry(d.r * 0.2, d.r + 30, 3, 1, (i / 24) * TAU, TAU / 24).rotateX(Math.PI / 2).translate(0, roofY - 0.5, 0), i % 2 ? '#ffe7a3' : '#ff9fb5'));
  }
  deck.push(flatGeo(new THREE.CircleGeometry(d.r * 0.2 + 1, 24).rotateX(Math.PI / 2).translate(0, roofY - 0.6, 0), GOLD));
  for (let i = 0; i < 24; i++) {
    const a = ((i + 0.5) / 24) * TAU;
    deck.push(flatGeo(new THREE.SphereGeometry(1, 8, 4, 0, TAU, 0, Math.PI / 2).scale(26, 20, 6).rotateX(Math.PI).rotateY(-a + Math.PI / 2).translate(Math.cos(a) * (d.r + 26), roofY + 2, Math.sin(a) * (d.r + 26)), i % 2 ? GOLD : '#3fa9f5'));
  }
  deck.push(flatGeo(new THREE.CylinderGeometry(d.r + 31, d.r + 31, 14, 48, 1, true).translate(0, roofY - 4, 0), GOLD));
  deck.push(flatGeo(new THREE.SphereGeometry(18, 12, 8).translate(0, roofY + 120, 0), GOLD), flatGeo(new THREE.ConeGeometry(6, 40, 8).translate(0, roofY + 150, 0), GOLD));
  const bulbGeo = [];
  bulbs(d.r + 30, roofY - 12, 48, bulbGeo, 4.5);
  bulbs(d.r - 9, d.z + 4, 40, bulbGeo, 3);
  // The horses' poles (they bob up and down them).
  const horses = [];
  for (let i = 0; i < d.horses; i++) {
    const a = (i / d.horses) * TAU;
    const x = Math.cos(a) * d.horseR;
    const z = Math.sin(a) * d.horseR;
    deck.push(flatGeo(new THREE.CylinderGeometry(3, 3, roofY - d.z, 8).translate(x, (roofY + d.z) / 2, z), BRASS));
    const m = new THREE.Mesh(horse(CANDY[i % CANDY.length], i % 2 ? WHITE : '#6b4a2b'), brightMaterial());
    m.castShadow = true;
    m.position.set(x, d.z + 52, z);
    m.rotation.y = -a - Math.PI / 2; // nose round the ride, the way it turns
    turn.add(m);
    horses.push(m);
  }
  turn.add(merged(deck));
  const bulbMesh = glow(mergeGeometries(bulbGeo), BULB);
  turn.add(bulbMesh);
  lights.push(bulbMesh);
  scene.add(turn);
  return (t) => {
    turn.rotation.y = -d.spin * t;
    horses.forEach((m, i) => { m.position.y = d.z + 52 + Math.sin(t * 2.2 + i * 1.7) * 18; });
  };
}

// ---------- the pirate ship ----------
// A-frame crossbar at the pivot, two arms down to a hull with a mast, a sail and a skull flag.
function ship(scene, map, m) {
  const posts = map.solids.filter((s) => s.kind === 'aframe');
  const frame = [];
  for (const sx of [-1, 1]) {
    const ps = posts.filter((s) => Math.sign(s.x - m.x) === sx);
    for (const p of ps) frame.push(strut([p.x, p.y, 0], [m.x + sx * 40, m.y, m.z + 6], 9, '#8f5d34'));
  }
  frame.push(flatGeo(new THREE.CylinderGeometry(10, 10, 110, 12).rotateZ(Math.PI / 2).translate(m.x, m.z, m.y), GOLD));
  scene.add(merged(frame));
  const g = new THREE.Group();
  g.position.set(m.x, m.z, m.y);
  const p = [];
  const hullLen = m.r * 4;
  const hull = new THREE.SphereGeometry(1, 20, 10, 0, TAU, Math.PI / 2, Math.PI / 2).scale(m.r * 1.05, m.r, hullLen / 2).translate(0, -m.len + m.r * 0.3, 0);
  p.push(flatGeo(hull, '#8f4a2b'));
  p.push(flatGeo(new THREE.BoxGeometry(m.r * 1.95, 6, hullLen * 0.98).translate(0, -m.len + m.r * 0.32, 0), '#c98c50'));
  p.push(flatGeo(new THREE.CylinderGeometry(m.r, m.r, 10, 20, 1, true).scale(1, 1, hullLen / m.r / 2).translate(0, -m.len + m.r * 0.28, 0), GOLD));
  for (const sz of [-1, 1]) p.push(strut([0, sz * hullLen * 0.32, 0], [0, sz * hullLen * 0.22, -m.len + m.r * 0.4], 6, '#5a3b22'));
  p.push(flatGeo(new THREE.CylinderGeometry(3.5, 4, 150, 8).translate(0, -m.len + m.r * 0.3 + 75, 0), '#5a3b22'));
  p.push(flatGeo(new THREE.BoxGeometry(2, 70, 90).translate(4, -m.len + m.r * 0.3 + 90, 0), WHITE));
  p.push(flatGeo(new THREE.BoxGeometry(2, 22, 34).translate(0, -m.len + m.r * 0.3 + 140, 18), '#1f2430'));
  // (three-space: the hull runs along z, the swing is along physics y = three z)
  g.add(merged(p.map((q) => q)));
  scene.add(g);
  return { update(t) { g.rotation.x = -map.pendulumAt(m, t).th; } };
}

// ---------- dodgems ----------
function dodgem(scene, b, i) {
  const g = new THREE.Group();
  const p = [];
  const col = CANDY[i % CANDY.length];
  p.push(flatGeo(new THREE.CylinderGeometry(b.r + 4, b.r + 6, 10, 20).scale(1, 1, 0.8).translate(0, 5, 0), '#1f2430'));
  p.push(flatGeo(new THREE.SphereGeometry(1, 16, 10, 0, TAU, 0, Math.PI / 2).scale(b.r, 18, b.r * 0.78).translate(0, 9, 0), col));
  p.push(flatGeo(new THREE.BoxGeometry(10, 10, 18).translate(-8, 22, 0), '#1f2430'));
  p.push(flatGeo(new THREE.CylinderGeometry(1.5, 1.5, 90, 6).translate(-14, 60, 0), '#cfd6df'));
  g.add(merged(p));
  const spark = glow(new THREE.SphereGeometry(4, 8, 6).translate(-14, 106, 0), '#9be7ff');
  g.add(spark);
  g.position.set(b.x, b.z, b.y);
  g.rotation.y = i * 1.3;
  scene.add(g);
  let flash = 0;
  return {
    hit() { flash = 1; },
    update(dt) {
      flash = Math.max(0, flash - dt * 3);
      const s = 1 + Math.sin(flash * Math.PI) * 0.16;
      g.scale.set(s, 1, s);
      spark.scale.setScalar(1 + flash * 2 + Math.random() * 0.4);
    },
  };
}
function dodgemCanopy(d, parts, bulbGeo) {
  const H = 150;
  for (const [x, y] of [[d.x0 + 14, d.y0 + 14], [d.x1 - 14, d.y0 + 14], [d.x0 + 14, d.y1 - 14], [d.x1 - 14, d.y1 - 14]]) parts.push(post(x, y, d.z, d.z + H, 6, '#cfd6df', 8));
  parts.push(box(d.x0 - 10, d.y0 - 10, d.z + H, d.x1 + 10, d.y1 + 10, d.z + H + 10, '#2b2d33', 2, { id: 'grate', cell: 30, color: '#4b5161' }));
  for (const [x0, y0, x1, y1] of [[d.x0 - 10, d.y0 - 14, d.x1 + 10, d.y0 - 10], [d.x0 - 10, d.y1 + 10, d.x1 + 10, d.y1 + 14], [d.x0 - 14, d.y0 - 10, d.x0 - 10, d.y1 + 10], [d.x1 + 10, d.y0 - 10, d.x1 + 14, d.y1 + 10]]) {
    parts.push(box(x0, y0, d.z + H - 14, x1, y1, d.z + H + 22, '#ffd23f', 1, { id: 'hazard', cell: 30, color: '#2b2d33' }));
  }
  for (let x = d.x0; x <= d.x1; x += 40) for (const y of [d.y0 - 12, d.y1 + 12]) bulbGeo.push(new THREE.SphereGeometry(4, 6, 4).translate(x, d.z + H + 4, y));
}

// ---------- the big top and the cannon ----------
function bigTop(d, parts, bulbGeo, pennants) {
  for (const sx of [-1, 1]) {
    const px = d.x + sx * 110;
    for (const g of stripedCone(220, 130, d.z - 6, 16, [RED, WHITE])) parts.push(g.translate(px, 0, d.y));
    parts.push(flatGeo(new THREE.SphereGeometry(10, 10, 6).translate(px, d.z + 130, d.y), GOLD));
    pennants.push({ x: px, y: d.y, z: d.z + 170, colour: sx > 0 ? '#3fa9f5' : '#ffd23f' });
  }
  // A scalloped valance round the roof's edge, and bulbs along it.
  const hw = d.w / 2;
  const hd = d.d / 2;
  for (let x = d.x - hw; x < d.x + hw; x += 50) {
    for (const [y, sy] of [[d.y - hd, -1], [d.y + hd, 1]]) {
      parts.push(flatGeo(new THREE.SphereGeometry(1, 8, 4, 0, TAU, Math.PI / 2, Math.PI / 2).scale(25, 22, 4).translate(x + 25, d.z - 16, y + sy * 2), Math.round(x / 50) % 2 ? RED : GOLD));
      bulbGeo.push(new THREE.SphereGeometry(4, 6, 4).translate(x + 25, d.z - 2, y + sy * 4));
    }
  }
  // The sign over the front.
  parts.push(box(d.x - 150, d.y - hd - 8, d.z + 10, d.x + 150, d.y - hd - 2, d.z + 60, '#3f2a7a', 4));
  parts.push(box(d.x - 140, d.y - hd - 10, d.z + 18, d.x + 140, d.y - hd - 7, d.z + 52, GOLD, 2, { id: 'tiles', cell: 18, color: '#ffe27a' }));
}
function cannon(d, parts) {
  const c = Math.cos(d.aim);
  const s = Math.sin(d.aim);
  parts.push(strut([d.x - c * 30, d.y - s * 30, 40], [d.x + c * 46, d.y + s * 46, 96], 20, '#3b4252'));
  parts.push(flatGeo(new THREE.TorusGeometry(21, 5, 8, 16).rotateX(Math.PI / 2).translate(d.x + c * 46, 96, d.y + s * 46), GOLD));
  for (const side of [-1, 1]) {
    const wx = d.x - s * side * 34;
    const wy = d.y + c * side * 34;
    parts.push(flatGeo(new THREE.CylinderGeometry(30, 30, 10, 16).rotateZ(Math.PI / 2).rotateY(-d.aim).translate(wx, 30, wy), RED));
  }
}

// ---------- the flume's lagoon, stalls ----------
function lagoon(scene, d, parts) {
  const r = rng(12);
  const logs = [];
  for (let k = 0; k < 6; k++) {
    const x = d.x0 + 80 + r() * (d.x1 - d.x0 - 160);
    const y = d.y0 + 80 + r() * (d.y1 - d.y0 - 160);
    const m = merged([flatGeo(new THREE.CylinderGeometry(22, 22, 110, 12).rotateZ(Math.PI / 2), '#8f5d34'),
      flatGeo(new THREE.CylinderGeometry(19, 19, 112, 12).rotateZ(Math.PI / 2).scale(1, 0.4, 0.8).translate(0, 14, 0), '#5a3b22')]);
    m.position.set(x, d.z, y);
    m.rotation.y = r() * TAU;
    scene.add(m);
    logs.push(m);
  }
  // The flume's chute coming down out of the corner into the lagoon.
  parts.push(strut([d.x1 + 260, d.y1 + 260, 360], [d.x1 - 60, d.y1 - 60, -10], 40, '#3fa9f5'));
  parts.push(post(d.x1 + 280, d.y1 + 280, -10, 380, 60, '#c98c50', 10));
  return (t) => logs.forEach((m, i) => { m.position.y = d.z + 2 + Math.sin(t * 1.4 + i) * 3; m.rotation.y += 0.002 * (i % 2 ? 1 : -1); });
}
function stall(d, parts, bulbGeo) {
  const awning = CANDY[d.style % CANDY.length];
  const n = Math.round(Math.max(d.w, d.d) / 30);
  const alongX = d.w >= d.d;
  for (let i = 0; i < n; i++) {
    const u0 = i / n;
    const u1 = (i + 1) / n;
    const [x0, x1, y0, y1] = alongX ? [d.x - d.w / 2 + d.w * u0, d.x - d.w / 2 + d.w * u1, d.y - d.d / 2 - 14, d.y + d.d / 2 + 14]
      : [d.x - d.w / 2 - 14, d.x + d.w / 2 + 14, d.y - d.d / 2 + d.d * u0, d.y - d.d / 2 + d.d * u1];
    parts.push(box(x0, y0, d.z, x1, y1, d.z + 10, i % 2 ? WHITE : awning, 1));
  }
  // Prizes on the counter: teddies in a row (a ball and ears).
  for (let i = 0; i < 5; i++) {
    const u = (i + 0.5) / 5 - 0.5;
    const x = alongX ? d.x + u * d.w * 0.8 : d.x;
    const y = alongX ? d.y : d.y + u * d.d * 0.8;
    parts.push(ball(x, y, d.z + 26, 14, CANDY[(i + d.style) % CANDY.length], 10), ball(x - 9, y, d.z + 40, 5, CANDY[(i + d.style) % CANDY.length], 6), ball(x + 9, y, d.z + 40, 5, CANDY[(i + d.style) % CANDY.length], 6));
  }
  for (let i = 0; i <= n; i++) {
    const u = i / n - 0.5;
    bulbGeo.push(new THREE.SphereGeometry(3.5, 6, 4).translate(alongX ? d.x + u * d.w : d.x - d.w / 2 - 14, d.z + 2, alongX ? d.y - d.d / 2 - 14 : d.y + u * d.d));
  }
}

// ---------- round the fair ----------
// Bunting: strings of little flags between poles round the fence.
function bunting(map, parts) {
  const S = map.size;
  const E = L.EDGE;
  const H = 120;
  const corners = [[E / 2, E / 2], [S - E / 2, E / 2], [S - E / 2, S - E / 2], [E / 2, S - E / 2]];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k];
    const [bx, by] = corners[(k + 1) % 4];
    const spans = 6;
    for (let j = 0; j < spans; j++) {
      const p0 = [ax + (bx - ax) * (j / spans), ay + (by - ay) * (j / spans)];
      const p1 = [ax + (bx - ax) * ((j + 1) / spans), ay + (by - ay) * ((j + 1) / spans)];
      parts.push(post(p0[0], p0[1], -10, H + 10, 4, WHITE, 6));
      for (let f = 0; f < 10; f++) {
        const u = (f + 0.5) / 10;
        const sag = Math.sin(u * Math.PI) * 26;
        const x = p0[0] + (p1[0] - p0[0]) * u;
        const y = p0[1] + (p1[1] - p0[1]) * u;
        const g = new THREE.ConeGeometry(7, 18, 3).rotateX(Math.PI).translate(x, H - sag - 9, y);
        parts.push(flatGeo(g, CANDY[(f + j) % CANDY.length]));
      }
    }
  }
  // The fence: white pickets with a red top rail, all the way round.
  for (const [x0, y0, x1, y1] of [[0, 0, S, E], [0, S - E, S, S], [0, E, E, S - E], [S - E, E, S, S - E]]) {
    parts.push(box(x0, y0, -10, x1, y1, 34, WHITE, 3, { id: 'ribs', cell: 14, color: '#d9d4c7' }), box(x0 + 3, y0 + 3, 32, x1 - 3, y1 - 3, 40, RED, 2));
  }
}
// The big wheel: a ring of gondolas turning on its axle, lit all round.
function bigWheel(scene, x, y, R, lights) {
  const stand = [];
  for (const sz of [-1, 1]) {
    stand.push(strut([x - R * 0.55, y + sz * 70, -10], [x, y + sz * 40, R + 40], 16, '#cfd6df'));
    stand.push(strut([x + R * 0.55, y + sz * 70, -10], [x, y + sz * 40, R + 40], 16, '#cfd6df'));
  }
  scene.add(merged(stand));
  const wheel = new THREE.Group();
  wheel.position.set(x, R + 40, y);
  const p = [];
  for (const sz of [-1, 1]) {
    p.push(flatGeo(new THREE.TorusGeometry(R, 8, 8, 64).translate(0, 0, sz * 36), WHITE));
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      p.push(flatGeo(new THREE.CylinderGeometry(3, 3, R, 4).translate(0, R / 2, 0).rotateZ(a).translate(0, 0, sz * 36), WHITE));
    }
  }
  p.push(flatGeo(new THREE.CylinderGeometry(20, 20, 110, 16).rotateX(Math.PI / 2), GOLD));
  wheel.add(merged(p));
  const lit = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * TAU;
    for (const sz of [-1, 1]) lit.push(new THREE.SphereGeometry(6, 6, 4).translate(Math.cos(a) * R, Math.sin(a) * R, sz * 44));
  }
  const ring = glow(mergeGeometries(lit), BULB);
  wheel.add(ring);
  lights.push(ring);
  const cars = [];
  for (let i = 0; i < 16; i++) {
    const c = merged([flatGeo(new THREE.CylinderGeometry(26, 22, 34, 12).translate(0, -24, 0), CANDY[i % CANDY.length]), flatGeo(new THREE.ConeGeometry(28, 14, 12).translate(0, 0, 0), WHITE)]);
    scene.add(c);
    cars.push(c);
  }
  scene.add(wheel);
  return (t) => {
    const a0 = t * 0.12;
    wheel.rotation.z = a0;
    cars.forEach((c, i) => {
      const a = a0 + (i / 16) * TAU;
      c.position.set(x + Math.cos(a) * R, R + 40 + Math.sin(a) * R - 6, y);
    });
  };
}
// A roller coaster: a looping track on stilts out past the far side.
function coaster(x0, y0, len, parts) {
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    pts.push([x0 + u * len, y0 + Math.sin(u * TAU * 1.5) * 260, 260 + Math.sin(u * TAU * 3) * 160 + (u < 0.15 ? (0.15 - u) * 2200 : 0)]);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (const off of [-14, 14]) parts.push(strut([pts[i][0], pts[i][1] + off, pts[i][2]], [pts[i + 1][0], pts[i + 1][1] + off, pts[i + 1][2]], 4, RED));
    if (i % 3 === 0) parts.push(strut([pts[i][0], pts[i][1], -10], [pts[i][0], pts[i][1], pts[i][2]], 6, WHITE));
  }
}
function outskirts(scene, map, parts, lights) {
  const S = map.size;
  const far = 12000;
  const P = (x, y) => new THREE.Vector2(x, -y);
  const shape = new THREE.Shape([P(-far, -far), P(S + far, -far), P(S + far, S + far), P(-far, S + far)]);
  shape.holes.push(new THREE.Path([P(0, 0), P(0, S), P(S, S), P(S, 0)]));
  const ground = new THREE.Mesh(flatGeo(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, -0.3, 0), '#5aa04a', 1, { id: 'checker', cell: 700, color: '#529646' }), brightMaterial());
  ground.receiveShadow = true;
  scene.add(ground);
  // Tents and trailers round the field.
  const r = rng(41);
  for (let k = 0; k < 26; k++) {
    let x;
    let y;
    do { x = -2200 + r() * (S + 4400); y = -2200 + r() * (S + 4400); } while (x > -500 && x < S + 500 && y > -500 && y < S + 500);
    const rr = 160 + r() * 140;
    for (const g of stripedCone(rr, rr * 1.1, rr * 0.55, 12, [CANDY[k % CANDY.length], WHITE])) parts.push(g.translate(x, 0, y));
    parts.push(post(x, y, -10, rr * 0.56, rr, k % 2 ? WHITE : '#ffe6c4', 12));
  }
  coaster(-1800, -1400, S + 3600, parts);
  return bigWheel(scene, S + 1500, S * 0.3, 900, lights);
}

// ---------- the whole dressing ----------
export function buildFunfair(scene, map) {
  const parts = [];
  const bulbGeo = [];
  const lights = [];
  const pennants = [];
  const tickers = [];
  for (const d of map.deco || []) {
    if (d.kind === 'carousel') tickers.push(carousel(scene, map, d, lights));
    else if (d.kind === 'dodgems') dodgemCanopy(d, parts, bulbGeo);
    else if (d.kind === 'bigtop') bigTop(d, parts, bulbGeo, pennants);
    else if (d.kind === 'cannon') cannon(d, parts);
    else if (d.kind === 'flume') tickers.push(lagoon(scene, d, parts));
    else if (d.kind === 'stall') stall(d, parts, bulbGeo);
    else if (d.kind === 'helter') {
      parts.push(post(d.x, d.y, d.z, d.z + 140, 3, WHITE, 6));
      pennants.push({ x: d.x, y: d.y, z: d.z + 136, colour: RED });
      bulbs(d.r + 2, d.z - 6, 40, bulbGeo, 3.5);
      for (const g of bulbGeo.splice(-40)) bulbGeo.push(g.translate(d.x, 0, d.y));
    }
  }
  bunting(map, parts);
  tickers.push(outskirts(scene, map, parts, lights));
  scene.add(merged(parts));
  if (bulbGeo.length) {
    const b = glow(mergeGeometries(bulbGeo), BULB);
    scene.add(b);
    lights.push(b);
  }
  const flagGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 9, 0), new THREE.Vector3(0, -9, 0), new THREE.Vector3(56, 0, 0)]);
  const flags = pennants.map((p) => {
    const m = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: p.colour, side: THREE.DoubleSide }));
    m.position.set(p.x + 2, p.z, p.y);
    scene.add(m);
    return m;
  });
  let n = 0;
  return {
    // Drawn here instead of by the bright kit: the turning deck.
    skip: new Set(['carousel']),
    ownWorld: true,
    mover(m) {
      if (m.type === 'pendulum' && m.kind === 'ship') return ship(scene, map, m);
      if (m.type === 'sweeper' && m.kind === 'horses') return { update() {} }; // (the carousel draws them)
      return null;
    },
    bumper(b) { return b.style === 'dodgem' ? dodgem(scene, b, n++) : null; },
    update(t) {
      for (const f of tickers) f(t);
      flags.forEach((m, i) => { m.rotation.y = 0.5 + Math.sin(t * 1.3 + i * 1.7) * 0.4; });
      // The bulbs chase: a slow shimmer in brightness.
      lights.forEach((m, i) => m.material.color.setHSL(0.13, 1, 0.78 + Math.sin(t * 3 + i) * 0.08));
    },
  };
}
