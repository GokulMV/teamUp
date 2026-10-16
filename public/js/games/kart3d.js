// 3D renderer for Kart Battle (race track + battle arena), built with Three.js.
// Game logic stays in kart.js / the server; this file only draws what it is given.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const K = window.KartCore;
const MOBILE = matchMedia('(pointer: coarse)').matches;

// ---------- small helpers ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 8;
  return t;
}

function noise(ctx, w, h, count, colors, size = 2) {
  const r = rng(w * 31 + h + count);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    ctx.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()));
  }
}

// Position/rotation helper for building merged geometry.
function part(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = geo.clone();
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

// ---------- textures ----------
const TEX = {};
function textures() {
  if (TEX.ready) return TEX;
  TEX.grass = canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#5aa047'; c.fillRect(0, 0, w, h);
    noise(c, w, h, 2500, ['#4f9440', '#63ad4f', '#56993f', '#6bb556'], 3);
  });
  TEX.grass.repeat.set(70, 70);
  TEX.asphalt = canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#4b4f58'; c.fillRect(0, 0, w, h);
    noise(c, w, h, 5000, ['#454952', '#52565f', '#3f434b', '#585c66'], 2);
    c.fillStyle = '#f2f2f2';
    c.fillRect(6, 0, 6, h); c.fillRect(w - 12, 0, 6, h);
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillRect(w / 2 - 4, 0, 8, h / 2);
  });
  TEX.curb = canvasTexture(32, 64, (c, w, h) => {
    c.fillStyle = '#e11d2e'; c.fillRect(0, 0, w, h / 2);
    c.fillStyle = '#f8fafc'; c.fillRect(0, h / 2, w, h / 2);
  });
  TEX.checker = canvasTexture(64, 64, (c, w, h) => {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      c.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      c.fillRect(i * 8, j * 8, 8, 8);
    }
  });
  TEX.hazard = canvasTexture(128, 32, (c, w, h) => {
    c.fillStyle = '#facc15'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f2937';
    for (let x = -h; x < w; x += 32) {
      c.beginPath(); c.moveTo(x, h); c.lineTo(x + 16, h); c.lineTo(x + 16 + h, 0); c.lineTo(x + h, 0); c.fill();
    }
  });
  TEX.crate = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#b7813f'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#a06c2e';
    for (let y = 0; y < h; y += 21) c.fillRect(0, y, w, 3);
    c.strokeStyle = '#7c4f1d'; c.lineWidth = 12;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.beginPath(); c.moveTo(10, 10); c.lineTo(w - 10, h - 10); c.stroke();
  }, false);
  TEX.stone = canvasTexture(256, 128, (c, w, h) => {
    c.fillStyle = '#8b93a7'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#6b7385'; c.lineWidth = 3;
    for (let y = 0; y < h; y += 32) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
      for (let x = (y / 32) % 2 ? 0 : 32; x < w; x += 64) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 32); c.stroke(); }
    }
    noise(c, w, h, 800, ['#7f879a', '#98a0b3'], 3);
  });
  TEX.arenaFloor = canvasTexture(1024, 1024, (c, w, h) => {
    c.fillStyle = '#2f3a52'; c.fillRect(0, 0, w, h);
    noise(c, w, h, 6000, ['#2c364d', '#334057', '#2a3349'], 2);
    c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 2;
    for (let i = 0; i <= w; i += 32) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke();
      c.beginPath(); c.moveTo(0, i); c.lineTo(w, i); c.stroke();
    }
    const cx = w / 2;
    c.lineWidth = 14;
    c.strokeStyle = 'rgba(255,79,139,0.75)';
    c.beginPath(); c.arc(cx, cx, 210, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 6;
    c.beginPath(); c.arc(cx, cx, 360, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, h); c.moveTo(0, cx); c.lineTo(w, cx); c.stroke();
    const corner = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];
    [[0, 0], [w, 0], [0, h], [w, h]].forEach(([x, y], i) => {
      c.fillStyle = corner[i] + '55';
      c.beginPath(); c.arc(x, y, 190, 0, Math.PI * 2); c.fill();
    });
    c.strokeStyle = '#facc15'; c.lineWidth = 10;
    c.strokeRect(20, 20, w - 40, h - 40);
  }, false);
  TEX.box = canvasTexture(128, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#facc15'); g.addColorStop(0.5, '#ec4899'); g.addColorStop(1, '#3b82f6');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 10; c.strokeRect(5, 5, w - 10, h - 10);
    c.fillStyle = '#fff'; c.font = 'bold 90px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = 8;
    c.fillText('?', w / 2, h / 2 + 6);
  }, false);
  TEX.spark = canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, false);
  TEX.ready = true;
  return TEX;
}

// ---------- particles (two GPU point clouds: additive fire + normal smoke) ----------
class Particles {
  constructor(scene, max, additive) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.rise = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: textures().spark }, scale: { value: 600 } },
      vertexShader: `
        attribute float size; attribute float alpha; varying vec3 vColor; varying float vAlpha;
        uniform float scale;
        void main() {
          vColor = color; vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, color, size, life, opts = {}) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.alpha[i] = opts.alpha ?? 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = opts.grow ?? 1;
    this.drag[i] = opts.drag ?? 1.5;
    this.rise[i] = opts.rise ?? 0;
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove with the last live particle
        const last = --this.count;
        if (i !== last) {
          for (const arr of [this.pos, this.vel, this.col]) arr.copyWithin(i * 3, last * 3, last * 3 + 3);
          for (const arr of [this.size, this.alpha, this.life, this.maxLife, this.grow, this.drag, this.rise]) arr[i] = arr[last];
        }
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.rise[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] *= 1 + (this.grow[i] - 1) * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(this.alpha[i], t * 1.4);
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    for (const name of ['position', 'color', 'size', 'alpha']) this.geo.attributes[name].needsUpdate = true;
  }
}

// ---------- kart model ----------
const SHARED = {};
function sharedKartParts() {
  if (SHARED.ready) return SHARED;
  SHARED.dark = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.7, metalness: 0.3 });
  SHARED.metal = new THREE.MeshStandardMaterial({ color: 0xc9ced8, roughness: 0.25, metalness: 0.9 });
  SHARED.rubber = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.95 });
  SHARED.skins = ['#ffd7b5', '#f1b98c', '#c98b5e', '#8d5a3b', '#ffe0c4'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
  SHARED.eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  SHARED.pupil = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
  SHARED.flame = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  SHARED.shield = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });

  const tire = new THREE.CylinderGeometry(1, 1, 1, 18);
  tire.rotateX(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.55, 0.55, 1.08, 10);
  hub.rotateX(Math.PI / 2);
  SHARED.wheelGeo = (r, w) => {
    const t = tire.clone(); t.scale(r, r, w);
    return t;
  };
  SHARED.hubGeo = (r, w) => {
    const h = hub.clone(); h.scale(r, r, w);
    return h;
  };

  // Colored body parts (player color)
  const body = [
    part(new RoundedBoxGeometry(34, 7, 20, 3, 2.5), 0, 7, 0),
    part(new RoundedBoxGeometry(14, 5, 15, 2, 2), 19, 6, 0, 0, 0, -0.22),
    part(new RoundedBoxGeometry(16, 6, 5, 2, 2), -2, 7, 12.5),
    part(new RoundedBoxGeometry(16, 6, 5, 2, 2), -2, 7, -12.5),
  ];
  SHARED.bodyGeo = mergeGeometries(body.map((g) => g.toNonIndexed()));
  // Accent parts (team color, or a lighter shade): rear wing, helmet stripe, nose stripe
  const accent = [
    part(new THREE.BoxGeometry(5, 1.6, 27), -19, 18, 0),
    part(new THREE.BoxGeometry(4, 6, 1.4), -19, 15, 13),
    part(new THREE.BoxGeometry(4, 6, 1.4), -19, 15, -13),
    part(new THREE.BoxGeometry(24, 0.6, 4), 6, 10.7, 0),
  ];
  SHARED.accentGeo = mergeGeometries(accent.map((g) => g.toNonIndexed()));
  // Dark chassis parts
  const dark = [
    part(new THREE.BoxGeometry(40, 2, 18), 0, 3, 0),
    part(new THREE.BoxGeometry(4, 3, 26), 24, 4, 0),
    part(new THREE.BoxGeometry(3, 11, 13), -10, 14, 0),
    part(new THREE.BoxGeometry(2, 6, 2), -19, 12, 0),
    part(new THREE.TorusGeometry(3.2, 0.7, 6, 14), 6, 16, 0, 0, Math.PI / 2, 0.5),
    part(new THREE.CylinderGeometry(0.6, 0.6, 7, 6), 4, 14, 0, 0, 0, 1.0),
  ];
  SHARED.darkGeo = mergeGeometries(dark.map((g) => g.toNonIndexed()));
  const metal = [
    part(new THREE.CylinderGeometry(1.6, 1.9, 7, 10), -21, 8, 5, 0, 0, Math.PI / 2),
    part(new THREE.CylinderGeometry(1.6, 1.9, 7, 10), -21, 8, -5, 0, 0, Math.PI / 2),
    part(new THREE.SphereGeometry(4.2, 12, 10), -14, 10, 0),
  ];
  SHARED.metalGeo = mergeGeometries(metal.map((g) => g.toNonIndexed()));
  // Driver: torso (jersey) + helmet + visor
  SHARED.torsoGeo = part(new THREE.CylinderGeometry(4.2, 5.5, 10, 12), -3, 15, 0);
  SHARED.armsGeo = mergeGeometries([
    part(new THREE.CylinderGeometry(1.6, 1.6, 9, 8), 2, 16, 4.5, 0, 0, 1.2).toNonIndexed(),
    part(new THREE.CylinderGeometry(1.6, 1.6, 9, 8), 2, 16, -4.5, 0, 0, 1.2).toNonIndexed(),
  ]);
  // Cartoon head: skin sphere, cap in the player's color, big eyes facing forward (+x).
  SHARED.headGeo = part(new THREE.SphereGeometry(7, 20, 16), -3, 25, 0);
  SHARED.capGeo = mergeGeometries([
    part(new THREE.SphereGeometry(7.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), -3, 26, 0, 0, 0, 0.12).toNonIndexed(),
    part(new THREE.CylinderGeometry(5, 5, 0.9, 16, 1, false, -Math.PI / 2, Math.PI), 2.5, 27.6, 0, 0, 0, 0.1).toNonIndexed(),
  ]);
  SHARED.eyesGeo = mergeGeometries([2.6, -2.6].map((z) => part(new THREE.SphereGeometry(2.1, 12, 10), 2.6, 25, z).toNonIndexed()));
  SHARED.pupilsGeo = mergeGeometries([2.6, -2.6].map((z) => part(new THREE.SphereGeometry(1.1, 10, 8), 4.4, 25, z).toNonIndexed()));
  SHARED.flameGeo = new THREE.ConeGeometry(2.4, 10, 10);
  SHARED.flameGeo.rotateZ(Math.PI / 2);
  SHARED.shieldGeo = new THREE.SphereGeometry(30, 24, 16);
  SHARED.ready = true;
  return SHARED;
}

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 34px "Trebuchet MS", sans-serif';
  const w = Math.min(250, ctx.measureText(text).width + 44);
  ctx.fillStyle = 'rgba(15,10,35,0.65)';
  ctx.beginPath(); ctx.roundRect((256 - w) / 2, 8, w, 48, 24); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc((256 - w) / 2 + 22, 32, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(text, (256 - w) / 2 + 38, 33, w - 46);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(46, 11.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function buildKart(meta, accentHex, isMe) {
  const S = sharedKartParts();
  const color = new THREE.Color(meta.color);
  const group = new THREE.Group();
  const chassis = new THREE.Group(); // rolls/pitches; wheels stay on the ground
  group.add(chassis);

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(accentHex), roughness: 0.4, metalness: 0.2 });
  const add = (geo, mat, parent = chassis) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  add(S.bodyGeo, bodyMat);
  add(S.accentGeo, accentMat);
  add(S.darkGeo, S.dark);
  add(S.metalGeo, S.metal);
  add(S.torsoGeo, accentMat);
  add(S.armsGeo, accentMat);
  let hash = 0;
  for (const ch of meta.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  add(S.headGeo, S.skins[hash % S.skins.length]);
  add(S.capGeo, bodyMat);
  add(S.eyesGeo, S.eyeWhite);
  add(S.pupilsGeo, S.pupil);

  const wheels = [];
  for (const [x, z, r, w, front] of [[13, 13.5, 6, 5, true], [13, -13.5, 6, 5, true], [-12, 14.5, 7.5, 7, false], [-12, -14.5, 7.5, 7, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    const spin = new THREE.Group();
    pivot.add(spin);
    add(S.wheelGeo(r, w), S.rubber, spin);
    add(S.hubGeo(r * 0.55, w), S.metal, spin);
    group.add(pivot);
    wheels.push({ pivot, spin, r, front });
  }

  const flames = [5, -5].map((z) => {
    const f = new THREE.Mesh(S.flameGeo, S.flame);
    f.position.set(-28, 8, z);
    f.visible = false;
    chassis.add(f);
    return f;
  });

  const shield = new THREE.Mesh(S.shieldGeo, S.shield);
  shield.position.y = 12;
  shield.visible = false;
  group.add(shield);

  let label = null;
  if (!isMe) {
    label = makeLabel(meta.name, accentHex);
    label.position.y = 44;
    group.add(label);
  }
  return { group, chassis, wheels, flames, shield, label, bodyMat, accentMat, steer: 0, lastAngle: null, smoke: 0, slide: 0, hop: 0, wasSpin: false, wasDead: false };
}

// ---------- world builders ----------
function ribbon(points, normals, offA, offB, y, vScale) {
  const n = points.length;
  const pos = [];
  const uv = [];
  const idx = [];
  let dist = 0;
  for (let i = 0; i <= n; i++) {
    const p = points[i % n];
    const nm = normals[i % n];
    if (i > 0) {
      const q = points[i - 1];
      dist += Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
    pos.push(p[0] + nm[0] * offA, y, p[1] + nm[1] * offA, p[0] + nm[0] * offB, y, p[1] + nm[1] * offB);
    uv.push(0, dist / vScale, 1, dist / vScale);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function addTrees(scene, positions, rand) {
  const trunkGeo = new THREE.CylinderGeometry(4, 6, 30, 7);
  trunkGeo.translate(0, 15, 0);
  const roundGeo = new THREE.IcosahedronGeometry(1, 0);
  const pineGeo = new THREE.ConeGeometry(1, 2.2, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 0.9 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
  const rounds = new THREE.InstancedMesh(roundGeo, leafMat, positions.length);
  const pines = new THREE.InstancedMesh(pineGeo, leafMat, positions.length);
  let nr = 0;
  let np = 0;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const greens = ['#3f8f3a', '#4ea045', '#2f7a3a', '#5aa64a', '#3b8a52'].map((c) => new THREE.Color(c));
  positions.forEach(([x, z], i) => {
    const s = 0.8 + rand() * 0.8;
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    const col = greens[Math.floor(rand() * greens.length)];
    q.setFromEuler(new THREE.Euler(0, rand() * Math.PI, 0));
    if (rand() < 0.45) {
      m.compose(new THREE.Vector3(x, 30 * s + 26 * s, z), q, new THREE.Vector3(26 * s, 32 * s, 26 * s));
      pines.setMatrixAt(np, m); pines.setColorAt(np, col); np++;
    } else {
      m.compose(new THREE.Vector3(x, 30 * s + 18 * s, z), q, new THREE.Vector3(30 * s, 28 * s, 30 * s));
      rounds.setMatrixAt(nr, m); rounds.setColorAt(nr, col); nr++;
    }
    q.identity();
  });
  rounds.count = nr;
  pines.count = np;
  for (const im of [trunks, rounds, pines]) {
    im.castShadow = true;
    im.receiveShadow = true;
    scene.add(im);
  }
}

function addHills(scene, cx, cz, radius) {
  const rand = rng(77);
  const mat = new THREE.MeshStandardMaterial({ color: 0x5d9b62, roughness: 1, flatShading: true });
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const count = 36;
  const hills = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.2;
    const r = radius + rand() * 900;
    const s = 500 + rand() * 700;
    m.compose(new THREE.Vector3(cx + Math.cos(a) * r, -s * 0.35, cz + Math.sin(a) * r), new THREE.Quaternion(),
      new THREE.Vector3(s * 1.4, s * (0.5 + rand() * 0.5), s * 1.4));
    hills.setMatrixAt(i, m);
  }
  scene.add(hills);
}

function buildRace(scene) {
  const T = textures();
  const pts = K.CENTERLINE;
  const n = pts.length;
  // Smoothed left-pointing normals (-ty, tx) in world x/y -> three x/z.
  const normals = pts.map((_, i) => {
    const a = K.TANGENTS[(i - 1 + n) % n];
    const b = K.TANGENTS[i];
    const tx = a[0] + b[0];
    const ty = a[1] + b[1];
    const l = Math.hypot(tx, ty) || 1;
    return [-ty / l, tx / l];
  });
  const half = K.TRACK_WIDTH / 2;

  const road = new THREE.Mesh(ribbon(pts, normals, -half, half, 0.6, 256),
    new THREE.MeshStandardMaterial({ map: T.asphalt, roughness: 0.85, side: THREE.DoubleSide }));
  road.receiveShadow = true;
  scene.add(road);
  for (const [a, b] of [[half, half + 18], [-half - 18, -half]]) {
    const curb = new THREE.Mesh(ribbon(pts, normals, a, b, 1.2, 64),
      new THREE.MeshStandardMaterial({ map: T.curb, roughness: 0.6, side: THREE.DoubleSide }));
    curb.receiveShadow = true;
    scene.add(curb);
  }
  // Sandy run-off beside the curbs.
  const sandMat = new THREE.MeshStandardMaterial({ color: 0xd9c08a, roughness: 1, side: THREE.DoubleSide });
  for (const [a, b] of [[half + 18, half + 60], [-half - 60, -half - 18]]) {
    const sand = new THREE.Mesh(ribbon(pts, normals, a, b, 0.3, 64), sandMat);
    sand.receiveShadow = true;
    scene.add(sand);
  }

  // Start/finish: checkered strip + gantry.
  const c0 = pts[0];
  const t0 = K.TANGENTS[0];
  const ang = Math.atan2(t0[1], t0[0]);
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(26, K.TRACK_WIDTH), new THREE.MeshStandardMaterial({ map: T.checker }));
  T.checker.repeat.set(1, 10);
  strip.rotation.x = -Math.PI / 2;
  strip.rotation.z = -ang;
  strip.position.set(c0[0], 1.4, c0[1]);
  scene.add(strip);
  const gantry = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.6, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(10, 120, 10), postMat);
    post.position.set(0, 60, s * (half + 30));
    post.castShadow = true;
    gantry.add(post);
  }
  const bannerTex = canvasTexture(512, 64, (c, w, h) => {
    c.fillStyle = '#ff4f8b'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff'; c.font = 'bold 44px "Trebuchet MS", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('🏁  TEAMUP GRAND PRIX  🏁', w / 2, h / 2 + 2);
  }, false);
  const banner = new THREE.Mesh(new THREE.BoxGeometry(8, 30, K.TRACK_WIDTH + 70),
    [postMat, postMat, postMat, postMat, new THREE.MeshStandardMaterial({ map: bannerTex }), new THREE.MeshStandardMaterial({ map: bannerTex })]);
  banner.position.y = 115;
  banner.castShadow = true;
  gantry.add(banner);
  gantry.position.set(c0[0], 0, c0[1]);
  gantry.rotation.y = -ang;
  scene.add(gantry);

  // Tire barriers just outside the physical wall, skipped where they'd intrude on another stretch.
  const wall = half + 175;
  const tires = [];
  for (let i = 0; i < n; i++) {
    for (const side of [1, -1]) {
      const p = pts[i];
      const nm = normals[i];
      const x = p[0] + nm[0] * wall * side;
      const z = p[1] + nm[1] * wall * side;
      if (K.nearestIndex(x, z).dist < wall - 6) continue;
      tires.push([x, z]);
    }
  }
  const tireMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(13, 13, 22, 12), new THREE.MeshStandardMaterial({ roughness: 0.8 }), tires.length);
  const m = new THREE.Matrix4();
  tires.forEach(([x, z], i) => {
    m.makeTranslation(x, 11, z);
    tireMesh.setMatrixAt(i, m);
    tireMesh.setColorAt(i, new THREE.Color(i % 4 < 2 ? 0xe11d2e : 0xf1f5f9));
  });
  tireMesh.castShadow = true;
  tireMesh.receiveShadow = true;
  scene.add(tireMesh);

  // Trees off the track.
  const rand = rng(1234);
  const trees = [];
  for (let tries = 0; trees.length < 380 && tries < 6000; tries++) {
    const x = -700 + rand() * (K.WORLD.w + 1400);
    const z = -700 + rand() * (K.WORLD.h + 1400);
    if (K.nearestIndex(x, z).dist > half + 260) trees.push([x, z]);
  }
  addTrees(scene, trees, rand);
  addHills(scene, K.WORLD.w / 2, K.WORLD.h / 2, 3600);
  return { center: [K.WORLD.w / 2, K.WORLD.h / 2], size: K.WORLD.w };
}

function buildArena(scene) {
  const T = textures();
  const A = K.ARENA;
  const S = A.size;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({ map: T.arenaFloor, roughness: 0.75 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(S / 2, 0.5, S / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // Perimeter walls (physics wall is at 40 units in from each edge).
  const hz = T.hazard.clone();
  hz.needsUpdate = true;
  hz.repeat.set(S / 128, 1);
  const wallMat = new THREE.MeshStandardMaterial({ map: hz, roughness: 0.6 });
  const wallSide = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.8 });
  for (const [x, z, w, d] of [[S / 2, 20, S, 40], [S / 2, S - 20, S, 40], [20, S / 2, 40, S], [S - 20, S / 2, 40, S]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 34, d), [wallSide, wallSide, wallSide, wallSide, wallMat, wallMat]);
    if (w < d) { wall.geometry = new THREE.BoxGeometry(d, 34, w); wall.rotation.y = Math.PI / 2; }
    wall.position.set(x, 17, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  }

  const stone = (rx, ry) => {
    const t = T.stone.clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
  };
  const towerMat = stone(10, 1.4);
  const towerTopMat = stone(6, 1);
  const pillarMat = stone(4, 1.8);
  const crateMat = new THREE.MeshStandardMaterial({ map: T.crate, roughness: 0.8 });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0xff4f8b, emissive: 0xff4f8b, emissiveIntensity: 0.8 });
  for (const o of A.obstacles) {
    let mesh;
    if (o.kind === 'tower') {
      mesh = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r + 10, 90, 32), towerMat);
      base.position.y = 45;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(o.r - 4, 6, 8, 40), glowMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 92;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 0.55, o.r * 0.75, 70, 24), towerTopMat);
      top.position.y = 125;
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(30, 1), glowMat);
      orb.position.y = 190;
      orb.userData.spin = true;
      [base, ring, top, orb].forEach((p) => { p.castShadow = true; p.receiveShadow = true; mesh.add(p); });
    } else if (o.kind === 'pillar') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, 110, 24), pillarMat);
      mesh.position.y = 55;
    } else {
      const s = o.r * 1.45;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), crateMat);
      mesh.position.y = s * 0.4;
      mesh.rotation.y = Math.PI / 4;
    }
    mesh.position.x = o.x;
    mesh.position.z = o.y;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Floodlight towers in the corners.
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.7, roughness: 0.35 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfffbe6, emissive: 0xfff3c4, emissiveIntensity: 1.2 });
  for (const [x, z] of [[-80, -80], [S + 80, -80], [-80, S + 80], [S + 80, S + 80]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(8, 12, 320, 10), poleMat);
    pole.position.set(x, 160, z);
    pole.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(70, 40, 20), lampMat);
    lamp.position.set(x, 330, z);
    lamp.lookAt(S / 2, 0, S / 2);
    scene.add(pole, lamp);
  }

  // Stands of spectators (colored blocks) along two sides.
  const standMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 });
  const crowdColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xeab308, 0xec4899, 0xffffff, 0xa855f7];
  const crowd = new THREE.InstancedMesh(new THREE.SphereGeometry(7, 6, 5), new THREE.MeshStandardMaterial({ roughness: 0.8 }), 900);
  const rand = rng(99);
  let ci = 0;
  const m = new THREE.Matrix4();
  for (const side of [0, 1]) {
    for (let row = 0; row < 4; row++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(S - 400, 18, 40), standMat);
      const z = side ? S + 90 + row * 40 : -90 - row * 40;
      step.position.set(S / 2, 9 + row * 18, z);
      step.receiveShadow = true;
      scene.add(step);
      for (let x = 260; x < S - 260 && ci < 900; x += 18 + rand() * 14) {
        m.makeTranslation(x, 25 + row * 18, z + (rand() - 0.5) * 16);
        crowd.setMatrixAt(ci, m);
        crowd.setColorAt(ci, new THREE.Color(crowdColors[Math.floor(rand() * crowdColors.length)]));
        ci++;
      }
    }
  }
  crowd.count = ci;
  scene.add(crowd);

  const trees = [];
  const r2 = rng(4321);
  for (let tries = 0; trees.length < 160 && tries < 5000; tries++) {
    const x = -1200 + r2() * (S + 2400);
    const z = -1200 + r2() * (S + 2400);
    const inside = x > -300 && x < S + 300 && z > -300 && z < S + 300;
    if (!inside) trees.push([x, z]);
  }
  addTrees(scene, trees, r2);
  addHills(scene, S / 2, S / 2, 3000);
  return { center: [S / 2, S / 2], size: S };
}

// ---------- the renderer ----------
class Kart3D {
  constructor(container, opts) {
    this.map = opts.map;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: !MOBILE, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'kart-canvas';
    container.prepend(this.renderer.domElement);

    const scene = new THREE.Scene();
    this.scene = scene;
    const horizon = new THREE.Color(0xcfe9ff);
    scene.fog = new THREE.Fog(horizon, 1400, 5200);
    // Sky dome with a vertical gradient.
    const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d8ee8) }, bottom: { value: horizon } },
      vertexShader: 'varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP - cameraPosition).y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }',
    }));
    this.sky = sky;
    scene.add(sky);

    scene.add(new THREE.HemisphereLight(0xdcefff, 0x55703a, 1.25));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -650; sc.right = 650; sc.top = 650; sc.bottom = -650; sc.near = 10; sc.far = 2500;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.5;
    this.sun = sun;
    scene.add(sun, sun.target);

    const T = textures();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshStandardMaterial({ map: T.grass, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(1700, 0, 1700);
    ground.receiveShadow = true;
    scene.add(ground);

    this.world = this.map === 'arena' ? buildArena(scene) : buildRace(scene);
    this.spinners = [];
    scene.traverse((o) => { if (o.userData.spin) this.spinners.push(o); });

    this.camera = new THREE.PerspectiveCamera(62, 1, 2, 12000);
    if (!MOBILE) {
      // Bloom makes flames, explosions, item boxes and neon glow.
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 0.82);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    // Skid marks: a ring buffer of flat dark quads.
    this.skidMax = 1600;
    this.skidIdx = 0;
    this.skids = new THREE.InstancedMesh(new THREE.PlaneGeometry(5, 9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      this.skidMax);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.skidMax; i++) this.skids.setMatrixAt(i, zero);
    this.skids.frustumCulled = false;
    this.skids.renderOrder = 1;
    scene.add(this.skids);
    this.tmpM = new THREE.Matrix4();
    this.tmpQ = new THREE.Quaternion();
    this.tmpV = new THREE.Vector3(1, 1, 1);
    this.effects = []; // short-lived meshes (respawn beams, shockwaves)
    this.camPos = null;
    this.camLook = new THREE.Vector3();
    this.camHeading = 0;
    this.shake = 0;

    this.fire = new Particles(scene, 2500, true);
    this.smoke = new Particles(scene, 2500, false);

    // Item boxes
    const boxPositions = this.map === 'arena' ? K.ARENA.itemBoxes : K.ITEM_BOXES;
    const boxMat = new THREE.MeshStandardMaterial({ map: T.box, transparent: true, opacity: 0.92, emissive: 0x332244, roughness: 0.3 });
    this.boxes = boxPositions.map((b, i) => {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(24, 24, 24, 2, 3), boxMat);
      mesh.position.set(b.x, 20, b.y);
      mesh.castShadow = true;
      mesh.userData.phase = i * 0.7;
      mesh.userData.was = true;
      scene.add(mesh);
      return mesh;
    });

    this.colBlue = new THREE.Color(0x4da6ff);
    this.colOrange = new THREE.Color(0xff9a1f);
    this.colWhite = new THREE.Color(0xfff6d5);
    this.karts = new Map();
    this.rockets = new Map();
    this.bananas = new Map();
    this.rocketGeo = this.makeRocketGeo();
    this.bananaGeo = new THREE.TorusGeometry(7, 2.6, 8, 14, Math.PI * 0.95);
    this.bananaMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  makeRocketGeo() {
    const body = part(new THREE.CylinderGeometry(3, 3, 18, 10), 0, 0, 0, 0, 0, Math.PI / 2).toNonIndexed();
    const nose = part(new THREE.ConeGeometry(3, 7, 10), 12.5, 0, 0, 0, 0, -Math.PI / 2).toNonIndexed();
    const fin1 = part(new THREE.BoxGeometry(5, 10, 1), -8, 0, 0).toNonIndexed();
    const fin2 = part(new THREE.BoxGeometry(5, 1, 10), -8, 0, 0).toNonIndexed();
    return {
      body: mergeGeometries([body, fin1, fin2]),
      nose,
      bodyMat: new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.35, metalness: 0.4 }),
      noseMat: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 }),
    };
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.camera.updateProjectionMatrix();
    this.fire.points.material.uniforms.scale.value = h * 0.9;
    this.smoke.points.material.uniforms.scale.value = h * 0.9;
  }

  setKarts(list, myIdx, teamColorOf) {
    for (const k of this.karts.values()) this.scene.remove(k.group);
    this.karts.clear();
    for (const meta of list) {
      const accent = teamColorOf(meta) || '#f8fafc';
      const kart = buildKart(meta, accent, meta.idx === myIdx);
      this.scene.add(kart.group);
      this.karts.set(meta.idx, kart);
    }
  }

  explode(x, z, big = true) {
    const fireCols = [new THREE.Color(0xffd166), new THREE.Color(0xff7b00), new THREE.Color(0xff3d00)];
    const n = big ? 70 : 30;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const sp = (big ? 160 : 90) * (0.4 + Math.random());
      this.fire.emit(x, 12, z, Math.cos(a) * sp, up * sp * 1.2, Math.sin(a) * sp,
        fireCols[i % 3], (big ? 26 : 16) * (0.6 + Math.random()), 0.5 + Math.random() * 0.4, { grow: 1.6, drag: 2.5, rise: 40 });
    }
    const smokeCol = new THREE.Color(0x3a3a42);
    for (let i = 0; i < (big ? 35 : 14); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 * Math.random();
      this.smoke.emit(x, 14, z, Math.cos(a) * sp, 30 + Math.random() * 40, Math.sin(a) * sp,
        smokeCol, 30 + Math.random() * 25, 1.2 + Math.random() * 0.8, { alpha: 0.7, grow: 1.8, drag: 1.2, rise: 25 });
    }
    // Debris sparks
    const spark = new THREE.Color(0xfff3b0);
    for (let i = 0; i < (big ? 30 : 10); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 250 + Math.random() * 200;
      this.fire.emit(x, 10, z, Math.cos(a) * sp, 120 + Math.random() * 200, Math.sin(a) * sp, spark, 6, 0.6, { drag: 1.2, rise: -500 });
    }
    if (big) this.shockwave(x, z);
    if (this.focus) {
      const d = Math.hypot(this.focus.x - x, this.focus.y - z);
      this.shake = Math.max(this.shake, Math.max(0, 1 - d / 600) * (big ? 14 : 6));
    }
  }

  addSkid(x, z, angle) {
    this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle + Math.PI / 2);
    this.tmpM.compose(new THREE.Vector3(x, 1.0, z), this.tmpQ, this.tmpV);
    this.skids.setMatrixAt(this.skidIdx, this.tmpM);
    this.skidIdx = (this.skidIdx + 1) % this.skidMax;
    this.skids.instanceMatrix.needsUpdate = true;
  }

  respawnBeam(x, z) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(26, 34, 500, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(x, 250, z);
    this.scene.add(beam);
    this.effects.push({ mesh: beam, life: 0.9, max: 0.9, kind: 'beam' });
    const col = new THREE.Color(0x9be7ff);
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      this.fire.emit(x + Math.cos(a) * 30, 5, z + Math.sin(a) * 30, Math.cos(a) * 40, 150 + Math.random() * 200, Math.sin(a) * 40, col, 8, 0.8, { drag: 1 });
    }
  }

  shockwave(x, z) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(x, 3, z);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, life: 0.5, max: 0.5, kind: 'ring' });
  }

  updateEffects(dt) {
    this.effects = this.effects.filter((e) => {
      e.life -= dt;
      const p = 1 - e.life / e.max;
      if (e.kind === 'beam') {
        e.mesh.material.opacity = 0.6 * (1 - p);
        e.mesh.scale.set(1 - p * 0.7, 1, 1 - p * 0.7);
      } else {
        e.mesh.scale.setScalar(20 + p * 160);
        e.mesh.material.opacity = 0.8 * (1 - p);
      }
      if (e.life > 0) return true;
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
      return false;
    });
  }

  sparkle(x, z) {
    const cols = [0xfacc15, 0xec4899, 0x3b82f6, 0x22c55e].map((c) => new THREE.Color(c));
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 120;
      this.fire.emit(x, 20, z, Math.cos(a) * sp, 60 + Math.random() * 120, Math.sin(a) * sp, cols[i % 4], 9, 0.5, { drag: 2, rise: -200 });
    }
  }

  // view: { karts:[{idx,x,y,angle,speed,flags}], rockets:[[id,x,y,a]], bananas:[[id,x,y]], boxes:[0|1], focusIdx, myIdx }
  update(view, dt, now) {
    const t = now / 1000;
    const flameCol = [new THREE.Color(0xffe066), new THREE.Color(0xff8c1a), new THREE.Color(0xff4d00)];
    const smokeCol = new THREE.Color(0x9aa0aa);
    const dustCol = new THREE.Color(0xc8b48a);

    // Karts
    const seen = new Set();
    for (const k of view.karts) {
      const kart = this.karts.get(k.idx);
      if (!kart) continue;
      seen.add(k.idx);
      const dead = k.flags & 32;
      kart.group.visible = !dead && !((k.flags & 16) && !(k.flags & 1) && !(k.flags & 4) && Math.floor(now / 90) % 2);
      if (dead) { kart.lastAngle = null; kart.wasDead = true; continue; }
      if (kart.wasDead) { kart.wasDead = false; this.respawnBeam(k.x, k.y); }
      const drifting = k.flags & 64;
      const driftDir = k.flags & 512 ? -1 : 1;
      const driftLevel = k.flags & 256 ? 2 : k.flags & 128 ? 1 : 0;
      // Drifting karts point their nose further into the turn.
      kart.slide += ((drifting ? driftDir * 0.42 : 0) - kart.slide) * Math.min(1, dt * 8);
      kart.group.position.set(k.x, 0, k.y);
      kart.group.rotation.y = -(k.angle + kart.slide);
      // Getting hit in a race: the kart pops up and does a flip.
      const spinNow = !!(k.flags & 1);
      if (spinNow && !kart.wasSpin) kart.hop = 0.8;
      kart.wasSpin = spinNow;
      if (kart.hop > 0) {
        kart.hop = Math.max(0, kart.hop - dt);
        const p = 1 - kart.hop / 0.8;
        kart.group.position.y = Math.sin(p * Math.PI) * 30;
        kart.chassis.rotation.z = p * Math.PI * 2;
      } else {
        kart.chassis.rotation.z = 0;
      }

      // Visual steering estimate from heading change.
      let dAng = kart.lastAngle === null ? 0 : k.angle - kart.lastAngle;
      dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
      kart.lastAngle = k.angle;
      const turnRate = dt > 0 ? dAng / dt : 0;
      const spinning = k.flags & 1;
      const targetSteer = spinning ? 0 : Math.max(-1, Math.min(1, turnRate / 2.5));
      kart.steer += (targetSteer - kart.steer) * Math.min(1, dt * 10);
      kart.chassis.rotation.x = -kart.steer * 0.12 * Math.min(1, Math.abs(k.speed) / 300);
      kart.chassis.position.y = Math.sin(t * 18 + k.idx) * 0.35 * Math.min(1, Math.abs(k.speed) / 200);
      for (const w of kart.wheels) {
        w.spin.rotation.z -= (k.speed * dt) / w.r;
        if (w.front) w.pivot.rotation.y = -kart.steer * 0.45;
      }

      const boosting = k.flags & 2;
      const cos = Math.cos(k.angle);
      const sin = Math.sin(k.angle);
      for (const f of kart.flames) {
        f.visible = !!boosting;
        if (boosting) f.scale.set(0.8 + Math.random() * 0.8, 1, 1);
      }
      if (kart.label) {
        const d = this.camera.position.distanceTo(kart.group.position);
        const w = Math.max(24, Math.min(90, d * 0.11));
        kart.label.scale.set(w, w / 4, 1);
      }
      kart.shield.visible = !!(k.flags & 4);
      if (kart.shield.visible) kart.shield.scale.setScalar(1 + Math.sin(t * 8) * 0.04);

      // Exhaust: flames when boosting, light smoke otherwise; tire smoke when sliding hard.
      const ex = k.x - cos * 26;
      const ez = k.y - sin * 26;
      if (boosting) {
        for (let i = 0; i < 3; i++) {
          this.fire.emit(ex + (Math.random() - 0.5) * 8, 8, ez + (Math.random() - 0.5) * 8,
            -cos * 120 + (Math.random() - 0.5) * 40, 20, -sin * 120 + (Math.random() - 0.5) * 40,
            flameCol[i], 14, 0.25, { grow: 0.3, drag: 3 });
        }
      } else if (Math.abs(k.speed) > 40) {
        kart.smoke -= dt;
        if (kart.smoke <= 0) {
          kart.smoke = 0.09;
          this.smoke.emit(ex, 8, ez, -cos * 30, 18, -sin * 30, smokeCol, 7, 0.6, { alpha: 0.35, grow: 2.2, drag: 1 });
        }
      }
      if (drifting) {
        const sparkCol = driftLevel === 2 ? this.colOrange : driftLevel === 1 ? this.colBlue : this.colWhite;
        for (const side of [1, -1]) {
          const wx = k.x - cos * 13 - sin * 15 * side;
          const wz = k.y - sin * 13 + cos * 15 * side;
          this.addSkid(wx, wz, k.angle + kart.slide);
          const n = driftLevel ? 3 : 1;
          for (let i = 0; i < n; i++) {
            this.fire.emit(wx, 3, wz, -cos * 60 + (Math.random() - 0.5) * 120, 40 + Math.random() * 90, -sin * 60 + (Math.random() - 0.5) * 120,
              sparkCol, driftLevel ? 7 : 5, 0.25, { drag: 2, rise: -400 });
          }
        }
      } else if (!spinning && Math.abs(kart.steer) > 0.6 && Math.abs(k.speed) > 320) {
        for (const side of [1, -1]) {
          this.smoke.emit(k.x - cos * 14 - sin * 14 * side, 3, k.y - sin * 14 + cos * 14 * side, 0, 10, 0,
            dustCol, 9, 0.7, { alpha: 0.4, grow: 2, drag: 1 });
        }
      }
      if (spinning) {
        const a = t * 12;
        this.fire.emit(k.x + Math.cos(a) * 14, 34, k.y + Math.sin(a) * 14, 0, 0, 0, new THREE.Color(0xfff27a), 8, 0.3);
      }
    }
    for (const [idx, kart] of this.karts) if (!seen.has(idx)) kart.group.visible = false;

    // Rockets
    const liveR = new Set();
    for (const [id, x, y, a] of view.rockets) {
      liveR.add(id);
      let r = this.rockets.get(id);
      if (!r) {
        r = new THREE.Group();
        const b = new THREE.Mesh(this.rocketGeo.body, this.rocketGeo.bodyMat);
        const n = new THREE.Mesh(this.rocketGeo.nose, this.rocketGeo.noseMat);
        b.castShadow = true;
        r.add(b, n);
        this.scene.add(r);
        this.rockets.set(id, r);
      }
      r.position.set(x, 14, y);
      r.rotation.y = -a;
      r.rotation.x += dt * 12;
      this.fire.emit(x - Math.cos(a) * 12, 14, y - Math.sin(a) * 12, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
        flameCol[Math.floor(Math.random() * 3)], 12, 0.18, { grow: 0.4 });
      this.smoke.emit(x - Math.cos(a) * 14, 14, y - Math.sin(a) * 14, 0, 12, 0, smokeCol, 9, 0.7, { alpha: 0.5, grow: 2.4, drag: 1 });
    }
    for (const [id, r] of this.rockets) if (!liveR.has(id)) { this.scene.remove(r); this.rockets.delete(id); }

    // Bananas
    const liveB = new Set();
    for (const [id, x, y] of view.bananas) {
      liveB.add(id);
      let b = this.bananas.get(id);
      if (!b) {
        b = new THREE.Mesh(this.bananaGeo, this.bananaMat);
        b.castShadow = true;
        b.rotation.set(-0.3, Math.random() * Math.PI * 2, 0.4);
        this.scene.add(b);
        this.bananas.set(id, b);
      }
      b.position.set(x, 5, y);
    }
    for (const [id, b] of this.bananas) if (!liveB.has(id)) { this.scene.remove(b); this.bananas.delete(id); }

    // Item boxes
    this.boxes.forEach((mesh, i) => {
      const on = !view.boxes || !!view.boxes[i];
      if (mesh.userData.was && !on) this.sparkle(mesh.position.x, mesh.position.z);
      mesh.userData.was = on;
      mesh.visible = on;
      if (!on) return;
      mesh.rotation.set(t * 0.9 + mesh.userData.phase, t * 1.3 + mesh.userData.phase, 0);
      mesh.position.y = 22 + Math.sin(t * 2.5 + mesh.userData.phase) * 4;
    });
    for (const s of this.spinners) { s.rotation.y = t * 0.8; s.rotation.x = t * 0.5; }

    this.fire.update(dt);
    this.smoke.update(dt);
    this.updateEffects(dt);

    // Chase camera
    const focus = view.focus;
    this.focus = focus;
    if (focus) {
      if (focus.snap) this.camHeading = focus.angle;
      if (!focus.spinning) {
        let d = focus.angle - this.camHeading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.camHeading += d * Math.min(1, dt * 8);
      }
      const arena = this.map === 'arena';
      const back = arena ? 175 : 150;
      const up = arena ? 105 : 78;
      const ch = Math.cos(this.camHeading);
      const sh = Math.sin(this.camHeading);
      // In the arena, pull the camera in so walls and the tower never block the view.
      let dist = back;
      if (arena) {
        for (let d = 20; d <= back; d += 10) {
          if (K.arenaBlocked(focus.x - ch * d, focus.y - sh * d, 18)) { dist = Math.max(45, d - 25); break; }
        }
      }
      this.camDist = this.camDist === undefined ? dist : this.camDist + (dist - this.camDist) * Math.min(1, dt * (dist < this.camDist ? 14 : 3));
      const camUp = up * (0.55 + 0.45 * (this.camDist / back));
      const desired = new THREE.Vector3(focus.x - ch * this.camDist, camUp, focus.y - sh * this.camDist);
      const look = new THREE.Vector3(focus.x + ch * 70, 14, focus.y + sh * 70);
      if (!this.camPos || focus.snap) {
        this.camPos = desired.clone();
        this.camLook.copy(look);
      } else {
        this.camPos.lerp(desired, 1 - Math.exp(-dt * 9));
        this.camLook.lerp(look, 1 - Math.exp(-dt * 12));
        // Never let the camera fall in on top of the kart.
        const dx = this.camPos.x - focus.x;
        const dz = this.camPos.z - focus.y;
        const hd = Math.hypot(dx, dz);
        const minD = (this.camDist ?? back) * 0.85;
        if (hd < minD && hd > 0.01) {
          this.camPos.x = focus.x + (dx / hd) * minD;
          this.camPos.z = focus.y + (dz / hd) * minD;
        }
      }
      const fov = focus.boost ? 74 : 62;
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this.camPos);
      if (this.shake > 0.01) {
        this.camera.position.x += (Math.random() - 0.5) * this.shake;
        this.camera.position.y += (Math.random() - 0.5) * this.shake;
        this.shake *= Math.exp(-dt * 6);
      }
      this.camera.lookAt(this.camLook);
      this.sun.position.set(focus.x + 450, 900, focus.y + 300);
      this.sun.target.position.set(focus.x, 0, focus.y);
    } else {
      const [cx, cz] = this.world.center;
      this.camera.position.set(cx + Math.cos(t * 0.1) * 1800, 1300, cz + Math.sin(t * 0.1) * 1800);
      this.camera.lookAt(cx, 0, cz);
      this.sun.position.set(cx + 450, 900, cz + 300);
      this.sun.target.position.set(cx, 0, cz);
    }
    this.sky.position.copy(this.camera.position);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    // Geometries/materials are freed from the GPU; shared ones are re-uploaded if a new game uses them.
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) m.dispose();
    });
  }
}

window.Kart3D = Kart3D;
window.dispatchEvent(new Event('kart3d-ready'));
