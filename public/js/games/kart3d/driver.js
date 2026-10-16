// Kart drivers: each player's lobby avatar (window.Avatars) as a round blob with their face,
// hands on the wheel and their accessory (cap, crown, headphones...) on top.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MOBILE, part } from './world.js';

const HEAD = [-3, 21, 0];
const MOUNT = [-3, 30.5, 0];
const cache = { face: new Map(), hands: new Map(), acc: new Map() };
let blobGeo = null;
let handsGeo = null;
let accMats = null;

// Avatar face (window.Avatars.face) painted on the front of an equirectangular sphere map:
// u = 0.5 is the sphere's +x side, which is where the kart points.
function faceMaterial(id, body) {
  let mat = cache.face.get(id);
  if (mat) return mat;
  const w = MOBILE ? 256 : 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = w / 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, w, w / 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55 });
  const size = w * 0.586;
  const img = new Image();
  // Drawn a little above the equator so the mouth clears the steering wheel.
  img.onload = () => { ctx.drawImage(img, w / 2 - size / 2, w / 4 - size * 0.7, size, size); texture.needsUpdate = true; };
  img.src = `data:image/svg+xml,${encodeURIComponent(window.Avatars.face(id).replace('<svg ', `<svg width="${Math.round(size)}" height="${Math.round(size)}" `))}`;
  cache.face.set(id, mat);
  return mat;
}

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
    tint(part(new THREE.TorusGeometry(10.2, 1.1, 6, 20, Math.PI), 0, -2, 0, 0, Math.PI / 2, 0), c),
    tint(part(new THREE.CylinderGeometry(3, 3, 2.6, 14), 0, -3, 10, Math.PI / 2, 0, 0), c),
    tint(part(new THREE.CylinderGeometry(3, 3, 2.6, 14), 0, -3, -10, Math.PI / 2, 0, 0), c),
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

// A tapered cylinder from a to b (arms).
function limb(a, b, r0, r1) {
  const from = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(from);
  const geo = new THREE.CylinderGeometry(r1, r0, dir.length(), 10, 1, true).translate(0, dir.length() / 2, 0);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  return geo.translate(from.x, from.y, from.z).toNonIndexed();
}

function accessory(id, kind, color) {
  const key = `${id}`;
  let geo = cache.acc.get(key);
  if (geo === undefined) {
    geo = ACC[kind] ? mergeGeometries(ACC[kind](color || '#ffffff')) : null;
    cache.acc.set(key, geo);
  }
  return geo;
}

// Meshes for the driver of `avatarId`, positioned in kart space (the kart points along +x).
// Returns { meshes, halo } where halo (if any) should spin slowly.
export function buildDriver(avatarId) {
  const id = Number(avatarId) || 0;
  const p = window.Avatars ? window.Avatars.preset(id) : { body: '#ffb02e', acc: 'none', accColor: '' };
  if (!blobGeo) {
    blobGeo = new THREE.SphereGeometry(9.5, 32, 20).scale(1, 1.08, 1).translate(...HEAD);
    // Hands on the wheel, with short arms reaching out of the body (one merged mesh).
    handsGeo = mergeGeometries([4.5, -4.5].flatMap((z) => [
      part(new THREE.SphereGeometry(2.3, 12, 8), 5.5, 13.6, z),
      limb([-1.5, 15.5, Math.sign(z) * 7.6], [5.5, 13.6, z], 2, 1.4),
    ]));
    accMats = {
      plain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.6 }),
      glow: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xfde047, emissiveIntensity: 1.2, roughness: 0.4 }),
    };
  }
  let hands = cache.hands.get(p.body);
  if (!hands) { hands = new THREE.MeshStandardMaterial({ color: p.body, roughness: 0.6 }); cache.hands.set(p.body, hands); }
  const meshes = [new THREE.Mesh(blobGeo, faceMaterial(id, p.body)), new THREE.Mesh(handsGeo, hands)];
  meshes[1].userData.noShadow = true;
  let halo = null;
  const geo = accessory(id, p.acc, p.accColor);
  if (geo) {
    const mat = p.acc === 'crown' ? accMats.metal : p.acc === 'halo' ? accMats.glow : accMats.plain;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(MOUNT[0], MOUNT[1] + (p.acc === 'halo' ? 3 : 0), MOUNT[2]);
    if (p.acc === 'halo') halo = m;
    meshes.push(m);
  }
  return { meshes, halo };
}
