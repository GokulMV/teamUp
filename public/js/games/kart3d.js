// 3D renderer for Kart Battle, built with Three.js. Game logic stays in kart.js and on the
// server; this file only draws what it is given. Scenery lives in kart3d/world.js (themes,
// arenas) and kart3d/track.js (race tracks: terrain, bridges, ramps, water and lava); power-up
// models and effects in kart3d/items3d.js.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MOBILE, THEMES, tex, part, buildArena, loadMoonlit } from './kart3d/world.js';
import { buildRace } from './kart3d/track.js';
import { ItemFX, shieldMaterial, shieldGeometry, ghostMaterial, starVariant } from './kart3d/items3d.js';
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
  SHARED.flame = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.85, 0.25), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  SHARED.flameCore = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.3, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  SHARED.shield = shieldMaterial();
  SHARED.ghost = ghostMaterial();

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
    part(new THREE.TorusGeometry(3.2, 0.7, 6, 14), 6.5, 14.5, 0, 0, Math.PI / 2, 0.5),
    part(new THREE.CylinderGeometry(0.6, 0.6, 7, 6), 4.5, 12.5, 0, 0, 0, 1.0),
  ]);
  SHARED.metalGeo = mergeGeometries([
    part(new THREE.CylinderGeometry(1.6, 1.9, 7, 10), -21, 8, 5, 0, 0, Math.PI / 2),
    part(new THREE.CylinderGeometry(1.6, 1.9, 7, 10), -21, 8, -5, 0, 0, Math.PI / 2),
    part(new THREE.SphereGeometry(4.2, 12, 10), -14, 10, 0),
  ]);
  SHARED.headlightGeo = mergeGeometries([6.5, -6.5].map((z) => part(new THREE.BoxGeometry(1.2, 2.4, 4), 25.6, 6, z)));
  SHARED.taillightGeo = mergeGeometries([8, -8].map((z) => part(new THREE.BoxGeometry(1, 2, 4), -17.6, 7, z)));
  // The driver is the player's lobby avatar (kart3d/driver.js).
  SHARED.flameGeo = new THREE.ConeGeometry(2.6, 12, 12, 1, true).rotateZ(Math.PI / 2);
  SHARED.flameCoreGeo = new THREE.ConeGeometry(1.3, 7, 10, 1, true).rotateZ(Math.PI / 2).translate(2.2, 0, 0);
  SHARED.shieldGeo = shieldGeometry();
  SHARED.ready = true;
  return SHARED;
}

// Name tags: the site font on a dark pill, a dot in the player's colour, a team-colour underline
// in team mode and (arena) a health bar. updateLabels sizes and places them in screen pixels:
// they shrink with distance like the karts, but never below a readable size, and a tag that would
// overlap a nearer one is lifted above it or faded out.
// The canvas is 256x88; without a health bar only its top 64 rows are shown.
const LABEL_W = 58; // world units: the tag's natural width, before the on-screen limits
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
  // sizeAttenuation off: the scale is in screen units, which updateLabels sets every frame.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, sizeAttenuation: false }));
  sprite.renderOrder = 10;
  sprite.frustumCulled = false; // updateLabels already hides tags that are off screen
  sprite.position.y = LABEL_TOP;
  let shown = null;
  const label = { sprite, rows: 64, pill: 0.5 };
  // px: on-screen width in CSS pixels; unit: CSS pixels per sprite scale unit; lift: px above the head.
  label.layout = (px, unit, lift) => {
    const h = (px * label.rows) / 256;
    sprite.scale.set(px / unit, h / unit, 1);
    // The head point sits at the bottom of the 64-row pill block, so the health bar hangs below it.
    sprite.center.set(0.5, (label.rows - 64) / label.rows - lift / h);
  };
  label.draw = (hp, force) => {
    const bucket = hp === null ? -1 : Math.round(hp / 4);
    if (bucket === shown && !force) return;
    label.rows = hp === null ? 64 : 88;
    texture.repeat.set(1, label.rows / 88);
    texture.offset.set(0, 1 - label.rows / 88);
    shown = bucket;
    ctx.clearRect(0, 0, 256, 88);
    ctx.font = `700 30px ${labelFont}`;
    const w = Math.min(248, ctx.measureText(name).width + 58);
    label.pill = w / 256;
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
  label.draw(null);
  const redraw = () => label.draw(shown === -1 ? null : shown * 4, true);
  labelRedraws.add(redraw);
  label.dispose = () => {
    labelRedraws.delete(redraw);
    texture.dispose();
    sprite.material.dispose();
  };
  return label;
}

function buildKart(meta, teamColor, isMe, night) {
  const S = sharedKartParts();
  const group = new THREE.Group();
  const chassis = new THREE.Group(); // rolls/pitches; wheels stay on the ground
  group.add(chassis);
  const meshes = [];

  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(meta.color), roughness: 0.32, metalness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(meta.color).multiplyScalar(0.8), roughness: 0.38, metalness: 0.3 });
  // Only the big parts cast shadows; small details are hidden on far-away karts (see update()).
  // `geo` can also be a ready-made mesh (the avatar driver's parts).
  const details = [];
  const add = (geo, mat, parent = chassis, { shadow = true, detail = false } = {}) => {
    const m = geo.isMesh ? geo : new THREE.Mesh(geo, mat);
    const casts = shadow && !m.userData.noShadow;
    m.castShadow = casts;
    if (!casts) m.userData.noShadow = true; // applyLook() restores shadows from this
    m.receiveShadow = true;
    m.userData.mat = m.material; // restored after ghost mode
    m.userData.shadow = casts;
    parent.add(m);
    meshes.push(m);
    if (detail) details.push(m);
    return m;
  };
  add(S.bodyGeo, bodyMat);
  add(S.accentGeo, accentMat, chassis, { shadow: false });
  // Team mode: the wing's end plates and a stripe along its top carry the team colour.
  const teamMat = teamColor ? new THREE.MeshStandardMaterial({ color: new THREE.Color(teamColor), roughness: 0.4, metalness: 0.2 }) : null;
  add(S.plateGeo, teamMat || accentMat, chassis, { shadow: false });
  if (teamMat) add(S.teamStripeGeo, teamMat, chassis, { shadow: false });
  add(S.darkGeo, S.dark);
  add(S.metalGeo, S.metal, chassis, { shadow: false, detail: true });
  // The driver rides in the chassis, so it tilts, flies, flips and shimmers with the kart.
  const driver = buildDriver(meta.avatar);
  driver.meshes.forEach((m, i) => add(m, null, chassis, { shadow: i === 0, detail: i > 0 }));
  add(S.headlightGeo, S.head, chassis, { shadow: false, detail: true });
  add(S.taillightGeo, S.tail, chassis, { shadow: false, detail: true });
  S.head.emissiveIntensity = night ? 3 : 1.2;

  const wheels = [];
  for (const [x, z, r, w, front] of [[13, 13.5, 6, 5, true], [13, -13.5, 6, 5, true], [-12, 14.5, 7.5, 7, false], [-12, -14.5, 7.5, 7, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    const spin = new THREE.Group();
    pivot.add(spin);
    add(S.wheelGeo(r, w), S.rubber, spin);
    add(S.hubGeo(r * 0.55, w), S.metal, spin, { shadow: false, detail: true });
    group.add(pivot);
    wheels.push({ pivot, spin, r, front });
  }

  const flames = [5, -5].map((z) => {
    const f = new THREE.Mesh(S.flameGeo, S.flame);
    f.add(new THREE.Mesh(S.flameCoreGeo, S.flameCore));
    f.position.set(-29, 8, z);
    f.visible = false;
    chassis.add(f);
    return f;
  });

  const shield = new THREE.Mesh(S.shieldGeo, S.shield);
  shield.position.y = 14;
  shield.renderOrder = 6;
  shield.visible = false;
  group.add(shield);

  let label = null;
  if (!isMe) {
    label = makeLabel(meta.name, meta.color, teamColor);
    label.sprite.visible = false;
    group.add(label.sprite);
  }
  return {
    group, chassis, wheels, flames, shield, label, meshes, details, near: true, ghosted: false, starred: false, halo: driver.halo, hitAt: -99, lastHp: 100,
    steer: 0, lastAngle: null, smoke: 0, slide: 0, hop: 0, wasSpin: false, wasDead: false,
    hint: null, pitch: 0, roll: 0, lastY: null, vy: 0, prevAir: 0, squash: 0, trickT: -1, trickDir: 1, wasTrick: false, falling: false, fallT: 0,
    color: meta.color, fade: 1, look: 'solid', tagAlpha: 0, tagLift: 0, tagOn: false,
  };
}

// A kart is drawn solid, as a ghost (ghost item), in rainbow versions of its own materials (star
// power) or, while it fades out next to the lens, in a see-through coat of its own colour.
function applyLook(kart) {
  const look = kart.fade < 1 ? 'fade' : kart.ghosted ? 'ghost' : kart.starred ? 'star' : 'solid';
  if (look === 'fade') {
    kart.fadeMat = kart.fadeMat || new THREE.MeshStandardMaterial({ color: new THREE.Color(kart.color), roughness: 0.5, transparent: true, depthWrite: false });
    kart.fadeMat.opacity = 0.75 * kart.fade;
  }
  if (look === kart.look) return;
  kart.look = look;
  for (const m of kart.meshes) {
    m.material = look === 'fade' ? kart.fadeMat : look === 'ghost' ? SHARED.ghost : look === 'star' ? starVariant(m.userData.mat) : m.userData.mat;
    m.castShadow = (look === 'solid' || look === 'star') && !m.userData.noShadow;
  }
}

function setLook(kart, ghost, star) {
  if (kart.ghosted === ghost && kart.starred === star) return;
  kart.ghosted = ghost;
  kart.starred = star;
  applyLook(kart);
}

// ---------- the renderer ----------
// Chase-camera poses: distance behind, height, look-ahead and look-at height.
const CAM = {
  race: { back: 132, up: 72, look: 110, at: 18 },
  arena: { back: 150, up: 90, look: 110, at: 18 },
  grid: { back: 120, up: 114, look: 150, at: 12 },
  // Portrait phones: further back and higher, so the narrow view still shows the karts beside you.
  portrait: { back: 150, up: 112, look: 100, at: 18 },
  portraitGrid: { back: 150, up: 116, look: 150, at: 12 },
};
const KART_MID = 15; // height of the kart's middle, which the chase cam keeps at a fixed spot on screen

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
    const sky = new THREE.Mesh(new THREE.SphereGeometry(15000, 24, 12), new THREE.ShaderMaterial({
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

    if (this.arena) {
      // Arenas sit on a flat plain; race tracks build their own terrain.
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshStandardMaterial({ map: theme.ground(), roughness: 1 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(this.map.center[0], 0, this.map.center[1]);
      ground.receiveShadow = true;
      scene.add(ground);
    }

    // World-building context: things the builders hand back for animation.
    this.ctx = {
      pads: [], lava: [], spinners: [], clouds: null, uniforms: { uTime: { value: 0 } }, volcanoGlow: null,
      water: [], beams: [], flags: [], vents: [], night: !!theme.night,
    };
    if (this.arena) buildArena(scene, this.map, theme, this.ctx);
    else buildRace(scene, this.map, theme, this.ctx);

    this.camera = new THREE.PerspectiveCamera(62, 1, 2, 20000);
    this.camHint = { hint: null };
    this.camGround = null;
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
    this.colAsh = new THREE.Color(0x8a827c);
    this.colSplash = new THREE.Color(0xe8f7ff);

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
    this.skidTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
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

    this.karts = new Map();
    this.lastKarts = new Map(); // idx -> latest drawn position, for item effects aimed at karts
    this.items = new ItemFX(this, { items: opts.items !== false });
    // Compile every item and aura shader with the first frame, not with a stutter mid-race.
    // Star variants: plain kart parts, the drivers' vertex-coloured accessories and textured faces.
    const S = sharedKartParts();
    const faceTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    faceTex.needsUpdate = true;
    const starMats = [S.dark, new THREE.MeshStandardMaterial({ vertexColors: true }), new THREE.MeshStandardMaterial({ map: faceTex })].map(starVariant);
    this.warm = this.items.warmUp([...starMats, S.ghost, S.shield]);

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
    this.viewW = w;
    this.viewH = h;
    this.camera.aspect = w / h;
    // On a tall portrait screen the picture is shifted up (a lens shift, not a tilt), so your kart
    // sits low, near the thumbs, with the road ahead above it and the HUD over the sky.
    this.tall = Math.max(0, Math.min(1, (0.8 - w / h) / 0.32));
    if (this.tall > 0) this.camera.setViewOffset(w, h, 0, -0.1 * this.tall * h, w, h); // (it also sets aspect)
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.fire.points.material.uniforms.scale.value = h * 0.9;
    this.smoke.points.material.uniforms.scale.value = h * 0.9;
  }

  // Height of whatever is under (x, z): road, bridge deck, ramp or terrain. `holder.hint` caches
  // the nearest road sample so lookups stay cheap and never snap to a parallel stretch.
  // `road`: anything inside the walls follows the road (projectiles fly straight over gaps).
  groundAt(x, z, holder, road = false) {
    if (this.arena) return 0;
    let q = this.map.nearestIndex(x, z, holder ? holder.hint : null);
    // A stale hint (the kart was teleported, e.g. fished out of the water) finds the wrong stretch.
    if (holder && holder.hint !== null && q.dist > this.map.width / 2 + K.WALL_PAD + 60) q = this.map.nearestIndex(x, z);
    if (holder) holder.hint = q.index;
    if (road && q.dist <= this.map.wallAt(q)) return q.h;
    return this.map.surfaceAt(x, z, q);
  }

  setKarts(list, myIdx, teamColorOf) {
    for (const k of this.karts.values()) { this.items.releaseKart(k); this.scene.remove(k.group); k.label?.dispose(); k.fadeMat?.dispose(); }
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
    return this.items.ground(x, z) || 0;
  }

  // kind: rocket | mine | bomb | kill | hit | bullet | bouncer | comet. `color` is the victim's kart colour (kills).
  explode(x, z, kind = 'rocket', radius = 60, color = null) {
    if (kind === 'comet' || kind === 'bouncer' || kind === 'snowball') { this.items.blast(kind, x, z, radius); return; }
    if (kind === 'sticky' || kind === 'decoy') this.items.blast(kind, x, z, radius); // goo or box shards, then the fireball
    const gy = this.groundY(x, z);
    if (kind === 'kill') this.killBurst(x, z, radius, color);
    if (kind === 'bullet') {
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        this.fire.emit(x, gy + 12, z, Math.cos(a) * 140, 60 + Math.random() * 80, Math.sin(a) * 140, this.colWhite, 5, 0.25, { drag: 3, rise: -400 });
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
      this.fire.emit(x, gy + 12, z, Math.cos(a) * sp, up * sp * 1.2, Math.sin(a) * sp,
        fireCols[i % 3], (big ? 26 : 16) * scale * (0.6 + Math.random()), 0.5 + Math.random() * 0.4, { grow: 1.6, drag: 2.5, rise: 40 });
    }
    const smokeCol = new THREE.Color(0x3a3a42);
    for (let i = 0; i < (big ? 35 : 12); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 * scale * Math.random();
      this.smoke.emit(x, gy + 14, z, Math.cos(a) * sp, 30 + Math.random() * 40, Math.sin(a) * sp,
        smokeCol, (30 + Math.random() * 25) * scale, 1.2 + Math.random() * 0.8, { alpha: 0.7, grow: 1.8, drag: 1.2, rise: 25 });
    }
    const spark = new THREE.Color(0xfff3b0);
    for (let i = 0; i < (big ? 30 : 10); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 250 + Math.random() * 200;
      this.fire.emit(x, gy + 10, z, Math.cos(a) * sp, 120 + Math.random() * 200, Math.sin(a) * sp, spark, 6, 0.6, { drag: 1.2, rise: -500 });
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
    const mine = !!this.focus && Math.hypot(this.focus.x - x, this.focus.y - z) < 60;
    this.effects.push({ mesh: flash, life: 0.37, max: 0.37, kind: 'flash', radius, mine });
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

  // The lightning ring and arcs carry the shock; a spray of small, fast sparks adds the crackle.
  shock(x, z, radius) {
    const gy = this.items.ground(x, z);
    this.items.shock(x, z, radius);
    this.ring(x, z, 0xffffff, radius * 0.7, 0.3);
    for (let i = 0; i < (MOBILE ? 16 : 36); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = radius * (2.2 + Math.random() * 1.4);
      this.fire.emit(x, gy + 8 + Math.random() * 16, z, Math.cos(a) * sp, 20 + Math.random() * 80, Math.sin(a) * sp, i % 3 ? this.colElectric : this.colSnow, 3 + Math.random() * 1.5, 0.3, { drag: 4, rise: -200 });
    }
    this.shake(x, z, 10);
  }

  // A shield (or the item trailing behind a kart, kind 'trail') soaked up a hit.
  block(x, z, kind) {
    const gy = this.items.ground(x, z);
    const col = kind === 'trail' ? this.colOrange : this.colBlue;
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.3) * Math.PI;
      this.fire.emit(x + Math.cos(a) * 28, gy + 14 + Math.sin(e) * 20, z + Math.sin(a) * 28, Math.cos(a) * 160, 40, Math.sin(a) * 160, col, 8, 0.4, { drag: 3 });
    }
    this.ring(x, z, kind === 'trail' ? 0xffb347 : 0x93c5fd, 70, 0.3);
  }

  // A frozen kart got hit: the ice flies off it.
  shatter(x, z) { this.items.shatter(x, z); this.shake(x, z, 8); }

  // Aiming a bomb: show where it will land (null hides it).
  setAim(aim) { this.items?.setAim?.(aim); }

  // Two karts bumped: a burst of hot sparks where they touched (bigger and brighter for a ram).
  bumpFx(x, z, power, ram) {
    const gy = this.items.ground(x, z);
    const n = Math.round((MOBILE ? 8 : 16) * (0.4 + power) * (ram ? 1.6 : 1));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 220 * (0.5 + power);
      this.fire.emit(x, gy + 10 + Math.random() * 10, z, Math.cos(a) * sp, 60 + Math.random() * 140, Math.sin(a) * sp, i % 3 ? this.colOrange : this.colSnow, 3 + Math.random() * 2, 0.35, { drag: 3, rise: -400 });
    }
    if (ram) this.ring(x, z, 0xffb347, 60, 0.25);
    this.shake(x, z, ram ? 9 : 3 + 5 * power);
  }

  sparkle(x, z, y) {
    const cols = [0xfacc15, 0xec4899, 0x3b82f6, 0x22c55e].map((c) => new THREE.Color(c));
    const gy = y === undefined ? this.groundAt(x, z) + 20 : y;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 120;
      this.fire.emit(x, gy, z, Math.cos(a) * sp, 60 + Math.random() * 120, Math.sin(a) * sp, cols[i % 4], 9, 0.5, { drag: 2, rise: -200 });
    }
  }

  // Thunder bolts on every victim, aimed where each kart is drawn (remote karts are drawn a little
  // in the past, my own a little ahead of the server); `fallback`: idx -> [x, z] for karts not drawn yet.
  thunderHit(idxs, fallback = new Map()) {
    const list = [];
    for (const idx of idxs) {
      const k = this.lastKarts.get(idx);
      const p = k ? [k.x, k.y] : fallback.get(idx);
      if (p) list.push({ x: p[0], z: p[1], idx });
    }
    this.thunder(list);
  }

  // list: [{ x, z, idx? }]
  thunder(list) {
    this.items.thunder(list);
    if (this.focus) this.shakeAmt = Math.max(this.shakeAmt, 8);
  }

  inkBurst(idx, hit) {
    this.items.inkBurst(this.lastKarts.get(idx), hit.map((i) => this.lastKarts.get(i)).filter(Boolean));
  }

  itemUsed(idx, item) {
    this.items.used(this.lastKarts.get(idx), item);
  }

  ring(x, z, color, radius, life) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(x, this.groundY(x, z) + 3, z);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, life, max: life, kind: 'ring', radius });
  }

  respawnBeam(x, z) {
    // A ring on the ground, rising sparkles and a short glow column that stays below the chase
    // camera's eye and fades away when the camera is close, so it never whites out your own view.
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
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(18, 24, 62, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9be7ff, map: this.beamTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.set(x, y + 31, z);
    this.ring(x, z, 0x9be7ff, 56, 0.6);
    this.scene.add(beam);
    this.effects.push({ mesh: beam, life: 0.8, max: 0.8, kind: 'beam' });
    const col = new THREE.Color(0x9be7ff);
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 18 + Math.random() * 10;
      this.fire.emit(x + Math.cos(a) * r, y + 4, z + Math.sin(a) * r, Math.cos(a) * 10, 70 + Math.random() * 90, Math.sin(a) * 10, col, 5, 0.6 + Math.random() * 0.3, { drag: 1 });
    }
  }

  // Off the road into water, lava or a gap (kind from the server event or the snapshot fx bits).
  fallFx(x, z, kind, y) {
    const gy = y === undefined ? this.groundAt(x, z) : y;
    if (kind === 'water') {
      // Fast, small droplets that fall back, a low mist and foam rings that linger on the surface.
      for (let i = 0; i < 90; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * 220;
        this.smoke.emit(x, gy + 4, z, Math.cos(a) * sp * 0.6, 260 + Math.random() * 420, Math.sin(a) * sp * 0.6, this.colSplash, 3 + Math.random() * 3, 0.6, { alpha: 0.9, drag: 0.4, rise: -1200 });
      }
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        this.smoke.emit(x + Math.cos(a) * 20, gy + 6, z + Math.sin(a) * 20, Math.cos(a) * 70, 10, Math.sin(a) * 70, this.colSplash, 22, 1.1, { alpha: 0.22, grow: 2.4, drag: 2 });
      }
      this.ring(x, z, 0xdff6ff, 170, 1.5);
      this.ring(x, z, 0xffffff, 100, 1.2);
    } else if (kind === 'lava') {
      // A burst of flame and embers with a short, light orange-grey puff: never a big dark disc.
      for (let i = 0; i < 46; i++) {
        const a = Math.random() * Math.PI * 2;
        this.fire.emit(x + Math.cos(a) * 18, gy, z + Math.sin(a) * 18, Math.cos(a) * 70, 220 + Math.random() * 300, Math.sin(a) * 70, this.colEmber, 6 + Math.random() * 6, 0.9, { grow: 1.2, drag: 1.2, rise: -250 });
      }
      const puff = new THREE.Color(0x9a6a52);
      for (let i = 0; i < 10; i++) this.smoke.emit(x + (Math.random() - 0.5) * 40, gy + 12, z + (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 90, 120 + Math.random() * 80, (Math.random() - 0.5) * 90, puff, 15, 0.9, { alpha: 0.35, grow: 1.8, rise: 80 });
      this.ring(x, z, 0xff8a3d, 120, 0.7);
    } else {
      // A gap: a puff of dust (desert canyon) or a burst of neon sparks (city).
      const col = this.theme.night ? new THREE.Color(0xff4fd8) : new THREE.Color(0xd9b68a);
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 80 + Math.random() * 120;
        (this.theme.night ? this.fire : this.smoke).emit(x, gy - 20, z, Math.cos(a) * sp, 60 + Math.random() * 120, Math.sin(a) * sp, col, this.theme.night ? 8 : 24, 0.9, { alpha: 0.7, grow: 1.5, drag: 1.5 });
      }
    }
  }

  // Dust kicked up by wheels, in the colour of the ground: ash on the volcano, sand on the desert
  // and beach, earth on grass, snow on ice, a violet haze on neon streets.
  dustColor() {
    if (!this.dustCol) {
      const byTheme = { desert: 0xd9b68a, coast: 0xe8d5a8, meadow: 0x9c8a62, snow: 0xffffff, neon: 0x9d8cff, lava: 0x4a403b, volcano: 0x4a403b };
      this.dustCol = new THREE.Color(byTheme[this.map.theme] ?? (this.theme.snowfall ? 0xffffff : this.theme.night ? 0x9d8cff : 0xc8b48a));
    }
    return this.dustCol;
  }

  // Touchdown after a jump: dust under the wheels, sparkles if a trick paid out.
  landFx(x, z, y, strength, trick) {
    const dust = this.dustColor();
    for (let i = 0; i < 4 + strength * 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 110 * strength;
      this.smoke.emit(x + Math.cos(a) * 14, y + 3, z + Math.sin(a) * 14, Math.cos(a) * sp, 20 + Math.random() * 40, Math.sin(a) * sp, dust, 8 + strength * 12, 0.6, { alpha: 0.5, grow: 2, drag: 2.5 });
    }
    // Volcanic ground throws a few embers too.
    if (this.map.theme === 'lava' || this.map.theme === 'volcano') {
      for (let i = 0; i < 4 + strength * 6; i++) {
        const a = Math.random() * Math.PI * 2;
        this.fire.emit(x + Math.cos(a) * 10, y + 4, z + Math.sin(a) * 10, Math.cos(a) * 60, 90 + Math.random() * 120, Math.sin(a) * 60, this.colEmber, 4, 0.6, { drag: 1, rise: -300 });
      }
    }
    if (trick) this.sparkle(x, z, y + 16);
  }

  addSkid(x, z, quat, y) {
    this.tmpQ.copy(quat).multiply(this.skidTurn);
    this.tmpM.compose(new THREE.Vector3(x, y + 1.0, z), this.tmpQ, this.tmpV);
    this.skids.setMatrixAt(this.skidIdx, this.tmpM);
    this.skidIdx = (this.skidIdx + 1) % this.skidMax;
    this.skids.instanceMatrix.needsUpdate = true;
  }

  updateEffects(dt) {
    this.effects = this.effects.filter((e) => {
      e.life -= dt;
      const p = 1 - e.life / e.max;
      if (e.kind === 'beam') {
        const near = Math.max(0, Math.min(1, (this.camera.position.distanceTo(e.mesh.position) - 110) / 140));
        e.mesh.material.opacity = 0.28 * near * (1 - p);
        e.mesh.scale.set(1 - p * 0.6, 1, 1 - p * 0.6);
      } else if (e.kind === 'flash') {
        // Never bigger than half the camera distance, and toned down when it's the kart you follow.
        const age = e.max - e.life;
        const k = e.mine ? 0.4 : 1;
        const cap = this.camera.position.distanceTo(e.mesh.position) * 0.5;
        e.mesh.scale.setScalar(Math.max(0.01, Math.min(Math.min(1, age / 0.12) * e.radius * 2.2, cap) * k));
        e.mesh.material.opacity = Math.max(0, 1 - age / e.max) * k;
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
    const gy = this.camGround === null ? 0 : this.camGround;
    if (this.theme.snowfall) {
      for (let i = 0; i < (MOBILE ? 2 : 5); i++) {
        this.smoke.emit(c.x + (Math.random() - 0.5) * 1400, gy + 350 + Math.random() * 200, c.z + (Math.random() - 0.5) * 1400,
          (Math.random() - 0.5) * 30, -70 - Math.random() * 40, (Math.random() - 0.5) * 30, this.colSnow, 3 + Math.random() * 3, 6, { alpha: 0.9, drag: 0 });
      }
    }
    if (this.theme.embers) {
      for (let i = 0; i < 2; i++) {
        this.fire.emit(c.x + (Math.random() - 0.5) * 1600, gy + Math.random() * 40, c.z + (Math.random() - 0.5) * 1600,
          (Math.random() - 0.5) * 20, 40 + Math.random() * 60, (Math.random() - 0.5) * 20, this.colEmber, 3 + Math.random() * 3, 4, { drag: 0.2 });
      }
    }
    if (this.theme.ash) {
      // Grey ash drifting down from the volcano.
      for (let i = 0; i < (MOBILE ? 1 : 3); i++) {
        this.smoke.emit(c.x + (Math.random() - 0.5) * 1500, gy + 300 + Math.random() * 250, c.z + (Math.random() - 0.5) * 1500,
          20 + Math.random() * 30, -45 - Math.random() * 30, (Math.random() - 0.5) * 30, this.colAsh, 3 + Math.random() * 3, 7, { alpha: 0.8, drag: 0 });
      }
    }
    // Smoke rising from the crater.
    for (const v of this.ctx.vents) {
      if (Math.random() < (MOBILE ? 0.3 : 0.7)) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * v.r;
        this.smoke.emit(v.x + Math.cos(a) * r, v.y, v.z + Math.sin(a) * r, 20 + Math.random() * 20, 90 + Math.random() * 60, (Math.random() - 0.5) * 20,
          new THREE.Color(0x3a302c), 160 + Math.random() * 120, 9, { alpha: 0.5, grow: 1.25, drag: 0.1, rise: 6 });
      }
    }
  }

  // view: { karts:[{idx,x,y,angle,speed,flags,hp,air,fx,item,ammo,roulette}], shots:[[id,kind,x,y,a,prog,...]], mines:[[id,x,y,armed]],
  //         bananas:[[id,x,y]], boxes:[0|1], myIdx, countdown,
  //         focus: {idx,x,y,angle,air,spinning,boost,star,grid,snap} }
  update(view, dt, now) {
    const t = now / 1000;
    const flameCol = [new THREE.Color(0xffe066), new THREE.Color(0xff8c1a), new THREE.Color(0xff4d00)];
    const smokeCol = new THREE.Color(this.theme.night ? 0x4a4560 : 0x9aa0aa);
    const dustCol = this.dustColor();

    // Karts
    const seen = new Set();
    for (const k of view.karts) {
      const kart = this.karts.get(k.idx);
      if (!kart) continue;
      seen.add(k.idx);
      const dead = k.flags & 32;
      const fx = k.fx || 0;
      const blink = (k.flags & 16) && !(k.flags & 1) && !(k.flags & 4) && Math.floor(now / 90) % 2;
      kart.group.visible = !dead && !blink;
      if (dead) { kart.lastAngle = null; kart.wasDead = true; this.items.releaseKart(kart); continue; }
      this.lastKarts.set(k.idx, k);
      if (kart.wasDead) { kart.wasDead = false; this.respawnBeam(k.x, k.y); }
      // Fell off: sink into the water/lava (or drop into the gap), then wait to be fished out.
      if (fx & 1) {
        if (!kart.falling) {
          kart.falling = true;
          kart.fallT = 0;
          kart.fallY = kart.lastY === null ? this.groundAt(k.x, k.y, kart) : kart.lastY;
          this.fallFx(k.x, k.y, fx & 4 ? 'lava' : fx & 8 ? 'water' : 'void', kart.fallY);
        }
        kart.fallT += dt;
        const p = Math.min(1, kart.fallT / 0.6);
        kart.group.position.set(k.x, kart.fallY - p * p * (fx & 12 ? 50 : 220), k.y);
        kart.chassis.rotation.z += dt * (fx & 12 ? 1.5 : 5);
        kart.group.visible = kart.fallT < 0.6;
        kart.lastAngle = null;
        kart.lastY = null;
        continue;
      }
      if (kart.falling) { kart.falling = false; kart.chassis.rotation.set(0, 0, 0); kart.prevAir = 0; this.respawnBeam(k.x, k.y); }
      kart.group.visible = !blink;
      setLook(kart, !!(k.flags & 1024), !!(k.flags & 4096));
      const drifting = k.flags & 64;
      const driftDir = k.flags & 512 ? -1 : 1;
      const driftLevel = k.flags & 256 ? 2 : k.flags & 128 ? 1 : 0;
      // Drifting karts point their nose further into the turn.
      kart.slide += ((drifting ? driftDir * 0.42 : 0) - kart.slide) * Math.min(1, dt * 8);
      const cos = Math.cos(k.angle);
      const sin = Math.sin(k.angle);

      // Height: the ground under the kart plus any air. Pitch and roll follow the slope under the
      // wheels; in the air the nose follows the flight path instead.
      const air = k.air || 0;
      const ground = this.groundAt(k.x, k.y, kart);
      const y = ground + air;
      const airborne = air > 1;
      let pitch = 0;
      let roll = 0;
      if (!this.arena) {
        const hF = this.groundAt(k.x + cos * 18, k.y + sin * 18, kart);
        const hB = this.groundAt(k.x - cos * 18, k.y - sin * 18, kart);
        const hP = this.groundAt(k.x - sin * 12, k.y + cos * 12, kart);
        const hM = this.groundAt(k.x + sin * 12, k.y - cos * 12, kart);
        pitch = Math.atan2(hF - hB, 36);
        roll = Math.atan2(hM - hP, 24);
      }
      if (kart.lastY !== null && dt > 0) kart.vy += ((y - kart.lastY) / dt - kart.vy) * Math.min(1, dt * 10);
      kart.lastY = y;
      if (airborne) {
        // Big jumps follow the flight path; a little hop stays nearly level.
        pitch = Math.max(-0.55, Math.min(0.5, Math.atan2(kart.vy, Math.max(200, Math.abs(k.speed))) * 0.9)) * Math.min(1, air / 70 + 0.15);
        roll = 0;
      }
      kart.pitch += (pitch - kart.pitch) * Math.min(1, dt * (airborne ? 6 : 16));
      kart.roll += (roll - kart.roll) * Math.min(1, dt * 16);
      // Touchdown: squash and a puff of dust (sparkles when a trick pays out).
      if (!airborne && kart.prevAir > 10) {
        kart.squash = 1;
        this.landFx(k.x, k.y, ground, Math.min(1, kart.prevAir / 80), kart.tricked);
        kart.tricked = false;
      }
      kart.prevAir = air;

      // Getting hit in a race: the kart pops up and does a flip.
      const spinNow = !!(k.flags & 1);
      if (spinNow && !kart.wasSpin) kart.hop = 0.8;
      kart.wasSpin = spinNow;
      let hopY = 0;
      if (kart.hop > 0) {
        kart.hop = Math.max(0, kart.hop - dt);
        const p = 1 - kart.hop / 0.8;
        hopY = Math.sin(p * Math.PI) * 30;
        kart.chassis.rotation.z = p * Math.PI * 2;
      } else {
        kart.chassis.rotation.z = 0;
      }
      // Tricks: a barrel roll off the ramp.
      const trickNow = !!(fx & 2);
      if (trickNow && !kart.wasTrick) {
        kart.trickT = 0;
        kart.trickDir = -kart.trickDir;
        kart.tricked = true;
        this.sparkle(k.x, k.y, y + 20);
      }
      kart.wasTrick = trickNow;
      let trick = 0;
      if (kart.trickT >= 0) {
        kart.trickT += dt;
        const p = Math.min(1, kart.trickT / 0.45);
        trick = kart.trickDir * Math.PI * 2 * (1 - (1 - p) ** 3);
        if (p >= 1) { kart.trickT = -1; trick = 0; }
      }
      const sq = kart.squash > 0 ? Math.sin(kart.squash * Math.PI) : 0;
      if (kart.squash > 0) kart.squash = Math.max(0, kart.squash - dt * 3.4);
      // (Scale is set after the item visuals below: thunder shrink times the landing squash.)
      // Roll the trick about the kart's middle, not its wheels.
      const a2 = k.angle + kart.slide;
      const ts = Math.sin(trick) * 14;
      kart.group.position.set(k.x + ts * Math.sin(a2), y + hopY + 14 * (1 - Math.cos(trick)), k.y - ts * Math.cos(a2));
      kart.group.rotation.set(kart.roll + trick, -a2, kart.pitch, 'YZX');

      // Visual steering estimate from heading change.
      let dAng = kart.lastAngle === null ? 0 : k.angle - kart.lastAngle;
      dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
      kart.lastAngle = k.angle;
      const turnRate = dt > 0 ? dAng / dt : 0;
      const spinning = k.flags & 1;
      const targetSteer = spinning ? 0 : Math.max(-1, Math.min(1, turnRate / 2.5));
      kart.steer += (targetSteer - kart.steer) * Math.min(1, dt * 10);
      kart.chassis.rotation.x = -kart.steer * 0.12 * Math.min(1, Math.abs(k.speed) / 300);
      kart.chassis.position.y = airborne ? 0 : Math.sin(t * 18 + k.idx) * 0.35 * Math.min(1, Math.abs(k.speed) / 200);
      for (const w of kart.wheels) {
        w.spin.rotation.z -= (k.speed * dt) / w.r;
        if (w.front) w.pivot.rotation.y = -kart.steer * 0.45;
        // Suspension: wheels drop a little in the air.
        w.pivot.position.y = w.r - (airborne ? 3 : 0);
      }

      const near = this.camera.position.distanceTo(kart.group.position) < 1100;
      if (near !== kart.near) { kart.near = near; for (const m of kart.details) m.visible = near; }
      if (kart.halo) kart.halo.rotation.y = t;
      if (k.hp < kart.lastHp) kart.hitAt = t;
      kart.lastHp = k.hp;
      const boosting = k.flags & 2;
      for (const f of kart.flames) {
        f.visible = !!boosting;
        if (boosting) f.scale.set(0.8 + Math.random() * 0.9, 0.85 + Math.random() * 0.3, 0.85 + Math.random() * 0.3);
      }
      kart.shield.visible = !!(k.flags & 4);
      if (kart.shield.visible) kart.shield.scale.set(1 + Math.sin(t * 8) * 0.04, 1 + Math.sin(t * 8 + 1) * 0.04, 1 + Math.sin(t * 8 + 2) * 0.04);
      this.items.kart(kart, k, dt, t, k.idx === view.myIdx);
      const shrink = kart.fx ? kart.fx.scale : 1;
      kart.group.scale.set(shrink * (1 + 0.13 * sq), shrink * (1 - 0.26 * sq), shrink * (1 + 0.13 * sq));

      // Minigun muzzle flash.
      if (k.flags & 2048) {
        for (let i = 0; i < 2; i++) {
          this.fire.emit(k.x + cos * 30, y + 12, k.y + sin * 30, cos * 200 + (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 40, sin * 200 + (Math.random() - 0.5) * 80,
            flameCol[i], 9, 0.08, { drag: 4 });
        }
      }
      // Exhaust: flames when boosting, light smoke otherwise; sparks and skids when drifting.
      const ex = k.x - cos * 26;
      const ez = k.y - sin * 26;
      if (boosting) {
        for (let i = 0; i < 3; i++) {
          this.fire.emit(ex + (Math.random() - 0.5) * 8, y + 8, ez + (Math.random() - 0.5) * 8,
            -cos * 120 + (Math.random() - 0.5) * 40, 20, -sin * 120 + (Math.random() - 0.5) * 40,
            flameCol[i], 14, 0.25, { grow: 0.3, drag: 3 });
        }
      } else if (Math.abs(k.speed) > 40) {
        kart.smoke -= dt;
        if (kart.smoke <= 0) {
          kart.smoke = 0.09;
          this.smoke.emit(ex, y + 8, ez, -cos * 30, 18, -sin * 30, smokeCol, 7, 0.6, { alpha: 0.35, grow: 2.2, drag: 1 });
        }
      }
      if (drifting && !airborne) {
        const sparkCol = driftLevel === 2 ? this.colOrange : driftLevel === 1 ? this.colBlue : this.colWhite;
        for (const side of [1, -1]) {
          const wx = k.x - cos * 13 - sin * 15 * side;
          const wz = k.y - sin * 13 + cos * 15 * side;
          this.addSkid(wx, wz, kart.group.quaternion, ground);
          const n = driftLevel ? 3 : 1;
          for (let i = 0; i < n; i++) {
            this.fire.emit(wx, y + 3, wz, -cos * 60 + (Math.random() - 0.5) * 120, 40 + Math.random() * 90, -sin * 60 + (Math.random() - 0.5) * 120,
              sparkCol, driftLevel ? 7 : 5, 0.25, { drag: 2, rise: -400 });
          }
        }
      } else if (!spinning && !airborne && Math.abs(kart.steer) > 0.6 && Math.abs(k.speed) > 320) {
        for (const side of [1, -1]) {
          this.smoke.emit(k.x - cos * 14 - sin * 14 * side, y + 3, k.y - sin * 14 + cos * 14 * side, 0, 10, 0,
            dustCol, 9, 0.7, { alpha: 0.4, grow: 2, drag: 1 });
        }
      }
      if (spinning) {
        const a = t * 12;
        this.fire.emit(k.x + Math.cos(a) * 14, y + 34, k.y + Math.sin(a) * 14, 0, 0, 0, new THREE.Color(0xfff27a), 8, 0.3);
      }
    }
    for (const [idx, kart] of this.karts) if (!seen.has(idx)) kart.group.visible = false;

    this.items.update(view, dt, t, now);

    // Scenery animation
    const c = this.ctx;
    c.uniforms.uTime.value = t;
    for (const s of c.spinners) { s.rotation.y = t * 0.8; s.rotation.x = t * 0.5; }
    for (const p of c.pads) p.material.map.offset.y = (t * 1.5) % 1;
    for (const l of c.lava) { l.offset.x = Math.sin(t * 0.2) * 0.1; l.offset.y = (t * 0.03) % 1; }
    for (const w of c.water) { w.offset.x = (t * 0.012) % 1; w.offset.y = (t * 0.007) % 1; }
    for (const b of c.beams) b.rotation.y = t * 0.9;
    c.flags.forEach((f, i) => { f.rotation.y = Math.sin(t * 3 + i) * 0.35; });
    if (c.clouds) c.clouds.update(dt);
    if (c.volcanoGlow) c.volcanoGlow.material.color.setHSL(0.04, 1, 0.5 + Math.sin(t * 2) * 0.08);
    this.ambient(dt);

    this.fire.update(dt);
    this.smoke.update(dt);
    this.updateEffects(dt);
    this.updateDebris(dt);
    this.updateCamera(view.focus, dt, t);
    this.updateLabels(view, dt, t);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    if (this.warm) { this.items.coolDown(this.warm); this.warm = null; }
  }

  // Name tags, laid out in screen space after the camera has moved:
  // - only karts that are drawn, in front of the camera and 110-750 units away (fading from 550),
  //   never during the countdown, at most 8, nearest first;
  // - sized like the kart would be, but kept between a readable minimum and a modest maximum;
  // - a tag that would overlap a nearer one is lifted one tag height, or faded out if still blocked;
  // - arena health bars show while hurt or within 3 s of a hit, and take part in the overlap test.
  updateLabels(view, dt, t) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const W = this.viewW;
    const H = this.viewH;
    const unit = (cam.projectionMatrix.elements[5] * H) / 2; // CSS px per sprite scale unit
    const maxPx = Math.min(MOBILE ? 116 : 136, W * 0.24);
    const minPx = Math.min(maxPx, MOBILE ? 84 : 92);
    const v = this.tmpLabelV || (this.tmpLabelV = new THREE.Vector3());
    const cands = [];
    for (const k of view.karts) {
      const kart = this.karts.get(k.idx);
      if (!kart?.label) continue;
      kart.tagWant = false;
      if (view.countdown || !kart.group.visible || kart.fade < 1 || k.flags & 32) continue;
      v.set(k.x, kart.group.position.y + LABEL_TOP, k.y);
      const d = v.distanceTo(cam.position);
      if (d < 110 || d > 750) continue;
      v.applyMatrix4(cam.matrixWorldInverse);
      if (v.z > -20) continue; // behind the camera
      const z = -v.z;
      v.applyMatrix4(cam.projectionMatrix);
      const sx = ((v.x + 1) / 2) * W;
      const sy = ((1 - v.y) / 2) * H;
      const px = Math.max(minPx, Math.min(maxPx, (LABEL_W * unit) / z));
      const edge = (px * kart.label.pill) / 2 + 4; // whole tags only, never cut by the screen edge
      if (sx < edge || sx > W - edge || sy < px * 0.3 || sy > H) continue;
      const hp = this.arena && (k.hp < 100 || t - kart.hitAt < 3) ? k.hp : null;
      // Tags already on screen keep their place a little longer, so two karts side by side don't
      // keep swapping which one is shown.
      cands.push({ kart, d, sx, sy, px, hp, rank: d * (kart.tagOn ? 0.85 : 1) });
    }
    cands.sort((a, b) => a.rank - b.rank);
    const placed = [];
    const hits = (r) => placed.some((p) => r.l < p.r && r.r > p.l && r.t < p.b && r.b > p.t);
    for (const c of cands.slice(0, 8)) {
      const half = (c.px * c.kart.label.pill) / 2 + 3;
      const rect = (lift) => ({
        l: c.sx - half, r: c.sx + half,
        t: c.sy - lift - (c.px * 60) / 256, b: c.sy - lift + (c.px * (c.hp === null ? -8 : 14)) / 256,
      });
      const step = (c.px * 50) / 256 + 2;
      for (const lift of [0, step]) {
        const r = rect(lift);
        if (hits(r)) continue;
        placed.push(r);
        c.kart.tagWant = true;
        c.lift = lift;
        break;
      }
      c.kart.tagPx = c.px;
      c.kart.tagHp = c.hp;
      c.kart.tagD = c.d;
      if (c.kart.tagWant) c.kart.tagLiftTo = c.lift;
    }
    for (const kart of this.karts.values()) {
      const label = kart.label;
      if (!label) continue;
      kart.tagOn = !!kart.tagWant;
      if (kart.tagAlpha <= 0) kart.tagLift = kart.tagLiftTo || 0; // a tag appears in place, then glides
      kart.tagAlpha = Math.max(0, Math.min(1, kart.tagAlpha + (kart.tagWant ? dt : -dt) / 0.15));
      const gone = !kart.group.visible || kart.fade < 1 || view.countdown;
      if (kart.tagAlpha <= 0 || gone || kart.tagPx === undefined) { label.sprite.visible = false; if (gone) kart.tagAlpha = 0; continue; }
      label.sprite.visible = true;
      label.draw(kart.tagHp);
      kart.tagLift += ((kart.tagLiftTo || 0) - kart.tagLift) * Math.min(1, dt * 14);
      label.layout(kart.tagPx, unit, kart.tagLift);
      label.sprite.material.opacity = kart.tagAlpha * Math.min(1, (750 - kart.tagD) / 200);
    }
  }

  updateCamera(focus, dt, t) {
    // A kart that teleported (fished out of the water, respawned) gets the camera snapped behind it.
    if (focus && this.focus && Math.hypot(focus.x - this.focus.x, focus.y - this.focus.y) > 400) focus = { ...focus, snap: true };
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
      const pose = (a, b) => (key) => a[key] + (b[key] - a[key]) * this.tall;
      const chase = pose(this.arena ? CAM.arena : CAM.race, CAM.portrait);
      const grid = pose(CAM.grid, CAM.portraitGrid);
      const mix = (key) => chase(key) + (grid(key) - chase(key)) * this.gridMix;
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
      // Aim so the kart keeps its usual height on screen, even when the camera is pulled in and
      // lifted: the look-ahead shrinks with the pull-in instead of pitching your kart off the bottom.
      let ahead = mix('look');
      if (this.camDist < back - 1) {
        const usual = Math.atan2(mix('up') - KART_MID, back) - Math.atan2(mix('up') - mix('at'), back + ahead);
        const pitch = Math.atan2(camUp - KART_MID, this.camDist) - usual;
        if (pitch > 0.05) ahead = Math.max(10, (camUp - mix('at')) / Math.tan(pitch) - this.camDist);
      }
      // Heights: the camera rides along with the kart, lagging a little on jumps so they feel big.
      const fy = this.groundAt(focus.x, focus.y, this.camHint) + (focus.air || 0);
      this.camY = this.camY === undefined || focus.snap ? fy : this.camY + (fy - this.camY) * Math.min(1, dt * 7);
      const desired = new THREE.Vector3(focus.x - ch * this.camDist, this.camY + camUp, focus.y - sh * this.camDist);
      const look = new THREE.Vector3(focus.x + ch * ahead, this.camY + mix('at') + (fy - this.camY) * 0.7, focus.y + sh * ahead);
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
      // ...nor sink into the hillside behind it (grid cam, chase cam and death cam alike).
      this.camGround = this.groundAt(this.camPos.x, this.camPos.z, this.camHint2 || (this.camHint2 = { hint: null }));
      if (this.camPos.y < this.camGround + 28) this.camPos.y = this.camGround + 28;
      // Aim for about 74 degrees of horizontal view. Portrait phones can't have that without a
      // fish-eye, so their vertical view tops out at 100 degrees (about 60 across on a phone).
      // Boosts and star power widen it.
      const base = Math.max(62, Math.min(88 + 12 * this.tall, (2 * Math.atan(Math.tan((37 * Math.PI) / 180) / this.camera.aspect) * 180) / Math.PI));
      const fov = base + (focus.boost ? 10 - 4 * this.tall : focus.star ? 6 : 0);
      this.camera.fov = focus.snap ? fov : this.camera.fov + (fov - this.camera.fov) * Math.min(1, dt * (fov > this.camera.fov ? 7 : 3));
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this.camPos);
      if (this.shakeAmt > 0.01) {
        this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt;
        this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt;
        this.shakeAmt *= Math.exp(-dt * 6);
      }
      this.camera.lookAt(this.camLook);
      // The shadow camera follows the player.
      this.sun.position.set(focus.x + 450, fy + 900, focus.y + 300);
      this.sun.target.position.set(focus.x, fy, focus.y);
    } else {
      const [cx, cz] = this.map.center;
      if (this.topY === undefined) this.topY = this.arena ? 0 : Math.max(...this.map.heights);
      this.camera.position.set(cx + Math.cos(t * 0.1) * 2600, this.topY + 1700, cz + Math.sin(t * 0.1) * 2600);
      this.camera.lookAt(cx, this.topY * 0.5, cz);
      this.camGround = this.topY;
      this.sun.position.set(cx + 450, this.topY + 900, cz + 300);
      this.sun.target.position.set(cx, 0, cz);
    }
    this.sky.position.copy(this.camera.position);
    // Rivals right next to the lens would fill the screen, and one sitting on the line between the
    // camera and your kart would hide it: they fade out (about 0.15 s) instead of popping.
    const cp = this.camera.position;
    const fx = focus ? focus.x - cp.x : 0;
    const fz = focus ? focus.y - cp.z : 0;
    const fd2 = fx * fx + fz * fz;
    for (const [idx, kart] of this.karts) {
      let clear = true;
      if (idx !== focus?.idx) {
        const p = kart.group.position;
        const dx = p.x - cp.x;
        const dz = p.z - cp.z;
        const along = fd2 > 0 ? (dx * fx + dz * fz) / fd2 : 1;
        clear = dx * dx + (p.y - cp.y) ** 2 + dz * dz >= 70 * 70
          && !(along > 0 && along < 0.8 && Math.abs(dx * fz - dz * fx) / Math.sqrt(fd2) < 24);
      }
      kart.fade = focus?.snap ? +clear : Math.max(0, Math.min(1, kart.fade + (clear ? dt : -dt) / 0.15));
      if (kart.fade <= 0) kart.group.visible = false;
      applyLook(kart);
    }
  }

  dispose() {
    this.resizeObserver.disconnect();
    for (const k of this.karts.values()) this.items.releaseKart(k);
    this.items.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    // Name tags hold a font-reload hook in a module-level set: drop them, or the whole scene stays alive.
    for (const k of this.karts.values()) { k.label?.dispose(); k.fadeMat?.dispose(); }
    this.karts.clear();
    // Per-game geometry and materials are freed; cached textures, trees and kart parts are kept for the next game.
    this.scene.traverse((o) => {
      if (o.geometry && !o.isInstancedMesh) o.geometry.dispose();
    });
  }
}

window.Kart3D = Kart3D;
window.dispatchEvent(new Event('kart3d-ready'));
