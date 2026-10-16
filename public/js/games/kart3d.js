// 3D renderer for Kart Battle, built with Three.js. Game logic stays in kart.js and on the
// server; this file only draws what it is given. Scenery lives in kart3d/world.js.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MOBILE, THEMES, tex, part, buildRace, buildArena, loadMoonlit } from './kart3d/world.js';
import { buildDriver } from './kart3d/driver.js';

const K = window.KartCore;

// Start fetching the tree code right away so it's ready when a race begins.
loadMoonlit();

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
      uniforms: { map: { value: tex.spark() }, scale: { value: 600 } },
      vertexShader: `
        attribute float size; attribute float alpha; varying vec3 vColor; varying float vAlpha;
        uniform float scale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vColor = color;
          // Fade out right in front of the lens and cap the size, so no puff ever fills the screen.
          vAlpha = alpha * clamp((-mv.z - 25.0) / 60.0, 0.0, 1.0);
          gl_PointSize = min(size * scale / -mv.z, scale * 0.35);
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
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
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
  SHARED.head = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff1c2, emissiveIntensity: 1.6 });
  SHARED.tail = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1a1a, emissiveIntensity: 1.2 });
  SHARED.flame = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  SHARED.shield = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
  SHARED.ghost = new THREE.MeshStandardMaterial({ color: 0xa5e4ff, emissive: 0x3a8dff, emissiveIntensity: 0.7, transparent: true, opacity: 0.32, depthWrite: false });

  const tire = new THREE.CylinderGeometry(1, 1, 1, 18).rotateX(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.55, 0.55, 1.08, 10).rotateX(Math.PI / 2);
  SHARED.wheelGeo = (r, w) => tire.clone().scale(r, r, w);
  SHARED.hubGeo = (r, w) => hub.clone().scale(r, r, w);

  SHARED.bodyGeo = mergeGeometries([
    part(new RoundedBoxGeometry(34, 7, 20, 3, 2.5), 0, 7, 0),
    part(new RoundedBoxGeometry(14, 5, 15, 2, 2), 19, 6, 0, 0, 0, -0.22),
    part(new RoundedBoxGeometry(16, 6, 5, 2, 2), -2, 7, 12.5),
    part(new RoundedBoxGeometry(16, 6, 5, 2, 2), -2, 7, -12.5),
  ]);
  // Rear wing and hood stripe in a darker shade of the kart colour; in team mode the wing's
  // end plates and a stripe along its top carry the team colour.
  SHARED.accentGeo = mergeGeometries([
    part(new THREE.BoxGeometry(5, 1.6, 27), -19, 18, 0),
    part(new THREE.BoxGeometry(24, 0.6, 4), 6, 10.7, 0),
  ]);
  SHARED.plateGeo = mergeGeometries([13, -13].map((z) => part(new THREE.BoxGeometry(4, 6, 1.4), -19, 15, z)));
  SHARED.teamStripeGeo = new THREE.BoxGeometry(2, 0.5, 27.2).translate(-19, 19, 0);
  SHARED.darkGeo = mergeGeometries([
    part(new THREE.BoxGeometry(40, 2, 18), 0, 3, 0),
    part(new THREE.BoxGeometry(4, 3, 26), 24, 4, 0),
    part(new THREE.BoxGeometry(3, 11, 13), -10, 14, 0),
    part(new THREE.BoxGeometry(2, 6, 2), -19, 12, 0),
    part(new THREE.TorusGeometry(3.2, 0.7, 6, 14), 6, 16, 0, 0, Math.PI / 2, 0.5),
    part(new THREE.CylinderGeometry(0.6, 0.6, 7, 6), 4, 14, 0, 0, 0, 1.0),
  ]);
  SHARED.metalGeo = mergeGeometries([
    part(new THREE.CylinderGeometry(1.6, 1.9, 7, 10), -21, 8, 5, 0, 0, Math.PI / 2),
    part(new THREE.CylinderGeometry(1.6, 1.9, 7, 10), -21, 8, -5, 0, 0, Math.PI / 2),
    part(new THREE.SphereGeometry(4.2, 12, 10), -14, 10, 0),
  ]);
  SHARED.headlightGeo = mergeGeometries([6.5, -6.5].map((z) => part(new THREE.BoxGeometry(1.2, 2.4, 4), 25.6, 6, z)));
  SHARED.taillightGeo = mergeGeometries([8, -8].map((z) => part(new THREE.BoxGeometry(1, 2, 4), -17.6, 7, z)));
  SHARED.flameGeo = new THREE.ConeGeometry(2.4, 10, 10).rotateZ(Math.PI / 2);
  SHARED.shieldGeo = new THREE.SphereGeometry(30, 24, 16);
  SHARED.ready = true;
  return SHARED;
}

// Name tags: the site font on a dark pill, a dot in the player's colour, a team-colour underline
// in team mode and (arena) a health bar. They keep a constant size in the world (so perspective
// shrinks the far ones) but never grow past a fixed size on screen up close.
// The canvas is 256x88; without a health bar only its top 64 rows are shown.
const LABEL_W = 58; // world units
const LABEL_TOP = 38; // the tag sits just above the driver's head
const labelRedraws = new Set();
let labelFont = 'system-ui, sans-serif';
document.fonts?.load('700 30px Inter').then((faces) => {
  if (!faces.length) return;
  labelFont = 'Inter, system-ui, sans-serif';
  for (const redraw of labelRedraws) redraw();
}).catch(() => {});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabel(text, color, teamColor) {
  const name = text.length > 12 ? `${text.slice(0, 11).trim()}…` : text;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 88;
  const ctx = c.getContext('2d');
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.renderOrder = 10;
  sprite.center.set(0.5, 1); // anchored at the top so the pill stays put when the bar appears
  let shown = null;
  let rows = 64;
  let width = LABEL_W;
  const size = (w) => {
    width = w;
    sprite.scale.set(w, (w * rows) / 256, 1);
    sprite.position.y = LABEL_TOP + (w * 64) / 256;
  };
  const draw = (hp, force) => {
    const bucket = hp === null ? -1 : Math.round(hp / 4);
    if (bucket === shown && !force) return;
    rows = hp === null ? 64 : 88;
    texture.repeat.set(1, rows / 88);
    texture.offset.set(0, 1 - rows / 88);
    size(width);
    shown = bucket;
    ctx.clearRect(0, 0, 256, 88);
    ctx.font = `700 30px ${labelFont}`;
    const w = Math.min(248, ctx.measureText(name).width + 58);
    const x = (256 - w) / 2;
    ctx.fillStyle = 'rgba(14,10,36,0.72)';
    roundRect(ctx, x, 6, w, 40, 20); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x + 22, 26, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x + 38, 27, w - 50);
    if (teamColor) {
      ctx.fillStyle = teamColor;
      roundRect(ctx, x + 14, 50, w - 28, 4, 2); ctx.fill();
    }
    if (hp !== null) {
      ctx.fillStyle = 'rgba(14,10,36,0.78)';
      roundRect(ctx, 48, 62, 160, 14, 7); ctx.fill();
      const f = Math.max(0, Math.min(1, hp / 100));
      ctx.fillStyle = f > 0.5 ? '#4ade80' : f > 0.25 ? '#fbbf24' : '#fb7185';
      if (f > 0) { roundRect(ctx, 50, 64, Math.max(10, 156 * f), 10, 5); ctx.fill(); }
    }
    texture.needsUpdate = true;
  };
  draw(null);
  const redraw = () => draw(shown === -1 ? null : shown * 4, true);
  labelRedraws.add(redraw);
  return { sprite, draw, size, dispose: () => labelRedraws.delete(redraw) };
}

function buildKart(meta, teamColor, isMe, night) {
  const S = sharedKartParts();
  const group = new THREE.Group();
  const chassis = new THREE.Group(); // rolls/pitches; wheels stay on the ground
  group.add(chassis);
  const meshes = [];

  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(meta.color), roughness: 0.32, metalness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(meta.color).multiplyScalar(0.8), roughness: 0.38, metalness: 0.3 });
  const add = (geo, mat, parent = chassis) => {
    const m = geo.isMesh ? geo : new THREE.Mesh(geo, mat);
    mat = m.material;
    m.castShadow = !m.userData.noShadow;
    m.receiveShadow = true;
    m.userData.mat = mat;
    parent.add(m);
    meshes.push(m);
    return m;
  };
  add(S.bodyGeo, bodyMat);
  add(S.accentGeo, accentMat);
  const teamMat = teamColor ? new THREE.MeshStandardMaterial({ color: new THREE.Color(teamColor), roughness: 0.4, metalness: 0.2 }) : null;
  add(S.plateGeo, teamMat || accentMat);
  if (teamMat) add(S.teamStripeGeo, teamMat);
  add(S.darkGeo, S.dark);
  add(S.metalGeo, S.metal);
  const driver = buildDriver(meta.avatar);
  for (const m of driver.meshes) add(m);
  add(S.headlightGeo, S.head).castShadow = false;
  add(S.taillightGeo, S.tail).castShadow = false;
  S.head.emissiveIntensity = night ? 3 : 1.2;

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
    label = makeLabel(meta.name, meta.color, teamColor);
    label.sprite.visible = false;
    group.add(label.sprite);
  }
  return {
    group, chassis, wheels, flames, shield, label, meshes, ghosted: false, halo: driver.halo, hitAt: -99, lastHp: 100,
    steer: 0, lastAngle: null, smoke: 0, slide: 0, hop: 0, wasSpin: false, wasDead: false,
  };
}

function setGhost(kart, on) {
  if (kart.ghosted === on) return;
  kart.ghosted = on;
  for (const m of kart.meshes) {
    m.material = on ? SHARED.ghost : m.userData.mat;
    m.castShadow = !on;
  }
}

// ---------- projectile models ----------
function projectileModels() {
  const rocketBody = mergeGeometries([
    part(new THREE.CylinderGeometry(3, 3, 18, 10), 0, 0, 0, 0, 0, Math.PI / 2),
    part(new THREE.BoxGeometry(5, 10, 1), -8, 0, 0),
    part(new THREE.BoxGeometry(5, 1, 10), -8, 0, 0),
  ]);
  const mineGeo = mergeGeometries([
    part(new THREE.CylinderGeometry(11, 12, 4, 16), 0, 2, 0),
    part(new THREE.SphereGeometry(6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 4, 0),
    ...[0, 1, 2, 3, 4, 5].map((i) => part(new THREE.ConeGeometry(1.4, 5, 6), Math.cos(i) * 8, 6, Math.sin(i) * 8)),
  ]);
  return {
    rocketBody,
    rocketNose: part(new THREE.ConeGeometry(3, 7, 10), 12.5, 0, 0, 0, 0, -Math.PI / 2),
    rocketMat: new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.35, metalness: 0.4 }),
    noseMat: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 }),
    bullet: new THREE.CapsuleGeometry(1.6, 12, 2, 6).rotateZ(Math.PI / 2),
    bulletMat: new THREE.MeshBasicMaterial({ color: 0xffe066 }),
    bomb: new THREE.SphereGeometry(9, 16, 12),
    bombMat: new THREE.MeshStandardMaterial({ color: 0x1f2430, roughness: 0.3, metalness: 0.6 }),
    fuse: new THREE.CylinderGeometry(1, 1, 5, 6).translate(0, 10, 0),
    mine: mineGeo,
    mineMat: new THREE.MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.5, metalness: 0.7 }),
    mineLight: new THREE.SphereGeometry(2.6, 10, 8).translate(0, 10, 0),
    mineLightMat: new THREE.MeshBasicMaterial({ color: 0xff2020 }),
    banana: new THREE.TorusGeometry(7, 2.6, 8, 14, Math.PI * 0.95),
    bananaMat: new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 }),
  };
}

// ---------- the renderer ----------
// Chase-camera poses: distance behind, height, look-ahead and look-at height.
const CAM = {
  race: { back: 132, up: 72, look: 110, at: 18 },
  arena: { back: 150, up: 90, look: 110, at: 18 },
  grid: { back: 120, up: 114, look: 150, at: 12 },
};

export class Kart3D {
  constructor(container, opts) {
    this.map = K.getMap(opts.mapId, opts.type, { reverse: !!opts.reverse });
    this.arena = this.map.type === 'arena';
    this.theme = THEMES[this.map.theme] || THEMES.meadow;
    const theme = this.theme;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: !MOBILE, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = theme.night ? 1.15 : 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'kart-canvas';
    container.prepend(this.renderer.domElement);

    const scene = new THREE.Scene();
    this.scene = scene;
    scene.fog = new THREE.Fog(theme.fog[0], theme.fog[1], theme.fog[2]);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(theme.sky[0]) }, bottom: { value: new THREE.Color(theme.sky[1]) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP - cameraPosition).y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }',
    }));
    this.sky = sky;
    scene.add(sky);

    scene.add(new THREE.HemisphereLight(theme.hemi[0], theme.hemi[1], theme.hemi[2]));
    const sun = new THREE.DirectionalLight(theme.sun[0], theme.sun[1]);
    sun.castShadow = true;
    sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -650; sc.right = 650; sc.top = 650; sc.bottom = -650; sc.near = 10; sc.far = 2500;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.5;
    this.sun = sun;
    scene.add(sun, sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshStandardMaterial({ map: theme.ground(), roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(this.map.center[0], 0, this.map.center[1]);
    ground.receiveShadow = true;
    scene.add(ground);

    // World-building context: things the builders hand back for animation.
    this.ctx = { pads: [], lava: [], spinners: [], clouds: null, uniforms: { uTime: { value: 0 } }, volcanoGlow: null };
    if (this.arena) buildArena(scene, this.map, theme, this.ctx);
    else buildRace(scene, this.map, theme, this.ctx);

    this.camera = new THREE.PerspectiveCamera(62, 1, 2, 14000);
    if (!MOBILE) {
      // Bloom makes flames, explosions, item boxes and neon glow.
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(scene, this.camera));
      // Daylight maps only bloom truly bright things (flames, explosions, neon), never white tyres or curbs.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), theme.night ? 0.8 : 0.32, 0.45, theme.night ? 0.7 : 0.97);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.camPos = null;
    this.camLook = new THREE.Vector3();
    this.camHeading = 0;
    this.shakeAmt = 0;

    this.fire = new Particles(scene, 3000, true);
    this.smoke = new Particles(scene, 3000, false);
    this.colBlue = new THREE.Color(0x4da6ff);
    this.colOrange = new THREE.Color(0xff9a1f);
    this.colWhite = new THREE.Color(0xfff6d5);
    this.colSnow = new THREE.Color(0xffffff);
    this.colEmber = new THREE.Color(0xff7a2a);
    this.colElectric = new THREE.Color(0x7dd3fc);

    // Skid marks: a ring buffer of flat dark quads.
    this.skidMax = 1600;
    this.skidIdx = 0;
    this.skids = new THREE.InstancedMesh(new THREE.PlaneGeometry(5, 9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: theme.night ? 0x05040a : 0x1a1a1a, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
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
    // Body panels flying off smashed karts: one pooled instanced mesh.
    const debrisMax = 48;
    const debris = new THREE.InstancedMesh(new RoundedBoxGeometry(6, 3, 4, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 }), debrisMax);
    debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < debrisMax; i++) { debris.setMatrixAt(i, zero); debris.setColorAt(i, new THREE.Color(0xffffff)); }
    debris.frustumCulled = false;
    scene.add(debris);
    this.debris = {
      mesh: debris, max: debrisMax, next: 0, active: false,
      pos: Array.from({ length: debrisMax }, () => new THREE.Vector3()),
      vel: Array.from({ length: debrisMax }, () => new THREE.Vector3()),
      axis: Array.from({ length: debrisMax }, () => new THREE.Vector3(0, 1, 0)),
      spin: new Float32Array(debrisMax), life: new Float32Array(debrisMax),
    };

    // Item boxes
    const boxMat = new THREE.MeshStandardMaterial({ map: tex.box(), transparent: true, opacity: 0.92, emissive: 0x332244, roughness: 0.3 });
    this.boxes = (opts.items === false ? [] : this.map.itemBoxes).map((b, i) => {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(24, 24, 24, 2, 3), boxMat);
      mesh.position.set(b.x, 20, b.y);
      mesh.castShadow = true;
      mesh.userData.phase = i * 0.7;
      mesh.userData.was = true;
      scene.add(mesh);
      return mesh;
    });

    this.models = projectileModels();
    this.karts = new Map();
    this.shots = new Map();
    this.mines = new Map();
    this.bananas = new Map();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.fire.points.material.uniforms.scale.value = h * 0.9;
    this.smoke.points.material.uniforms.scale.value = h * 0.9;
  }

  setKarts(list, myIdx, teamColorOf) {
    for (const k of this.karts.values()) { this.scene.remove(k.group); k.label?.dispose(); }
    this.karts.clear();
    for (const meta of list) {
      const kart = buildKart(meta, teamColorOf(meta), meta.idx === myIdx, this.theme.night);
      this.scene.add(kart.group);
      this.karts.set(meta.idx, kart);
    }
  }

  shake(x, z, amount) {
    if (!this.focus) return;
    const d = Math.hypot(this.focus.x - x, this.focus.y - z);
    this.shakeAmt = Math.max(this.shakeAmt, Math.max(0, 1 - d / 700) * amount);
  }

  groundY(x, z) {
    return this.map.heightAt ? this.map.heightAt(x, z) || 0 : 0;
  }

  // kind: rocket | mine | bomb | kill | hit | bullet. `color` is the victim's kart colour (kills).
  explode(x, z, kind = 'rocket', radius = 60, color = null) {
    if (kind === 'kill') this.killBurst(x, z, radius, color);
    if (kind === 'bullet') {
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        this.fire.emit(x, 12, z, Math.cos(a) * 140, 60 + Math.random() * 80, Math.sin(a) * 140, this.colWhite, 5, 0.25, { drag: 3, rise: -400 });
      }
      return;
    }
    const big = kind !== 'hit';
    const scale = Math.max(0.6, Math.min(2.2, radius / 70));
    const fireCols = [new THREE.Color(0xffd166), new THREE.Color(0xff7b00), new THREE.Color(0xff3d00)];
    const n = Math.round((big ? 70 : 26) * Math.min(1.6, scale));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const sp = (big ? 160 : 90) * scale * (0.4 + Math.random());
      this.fire.emit(x, 12, z, Math.cos(a) * sp, up * sp * 1.2, Math.sin(a) * sp,
        fireCols[i % 3], (big ? 26 : 16) * scale * (0.6 + Math.random()), 0.5 + Math.random() * 0.4, { grow: 1.6, drag: 2.5, rise: 40 });
    }
    const smokeCol = new THREE.Color(0x3a3a42);
    for (let i = 0; i < (big ? 35 : 12); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 * scale * Math.random();
      this.smoke.emit(x, 14, z, Math.cos(a) * sp, 30 + Math.random() * 40, Math.sin(a) * sp,
        smokeCol, (30 + Math.random() * 25) * scale, 1.2 + Math.random() * 0.8, { alpha: 0.7, grow: 1.8, drag: 1.2, rise: 25 });
    }
    const spark = new THREE.Color(0xfff3b0);
    for (let i = 0; i < (big ? 30 : 10); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 250 + Math.random() * 200;
      this.fire.emit(x, 10, z, Math.cos(a) * sp, 120 + Math.random() * 200, Math.sin(a) * sp, spark, 6, 0.6, { drag: 1.2, rise: -500 });
    }
    if (big) this.ring(x, z, 0xffb347, radius * 1.6, 0.5);
    this.shake(x, z, big ? 14 * Math.min(1.5, scale) : 6);
  }

  // A smashed kart: a hot core flash, confetti in its colour and a few tumbling body panels.
  killBurst(x, z, radius, color) {
    const y = this.groundY(x, z);
    const col = new THREE.Color(color || '#ffffff');
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < 36; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 220;
      this.smoke.emit(x, y + 16, z, Math.cos(a) * sp, 260 + Math.random() * 260, Math.sin(a) * sp,
        i % 3 ? col : white, 6, 1 + Math.random() * 0.5, { drag: 1.4, rise: -300 });
    }
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.spark(), color: 0xfff1c2, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.position.set(x, y + 18, z);
    flash.scale.setScalar(0.01);
    flash.renderOrder = 4;
    this.scene.add(flash);
    this.effects.push({ mesh: flash, life: 0.37, max: 0.37, kind: 'flash', radius });
    const D = this.debris;
    for (let n = 0; n < 6; n++) {
      const i = D.next;
      D.next = (D.next + 1) % D.max;
      const a = Math.random() * Math.PI * 2;
      const sp = 140 + Math.random() * 160;
      D.pos[i].set(x, y + 14, z);
      D.vel[i].set(Math.cos(a) * sp, 280 + Math.random() * 220, Math.sin(a) * sp);
      D.axis[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      D.spin[i] = 6 + Math.random() * 10;
      D.life[i] = 1.2;
      D.mesh.setColorAt(i, n % 3 ? col : white);
    }
    D.mesh.instanceColor.needsUpdate = true;
    D.active = true;
  }

  updateDebris(dt) {
    const D = this.debris;
    if (!D.active) return;
    let alive = false;
    for (let i = 0; i < D.max; i++) {
      if (D.life[i] <= 0) continue;
      D.life[i] -= dt;
      const p = D.pos[i];
      const v = D.vel[i];
      v.y -= 900 * dt;
      p.addScaledVector(v, dt);
      const floor = this.groundY(p.x, p.z) + 2;
      if (p.y < floor) { p.y = floor; v.y *= -0.35; v.x *= 0.6; v.z *= 0.6; D.spin[i] *= 0.6; }
      this.tmpQ.setFromAxisAngle(D.axis[i], D.spin[i] * (1.2 - D.life[i]));
      const sc = D.life[i] > 0 ? Math.min(1, D.life[i] / 0.25) : 0;
      this.tmpV.setScalar(sc);
      this.tmpM.compose(p, this.tmpQ, this.tmpV);
      D.mesh.setMatrixAt(i, this.tmpM);
      if (D.life[i] > 0) alive = true;
    }
    this.tmpV.set(1, 1, 1);
    D.mesh.instanceMatrix.needsUpdate = true;
    D.active = alive;
  }

  shock(x, z, radius) {
    this.ring(x, z, 0x7dd3fc, radius, 0.45);
    this.ring(x, z, 0xffffff, radius * 0.7, 0.3);
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = radius * (1.5 + Math.random());
      this.fire.emit(x, 10 + Math.random() * 20, z, Math.cos(a) * sp, Math.random() * 60, Math.sin(a) * sp, this.colElectric, 8, 0.45, { drag: 2.5 });
    }
    this.shake(x, z, 10);
  }

  block(x, z) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.3) * Math.PI;
      this.fire.emit(x + Math.cos(a) * 28, 14 + Math.sin(e) * 20, z + Math.sin(a) * 28, Math.cos(a) * 160, 40, Math.sin(a) * 160, this.colBlue, 8, 0.4, { drag: 3 });
    }
  }

  sparkle(x, z) {
    const cols = [0xfacc15, 0xec4899, 0x3b82f6, 0x22c55e].map((c) => new THREE.Color(c));
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 120;
      this.fire.emit(x, 20, z, Math.cos(a) * sp, 60 + Math.random() * 120, Math.sin(a) * sp, cols[i % 4], 9, 0.5, { drag: 2, rise: -200 });
    }
  }

  ring(x, z, color, radius, life) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(x, 3, z);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, life, max: life, kind: 'ring', radius });
  }

  respawnBeam(x, z) {
    // A short column of light that fades upward: never a wall of white in front of the camera.
    const y = this.groundY(x, z);
    if (!this.beamTex) {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, 64);
      grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.7, 'rgba(255,255,255,0.45)'); grad.addColorStop(1, '#fff');
      g.fillStyle = grad; g.fillRect(0, 0, 4, 64);
      this.beamTex = new THREE.CanvasTexture(c);
    }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(22, 30, 160, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9be7ff, map: this.beamTex, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(x, y + 80, z);
    this.ring(x, z, 0x9be7ff, 70, 0.6);
    this.scene.add(beam);
    this.effects.push({ mesh: beam, life: 0.9, max: 0.9, kind: 'beam' });
    const col = new THREE.Color(0x9be7ff);
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      this.fire.emit(x + Math.cos(a) * 30, 5, z + Math.sin(a) * 30, Math.cos(a) * 40, 150 + Math.random() * 200, Math.sin(a) * 40, col, 8, 0.8, { drag: 1 });
    }
  }

  addSkid(x, z, angle) {
    this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle + Math.PI / 2);
    this.tmpM.compose(new THREE.Vector3(x, 1.0, z), this.tmpQ, this.tmpV);
    this.skids.setMatrixAt(this.skidIdx, this.tmpM);
    this.skidIdx = (this.skidIdx + 1) % this.skidMax;
    this.skids.instanceMatrix.needsUpdate = true;
  }

  updateEffects(dt) {
    this.effects = this.effects.filter((e) => {
      e.life -= dt;
      const p = 1 - e.life / e.max;
      if (e.kind === 'beam') {
        e.mesh.material.opacity = 0.45 * (1 - p);
        e.mesh.scale.set(1 - p * 0.7, 1, 1 - p * 0.7);
      } else if (e.kind === 'flash') {
        const age = e.max - e.life;
        e.mesh.scale.setScalar(Math.max(0.01, Math.min(1, age / 0.12) * e.radius * 2.2));
        e.mesh.material.opacity = Math.max(0, 1 - age / e.max);
      } else {
        e.mesh.scale.setScalar(10 + p * e.radius);
        e.mesh.material.opacity = 0.85 * (1 - p);
      }
      if (e.life > 0) return true;
      this.scene.remove(e.mesh);
      if (!e.mesh.isSprite) e.mesh.geometry.dispose(); // sprites share one geometry
      e.mesh.material.dispose();
      return false;
    });
  }

  // Weather and ambient particles around the camera.
  ambient(dt) {
    const c = this.camera.position;
    if (this.theme.snowfall) {
      for (let i = 0; i < (MOBILE ? 2 : 5); i++) {
        this.smoke.emit(c.x + (Math.random() - 0.5) * 1400, 350 + Math.random() * 200, c.z + (Math.random() - 0.5) * 1400,
          (Math.random() - 0.5) * 30, -70 - Math.random() * 40, (Math.random() - 0.5) * 30, this.colSnow, 3 + Math.random() * 3, 6, { alpha: 0.9, drag: 0 });
      }
    }
    if (this.theme.embers) {
      for (let i = 0; i < 2; i++) {
        this.fire.emit(c.x + (Math.random() - 0.5) * 1600, Math.random() * 40, c.z + (Math.random() - 0.5) * 1600,
          (Math.random() - 0.5) * 20, 40 + Math.random() * 60, (Math.random() - 0.5) * 20, this.colEmber, 3 + Math.random() * 3, 4, { drag: 0.2 });
      }
    }
  }

  // view: { karts:[{idx,x,y,angle,speed,flags,hp}], shots:[[id,kind,x,y,a,prog]], mines:[[id,x,y,armed]],
  //         bananas:[[id,x,y]], boxes:[0|1], countdown, focus: {idx,x,y,angle,spinning,boost,grid,snap} }
  update(view, dt, now) {
    const t = now / 1000;
    const flameCol = [new THREE.Color(0xffe066), new THREE.Color(0xff8c1a), new THREE.Color(0xff4d00)];
    const smokeCol = new THREE.Color(this.theme.night ? 0x4a4560 : 0x9aa0aa);
    const dustCol = new THREE.Color(this.theme.snowfall ? 0xffffff : 0xc8b48a);

    // Karts
    const seen = new Set();
    for (const k of view.karts) {
      const kart = this.karts.get(k.idx);
      if (!kart) continue;
      seen.add(k.idx);
      const dead = k.flags & 32;
      const blink = (k.flags & 16) && !(k.flags & 1) && !(k.flags & 4) && Math.floor(now / 90) % 2;
      kart.group.visible = !dead && !blink;
      if (dead) { kart.lastAngle = null; kart.wasDead = true; continue; }
      if (kart.wasDead) { kart.wasDead = false; this.respawnBeam(k.x, k.y); }
      setGhost(kart, !!(k.flags & 1024));
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

      if (kart.halo) kart.halo.rotation.y = t;
      if (k.hp < kart.lastHp) kart.hitAt = t;
      kart.lastHp = k.hp;
      const boosting = k.flags & 2;
      const cos = Math.cos(k.angle);
      const sin = Math.sin(k.angle);
      for (const f of kart.flames) {
        f.visible = !!boosting;
        if (boosting) f.scale.set(0.8 + Math.random() * 0.8, 1, 1);
      }
      kart.shield.visible = !!(k.flags & 4);
      if (kart.shield.visible) kart.shield.scale.setScalar(1 + Math.sin(t * 8) * 0.04);

      // Minigun muzzle flash.
      if (k.flags & 2048) {
        for (let i = 0; i < 2; i++) {
          this.fire.emit(k.x + cos * 30, 12, k.y + sin * 30, cos * 200 + (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 40, sin * 200 + (Math.random() - 0.5) * 80,
            flameCol[i], 9, 0.08, { drag: 4 });
        }
      }
      // Exhaust: flames when boosting, light smoke otherwise; sparks and skids when drifting.
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

    this.updateShots(view.shots || [], dt, flameCol, smokeCol);
    this.updateMines(view.mines || [], now);
    this.updateBananas(view.bananas || []);

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

    // Scenery animation
    const c = this.ctx;
    c.uniforms.uTime.value = t;
    for (const s of c.spinners) { s.rotation.y = t * 0.8; s.rotation.x = t * 0.5; }
    for (const p of c.pads) p.material.map.offset.y = (t * 1.5) % 1;
    for (const l of c.lava) { l.offset.x = Math.sin(t * 0.2) * 0.1; l.offset.y = (t * 0.03) % 1; }
    if (c.clouds) c.clouds.update(dt);
    if (c.volcanoGlow) c.volcanoGlow.material.color.setHSL(0.04, 1, 0.5 + Math.sin(t * 2) * 0.08);
    this.ambient(dt);

    this.fire.update(dt);
    this.smoke.update(dt);
    this.updateEffects(dt);
    this.updateDebris(dt);
    this.updateCamera(view.focus, dt, t);
    this.updateLabels(view, now, t);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // Name tags: only the 8 karts nearest the camera (re-sorted 4 times a second), only at a
  // readable distance, never during the countdown; arena health bars while hurt or just hit.
  updateLabels(view, now, t) {
    const c = this.camera.position;
    if (!this.labelSet || now - this.labelSortAt > 250 || view.focus?.snap) {
      this.labelSortAt = now;
      const near = view.karts.filter((k) => !(k.flags & 32) && this.karts.get(k.idx)?.label)
        .map((k) => [k.idx, (k.x - c.x) ** 2 + (k.y - c.z) ** 2])
        .sort((a, b) => a[1] - b[1]);
      this.labelSet = new Set(near.slice(0, 8).map((e) => e[0]));
    }
    for (const k of view.karts) {
      const kart = this.karts.get(k.idx);
      if (!kart?.label) continue;
      const d = c.distanceTo(kart.group.position);
      const on = kart.group.visible && this.labelSet.has(k.idx) && !view.countdown && d > 110 && d < 1500;
      kart.label.sprite.visible = on;
      if (!on) continue;
      kart.label.size(Math.min(LABEL_W, d * 0.2));
      kart.label.sprite.material.opacity = d > 1150 ? 1 - (d - 1150) / 350 : 1;
      kart.label.draw(this.arena && (k.hp < 100 || t - kart.hitAt < 3) ? k.hp : null);
    }
  }

  updateShots(list, dt, flameCol, smokeCol) {
    const M = this.models;
    const live = new Set();
    for (const [id, kind, x, y, a, prog] of list) {
      live.add(id);
      let s = this.shots.get(id);
      if (!s) {
        s = new THREE.Group();
        if (kind === 1) {
          const b = new THREE.Mesh(M.rocketBody, M.rocketMat);
          b.castShadow = true;
          s.add(b, new THREE.Mesh(M.rocketNose, M.noseMat));
        } else if (kind === 2) {
          s.add(new THREE.Mesh(M.bullet, M.bulletMat));
        } else {
          const b = new THREE.Mesh(M.bomb, M.bombMat);
          b.castShadow = true;
          s.add(b, new THREE.Mesh(M.fuse, M.noseMat));
        }
        s.userData.kind = kind;
        this.scene.add(s);
        this.shots.set(id, s);
      }
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      if (kind === 3) {
        // Bombs arc through the air.
        const p = (prog || 0) / 100;
        s.position.set(x, 12 + Math.sin(Math.min(1, p) * Math.PI) * 110, y);
        s.rotation.z += dt * 6;
        this.fire.emit(x, s.position.y + 12, y, 0, 20, 0, flameCol[0], 7, 0.2);
      } else {
        s.position.set(x, kind === 2 ? 12 : 14, y);
        s.rotation.y = -a;
        if (kind === 1) {
          s.rotation.x += dt * 12;
          this.fire.emit(x - ca * 12, 14, y - sa * 12, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
            flameCol[Math.floor(Math.random() * 3)], 12, 0.18, { grow: 0.4 });
          this.smoke.emit(x - ca * 14, 14, y - sa * 14, 0, 12, 0, smokeCol, 9, 0.7, { alpha: 0.5, grow: 2.4, drag: 1 });
        }
      }
    }
    for (const [id, s] of this.shots) if (!live.has(id)) { this.scene.remove(s); this.shots.delete(id); }
  }

  updateMines(list, now) {
    const M = this.models;
    const live = new Set();
    for (const [id, x, y, armed] of list) {
      live.add(id);
      let m = this.mines.get(id);
      if (!m) {
        m = new THREE.Group();
        const body = new THREE.Mesh(M.mine, M.mineMat);
        body.castShadow = true;
        const light = new THREE.Mesh(M.mineLight, M.mineLightMat);
        m.add(body, light);
        m.userData.light = light;
        m.position.set(x, 0.5, y);
        this.scene.add(m);
        this.mines.set(id, m);
      }
      m.userData.light.visible = armed ? Math.floor(now / 250) % 2 === 0 : true;
      m.userData.light.scale.setScalar(armed ? 1.3 : 0.7);
    }
    for (const [id, m] of this.mines) if (!live.has(id)) { this.scene.remove(m); this.mines.delete(id); }
  }

  updateBananas(list) {
    const M = this.models;
    const live = new Set();
    for (const [id, x, y] of list) {
      live.add(id);
      let b = this.bananas.get(id);
      if (!b) {
        b = new THREE.Mesh(M.banana, M.bananaMat);
        b.castShadow = true;
        b.rotation.set(-0.3, Math.random() * Math.PI * 2, 0.4);
        this.scene.add(b);
        this.bananas.set(id, b);
      }
      b.position.set(x, 5, y);
    }
    for (const [id, b] of this.bananas) if (!live.has(id)) { this.scene.remove(b); this.bananas.delete(id); }
  }

  updateCamera(focus, dt, t) {
    this.focus = focus;
    if (focus) {
      if (focus.snap) this.camHeading = focus.angle;
      if (!focus.spinning) {
        let d = focus.angle - this.camHeading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.camHeading += d * Math.min(1, dt * 8);
      }
      // During the countdown a high grid cam looks over the karts ahead; after GO it eases
      // (about 0.9 s) into the chase cam.
      const gridTarget = focus.grid ? 1 : 0;
      if (focus.snap || this.gridMix === undefined) this.gridMix = gridTarget;
      else this.gridMix += (gridTarget - this.gridMix) * (1 - Math.exp(-dt * 3));
      const chase = this.arena ? CAM.arena : CAM.race;
      const mix = (key) => chase[key] + (CAM.grid[key] - chase[key]) * this.gridMix;
      const back = mix('back');
      const ch = Math.cos(this.camHeading);
      const sh = Math.sin(this.camHeading);
      // In the arena, pull the camera in when a wall or obstacle is behind the kart, and lift it
      // so it looks over the top instead of into the driver's head.
      let dist = back;
      if (this.arena) {
        for (let d = 20; d <= back; d += 10) {
          if (this.map.blocked(focus.x - ch * d, focus.y - sh * d, 18)) { dist = Math.max(90, d - 25); break; }
        }
      }
      this.camDist = this.camDist === undefined || focus.snap ? dist : this.camDist + (dist - this.camDist) * Math.min(1, dt * (dist < this.camDist ? 14 : 3));
      const camUp = mix('up') + Math.max(0, back - this.camDist) * 0.6;
      const ahead = mix('look');
      const desired = new THREE.Vector3(focus.x - ch * this.camDist, camUp, focus.y - sh * this.camDist);
      const look = new THREE.Vector3(focus.x + ch * ahead, mix('at'), focus.y + sh * ahead);
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
        const minD = this.camDist * 0.85;
        if (hd < minD && hd > 0.01) {
          this.camPos.x = focus.x + (dx / hd) * minD;
          this.camPos.z = focus.y + (dz / hd) * minD;
        }
      }
      // Keep at least ~74 degrees of horizontal view, so portrait phones still see the corners.
      const base = Math.max(62, Math.min(88, (2 * Math.atan(Math.tan((37 * Math.PI) / 180) / this.camera.aspect) * 180) / Math.PI));
      const fov = base + (focus.boost ? 10 : 0);
      this.camera.fov = focus.snap ? fov : this.camera.fov + (fov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this.camPos);
      if (this.shakeAmt > 0.01) {
        this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt;
        this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt;
        this.shakeAmt *= Math.exp(-dt * 6);
      }
      this.camera.lookAt(this.camLook);
      this.sun.position.set(focus.x + 450, 900, focus.y + 300);
      this.sun.target.position.set(focus.x, 0, focus.y);
    } else {
      const [cx, cz] = this.map.center;
      this.camera.position.set(cx + Math.cos(t * 0.1) * 1800, 1300, cz + Math.sin(t * 0.1) * 1800);
      this.camera.lookAt(cx, 0, cz);
      this.sun.position.set(cx + 450, 900, cz + 300);
      this.sun.target.position.set(cx, 0, cz);
    }
    this.sky.position.copy(this.camera.position);
    // Rivals right next to the lens would fill the screen, and one sitting on the line between the
    // camera and your kart would hide it: don't draw them.
    const cp = this.camera.position;
    const fx = focus ? focus.x - cp.x : 0;
    const fz = focus ? focus.y - cp.z : 0;
    const fd2 = fx * fx + fz * fz;
    for (const [idx, kart] of this.karts) {
      if (idx === focus?.idx || !kart.group.visible) continue;
      const p = kart.group.position;
      const dx = p.x - cp.x;
      const dz = p.z - cp.z;
      if (dx * dx + (p.y - cp.y) ** 2 + dz * dz < 70 * 70) { kart.group.visible = false; continue; }
      const along = fd2 > 0 ? (dx * fx + dz * fz) / fd2 : 1;
      if (along > 0 && along < 0.8 && Math.abs(dx * fz - dz * fx) / Math.sqrt(fd2) < 24) kart.group.visible = false;
    }
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    // Per-game geometry and materials are freed; cached textures, trees and kart parts are kept for the next game.
    this.scene.traverse((o) => {
      if (o.geometry && !o.isInstancedMesh) o.geometry.dispose();
    });
  }
}

window.Kart3D = Kart3D;
window.dispatchEvent(new Event('kart3d-ready'));
