// The cartoon look for karts, drivers, item boxes and weapons: toon shading in three flat bands of
// light, and dark ink outlines drawn as inverted hulls (a copy of the shape, pushed out along its
// normals and drawn from the inside), as thick on screen near or far.
import * as THREE from 'three';

let gradient = null;
// The light ramp: shadow, mid-tone, lit.
export function toonGradient() {
  if (gradient) return gradient;
  const steps = [84, 172, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  gradient = new THREE.DataTexture(data, steps.length, 1);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

export function toon(params = {}) {
  return new THREE.MeshToonMaterial({ gradientMap: toonGradient(), ...params });
}

// A toon version of a lit material (its colour, vertex colours and glow), made once per material.
const toonCache = new WeakMap();
export function toonOf(mat) {
  if (!mat || mat.isMeshBasicMaterial || mat.isMeshToonMaterial || mat.isShaderMaterial) return mat;
  let t = toonCache.get(mat);
  if (!t) {
    t = toon({ color: mat.color.clone(), vertexColors: mat.vertexColors, emissive: mat.emissive ? mat.emissive.clone() : 0x000000, emissiveIntensity: mat.emissiveIntensity ?? 1 });
    toonCache.set(mat, t);
  }
  return t;
}

// Outline thickness: a fraction of the distance to the camera (about 2-3 px at any range).
export const OUTLINE = { thick: 0.0036, color: new THREE.Color(0x1d1530) };
let outlineMat = null;
export function outlineMaterial() {
  if (outlineMat) return outlineMat;
  outlineMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { thick: { value: OUTLINE.thick }, ink: { value: OUTLINE.color } }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      uniform float thick;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        mvPosition.xyz += n * thick * -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 ink;
      void main() {
        gl_FragColor = vec4(ink, 1.0);
        #include <fog_fragment>
      }`,
    side: THREE.BackSide,
    fog: true,
  });
  return outlineMat;
}

// Give `mesh` an ink outline (of `geo`, its own shape by default). Returns the outline mesh.
export function outlined(mesh, geo = mesh.geometry) {
  const o = new THREE.Mesh(geo, outlineMaterial());
  o.castShadow = false;
  o.receiveShadow = false;
  o.userData.outline = true;
  mesh.add(o);
  return o;
}
