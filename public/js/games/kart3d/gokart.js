// Kart Battle's karts and drivers, modelled in code (original designs, no model files).
//
// The kart: a chunky arcade go-kart. Its nose, side pods, wings and rear bumper are painted in the
// player's colour (the team's in team games); the frame, seat, engine, twin exhausts and tyres keep
// their own colours, and the rims wear the driver's accent colour.
//
// The driver: one of CHARACTERS, a big-headed animal in a racing suit (the paint colour) with white
// gloves on the wheel and the player's lobby hat on. Their rig brings them to life: the eyes blink
// (and squeeze shut when hit), the ears swing on springs (back under boost, out in the turns, up
// over jumps), the head looks into the turn and the hands turn the wheel.
//
// Space: the kart points along +x, +y is up and +z is its right; the tyres stand on y = 0.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hatFor } from './driver.js';

// ---------- the cast ----------
// ears: round (size `ear`) | pointy | long | floppy | fold | none. `rim`: their wheels' colour.
export const CHARACTERS = {
  bunny: { fur: '#f2efff', muzzle: '#ffffff', inner: '#ffb1c8', nose: '#ff77a0', ears: 'long', teeth: true, rim: '#ff77a0' },
  bear: { fur: '#b27b4d', muzzle: '#f0d4ae', inner: '#f0d4ae', nose: '#3a2a22', ears: 'round', ear: 3.6, rim: '#ffb02e' },
  cat: { fur: '#ffaa48', muzzle: '#fff4e4', inner: '#ffb1c8', nose: '#ff77a0', ears: 'pointy', whiskers: true, rim: '#4f9dff' },
  fox: { fur: '#ff7a2c', muzzle: '#fff8ef', inner: '#fff8ef', nose: '#2b1d17', ears: 'pointy', tip: '#3a2a22', foxFace: true, rim: '#22c5d8' },
  panda: { fur: '#fbfbfd', muzzle: '#ffffff', inner: '#2a2a33', earFur: '#2a2a33', nose: '#2a2a33', ears: 'round', ear: 3.5, patches: '#2a2a33', sclera: true, rim: '#36c98e' },
  frog: { fur: '#74d45e', belly: '#c9f0a8', ears: 'none', frog: true, rim: '#facc15' },
  penguin: { fur: '#2f3b55', face: '#ffffff', beak: '#ffa62b', ears: 'none', rim: '#38bdf8' },
  pig: { fur: '#ffb6c9', snout: '#ff8db0', inner: '#ff8db0', ears: 'fold', rim: '#a78bfa' },
  mouse: { fur: '#bcc3cf', muzzle: '#f1f3f7', inner: '#ffb1c8', nose: '#ff77a0', ears: 'round', ear: 5.4, whiskers: true, rim: '#fb7185' },
  dog: { fur: '#f2c690', muzzle: '#fff4e3', earFur: '#9b643a', nose: '#2b1d17', ears: 'floppy', tongue: true, rim: '#ef4444' },
  duck: { fur: '#ffd83a', bill: '#ff9b1f', ears: 'none', tuft: true, rim: '#3b82f6' },
  raccoon: { fur: '#9ba2ae', muzzle: '#f4f5f8', inner: '#f4f5f8', earFur: '#5e6571', nose: '#2a2a33', ears: 'pointy', mask: '#3a3f4a', sclera: true, rim: '#f97316' },
  koala: { fur: '#adb5c2', inner: '#f5f6f8', nose: '#3a3f4a', ears: 'round', ear: 5.2, bigNose: true, rim: '#84cc16' },
  lion: { fur: '#ffc84a', mane: '#e07b2c', muzzle: '#fff0c8', inner: '#e07b2c', nose: '#6a3a22', ears: 'round', ear: 2.9, rim: '#e879f9' },
  dino: { fur: '#5ed394', muzzle: '#a6ecc4', spikes: '#2c9e66', ears: 'none', dino: true, rim: '#f43f5e' },
};

// Fixed colours of the kart.
const COL = {
  frame: '#2b2f38', tube: '#eef1f5', seat: '#20232b', seatTrim: '#3d4350', engine: '#4a505c', grille: '#14161b',
  steel: '#a9b1bf', chrome: '#e3e8ef', rubber: '#25272d', tread: '#1d1f24', dish: '#2c3038', white: '#ffffff', glove: '#fbfbfd',
  head: '#fff3cf', tail: '#ff2b2b', cheek: '#ff93b0', mouth: '#3b2026', eye: '#141419',
};

// Wheels: [x, z, radius, width, front]. The kart's own module reads these (spin, steer, skids).
export const WHEELS = [[16, 14.2, 6.4, 6.2, true], [16, -14.2, 6.4, 6.2, true], [-14, 15.6, 8, 8, false], [-14, -15.6, 8, 8, false]];
// Exhaust tips (flames come out of them) and the centre of the driver's head.
export const EXHAUSTS = [[-29.6, 11.6, 7.4], [-29.6, 11.6, -7.4]];
export const HEAD = [-5.4, 28.4, 0];

// ---------- geometry helpers ----------
const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// A part: geometry g scaled, turned (Euler angles or a quaternion) and moved, in one flat colour.
// Painted parts give `shade` instead: their vertex colour multiplies the paint (1 = the paint itself).
function P(g, { at = [0, 0, 0], rot = [0, 0, 0], quat = null, scale = 1, color = '#ffffff', shade = null } = {}) {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const s = Array.isArray(scale) ? scale : [scale, scale, scale];
  if (quat) _q.copy(quat);
  else _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  geo.applyMatrix4(_m.compose(_v.set(at[0], at[1], at[2]), _q, _s.set(s[0], s[1], s[2])));
  const c = shade === null ? new THREE.Color(color) : new THREE.Color(shade, shade, shade);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const rbox = (w, h, d, r, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, r);
const ball = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
const cyl = (r0, r1, h, n = 18, open = false) => new THREE.CylinderGeometry(r1, r0, h, n, 1, open);
// A rod from a to b (its own radius at each end).
function rod(a, b, r0, r1 = r0, n = 10) {
  const A = new THREE.Vector3(...a);
  const d = new THREE.Vector3(...b).sub(A);
  const g = cyl(r0, r1, d.length(), n).translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  return g.translate(A.x, A.y, A.z);
}
const tube = (pts, r, seg = 24, n = 9) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), seg, r, n, false);
// A turn that points a part's +x along n, keeping its +y as near to straight up as it can.
function facing(n, ref = UP) {
  const x = n.clone().normalize();
  const y = ref.clone().addScaledVector(x, -ref.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const merge = (list) => (list.length ? mergeGeometries(list) : null);

// ---------- the wheels ----------
const wheelCache = new Map();
// One wheel, its axle along z with the rim on the +z side: a tyre with rounded shoulders and a
// chevron tread, and a five-spoke rim in `rim` colour.
function wheelGeometry(r, w, rim) {
  const key = `${r}:${w}:${rim}`;
  if (wheelCache.has(key)) return wheelCache.get(key);
  const hw = w / 2;
  const ri = r * 0.62;
  const s = Math.min(hw * 0.5, r * 0.24);
  const pts = [new THREE.Vector2(ri * 0.97, -hw * 0.82), new THREE.Vector2(ri + 0.35, -hw)];
  const arc = (cy, a0, a1) => { for (let i = 0; i <= 5; i++) { const a = a0 + ((a1 - a0) * i) / 5; pts.push(new THREE.Vector2(r - s + Math.cos(a) * s, cy + Math.sin(a) * s)); } };
  arc(-hw + s, -Math.PI / 2, 0);
  pts.push(new THREE.Vector2(r + 0.15, 0));
  arc(hw - s, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(ri + 0.35, hw), new THREE.Vector2(ri * 0.97, hw * 0.82));
  const parts = [P(new THREE.LatheGeometry(pts, 36), { rot: [Math.PI / 2, 0, 0], color: COL.rubber })];
  // Tread: chevrons of little blocks right round the tyre.
  const N = 14;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    for (const side of [1, -1]) {
      const g = P(new THREE.BoxGeometry(1.7, 1.1, hw * 0.78), { at: [0, r, side * hw * 0.42], rot: [0, side * 0.5, 0], color: COL.tread });
      parts.push(g.rotateZ(a));
    }
  }
  // Rim: a dark dish behind five spokes, a lip and a hub.
  const z = hw * 0.62;
  parts.push(P(cyl(ri, ri, 0.8, 28), { at: [0, 0, z - 0.3], rot: [Math.PI / 2, 0, 0], color: COL.dish }));
  parts.push(P(new THREE.TorusGeometry(ri * 0.95, 0.55, 8, 32), { at: [0, 0, z], color: rim }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
    parts.push(P(rbox(ri * 0.66, ri * 0.3, 1.1, 0.35, 2), { at: [Math.cos(a) * ri * 0.58, Math.sin(a) * ri * 0.58, z + 0.2], rot: [0, 0, a], color: rim }));
  }
  parts.push(P(cyl(ri * 0.38, ri * 0.32, 1.4, 20), { at: [0, 0, z + 0.6], rot: [Math.PI / 2, 0, 0], color: rim }));
  parts.push(P(ball(ri * 0.15, 10, 8), { at: [0, 0, z + 1.35], scale: [1, 1, 0.6], color: COL.chrome }));
  const geo = merge(parts);
  wheelCache.set(key, geo);
  return geo;
}

// ---------- the kart ----------
let kartGeo = null;
function kartGeometry() {
  if (kartGeo) return kartGeo;
  const paint = [];
  const fixed = [];
  const chrome = [];
  const lights = [];
  const mirror = (fn) => { fn(1); fn(-1); };

  // Nose: a side profile pushed out across the kart with rounded edges, narrowing to the tip.
  const s = new THREE.Shape();
  s.moveTo(4, 3);
  s.lineTo(22.5, 3);
  s.quadraticCurveTo(25.6, 3, 25.6, 6);
  s.quadraticCurveTo(25.2, 8.4, 22.6, 9);
  s.quadraticCurveTo(13, 11.4, 8, 12.2);
  s.lineTo(4, 12.2);
  s.closePath();
  let nose = new THREE.ExtrudeGeometry(s, { depth: 15, bevelEnabled: true, bevelThickness: 2.8, bevelSize: 2, bevelSegments: 4, curveSegments: 16 });
  nose.deleteAttribute('uv');
  nose.deleteAttribute('normal');
  nose = mergeVertices(nose.translate(0, 0, -7.5));
  const np = nose.attributes.position;
  for (let i = 0; i < np.count; i++) np.setZ(i, np.getZ(i) * (1 - 0.22 * Math.min(1, Math.max(0, (np.getX(i) - 8) / 19))));
  nose.computeVertexNormals();
  paint.push(P(nose, { shade: 1 }));

  // A chunky front bumper across the front wheels.
  paint.push(P(rbox(4.6, 4.6, 33, 2.1), { at: [26.6, 4.4, 0], shade: 0.86 }));

  // Side pods with black intakes and a white stripe.
  mirror((sz) => {
    paint.push(P(rbox(14.5, 7.6, 7, 2.7), { at: [1.4, 7.6, sz * 11.3], shade: 1 }));
    fixed.push(P(rbox(1.2, 4.6, 4.6, 0.5), { at: [8.4, 8, sz * 11.3], color: COL.grille }));
    fixed.push(P(rbox(11.5, 0.7, 2.6, 0.3), { at: [1.2, 11.5, sz * 11.3], color: COL.white }));
  });

  // Rear wing on two struts, and the rear bumper with the tail lights.
  paint.push(P(rbox(7.2, 1.6, 30, 0.7), { at: [-24.8, 21.4, 0], rot: [0, 0, 0.1], shade: 1 }));
  mirror((sz) => paint.push(P(rbox(9.4, 7.6, 1.3, 0.6), { at: [-24.8, 19.4, sz * 15.3], shade: 0.68 })));
  mirror((sz) => fixed.push(P(rod([-21.5, 9, sz * 4.5], [-24.6, 20.6, sz * 4.5], 0.75), { color: COL.frame })));
  paint.push(P(rbox(4.4, 4.6, 30, 2), { at: [-25.8, 5.6, 0], shade: 0.86 }));
  mirror((sz) => lights.push(P(rbox(1, 1.9, 4.6, 0.45), { at: [-28, 6.2, sz * 9.2], color: COL.tail })));

  // Floor pan, axles, the steering column and the side bumpers.
  fixed.push(P(rbox(48, 2.2, 19, 1), { at: [0, 2.6, 0], color: COL.frame }));
  fixed.push(P(rod([-14, 8, -13], [-14, 8, 13], 1.15), { color: COL.steel }));
  fixed.push(P(rod([16, 6.4, -12], [16, 6.4, 12], 0.9), { color: COL.frame }));
  fixed.push(P(rod([12.6, 6.6, 0], [6.8, 14.2, 0], 0.75), { color: COL.frame }));
  mirror((sz) => fixed.push(P(tube([[9.2, 4.2, sz * 12.6], [7.6, 5.2, sz * 16.9], [-2, 5.2, sz * 16.9], [-5.4, 4.2, sz * 13]], 1.05, 20), { color: COL.tube })));

  // The seat.
  fixed.push(P(rbox(10.5, 2.8, 11.6, 1.3), { at: [-5.6, 6.2, 0], color: COL.seat }));
  fixed.push(P(rbox(3, 12.4, 12.6, 1.4), { at: [-12, 11.6, 0], rot: [0, 0, 0.22], color: COL.seat }));
  fixed.push(P(rbox(3.2, 1.3, 12.8, 0.5), { at: [-13.2, 16.4, 0], rot: [0, 0, 0.22], color: COL.seatTrim }));

  // The engine behind the seat: a block with a finned cylinder, an air filter and twin exhausts.
  fixed.push(P(rbox(9, 8, 10, 1.8), { at: [-18.4, 10, 0], color: COL.engine }));
  for (let i = 0; i < 4; i++) chrome.push(P(cyl(3.7, 3.7, 0.7, 22), { at: [-18.4, 14.6 + i * 1.15, 0], color: COL.chrome }));
  chrome.push(P(cyl(2.2, 2.6, 1.4, 18), { at: [-18.4, 19.4, 0], color: COL.chrome }));
  fixed.push(P(cyl(2.5, 2.5, 3.6, 18), { at: [-18.4, 10.4, -7], rot: [Math.PI / 2, 0, 0], color: '#e5484d' }));
  chrome.push(P(cyl(2.6, 2.6, 0.6, 18), { at: [-18.4, 10.4, -8.9], rot: [Math.PI / 2, 0, 0], color: COL.chrome }));
  mirror((sz) => {
    const [x, y, z] = EXHAUSTS[0];
    chrome.push(P(tube([[-16.5, 9, sz * 4.8], [-20.5, 9.6, sz * 7.6], [-25.5, 10.6, sz * 7.8], [x + 1.6, y - 0.4, sz * z]], 1.2, 22), { color: COL.chrome }));
    // The tip: a short flared pipe pointing back and a little up, dark inside.
    const dir = new THREE.Vector3(-1, 0.26, 0).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    chrome.push(P(cyl(1.3, 1.75, 2.8, 16, true), { at: [x + 0.4, y - 0.1, sz * z], quat: q, color: COL.chrome }));
    fixed.push(P(new THREE.CircleGeometry(1.5, 16), { at: [x - 0.9, y + 0.2, sz * z], quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), color: COL.grille }));
  });

  // Headlights on the nose.
  mirror((sz) => lights.push(P(ball(1.5, 14, 10), { at: [27.6, 7.4, sz * 4.4], scale: [0.5, 1, 1.15], color: COL.head })));

  kartGeo = { paint: merge(paint), fixed: merge(fixed), chrome: merge(chrome), lights: merge(lights) };
  return kartGeo;
}

// The steering wheel turns about its own z axis (towards the driver); B is its tilt in kart space.
const STEER_AT = new THREE.Vector3(6.8, 14.6, 0);
const STEER_Z = new THREE.Vector3(-1, 0.8, 0).normalize();
const STEER_X = new THREE.Vector3(0, 0, 1);
const STEER_Y = new THREE.Vector3().crossVectors(STEER_Z, STEER_X);
const STEER_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(STEER_X, STEER_Y, STEER_Z));
const STEER_R = 3.8;
const GRIP = 0.96; // the hands hold the rim 55 degrees either side of the top
const GLOVES = [1, -1].map((sz) => new THREE.Vector3(sz * STEER_R * Math.sin(GRIP), STEER_R * Math.cos(GRIP), 0.7));
let steerGeo = null;
function steeringGeometry() {
  if (steerGeo) return steerGeo;
  const g = [P(new THREE.TorusGeometry(STEER_R, 0.8, 10, 32), { color: '#262a32' })];
  for (const a of [0, Math.PI, -Math.PI / 2]) g.push(P(rbox(STEER_R, 0.9, 0.6, 0.3, 2), { at: [Math.cos(a) * STEER_R * 0.5, Math.sin(a) * STEER_R * 0.5, 0], rot: [0, 0, a], color: '#262a32' }));
  g.push(P(cyl(1.35, 1.35, 1.3, 18), { at: [0, 0, 0.3], rot: [Math.PI / 2, 0, 0], color: '#e5484d' }));
  for (const p of GLOVES) g.push(P(ball(1.9, 16, 12), { at: [p.x, p.y, p.z], scale: [1.05, 1.15, 0.95], color: COL.glove }));
  steerGeo = merge(g);
  return steerGeo;
}

// ---------- the driver ----------
const R = 10; // head radius
const HS = [1, 0.94, 1.05]; // the head is a little wide
// A point on the head's surface (and the outward normal there): az round from the nose towards +z,
// el up from the equator, `inset` units below the surface.
function surf(az, el, inset = 0) {
  const d = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  const n = new THREE.Vector3(d.x / HS[0], d.y / HS[1], d.z / HS[2]).normalize();
  const p = new THREE.Vector3(d.x * R * HS[0], d.y * R * HS[1], d.z * R * HS[2]).addScaledVector(n, -inset);
  return { p, n };
}
const at = (v) => [v.x, v.y, v.z];

const headCache = new Map();
// Head geometry for character `id` in head space (centre at the origin, face to +x):
// { fur, eyes, eyeY, ears: [{ geo, at, rot, side }] }. The eyes are their own mesh (they blink).
function headGeometry(id) {
  if (headCache.has(id)) return headCache.get(id);
  const c = CHARACTERS[id];
  const penguin = !!c.beak;
  const duck = !!c.bill;
  const fur = [P(ball(R, 36, 26), { scale: HS, color: c.fur })];
  const eyes = [];
  const ears = [];
  const glossy = (g, o) => eyes.push(P(g, o));

  // Eyes: glossy black with two catch-lights; some have whites round them.
  const eyeAz = c.frog ? 0.4 : penguin ? 0.3 : 0.35;
  const eyeEl = c.frog ? 0.64 : duck || penguin ? 0.16 : 0.08;
  let eyeY = 0;
  for (const side of [1, -1]) {
    const { p, n } = surf(side * eyeAz, eyeEl, c.frog ? -1.6 : 0.55);
    const q = facing(n);
    const zAx = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    eyeY = p.y;
    if (c.frog) {
      // Frog eyes bulge up out of the head.
      // (a fur lid over the top of each)
      const bulge = surf(side * eyeAz, eyeEl, 1.2).p;
      fur.push(P(ball(3.7, 20, 16), { at: at(bulge), color: '#ffffff' }));
      fur.push(P(new THREE.SphereGeometry(3.95, 20, 16, 0, Math.PI * 2, 0, 1.2), { at: at(bulge), quat: facing(n), color: c.fur }));
    }
    if (c.sclera || c.frog) glossy(ball(2.5, 18, 14), { at: at(p.clone().addScaledVector(n, -0.4)), quat: q, scale: [0.42, 1.12, 0.98], color: '#ffffff' });
    const pr = c.sclera || c.frog ? 1.45 : 1.85;
    const pc = p.clone().addScaledVector(n, c.sclera || c.frog ? 0.65 : 0);
    glossy(ball(pr, 18, 14), { at: at(pc), quat: q, scale: [0.5, 1.28, 1], color: COL.eye });
    glossy(ball(pr * 0.3, 10, 8), { at: at(pc.clone().addScaledVector(n, pr * 0.45).add(new THREE.Vector3(0, pr * 0.62, 0)).addScaledVector(zAx, -side * pr * 0.2)), color: '#ffffff' });
    glossy(ball(pr * 0.15, 8, 6), { at: at(pc.clone().addScaledVector(n, pr * 0.45).add(new THREE.Vector3(0, -pr * 0.45, 0)).addScaledVector(zAx, side * pr * 0.3)), color: '#ffffff' });
    // Patches round the eyes (panda), a bandit mask (raccoon).
    if (c.patches) fur.push(P(ball(2.9, 18, 14), { at: at(surf(side * (eyeAz + 0.04), eyeEl - 0.06, 0.9).p), quat: facing(n).multiply(_q.setFromEuler(_e.set(side * 0.5, 0, 0))), scale: [0.36, 1.25, 1.0], color: c.patches }));
    if (c.mask) fur.push(P(ball(3, 18, 14), { at: at(surf(side * (eyeAz + 0.08), eyeEl, 0.9).p), quat: facing(n), scale: [0.36, 0.85, 1.45], color: c.mask }));
    // Rosy cheeks.
    const ck = surf(side * 0.62, -0.22, 0.3);
    if (!c.frog) fur.push(P(ball(1.9, 14, 10), { at: at(ck.p), quat: facing(ck.n), scale: [0.3, 0.72, 1.15], color: COL.cheek }));
    else fur.push(P(ball(1.9, 14, 10), { at: at(surf(side * 0.6, 0.1, 0.3).p), quat: facing(surf(side * 0.6, 0.1).n), scale: [0.3, 0.72, 1.15], color: COL.cheek }));
  }

  // Muzzle, nose and mouth (or a beak, a bill, a snout).
  const front = (el, inset) => surf(0, el, inset);
  if (c.foxFace) {
    fur.push(P(ball(R * 0.78, 28, 20), { at: [R * 0.42, -3.6, 0], scale: [0.62, 0.62, 1.12], color: c.muzzle }));
  }
  if (penguin) {
    fur.push(P(ball(R * 0.9, 28, 20), { at: [R * 0.5, -0.8, 0], scale: [0.55, 0.82, 0.92], color: c.face }));
    for (const side of [1, -1]) fur.push(P(ball(R * 0.5, 20, 14), { at: [R * 0.62, 2.2, side * 2.8], scale: [0.6, 0.9, 0.9], color: c.face }));
    fur.push(P(new THREE.ConeGeometry(1.9, 4.6, 16), { at: [R * 1.08, -1.6, 0], rot: [0, 0, -Math.PI / 2], scale: [1, 1, 0.8], color: c.beak }));
  } else if (duck) {
    fur.push(P(rbox(6.4, 1.7, 6.8, 0.8), { at: [R * 1.04, -2.2, 0], rot: [0, 0, -0.1], color: c.bill }));
    fur.push(P(rbox(5.4, 1.2, 6, 0.55), { at: [R * 1.0, -3.6, 0], rot: [0, 0, 0.06], color: '#f08410' }));
  } else if (c.ears === 'fold') {
    // Pig: a round snout with two nostrils.
    const sn = front(-0.2, -0.6);
    fur.push(P(cyl(3, 3.1, 3, 22), { at: at(sn.p), rot: [0, 0, -Math.PI / 2], color: c.snout }));
    for (const side of [1, -1]) fur.push(P(ball(0.7, 10, 8), { at: [sn.p.x + 1.55, sn.p.y + 0.3, side * 1.1], scale: [0.4, 1.3, 1], color: '#c45478' }));
    fur.push(P(new THREE.TorusGeometry(1.2, 0.3, 6, 12, Math.PI), { at: [sn.p.x - 0.3, sn.p.y - 3.4, 0], rot: [0, Math.PI / 2, Math.PI], color: COL.mouth }));
  } else if (c.frog) {
    fur.push(P(new THREE.TorusGeometry(4.6, 0.45, 8, 24, Math.PI * 0.9), { at: [R * 0.84, -2.4, 0], rot: [0, Math.PI / 2, Math.PI * 1.05], scale: [1, 0.55, 1], color: '#2f6b2a' }));
    fur.push(P(ball(R * 0.85, 28, 20), { at: [R * 0.3, -4, 0], scale: [0.7, 0.55, 1.05], color: c.belly }));
  } else {
    // A muzzle (an ellipsoid on the front of the face) with the nose, mouth and whiskers on it;
    // without one (koala) they sit on the face itself.
    const big = c.dino ? 1.3 : 1;
    let on;
    if (c.muzzle) {
      const mc = surf(0, -0.3, 2.1 * big).p;
      const mr = new THREE.Vector3(2.9 * big, 3 * big, 4.3 * big);
      fur.push(P(ball(1, 22, 16), { at: at(mc), scale: [mr.x, mr.y, mr.z], color: c.muzzle }));
      // A point on the muzzle `out` units off its surface, el up and az round from its front.
      on = (el, az = 0, out = 0) => {
        const d = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        const n = new THREE.Vector3(d.x / mr.x, d.y / mr.y, d.z / mr.z).normalize();
        return { p: new THREE.Vector3(mc.x + d.x * mr.x, mc.y + d.y * mr.y, mc.z + d.z * mr.z).addScaledVector(n, out), n };
      };
    } else {
      on = (el, az = 0, out = 0) => { const f = surf(az * 0.5, -0.12 + el * 0.25, -out); return f; };
    }
    if (c.bigNose) {
      const nz = on(0.2, 0, 0.6);
      fur.push(P(ball(2.4, 18, 14), { at: at(nz.p), scale: [0.62, 1.3, 1], color: c.nose }));
    } else if (c.dino) {
      for (const side of [1, -1]) {
        const nz = on(0.5, side * 0.35, -0.15);
        fur.push(P(ball(0.6, 10, 8), { at: at(nz.p), quat: facing(nz.n), scale: [0.5, 1, 1], color: '#1f5f3e' }));
      }
    } else {
      const nz = on(0.62, 0, 0.35);
      fur.push(P(ball(1.35, 16, 12), { at: at(nz.p), quat: facing(nz.n), scale: [0.72, 0.7, 1.1], color: c.nose }));
    }
    // A little smile under the nose (a wide grin on the dino).
    const mo = on(-0.38, 0, 0.05);
    fur.push(P(new THREE.TorusGeometry(c.dino ? 2.2 : 1.15, 0.28, 6, 12, Math.PI), { at: at(mo.p), quat: facing(mo.n).multiply(_q.setFromEuler(_e.set(0, Math.PI / 2, Math.PI))), color: COL.mouth }));
    if (c.teeth) for (const side of [1, -1]) { const tp = on(-0.62, side * 0.12, -0.2); fur.push(P(rbox(0.85, 1.3, 0.75, 0.25, 2), { at: at(tp.p), quat: facing(tp.n), color: '#ffffff' })); }
    if (c.tongue) { const tp = on(-0.62, 0.1, 0.05); fur.push(P(ball(1.1, 12, 8), { at: at(tp.p), quat: facing(tp.n), scale: [0.5, 1, 0.85], color: '#ff6b8b' })); }
    if (c.whiskers) {
      for (const side of [1, -1]) {
        for (const tilt of [-0.2, 0, 0.2]) {
          const w0 = on(0.05 + tilt * 0.6, side * 0.75, -0.1).p;
          fur.push(P(rod(at(w0), [w0.x - 1.6, w0.y + tilt * 6, w0.z + side * 5.6], 0.16, 0.09, 5), { color: '#4b4f5a' }));
        }
      }
    }
  }
  // Lion's mane: a ring of puffs round the face.
  if (c.mane) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      fur.push(P(ball(3.8, 14, 10), { at: [-0.5, Math.sin(a) * R * 0.98 - 0.4, Math.cos(a) * R * 1.02], color: c.mane }));
    }
    fur.push(P(ball(R * 0.98, 28, 20), { at: [-2.2, 0, 0], color: c.mane }));
  }
  // Dino: spikes down the middle of the head.
  if (c.dino) {
    for (let i = 0; i < 5; i++) {
      const th = 1.25 + i * 0.42;
      const n = new THREE.Vector3(Math.cos(th), Math.sin(th), 0);
      fur.push(P(new THREE.ConeGeometry(1.9 - i * 0.12, 3.4 - i * 0.2, 12), { at: [Math.cos(th) * R * 0.98, Math.sin(th) * R * 0.92, 0], quat: new THREE.Quaternion().setFromUnitVectors(UP, n), scale: [1, 1, 0.55], color: c.spikes }));
    }
  }
  // Duck: a tuft on top.
  if (c.tuft) for (const [a, h] of [[-0.35, 3.6], [0, 4.6], [0.35, 3.4]]) fur.push(P(new THREE.ConeGeometry(0.9, h, 10), { at: [-1, R * HS[1] + h * 0.35, 0], rot: [a, 0, -0.35], color: c.fur }));

  // Ears, each its own mesh so it can swing: geometry in the ear's own space (it grows up +y and
  // faces +x), placed at its root on the head.
  const earFur = c.earFur || c.fur;
  const ear = (side, geo, root, rot) => ears.push({ geo, at: root, rot, side });
  for (const side of [1, -1]) {
    if (c.ears === 'round') {
      const e = c.ear;
      const g = [P(ball(e, 20, 14), { at: [0, e * 0.55, 0], scale: [0.42, 1, 1], color: earFur })];
      g.push(P(ball(e * 0.62, 16, 12), { at: [e * 0.22, e * 0.5, 0], scale: [0.26, 1, 1], color: c.inner }));
      ear(side, merge(g), surf(side * 1.3, 0.8, e * 0.3).p, [side * 0.38, -side * 0.25, 0]);
    } else if (c.ears === 'pointy') {
      const g = [P(new THREE.ConeGeometry(3.4, 7.6, 16), { at: [0, 3.4, 0], scale: [0.44, 1, 1], color: earFur })];
      g.push(P(new THREE.ConeGeometry(2.1, 5, 12), { at: [0.62, 3, 0], scale: [0.3, 1, 1], color: c.inner }));
      if (c.tip) g.push(P(new THREE.ConeGeometry(1.55, 2.8, 12), { at: [0.06, 5.98, 0], scale: [0.48, 1, 1], color: c.tip }));
      ear(side, merge(g), surf(side * 1.05, 0.95, 1.2).p, [side * 0.42, -side * 0.18, 0]);
    } else if (c.ears === 'long') {
      const g = [P(new THREE.CapsuleGeometry(2.45, 9.4, 6, 14), { at: [0, 7.1, 0], scale: [0.55, 1, 1.12], color: c.fur })];
      g.push(P(new THREE.CapsuleGeometry(1.5, 7.6, 6, 12), { at: [0.86, 7.4, 0], scale: [0.3, 1, 1], color: c.inner }));
      ear(side, merge(g), surf(side * 0.62, 1.1, 1).p, [side * 0.24, 0, 0.16]);
    } else if (c.ears === 'floppy') {
      // Hanging from the top of the head, flaring out at the tips.
      const g = [P(new THREE.CapsuleGeometry(3, 7.4, 6, 14), { at: [0, -4.6, 0], scale: [1, 1, 0.42], color: earFur })];
      ear(side, merge(g), surf(side * 1.3, 0.92, 0.9).p, [-side * 0.62, 0, 0.12]);
    } else if (c.ears === 'fold') {
      const g = [P(new THREE.ConeGeometry(3, 5.8, 14), { at: [0, 2.7, 0], scale: [0.42, 1, 1], color: c.fur })];
      g.push(P(new THREE.ConeGeometry(1.9, 4, 12), { at: [0.5, 2.4, 0], scale: [0.3, 1, 1], color: c.inner }));
      ear(side, merge(g), surf(side * 0.95, 0.98, 0.8).p, [side * 0.5, 0, -0.7]);
    }
  }
  const out = { fur: merge(fur), eyes: merge(eyes.map((g) => g.translate(0, -eyeY, 0))), eyeY, ears };
  headCache.set(id, out);
  return out;
}

// The driver's torso (suit) and an arm (it reaches up +y, 8.4 units long), painted like the kart.
let bodyGeo = null;
const ARM = 8.4;
const HIP = new THREE.Vector3(-6.6, 7.6, 0);
const SHOULDERS = [1, -1].map((sz) => new THREE.Vector3(-6.4, 17.8, sz * 5.4));
function bodyGeometry() {
  if (bodyGeo) return bodyGeo;
  const torso = [P(new THREE.CapsuleGeometry(4.8, 4.4, 6, 18), { at: [-7.1 - HIP.x, 13.5 - HIP.y, 0], rot: [0, 0, 0.14], scale: [0.95, 1, 1.2], shade: 1 })];
  // A white collar and a white stripe down each side of the suit.
  const collar = [P(new THREE.TorusGeometry(3.7, 1.05, 8, 22), { at: [-6.5 - HIP.x, 19.6 - HIP.y, 0], rot: [Math.PI / 2, 0, 0], color: COL.white })];
  const arm = P(new THREE.CapsuleGeometry(1.75, ARM - 3.5, 4, 12), { at: [0, ARM / 2, 0], shade: 1 });
  bodyGeo = { torso: merge(torso), collar: merge(collar), arm };
  return bodyGeo;
}

// ---------- materials ----------
// Shared (except the paint, one per kart); all take the environment map that setEnvironment gives.
let MATS = null;
const envMats = new Set();
let ENV = null;
let envK = 1; // dimmer reflections at night
function env(m, k) {
  m.envMap = ENV;
  m.userData.env = k;
  m.envMapIntensity = k * envK;
  envMats.add(m);
  return m;
}
function mats() {
  if (MATS) return MATS;
  MATS = {
    fixed: env(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.08 }), 0.55),
    chrome: env(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2, metalness: 1 }), 1.1),
    wheel: env(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58, metalness: 0.1 }), 0.5),
    fur: env(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }), 0.4),
    eyes: env(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0 }), 1.3),
    lights: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
  return MATS;
}
// An environment map (a PMREM texture for this renderer) for the karts' reflections.
export function setEnvironment(texture, night) {
  ENV = texture;
  envK = night ? 0.35 : 1;
  mats();
  for (const m of envMats) {
    m.envMap = texture;
    m.envMapIntensity = m.userData.env * envK;
    m.needsUpdate = true;
  }
  MATS.lights.color.setScalar(night ? 2.4 : 1);
}
// The materials every kart shares (and a paint), for compiling them and their star versions up front.
export function kartMaterials() {
  const m = mats();
  m.samplePaint = m.samplePaint || paintMaterial('#ff0000');
  return [m.fixed, m.chrome, m.wheel, m.fur, m.eyes, m.lights, m.samplePaint];
}
function paintMaterial(color) {
  return env(new THREE.MeshStandardMaterial({ color: new THREE.Color(color), vertexColors: true, roughness: 0.34, metalness: 0.22 }), 0.45);
}

// ---------- one kart ----------
// Everything for kart `meta` ({ character, avatar }) painted `paint`. Returns
// { parts: [{ mesh, shadow, detail }] (every mesh), chassis: [meshes], driver, wheels: [{ pivot,
// spin, r, front, mesh }], rig, halo, top, dispose }: the chassis meshes and the driver go in the
// kart's body (it rolls and pitches on its springs), the wheel pivots straight in the kart.
export function buildGoKart(meta, paint) {
  const M = mats();
  const id = CHARACTERS[meta.character] ? meta.character : 'bunny';
  const c = CHARACTERS[id];
  const paintMat = paintMaterial(paint);
  const K = kartGeometry();
  const out = [];
  const mesh = (geo, mat, shadow = false, detail = false) => {
    const m = new THREE.Mesh(geo, mat);
    out.push({ mesh: m, shadow, detail });
    return m;
  };
  mesh(K.paint, paintMat, true);
  mesh(K.fixed, M.fixed, true);
  mesh(K.chrome, M.chrome, false, true);
  mesh(K.lights, M.lights, false, true);

  // The wheels.
  const wheels = WHEELS.map(([x, z, r, w, front]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    const spin = new THREE.Group();
    pivot.add(spin);
    const m = new THREE.Mesh(wheelGeometry(r, w, c.rim), M.wheel);
    if (z < 0) m.rotation.y = Math.PI; // the rim faces out on both sides
    m.castShadow = true;
    m.receiveShadow = true;
    spin.add(m);
    return { pivot, spin, r, front, mesh: m };
  });

  // The steering wheel (with the gloves on it).
  const steer = mesh(steeringGeometry(), M.fixed);
  steer.position.copy(STEER_AT);
  steer.quaternion.copy(STEER_Q);

  // The driver: a body that leans (from the hips), arms that reach for the wheel, the head.
  const body = bodyGeometry();
  const driver = new THREE.Group();
  driver.position.copy(HIP);
  const torso = mesh(body.torso, paintMat, true);
  const collar = mesh(body.collar, M.fixed);
  driver.add(torso, collar);
  const arms = SHOULDERS.map(() => mesh(body.arm, paintMat));
  const H = headGeometry(id);
  const head = new THREE.Group();
  head.position.set(HEAD[0] - HIP.x, HEAD[1] - HIP.y, 0);
  driver.add(head);
  head.add(mesh(H.fur, M.fur, true));
  const eyes = mesh(H.eyes, M.eyes, false, true);
  eyes.position.y = H.eyeY;
  head.add(eyes);
  const ears = H.ears.map((e) => {
    const root = new THREE.Group();
    root.position.copy(e.at);
    root.rotation.set(e.rot[0], e.rot[1], e.rot[2]);
    const m = mesh(e.geo, M.fur, true);
    root.add(m);
    head.add(root);
    return { mesh: m, side: e.side };
  });
  let halo = null;
  const hat = hatFor(meta.avatar);
  if (hat) {
    // On the crown of the head, tipped back a touch.
    const crown = new THREE.Group();
    crown.position.set(0.4, R * HS[1] - 0.6, 0);
    crown.scale.setScalar(1.06);
    crown.rotation.z = -0.08;
    const m = mesh(hat.mesh.geometry, hat.mesh.material, true);
    m.position.copy(hat.mesh.position);
    crown.add(m);
    head.add(crown);
    if (hat.kind === 'halo') halo = m;
  }

  const rig = new DriverRig({ driver, head, eyes, ears, arms, steer });
  // How high the driver reaches (ears and hat included), for the name tag.
  driver.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(head).max.y;
  return {
    top,
    chassis: out.filter((o) => !o.mesh.parent).map((o) => o.mesh),
    parts: out,
    driver,
    wheels,
    rig,
    halo,
    dispose: () => { envMats.delete(paintMat); paintMat.dispose(); },
  };
}

// ---------- bringing the driver to life ----------
const _hand = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lean = new THREE.Quaternion();
const _x = new THREE.Vector3(1, 0, 0);
const _z = new THREE.Vector3(0, 0, 1);
class DriverRig {
  constructor(p) {
    Object.assign(this, p);
    this.blinkIn = 0.5 + Math.random() * 3;
    this.blinkT = -1;
    this.earP = 0; this.earVP = 0; // ear swing back (+) and forward
    this.earR = 0; this.earVR = 0; // ear swing towards +z
    this.look = 0;
    this.lastSpeed = 0;
    this.shut = 0; // eyes squeezed shut (hit) for this long
    this.dizzy = 0;
    this.lean = 0;
  }

  // Something knocked the kart: the ears flop and the eyes squeeze shut.
  jolt(power = 1, hurt = false) {
    this.earVP -= 7 * power;
    this.earVR += (Math.random() - 0.5) * 10 * power;
    if (hurt) this.shut = 0.45;
  }

  // st: { steer (-1..1, + is right), speed, airborne, boosting, spinning }
  update(dt, t, st) {
    if (dt <= 0) return;
    const step = Math.min(dt, 1 / 30);
    // Blinking (now and then a double blink); shut tight while hurt or spinning out.
    this.blinkIn -= dt;
    if (this.blinkIn < 0 && this.blinkT < 0) this.blinkT = 0;
    let open = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / 0.13;
      open = 1 - 0.92 * Math.sin(Math.min(1, p) * Math.PI);
      if (p >= 1) { this.blinkT = -1; this.blinkIn = Math.random() < 0.2 ? 0.12 : 1.6 + Math.random() * 3.6; }
    }
    this.shut = Math.max(0, this.shut - dt);
    if (this.shut > 0 || st.spinning) open = 0.1;
    this.eyes.scale.y = open;

    // Ears on springs: acceleration and wind sweep them back, braking throws them forward, turns
    // swing them to the outside, and they lift in the air.
    const accel = Math.max(-2500, Math.min(2500, (st.speed - this.lastSpeed) / dt));
    this.lastSpeed = st.speed;
    const tP = Math.max(-0.5, Math.min(0.75, accel * 0.00022 + Math.abs(st.speed) * 0.00045 + (st.boosting ? 0.35 : 0) - (st.airborne ? 0.4 : 0)));
    const tR = -st.steer * 0.45 * Math.min(1, Math.abs(st.speed) / 250);
    const w = 13;
    const z = 0.18;
    this.earVP += (-(w * w) * (this.earP - tP) - 2 * z * w * this.earVP) * step;
    this.earP += this.earVP * step;
    this.earVR += (-(w * w) * (this.earR - tR) - 2 * z * w * this.earVR) * step;
    this.earR += this.earVR * step;
    for (const e of this.ears) {
      e.mesh.rotation.z = this.earP;
      e.mesh.rotation.x = this.earR * (e.side > 0 ? 1 : 0.8);
    }

    // The head looks into the turn (and wobbles when spun out); the body leans in.
    this.look += (st.steer * 0.32 - this.look) * Math.min(1, dt * 7);
    this.head.rotation.set(st.steer * 0.08, -this.look, st.spinning ? Math.sin(t * 16) * 0.22 : 0);
    this.lean += (st.steer * 0.13 - this.lean) * Math.min(1, dt * 6);
    this.driver.rotation.x = this.lean;
    this.head.position.y = HEAD[1] - HIP.y + (st.airborne ? 0 : Math.sin(t * 15) * 0.18 * Math.min(1, Math.abs(st.speed) / 300));

    // The wheel turns with the steering, and the arms follow the hands.
    const turn = -st.steer * 1.15;
    this.steer.quaternion.copy(STEER_Q).multiply(_lean.setFromAxisAngle(_z, turn));
    _lean.setFromAxisAngle(_x, this.lean);
    for (let i = 0; i < 2; i++) {
      _hand.copy(GLOVES[i]).applyQuaternion(this.steer.quaternion).add(STEER_AT);
      _sh.copy(SHOULDERS[i]).sub(HIP).applyQuaternion(_lean).add(HIP);
      _dir.subVectors(_hand, _sh);
      const len = _dir.length();
      const arm = this.arms[i];
      arm.position.copy(_sh);
      arm.quaternion.setFromUnitVectors(UP, _dir.multiplyScalar(1 / len));
      arm.scale.set(1, len / ARM, 1);
    }
  }
}
