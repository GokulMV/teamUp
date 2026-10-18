// Power-up models and effects for Kart Battle: projectiles, dropped items, item boxes, what karts
// carry (trailing bananas, orbiting rockets, a minigun) and their auras (shield, ghost, star), plus
// one-shot effects (shock rings, thunder bolts, comet blasts, debris).
// Draw calls stay low: each model is baked into one vertex-coloured mesh, bullets and debris are
// instanced, and meshes and effect materials are pooled (hidden and reused, never rebuilt per shot,
// so no shader is ever recompiled mid-race). warmUp() compiles every item shader before the start.
// Every item sits at ground(x, z) + offset so it follows hills on maps that have them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MOBILE, part, canvasTexture, tex } from './world.js';
import { outlined } from './toon.js';
import { MOUNT_OF, buildMount } from './mounts.js';
import { ease } from './juice.js';

const K = window.KartCore;
const TAU = Math.PI * 2;
const SHOT = { rocket: 1, bullet: 2, bomb: 3, bouncer: 4, comet: 5, snowball: 6, sticky: 7 };
const CODE = Object.fromEntries(K.ITEMS.map((id, i) => [id, i + 1]));
const FLAG = { spin: 1, boost: 2, shield: 4, dead: 32, ghost: 1024, gun: 2048, star: 4096, shrunk: 8192, inked: 16384, frozen: 32768, spikes: 65536 };
const TIME = { value: 0 }; // shared by every animated item material
// Item models are built at toy scale and blown up so they read clearly from the chase camera.
const SIZE = { rocket: 1.6, shell: 1.45, bomb: 1.35, mine: 1.4, peel: 1.25, comet: 1.9 };
const HELD = 0.7; // items carried behind a kart are shown smaller so they trail it rather than hide it
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
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
// Star: a pool of rainbow light on the ground under the kart (one material, every star kart in step).
function starGlow() {
  return AURA.glow || (AURA.glow = new THREE.MeshBasicMaterial({ map: tex.spark(), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
}
// Star: the kart's own materials with a rainbow sheen worked in (no overlay meshes: nothing to
// z-fight and no extra draw calls). One variant per base material, all sharing one shader program.
const STAR_SKIN = new WeakMap();
export function starVariant(mat) {
  let star = STAR_SKIN.get(mat);
  if (star) return star;
  star = mat.clone();
  star.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStarW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvStarW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; varying vec3 vStarW; ${HUE}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 1.6);
          vec3 rainbow = hue(fract(uTime * 1.6 + vStarW.y * 0.014 + (vStarW.x + vStarW.z) * 0.003));
          float pulse = 0.8 + 0.2 * sin(uTime * 14.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, rainbow, 0.4);
          totalEmissiveRadiance += rainbow * (0.3 + 1.5 * rim) * pulse;
        }`);
  };
  star.customProgramCacheKey = () => 'kart-star';
  STAR_SKIN.set(mat, star);
  return star;
}

// ---------- textures ----------
const TEX = {};
// Hex plates on the top 128 rows; the last 8 rows are plain white so the shell's rim and base
// (vertex-coloured, in the same mesh) can sample white and keep their own colour.
const SHELL_TEX_H = 136;
function hexShellTexture() {
  return TEX.shell || (TEX.shell = canvasTexture(256, SHELL_TEX_H, (c, w) => {
    const h = 128;
    c.fillStyle = '#fff'; c.fillRect(0, h, w, SHELL_TEX_H - h);
    c.beginPath(); c.rect(0, 0, w, h); c.clip();
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

// Bake [geometry, colour] parts into one geometry with a colour per vertex, so a whole model is a
// single mesh: one draw call and one shadow caster. Colours are hex (sRGB) or linear THREE.Colors.
function baked(parts, keepUv = false) {
  const keep = ['position', 'normal', 'color', ...(keepUv ? ['uv'] : [])];
  return mergeGeometries(parts.map(([geo, color]) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    const c = color.isColor ? color : new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
    return g;
  }));
}
const vtx = (extra = {}) => ({ vertexColors: true, ...extra });

function models() {
  if (M.ready) return M;
  // Rocket (points +x): red body, white nose and band, yellow fins, glass porthole, steel nozzle.
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(-7, 0); finShape.lineTo(-9.5, 6.5); finShape.lineTo(-4.5, 6.5); finShape.closePath();
  const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.9, bevelEnabled: false }).translate(-1.5, 2.4, -0.45);
  M.rocket = {
    geo: baked([
      [part(new THREE.CylinderGeometry(3.2, 3.2, 15, 16), 0, 0, 0, 0, 0, Math.PI / 2), 0xef233c],
      [part(new THREE.ConeGeometry(3.2, 9, 16), 12, 0, 0, 0, 0, -Math.PI / 2), 0xf8fafc],
      [part(new THREE.CylinderGeometry(3.35, 3.35, 2.2, 16), 4, 0, 0, 0, 0, Math.PI / 2), 0xf8fafc],
      ...[0, 1, 2, 3].map((i) => [part(fin, 0, 0, 0, (i * Math.PI) / 2 + Math.PI / 4, 0, 0), 0xfbbf24]),
      [part(new THREE.CylinderGeometry(2.3, 3, 3, 12), -9, 0, 0, 0, 0, Math.PI / 2), 0x4b5563],
      [part(new THREE.SphereGeometry(1.7, 12, 8), 0, 2.7, 0), 0x9be7ff],
    ]).scale(SIZE.rocket, SIZE.rocket, SIZE.rocket),
    mat: std(0xffffff, 0.3, 0.3, vtx()),
    // Exhaust: an orange flame cone around a white-hot core (HDR colours, so they bloom).
    flame: baked([
      [new THREE.ConeGeometry(2.8, 16, 12, 1, true).rotateZ(Math.PI / 2).translate(-18.5, 0, 0), hdr(2.2, 0.9, 0.25)],
      [new THREE.ConeGeometry(1.5, 9, 10, 1, true).rotateZ(Math.PI / 2).translate(-15, 0, 0), hdr(2.6, 2.4, 1.7)],
    ]).scale(SIZE.rocket, SIZE.rocket, SIZE.rocket),
    flameMat: new THREE.MeshBasicMaterial(vtx({ transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })),
  };
  // Bouncer shell: hex-plated dome (textured) on a white rim and dark base, all one mesh.
  const dome = new THREE.SphereGeometry(10, 28, 14, 0, TAU, 0, Math.PI / 2).scale(1, 0.8, 1).translate(0, 3.2, 0);
  const lo = (SHELL_TEX_H - 128) / SHELL_TEX_H; // the dome uses the hex rows, above the white strip
  const uv = dome.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, lo + uv.getY(i) * (1 - lo));
  const plain = (g) => { const a = g.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, 0.5, lo / 2); return g; };
  M.shell = {
    geo: baked([
      [dome, 0xffffff],
      [plain(new THREE.TorusGeometry(10.1, 2.2, 10, 32).rotateX(Math.PI / 2).translate(0, 3.2, 0)), 0xf8fafc],
      [plain(new THREE.CylinderGeometry(9.6, 8, 3.2, 28).translate(0, 1.6, 0)), 0x1e293b],
    ], true).scale(SIZE.shell, SIZE.shell, SIZE.shell),
    mat: std(0xffffff, 0.2, 0.05, vtx({ map: hexShellTexture(), emissive: 0x064e3b, emissiveIntensity: 0.2 })),
  };
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
    geo: baked([
      [new THREE.SphereGeometry(9, 24, 16), 0x1b2030],
      [new THREE.TorusGeometry(9.05, 1.1, 8, 32).rotateX(Math.PI / 2), 0xf59e0b],
      [new THREE.CylinderGeometry(3, 3.4, 3.4, 14).translate(0, 9.6, 0), 0x9ca3af],
      [new THREE.TubeGeometry(fuseCurve, 12, 0.75, 6), 0x92400e],
    ]).scale(SIZE.bomb, SIZE.bomb, SIZE.bomb),
    mat: std(0xffffff, 0.26, 0.55, vtx()),
    tip: new THREE.Vector3(5.2, 14.4, 0.2).multiplyScalar(SIZE.bomb),
    sparkMat: new THREE.SpriteMaterial({ map: tex.spark(), color: 0xffb347, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  // Mine: a squat metal disc, hazard band and spikes (one mesh), and a light dome that blinks.
  const mineSpikes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    mineSpikes.push([part(new THREE.ConeGeometry(1.5, 6, 8), Math.cos(a) * 11, 4, Math.sin(a) * 11, 0, -a, -Math.PI / 2), 0x3a404d]);
  }
  M.mine = {
    body: baked([
      [part(new THREE.SphereGeometry(10, 22, 12).scale(1, 0.5, 1), 0, 4, 0), 0x2f3440],
      [part(new THREE.CylinderGeometry(8, 9.5, 1.6, 22), 0, 0.8, 0), 0x23272f],
      ...mineSpikes,
      [new THREE.TorusGeometry(9.7, 1.2, 8, 30).rotateX(Math.PI / 2).translate(0, 4, 0), 0xffd21f],
    ]).scale(SIZE.mine, SIZE.mine, SIZE.mine),
    bodyMat: std(0xffffff, 0.35, 0.45, vtx()),
    light: new THREE.SphereGeometry(2.8, 14, 8, 0, TAU, 0, Math.PI / 2).translate(0, 8.2, 0).scale(SIZE.mine, SIZE.mine, SIZE.mine),
    lightOff: std(0x7f1d1d, 0.3, 0.1), lightOn: new THREE.MeshBasicMaterial({ color: hdr(3, 0.25, 0.2) }),
    lightArming: new THREE.MeshBasicMaterial({ color: hdr(2.4, 1.8, 0.2) }),
    // Two halo materials, so an armed (red) mine and a fresh (amber) one can sit side by side.
    haloArmed: new THREE.SpriteMaterial({ map: tex.spark(), color: 0xff3030, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    haloArming: new THREE.SpriteMaterial({ map: tex.spark(), color: 0xffc040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  // Snowball: lumpy packed snow, white with blue in the dents (the lumps depend only on position,
  // so faces that share a corner stay joined).
  {
    const g = new THREE.IcosahedronGeometry(9, 2);
    const pos = g.attributes.position;
    const col = [];
    const v = new THREE.Vector3();
    const shade = new THREE.Color(0x9cc7f2);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = 0.9 + 0.1 * Math.sin(v.x * 1.7) * Math.sin(v.y * 2.1 + 1) * Math.sin(v.z * 1.9 + 2);
      v.multiplyScalar(n);
      pos.setXYZ(i, v.x, v.y, v.z);
      const c = new THREE.Color(0xffffff).lerp(shade, Math.max(0, Math.min(1, (0.97 - n) * 5)));
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    M.snow = { geo: g.scale(1.2, 1.2, 1.2), mat: std(0xffffff, 0.85, 0, vtx({ emissive: 0x1e3a5f, emissiveIntensity: 0.18 })) };
  }
  // Sticky bomb: a glossy pink goo blob with a steel cap and a red light that blinks.
  M.goo = {
    geo: baked([
      [new THREE.SphereGeometry(8, 18, 12).scale(1, 0.78, 1).translate(0, 5.5, 0), 0xec4899],
      [new THREE.SphereGeometry(4, 12, 8).translate(5.5, 2.5, 3), 0xdb2777],
      [new THREE.SphereGeometry(3.5, 12, 8).translate(-5, 2, -4), 0xdb2777],
      [new THREE.SphereGeometry(3, 10, 8).translate(-3, 2, 6), 0xf472b6],
      [new THREE.CylinderGeometry(2.6, 2.6, 2, 12).translate(0, 11.2, 0), 0x4b5563],
    ]).scale(1.3, 1.3, 1.3),
    mat: std(0xffffff, 0.22, 0.1, vtx({ emissive: 0x500724, emissiveIntensity: 0.35 })),
    light: new THREE.SphereGeometry(2.2, 12, 8, 0, TAU, 0, Math.PI / 2).translate(0, 12.2, 0).scale(1.3, 1.3, 1.3),
    lightOn: new THREE.MeshBasicMaterial({ color: hdr(3, 0.3, 0.3) }), lightOff: std(0x7f1d1d, 0.3, 0.1),
  };
  // Frozen karts: a block of clear blue ice round the whole kart.
  M.ice = {
    geo: new RoundedBoxGeometry(52, 32, 40, 2, 6).translate(0, 15, 0),
    mat: new THREE.MeshStandardMaterial({ color: 0xc7e9ff, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.5, emissive: 0x2f6fbf, emissiveIntensity: 0.3, depthWrite: false }),
  };
  // Spin spikes: a steel ring of spikes round the kart, spinning.
  const ringSpikes = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    ringSpikes.push([part(new THREE.ConeGeometry(2.8, 13, 8), Math.cos(a) * 36, 0, Math.sin(a) * 36, 0, -a, -Math.PI / 2), 0xe2e8f0]);
  }
  M.spikes = {
    geo: baked([[new THREE.TorusGeometry(31, 2.4, 8, 44).rotateX(Math.PI / 2), 0x475569], ...ringSpikes]),
    mat: std(0xffffff, 0.22, 0.9, vtx({ emissive: 0x334155, emissiveIntensity: 0.25 })),
  };
  M.peel = peelGeometry().scale(SIZE.peel, SIZE.peel, SIZE.peel);
  M.peelMat = std(0xffffff, 0.55, 0, vtx());
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
  // A decoy's "?" hangs upside down (the only tell, if you look); its owner's team sees it red.
  M.decoyQ = new THREE.SpriteMaterial({ map: questionTexture(), transparent: true, depthWrite: false, rotation: Math.PI });
  M.decoyOurs = new THREE.SpriteMaterial({ map: questionTexture(), transparent: true, depthWrite: false, rotation: Math.PI, color: 0xff6b6b });
  // Markers on the ground.
  M.ring = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
  M.disc = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  M.tick = new THREE.PlaneGeometry(0.1, 0.35).rotateX(-Math.PI / 2);
  M.plate = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2); // star light pool, shock ring
  M.tracer = new THREE.CylinderGeometry(1.5, 0.7, 1, 6, 1, true).rotateZ(Math.PI / 2);
  M.debris = new THREE.BoxGeometry(1, 1, 1);
  M.ready = true;
  return M;
}

// Banana peel: a short stub with a brown stem, and three thick flaps of uneven length that arc out
// and droop to the ground, their tips curling back up. Yellow outside, cream inside, a few brown
// speckles. Built at toy scale (about 20 across) as one vertex-coloured geometry.
function peelGeometry() {
  const YELLOW = new THREE.Color(0xf5c518);
  const DEEP = new THREE.Color(0xd99a06); // shading where a flap meets the stub and along its edges
  const CREAM = new THREE.Color(0xffe58a); // a warm inside, so it never goes olive in shadow
  const BROWN = new THREE.Color(0x5a3510);
  const SEG = 14;
  const COLS = 5;
  const THICK = 1.15;
  const parts = [];
  const flaps = [[0.25, 11.5], [2.4, 9.5], [4.3, 12.5]]; // [angle around the stub, length]
  for (const [a0, len] of flaps) {
    const pos = [];
    const col = [];
    const idx = [];
    const ring = 2 * (COLS + 1); // cross-section loop: top edge across, then the underside back
    const tops = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      // Over in a rounded arc from the top of the stub to the ground, along it, then a curl at the tip.
      const arc = Math.min(1, t / 0.62);
      const r = 2.2 + len * (0.74 * Math.sin((arc * Math.PI) / 2) + 0.26 * Math.max(0, (t - 0.62) / 0.38));
      const curl = t > 0.8 ? ((t - 0.8) / 0.2) ** 2 * 2.8 : 0;
      const y = 0.7 + 9.6 * Math.cos((arc * Math.PI) / 2) + curl;
      const w = 6.2 + 3.0 * Math.sin(Math.PI * t) - 5.2 * t ** 3; // width: broad middle, pointed tip
      const half = w / 2 / r;
      const row = [];
      for (let j = 0; j <= COLS; j++) {
        const s = (j / COLS) * 2 - 1;
        const ang = a0 + s * half;
        const cup = s * s * 1.1 * Math.sin(Math.PI * Math.min(1, t * 1.2)); // edges curl up a little
        row.push(new THREE.Vector3(Math.cos(ang) * r, y + cup, Math.sin(ang) * r));
      }
      tops.push(row);
    }
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const row = tops[i];
      // The underside sits THICK below the top surface (along the local surface normal).
      const along = tops[Math.min(SEG, i + 1)][2].clone().sub(tops[Math.max(0, i - 1)][2]);
      const across = row[COLS].clone().sub(row[0]);
      const n = across.cross(along).normalize();
      if (n.y < 0) n.negate();
      const tip = t > 0.88 ? BROWN : null;
      for (let j = 0; j <= COLS; j++) {
        const edge = Math.abs((j / COLS) * 2 - 1);
        pos.push(row[j].x, row[j].y, row[j].z);
        const c = tip || YELLOW.clone().lerp(DEEP, Math.max(t < 0.18 ? 1 - t / 0.18 : 0, edge > 0.7 ? 0.5 : 0));
        col.push(c.r, c.g, c.b);
      }
      for (let j = COLS; j >= 0; j--) {
        const p = row[j].clone().addScaledVector(n, -THICK);
        p.y = Math.max(0.05, p.y);
        pos.push(p.x, p.y, p.z);
        const c = tip || CREAM;
        col.push(c.r, c.g, c.b);
      }
    }
    // Stitch each cross-section loop to the next (outward-facing winding), then cap the tip.
    for (let i = 0; i < SEG; i++) {
      for (let k = 0; k < ring; k++) {
        const a = i * ring + k;
        const b = (i + 1) * ring + k;
        const c = i * ring + ((k + 1) % ring);
        const d = (i + 1) * ring + ((k + 1) % ring);
        idx.push(a, c, b, c, d, b);
      }
    }
    const end = SEG * ring;
    for (let k = 1; k < ring - 1; k++) idx.push(end, end + k, end + k + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
    // Two brown speckles on the top of each flap.
    for (const [i, j] of [[5, 2], [8, 3]]) {
      const p = tops[i][j];
      const q = tops[i + 1][j].clone().sub(tops[i - 1][j]);
      const tilt = Math.atan2(q.y, Math.hypot(q.x, q.z));
      const dir = Math.atan2(q.z, q.x);
      const up = 0.15; // lifted off the surface along its normal
      const dot = new THREE.CircleGeometry(0.55 + (i % 3) * 0.15, 7).rotateX(-Math.PI / 2).rotateZ(tilt).rotateY(-dir);
      dot.translate(p.x - Math.sin(tilt) * Math.cos(dir) * up, p.y + Math.cos(tilt) * up, p.z - Math.sin(tilt) * Math.sin(dir) * up);
      parts.push(tinted(dot, BROWN));
    }
  }
  // The stub where the flaps meet, and the stem on top.
  parts.push(tinted(new THREE.CylinderGeometry(2.4, 3.2, 10.5, 14).translate(0, 5.25, 0), YELLOW));
  parts.push(tinted(new THREE.SphereGeometry(2.4, 14, 6, 0, TAU, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 10.5, 0), DEEP));
  parts.push(tinted(new THREE.CylinderGeometry(1.0, 1.35, 3.4, 8).translate(0, 12.6, 0), BROWN));
  return mergeGeometries(parts);
}
function tinted(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function buildModel(kind) {
  const m = models();
  const g = new THREE.Group();
  const mesh = (geo, mat) => new THREE.Mesh(geo, mat);
  // Projectiles cast real shadows on desktop. Things lying on the ground, carried items and every
  // item on phones don't: each caster costs a second draw in the shadow pass.
  const cast = !MOBILE && ['rocket', 'bouncer', 'bomb', 'comet', 'snowball', 'sticky'].includes(kind);
  let body = null;
  if (kind === 'rocket' || kind === 'mini') {
    const spin = new THREE.Group(); // rolls around its own axis in flight
    body = mesh(m.rocket.geo, m.rocket.mat);
    spin.add(body);
    g.add(spin);
    g.userData.spin = spin;
    if (kind === 'rocket') {
      const flame = mesh(m.rocket.flame, m.rocket.flameMat);
      g.add(flame);
      g.userData.flame = flame;
    }
  } else if (kind === 'bouncer') {
    const spin = new THREE.Group();
    body = mesh(m.shell.geo, m.shell.mat);
    spin.add(body);
    g.add(spin);
    g.userData.spin = spin;
  } else if (kind === 'comet') {
    const C = m.comet;
    const spin = new THREE.Group();
    body = mesh(C.spikes, C.spikeMat);
    spin.add(mesh(C.core, C.coreMat), body);
    const ring = mesh(C.ring, C.ringMat);
    const halo = new THREE.Sprite(C.haloMat);
    halo.scale.set(100, 100, 1);
    g.add(spin, ring, halo);
    Object.assign(g.userData, { spin, ring, halo });
  } else if (kind === 'bomb') {
    const B = m.bomb;
    const tumble = new THREE.Group();
    body = mesh(B.geo, B.mat);
    const spark = new THREE.Sprite(B.sparkMat);
    spark.position.copy(B.tip);
    spark.scale.set(16, 16, 1);
    tumble.add(body, spark);
    g.add(tumble);
    Object.assign(g.userData, { spin: tumble, spark });
  } else if (kind === 'mine') {
    const N = m.mine;
    body = mesh(N.body, N.bodyMat);
    const light = mesh(N.light, N.lightOff);
    const halo = new THREE.Sprite(N.haloArming);
    halo.position.y = 9.5 * SIZE.mine;
    halo.scale.set(30, 30, 1);
    g.add(body, light, halo);
    Object.assign(g.userData, { light, halo });
  } else if (kind === 'banana') {
    body = mesh(m.peel, m.peelMat);
    g.add(body);
  } else if (kind === 'snowball') {
    const spin = new THREE.Group();
    body = mesh(m.snow.geo, m.snow.mat);
    spin.add(body);
    g.add(spin);
    g.userData.spin = spin;
  } else if (kind === 'sticky') {
    const G = m.goo;
    body = mesh(G.geo, G.mat);
    const light = mesh(G.light, G.lightOff);
    g.add(body, light);
    g.userData.light = light;
  } else if (kind === 'ice') {
    body = mesh(m.ice.geo, m.ice.mat);
    body.renderOrder = 6;
    g.add(body);
  } else if (kind === 'spikeRing') {
    body = mesh(m.spikes.geo, m.spikes.mat);
    g.add(body);
  }
  Object.assign(g.userData, { kind, body, cast });
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
      const floor = this.ground(this.p[o], this.p[o + 2], this.under ? this.under(this.p[o], this.p[o + 2], this.p[o + 1]) : undefined) + this.s[i] * 0.5;
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

// The rainbow glass of an item box (and of a decoy pretending to be one).
function boxMaterial(fog) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: TIME, uAlpha: { value: 1 }, uFlash: { value: 0 },
      // (Exponential fog has no near and far: a linear ramp that looks about the same.)
      uFogColor: { value: fog.color }, uFogNear: { value: fog.isFogExp2 ? 0 : fog.near }, uFogFar: { value: fog.isFogExp2 ? 2.2 / fog.density : fog.far },
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
        // (Right up against the lens a box would fill the screen: it fades out instead.)
        float a = clamp(0.42 + f * 0.45 + edge * 0.5 + spec, 0.0, 1.0) * uAlpha * smoothstep(40.0, 95.0, length(vW - cameraPosition));
        float fogF = smoothstep(uFogNear, uFogFar, length(vW - cameraPosition));
        gl_FragColor = vec4(mix(col, uFogColor, fogF), a);
      }`,
    transparent: true,
    depthWrite: false,
  });
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
    // Ground height under (x, z): y when it's known (layered arenas give everything its height),
    // else 0 on flat maps or heightAt() on maps with hills.
    this.ground = (x, z, y) => (Number.isFinite(y) ? y : this.map.heightAt ? this.map.heightAt(x, z) : 0);
    // Layered arenas: every shot, trap and decoy row ends with its height.
    this.layered = !!this.map.layered;
    const ground = this.ground;
    this.rowY = (row, x, z) => (this.layered ? row[row.length - 1] : ground(x, z));
    this.pools = {};
    this.shots = new Map(); // shot id -> { kind, obj, marker, last... }
    this.mines = new Map();
    this.bananas = new Map();
    this.effects = [];
    this.bolts = [];
    this.debris = new Debris(this.scene, MOBILE ? 160 : 400, this.ground);
    if (this.layered) {
      // Debris bounces on whatever floor is under it at its own height (it can fall off a ledge).
      const map = this.map;
      this.debris.under = (x, z, y) => { const f = map.floorAt(x, z, y + window.KartCore.Layers.STEP, 0); return Number.isFinite(f) ? f : map.deathZ; };
    }
    this.c = {
      rainbow: [0xff5d73, 0xffb347, 0xfde047, 0x4ade80, 0x38bdf8, 0xa78bfa].map((h) => new THREE.Color(h)),
      flame: [new THREE.Color(0xffe066), new THREE.Color(0xff8c1a), new THREE.Color(0xff4d00)],
      comet: [new THREE.Color(0xe0e7ff), new THREE.Color(0x8fb4ff), new THREE.Color(0xa78bfa), new THREE.Color(0x60a5fa)],
      ink: new THREE.Color(0x1a0f2e), inkHi: new THREE.Color(0x4c1d95),
      mint: new THREE.Color(0x6ee7b7), white: new THREE.Color(0xffffff), electric: new THREE.Color(0x9bd5ff),
      smoke: new THREE.Color(r.theme.night ? 0x4a4560 : 0x9aa0aa), shell: new THREE.Color(0x10b981),
      puff: new THREE.Color(r.theme.night ? 0x6a6585 : 0xe8ecf2), plume: new THREE.Color(0x3b2a8f),
      fireball: [new THREE.Color(0xf5d0fe), new THREE.Color(0xa78bfa), new THREE.Color(0x7c3aed)],
      shockRing: new THREE.Color(0.35, 0.7, 1), cometRing: new THREE.Color(0.75, 0.45, 1.3),
      frost: new THREE.Color(0xbfe3ff), ice: new THREE.Color(0x7dd3fc),
      goo: [new THREE.Color(0xf472b6), new THREE.Color(0xdb2777), new THREE.Color(0xfbcfe8)],
    };
    this.stickyGround = new Map();
    this.decoyBoxes = new Map();

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
      const mat = boxMaterial(fog);
      const mesh = new THREE.Mesh(m.box, mat);
      mesh.castShadow = true;
      mesh.renderOrder = 4;
      const ink = outlined(mesh); // the cartoon ink outline, like the karts'
      const q = new THREE.Sprite(m.questionMat);
      q.scale.set(17, 17, 1);
      q.renderOrder = 3;
      const g = new THREE.Group();
      g.add(mesh, q);
      const gy = this.ground(b.x, b.y, this.layered ? b.z : undefined);
      g.position.set(b.x, gy + 22, b.y);
      this.scene.add(g);
      return { g, mesh, mat, ink, x: b.x, z: b.y, gy, phase: i * 0.7, state: 'on', t: 0 };
    });
  }

  // A decoy: the same glass box, a "?" hanging upside down. Pooled, own material each.
  buildDecoy() {
    const m = models();
    const mat = boxMaterial(this.scene.fog);
    const mesh = new THREE.Mesh(m.box, mat);
    mesh.renderOrder = 4;
    outlined(mesh);
    const q = new THREE.Sprite(m.decoyQ);
    q.scale.set(17, 17, 1);
    q.renderOrder = 3;
    const g = new THREE.Group();
    g.add(mesh, q);
    Object.assign(g.userData, { kind: 'decoy', mats: [mat], mesh, q, mat });
    return g;
  }

  // ---------- pools ----------
  get(kind) {
    const list = this.pools[kind] || (this.pools[kind] = []);
    let obj = list.pop();
    if (!obj) {
      if (kind === 'marker' || kind === 'reticle' || kind === 'pulse' || kind === 'aim') obj = this.buildMarker(kind);
      else if (kind === 'decoy') obj = this.buildDecoy();
      else if (kind === 'shock') obj = this.buildShock();
      else if (kind === 'flare') obj = this.buildFlare();
      else obj = buildModel(kind);
      this.scene.add(obj);
    }
    obj.visible = true;
    obj.scale.setScalar(1);
    obj.rotation.set(0, 0, 0);
    obj.position.set(0, 0, 0);
    if (obj.userData.body) obj.userData.body.castShadow = obj.userData.cast;
    return obj;
  }

  put(obj) {
    if (!obj) return;
    obj.visible = false;
    if (obj.parent !== this.scene) this.scene.add(obj);
    (this.pools[obj.userData.kind] || (this.pools[obj.userData.kind] = [])).push(obj);
  }

  // My own bomb, aimed but not thrown yet: a gold ring the size of the blast where it will land and
  // a dotted arc from the kart to it. aim: { x, z, fromX, fromZ, t } or null to hide.
  setAim(aim) {
    if (!aim) {
      if (this.aimMarker) { this.put(this.aimMarker); this.aimMarker = null; }
      if (this.aimDots) this.aimDots.visible = false;
      return;
    }
    if (!this.aimMarker) this.aimMarker = this.get('aim');
    const gy = this.ground(aim.x, aim.z, aim.y);
    this.aimMarker.position.set(aim.x, gy + 1.6, aim.z);
    this.aimMarker.scale.setScalar(140);
    this.aimMarker.rotation.y = aim.t * 1.5;
    this.aimMarker.userData.mat.opacity = 0.6 + 0.25 * Math.sin(aim.t * 8);
    const N = 18;
    if (!this.aimDots) {
      const mat = new THREE.MeshBasicMaterial({ color: hdr(2.2, 1.7, 0.45), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
      this.aimDots = new THREE.InstancedMesh(new THREE.SphereGeometry(2.6, 8, 6), mat, N);
      this.aimDots.frustumCulled = false;
      this.aimDots.renderOrder = 6;
      this.scene.add(this.aimDots);
    }
    this.aimDots.visible = true;
    // The same arc a thrown bomb flies (see the bomb shot above), dots marching along it.
    const g0 = this.ground(aim.fromX, aim.fromZ, aim.fromY);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const f = ((i + (aim.t * 2.5) % 1) / N);
      const x = aim.fromX + (aim.x - aim.fromX) * f;
      const z = aim.fromZ + (aim.z - aim.fromZ) * f;
      const y = g0 + (gy - g0) * f + 12 + Math.sin(f * Math.PI) * 110;
      m4.makeTranslation(x, y, z);
      this.aimDots.setMatrixAt(i, m4);
    }
    this.aimDots.instanceMatrix.needsUpdate = true;
  }

  // Ground markers: bomb landing zones, comet target reticles, mine pulses. Own material each (own opacity).
  buildMarker(kind) {
    const m = models();
    const g = new THREE.Group();
    const color = kind === 'reticle' ? hdr(1.4, 0.6, 2.4) : kind === 'pulse' ? hdr(2, 0.2, 0.2) : kind === 'aim' ? hdr(2.2, 1.7, 0.45) : hdr(2.4, 0.5, 0.3);
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

  // A ring of lightning racing outwards over the ground (shock, comet impact). Pooled with its own
  // material, so the shader is compiled once and never thrown away mid-race.
  buildShock() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: TIME, uP: { value: 0 }, uColor: { value: new THREE.Color(0.35, 0.7, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime; uniform float uP; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p); float a = atan(p.y, p.x);
          float jag = 0.035 * sin(a * 23.0 + uTime * 47.0) + 0.025 * sin(a * 61.0 - uTime * 31.0) + 0.015 * sin(a * 7.0 + uTime * 13.0);
          float d = abs(r - uP + jag);
          // A crisp ring with a thin glow: no wash over the inside, so a shock next to the camera
          // never whites out the screen.
          float core = smoothstep(0.03, 0.0, d);
          float halo = smoothstep(0.08, 0.0, d) * 0.25;
          float inner = smoothstep(uP, 0.0, r) * 0.04 * (1.0 - uP);
          float fade = 1.0 - uP * uP;
          vec3 col = mix(uColor, vec3(1.0), core) * 1.5;
          gl_FragColor = vec4(col, (core + halo + inner) * fade);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(models().plate, mat);
    disc.renderOrder = 5;
    disc.userData = { kind: 'shock', mats: [mat], mat };
    return disc;
  }

  // A bright camera-facing flash (comet impact). Pooled, own material for its own fade.
  buildFlare() {
    const mat = new THREE.SpriteMaterial({ map: tex.spark(), color: hdr(2.2, 1.9, 3.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 6;
    sprite.userData = { kind: 'flare', mats: [mat], mat };
    return sprite;
  }

  // Every item shader compiles here, before the race, instead of with a stutter on first use:
  // one of each model, marker, aura and effect is parked under the ground for the first frame
  // (extra: kart materials such as the star, ghost and shield skins). Call coolDown() after it.
  warmUp(extra = []) {
    const objs = ['rocket', 'mini', 'bouncer', 'comet', 'bomb', 'mine', 'banana', 'marker', 'reticle', 'pulse', 'shock', 'flare'].map((kind) => this.get(kind));
    const temp = new THREE.Group();
    const G = models().gun;
    const box = new THREE.BoxGeometry(4, 4, 4);
    temp.add(new THREE.Mesh(G.barrels, G.barrelMat), new THREE.Mesh(G.housing, G.housingMat), new THREE.Mesh(G.flash, G.flashMat), new THREE.Mesh(models().plate, starGlow()));
    for (const mat of extra) temp.add(new THREE.Mesh(box, mat));
    this.scene.add(temp);
    const bolt = this.bolt();
    bolt.shape(new THREE.Vector3(0, -300, 0), new THREE.Vector3(10, -320, 0), 5, 0.2, this.r.camera);
    for (const o of [...objs, temp, bolt.mesh]) {
      o.position.set(this.map.center[0], -400, this.map.center[1]);
      o.traverse((c) => { c.frustumCulled = false; if (c.isMesh) c.castShadow = true; });
    }
    return { objs, temp, bolt, box };
  }

  coolDown(w) {
    for (const o of [...w.objs, w.temp, w.bolt.mesh]) o.traverse((c) => { c.frustumCulled = true; c.castShadow = false; });
    w.bolt.mesh.frustumCulled = false;
    w.bolt.busy = false;
    w.bolt.mesh.visible = false;
    this.scene.remove(w.temp);
    w.box.dispose();
    for (const o of w.objs) this.put(o);
  }

  // ---------- per-kart visuals ----------
  // kart: the Kart3D kart record; k: the interpolated row { x, y, angle, speed, flags, item, ammo, roulette }.
  kart(kart, k, dt, t, isMe) {
    const fx = kart.fx || (kart.fx = { held: null, heldKind: 0, orbit: null, orbitN: 0, gun: null, glow: null, scale: 1, drip: 0, sparkle: 0 });
    const ready = !!k.item && !k.roulette;

    // Thunder victims shrink (and spring back).
    const scale = k.flags & FLAG.shrunk ? 0.55 : 1;
    fx.scale += (scale - fx.scale) * Math.min(1, dt * (scale < fx.scale ? 12 : 5));
    kart.group.scale.setScalar(fx.scale);

    // Banana, mine or bouncer shell trailing behind the kart: smaller than when thrown, and far
    // enough back to clear the rear wing and stay under the chase camera's view of the kart.
    const held = ready && [CODE.banana, CODE.mine, CODE.bouncer].includes(k.item) ? k.item : 0;
    if (held !== fx.heldKind) {
      this.put(fx.held);
      fx.held = null;
      fx.heldKind = held;
      if (held) {
        const obj = this.get(K.ITEMS[held - 1]);
        obj.userData.body.castShadow = false;
        obj.scale.setScalar(HELD);
        if (obj.userData.halo) { // a mine in tow is not armed: no red glow washing over the kart
          obj.userData.halo.visible = false;
          obj.userData.light.material = models().mine.lightOff;
        }
        kart.group.add(obj);
        fx.held = obj;
      }
    }
    if (fx.held) {
      const sway = Math.sin(t * 5 + k.idx) * 0.15 - (kart.steer || 0) * 0.35;
      fx.held.position.set(-50 * Math.cos(sway), 0.3, -50 * Math.sin(sway));
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
        r.position.set(Math.cos(a) * 42, 18 + Math.sin(t * 4 + i * 2) * 2, Math.sin(a) * 42); // clear of the kart's corners
        r.rotation.set(0, -a - Math.PI / 2, 0);
        r.scale.setScalar(0.36);
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
      // It pops into place (an elastic overshoot) when it appears.
      if (showGun && !fx.gunWas) fx.gunT = 0;
      fx.gunWas = showGun;
      if (showGun && fx.gunT < 0.5) {
        fx.gunT += dt;
        fx.gun.scale.setScalar(Math.max(0.001, ease.outElastic(Math.min(1, fx.gunT / 0.45))));
      }
      fx.gun.visible = showGun;
      if (showGun) {
        const { barrels, flash } = fx.gun.userData;
        barrels.rotation.x += dt * (firing ? 40 : 2);
        flash.visible = firing && Math.random() > 0.25;
        if (flash.visible) { flash.scale.setScalar(rand(0.6, 1.25)); flash.rotation.x = rand(0, TAU); }
      }
    }

    // The weapon it's carrying, on the kart (kart3d/mounts.js): it pops on with an elastic overshoot
    // when the roulette lands and shrinks away when it's fired.
    const want = ready ? MOUNT_OF[K.ITEMS[k.item - 1]] || null : null;
    if (want !== fx.mountKind) {
      if (fx.mount) { fx.mountOut = fx.mount; fx.mountOutT = 0; }
      fx.mount = null;
      fx.mountKind = want;
      if (want) {
        fx.mounts = fx.mounts || {};
        const m = fx.mounts[want] || (fx.mounts[want] = buildMount(want));
        if (m) {
          if (fx.mountOut === m) fx.mountOut = null;
          if (m.parent !== kart.chassis) kart.chassis.add(m);
          m.visible = true;
          fx.mount = m;
          fx.mountT = 0;
        }
      }
    }
    if (fx.mount) {
      fx.mountT += dt;
      fx.mount.scale.setScalar(Math.max(0.001, ease.outElastic(Math.min(1, fx.mountT / 0.5))));
      fx.mount.visible = !kart.ghosted && kart.fade >= 1;
    }
    if (fx.mountOut) {
      fx.mountOutT += dt;
      const p = Math.min(1, fx.mountOutT / 0.14);
      fx.mountOut.scale.setScalar(Math.max(0.001, 1 - p));
      if (p >= 1) { fx.mountOut.visible = false; fx.mountOut = null; }
    }

    // Star: the kart itself runs through the rainbow (Kart3D swaps in starVariant() materials), a
    // pool of rainbow light follows it over the ground and sparkles stream off it.
    const star = !!(k.flags & FLAG.star);
    if (star && !fx.glow) {
      fx.glow = new THREE.Mesh(models().plate, starGlow());
      fx.glow.position.y = 1.5;
      fx.glow.renderOrder = 2;
      kart.group.add(fx.glow);
    }
    if (fx.glow) {
      fx.glow.visible = star;
      if (star) fx.glow.scale.setScalar(46 + Math.sin(t * 18) * 5);
    }
    const gy = this.ground(k.x, k.y, this.layered ? k.z : undefined);
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

    // Frozen: a block of ice round the kart; frost puffs out as it freezes over.
    const frozen = !!(k.flags & FLAG.frozen);
    if (frozen && !fx.ice) {
      fx.ice = this.get('ice');
      kart.group.add(fx.ice);
      fx.iceT = 0;
      for (let i = 0; i < 18; i++) {
        const a = rand(0, TAU);
        this.fire.emit(k.x + Math.cos(a) * 20, gy + rand(4, 30), k.y + Math.sin(a) * 20, Math.cos(a) * rand(40, 120), rand(20, 80), Math.sin(a) * rand(40, 120), this.c.frost, rand(6, 10), 0.5, { drag: 2.5 });
      }
    } else if (!frozen && fx.ice) {
      this.put(fx.ice);
      fx.ice = null;
    }
    if (fx.ice) {
      fx.iceT += dt;
      const grow = Math.min(1, fx.iceT / 0.18);
      fx.ice.scale.set(grow, grow, grow);
      fx.ice.position.y = 0;
    }

    // Spin spikes: a ring of steel spikes whirling round the kart.
    const spiky = !!(k.flags & FLAG.spikes);
    if (spiky && !fx.spk) { fx.spk = this.get('spikeRing'); kart.group.add(fx.spk); }
    else if (!spiky && fx.spk) { this.put(fx.spk); fx.spk = null; }
    if (fx.spk) {
      fx.spk.position.set(0, 9, 0);
      fx.spk.rotation.y = t * 9;
    }

    // A sticky bomb riding on the kart: the light blinks faster as the fuse burns down.
    const fuse = k.sticky || 0; // tenths of a second left
    if (fuse > 0 && !fx.goo) { fx.goo = this.get('sticky'); kart.group.add(fx.goo); }
    else if (!fuse && fx.goo) { this.put(fx.goo); fx.goo = null; }
    if (fx.goo) {
      const rate = fuse < 8 ? 14 : fuse < 16 ? 8 : 4;
      // On the back of the kart, clear of the driver, where the chase camera sees it.
      fx.goo.position.set(-24, 17, 0);
      fx.goo.scale.setScalar(1.05 + Math.max(0, Math.sin(t * rate * Math.PI)) * 0.1);
      fx.goo.userData.light.material = Math.floor(t * rate) % 2 ? models().goo.lightOn : models().goo.lightOff;
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
    for (const m of [fx.mount, fx.mountOut]) if (m) m.visible = false;
    fx.mount = null;
    fx.mountOut = null;
    fx.mountKind = null;
    for (const key of ['ice', 'spk', 'goo']) { this.put(fx[key]); fx[key] = null; }
  }

  // ---------- per frame ----------
  // view: { shots:[[id,kind,x,y,a,prog|alt,...extra]], mines:[[id,x,y,armed]], bananas:[[id,x,y]], boxes:[0|1], karts }
  update(view, dt, t, now) {
    TIME.value = t;
    starGlow().color.setHSL((t * 1.6) % 1, 1, 0.55);
    this.updateShots(view.shots || [], view.karts || [], dt, t);
    this.updateMines(view.mines || [], dt, now);
    this.updateBananas(view.bananas || [], dt);
    this.updateStickies(view.stickies || [], dt, t);
    this.updateDecoys(view.decoys || [], dt, t);
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
      const gy = this.rowY(row, x, z);
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
        const name = kind === SHOT.rocket ? 'rocket' : kind === SHOT.bomb ? 'bomb' : kind === SHOT.bouncer ? 'bouncer'
          : kind === SHOT.snowball ? 'snowball' : kind === SHOT.sticky ? 'sticky' : 'comet';
        s = { kind, obj: this.get(name), marker: null, lastA: a, lastAlt: p, age: 0, px: x, pz: z, trail: {} };
        this.shots.set(id, s);
        if (kind === SHOT.comet) this.cometLaunch(x, gy, z);
      }
      s.age += dt;
      const o = s.obj;
      // Trails are emitted at a fixed rate per second and spread along the stretch flown since the
      // last frame: the same density at 30, 60 or 144 fps, and no gaps on slow phones.
      // emit(tx, tz) gets evenly spaced points on that stretch.
      const trail = (name, rate, emit) => {
        const n = this.burst(s.trail, name, rate, dt);
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          emit(s.px + (x - s.px) * f, s.pz + (z - s.pz) * f);
        }
      };
      if (kind === SHOT.rocket) {
        o.position.set(x, gy + 15, z);
        o.rotation.y = -a;
        o.userData.spin.rotation.x += dt * 9;
        o.userData.flame.scale.set(rand(0.8, 1.3), rand(0.85, 1.15), rand(0.85, 1.15));
        trail('fire', MOBILE ? 30 : 60, (tx, tz) => this.fire.emit(tx - ca * 32, gy + 15, tz - sa * 32, -ca * 60 + rand(-15, 15), rand(-15, 15), -sa * 60 + rand(-15, 15),
          this.c.flame[Math.floor(rand(0, 3))], rand(12, 18), 0.16, { grow: 0.4 }));
        trail('smoke', MOBILE ? 20 : 45, (tx, tz) => this.smoke.emit(tx - ca * 38, gy + 15, tz - sa * 38, rand(-8, 8), rand(6, 16), rand(-8, 8), this.c.puff, rand(8, 11), 0.8, { alpha: 0.42, grow: 2.4, drag: 1 }));
      } else if (kind === SHOT.bomb) {
        // Lobbed: arcs up and down, tumbling, fuse fizzing. The landing spot is marked on the ground.
        // (Layered arenas send the bomb's height on its arc, and where it will land: [.. lx, ly, lz, z].)
        const prog = Math.min(1, (p || 0) / 100);
        o.position.set(x, this.layered ? gy + 12 : gy + 12 + Math.sin(prog * Math.PI) * 110, z);
        o.rotation.y = -a;
        o.userData.spin.rotation.z -= dt * 7;
        o.userData.spark.scale.setScalar(rand(9, 16));
        const tip = o.userData.spark.getWorldPosition(v);
        const sparks = this.burst(s.trail, 'fuse', MOBILE ? 30 : 60, dt);
        for (let i = 0; i < sparks; i++) this.fire.emit(tip.x, tip.y, tip.z, rand(-60, 60), rand(20, 90), rand(-60, 60), this.c.flame[Math.floor(rand(0, 2))], rand(3, 5), 0.3, { drag: 2, rise: -300 });
        if (row.length >= 8) {
          if (!s.marker) s.marker = this.get('marker');
          const lx = row[6];
          const lz = row[7];
          const size = 140 * (1.25 - 0.25 * prog);
          s.marker.position.set(lx, this.ground(lx, lz, this.layered ? row[8] : undefined) + 1.5, lz);
          s.marker.scale.setScalar(size);
          s.marker.rotation.y = t * 2;
          s.marker.userData.mat.opacity = 0.45 + 0.4 * Math.abs(Math.sin(t * 10));
        }
      } else if (kind === SHOT.snowball) {
        // Straight and fast, spinning, shedding frost.
        o.position.set(x, gy + 16, z);
        o.rotation.y = -a;
        o.userData.spin.rotation.z -= dt * 14;
        trail('frost', MOBILE ? 25 : 55, (tx, tz) => this.fire.emit(tx - ca * 12 + rand(-4, 4), gy + 16 + rand(-4, 4), tz - sa * 12 + rand(-4, 4), -ca * 30 + rand(-20, 20), rand(-10, 25), -sa * 30 + rand(-20, 20),
          Math.random() < 0.5 ? this.c.white : this.c.frost, rand(4, 7), 0.45, { drag: 2, rise: -120 }));
      } else if (kind === SHOT.sticky) {
        // A short low lob, wobbling, light blinking, dripping goo.
        const prog = Math.min(1, (p || 0) / 100);
        o.position.set(x, gy + 8 + Math.sin(prog * Math.PI) * 45, z);
        o.rotation.y += dt * 8;
        o.scale.set(1 + Math.sin(t * 30) * 0.06, 1 - Math.sin(t * 30) * 0.06, 1);
        o.userData.light.material = Math.floor(t * 8) % 2 ? models().goo.lightOn : models().goo.lightOff;
        trail('goo', MOBILE ? 10 : 22, (tx, tz) => this.fire.emit(tx, o.position.y, tz, rand(-15, 15), rand(-20, 10), rand(-15, 15), this.c.goo[Math.floor(rand(0, 3))], rand(4, 7), 0.5, { drag: 1, rise: -400 }));
      } else if (kind === SHOT.bouncer) {
        o.position.set(x, gy + 0.5 + Math.abs(Math.sin(s.age * 14)) * 1.5, z);
        o.userData.spin.rotation.y += dt * 18;
        if (Math.abs(wrap(a - s.lastA)) > 0.6) this.bounceFx(x, gy, z);
        trail('spark', MOBILE ? 15 : 30, (tx, tz) => this.fire.emit(tx - ca * 10, gy + 4, tz - sa * 10, rand(-20, 20), rand(10, 40), rand(-20, 20), this.c.mint, rand(4, 7), 0.3, { drag: 2 }));
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
        // The glow shrinks and lifts as the comet comes down, so the ground never slices through it.
        const lift = 16 + alt;
        const hs = (95 + Math.sin(t * 20) * 12) * Math.max(0.4, Math.min(1, lift / 70));
        o.userData.halo.scale.setScalar(hs);
        o.userData.halo.position.y = Math.max(0, hs * 0.32 - lift);
        // Tail: bright sparks plus a darker indigo plume so it reads against a daytime sky.
        const y0 = o.position.y;
        trail('fire', MOBILE ? 90 : 200, (tx, tz) => this.fire.emit(tx - ca * 16 + rand(-8, 8), y0 + rand(-8, 8), tz - sa * 16 + rand(-8, 8), -ca * 90 + rand(-30, 30), rand(-30, 30), -sa * 90 + rand(-30, 30),
          this.c.comet[Math.floor(rand(0, 4))], rand(16, 28), rand(0.35, 0.7), { grow: 0.5, drag: 1.5 }));
        trail('smoke', MOBILE ? 25 : 50, (tx, tz) => this.smoke.emit(tx - ca * 26, y0, tz - sa * 26, -ca * 40 + rand(-20, 20), rand(-10, 10), -sa * 40 + rand(-20, 20), this.c.plume, rand(18, 26), 0.8, { alpha: 0.55, grow: 1.6, drag: 1 }));
        const target = row[6] >= 0 ? karts.find((kk) => kk.idx === row[6]) : null;
        if (target && !(target.flags & FLAG.dead)) {
          if (!s.marker) s.marker = this.get('reticle');
          const near = Math.max(0, 1 - Math.hypot(target.x - x, target.y - z) / 2500);
          s.marker.position.set(target.x, this.ground(target.x, target.y, this.layered ? target.z : undefined) + 1.6, target.y);
          s.marker.scale.setScalar(60 + 50 * (1 - near) + Math.sin(t * 12) * 6);
          s.marker.rotation.y = -t * 3;
          s.marker.userData.mat.opacity = 0.5 + 0.45 * near;
        } else if (s.marker) { this.put(s.marker); s.marker = null; }
        s.lastAlt = alt;
      }
      s.lastA = a;
      s.px = x;
      s.pz = z;
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

  // How many particles a `rate`-per-second emitter owes this frame (fractions carry over).
  burst(acc, name, rate, dt) {
    acc[name] = (acc[name] || 0) + rate * dt;
    const n = Math.floor(acc[name]);
    acc[name] -= n;
    return n;
  }

  updateMines(list, dt, now) {
    const live = new Set();
    for (const row of list) {
      const [id, x, z, armed] = row;
      live.add(id);
      let m = this.mines.get(id);
      if (!m) {
        m = { obj: this.get('mine'), pulse: this.get('pulse'), t: 0 };
        m.obj.rotation.y = rand(0, TAU);
        this.mines.set(id, m);
      }
      m.t += dt;
      const gy = this.rowY(row, x, z);
      // Dropped: falls and bounces once, then sits flat.
      const drop = Math.max(0, 1 - m.t / 0.35);
      m.obj.position.set(x, gy + 0.3 + Math.abs(Math.cos(m.t * 9)) * 16 * drop * drop, z);
      const { light, halo } = m.obj.userData;
      const on = armed ? Math.floor(now / 160) % 2 === 0 : true;
      const N = models().mine;
      light.material = !on ? N.lightOff : armed ? N.lightOn : N.lightArming;
      halo.visible = on;
      halo.material = armed ? N.haloArmed : N.haloArming;
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
    for (const row of list) {
      const [id, x, z] = row;
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
      b.gy = this.rowY(row, x, z);
      const pop = Math.min(1, b.t / 0.25);
      b.obj.scale.setScalar(0.3 + 0.7 * (1 - (1 - pop) ** 3) + Math.sin(pop * Math.PI) * 0.15);
      b.obj.position.set(x, b.gy + 0.2, z);
    }
    for (const [id, b] of this.bananas) {
      if (live.has(id)) continue;
      // Squashed or swept away: peel bits fly off.
      const gy = b.gy ?? this.ground(b.x, b.z);
      for (let i = 0; i < 6; i++) {
        const a = rand(0, TAU);
        this.debris.emit(b.x, gy + 6, b.z, Math.cos(a) * rand(60, 140), rand(150, 300), Math.sin(a) * rand(60, 140), rand(2.5, 4.5), i % 3 ? 0xfacc15 : 0x8a5a1c, rand(0.8, 1.3));
      }
      this.put(b.obj);
      this.bananas.delete(id);
    }
  }

  // Sticky bombs lying on the ground, light blinking slowly: rows [id, x, z].
  updateStickies(list, dt, t) {
    const live = new Set();
    for (const row of list) {
      const [id, x, z] = row;
      live.add(id);
      let g = this.stickyGround.get(id);
      if (!g) {
        g = { obj: this.get('sticky'), t: 0 };
        g.obj.rotation.y = rand(0, TAU);
        this.stickyGround.set(id, g);
      }
      g.t += dt;
      const splat = Math.max(0, 1 - g.t / 0.3);
      g.obj.scale.set(1 + 0.3 * splat, 1 - 0.45 * splat, 1 + 0.3 * splat);
      g.obj.position.set(x, this.rowY(row, x, z) + 0.2, z);
      g.obj.userData.light.material = Math.floor(t * 3) % 2 ? models().goo.lightOn : models().goo.lightOff;
    }
    for (const [id, g] of this.stickyGround) {
      if (live.has(id)) continue;
      this.put(g.obj);
      this.stickyGround.delete(id);
    }
  }

  // Decoys: rows [id, x, z, owner idx, ours, (layered arenas) height]. They bob like real boxes but
  // spin the other way, and their "?" hangs upside down; to the owner's team they show red.
  updateDecoys(list, dt, t) {
    const live = new Set();
    for (const row of list) {
      const [id, x, z, , ours] = row;
      live.add(id);
      let d = this.decoyBoxes.get(id);
      if (!d) {
        d = { obj: this.get('decoy'), t: 0, phase: rand(0, 6) };
        this.decoyBoxes.set(id, d);
      }
      d.t += dt;
      const { mesh, q, mat } = d.obj.userData;
      q.material = ours ? models().decoyOurs : models().decoyQ;
      mat.uniforms.uAlpha.value = 1;
      mat.uniforms.uFlash.value = 0;
      const pop = Math.min(1, d.t / 0.55);
      d.obj.scale.setScalar(Math.max(0.01, 1 - Math.cos(pop * Math.PI * 2.5) * Math.exp(-pop * 5)));
      mesh.rotation.set(-(t * 0.9 + d.phase), -(t * 1.3 + d.phase), 0);
      d.obj.position.set(x, this.ground(x, z, this.layered ? row[5] : undefined) + 22 + Math.sin(t * 2.5 + d.phase) * 4, z);
    }
    for (const [id, d] of this.decoyBoxes) {
      if (live.has(id)) continue;
      this.put(d.obj);
      this.decoyBoxes.delete(id);
    }
  }

  // Ice breaking off a frozen kart that got hit.
  shatter(x, z, y) {
    const gy = this.ground(x, z, y);
    for (let i = 0; i < (MOBILE ? 10 : 20); i++) {
      const a = rand(0, TAU);
      this.debris.emit(x, gy + rand(8, 26), z, Math.cos(a) * rand(120, 300), rand(150, 380), Math.sin(a) * rand(120, 300), rand(3, 7), i % 3 ? 0xc7e9ff : 0xffffff, rand(0.8, 1.3));
    }
    for (let i = 0; i < (MOBILE ? 16 : 32); i++) {
      const a = rand(0, TAU);
      this.fire.emit(x, gy + 16, z, Math.cos(a) * rand(100, 260), rand(40, 200), Math.sin(a) * rand(100, 260), i % 2 ? this.c.white : this.c.ice, rand(5, 9), 0.45, { drag: 2.5, rise: -300 });
    }
    this.r.ring(x, z, 0xbfe3ff, 70, 0.3, gy);
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
      // A box bursting into shards has no outline; nor does one fading out by the camera (its "?" goes too).
      const cam = this.r.camera.position;
      const near = (cam.x - b.x) ** 2 + (cam.z - b.z) ** 2 + (cam.y - b.g.position.y) ** 2 < 75 * 75;
      b.ink.visible = b.state !== 'pop' && !near;
      b.g.children[1].visible = !near;
      if (!b.g.visible) return;
      b.g.scale.setScalar(Math.max(0.01, s));
      b.mesh.rotation.set(t * 0.9 + b.phase, t * 1.3 + b.phase, 0);
      b.g.position.y = b.gy + 22 + Math.sin(t * 2.5 + b.phase) * 4;
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
    const y = b.gy + 22;
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

  // kind: comet | bouncer | snowball | sticky | decoy (others are drawn by Kart3D.explode; sticky
  // and decoy get its fireball too).
  blast(kind, x, z, radius, y) {
    const gy = this.ground(x, z, y);
    if (kind === 'snowball') {
      for (let i = 0; i < (MOBILE ? 14 : 28); i++) {
        const a = rand(0, TAU);
        this.fire.emit(x, gy + 14, z, Math.cos(a) * rand(60, 180), rand(30, 160), Math.sin(a) * rand(60, 180), i % 2 ? this.c.white : this.c.frost, rand(6, 11), 0.5, { drag: 2.5, rise: -250 });
      }
      for (let i = 0; i < 6; i++) {
        const a = rand(0, TAU);
        this.debris.emit(x, gy + 12, z, Math.cos(a) * rand(60, 160), rand(120, 260), Math.sin(a) * rand(60, 160), rand(2.5, 5), 0xffffff, rand(0.6, 1));
      }
      return;
    }
    if (kind === 'sticky') {
      for (let i = 0; i < (MOBILE ? 10 : 18); i++) {
        const a = rand(0, TAU);
        this.debris.emit(x, gy + 14, z, Math.cos(a) * rand(100, 280), rand(160, 360), Math.sin(a) * rand(100, 280), rand(3, 6), i % 2 ? 0xec4899 : 0xbe185d, rand(0.8, 1.3));
      }
      return;
    }
    if (kind === 'decoy') {
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU);
        this.debris.emit(x, gy + 22, z, Math.cos(a) * rand(80, 220), rand(120, 320), Math.sin(a) * rand(80, 220), rand(3, 6), this.c.rainbow[i % 6], rand(0.7, 1.2));
      }
      return;
    }
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
    // Comet impact: a blinding flash, a violet fireball, a lightning shock ring racing out over the
    // ground, a light pillar and debris thrown high. (Small = a comet fizzling out in the air.)
    const big = radius > 100;
    this.flare(x, gy + 40, z, radius * (big ? 1.7 : 0.7), big ? 0.32 : 0.2);
    if (big) this.flare(x, gy + 20, z, radius * 0.7, 0.14);
    const n = big ? (MOBILE ? 24 : 44) : 14;
    for (let i = 0; i < n; i++) { // sparks
      const a = rand(0, TAU);
      const e = rand(0, 1.2);
      const sp = rand(380, 820) * (big ? 1 : 0.5);
      this.fire.emit(x, gy + 14, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 80, Math.sin(a) * Math.cos(e) * sp,
        this.c.comet[i % 4], rand(5, 9), rand(0.35, 0.6), { drag: 3, rise: -250 });
    }
    for (let i = 0; i < (big ? (MOBILE ? 14 : 26) : 6); i++) { // fireball: slow, fat, rising puffs
      const a = rand(0, TAU);
      const sp = rand(40, 170) * (big ? 1 : 0.5);
      this.fire.emit(x + Math.cos(a) * rand(0, 40), gy + rand(10, 50), z + Math.sin(a) * rand(0, 40), Math.cos(a) * sp, rand(40, 160), Math.sin(a) * sp,
        this.c.fireball[i % 3], rand(26, 40) * (big ? 1 : 0.6), rand(0.35, 0.6), { grow: 1.7, drag: 2.2, rise: 90 });
    }
    for (let i = 0; i < (big ? 14 : 3); i++) {
      const a = rand(0, TAU);
      this.debris.emit(x, gy + 10, z, Math.cos(a) * rand(120, 300), rand(320, 620), Math.sin(a) * rand(120, 300), rand(2.5, 5.5), i % 2 ? 0x8b5cf6 : 0x93c5fd, rand(1, 1.6));
    }
    for (let i = 0; i < (big ? 10 : 4); i++) {
      const a = rand(0, TAU);
      this.smoke.emit(x + Math.cos(a) * 60, gy + 8, z + Math.sin(a) * 60, Math.cos(a) * rand(100, 220), rand(10, 40), Math.sin(a) * rand(100, 220), this.c.plume, rand(20, 34), rand(0.9, 1.4), { alpha: 0.35, grow: 1.5, drag: 1.6, rise: 15 });
    }
    if (!big) return;
    this.shockRing(x, gy, z, radius * 1.35, 0.42, this.c.cometRing);
    this.pillar(x, gy, z, 0x5b7cff, 0.9);
    this.r.ring(x, z, 0xffffff, radius * 1.1, 0.35);
    this.r.shake(x, z, 26);
  }

  // A flash sprite that swells and fades out over `life` seconds.
  flare(x, y, z, size, life) {
    const f = this.get('flare');
    f.position.set(x, y, z);
    f.scale.setScalar(size * 0.3);
    f.userData.mat.opacity = 1;
    this.effects.push({ kind: 'flare', obj: f, life, max: life, size });
  }

  // A pooled lightning ring on the ground expanding to `radius` (shock items, comet impacts).
  shockRing(x, gy, z, radius, life, color) {
    const disc = this.get('shock');
    disc.position.set(x, gy + 3, z);
    disc.scale.setScalar(radius);
    disc.userData.mat.uniforms.uP.value = 0;
    disc.userData.mat.uniforms.uColor.value.copy(color || this.c.shockRing);
    this.effects.push({ kind: 'ring', obj: disc, life, max: life });
    return disc;
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
  shock(x, z, radius, y) {
    const gy = this.ground(x, z, y);
    this.shockRing(x, gy, z, radius, 0.5);
    this.effects.push({ kind: 'arcs', life: 0.5, max: 0.5, x, z, gy, radius, zap: 0, bolts: [] });
  }

  // Thunder: a bolt out of the sky onto each victim, with a flash on the ground.
  // list: [{ x, z, idx, y }]; each bolt keeps following kart idx (where it is drawn) while it flickers.
  thunder(list) {
    for (const { x, z, idx, y } of list) {
      const gy = this.ground(x, z, y);
      this.effects.push({ kind: 'strike', life: 0.55, max: 0.55, x, z, gy, idx, zap: 0, bolts: [] });
      for (let i = 0; i < (MOBILE ? 14 : 28); i++) {
        const a = rand(0, TAU);
        this.fire.emit(x, gy + 10, z, Math.cos(a) * rand(80, 260), rand(60, 260), Math.sin(a) * rand(80, 260), i % 3 ? this.c.electric : this.c.white, rand(5, 10), 0.45, { drag: 2, rise: -300 });
      }
      this.r.ring(x, z, 0xbfd8ff, 90, 0.35, gy);
    }
  }

  // Ink: dark globs arc from the user to every victim.
  inkBurst(from, targets) {
    if (!from) return;
    const gy = this.ground(from.x, from.y, this.layered ? from.z : undefined);
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
    const gy = this.ground(k.x, k.y, this.layered ? k.z : undefined);
    if (item === 'star') {
      for (let i = 0; i < 40; i++) {
        const a = rand(0, TAU);
        this.fire.emit(k.x, gy + 16, k.y, Math.cos(a) * rand(100, 260), rand(40, 220), Math.sin(a) * rand(100, 260), this.c.rainbow[i % 6], rand(8, 13), 0.6, { drag: 2.2 });
      }
      this.r.ring(k.x, k.y, 0xfff3a0, 120, 0.4, gy);
    } else if (item === 'shield') {
      this.r.ring(k.x, k.y, 0x60a5fa, 80, 0.35, gy);
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
      if (e.kind === 'flare') {
        e.obj.scale.setScalar(e.size * (0.3 + 0.7 * (1 - (1 - p) ** 3)));
        e.obj.userData.mat.opacity = (1 - p) ** 2;
      } else if (e.kind === 'ring') {
        e.obj.userData.mat.uniforms.uP.value = Math.min(1, p * 1.15);
      } else if (e.kind === 'pillar') {
        e.mesh.material.opacity = 0.4 * (1 - p) * (1 - p);
        e.mesh.scale.set(1 - p * 0.6, 1 + p * 0.3, 1 - p * 0.6);
      } else if (e.kind === 'arcs') {
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
        const k = e.idx !== undefined && this.r.lastKarts.get(e.idx);
        if (k) { e.x = k.x; e.z = k.y; e.gy = this.ground(k.x, k.y, this.layered ? k.z : undefined); }
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
      if (e.obj) this.put(e.obj); // pooled: hidden, material kept (so its shader stays compiled)
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
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
    for (const e of this.effects) {
      if (e.obj && e.obj.userData.mats) for (const mat of e.obj.userData.mats) mat.dispose();
      if (e.mesh) { e.mesh.geometry.dispose(); e.mesh.material.dispose(); }
    }
    this.tracers.material.dispose();
    this.tracers.dispose();
    this.debris.dispose();
    if (this.aimMarker) for (const mat of this.aimMarker.userData.mats) mat.dispose();
    for (const d of this.decoyBoxes.values()) for (const mat of d.obj.userData.mats) mat.dispose();
    if (this.aimDots) { this.aimDots.geometry.dispose(); this.aimDots.material.dispose(); this.aimDots.dispose(); }
  }
}
