// Weapons on the karts: what a kart is carrying shows on it, popping on with an elastic overshoot
// when its roulette lands and shrinking away when it's fired. Twin rocket pods ride on the side
// pods, the bomb sits in a mortar, the snowball in a snow cannon and the sticky bomb in a goo
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

const BUILD = {
  // A pod of two rocket tubes on each side pod, noses peeking out, a hazard stripe round it.
  pods() {
    const g = [];
    for (const z of [-12.2, 12.2]) {
      g.push(P(rbox(13, 6.6, 6.6, 1.6), { at: [3, 15.4, z], color: '#3b4150' }));
      g.push(P(rbox(1.6, 6.9, 6.9, 0.5), { at: [-0.6, 15.4, z], color: '#facc15' }));
      for (const dy of [-1.6, 1.6]) {
        g.push(P(cyl(1.55, 1.55, 2.4), { at: [10.4, 15.4 + dy, z], rot: X, color: '#1f232c' }));
        g.push(P(new THREE.ConeGeometry(1.15, 2.6, 10), { at: [11.2, 15.4 + dy, z], rot: X, color: '#ef233c' }));
      }
      g.push(P(rbox(6, 2, 3, 0.6), { at: [2, 11.6, z], color: '#2a2e38' })); // the bracket
    }
    return g;
  },
  // A stubby mortar on the right side pod, tipped up and forward, a gold band round its muzzle.
  mortar() {
    const tilt = [0, 0, -0.55];
    return [
      P(rbox(9, 2.4, 9, 0.8), { at: [2, 12.4, 12.2], color: '#4a505c' }),
      P(cyl(3.6, 3.2, 10, 16), { at: [3.4, 17.4, 12.2], rot: tilt, color: '#1b2030' }),
      P(new THREE.TorusGeometry(3.3, 0.7, 6, 16), { at: [6, 21.4, 12.2], rot: [0, Math.PI / 2, 0.55], color: '#f59e0b' }),
      P(new THREE.SphereGeometry(2.6, 12, 8), { at: [6.2, 21.6, 12.2], color: '#0f121a' }),
    ];
  },
  // The same shape in ice blue and white, with a snowball loaded.
  snowgun() {
    const tilt = [0, 0, -0.35];
    return [
      P(rbox(9, 2.4, 9, 0.8), { at: [2, 12.4, 12.2], color: '#64748b' }),
      P(cyl(3.4, 3.4, 11, 16), { at: [4, 16.6, 12.2], rot: [0, 0, -Math.PI / 2 + 0.35], color: '#f1f5f9' }),
      P(cyl(3.6, 3.6, 2, 16), { at: [6.5, 17.5, 12.2], rot: [0, 0, -Math.PI / 2 + 0.35], color: '#38bdf8' }),
      P(cyl(3.6, 3.6, 2, 16), { at: [1.8, 15.8, 12.2], rot: [0, 0, -Math.PI / 2 + 0.35], color: '#38bdf8' }),
      P(new THREE.SphereGeometry(2.8, 12, 8), { at: [9.3, 18.6, 12.2], color: '#ffffff' }),
      void tilt,
    ].filter(Boolean);
  },
  // A pink goo tank with a nozzle pointing forward.
  goo() {
    return [
      P(rbox(9, 2.4, 9, 0.8), { at: [1.5, 12.4, 12.2], color: '#4a505c' }),
      P(new THREE.SphereGeometry(4.4, 16, 12), { at: [1, 17.6, 12.2], color: '#f472b6' }),
      P(new THREE.TorusGeometry(4.5, 0.6, 6, 18), { at: [1, 17.6, 12.2], rot: [Math.PI / 2, 0, 0], color: '#831843' }),
      P(cyl(1.6, 1.1, 7, 12), { at: [7, 17.6, 12.2], rot: X, color: '#be185d' }),
      P(new THREE.SphereGeometry(1.5, 10, 8), { at: [10.6, 17.6, 12.2], color: '#fbcfe8' }),
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
  // Where a shot leaves it (kart space), for the muzzle flash.
  pivot.userData.muzzle = kind === 'pods' ? [12, 15.4, 0] : kind === 'mortar' ? [6.4, 22, 12.2] : kind === 'snowgun' ? [10, 19, 12.2] : [11.5, 17.6, 12.2];
  return pivot;
}
