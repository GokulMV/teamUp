// CC0 glTF models (Kenney's kits, see CREDITS.md), loaded on demand: one fetch per file per page,
// then every user gets its own copy. Kenney's vehicles face +z and are about 1.7 units long.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

// The parsed scene for `url` (shared: use fitted(), which clones it).
export function loadModel(url) {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url).then((gltf) => gltf.scene));
  return cache.get(url);
}

// A copy of a loaded scene scaled so its length (along its forward axis) is `length` units, turned
// to face +x like our karts and set down on y = 0. Meshes cast and receive shadows; their
// materials are shared between copies, so a copy never disposes them.
export function fitted(scene, { length, forward = '+z' }) {
  const copy = scene.clone(true);
  const box = new THREE.Box3().setFromObject(copy);
  const size = box.getSize(new THREE.Vector3());
  const along = forward.endsWith('z') ? size.z : size.x;
  const s = length / Math.max(1e-6, along);
  const root = new THREE.Group();
  copy.scale.setScalar(s);
  // +z forward -> +x forward: a quarter turn about y.
  if (forward === '+z') copy.rotation.y = Math.PI / 2;
  else if (forward === '-z') copy.rotation.y = -Math.PI / 2;
  else if (forward === '-x') copy.rotation.y = Math.PI;
  copy.position.y = -box.min.y * s;
  root.add(copy);
  copy.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

// Named parts of a fitted model (e.g. Kenney's 'wheel-front-left'), for animating them.
export function partsOf(root, names) {
  const out = {};
  root.traverse((o) => { if (names.includes(o.name)) out[o.name] = o; });
  return out;
}
