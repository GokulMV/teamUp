// 3D view for Ball & Chain (Three.js). Game logic lives on the server and in ballchain.js; this
// module only draws what it is given: the course (ballchain3d/course.js), the stick figures
// (ballchain3d/figures.js), the balls, the ropes, particles and the chase camera.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MOBILE, canvasTexture, tex as kartTex } from './kart3d/world.js';
import { buildCourse, buildSky, buildClouds, THEMES } from './ballchain3d/course.js';
import { Figures, nameTag } from './ballchain3d/figures.js';

const BC = window.BallChainCore;
const R = BC.PHYS.ballR;

// ---------- particles: one additive cloud (sparks) and one normal (dust, clouds, confetti) ----------
class Particles {
  constructor(scene, max, additive, map) {
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
    this.grav = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; varying vec3 vColor; varying float vAlpha; uniform float scale;
        void main() { vColor = color; vAlpha = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec3 vColor; varying float vAlpha;
        void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vColor * (0.85 + 0.15 * t.r), t.a * vAlpha); }`,
      vertexColors: true, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, color, size, life, o = {}) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.alpha[i] = o.alpha ?? 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = o.grow ?? 1;
    this.drag[i] = o.drag ?? 1.5;
    this.grav[i] = o.grav ?? 0;
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.count;
        if (i !== last) {
          for (const a of [this.pos, this.vel, this.col]) a.copyWithin(i * 3, last * 3, last * 3 + 3);
          for (const a of [this.size, this.alpha, this.life, this.maxLife, this.grow, this.drag, this.grav]) a[i] = a[last];
        }
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] *= 1 + (this.grow[i] - 1) * dt;
      this.alpha[i] = Math.min(this.alpha[i], (this.life[i] / this.maxLife[i]) * 1.6);
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    for (const n of ['position', 'color', 'size', 'alpha']) this.geo.attributes[n].needsUpdate = true;
  }
}

// ---------- ropes: a preallocated tube rebuilt along a sagging path every frame ----------
const ROPE_PTS = 30;
const ROPE_RAD = 5;
class Rope {
  constructor(material) {
    const ring = ROPE_RAD + 1;
    this.pos = new Float32Array(ROPE_PTS * ring * 3);
    this.nrm = new Float32Array(ROPE_PTS * ring * 3);
    this.uv = new Float32Array(ROPE_PTS * ring * 2);
    const idx = [];
    for (let i = 0; i < ROPE_PTS - 1; i++) {
      for (let j = 0; j < ROPE_RAD; j++) {
        const a = i * ring + j;
        const b = a + ring;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.pts = Array.from({ length: ROPE_PTS }, () => new THREE.Vector3());
  }

  // Lay the tube along this.pts.
  build(radius) {
    const ring = ROPE_RAD + 1;
    const t = new THREE.Vector3();
    const n = new THREE.Vector3();
    const b = new THREE.Vector3();
    let u = 0;
    for (let i = 0; i < ROPE_PTS; i++) {
      const p = this.pts[i];
      const a = this.pts[Math.max(0, i - 1)];
      const c = this.pts[Math.min(ROPE_PTS - 1, i + 1)];
      t.subVectors(c, a);
      if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
      t.normalize();
      n.set(-t.z, 0, t.x);
      if (n.lengthSq() < 1e-4) n.set(1, 0, 0);
      n.normalize();
      b.crossVectors(t, n);
      if (i > 0) u += p.distanceTo(this.pts[i - 1]) / 16;
      for (let j = 0; j <= ROPE_RAD; j++) {
        const ang = (j / ROPE_RAD) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sx = Math.sin(ang);
        const nx = n.x * cx + b.x * sx;
        const ny = n.y * cx + b.y * sx;
        const nz = n.z * cx + b.z * sx;
        const k = (i * ring + j) * 3;
        this.pos[k] = p.x + nx * radius; this.pos[k + 1] = p.y + ny * radius; this.pos[k + 2] = p.z + nz * radius;
        this.nrm[k] = nx; this.nrm[k + 1] = ny; this.nrm[k + 2] = nz;
        const q = (i * ring + j) * 2;
        this.uv[q] = u; this.uv[q + 1] = j / ROPE_RAD;
      }
    }
    for (const name of ['position', 'normal', 'uv']) this.geo.attributes[name].needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}

function ballTexture(color) {
  return canvasTexture(512, 256, (c, w, h) => {
    const gores = ['team', '#ffffff', 'team', '#ffe27a', 'team', '#ffffff', 'team', '#7fdcff'];
    gores.forEach((g, i) => {
      c.fillStyle = g === 'team' ? color : g;
      c.fillRect((i * w) / gores.length, 0, w / gores.length + 1, h);
    });
    // White caps top and bottom, with a soft shine band.
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h * 0.09);
    c.fillRect(0, h * 0.91, w, h * 0.09);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(0, h * 0.42, w, h * 0.06);
  }, false);
}

function braidTexture(color) {
  return canvasTexture(64, 32, (c, w, h) => {
    c.fillStyle = color; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 6;
    for (let x = -h; x < w + h; x += 16) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + h, h); c.stroke(); }
    c.strokeStyle = 'rgba(0,0,0,0.12)'; c.lineWidth = 2;
    for (let x = -h; x < w + h; x += 16) { c.beginPath(); c.moveTo(x + 8, 0); c.lineTo(x + 8 + h, h); c.stroke(); }
  });
}

const glossy = (o) => new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0, envMapIntensity: 1.4, ...o });

export class BallChain3D {
  constructor(container) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: !MOBILE, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.96;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'bc-canvas';
    renderer.info.autoReset = false; // count draw calls over the whole frame (all post passes)
    container.prepend(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    // A tiny sky panorama for soft reflections on the glossy plastic (cheap to prefilter).
    this.envMap = canvasTexture(128, 64, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#9fd8ff'); g.addColorStop(0.48, '#ffffff'); g.addColorStop(0.56, '#ffe6f2'); g.addColorStop(1, '#ffc9e3');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      const sunG = c.createRadialGradient(w * 0.3, h * 0.22, 0, w * 0.3, h * 0.22, 16);
      sunG.addColorStop(0, 'rgba(255,255,255,1)'); sunG.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sunG; c.fillRect(0, 0, w, h);
    }, false);
    this.envMap.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = this.envMap;
    scene.environmentIntensity = 0.55;

    this.hemi = new THREE.HemisphereLight(0xdff3ff, 0xffc7e0, 1.05);
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -800; sc.right = 800; sc.top = 800; sc.bottom = -800; sc.near = 50; sc.far = 3000;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 1.2;
    sun.shadow.radius = 3;
    this.sun = sun;
    scene.add(sun, sun.target);

    this.camera = new THREE.PerspectiveCamera(46, 1, 5, 40000);
    if (!MOBILE) {
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(scene, this.camera));
      // Only the truly bright bits glow (sparks, plates); the pastel floors must stay crisp.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.16, 0.35, 0.985);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    const spark = kartTex.spark();
    this.sparks = new Particles(scene, 2500, true, spark);
    this.puffs = new Particles(scene, 3000, false, spark);
    this.confettiTex = canvasTexture(32, 32, (c) => { c.fillStyle = '#fff'; c.fillRect(6, 10, 20, 12); }, false);
    this.confetti = new Particles(scene, 2500, false, this.confettiTex);
    this.effects = [];
    this.splashed = new Set();
    this.shakeAmt = 0;
    this.camPos = null;
    this.camLook = new THREE.Vector3();
    this.colors = {
      white: new THREE.Color(0xffffff), gold: new THREE.Color(0xffd84d), pink: new THREE.Color(0xff5d9e),
      cyan: new THREE.Color(0x6ff3ff), dust: new THREE.Color(0xfff3e8), cloud: new THREE.Color(0xffffff),
      confetti: ['#ff5d8f', '#ffd84d', '#5ee38c', '#4cc3ff', '#9b7bff', '#ff9b4c'].map((c) => new THREE.Color(c)),
    };
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
    for (const p of [this.sparks, this.puffs, this.confetti]) p.points.material.uniforms.scale.value = h * 0.9;
  }

  // (Re)build for a course: { C, theme, teams: [{ idx, color }], players: [{ idx, team, color, avatar, name }], myIdx }
  setMatch(m) {
    // Never tear down a scene while its shaders are still compiling.
    if (this.compiling) { this.pendingMatch = m; return; }
    this.clearMatch();
    this.C = m.C;
    this.theme = THEMES[m.theme] || THEMES.candy;
    this.teams = m.teams;
    this.myIdx = m.myIdx;
    this.myTeam = m.players.find((p) => p.idx === m.myIdx)?.team ?? null;
    this.rope = m.rope;
    const T = this.teams.length;
    this.laneXs = this.teams.map((t, i) => (i - (T - 1) / 2) * BC.LANE_SPACING);
    const scene = this.scene;
    scene.background = null;
    scene.fog = new THREE.Fog(this.theme.fog, 3200, 12000);
    this.sky = buildSky(scene, m.theme);
    this.hemi.color.set(0xe6f4ff);
    this.sun.color.set(this.theme.sun);
    this.world = buildCourse(scene, this.C, m.theme, this.laneXs);
    this.H = this.world.H;
    this.clouds = buildClouds(scene, this.C.len, T * BC.LANE_SPACING, m.theme);

    // Balls.
    this.balls = this.teams.map((t) => {
      const map = ballTexture(t.color);
      const mat = glossy({ map, color: 0xffffff });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, MOBILE ? 32 : 48, MOBILE ? 22 : 32), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const ring = new THREE.Mesh(new THREE.RingGeometry(R * 1.05, R * 1.22, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: 0.55, depthWrite: false }));
      ring.renderOrder = 2;
      scene.add(ring);
      const oil = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1d1530, roughness: 0.05, metalness: 0.3, envMapIntensity: 2, transparent: true, opacity: 0.9 }));
      oil.visible = false;
      scene.add(oil);
      return { mesh, ring, oil, mat, q: new THREE.Quaternion(), last: null, heavy: 0, team: t, falling: false };
    });
    // Ropes, one per player, braided in the team colour.
    this.ropeMats = new Map(this.teams.map((t) => [t.idx, new THREE.MeshStandardMaterial({ map: braidTexture(t.color), roughness: 0.75 })]));
    for (const mtl of this.ropeMats.values()) { mtl.map.wrapS = THREE.RepeatWrapping; }
    this.ropes = new Map();
    for (const p of m.players) {
      const rope = new Rope(this.ropeMats.get(p.team));
      scene.add(rope.mesh);
      this.ropes.set(p.idx, rope);
    }
    // Figures and name tags.
    const teamColor = new Map(this.teams.map((t) => [t.idx, t.color]));
    this.figures = new Figures(scene, m.players.map((p) => ({ idx: p.idx, color: p.color, team: p.team, teamColor: teamColor.get(p.team), avatar: p.avatar })), { mobile: MOBILE });
    this.tags = new Map();
    for (const p of m.players) {
      const tag = nameTag(p.name, teamColor.get(p.team), p.avatar || 0, p.idx === m.myIdx);
      scene.add(tag);
      this.tags.set(p.idx, tag);
    }
    // A glowing ring under your own feet.
    this.meRing = new THREE.Mesh(new THREE.RingGeometry(17, 23, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
    this.meRing.renderOrder = 3;
    scene.add(this.meRing);
    this.camPos = null;
    // Compile every shader up front (in parallel where the browser can) while the intro plays.
    this.ready = false;
    const done = () => {
      this.compiling = false;
      if (this.disposeAfterCompile) { this.dispose(); return; }
      this.ready = true;
      if (this.pendingMatch) { const next = this.pendingMatch; this.pendingMatch = null; this.setMatch(next); }
    };
    if (this.renderer.compileAsync) { this.compiling = true; this.renderer.compileAsync(scene, this.camera).then(done, done); } else done();
  }

  clearMatch() {
    if (!this.world) return;
    const scene = this.scene;
    this.world.dispose();
    this.clouds.dispose();
    scene.remove(this.sky);
    this.sky.geometry.dispose();
    for (const b of this.balls) {
      scene.remove(b.mesh, b.ring, b.oil);
      b.mesh.geometry.dispose(); b.mat.map.dispose(); b.mat.dispose();
    }
    for (const r of this.ropes.values()) { scene.remove(r.mesh); r.geo.dispose(); }
    for (const mtl of this.ropeMats.values()) { mtl.map.dispose(); mtl.dispose(); }
    this.figures.dispose();
    for (const t of this.tags.values()) { scene.remove(t); t.material.map.dispose(); t.material.dispose(); }
    scene.remove(this.meRing);
    this.world = null;
  }

  laneX(team) {
    return this.laneXs[team] ?? 0;
  }

  // ---------- effects ----------
  shake(amount) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  ring(x, y, z, color, radius, life) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.effects.push({ mesh, life, max: life, radius });
  }

  world3(team, x, y, lift = 0) {
    return new THREE.Vector3(this.laneX(team) + x, (this.H ? this.H(x, y) : 0) + lift, -y);
  }

  // Event from the server (already filtered to things worth drawing).
  fx(e, info) {
    if (!this.world) return;
    const C = this.colors;
    if (e.type === 'sync' || e.type === 'launch') {
      const p = this.world3(e.team, e.x, e.y, R);
      const k = e.k || 2;
      for (let i = 0; i < 26 + k * 14; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 160 + Math.random() * 220 + k * 30;
        this.sparks.emit(p.x, p.y, p.z, Math.cos(a) * sp, 80 + Math.random() * 260, Math.sin(a) * sp, i % 3 ? C.gold : C.white, 10 + k * 2, 0.7, { drag: 2.2, grav: 380 });
      }
      this.ring(p.x, p.y - R + 3, p.z, 0xffd84d, 150 + k * 40, 0.55);
      if (e.type === 'launch') { this.ring(p.x, p.y - R + 3, p.z, 0xffffff, 320, 0.7); this.shake(10); }
    } else if (e.type === 'heave') {
      const p = this.world3(e.team, e.x, e.y, 26);
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        this.sparks.emit(p.x, p.y, p.z, Math.cos(a) * 90, 60 + Math.random() * 80, Math.sin(a) * 90, C.gold, 7, 0.35, { drag: 3 });
      }
    } else if (e.type === 'fallBelow') {
      // The ball (or a player) plops into the clouds.
      const p = new THREE.Vector3(this.laneX(e.team) + e.x, -320, -e.y);
      const big = e.ball ? 1 : 0.45;
      for (let i = 0; i < 40 * big + 10; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (120 + Math.random() * 220) * big;
        this.puffs.emit(p.x, p.y, p.z, Math.cos(a) * sp, 40 + Math.random() * 120, Math.sin(a) * sp, C.cloud, (80 + Math.random() * 80) * big, 1.6, { alpha: 0.95, grow: 1.6, drag: 1.4 });
      }
    } else if (e.type === 'fall') {
      const p = this.world3(e.team, e.x, e.y, 10);
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        this.puffs.emit(p.x, p.y, p.z, Math.cos(a) * 80, 30 + Math.random() * 60, Math.sin(a) * 80, C.dust, 26, 0.7, { alpha: 0.8, grow: 1.8, drag: 2 });
      }
    } else if (e.type === 'bump' || e.type === 'hit') {
      const p = this.world3(e.team, e.x, e.y, 30);
      const col = e.kind === 'bumper' ? C.pink : C.white;
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        this.sparks.emit(p.x, p.y, p.z, Math.cos(a) * 220, 40 + Math.random() * 160, Math.sin(a) * 220, i % 2 ? col : C.gold, 9, 0.4, { drag: 3, grav: 300 });
      }
      if (e.kind === 'bumper') this.world.bump(e.team, e.x, e.y);
      if (e.team === this.myTeam && e.kind !== 'post') this.shake(e.kind === 'hammer' ? 9 : 5);
    } else if (e.type === 'checkpoint' || e.type === 'finish') {
      const y = e.type === 'finish' ? this.C.goal.y : this.C.checkpoints[e.cp].y;
      const base = this.world3(e.team, 0, y, 0);
      const n = e.type === 'finish' ? (MOBILE ? 260 : 520) : (MOBILE ? 90 : 160);
      for (let i = 0; i < n; i++) {
        const side = i % 2 ? 1 : -1;
        const spread = e.type === 'finish' ? 330 : 300;
        const x = base.x + side * spread;
        this.confetti.emit(x, base.y + 40, base.z, -side * (80 + Math.random() * 260), 380 + Math.random() * 420, (Math.random() - 0.5) * 260,
          C.confetti[i % C.confetti.length], 9 + Math.random() * 6, 2.6 + Math.random(), { drag: 0.9, grav: 420 });
      }
    } else if (e.type === 'land') {
      const p = this.world3(e.team, e.x, e.y, 4);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        this.puffs.emit(p.x, p.y, p.z, Math.cos(a) * 200, 30, Math.sin(a) * 200, C.dust, 30, 0.7, { alpha: 0.8, grow: 1.8, drag: 2.5 });
      }
      if (e.team === this.myTeam) this.shake(8);
    } else if (e.type === 'pop' || e.type === 'respawn') {
      const p = this.world3(e.team, e.x, e.y, 10);
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2;
        this.sparks.emit(p.x, p.y, p.z, Math.cos(a) * 60, 120 + Math.random() * 160, Math.sin(a) * 60, C.cyan, 8, 0.6, { drag: 1.5 });
      }
    }
    void info;
  }

  // ---------- per frame ----------
  // view: { t (course time), phase, intro (0..1 camera fly-in), balls: [{ team, x, y, z, vx, vy, state, gates, plates }],
  //   players: [{ idx, team, x, y, vx, vy, flags }], wraps: Map, focus: { team, x, y, mx, my }, mods: Map(team -> mods), rope }
  update(view, dt, now) {
    if (!this.world) return;
    const t = now / 1000;
    const H = this.H;
    const C = this.C;
    const ballState = new Map();
    for (const b of view.balls) ballState.set(b.team, b);

    // Course animation (gates, plates, sweepers, hammers, fans, bridges, belts).
    this.world.update(view.t, dt, this.teams.map((tm) => ballState.get(tm.idx) || {}), this.camPos ? { z: this.camPos.z, focusZ: this.camLook.z + 140 } : null);
    this.clouds.update(dt);

    // Balls.
    for (const b of this.balls) {
      const s = ballState.get(b.team.idx);
      if (!s) { b.mesh.visible = false; b.ring.visible = false; continue; }
      const lx = this.laneX(b.team.idx);
      const ground = H(s.x, s.y);
      const falling = s.state === 1;
      const y = falling ? ground + R + Math.min(0, s.z) * 1.0 : ground + R + Math.max(0, s.z);
      b.mesh.visible = y > -900;
      b.mesh.position.set(lx + s.x, y, -s.y);
      if (b.last) {
        const dx = s.x - b.last.x;
        const dy = s.y - b.last.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.01 && dist < 200) {
          const axis = new THREE.Vector3(-dy, 0, -dx).normalize();
          b.q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, dist / R));
          b.mesh.quaternion.copy(b.q);
        }
      }
      b.last = { x: s.x, y: s.y };
      b.ring.visible = !falling && s.z < 30;
      b.ring.position.set(lx + s.x, ground + 1.5, -s.y);
      // Rolling dust.
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > 90 && !falling && s.z < 5 && Math.random() < dt * 14) {
        this.puffs.emit(b.mesh.position.x + (Math.random() - 0.5) * 50, ground + 6, -s.y + (Math.random() - 0.5) * 50, 0, 25, 0, this.colors.dust, 26, 0.8, { alpha: 0.55, grow: 2, drag: 1.5 });
      }
      if (falling && !b.falling && s.z < -250) {
        b.falling = true;
        this.fx({ type: 'fallBelow', team: b.team.idx, x: s.x, y: s.y, ball: true });
      }
      if (!falling) b.falling = false;
      // Heavy-ball sabotage turns it to iron.
      const mods = view.mods?.get(b.team.idx);
      const heavy = mods && mods.heavy > view.t ? 1 : 0;
      b.heavy += (heavy - b.heavy) * Math.min(1, dt * 4);
      b.mat.color.setRGB(1 - b.heavy * 0.55, 1 - b.heavy * 0.55, 1 - b.heavy * 0.5);
      if ('metalness' in b.mat) b.mat.metalness = b.heavy * 0.7;
      const oil = mods?.oil && mods.oil.until > view.t ? mods.oil : null;
      b.oil.visible = !!oil;
      if (oil) {
        const cx = (oil.x0 + oil.x1) / 2;
        const cy = (oil.y0 + oil.y1) / 2;
        b.oil.position.set(lx + cx, H(cx, cy) + 1.6, -cy);
        b.oil.scale.set((oil.x1 - oil.x0) / 2, 1, (oil.y1 - oil.y0) / 2);
      }
      // Gust: wind streaks across the lane.
      if (mods?.gust && view.t >= mods.gust.from && view.t < mods.gust.until && Math.random() < dt * 30) {
        const dir = Math.sign(mods.gust.ax);
        this.puffs.emit(lx - dir * 320, ground + 20 + Math.random() * 80, -(s.y + (Math.random() - 0.4) * 500), dir * 900, 0, 0, this.colors.white, 10, 0.8, { alpha: 0.5, grow: 1.2, drag: 0 });
      }
    }
    // Fan wind streaks.
    for (const z of C.zones) {
      if (z.type !== 'wind' || !BC.windOn(z, view.t) || Math.random() > dt * 22) continue;
      const lane = this.myTeam ?? 0;
      const dir = Math.sign(z.ax);
      const y = z.y0 + Math.random() * (z.y1 - z.y0);
      this.puffs.emit(this.laneX(lane) + (dir > 0 ? z.x0 : z.x1), 30 + Math.random() * 120, -y, dir * 700, 0, 0, this.colors.white, 9, 0.9, { alpha: 0.6, grow: 1.1, drag: 0 });
    }

    // Figures and ropes (a rope snarl sabotage tints the team's ropes a knotted dark red).
    const snarled = (team) => { const m = view.mods?.get(team); return m && m.snarl > view.t; };
    for (const [team, mtl] of this.ropeMats) mtl.color.setHex(snarled(team) ? 0x9c3a5e : 0xffffff);
    for (const p of view.players) {
      const lx = this.laneX(p.team);
      const ball = ballState.get(p.team);
      const gone = !!(p.flags & 32);
      const falling = !!(p.flags & 4);
      const wraps = view.wraps.get(p.idx) || [];
      // Rope anchors in lane space: ball, wrap contact points, hands.
      let ropeDir = null;
      let taut = 0;
      let anchors = null;
      const ropeLive = ball && ball.state !== 1 && !gone && !falling && ball.state !== 2;
      if (ropeLive) {
        anchors = [{ x: ball.x, y: ball.y }];
        for (const id of wraps) anchors.push(C.posts[id]);
        anchors.push({ x: p.x, y: p.y });
        // Contact points sit on the outside of each bend.
        for (let i = 1; i < anchors.length - 1; i++) {
          const post = anchors[i];
          const a = anchors[i - 1];
          const c = anchors[i + 1];
          const u1x = post.x - a.x; const u1y = post.y - a.y;
          const u2x = c.x - post.x; const u2y = c.y - post.y;
          const l1 = Math.hypot(u1x, u1y) || 1; const l2 = Math.hypot(u2x, u2y) || 1;
          let ox = u1x / l1 - u2x / l2;
          let oy = u1y / l1 - u2y / l2;
          const ol = Math.hypot(ox, oy);
          if (ol < 0.05) { ox = -u1y / l1; oy = u1x / l1; } else { ox /= ol; oy /= ol; }
          anchors[i] = { x: post.x + ox * (post.r + 3), y: post.y + oy * (post.r + 3), post: true };
        }
        let len = 0;
        for (let i = 1; i < anchors.length; i++) len += Math.hypot(anchors[i].x - anchors[i - 1].x, anchors[i].y - anchors[i - 1].y);
        const rest = snarled(p.team) ? this.rope.rest * 0.62 : this.rope.rest;
        taut = Math.max(0, Math.min(1, (len - rest * 0.8) / (rest * 0.25)));
        const prev = anchors[anchors.length - 2];
        const dx = prev.x - p.x;
        const dy = prev.y - p.y;
        const dl = Math.hypot(dx, dy) || 1;
        ropeDir = { x: dx / dl, z: -dy / dl };
        anchors.len = len;
        anchors.rest = rest;
      }
      const ground = H(p.x, p.y);
      const pose = this.figures.pose({
        idx: p.idx, X: lx + p.x, Y: ground, Z: -p.y, vx: p.vx, vz: -p.vy, flags: p.flags, rope: ropeDir, taut, gone,
      }, dt, t);
      const rope = this.ropes.get(p.idx);
      const tag = this.tags.get(p.idx);
      if (!pose) {
        rope.mesh.visible = false;
        tag.visible = false;
        continue;
      }
      if (!falling) this.splashed.delete(p.idx);
      else if (pose.base < -260 && !this.splashed.has(p.idx)) { this.splashed.add(p.idx); this.fx({ type: 'fallBelow', team: p.team, x: p.x, y: p.y }); }
      // Name tag above the head.
      tag.visible = !falling;
      tag.position.set(pose.head.x, pose.head.y + 16, pose.head.z);
      const d = this.camera.position.distanceTo(tag.position);
      const w = Math.max(56, Math.min(170, d * 0.105)) * (p.idx === this.myIdx ? 0.85 : 1);
      tag.scale.set(w, w * (84 / 320), 1);
      if (p.idx === this.myIdx) {
        this.meRing.visible = !falling;
        this.meRing.position.set(lx + p.x, ground + 1.2, -p.y);
        this.meRing.material.color.set(this.teams[p.team]?.color || '#ffffff');
        this.meRing.scale.setScalar(1 + Math.sin(t * 5) * 0.08);
      }
      // Dust under running feet.
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 150 && !falling && Math.random() < dt * 8) {
        this.puffs.emit(lx + p.x, ground + 3, -p.y, -p.vx * 0.1, 18, p.vy * 0.1, this.colors.dust, 14, 0.5, { alpha: 0.5, grow: 2, drag: 2 });
      }
      if (!anchors) { rope.mesh.visible = false; continue; }
      rope.mesh.visible = true;
      this.layRope(rope, anchors, lx, ball, pose.hands, p.team, view.t);
    }
    this.figures.commit();

    this.sparks.update(dt);
    this.puffs.update(dt);
    this.confetti.update(dt);
    this.effects = this.effects.filter((e) => {
      e.life -= dt;
      const k = 1 - e.life / e.max;
      e.mesh.scale.setScalar(10 + k * e.radius);
      e.mesh.material.opacity = 0.9 * (1 - k);
      if (e.life > 0) return true;
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
      return false;
    });
    this.updateCamera(view, dt, t);
    if (!this.ready) return;
    const r0 = performance.now();
    this.renderer.info.reset();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.renderMs = performance.now() - r0;
  }

  // Sample a sagging curve through the rope's anchors into the tube.
  layRope(rope, anchors, lx, ball, hands, team, tc) {
    const H = this.H;
    const slack = Math.max(0, anchors.rest - anchors.len);
    const sagMax = Math.min(46, Math.sqrt(slack) * 3.2);
    // 3D anchor points.
    const pts3 = anchors.map((a, i) => {
      if (i === anchors.length - 1) return hands.clone();
      if (i === 0) {
        const nx = anchors[1].x - a.x;
        const ny = anchors[1].y - a.y;
        const l = Math.hypot(nx, ny) || 1;
        const by = H(ball.x, ball.y) + R + Math.max(0, ball.z) - 6;
        return new THREE.Vector3(lx + a.x + (nx / l) * R * 0.94, by, -(a.y + (ny / l) * R * 0.94));
      }
      return new THREE.Vector3(lx + a.x, H(a.x, a.y) + 22, -a.y);
    });
    const segLens = [];
    let total = 0;
    for (let i = 1; i < pts3.length; i++) { const l = pts3[i].distanceTo(pts3[i - 1]); segLens.push(l); total += l; }
    const n = ROPE_PTS;
    let si = 0;
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const dist = (k / (n - 1)) * total;
      while (si < segLens.length - 1 && dist > acc + segLens[si]) { acc += segLens[si]; si++; }
      const u = segLens[si] > 0 ? Math.min(1, (dist - acc) / segLens[si]) : 0;
      const a = pts3[si];
      const b = pts3[si + 1];
      const p = rope.pts[k];
      p.lerpVectors(a, b, u);
      const sag = sagMax * (segLens[si] / total) * 4 * u * (1 - u) * Math.min(1, total / 120);
      p.y -= sag;
      // Taut ropes hum a little.
      if (slack <= 0 && anchors.len > anchors.rest * 1.15) p.y += Math.sin(tc * 60 + k) * 0.6 * u * (1 - u) * 4;
      const floor = H(p.x - lx, -p.z) + 1.5;
      if (p.y < floor) p.y = floor;
    }
    rope.build(3.2);
  }

  updateCamera(view, dt, t) {
    const f = view.focus;
    if (!f) return;
    const lx = this.laneX(f.team);
    const aspect = this.camera.aspect;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const wantW = aspect < 0.8 ? 600 : aspect < 1.3 ? 760 : 880;
    let dist = wantW / (2 * Math.tan(hfov / 2));
    dist = Math.max(480, Math.min(1400, dist));
    const pitch = aspect < 0.8 ? 0.98 : 0.84;
    const fx = f.x + (f.mx !== undefined ? (f.mx - f.x) * 0.3 : 0);
    const fy = f.y + 140 + (f.my !== undefined ? (f.my - f.y) * 0.25 : 0);
    const gh = this.H(fx, Math.min(fy, this.C.len)) * 0.8;
    const look = new THREE.Vector3(lx + fx, gh + 20, -fy);
    let desired = new THREE.Vector3(look.x, look.y + Math.sin(pitch) * dist, look.z + Math.cos(pitch) * dist);
    // Countdown: swoop in from high above the course.
    if (view.intro !== undefined && view.intro < 1) {
      const k = 1 - (1 - view.intro) ** 3;
      const over = new THREE.Vector3(lx + Math.sin(t * 0.3) * 200, 2600, -(this.C.len * 0.45));
      desired = over.lerp(desired, k);
      look.lerpVectors(new THREE.Vector3(lx, 0, -this.C.len * 0.55), look, k);
    }
    if (!this.camPos || f.snap) {
      this.camPos = desired.clone();
      this.camLook.copy(look);
    } else {
      this.camPos.lerp(desired, 1 - Math.exp(-dt * 4.5));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 6));
    }
    this.camera.position.copy(this.camPos);
    if (this.shakeAmt > 0.05) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt;
      this.shakeAmt *= Math.exp(-dt * 7);
    }
    this.camera.lookAt(this.camLook);
    this.sun.position.set(this.camLook.x + 500, this.camLook.y + 1200, this.camLook.z + 350);
    this.sun.target.position.copy(this.camLook);
    this.sky.position.copy(this.camera.position);
  }

  dispose() {
    // Three keeps polling shader programs while compileAsync runs: finish that first.
    if (this.compiling) { this.disposeAfterCompile = true; this.renderer.domElement.remove(); return; }
    this.clearMatch();
    this.resizeObserver.disconnect();
    this.composer?.dispose();
    this.envMap?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

window.BallChain3D = BallChain3D;
window.dispatchEvent(new Event('ballchain3d-ready'));
