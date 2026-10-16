// Power-up models and effects for Kart Battle: projectiles, dropped items, item boxes, what karts
// carry (trailing bananas, orbiting rockets, a minigun) and their auras (shield, ghost, star), plus
// one-shot effects (shock rings, thunder bolts, comet blasts, debris).
// Everything is pooled or instanced: meshes are hidden and reused, never rebuilt per shot.
// Every item sits at ground(x, z) + offset so it follows hills on maps that have them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MOBILE, part, canvasTexture, tex } from './world.js';

const K = window.KartCore;
const TAU = Math.PI * 2;
const SHOT = { rocket: 1, bullet: 2, bomb: 3, bouncer: 4, comet: 5 };
const CODE = Object.fromEntries(K.ITEMS.map((id, i) => [id, i + 1]));
const FLAG = { spin: 1, boost: 2, shield: 4, dead: 32, ghost: 1024, gun: 2048, star: 4096, shrunk: 8192, inked: 16384 };
const TIME = { value: 0 }; // shared by every animated item material
// Item models are built at toy scale and blown up so they read clearly from the chase camera.
const SIZE = { rocket: 1.6, shell: 1.45, bomb: 1.35, mine: 1.4, peel: [1.9, 1.5, 1.9], comet: 1.9 };
const scaleAll = (obj, s) => { for (const g of Object.values(obj)) if (g && g.isBufferGeometry) g.scale(s, s, s); };

const rand = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- shaders ----------
const VIEW_VERT = `
  varying vec3 vN; varying vec3 vV; varying vec3 vW; varying vec3 vL;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vL = position;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - w.xyz);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const HUE = 'vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }';
const FRESNEL = (p) => `float fres(vec3 n, vec3 v) { return pow(1.0 - abs(dot(normalize(n), normalize(v))), ${p}); }`;

function viewMaterial(frag, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: TIME, ...(extra.uniforms || {}) },
    vertexShader: VIEW_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: extra.blending ?? THREE.AdditiveBlending,
    side: extra.side ?? THREE.FrontSide,
    depthFunc: extra.depthFunc ?? THREE.LessEqualDepth,
  });
}

// Kart auras, shared with kart3d.js (one material each for every kart and every game).
const AURA = {};
// Shield: a glassy bubble with a bright rim, drifting cells and a band sweeping up.
export function shieldMaterial() {
  return AURA.shield || (AURA.shield = viewMaterial(`
    uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vL; ${FRESNEL('2.4')}
    void main() {
      float f = fres(vN, vV);
      vec3 p = normalize(vL) * 7.0;
      float cells = sin(p.x * 2.1 + uTime * 0.9) * sin(p.y * 2.3 - uTime * 1.2) * sin(p.z * 2.2 + uTime * 0.6);
      float lines = smoothstep(0.1, 0.0, abs(cells)) * 0.35;
      float sweep = smoothstep(0.86, 1.0, sin(vL.y * 0.16 - uTime * 3.2));
      vec3 col = vec3(0.3, 0.68, 1.0) * (0.3 + 1.7 * f) + vec3(0.85, 0.96, 1.0) * (sweep * 0.55 + lines * (0.25 + f));
      gl_FragColor = vec4(col, 0.1 + 0.8 * f + sweep * 0.3 + lines * 0.3);
    }`));
}
export function shieldGeometry() {
  if (AURA.shieldGeo) return AURA.shieldGeo;
  const g = new THREE.SphereGeometry(1, 32, 20);
  g.scale(31, 24, 26);
  g.computeVertexNormals();
  return (AURA.shieldGeo = g);
}
// Ghost: see-through, with a rim and scanlines rolling up the kart.
export function ghostMaterial() {
  return AURA.ghost || (AURA.ghost = viewMaterial(`
    uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vW; ${FRESNEL('2.0')}
    void main() {
      float f = fres(vN, vV);
      float scan = 0.5 + 0.5 * sin(vW.y * 1.1 - uTime * 9.0);
      float flick = 0.82 + 0.18 * sin(uTime * 21.0 + vW.x * 0.05);
      vec3 col = mix(vec3(0.55, 0.72, 1.0), vec3(0.96, 0.98, 1.0), f);
      gl_FragColor = vec4(col, (0.08 + 0.55 * f + 0.1 * scan) * flick);
    }`, { blending: THREE.NormalBlending }));
}
// Star: a glow behind the kart that cycles through the rainbow (one material, every star kart in step).
function starAura() {
  return AURA.aura || (AURA.aura = new THREE.SpriteMaterial({ map: tex.spark(), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
}
// Star: a rainbow sheen laid over every part of the kart.
function starMaterial() {
  return AURA.star || (AURA.star = viewMaterial(`
    uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vW; ${FRESNEL('1.3')} ${HUE}
    void main() {
      float f = fres(vN, vV);
      float h = fract(uTime * 1.6 + vW.y * 0.012 + (vW.x + vW.z) * 0.002);
      float pulse = 0.75 + 0.25 * sin(uTime * 14.0);
      gl_FragColor = vec4(hue(h) * (0.5 + 1.7 * f) * pulse, 1.0);
    }`));
}

// ---------- textures ----------
const TEX = {};
function hexShellTexture() {
  return TEX.shell || (TEX.shell = canvasTexture(256, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#a7f3d0'); g.addColorStop(0.5, '#34d399'); g.addColorStop(1, '#059669');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const r = 18;
    c.lineWidth = 5; c.strokeStyle = '#065f46';
    for (let row = -1; row < h / (r * 1.5) + 1; row++) {
      for (let col = -1; col < w / (r * 1.732) + 1; col++) {
        const cx = col * r * 1.732 + (row % 2 ? r * 0.866 : 0);
        const cy = row * r * 1.5;
        c.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3;
          c[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
        }
        c.closePath();
        c.fillStyle = 'rgba(255,255,255,0.12)'; c.fill();
        c.stroke();
      }
    }
  }));
}
function questionTexture() {
  return TEX.question || (TEX.question = canvasTexture(128, 128, (c, w, h) => {
    c.font = '900 104px "Trebuchet MS", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(255,255,255,0.9)'; c.shadowBlur = 14;
    c.lineWidth = 12; c.strokeStyle = '#3b1a7a'; c.strokeText('?', w / 2, h / 2 + 6);
    c.shadowBlur = 0; c.fillStyle = '#fff'; c.fillText('?', w / 2, h / 2 + 6);
  }, false));
}
// A bolt is a ribbon with this across it: a white-hot core in a blue glow.
function boltTexture() {
  return TEX.bolt || (TEX.bolt = canvasTexture(64, 4, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(80,140,255,0)'); g.addColorStop(0.3, 'rgba(110,170,255,0.45)');
    g.addColorStop(0.46, 'rgba(235,245,255,1)'); g.addColorStop(0.54, 'rgba(235,245,255,1)');
    g.addColorStop(0.7, 'rgba(110,170,255,0.45)'); g.addColorStop(1, 'rgba(80,140,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, false));
}
function flashTexture() {
  return TEX.flash || (TEX.flash = canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,240,1)'); g.addColorStop(0.25, 'rgba(255,220,120,0.9)'); g.addColorStop(1, 'rgba(255,140,30,0)');
    c.fillStyle = g;
    c.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const r = i % 2 ? w * 0.16 : w * 0.5;
      c[i ? 'lineTo' : 'moveTo'](w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
    }
    c.closePath(); c.fill();
  }, false));
}

// ---------- models (geometry and materials built once, reused by every game) ----------
const M = {};
function std(color, roughness = 0.4, metalness = 0.1, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}
function glow(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
}
function hdr(r, g, b) { return new THREE.Color(r, g, b); }

function models() {
  if (M.ready) return M;
  // Rocket (points +x): red body, white nose and band, yellow fins, glass porthole, steel nozzle.
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(-7, 0); finShape.lineTo(-9.5, 6.5); finShape.lineTo(-4.5, 6.5); finShape.closePath();
  const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.9, bevelEnabled: false }).translate(-1.5, 2.4, -0.45);
  M.rocket = {
    body: part(new THREE.CylinderGeometry(3.2, 3.2, 15, 16), 0, 0, 0, 0, 0, Math.PI / 2),
    white: mergeGeometries([
      part(new THREE.ConeGeometry(3.2, 9, 16), 12, 0, 0, 0, 0, -Math.PI / 2),
      part(new THREE.CylinderGeometry(3.35, 3.35, 2.2, 16), 4, 0, 0, 0, 0, Math.PI / 2),
    ]),
    fins: mergeGeometries([0, 1, 2, 3].map((i) => part(fin, 0, 0, 0, (i * Math.PI) / 2 + Math.PI / 4, 0, 0))),
    nozzle: part(new THREE.CylinderGeometry(2.3, 3, 3, 12), -9, 0, 0, 0, 0, Math.PI / 2),
    glass: part(new THREE.SphereGeometry(1.7, 12, 8), 0, 2.7, 0),
    flame: new THREE.ConeGeometry(2.8, 16, 12, 1, true).rotateZ(Math.PI / 2).translate(-18.5, 0, 0),
    core: new THREE.ConeGeometry(1.5, 9, 10, 1, true).rotateZ(Math.PI / 2).translate(-15, 0, 0),
    redMat: std(0xef233c, 0.28, 0.35), whiteMat: std(0xf8fafc, 0.25, 0.2), finMat: std(0xfbbf24, 0.35, 0.3),
    steelMat: std(0x4b5563, 0.3, 0.9), glassMat: std(0x7dd3fc, 0.05, 0.3, { emissive: 0x0ea5e9, emissiveIntensity: 0.5 }),
    flameMat: glow(hdr(2.2, 0.9, 0.25), 0.9), coreMat: glow(hdr(2.6, 2.4, 1.7), 1),
  };
  scaleAll(M.rocket, SIZE.rocket);
  // Bouncer shell: hex-plated dome on a white rim and dark base.
  M.shell = {
    dome: new THREE.SphereGeometry(10, 28, 14, 0, TAU, 0, Math.PI / 2).scale(1, 0.8, 1).translate(0, 3.2, 0),
    rim: new THREE.TorusGeometry(10.1, 2.2, 10, 32).rotateX(Math.PI / 2).translate(0, 3.2, 0),
    base: new THREE.CylinderGeometry(9.6, 8, 3.2, 28).translate(0, 1.6, 0),
    domeMat: std(0xffffff, 0.18, 0.05, { map: hexShellTexture(), emissive: 0x064e3b, emissiveIntensity: 0.25 }),
    rimMat: std(0xf8fafc, 0.3, 0.1), baseMat: std(0x1e293b, 0.6, 0.2),
  };
  scaleAll(M.shell, SIZE.shell);
  // Comet: a white-hot core in a crown of crystal spikes, a spinning halo ring and a glow.
  const spikes = [];
  for (let i = 0; i < 10; i++) {
    const y = 1 - (i + 0.5) / 5; // fibonacci-ish spread over the sphere
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * 2.4;
    const dir = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r).normalize();
    const g = new THREE.ConeGeometry(2.4, 11, 6).translate(0, 9, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    spikes.push(g.index ? g.toNonIndexed() : g);
  }
  M.comet = {
    core: new THREE.IcosahedronGeometry(8, 2), spikes: mergeGeometries(spikes),
    ring: new THREE.TorusGeometry(15, 1.1, 8, 40),
    coreMat: new THREE.MeshBasicMaterial({ color: hdr(1.5, 1.9, 3.4) }),
    spikeMat: std(0x4c1d95, 0.15, 0.5, { emissive: 0x5b21b6, emissiveIntensity: 0.9 }),
    ringMat: glow(hdr(1.4, 0.7, 2.6), 0.9),
    haloMat: new THREE.SpriteMaterial({ map: tex.spark(), color: 0x6a5cff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  scaleAll(M.comet, SIZE.comet);
  // Bomb: glossy black sphere, gold band, steel cap, a curling fuse with a sparking tip.
  const fuseCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 10.5, 0), new THREE.Vector3(1, 13.5, 0.4), new THREE.Vector3(3.6, 15.2, 0.6), new THREE.Vector3(5.2, 14.4, 0.2)]);
  M.bomb = {
    ball: new THREE.SphereGeometry(9, 24, 16),
    band: new THREE.TorusGeometry(9.05, 1.1, 8, 32).rotateX(Math.PI / 2),
    cap: new THREE.CylinderGeometry(3, 3.4, 3.4, 14).translate(0, 9.6, 0),
    fuse: new THREE.TubeGeometry(fuseCurve, 12, 0.75, 6),
    tip: new THREE.Vector3(5.2, 14.4, 0.2),
    ballMat: std(0x1b2030, 0.22, 0.65), bandMat: std(0xf59e0b, 0.3, 0.8), capMat: std(0x9ca3af, 0.3, 0.9), fuseMat: std(0x92400e, 0.8, 0),
    sparkMat: new THREE.SpriteMaterial({ map: tex.spark(), color: 0xffb347, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  scaleAll(M.bomb, SIZE.bomb);
  M.bomb.tip.multiplyScalar(SIZE.bomb);
  // Mine: a squat metal disc, hazard band, spikes and a light dome that blinks.
  const mineSpikes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    mineSpikes.push(part(new THREE.ConeGeometry(1.5, 6, 8), Math.cos(a) * 11, 4, Math.sin(a) * 11, 0, -a, -Math.PI / 2));
  }
  M.mine = {
    body: mergeGeometries([
      part(new THREE.SphereGeometry(10, 22, 12).scale(1, 0.5, 1), 0, 4, 0),
      part(new THREE.CylinderGeometry(8, 9.5, 1.6, 22), 0, 0.8, 0),
      ...mineSpikes,
    ]),
    band: new THREE.TorusGeometry(9.7, 1.2, 8, 30).rotateX(Math.PI / 2).translate(0, 4, 0),
    light: new THREE.SphereGeometry(2.8, 14, 8, 0, TAU, 0, Math.PI / 2).translate(0, 8.2, 0),
    bodyMat: std(0x2f3440, 0.35, 0.75), bandMat: std(0xfacc15, 0.4, 0.3),
    lightOff: std(0x7f1d1d, 0.3, 0.1), lightOn: new THREE.MeshBasicMaterial({ color: hdr(3, 0.25, 0.2) }),
    lightArming: new THREE.MeshBasicMaterial({ color: hdr(2.4, 1.8, 0.2) }),
    glowMat: new THREE.SpriteMaterial({ map: tex.spark(), color: 0xff3030, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  scaleAll(M.mine, SIZE.mine);
  // Banana peel: four petals drooping from the open top to the ground, tips browned.
  M.peel = peelGeometry().scale(...SIZE.peel);
  M.peelMat = std(0xffffff, 0.5, 0, { vertexColors: true, side: THREE.DoubleSide });
  // Minigun: six barrels around a hub, mounted on the kart's nose.
  const barrels = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    barrels.push(part(new THREE.CylinderGeometry(0.75, 0.75, 15, 8), 9, Math.cos(a) * 2.1, Math.sin(a) * 2.1, 0, 0, Math.PI / 2));
  }
  M.gun = {
    barrels: mergeGeometries([...barrels, part(new THREE.CylinderGeometry(3, 3, 1.4, 14), 14, 0, 0, 0, 0, Math.PI / 2)]),
    housing: mergeGeometries([
      part(new RoundedBoxGeometry(8, 6.5, 7, 2, 1.5), -1, 0, 0),
      part(new THREE.CylinderGeometry(3.4, 3.4, 4, 14), 3.5, 0, 0, 0, 0, Math.PI / 2),
      part(new THREE.BoxGeometry(3, 6, 2.5), -2, -5, 0),
    ]),
    barrelMat: std(0x9ca3af, 0.25, 0.95), housingMat: std(0x1f2937, 0.4, 0.6),
    flashMat: new THREE.MeshBasicMaterial({ map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: hdr(2.5, 2.2, 1.6) }),
    flash: mergeGeometries([new THREE.PlaneGeometry(16, 16), new THREE.PlaneGeometry(16, 16).rotateX(Math.PI / 2)]).rotateZ(Math.PI / 2),
  };
  // Item box: rounded glass cube, plus the "?" inside.
  M.box = new RoundedBoxGeometry(24, 24, 24, 3, 4);
  M.questionMat = new THREE.SpriteMaterial({ map: questionTexture(), transparent: true, depthWrite: false });
  // Markers on the ground.
  M.ring = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
  M.disc = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  M.tick = new THREE.PlaneGeometry(0.1, 0.35).rotateX(-Math.PI / 2);
  M.tracer = new THREE.CylinderGeometry(1.5, 0.7, 1, 6, 1, true).rotateZ(Math.PI / 2);
  M.debris = new THREE.BoxGeometry(1, 1, 1);
  M.ready = true;
  return M;
}

function peelGeometry() {
  const parts = [];
  const lin = (hex) => new THREE.Color(hex).toArray();
  const YELLOW = lin(0xffd21a);
  const PALE = lin(0xfff1a0);
  const BROWN = lin(0x6b4214);
  const petals = 4;
  for (let p = 0; p < petals; p++) {
    const a0 = (p / petals) * TAU + 0.35;
    const segs = 10;
    const cols = 4;
    const pos = [];
    const col = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const r = 2 + 12 * Math.sin(t * Math.PI * 0.5);
      const y = 10 * (1 - t) ** 1.7 + 0.7 + Math.max(0, t - 0.82) * 10; // the tip curls up off the ground
      const w = 5 * Math.sin(Math.PI * (0.16 + 0.84 * t)) + 0.5; // widest in the middle, pointed tip
      for (let j = 0; j <= cols; j++) {
        const s = j / cols - 0.5;
        const ang = a0 + (s * w) / Math.max(r, 2.5);
        const cup = Math.abs(s) * 2.2 * Math.sin(t * Math.PI); // edges curl up: a cupped petal
        pos.push(Math.cos(ang) * r, y + cup, Math.sin(ang) * r);
        const c = t > 0.86 ? BROWN : Math.abs(s) < 0.2 && t > 0.15 ? PALE : YELLOW;
        col.push(...c);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < cols; j++) {
        const a = i * (cols + 1) + j;
        const b = a + cols + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }
  const colored = (geo, c) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => c), 3));
    return g;
  };
  parts.push(colored(new THREE.CylinderGeometry(2.6, 2.1, 4.5, 12).translate(0, 9, 0), YELLOW));
  parts.push(colored(new THREE.CylinderGeometry(1.1, 1.5, 3.6, 8).translate(0, 12.8, 0), BROWN));
  return mergeGeometries(parts);
}

function buildModel(kind) {
  const m = models();
  const g = new THREE.Group();
  const mesh = (geo, mat, shadow = true) => {
    const x = new THREE.Mesh(geo, mat);
    x.castShadow = shadow;
    return x;
  };
  if (kind === 'rocket' || kind === 'mini') {
    const R = m.rocket;
    const spin = new THREE.Group(); // rolls around its own axis in flight
    spin.add(mesh(R.body, R.redMat), mesh(R.white, R.whiteMat), mesh(R.fins, R.finMat), mesh(R.nozzle, R.steelMat), mesh(R.glass, R.glassMat, false));
    g.add(spin);
    g.userData.spin = spin;
    if (kind === 'rocket') {
      const flame = mesh(R.flame, R.flameMat, false);
      const core = mesh(R.core, R.coreMat, false);
      g.add(flame, core);
      g.userData.flames = [flame, core];
    }
  } else if (kind === 'bouncer') {
    const S = m.shell;
    const spin = new THREE.Group();
    spin.add(mesh(S.dome, S.domeMat), mesh(S.rim, S.rimMat), mesh(S.base, S.baseMat));
    g.add(spin);
    g.userData.spin = spin;
  } else if (kind === 'comet') {
    const C = m.comet;
    const spin = new THREE.Group();
    spin.add(mesh(C.core, C.coreMat, false), mesh(C.spikes, C.spikeMat));
    const ring = mesh(C.ring, C.ringMat, false);
    const halo = new THREE.Sprite(C.haloMat);
    halo.scale.set(100, 100, 1);
    g.add(spin, ring, halo);
    Object.assign(g.userData, { spin, ring, halo });
  } else if (kind === 'bomb') {
    const B = m.bomb;
    const tumble = new THREE.Group();
    tumble.add(mesh(B.ball, B.ballMat), mesh(B.band, B.bandMat), mesh(B.cap, B.capMat), mesh(B.fuse, B.fuseMat, false));
    const spark = new THREE.Sprite(B.sparkMat);
    spark.position.copy(B.tip);
    spark.scale.set(16, 16, 1);
    tumble.add(spark);
    g.add(tumble);
    Object.assign(g.userData, { spin: tumble, spark });
  } else if (kind === 'mine') {
    const N = m.mine;
    const light = mesh(N.light, N.lightOff, false);
    const halo = new THREE.Sprite(N.glowMat);
    halo.position.y = 9.5 * SIZE.mine;
    halo.scale.set(30, 30, 1);
    g.add(mesh(N.body, N.bodyMat), mesh(N.band, N.bandMat), light, halo);
    Object.assign(g.userData, { light, halo });
  } else if (kind === 'banana') {
    g.add(mesh(m.peel, m.peelMat));
  }
  g.userData.kind = kind;
  return g;
}

// ---------- small instanced systems ----------
// Tumbling debris (box shards, shell fragments, peel bits) as one instanced mesh.
class Debris {
  constructor(scene, max, ground) {
    this.max = max;
    this.ground = ground;
    this.n = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.r = new Float32Array(max * 3);
    this.w = new Float32Array(max * 3);
    this.s = new Float32Array(max);
    this.life = new Float32Array(max);
    this.cols = new Array(max).fill(null).map(() => new THREE.Color());
    this.mesh = new THREE.InstancedMesh(models().debris, std(0xffffff, 0.35, 0.2, { emissive: 0x222222 }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.m4 = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.v3 = new THREE.Vector3();
    this.sc = new THREE.Vector3();
  }

  emit(x, y, z, vx, vy, vz, size, color, life) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.p.set([x, y, z], i * 3);
    this.v.set([vx, vy, vz], i * 3);
    this.r.set([rand(0, TAU), rand(0, TAU), 0], i * 3);
    this.w.set([rand(-12, 12), rand(-12, 12), rand(-12, 12)], i * 3);
    this.s[i] = size;
    this.life[i] = life;
    this.cols[i].set(color);
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.n;
        if (i !== last) {
          for (const arr of [this.p, this.v, this.r, this.w]) arr.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.s[i] = this.s[last];
          this.life[i] = this.life[last];
          this.cols[i].copy(this.cols[last]);
        }
        continue;
      }
      const o = i * 3;
      this.v[o + 1] -= 900 * dt;
      for (let k = 0; k < 3; k++) { this.p[o + k] += this.v[o + k] * dt; this.r[o + k] += this.w[o + k] * dt; }
      const floor = this.ground(this.p[o], this.p[o + 2]) + this.s[i] * 0.5;
      if (this.p[o + 1] < floor) {
        this.p[o + 1] = floor;
        this.v[o + 1] = Math.abs(this.v[o + 1]) * 0.35;
        this.v[o] *= 0.6; this.v[o + 2] *= 0.6;
        for (let k = 0; k < 3; k++) this.w[o + k] *= 0.5;
      }
      const shrink = Math.min(1, this.life[i] / 0.3);
      this.q.setFromEuler(this.e.set(this.r[o], this.r[o + 1], this.r[o + 2]));
      this.m4.compose(this.v3.set(this.p[o], this.p[o + 1], this.p[o + 2]), this.q, this.sc.setScalar(this.s[i] * shrink));
      this.mesh.setMatrixAt(i, this.m4);
      this.mesh.setColorAt(i, this.cols[i]);
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() { this.mesh.material.dispose(); this.mesh.dispose(); }
}

// Lightning: camera-facing ribbons along a jagged path, rebuilt in place (fixed vertex count).
const BOLT_POINTS = 17;
class Bolt {
  constructor(scene) {
    const n = BOLT_POINTS;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    for (let i = 0; i < n; i++) {
      uv.set([0, i / (n - 1), 1, i / (n - 1)], i * 4);
      if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({ map: boltTexture(), color: hdr(2.2, 2.4, 3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.pts = new Array(n).fill(null).map(() => new THREE.Vector3());
  }

  // Jagged path from a to b (midpoint displacement), `rough` = sideways jitter per unit length.
  shape(a, b, width, rough, camera) {
    const n = BOLT_POINTS;
    const pts = this.pts;
    pts[0].copy(a);
    pts[n - 1].copy(b);
    for (let step = n - 1; step > 1; step >>= 1) {
      for (let i = step >> 1; i < n; i += step) {
        const lo = pts[i - (step >> 1)];
        const hi = pts[Math.min(n - 1, i + (step >> 1))];
        const len = lo.distanceTo(hi);
        pts[i].copy(lo).add(hi).multiplyScalar(0.5);
        pts[i].x += rand(-1, 1) * len * rough;
        pts[i].y += rand(-1, 1) * len * rough * 0.5;
        pts[i].z += rand(-1, 1) * len * rough;
      }
    }
    const side = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const view = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      dir.copy(pts[Math.min(n - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
      view.copy(camera.position).sub(pts[i]);
      side.crossVectors(dir, view).normalize().multiplyScalar(width * (1 - (i / n) * 0.35) * 0.5);
      this.pos.set([pts[i].x - side.x, pts[i].y - side.y, pts[i].z - side.z, pts[i].x + side.x, pts[i].y + side.y, pts[i].z + side.z], i * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ---------- the manager ----------
export class ItemFX {
  // r: the Kart3D renderer (scene, camera, map, particles, shake()).
  constructor(r, opts = {}) {
    const m = models();
    this.r = r;
    this.scene = r.scene;
    this.map = r.map;
    this.fire = r.fire;
    this.smoke = r.smoke;
    // Ground height under (x, z). Flat maps return 0; maps with hills provide heightAt().
    this.ground = (x, z) => (this.map.heightAt ? this.map.heightAt(x, z) : 0);
    this.pools = {};
    this.shots = new Map(); // shot id -> { kind, obj, marker, last... }
    this.mines = new Map();
    this.bananas = new Map();
    this.effects = [];
    this.bolts = [];
    this.debris = new Debris(this.scene, MOBILE ? 160 : 400, this.ground);
    this.c = {
      rainbow: [0xff5d73, 0xffb347, 0xfde047, 0x4ade80, 0x38bdf8, 0xa78bfa].map((h) => new THREE.Color(h)),
      flame: [new THREE.Color(0xffe066), new THREE.Color(0xff8c1a), new THREE.Color(0xff4d00)],
      comet: [new THREE.Color(0xe0e7ff), new THREE.Color(0x8fb4ff), new THREE.Color(0xa78bfa), new THREE.Color(0x60a5fa)],
      ink: new THREE.Color(0x1a0f2e), inkHi: new THREE.Color(0x4c1d95),
      mint: new THREE.Color(0x6ee7b7), white: new THREE.Color(0xffffff), electric: new THREE.Color(0x9bd5ff),
      smoke: new THREE.Color(r.theme.night ? 0x4a4560 : 0x9aa0aa), shell: new THREE.Color(0x10b981),
      puff: new THREE.Color(r.theme.night ? 0x6a6585 : 0xe8ecf2), plume: new THREE.Color(0x3b2a8f),
    };

    // Bullets: one instanced mesh of glowing tracers.
    this.tracerMax = MOBILE ? 300 : 900;
    this.tracers = new THREE.InstancedMesh(m.tracer, glow(hdr(3, 2.3, 0.9), 1), this.tracerMax);
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.renderOrder = 5;
    this.scene.add(this.tracers);

    // Item boxes: one glass material per box (each pops and regrows on its own).
    const fog = this.scene.fog;
    this.boxes = (opts.items === false ? [] : this.map.itemBoxes).map((b, i) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: TIME, uAlpha: { value: 1 }, uFlash: { value: 0 },
          uFogColor: { value: fog.color }, uFogNear: { value: fog.near }, uFogFar: { value: fog.far },
        },
        vertexShader: VIEW_VERT,
        fragmentShader: `
          uniform float uTime; uniform float uAlpha; uniform float uFlash;
          uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
          varying vec3 vN; varying vec3 vV; varying vec3 vW; varying vec3 vL; ${FRESNEL('2.0')} ${HUE}
          void main() {
            vec3 n = normalize(vN); vec3 v = normalize(vV);
            float f = fres(n, v);
            vec3 rainbow = hue(fract(uTime * 0.22 + (vL.x + vL.y * 0.7 + vL.z * 0.45) * 0.022));
            vec3 h = normalize(normalize(vec3(0.35, 1.0, 0.25)) + v);
            float spec = pow(max(dot(n, h), 0.0), 60.0);
            vec3 q = abs(vL) / 12.0;
            float second = max(min(q.x, q.y), max(min(q.y, q.z), min(q.x, q.z)));
            float edge = smoothstep(0.78, 0.96, second);
            vec3 col = rainbow * (0.45 + 1.1 * f) + vec3(1.0) * (spec * 1.6 + edge * 0.85 + uFlash);
            float a = clamp(0.42 + f * 0.45 + edge * 0.5 + spec, 0.0, 1.0) * uAlpha;
            float fogF = smoothstep(uFogNear, uFogFar, length(vW - cameraPosition));
            gl_FragColor = vec4(mix(col, uFogColor, fogF), a);
          }`,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(m.box, mat);
      mesh.castShadow = true;
      mesh.renderOrder = 4;
      const q = new THREE.Sprite(m.questionMat);
      q.scale.set(17, 17, 1);
      q.renderOrder = 3;
      const g = new THREE.Group();
      g.add(mesh, q);
      g.position.set(b.x, this.ground(b.x, b.y) + 22, b.y);
      this.scene.add(g);
      return { g, mesh, mat, x: b.x, z: b.y, phase: i * 0.7, state: 'on', t: 0 };
    });
  }

  // ---------- pools ----------
  get(kind) {
    const list = this.pools[kind] || (this.pools[kind] = []);
    let obj = list.pop();
    if (!obj) {
      if (kind === 'marker' || kind === 'reticle' || kind === 'pulse') obj = this.buildMarker(kind);
      else obj = buildModel(kind);
      this.scene.add(obj);
    }
    obj.visible = true;
    obj.scale.setScalar(1);
    obj.rotation.set(0, 0, 0);
    return obj;
  }

  put(obj) {
    if (!obj) return;
    obj.visible = false;
    if (obj.parent !== this.scene) this.scene.add(obj);
    (this.pools[obj.userData.kind] || (this.pools[obj.userData.kind] = [])).push(obj);
  }

  // Ground markers: bomb landing zones, comet target reticles, mine pulses. Own material each (own opacity).
  buildMarker(kind) {
    const m = models();
    const g = new THREE.Group();
    const color = kind === 'reticle' ? hdr(1.4, 0.6, 2.4) : kind === 'pulse' ? hdr(2, 0.2, 0.2) : hdr(2.4, 0.5, 0.3);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(m.ring, mat);
    g.add(ring);
    g.userData.mats = [mat];
    if (kind !== 'pulse') {
      const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false });
      g.add(new THREE.Mesh(m.disc, fillMat));
      g.userData.mats.push(fillMat);
      // Four ticks pointing in, like crosshairs.
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(m.tick, mat);
        const a = (i / 4) * TAU;
        t.position.set(Math.cos(a) * 0.72, 0, Math.sin(a) * 0.72);
        t.rotation.y = -a + Math.PI / 2;
        g.add(t);
      }
    }
    g.userData.kind = kind;
    g.userData.mat = mat;
    return g;
  }

  // ---------- per-kart visuals ----------
  // kart: the Kart3D kart record; k: the interpolated row { x, y, angle, speed, flags, item, ammo, roulette }.
  kart(kart, k, dt, t, isMe) {
    const fx = kart.fx || (kart.fx = { held: null, heldKind: 0, orbit: null, orbitN: 0, gun: null, overlays: null, scale: 1, drip: 0, sparkle: 0 });
    const ready = !!k.item && !k.roulette;

    // Thunder victims shrink (and spring back).
    const scale = k.flags & FLAG.shrunk ? 0.55 : 1;
    fx.scale += (scale - fx.scale) * Math.min(1, dt * (scale < fx.scale ? 12 : 5));
    kart.group.scale.setScalar(fx.scale);

    // Banana, mine or bouncer shell trailing behind the kart.
    const held = ready && [CODE.banana, CODE.mine, CODE.bouncer].includes(k.item) ? k.item : 0;
    if (held !== fx.heldKind) {
      this.put(fx.held);
      fx.held = null;
      fx.heldKind = held;
      if (held) {
        fx.held = this.get(K.ITEMS[held - 1]);
        kart.group.add(fx.held);
      }
    }
    if (fx.held) {
      const sway = Math.sin(t * 5 + k.idx) * 0.15 - (kart.steer || 0) * 0.35;
      fx.held.position.set(-44 * Math.cos(sway), 0.5, -44 * Math.sin(sway));
      fx.held.rotation.y = t * (held === CODE.bouncer ? 3 : 0.6);
    }

    // Triple rockets orbit the kart, one per shot left.
    const orbitN = ready && k.item === CODE.triple ? Math.max(0, k.ammo) : 0;
    if (orbitN !== fx.orbitN) {
      if (!fx.orbit) { fx.orbit = new THREE.Group(); kart.group.add(fx.orbit); }
      while (fx.orbit.children.length > orbitN) this.put(fx.orbit.children[fx.orbit.children.length - 1]);
      while (fx.orbit.children.length < orbitN) fx.orbit.add(this.get('mini'));
      fx.orbitN = orbitN;
    }
    if (fx.orbit && orbitN) {
      fx.orbit.rotation.y = t * 3.2;
      fx.orbit.children.forEach((r, i) => {
        const a = (i / orbitN) * TAU;
        r.position.set(Math.cos(a) * 34, 16 + Math.sin(t * 4 + i * 2) * 2, Math.sin(a) * 34);
        r.rotation.set(0, -a - Math.PI / 2, 0);
        r.scale.setScalar(0.45);
      });
    }

    // Minigun: barrels on the nose while you hold or fire it; spinning, flashing and spitting tracers.
    const firing = !!(k.flags & FLAG.gun);
    const showGun = firing || (!!ready && k.item === CODE.minigun); // a boolean: three.js hides only visible === false
    if (showGun && !fx.gun) {
      const G = models().gun;
      const gun = new THREE.Group();
      const barrels = new THREE.Mesh(G.barrels, G.barrelMat);
      barrels.castShadow = true;
      const housing = new THREE.Mesh(G.housing, G.housingMat);
      housing.castShadow = true;
      const flash = new THREE.Mesh(G.flash, G.flashMat);
      flash.position.x = 26;
      gun.add(barrels, housing, flash);
      gun.position.set(8, 15, -15);
      gun.userData = { barrels, flash };
      kart.chassis.add(gun);
      fx.gun = gun;
    }
    if (fx.gun) {
      fx.gun.visible = showGun;
      if (showGun) {
        const { barrels, flash } = fx.gun.userData;
        barrels.rotation.x += dt * (firing ? 40 : 2);
        flash.visible = firing && Math.random() > 0.25;
        if (flash.visible) { flash.scale.setScalar(rand(0.6, 1.25)); flash.rotation.x = rand(0, TAU); }
      }
    }

    // Star: rainbow sheen over every part of the kart, and sparkles streaming off it.
    const star = !!(k.flags & FLAG.star);
    if (star && !fx.overlays) {
      const mat = starMaterial();
      fx.overlays = kart.meshes.map((mesh) => {
        const o = new THREE.Mesh(mesh.geometry, mat);
        o.renderOrder = 3;
        mesh.add(o);
        return o;
      });
    }
    if (fx.overlays && fx.overlays[0].visible !== star) for (const o of fx.overlays) o.visible = star;
    if (star && !fx.aura) {
      fx.aura = new THREE.Sprite(starAura());
      fx.aura.position.y = 14;
      kart.group.add(fx.aura);
    }
    if (fx.aura) {
      fx.aura.visible = star;
      if (star) fx.aura.scale.setScalar(95 + Math.sin(t * 18) * 10);
    }
    const gy = this.ground(k.x, k.y);
    if (star) {
      fx.sparkle -= dt;
      if (fx.sparkle <= 0) {
        fx.sparkle = MOBILE ? 0.06 : 0.025;
        const a = rand(0, TAU);
        const col = this.c.rainbow[Math.floor(rand(0, 6))];
        this.fire.emit(k.x + Math.cos(a) * 22, gy + rand(6, 34), k.y + Math.sin(a) * 22, Math.cos(a) * 40 - Math.cos(k.angle) * 80, rand(20, 90), Math.sin(a) * 40 - Math.sin(k.angle) * 80,
          col, rand(6, 11), 0.5, { drag: 2, rise: -60 });
      }
    }

    // Inked rivals drip ink (you never see your own; your screen shows it instead).
    if (k.flags & FLAG.inked && !isMe) {
      fx.drip -= dt;
      if (fx.drip <= 0) {
        fx.drip = 0.07;
        this.smoke.emit(k.x + rand(-10, 10), gy + 34 * fx.scale, k.y + rand(-10, 10), rand(-20, 20), rand(-10, 30), rand(-20, 20),
          Math.random() < 0.7 ? this.c.ink : this.c.inkHi, rand(5, 9), 0.7, { alpha: 0.95, rise: -260, drag: 0.4, grow: 0.8 });
      }
    }
  }

  // A kart left the scene (or the round ended): give back anything it carried.
  releaseKart(kart) {
    const fx = kart.fx;
    if (!fx) return;
    this.put(fx.held);
    fx.held = null;
    fx.heldKind = 0;
    if (fx.orbit) { while (fx.orbit.children.length) this.put(fx.orbit.children[0]); fx.orbitN = 0; }
  }

  // ---------- per frame ----------
  // view: { shots:[[id,kind,x,y,a,prog|alt,...extra]], mines:[[id,x,y,armed]], bananas:[[id,x,y]], boxes:[0|1], karts }
  update(view, dt, t, now) {
    TIME.value = t;
    starAura().color.setHSL((t * 1.6) % 1, 1, 0.6);
    this.updateShots(view.shots || [], view.karts || [], dt, t);
    this.updateMines(view.mines || [], dt, now);
    this.updateBananas(view.bananas || [], dt);
    this.updateBoxes(view.boxes, dt, t);
    this.debris.update(dt);
    this.updateEffects(dt, t);
  }

  updateShots(list, karts, dt, t) {
    const live = new Set();
    const m4 = this.m4 || (this.m4 = new THREE.Matrix4());
    const q = this.q || (this.q = new THREE.Quaternion());
    const v = this.v || (this.v = new THREE.Vector3());
    const sc = this.sc || (this.sc = new THREE.Vector3());
    const up = this.up || (this.up = new THREE.Vector3(0, 1, 0));
    let tracers = 0;
    for (const row of list) {
      const [id, kind, x, z, a, p] = row;
      const gy = this.ground(x, z);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      if (kind === SHOT.bullet) {
        if (tracers >= this.tracerMax) continue;
        q.setFromAxisAngle(up, -a);
        m4.compose(v.set(x - ca * 14, gy + 13, z - sa * 14), q, sc.set(38, 1, 1));
        this.tracers.setMatrixAt(tracers++, m4);
        continue;
      }
      live.add(id);
      let s = this.shots.get(id);
      if (!s) {
        const name = kind === SHOT.rocket ? 'rocket' : kind === SHOT.bomb ? 'bomb' : kind === SHOT.bouncer ? 'bouncer' : 'comet';
        s = { kind, obj: this.get(name), marker: null, lastA: a, lastAlt: p, age: 0 };
        this.shots.set(id, s);
        if (kind === SHOT.comet) this.cometLaunch(x, gy, z);
      }
      s.age += dt;
      const o = s.obj;
      if (kind === SHOT.rocket) {
        o.position.set(x, gy + 15, z);
        o.rotation.y = -a;
        o.userData.spin.rotation.x += dt * 9;
        const [flame, core] = o.userData.flames;
        flame.scale.set(rand(0.8, 1.3), rand(0.85, 1.15), rand(0.85, 1.15));
        core.scale.set(rand(0.7, 1.2), 1, 1);
        this.fire.emit(x - ca * 32, gy + 15, z - sa * 32, -ca * 60 + rand(-15, 15), rand(-15, 15), -sa * 60 + rand(-15, 15),
          this.c.flame[Math.floor(rand(0, 3))], rand(12, 18), 0.16, { grow: 0.4 });
        this.smoke.emit(x - ca * 38, gy + 15, z - sa * 38, rand(-8, 8), rand(6, 16), rand(-8, 8), this.c.puff, rand(8, 11), 0.8, { alpha: 0.42, grow: 2.4, drag: 1 });
      } else if (kind === SHOT.bomb) {
        // Lobbed: arcs up and down, tumbling, fuse fizzing. The landing spot is marked on the ground.
        const prog = Math.min(1, (p || 0) / 100);
        o.position.set(x, gy + 12 + Math.sin(prog * Math.PI) * 110, z);
        o.rotation.y = -a;
        o.userData.spin.rotation.z -= dt * 7;
        o.userData.spark.scale.setScalar(rand(9, 16));
        const tip = o.userData.spark.getWorldPosition(v);
        this.fire.emit(tip.x, tip.y, tip.z, rand(-60, 60), rand(20, 90), rand(-60, 60), this.c.flame[Math.floor(rand(0, 2))], rand(3, 5), 0.3, { drag: 2, rise: -300 });
        if (row.length >= 8) {
          if (!s.marker) s.marker = this.get('marker');
          const lx = row[6];
          const lz = row[7];
          const size = 140 * (1.25 - 0.25 * prog);
          s.marker.position.set(lx, this.ground(lx, lz) + 1.5, lz);
          s.marker.scale.setScalar(size);
          s.marker.rotation.y = t * 2;
          s.marker.userData.mat.opacity = 0.45 + 0.4 * Math.abs(Math.sin(t * 10));
        }
      } else if (kind === SHOT.bouncer) {
        o.position.set(x, gy + 0.5 + Math.abs(Math.sin(s.age * 14)) * 1.5, z);
        o.userData.spin.rotation.y += dt * 18;
        if (Math.abs(wrap(a - s.lastA)) > 0.6) this.bounceFx(x, gy, z);
        if (Math.random() < 0.5) this.fire.emit(x - ca * 10, gy + 4, z - sa * 10, rand(-20, 20), rand(10, 40), rand(-20, 20), this.c.mint, rand(4, 7), 0.3, { drag: 2 });
      } else if (kind === SHOT.comet) {
        // High over the track, then a dive onto the target (whose spot gets a reticle).
        const alt = p || 0;
        const climbing = alt - s.lastAlt;
        o.position.set(x, gy + 16 + alt, z);
        o.rotation.y = -a;
        o.rotation.z = Math.max(-1.1, Math.min(0.6, (climbing / Math.max(dt, 0.001)) * 0.002));
        o.userData.spin.rotation.x += dt * 4;
        o.userData.spin.rotation.y += dt * 6;
        o.userData.ring.rotation.set(Math.PI / 2 + Math.sin(t * 3) * 0.4, t * 5, 0);
        o.userData.halo.scale.setScalar(95 + Math.sin(t * 20) * 12);
        // Tail: bright sparks plus a darker indigo plume so it reads against a daytime sky.
        for (let i = 0; i < (MOBILE ? 2 : 4); i++) {
          this.fire.emit(x - ca * 16 + rand(-8, 8), o.position.y + rand(-8, 8), z - sa * 16 + rand(-8, 8), -ca * 90 + rand(-30, 30), rand(-30, 30), -sa * 90 + rand(-30, 30),
            this.c.comet[Math.floor(rand(0, 4))], rand(16, 28), rand(0.35, 0.7), { grow: 0.5, drag: 1.5 });
        }
        this.smoke.emit(x - ca * 26, o.position.y, z - sa * 26, -ca * 40 + rand(-20, 20), rand(-10, 10), -sa * 40 + rand(-20, 20), this.c.plume, rand(18, 26), 0.8, { alpha: 0.55, grow: 1.6, drag: 1 });
        const target = row[6] >= 0 ? karts.find((kk) => kk.idx === row[6]) : null;
        if (target && !(target.flags & FLAG.dead)) {
          if (!s.marker) s.marker = this.get('reticle');
          const near = Math.max(0, 1 - Math.hypot(target.x - x, target.y - z) / 2500);
          s.marker.position.set(target.x, this.ground(target.x, target.y) + 1.6, target.y);
          s.marker.scale.setScalar(60 + 50 * (1 - near) + Math.sin(t * 12) * 6);
          s.marker.rotation.y = -t * 3;
          s.marker.userData.mat.opacity = 0.5 + 0.45 * near;
        } else if (s.marker) { this.put(s.marker); s.marker = null; }
        s.lastAlt = alt;
      }
      s.lastA = a;
    }
    this.tracers.count = tracers;
    this.tracers.instanceMatrix.needsUpdate = true;
    for (const [id, s] of this.shots) {
      if (live.has(id)) continue;
      this.put(s.obj);
      this.put(s.marker);
      this.shots.delete(id);
    }
  }

  updateMines(list, dt, now) {
    const live = new Set();
    for (const [id, x, z, armed] of list) {
      live.add(id);
      let m = this.mines.get(id);
      if (!m) {
        m = { obj: this.get('mine'), pulse: this.get('pulse'), t: 0 };
        m.obj.rotation.y = rand(0, TAU);
        this.mines.set(id, m);
      }
      m.t += dt;
      const gy = this.ground(x, z);
      // Dropped: falls and bounces once, then sits flat.
      const drop = Math.max(0, 1 - m.t / 0.35);
      m.obj.position.set(x, gy + 0.3 + Math.abs(Math.cos(m.t * 9)) * 16 * drop * drop, z);
      const { light, halo } = m.obj.userData;
      const on = armed ? Math.floor(now / 160) % 2 === 0 : true;
      const N = models().mine;
      light.material = !on ? N.lightOff : armed ? N.lightOn : N.lightArming;
      halo.visible = on;
      halo.material.color.setHex(armed ? 0xff3030 : 0xffc040);
      const ph = (now / 1000) % 1;
      m.pulse.visible = !!armed;
      m.pulse.position.set(x, gy + 1.2, z);
      m.pulse.scale.setScalar(18 + ph * 42);
      m.pulse.userData.mat.opacity = 0.5 * (1 - ph) * (1 - ph);
    }
    for (const [id, m] of this.mines) {
      if (live.has(id)) continue;
      this.put(m.obj);
      this.put(m.pulse);
      this.mines.delete(id);
    }
  }

  updateBananas(list, dt) {
    const live = new Set();
    for (const [id, x, z] of list) {
      live.add(id);
      let b = this.bananas.get(id);
      if (!b) {
        b = { obj: this.get('banana'), t: 0, x, z };
        b.obj.rotation.y = rand(0, TAU);
        this.bananas.set(id, b);
      }
      b.t += dt;
      b.x = x;
      b.z = z;
      const pop = Math.min(1, b.t / 0.25);
      b.obj.scale.setScalar(0.3 + 0.7 * (1 - (1 - pop) ** 3) + Math.sin(pop * Math.PI) * 0.15);
      b.obj.position.set(x, this.ground(x, z) + 0.2, z);
    }
    for (const [id, b] of this.bananas) {
      if (live.has(id)) continue;
      // Squashed or swept away: peel bits fly off.
      const gy = this.ground(b.x, b.z);
      for (let i = 0; i < 6; i++) {
        const a = rand(0, TAU);
        this.debris.emit(b.x, gy + 6, b.z, Math.cos(a) * rand(60, 140), rand(150, 300), Math.sin(a) * rand(60, 140), rand(2.5, 4.5), i % 3 ? 0xfacc15 : 0x8a5a1c, rand(0.8, 1.3));
      }
      this.put(b.obj);
      this.bananas.delete(id);
    }
  }

  // Glossy rainbow "?" boxes: spin and bob; pop into shards when collected; grow back when they return.
  updateBoxes(boxes, dt, t) {
    this.boxes.forEach((b, i) => {
      const on = !boxes || !!boxes[i];
      if (b.state === 'on' && !on) { b.state = 'pop'; b.t = 0; this.boxPop(b); }
      if ((b.state === 'off' || b.state === 'pop') && on) { b.state = 'grow'; b.t = 0; this.boxGrow(b); }
      b.t += dt;
      let s = 1;
      if (b.state === 'pop') {
        const p = Math.min(1, b.t / 0.2);
        s = 1 + p * 0.6;
        b.mat.uniforms.uAlpha.value = 1 - p;
        b.mat.uniforms.uFlash.value = 1 - p;
        if (p >= 1) b.state = 'off';
      } else if (b.state === 'grow') {
        const p = Math.min(1, b.t / 0.55);
        s = 1 - Math.cos(p * Math.PI * 2.5) * Math.exp(-p * 5); // elastic
        b.mat.uniforms.uAlpha.value = 1;
        b.mat.uniforms.uFlash.value = Math.max(0, 0.6 - p);
        if (p >= 1) b.state = 'on';
      } else if (b.state === 'on') {
        b.mat.uniforms.uFlash.value = 0;
      }
      b.g.visible = b.state !== 'off';
      if (!b.g.visible) return;
      b.g.scale.setScalar(Math.max(0.01, s));
      b.mesh.rotation.set(t * 0.9 + b.phase, t * 1.3 + b.phase, 0);
      b.g.position.y = this.ground(b.x, b.z) + 22 + Math.sin(t * 2.5 + b.phase) * 4;
    });
  }

  boxPop(b) {
    const y = b.g.position.y;
    for (let i = 0; i < 10; i++) {
      const a = rand(0, TAU);
      this.debris.emit(b.x, y, b.z, Math.cos(a) * rand(80, 220), rand(120, 320), Math.sin(a) * rand(80, 220), rand(3, 6), this.c.rainbow[i % 6], rand(0.7, 1.2));
    }
    for (let i = 0; i < (MOBILE ? 18 : 36); i++) {
      const a = rand(0, TAU);
      const sp = rand(90, 240);
      this.fire.emit(b.x, y, b.z, Math.cos(a) * sp, rand(40, 200), Math.sin(a) * sp, this.c.rainbow[i % 6], rand(7, 12), 0.55, { drag: 2.2, rise: -200 });
    }
  }

  boxGrow(b) {
    const y = this.ground(b.x, b.z) + 22;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      this.fire.emit(b.x + Math.cos(a) * 20, y - 14, b.z + Math.sin(a) * 20, -Math.cos(a) * 30, rand(60, 120), -Math.sin(a) * 30, this.c.rainbow[i % 6], 7, 0.5, { drag: 1.5 });
    }
  }

  // ---------- one-shot effects ----------
  bounceFx(x, gy, z) {
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU);
      this.fire.emit(x, gy + 6, z, Math.cos(a) * rand(100, 220), rand(40, 160), Math.sin(a) * rand(100, 220), i % 2 ? this.c.white : this.c.mint, rand(4, 7), 0.3, { drag: 2.5, rise: -400 });
    }
    const f = this.r.focus;
    const d = f ? Math.hypot(f.x - x, f.y - z) : 1000;
    if (d < 1200) window.Sfx?.bounce?.(1 - d / 1200);
  }

  // kind: comet | bouncer (others are drawn by Kart3D.explode).
  blast(kind, x, z, radius) {
    const gy = this.ground(x, z);
    if (kind === 'bouncer') {
      for (let i = 0; i < 9; i++) {
        const a = rand(0, TAU);
        this.debris.emit(x, gy + 6, z, Math.cos(a) * rand(80, 200), rand(150, 330), Math.sin(a) * rand(80, 200), rand(3, 5.5), i % 3 ? 0x10b981 : 0xf8fafc, rand(0.8, 1.3));
      }
      for (let i = 0; i < 20; i++) {
        const a = rand(0, TAU);
        this.fire.emit(x, gy + 8, z, Math.cos(a) * rand(80, 200), rand(40, 160), Math.sin(a) * rand(80, 200), i % 2 ? this.c.white : this.c.mint, rand(5, 9), 0.35, { drag: 2.5 });
      }
      return;
    }
    // Comet: a white-blue starburst, a light pillar and shockwaves.
    const big = radius > 100;
    const n = big ? (MOBILE ? 40 : 70) : 20;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const e = rand(-0.1, 1.1);
      const sp = rand(300, 760) * (big ? 1 : 0.5);
      this.fire.emit(x, gy + 14, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 60, Math.sin(a) * Math.cos(e) * sp,
        this.c.comet[i % 4], rand(7, 14), rand(0.45, 0.8), { grow: 1.1, drag: 2.6, rise: 20 });
    }
    if (big) this.dome(x, gy, z, radius);
    for (let i = 0; i < (big ? 10 : 3); i++) {
      const a = rand(0, TAU);
      this.debris.emit(x, gy + 10, z, Math.cos(a) * rand(160, 320), rand(200, 420), Math.sin(a) * rand(160, 320), rand(2.5, 5), i % 2 ? 0x8b5cf6 : 0x93c5fd, rand(0.8, 1.3));
    }
    for (let i = 0; i < (big ? 10 : 4); i++) {
      const a = rand(0, TAU);
      this.smoke.emit(x + Math.cos(a) * 60, gy + 8, z + Math.sin(a) * 60, Math.cos(a) * rand(100, 220), rand(10, 40), Math.sin(a) * rand(100, 220), this.c.plume, rand(20, 34), rand(0.9, 1.4), { alpha: 0.35, grow: 1.5, drag: 1.6, rise: 15 });
    }
    if (!big) return;
    this.pillar(x, gy, z, 0x5b7cff, 0.9);
    this.r.ring(x, z, 0x8fb4ff, radius * 1.6, 0.6);
    this.r.ring(x, z, 0xffffff, radius * 1.1, 0.4);
    this.r.shake(x, z, 26);
  }

  // A blast dome: a glassy blue hemisphere that swells to the blast radius and fades.
  dome(x, gy, z, radius) {
    const mat = viewMaterial(`
      uniform float uA; varying vec3 vN; varying vec3 vV; varying vec3 vL; ${FRESNEL('1.8')}
      void main() {
        float f = fres(vN, vV);
        float bands = 0.5 + 0.5 * sin(vL.y * 18.0);
        vec3 col = mix(vec3(0.35, 0.45, 1.0), vec3(0.95, 0.97, 1.0), f) * (0.6 + 1.6 * f);
        gl_FragColor = vec4(col, (0.08 + 0.85 * f + 0.06 * bands) * uA);
      }`, { uniforms: { uA: { value: 1 } }, side: THREE.DoubleSide });
    const geo = AURA.dome || (AURA.dome = new THREE.SphereGeometry(1, 32, 14, 0, TAU, 0, Math.PI / 2));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, gy, z);
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this.effects.push({ kind: 'dome', mesh, life: 0.55, max: 0.55, radius, shared: true });
  }

  pillar(x, gy, z, color, life) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(14, 26, 700, 24, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(x, gy + 350, z);
    this.scene.add(beam);
    this.effects.push({ kind: 'pillar', mesh: beam, life, max: life });
  }

  cometLaunch(x, gy, z) {
    for (let i = 0; i < 30; i++) {
      const a = rand(0, TAU);
      this.fire.emit(x, gy + 20, z, Math.cos(a) * rand(60, 160), rand(80, 260), Math.sin(a) * rand(60, 160), this.c.comet[i % 4], rand(8, 14), 0.6, { drag: 2 });
    }
  }

  // Shock: a ring of lightning racing outwards plus bolts arcing to its edge.
  shock(x, z, radius) {
    const gy = this.ground(x, z);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: TIME, uP: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime; uniform float uP; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p); float a = atan(p.y, p.x);
          float jag = 0.035 * sin(a * 23.0 + uTime * 47.0) + 0.025 * sin(a * 61.0 - uTime * 31.0) + 0.015 * sin(a * 7.0 + uTime * 13.0);
          float d = abs(r - uP + jag);
          float core = smoothstep(0.03, 0.0, d);
          float halo = smoothstep(0.14, 0.0, d) * 0.4;
          float inner = smoothstep(uP, 0.0, r) * 0.18 * (1.0 - uP);
          float fade = 1.0 - uP * uP;
          vec3 col = mix(vec3(0.35, 0.7, 1.0), vec3(1.0), core) * 2.0;
          gl_FragColor = vec4(col, (core + halo + inner) * fade);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), mat);
    disc.position.set(x, gy + 3, z);
    disc.scale.setScalar(radius);
    disc.renderOrder = 5;
    this.scene.add(disc);
    this.effects.push({ kind: 'shock', mesh: disc, life: 0.5, max: 0.5, x, z, gy, radius, zap: 0, bolts: [] });
  }

  // Thunder: a bolt out of the sky onto each victim, with a flash on the ground.
  thunder(list) {
    for (const [x, z] of list) {
      const gy = this.ground(x, z);
      this.effects.push({ kind: 'strike', life: 0.55, max: 0.55, x, z, gy, zap: 0, bolts: [] });
      for (let i = 0; i < (MOBILE ? 14 : 28); i++) {
        const a = rand(0, TAU);
        this.fire.emit(x, gy + 10, z, Math.cos(a) * rand(80, 260), rand(60, 260), Math.sin(a) * rand(80, 260), i % 3 ? this.c.electric : this.c.white, rand(5, 10), 0.45, { drag: 2, rise: -300 });
      }
      this.r.ring(x, z, 0xbfd8ff, 90, 0.35);
    }
  }

  // Ink: dark globs arc from the user to every victim.
  inkBurst(from, targets) {
    if (!from) return;
    const gy = this.ground(from.x, from.y);
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU);
      this.smoke.emit(from.x, gy + 30, from.y, Math.cos(a) * rand(60, 160), rand(80, 220), Math.sin(a) * rand(60, 160), i % 3 ? this.c.ink : this.c.inkHi, rand(8, 14), 0.8, { alpha: 0.95, rise: -500, drag: 0.6 });
    }
    for (const tgt of targets) {
      const T = 0.7;
      const dx = tgt.x - from.x;
      const dz = tgt.y - from.y;
      for (let i = 0; i < 6; i++) {
        this.smoke.emit(from.x, gy + 30, from.y, dx / T + rand(-30, 30), 0.5 * 500 * T + rand(-20, 20), dz / T + rand(-30, 30),
          i % 2 ? this.c.ink : this.c.inkHi, rand(10, 16), T + 0.05, { alpha: 0.95, rise: -500, drag: 0 });
      }
    }
  }

  // Boost/star/shield/ghost activation flourishes.
  used(k, item) {
    if (!k) return;
    const gy = this.ground(k.x, k.y);
    if (item === 'star') {
      for (let i = 0; i < 40; i++) {
        const a = rand(0, TAU);
        this.fire.emit(k.x, gy + 16, k.y, Math.cos(a) * rand(100, 260), rand(40, 220), Math.sin(a) * rand(100, 260), this.c.rainbow[i % 6], rand(8, 13), 0.6, { drag: 2.2 });
      }
      this.r.ring(k.x, k.y, 0xfff3a0, 120, 0.4);
    } else if (item === 'shield') {
      this.r.ring(k.x, k.y, 0x60a5fa, 80, 0.35);
    } else if (item === 'ghost') {
      for (let i = 0; i < 20; i++) {
        const a = rand(0, TAU);
        this.smoke.emit(k.x + Math.cos(a) * 20, gy + rand(4, 30), k.y + Math.sin(a) * 20, Math.cos(a) * 50, rand(10, 40), Math.sin(a) * 50, this.c.white, rand(14, 24), 0.8, { alpha: 0.5, grow: 1.8 });
      }
    } else if (item === 'boost') {
      const ca = Math.cos(k.angle);
      const sa = Math.sin(k.angle);
      for (let i = 0; i < 24; i++) {
        this.fire.emit(k.x - ca * 26, gy + 8, k.y - sa * 26, -ca * rand(150, 320) + rand(-50, 50), rand(10, 80), -sa * rand(150, 320) + rand(-50, 50), this.c.flame[i % 3], rand(10, 18), 0.35, { grow: 0.5, drag: 2.5 });
      }
    }
  }

  updateEffects(dt, t) {
    const cam = this.r.camera;
    const a = this.va || (this.va = new THREE.Vector3());
    const b = this.vb || (this.vb = new THREE.Vector3());
    this.effects = this.effects.filter((e) => {
      e.life -= dt;
      const p = 1 - Math.max(0, e.life) / e.max;
      if (e.kind === 'dome') {
        const k = 1 - (1 - p) ** 3;
        e.mesh.scale.set(e.radius * (0.15 + 0.95 * k), e.radius * (0.1 + 0.75 * k), e.radius * (0.15 + 0.95 * k));
        e.mesh.material.uniforms.uA.value = 1 - p * p;
      } else if (e.kind === 'pillar') {
        e.mesh.material.opacity = 0.4 * (1 - p) * (1 - p);
        e.mesh.scale.set(1 - p * 0.6, 1 + p * 0.3, 1 - p * 0.6);
      } else if (e.kind === 'shock') {
        e.mesh.material.uniforms.uP.value = Math.min(1, p * 1.15);
        e.zap -= dt;
        if (e.zap <= 0 && e.life > 0.08) {
          // Fresh arcs every few frames, from the kart out to the ring front.
          e.zap = 0.05;
          this.freeBolts(e);
          const reach = e.radius * Math.min(1, p * 1.15);
          for (let i = 0; i < (MOBILE ? 3 : 6); i++) {
            const bolt = this.bolt();
            const ang = rand(0, TAU);
            bolt.shape(a.set(e.x, e.gy + 14, e.z), b.set(e.x + Math.cos(ang) * reach, e.gy + 4, e.z + Math.sin(ang) * reach), 9, 0.22, cam);
            e.bolts.push(bolt);
          }
        }
        for (const bolt of e.bolts) bolt.mat.opacity = 1 - p;
      } else if (e.kind === 'strike') {
        e.zap -= dt;
        if (e.zap <= 0 && e.life > 0.1) {
          // The bolt flickers: re-drawn a few times, with a branch or two.
          e.zap = 0.08;
          this.freeBolts(e);
          const main = this.bolt();
          main.shape(a.set(e.x + rand(-120, 120), e.gy + 950, e.z + rand(-120, 120)), b.set(e.x, e.gy + 12, e.z), 22, 0.16, cam);
          e.bolts.push(main);
          for (let i = 0; i < 2; i++) {
            const k = 3 + Math.floor(rand(0, 8));
            const from = main.pts[k];
            const branch = this.bolt();
            branch.shape(a.copy(from), b.set(from.x + rand(-160, 160), from.y - rand(120, 280), from.z + rand(-160, 160)), 10, 0.22, cam);
            e.bolts.push(branch);
          }
        }
        for (const bolt of e.bolts) bolt.mat.opacity = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      }
      if (e.life > 0) return true;
      if (e.bolts) this.freeBolts(e);
      if (e.mesh) {
        this.scene.remove(e.mesh);
        if (!e.shared) e.mesh.geometry.dispose(); // the dome geometry is shared
        e.mesh.material.dispose();
      }
      return false;
    });
  }

  bolt() {
    const free = this.bolts.find((x) => !x.busy);
    const bolt = free || new Bolt(this.scene);
    if (!free) this.bolts.push(bolt);
    bolt.busy = true;
    bolt.mat.opacity = 1;
    return bolt;
  }

  freeBolts(e) {
    for (const bolt of e.bolts) { bolt.busy = false; bolt.mesh.visible = false; }
    e.bolts.length = 0;
  }

  dispose() {
    // Shared geometry and materials (models(), auras) stay cached for the next game.
    for (const b of this.boxes) b.mat.dispose();
    const markers = [...Object.values(this.pools).flat(), ...[...this.shots.values()].map((s) => s.marker), ...[...this.mines.values()].map((m) => m.pulse)];
    for (const o of markers) if (o && o.userData.mats) for (const mat of o.userData.mats) mat.dispose();
    for (const b of this.bolts) b.dispose();
    for (const e of this.effects) if (e.mesh) { if (!e.shared) e.mesh.geometry.dispose(); e.mesh.material.dispose(); }
    this.tracers.material.dispose();
    this.tracers.dispose();
    this.debris.dispose();
  }
}
