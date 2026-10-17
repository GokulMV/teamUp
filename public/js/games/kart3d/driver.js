// The hat on each kart driver's head: the accessory of the player's lobby avatar (window.Avatars)
// (cap, beanie, crown, horns, bow, antenna, headphones, top hat, flower, leaf or halo).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { part } from './world.js';

const cache = new Map();
let mats = null;

// Accessories are merged primitives with vertex colours, so a two-tone cap is still one mesh.
function tint(geo, hex) {
  const col = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const shade = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;

// Each is built round the top of the head (y = 0 there), facing +x.
const ACC = {
  cap: (c) => [
    tint(part(new THREE.SphereGeometry(9.6, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2.3), 0, -3, 0), c),
    tint(part(new THREE.CylinderGeometry(6, 6, 0.9, 16, 1, false, -Math.PI / 2, Math.PI), 6, 0.4, 0, 0, 0, 0.12), shade(c, 0.75)),
  ],
  beanie: (c) => [
    tint(part(new THREE.SphereGeometry(9.8, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2.2), 0, -3, 0), c),
    tint(part(new THREE.TorusGeometry(9.2, 1.6, 6, 24), 0, -2, 0, Math.PI / 2, 0, 0), shade(c, 0.8)),
    tint(part(new THREE.SphereGeometry(2.6, 10, 8), 0, 7.6, 0), '#ffffff'),
  ],
  crown: (c) => {
    const g = [tint(part(new THREE.CylinderGeometry(6.2, 6.6, 3, 16, 1, true), 0, 0, 0), c)];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.push(tint(part(new THREE.ConeGeometry(1.5, 4, 6), Math.cos(a) * 6.2, 3.2, Math.sin(a) * 6.2), c));
    }
    g.push(tint(part(new THREE.SphereGeometry(1.3, 8, 6), 6.4, 0.2, 0), '#ef4444'));
    return g;
  },
  horns: (c) => [
    tint(part(new THREE.ConeGeometry(1.8, 7, 8), 0, 1, 5, 0.5, 0, 0), c),
    tint(part(new THREE.ConeGeometry(1.8, 7, 8), 0, 1, -5, -0.5, 0, 0), c),
  ],
  bow: (c) => [
    tint(part(new THREE.ConeGeometry(3, 5, 8), 0, 0, 3, -Math.PI / 2, 0, 0), c),
    tint(part(new THREE.ConeGeometry(3, 5, 8), 0, 0, -3, Math.PI / 2, 0, 0), c),
    tint(part(new THREE.SphereGeometry(1.6, 8, 6), 0, 0, 0), shade(c, 0.8)),
  ],
  antenna: (c) => [
    tint(part(new THREE.CylinderGeometry(0.5, 0.5, 8, 6), 0, 2, 3.5, 0.35, 0, 0), '#1f2937'),
    tint(part(new THREE.CylinderGeometry(0.5, 0.5, 8, 6), 0, 2, -3.5, -0.35, 0, 0), '#1f2937'),
    tint(part(new THREE.SphereGeometry(2, 10, 8), 0, 6, 5), c),
    tint(part(new THREE.SphereGeometry(2, 10, 8), 0, 6, -5), c),
  ],
  headphones: (c) => [
    tint(part(new THREE.TorusGeometry(10.6, 1.1, 6, 20, Math.PI), 0, -3, 0, 0, Math.PI / 2, 0), c),
    tint(part(new THREE.CylinderGeometry(3, 3, 2.6, 14), 0, -5, 10.4, Math.PI / 2, 0, 0), c),
    tint(part(new THREE.CylinderGeometry(3, 3, 2.6, 14), 0, -5, -10.4, Math.PI / 2, 0, 0), c),
  ],
  tophat: (c) => [
    tint(part(new THREE.CylinderGeometry(8.5, 8.5, 1, 20), 0, -0.4, 0), c),
    tint(part(new THREE.CylinderGeometry(5.6, 5.6, 9, 18), 0, 4.6, 0), c),
    tint(part(new THREE.CylinderGeometry(5.75, 5.75, 1.8, 18), 0, 1.4, 0), '#ef4444'),
  ],
  flower: (c) => {
    const g = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.push(tint(part(new THREE.SphereGeometry(2, 8, 6).scale(1, 0.45, 1.6), Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6, 0, -a, 0), c));
    }
    g.push(tint(part(new THREE.SphereGeometry(1.5, 8, 6), 0, 0.5, 0), '#fde047'));
    return g.map((p) => p.rotateX(-0.5).translate(-1, -2, 6.5));
  },
  leaf: (c) => [
    tint(part(new THREE.CylinderGeometry(0.4, 0.4, 3, 6), 0, 0.5, 0), shade(c, 0.7)),
    tint(part(new THREE.SphereGeometry(3, 10, 8).scale(1, 0.35, 0.6), 1.8, 2.6, 0, 0, 0, 0.5), c),
  ],
  halo: (c) => [tint(part(new THREE.TorusGeometry(6.5, 0.9, 8, 28), 0, 0, 0, Math.PI / 2, 0, 0), c)],
};

// The hat of avatar `avatarId` as a mesh standing on the top of the head (its origin), or null if
// the avatar has none. kind 'halo' floats a little higher and should spin slowly.
export function hatFor(avatarId) {
  const id = Number(avatarId) || 0;
  const p = window.Avatars ? window.Avatars.preset(id) : { acc: 'none', accColor: '' };
  if (!ACC[p.acc]) return null;
  let geo = cache.get(id);
  if (!geo) {
    geo = mergeGeometries(ACC[p.acc](p.accColor || '#ffffff'));
    cache.set(id, geo);
  }
  if (!mats) {
    mats = {
      plain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.6 }),
      glow: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xfde047, emissiveIntensity: 1.2, roughness: 0.4 }),
    };
  }
  const mesh = new THREE.Mesh(geo, p.acc === 'crown' ? mats.metal : p.acc === 'halo' ? mats.glow : mats.plain);
  if (p.acc === 'halo') mesh.position.y = 3;
  return { mesh, kind: p.acc };
}
