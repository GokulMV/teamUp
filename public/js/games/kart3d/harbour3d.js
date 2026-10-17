// Harbour Havoc's own pieces (kart-layers.js's theHarbour), in the bright look (kart3d/bright3d.js):
// doors and corner castings on every container, the gantry crane and the container swinging under
// it, forklifts working the alleys, steel bascule bridges with counterweights and warning lamps,
// lamp posts, a striped lighthouse with a turning beam, a cargo ship moored off the east side and
// gulls wheeling over the water.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { brightMaterial, flatGeo, styleOf } from './bright3d.js';

const TAU = Math.PI * 2;
const DARK = '#2b2d33';
const STEEL = '#3a3f48';
const YELLOW = '#ffcf33';
const WHITE = '#f4f6fb';

// ---------- geometry helpers (physics space: x, y on the ground, z up) ----------
function box(ax, ay, az, bx, by, bz, colour, r = 0, pattern = null) {
  const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)];
  const [y0, y1] = [Math.min(ay, by), Math.max(ay, by)];
  const [z0, z1] = [Math.min(az, bz), Math.max(az, bz)];
  const w = x1 - x0;
  const d = y1 - y0;
  const h = z1 - z0;
  const rr = Math.min(r, w / 2 - 0.1, d / 2 - 0.1, h / 2 - 0.1);
  const g = rr > 0.5 ? new RoundedBoxGeometry(w, h, d, 1, rr) : new THREE.BoxGeometry(w, h, d);
  g.translate((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2);
  return flatGeo(g, colour, 1, pattern);
}
function post(x, y, z0, z1, r, colour, n = 10, r1 = r) {
  return flatGeo(new THREE.CylinderGeometry(r1, r, z1 - z0, n).translate(x, (z0 + z1) / 2, y), colour);
}
function ball(x, y, z, r, colour, n = 10) {
  return flatGeo(new THREE.SphereGeometry(r, n, Math.max(6, n - 2)).translate(x, z, y), colour);
}
const _up = new THREE.Vector3(0, 1, 0);
function strut(a, b, r, colour) {
  const A = new THREE.Vector3(a[0], a[2], a[1]);
  const B = new THREE.Vector3(b[0], b[2], b[1]);
  const d = B.clone().sub(A);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 6);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.clone().normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return flatGeo(g, colour);
}
function merged(parts, cast = true) {
  const m = new THREE.Mesh(mergeGeometries(parts), brightMaterial());
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
const darker = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
// Something that glows (lamps, beacons): unlit, so it reads at dusk; `on` dims it.
function glow(geo, hex) {
  const mat = new THREE.MeshBasicMaterial({ color: hex, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.base = new THREE.Color(hex);
  return mesh;
}

// ---------- containers ----------
// Doors on both ends (a frame, two leaves, four locking bars), corner castings on top, a white
// shipping-line plate on one side.
function containerDetails(map) {
  const parts = [];
  for (const s of map.solids) {
    if (!s.kind || !s.kind.startsWith('ctr-')) continue;
    const st = styleOf(map, s.kind);
    const frame = darker(st.top, 0.7);
    const alongX = s.x1 - s.x0 >= s.y1 - s.y0;
    const z0 = s.z0 + 4;
    const z1 = s.z1 - 4;
    for (const end of [-1, 1]) {
      if (alongX) {
        const x = end > 0 ? s.x1 : s.x0;
        parts.push(box(x, s.y0 + 5, z0, x + end * 1.6, s.y1 - 5, z1, frame));
        for (const f of [0.2, 0.4, 0.6, 0.8]) parts.push(post(x + end * 2.6, s.y0 + (s.y1 - s.y0) * f, z0 + 4, z1 - 4, 1.4, STEEL, 6));
        parts.push(box(x + end * 1.7, (s.y0 + s.y1) / 2 - 0.8, z0, x + end * 2.2, (s.y0 + s.y1) / 2 + 0.8, z1, DARK));
      } else {
        const y = end > 0 ? s.y1 : s.y0;
        parts.push(box(s.x0 + 5, y, z0, s.x1 - 5, y + end * 1.6, z1, frame));
        for (const f of [0.2, 0.4, 0.6, 0.8]) parts.push(post(s.x0 + (s.x1 - s.x0) * f, y + end * 2.6, z0 + 4, z1 - 4, 1.4, STEEL, 6));
        parts.push(box((s.x0 + s.x1) / 2 - 0.8, y + end * 1.7, z0, (s.x0 + s.x1) / 2 + 0.8, y + end * 2.2, z1, DARK));
      }
    }
    for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y0], [s.x0, s.y1], [s.x1, s.y1]]) {
      const ix = x === s.x0 ? 1 : -1;
      const iy = y === s.y0 ? 1 : -1;
      parts.push(box(x + ix * 0.5, y + iy * 0.5, s.z1 - 5, x + ix * 8, y + iy * 8, s.z1 + 0.8, STEEL));
    }
    // A white plate near one end of a long side.
    if (alongX) parts.push(box(s.x0 + 30, s.y1, s.z1 - 26, s.x0 + 70, s.y1 + 1, s.z1 - 12, WHITE));
    else parts.push(box(s.x1, s.y0 + 30, s.z1 - 26, s.x1 + 1, s.y0 + 70, s.z1 - 12, WHITE));
  }
  return parts;
}

// ---------- the gantry crane ----------
function crane(d, lamps) {
  const parts = [];
  const { x0, x1, y0, y1, top } = d;
  // Portal beams across the pier over each pair of legs, and the girders between them.
  for (const y of [y0, y1]) parts.push(box(x0 - 46, y - 24, top - 36, x1 + 46, y + 24, top, YELLOW, 5, { id: 'hazard', cell: 40, color: DARK }));
  for (const x of [d.x - 64, d.x + 64]) parts.push(box(x - 13, y0 - 24, top, x + 13, y1 + 24, top + 26, YELLOW, 4));
  // Cross bracing between each side's legs.
  for (const x of [x0, x1]) {
    parts.push(strut([x, y0, 40], [x, y1, top - 46], 5, DARK));
    parts.push(strut([x, y1, 40], [x, y0, top - 46], 5, DARK));
  }
  // The trolley on the girders, the operator's cab under one side, a ladder up a leg.
  parts.push(box(d.x - 92, d.y - 72, top - 14, d.x + 92, d.y + 72, top + 44, '#f59e0b', 6));
  parts.push(box(d.x + 34, d.y - 128, top - 76, d.x + 104, d.y - 62, top - 14, WHITE, 7));
  parts.push(box(d.x + 36, d.y - 130, top - 66, d.x + 102, d.y - 120, top - 34, '#3aa0ff'));
  for (let z = 30; z < top - 40; z += 18) parts.push(box(x0 + 26, y0 - 9, z, x0 + 30, y0 + 9, z + 3, DARK));
  // The hook block hangs from the trolley on four cables, at the swing's pivot.
  for (const [dx, dy] of [[-34, -22], [34, -22], [-34, 22], [34, 22]]) parts.push(strut([d.x + dx, d.y + dy, top - 14], [d.x + dx * 0.4, d.y + dy * 0.4, d.pivot + 12], 1.3, DARK));
  parts.push(box(d.x - 28, d.y - 17, d.pivot - 6, d.x + 28, d.y + 17, d.pivot + 12, STEEL, 3));
  parts.push(box(d.x - 30, d.y - 4, d.pivot - 8, d.x + 30, d.y + 4, d.pivot - 4, YELLOW));
  // Aircraft-warning lamps on the beam ends.
  for (const x of [x0 - 40, x1 + 40]) for (const y of [y0, y1]) {
    const lamp = glow(new THREE.SphereGeometry(6, 10, 8), '#ff3b30');
    lamp.position.set(x, top + 8, y);
    lamps.push(lamp);
  }
  return parts;
}

// The container swinging under the crane: one pendulum's swing (the middle of its row), with the
// container and its cables hanging from the pivot.
function swingingLoad(scene, map, group) {
  const m = group[Math.floor(group.length / 2)];
  const cx = group.reduce((a, g) => a + g.x, 0) / group.length;
  const length = group[group.length - 1].x - group[0].x + 2 * m.r + 14;
  const H = 2 * m.r - 2;
  const D = 2 * m.r + 2;
  const swing = new THREE.Group();
  swing.position.set(cx, m.z, m.y);
  scene.add(swing);
  const parts = [];
  // In the swing's own frame: the pivot at the origin, the container's middle len below it.
  const cz = -m.len;
  const red = '#e5484d';
  const body = new RoundedBoxGeometry(length, H, D, 1, 3).translate(0, cz, 0);
  parts.push(flatGeo(body, red, 1, { id: 'ribs', cell: 12, color: '#a8333a' }));
  // Doors on both ends, with their locking bars.
  for (const end of [-1, 1]) {
    const x = end * (length / 2);
    const door = new THREE.BoxGeometry(1.8, H - 8, D - 8).translate(x + end * 0.9, cz, 0);
    parts.push(flatGeo(door, '#a8333a'));
    for (const f of [-0.3, -0.1, 0.1, 0.3]) parts.push(flatGeo(new THREE.CylinderGeometry(1.4, 1.4, H - 16, 6).translate(x + end * 2.4, cz, f * D), STEEL));
  }
  // A spreader frame on top, and the four cables up to the pivot.
  parts.push(flatGeo(new THREE.BoxGeometry(length * 0.86, 5, D * 0.7).translate(0, cz + H / 2 + 4, 0), YELLOW));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const a = new THREE.Vector3(sx * length * 0.4, cz + H / 2 + 6, sz * D * 0.32);
    const b = new THREE.Vector3(sx * 10, 0, sz * 6);
    const dir = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(1.3, 1.3, dir.length(), 5);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    parts.push(flatGeo(g, DARK));
  }
  swing.add(merged(parts));
  return {
    update(t) {
      const b = map.pendulumAt(m, t);
      swing.rotation.x = -b.th;
    },
  };
}

// ---------- forklifts ----------
// A forklift carrying a pallet of crates, filling its slider's footprint, forks towards +y.
function forklift(scene, map, m) {
  const g = new THREE.Group();
  const w = m.x1 - m.x0;
  const d = m.y1 - m.y0;
  const hx = w / 2;
  const hy = d / 2;
  const parts = [];
  parts.push(box(-hx * 0.86, -hy * 0.92, 7, hx * 0.86, hy * 0.2, 30, '#ffb400', 7)); // body
  parts.push(box(-hx * 0.8, -hy, 7, hx * 0.8, -hy * 0.62, 34, STEEL, 6)); // counterweight
  for (const sx of [-1, 1]) for (const y of [-hy * 0.62, hy * 0.05]) {
    parts.push(flatGeo(new THREE.CylinderGeometry(9, 9, 9, 14).rotateZ(Math.PI / 2).translate(sx * hx * 0.84, 9, y), '#1f2127'));
    parts.push(flatGeo(new THREE.CylinderGeometry(4, 4, 9.6, 10).rotateZ(Math.PI / 2).translate(sx * hx * 0.84, 9, y), '#c9ced8'));
  }
  // The driver's seat and the overhead guard.
  parts.push(box(-hx * 0.3, -hy * 0.55, 30, hx * 0.3, -hy * 0.2, 40, DARK, 3));
  for (const sx of [-1, 1]) for (const y of [-hy * 0.6, hy * 0.12]) parts.push(post(sx * hx * 0.62, y, 30, 64, 1.8, DARK, 6));
  parts.push(box(-hx * 0.68, -hy * 0.66, 62, hx * 0.68, hy * 0.18, 66, DARK, 1));
  // The mast, the forks and a pallet of crates on them.
  for (const sx of [-1, 1]) parts.push(box(sx * hx * 0.5 - 3, hy * 0.2, 6, sx * hx * 0.5 + 3, hy * 0.3, 74, STEEL));
  parts.push(box(-hx * 0.55, hy * 0.2, 66, hx * 0.55, hy * 0.3, 72, STEEL));
  for (const sx of [-1, 1]) parts.push(box(sx * hx * 0.3 - 3, hy * 0.3, 10, sx * hx * 0.3 + 3, hy * 0.98, 13, STEEL));
  parts.push(box(-hx * 0.7, hy * 0.32, 13, hx * 0.7, hy * 0.98, 19, '#c98e57', 1));
  parts.push(box(-hx * 0.62, hy * 0.36, 19, -hx * 0.02, hy * 0.94, 42, '#3fae5a', 3));
  parts.push(box(hx * 0.04, hy * 0.36, 19, hx * 0.64, hy * 0.94, 36, '#2f6fd6', 3));
  parts.push(box(-hx * 0.3, hy * 0.42, 42, hx * 0.28, hy * 0.88, 58, '#f28a2e', 3));
  g.add(merged(parts));
  const beacon = glow(new THREE.SphereGeometry(4.5, 10, 8), '#ff9f1a');
  beacon.position.set(0, 70, -hy * 0.3);
  g.add(beacon);
  const cx = (m.x0 + m.x1) / 2;
  const cy = (m.y0 + m.y1) / 2;
  g.position.set(cx, m.z0, cy);
  scene.add(g);
  return {
    update(t) {
      const { u } = map.sliderAt(m, t);
      g.position.set(cx + m.dx * u, m.z0, cy + m.dy * u);
      beacon.material.color.copy(beacon.userData.base).multiplyScalar(Math.floor(t * 3) % 2 ? 1 : 0.25);
    },
  };
}

// ---------- bascule bridges ----------
// A steel leaf on its hinge: a grated deck with hazard stripes at its tip, girders underneath, a
// counterweight below the hinge (it swings down as the leaf rises), and lamps on posts either side
// of the hinge that flash before it rises and while it is up.
function bascule(scene, map, m) {
  const [axis, sign, h, len] = map.bridgeFrame(m);
  const w = axis ? m.x1 - m.x0 : m.y1 - m.y0;
  const outer = new THREE.Group();
  const hingeX = axis ? (m.x0 + m.x1) / 2 : h;
  const hingeY = axis ? h : (m.y0 + m.y1) / 2;
  outer.position.set(hingeX, m.z, hingeY);
  outer.rotation.y = axis ? (sign > 0 ? Math.PI : 0) : (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
  const pivot = new THREE.Group();
  outer.add(pivot);
  // In the leaf's frame (three): x across it, -z out from the hinge, y up; the deck's top at 0.
  const parts = [];
  const deck = new THREE.BoxGeometry(w - 2, m.thick, len).translate(0, -m.thick / 2, -len / 2);
  parts.push(flatGeo(deck, '#4f86c6', 1, { id: 'grate', cell: 14, color: '#2f5f99' }));
  const tip = new THREE.BoxGeometry(w - 2, 1, 22).translate(0, 0.6, -len + 12);
  parts.push(flatGeo(tip, YELLOW, 1, { id: 'hazard', cell: 30, color: DARK }));
  for (const sx of [-1, 1]) {
    parts.push(flatGeo(new THREE.BoxGeometry(10, 22, len).translate(sx * (w / 2 - 8), -m.thick - 11, -len / 2), STEEL));
  }
  // The counterweight, under and behind the hinge.
  parts.push(flatGeo(new RoundedBoxGeometry(w * 0.8, 46, 44, 1, 4).translate(0, -m.thick - 40, 26), '#4b5260'));
  const leaf = merged(parts);
  pivot.add(leaf);
  // Lamps on posts either side of the hinge, on the pier.
  const lamps = [];
  const fixed = [];
  for (const sx of [-1, 1]) {
    fixed.push(flatGeo(new THREE.CylinderGeometry(3, 3.6, 58, 8).translate(sx * (w / 2 + 16), 29, 14), DARK));
    const lamp = glow(new THREE.SphereGeometry(6.5, 12, 8), '#ff3b30');
    lamp.position.set(sx * (w / 2 + 16), 62, 14);
    outer.add(lamp);
    lamps.push(lamp);
  }
  outer.add(merged(fixed));
  scene.add(outer);
  const state = (t) => { const st = map.bridgeAt(m, t); return { rise: st.rise, up: !st.down, a: st.a }; };
  return {
    bridge: true,
    state,
    update(t) {
      const st = map.bridgeAt(m, t);
      pivot.rotation.x = st.a;
      const warn = st.a > 0 || st.rise < 3;
      const k = warn ? (Math.floor(t * 4) % 2 ? 1 : 0.25) : 0.12;
      for (const l of lamps) l.material.color.copy(l.userData.base).multiplyScalar(k);
    },
  };
}

// ---------- scenery ----------
function lampPost(x, y, z, lights) {
  const parts = [post(x, y, z, z + 120, 2.6, STEEL, 8, 2), box(x - 2, y - 2, z + 116, x + 30, y + 2, z + 120, STEEL)];
  parts.push(box(x + 20, y - 7, z + 108, x + 38, y + 7, z + 116, DARK, 2));
  const bulb = glow(new THREE.SphereGeometry(5.5, 10, 8).scale(1.5, 0.6, 1.2), '#ffd88a');
  bulb.position.set(x + 29, z + 106, y);
  lights.push(bulb);
  return parts;
}

// A rocky islet with a striped lighthouse; its lantern's beam sweeps round.
function lighthouse(scene, d) {
  const parts = [];
  const z = d.z;
  // The rock: lumpy low-poly boulders.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU;
    const r = 70 + (i % 3) * 22;
    const g = new THREE.IcosahedronGeometry(60 + (i % 4) * 14, 0).scale(1.2, 0.7, 1.1).translate(d.x + Math.cos(a) * r, z + 12, d.y + Math.sin(a) * r);
    parts.push(flatGeo(g, i % 2 ? '#8d8a94' : '#a19eaa'));
  }
  parts.push(flatGeo(new THREE.CylinderGeometry(120, 150, 50, 12).translate(d.x, z + 20, d.y), '#9d99a6'));
  // The tower: white with red bands, tapering, a gallery and the lantern room.
  const H = 420;
  for (let k = 0; k < 6; k++) {
    const z0 = z + 45 + (k * H) / 6;
    const z1 = z0 + H / 6;
    const r0 = 52 - (k / 6) * 16;
    const r1 = 52 - ((k + 1) / 6) * 16;
    parts.push(flatGeo(new THREE.CylinderGeometry(r1, r0, z1 - z0, 20).translate(d.x, (z0 + z1) / 2, d.y), k % 2 ? '#e5484d' : WHITE));
  }
  const top = z + 45 + H;
  parts.push(flatGeo(new THREE.CylinderGeometry(50, 44, 10, 20).translate(d.x, top + 5, d.y), DARK));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    parts.push(post(d.x + Math.cos(a) * 46, d.y + Math.sin(a) * 46, top + 10, top + 34, 1.5, DARK, 5));
  }
  parts.push(flatGeo(new THREE.CylinderGeometry(30, 34, 8, 16).translate(d.x, top + 54, d.y), DARK));
  parts.push(flatGeo(new THREE.ConeGeometry(36, 34, 16).translate(d.x, top + 74, d.y), '#e5484d'));
  scene.add(merged(parts));
  const lamp = glow(new THREE.CylinderGeometry(24, 24, 40, 16), '#fff1b8');
  lamp.position.set(d.x, top + 32, d.y);
  scene.add(lamp);
  // The beam: two long soft cones turning.
  const beamMat = new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Group();
  for (const s of [1, -1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(120, 1600, 16, 1, true).rotateZ((s * Math.PI) / 2).translate(s * 800, 0, 0), beamMat);
    beam.add(cone);
  }
  beam.position.set(d.x, top + 32, d.y);
  scene.add(beam);
  return (t) => { beam.rotation.y = t * 0.6; };
}

// A cargo ship along the east side: hull, red boot-topping, a white bridge house and funnel at the
// stern, containers stacked on deck.
function ship(scene, d) {
  const parts = [];
  const L = d.len;
  const B = 280;
  const z = d.z;
  // In the ship's frame: x along it (bow at +x), y across. Built then turned onto its heading.
  const hull = new THREE.Shape();
  hull.moveTo(-L / 2, -B / 2);
  hull.lineTo(L / 2 - 220, -B / 2);
  hull.quadraticCurveTo(L / 2, -B * 0.3, L / 2 + 30, 0);
  hull.quadraticCurveTo(L / 2, B * 0.3, L / 2 - 220, B / 2);
  hull.lineTo(-L / 2, B / 2);
  hull.quadraticCurveTo(-L / 2 - 50, 0, -L / 2, -B / 2);
  const ext = (shape, z0, z1, colour) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2).translate(0, z0, 0);
    return flatGeo(g, colour);
  };
  parts.push(ext(hull, z - 60, z + 14, '#d93f3f'));
  parts.push(ext(hull, z + 14, z + 150, '#22365c'));
  parts.push(ext(hull, z + 150, z + 156, WHITE));
  // The bridge house and funnel near the stern.
  parts.push(flatGeo(new RoundedBoxGeometry(150, 160, B - 30, 1, 6).translate(-L / 2 + 150, z + 236, 0), WHITE));
  parts.push(flatGeo(new THREE.BoxGeometry(150.5, 20, B - 40).translate(-L / 2 + 150, z + 270, 0), '#2d6fd6'));
  parts.push(flatGeo(new RoundedBoxGeometry(170, 12, B + 10, 1, 4).translate(-L / 2 + 150, z + 322, 0), WHITE));
  parts.push(flatGeo(new THREE.CylinderGeometry(34, 40, 120, 14).translate(-L / 2 + 70, z + 380, 0), '#e5484d'));
  parts.push(flatGeo(new THREE.CylinderGeometry(35, 35, 22, 14).translate(-L / 2 + 70, z + 420, 0), DARK));
  // Containers on deck, in bays.
  const colours = ['#e5484d', '#2f6fd6', '#14a3a0', '#f28a2e', '#7a52d6', '#3fae5a', '#f2c230'];
  let k = 0;
  for (let x = -L / 2 + 280; x < L / 2 - 260; x += 140) {
    const tiers = 2 + ((x / 140) % 3 === 0 ? 1 : 0) + (k % 4 === 1 ? 1 : 0);
    for (let row = -2; row <= 2; row++) {
      for (let t = 0; t < tiers; t++) {
        const c = colours[(k + row * 3 + t * 5 + 70) % colours.length];
        parts.push(flatGeo(new THREE.BoxGeometry(130, 56, 50).translate(x, z + 184 + t * 58, row * 52), c, 1, { id: 'ribs', cell: 10, color: darker(c, 0.75) }));
      }
    }
    k++;
  }
  const geo = mergeGeometries(parts);
  geo.rotateY(-(d.angle || 0));
  geo.translate(d.x, 0, d.y);
  const mesh = new THREE.Mesh(geo, brightMaterial());
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Gulls: a handful of white birds circling over the water, flapping.
function gulls(scene, S) {
  const birds = [];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -16, 3, -9, -3, 0, 0, 0, 0, 0, 3, 0, 0, -16, 3, 9], 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide });
  for (let i = 0; i < 7; i++) {
    const g = new THREE.Mesh(geo, mat);
    g.scale.setScalar(1.6);
    scene.add(g);
    birds.push({ g, cx: 500 + ((i * 731) % (S - 1000)), cy: 200 + ((i * 457) % 1200), r: 160 + (i % 3) * 90, h: 260 + (i % 4) * 60, w: 0.25 + (i % 3) * 0.08, p: i * 1.7 });
  }
  return (t) => {
    for (const b of birds) {
      const a = b.p + t * b.w;
      b.g.position.set(b.cx + Math.cos(a) * b.r, b.h + Math.sin(t * 0.7 + b.p) * 20, b.cy + Math.sin(a) * b.r);
      b.g.rotation.y = -a;
      b.g.scale.y = 1.6 * (0.4 + 0.6 * Math.abs(Math.sin(t * 6 + b.p)));
    }
  };
}

// ---------- the arena ----------
export function buildHarbour(scene, map) {
  const lamps = [];
  const statics = containerDetails(map);
  const tickers = [];
  for (const d of map.deco || []) {
    if (d.kind === 'crane') statics.push(...crane(d, lamps));
    else if (d.kind === 'lamp') statics.push(...lampPost(d.x, d.y, d.z, lamps));
    else if (d.kind === 'lighthouse') tickers.push(lighthouse(scene, d));
    else if (d.kind === 'ship') ship(scene, d);
  }
  if (statics.length) scene.add(merged(statics));
  for (const l of lamps) scene.add(l);
  tickers.push(gulls(scene, map.size));
  // Movers: the crane's load (one per swinging group), forklifts, bascule leaves.
  const groups = new Map();
  for (const m of map.movers) if (m.type === 'pendulum' && m.group) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const drawn = new Set();
  return {
    mover(m) {
      if (m.type === 'pendulum' && m.group) {
        if (drawn.has(m.group)) return { update() {} };
        drawn.add(m.group);
        return swingingLoad(scene, map, groups.get(m.group));
      }
      if (m.type === 'slider' && m.kind === 'forklift') return forklift(scene, map, m);
      if (m.type === 'drawbridge' && m.kind === 'bascule') return bascule(scene, map, m);
      return null;
    },
    update(t) {
      for (const f of tickers) f(t);
      const blink = Math.floor(t * 1.5) % 2 ? 1 : 0.35;
      for (const l of lamps) if (l.userData.base && l.userData.base.r > 0.9 && l.userData.base.g < 0.4) l.material.color.copy(l.userData.base).multiplyScalar(blink);
    },
  };
}
