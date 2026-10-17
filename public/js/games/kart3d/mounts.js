// Weapons on the karts: what a kart is carrying shows on it, popping on with an elastic overshoot
// when its roulette lands and shrinking away when it's fired. Rocket pods ride on both ends of the
// rear wing, the bomb sits in a mortar, the snowball in a snow cannon and the sticky bomb in a goo
// launcher. Toon-shaded with ink outlines, like the karts (kart3d/toon.js).
//
// Kart space: +x forward, +y up, +z the kart's right (see kart3d/gokart.js).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon, outlined } from './toon.js';

// Item -> mount.
export const MOUNT_OF = { rocket: 'pods', bomb: 'mortar', snowball: 'snowgun', sticky: 'goo' };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
function P(g, { at = [0, 0, 0], rot = [0, 0, 0], scale = 1, color = '#ffffff' } = {}) {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const s = Array.isArray(scale) ? scale : [scale, scale, scale];
  geo.applyMatrix4(_m.compose(_p.set(...at), _q.setFromEuler(_e.set(...rot)), _s.set(...s)));
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 2, r);
const cyl = (r0, r1, h, n = 14) => new THREE.CylinderGeometry(r1, r0, h, n);
const X = [0, 0, -Math.PI / 2]; // a cylinder along +x

// Everything sits up on the rear wing (top at about y 22, x -25, spanning z +-15), where the chase
// camera sees it either side of the driver's head.
const WX = -23.5; // along the wing
const WY = 22.6; // the wing's top
const SIDE = 12.8; // out towards the wing's ends, clear of the driver's head
const BUILD = {
  // A rocket pod on each end of the wing: two tubes with red noses peeking out in front, thruster
  // rings glowing at the back, a hazard stripe round the middle.
  pods() {
    const g = [];
    for (const z of [-SIDE, SIDE]) {
      const y = WY + 4.6;
      g.push(P(rbox(15, 8, 8, 1.8), { at: [WX, y, z], color: '#3b4150' }));
      g.push(P(rbox(1.8, 8.3, 8.3, 0.5), { at: [WX + 1.5, y, z], color: '#facc15' }));
      for (const dy of [-1.8, 1.8]) {
        g.push(P(cyl(1.75, 1.75, 2.6), { at: [WX + 8, y + dy, z], rot: X, color: '#1f232c' }));
        g.push(P(new THREE.ConeGeometry(1.3, 2.8, 10), { at: [WX + 8.9, y + dy, z], rot: X, color: '#ef233c' }));
        g.push(P(new THREE.TorusGeometry(1.5, 0.5, 6, 14), { at: [WX - 7.6, y + dy, z], rot: [0, Math.PI / 2, 0], color: '#ff8a1f' }));
      }
      g.push(P(rbox(6, 2.4, 3, 0.6), { at: [WX, WY + 0.4, z], color: '#2a2e38' })); // the bracket
    }
    return g;
  },
  // A stubby mortar on the right end of the wing, tipped up and forward, a gold band round its muzzle.
  mortar() {
    const tilt = [0, 0, -0.5];
    return [
      P(rbox(10, 2.6, 10, 0.9), { at: [WX, WY + 1.2, SIDE], color: '#4a505c' }),
      P(cyl(4.2, 3.7, 11, 16), { at: [WX + 1.4, WY + 7.6, SIDE], rot: tilt, color: '#1b2030' }),
      P(new THREE.TorusGeometry(3.8, 0.8, 6, 16), { at: [WX + 4.2, WY + 12.1, SIDE], rot: [0, Math.PI / 2, 0.5], color: '#f59e0b' }),
      P(new THREE.SphereGeometry(3, 12, 8), { at: [WX + 4.4, WY + 12.3, SIDE], color: '#0f121a' }),
    ];
  },
  // The same in ice blue and white, a snowball loaded.
  snowgun() {
    const r = [0, 0, -Math.PI / 2 + 0.35];
    return [
      P(rbox(10, 2.6, 10, 0.9), { at: [WX, WY + 1.2, SIDE], color: '#64748b' }),
      P(cyl(3.8, 3.8, 13, 16), { at: [WX + 1.5, WY + 7, SIDE], rot: r, color: '#f1f5f9' }),
      P(cyl(4, 4, 2.2, 16), { at: [WX + 4.4, WY + 8, SIDE], rot: r, color: '#38bdf8' }),
      P(cyl(4, 4, 2.2, 16), { at: [WX - 1.4, WY + 6, SIDE], rot: r, color: '#38bdf8' }),
      P(new THREE.SphereGeometry(3.2, 12, 8), { at: [WX + 7.6, WY + 9.3, SIDE], color: '#ffffff' }),
    ];
  },
  // A pink goo tank with a nozzle pointing forward.
  goo() {
    return [
      P(rbox(10, 2.6, 10, 0.9), { at: [WX, WY + 1.2, SIDE], color: '#4a505c' }),
      P(new THREE.SphereGeometry(5, 16, 12), { at: [WX - 0.5, WY + 7.2, SIDE], color: '#f472b6' }),
      P(new THREE.TorusGeometry(5.1, 0.7, 6, 18), { at: [WX - 0.5, WY + 7.2, SIDE], rot: [Math.PI / 2, 0, 0], color: '#831843' }),
      P(cyl(1.8, 1.3, 8, 12), { at: [WX + 6.5, WY + 7.2, SIDE], rot: X, color: '#be185d' }),
      P(new THREE.SphereGeometry(1.7, 10, 8), { at: [WX + 10.6, WY + 7.2, SIDE], color: '#fbcfe8' }),
    ];
  },
};

const geoCache = new Map();
let mat = null;
// A fresh mount of `kind` (a group whose origin is the kart's, so it scales about where it sits).
export function buildMount(kind) {
  if (!BUILD[kind]) return null;
  if (!geoCache.has(kind)) geoCache.set(kind, mergeGeometries(BUILD[kind]()));
  mat = mat || toon({ vertexColors: true });
  const geo = geoCache.get(kind);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  outlined(mesh);
  // Scale about the mount's own middle, not the kart's.
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  const pivot = new THREE.Group();
  pivot.position.copy(c);
  mesh.position.copy(c).multiplyScalar(-1);
  pivot.add(mesh);
  pivot.userData.kind = kind;
  pivot.userData.mesh = mesh;
  return pivot;
}

// Where shots leave each mount (kart space), for the muzzle flashes.
export const MUZZLES = {
  pods: [[WX + 10, WY + 4.6, SIDE], [WX + 10, WY + 4.6, -SIDE]],
  mortar: [[WX + 4.6, WY + 12.6, SIDE]],
  snowgun: [[WX + 8.6, WY + 9.6, SIDE]],
  goo: [[WX + 12, WY + 7.2, SIDE]],
};
