// Game feel for Kart Battle: layered blasts, trauma camera shake, hit flashes, floating damage
// numbers, muzzle flashes and smoking wrecks. Everything is pooled (instanced meshes and a few
// sprites), so a dozen karts blowing up at once costs a handful of draw calls.
//
// A blast is four things at once:
// - the core: a white-hot ball that swells to its size in 0.1 s, then fades in the next 0.1 s;
// - the shockwave: a ring racing out over the ground, gone in 0.3 s;
// - the fireball and smoke: chunky low-poly puffs (glowing yellow to orange to ember, then solid
//   grey smoke rolling up), each popping up with a little overshoot and shrinking away;
// - debris: low-poly cubes thrown out on arcs, bouncing and shrinking away (ItemFX's Debris pool);
// and the camera takes trauma from it: the shake is trauma squared, a smooth rotational wobble,
// and trauma drains linearly (all of it in 0.5 s).
import * as THREE from 'three';

// ---------- easing ----------
export const ease = {
  outCubic: (t) => 1 - (1 - t) ** 3,
  outBack: (t, s = 2.2) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

// Colour ramps: [t, r, g, b] stops (linear colour; above 1 glows under bloom).
const RAMP = {
  fire: [[0, 2.2, 2, 1.4], [0.18, 2, 1.35, 0.35], [0.45, 1.6, 0.55, 0.1], [0.75, 0.55, 0.16, 0.06], [1, 0.16, 0.08, 0.06]],
  smoke: [[0, 1, 0.72, 0.45], [0.2, 0.8, 0.74, 0.68], [0.6, 0.66, 0.65, 0.66], [1, 0.55, 0.55, 0.58]],
  soot: [[0, 0.9, 0.42, 0.15], [0.18, 0.16, 0.15, 0.15], [1, 0.08, 0.08, 0.09]],
  steam: [[0, 0.95, 0.96, 0.98], [1, 0.8, 0.82, 0.86]],
};
function ramp(stops, t, out) {
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < t) i++;
  const a = stops[i - 1];
  const b = stops[i];
  const k = Math.max(0, Math.min(1, (t - a[0]) / Math.max(1e-6, b[0] - a[0])));
  return out.setRGB(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
}

// ---------- puffs: chunky low-poly smoke and fire balls ----------
// Each pops up to its size with a little overshoot, drifts (and rises), swells a touch and then
// shrinks away, its colour running along its ramp. `lit` puffs are solid shaded smoke; unlit ones
// glow (fire).
class Puffs {
  constructor(scene, max, lit) {
    this.max = max;
    this.n = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.rot = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.span = new Float32Array(max);
    this.delay = new Float32Array(max);
    this.rise = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.ramp = new Array(max).fill(RAMP.smoke);
    // Round, softly shaded puffs: smoke catches the light like a cloud does (a touch of its own glow
    // keeps the shadow side from going dark); fire is unlit and glows.
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = lit
      ? new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, emissive: 0x2a2a30 })
      : new THREE.MeshBasicMaterial({});
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = lit;
    scene.add(this.mesh);
    this.m4 = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.v3 = new THREE.Vector3();
    this.sc = new THREE.Vector3();
    this.col = new THREE.Color();
  }

  emit(x, y, z, vx, vy, vz, size, life, rampStops, { delay = 0, rise = 0, drag = 2 } = {}) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.p.set([x, y, z], i * 3);
    this.v.set([vx, vy, vz], i * 3);
    this.rot.set([rand(0, TAU), rand(0, TAU), rand(0, TAU)], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.span[i] = life;
    this.delay[i] = delay;
    this.rise[i] = rise;
    this.drag[i] = drag;
    this.ramp[i] = rampStops;
  }

  // cam: the camera position; puffs shrink away as they come near it, so smoke never blinds you.
  update(dt, cam) {
    let i = 0;
    while (i < this.n) {
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        this.m4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m4);
        i++;
        continue;
      }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.n;
        if (i !== last) {
          for (const arr of [this.p, this.v, this.rot]) arr.copyWithin(i * 3, last * 3, last * 3 + 3);
          for (const arr of [this.size, this.life, this.span, this.delay, this.rise, this.drag]) arr[i] = arr[last];
          this.ramp[i] = this.ramp[last];
        }
        continue;
      }
      const o = i * 3;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.v[o] *= d;
      this.v[o + 1] = this.v[o + 1] * d + this.rise[i] * dt;
      this.v[o + 2] *= d;
      for (let k = 0; k < 3; k++) this.p[o + k] += this.v[o + k] * dt;
      const t = 1 - this.life[i] / this.span[i];
      // Pop (with overshoot), swell, shrink away.
      let s = t < 0.16 ? ease.outBack(t / 0.16) : t < 0.55 ? 1 + 0.22 * ((t - 0.16) / 0.39) : 1.22 * (1 - ((t - 0.55) / 0.45) ** 1.6);
      if (cam) {
        const near = Math.hypot(cam.x - this.p[o], cam.y - this.p[o + 1], cam.z - this.p[o + 2]) - this.size[i] * 1.2;
        s *= Math.max(0, Math.min(1, (near - 30) / 90));
      }
      this.q.setFromEuler(this.e.set(this.rot[o] + t * 0.8, this.rot[o + 1], this.rot[o + 2]));
      this.m4.compose(this.v3.set(this.p[o], this.p[o + 1], this.p[o + 2]), this.q, this.sc.setScalar(Math.max(0, s) * this.size[i]));
      this.mesh.setMatrixAt(i, this.m4);
      this.mesh.setColorAt(i, ramp(this.ramp[i], t, this.col));
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
}

// ---------- flashes: additive things that grow and fade (blast cores, shockwave rings) ----------
// kind core: swells to full size in `grow` seconds (ease out), then fades out over `fade` seconds.
// kind ring: races out to full size over its life (ease out), fading as it goes.
class Flashes {
  constructor(scene, geo, max, renderOrder) {
    this.max = max;
    this.n = 0;
    this.p = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.fade = new Float32Array(max);
    this.cols = Array.from({ length: max }, () => new THREE.Color());
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);
    this.m4 = new THREE.Matrix4();
    this.v3 = new THREE.Vector3();
    this.sc = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.col = new THREE.Color();
  }

  emit(x, y, z, size, color, grow, fade) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.p.set([x, y, z], i * 3);
    this.size[i] = size;
    this.age[i] = 0;
    this.grow[i] = grow;
    this.fade[i] = fade;
    this.cols[i].copy(color);
  }

  // cap(x, y, z, size): the largest size allowed there (blast cores never swallow the camera).
  update(dt, ring, cap) {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      const total = this.grow[i] + this.fade[i];
      if (this.age[i] >= total) {
        const last = --this.n;
        if (i !== last) {
          this.p.copyWithin(i * 3, last * 3, last * 3 + 3);
          for (const arr of [this.size, this.age, this.grow, this.fade]) arr[i] = arr[last];
          this.cols[i].copy(this.cols[last]);
        }
        continue;
      }
      const o = i * 3;
      const a = this.age[i];
      let s;
      let k;
      if (ring) {
        const t = a / total;
        s = ease.outCubic(t);
        k = 1 - t;
      } else {
        s = a < this.grow[i] ? ease.outCubic(a / this.grow[i]) : 1 + 0.12 * ((a - this.grow[i]) / this.fade[i]);
        k = a < this.grow[i] ? 1 : 1 - (a - this.grow[i]) / this.fade[i];
      }
      let size = Math.max(0.001, s * this.size[i]);
      if (cap) size = Math.min(size, cap(this.p[o], this.p[o + 1], this.p[o + 2]));
      this.m4.compose(this.v3.set(this.p[o], this.p[o + 1], this.p[o + 2]), this.q, this.sc.set(size, size, size));
      this.mesh.setMatrixAt(i, this.m4);
      this.mesh.setColorAt(i, this.col.copy(this.cols[i]).multiplyScalar(Math.max(0, k)));
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
}

// ---------- damage numbers ----------
const numberTextures = new Map();
function numberTexture(text, style) {
  const key = `${style}:${text}`;
  let tex = numberTextures.get(key);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d');
  g.font = `900 ${style === 'big' ? 70 : 60}px Inter, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 14;
  g.strokeStyle = 'rgba(20, 12, 40, 0.95)';
  g.strokeText(text, 128, 50, 240);
  const fill = style === 'hurt' ? ['#ffb4b4', '#ff3b3b'] : style === 'big' ? ['#fff7c2', '#ffb020'] : ['#ffffff', '#ffe07a'];
  const grad = g.createLinearGradient(0, 22, 0, 78);
  grad.addColorStop(0, fill[0]);
  grad.addColorStop(1, fill[1]);
  g.fillStyle = grad;
  g.fillText(text, 128, 50, 240);
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (numberTextures.size > 80) {
    const [oldKey, old] = numberTextures.entries().next().value;
    numberTextures.delete(oldKey);
    old.dispose();
  }
  numberTextures.set(key, tex);
  return tex;
}

// ---------- the muzzle starburst ----------
let starTex = null;
function starburstTexture() {
  if (starTex) return starTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.35, 'rgba(255,214,90,0.95)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const r = i % 2 ? 22 : 62;
    g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  starTex = new THREE.CanvasTexture(c);
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}

export class Juice {
  // r: the Kart3D renderer (scene, camera, particles, ground lookups, items.debris).
  constructor(r, mobile) {
    this.r = r;
    this.mobile = mobile;
    const scene = r.scene;
    this.smoke = new Puffs(scene, mobile ? 160 : 360, true);
    this.fire = new Puffs(scene, mobile ? 140 : 300, false);
    this.cores = new Flashes(scene, new THREE.IcosahedronGeometry(1, 3), 24, 4);
    this.rings = new Flashes(scene, new THREE.RingGeometry(0.84, 1, 64).rotateX(-Math.PI / 2), 24, 3);
    this.trauma = 0;
    this.shakeT = 0;
    this.numbers = [];
    this.flashes = [];
    this.col = {
      core: new THREE.Color(2.2, 1.75, 1.05),
      ring: new THREE.Color(1.4, 0.95, 0.55),
      ringBig: new THREE.Color(1.6, 1.25, 0.8),
      debris: [0xff8a2a, 0xffb347, 0x5b5f6b, 0x8a8f9c],
    };
    const cam = r.camera;
    // Blast cores never grow past a third of their distance to the camera (no white screens).
    this.cap = (x, y, z) => Math.max(4, Math.hypot(cam.position.x - x, cam.position.y - y, cam.position.z - z) * 0.33);
  }

  // ---------- blasts ----------
  // A layered explosion at (x, y, z): y is the ground there. radius: the blast's reach;
  // opts.big: a full explosion (else a small hit pop); opts.color: debris colour (a smashed kart).
  blast(x, y, z, radius, { big = true, color = null, soot = false } = {}) {
    const s = Math.max(0.55, Math.min(2.4, radius / 70));
    const m = this.mobile ? 0.6 : 1;
    // Core and shockwave.
    this.cores.emit(x, y + 14 * s, z, (big ? 26 : 14) * s, this.col.core, 0.1, 0.1);
    this.rings.emit(x, y + 2, z, radius * (big ? 1.45 : 0.9), big ? this.col.ringBig : this.col.ring, 0.3, 0);
    // Fireball: glowing puffs bursting out and up.
    const nFire = Math.round((big ? 11 : 5) * m);
    for (let i = 0; i < nFire; i++) {
      const a = rand(0, TAU);
      const out = rand(0.2, 1);
      const sp = (big ? 170 : 100) * s * out;
      this.fire.emit(x + Math.cos(a) * 6 * s, y + rand(8, 22) * s, z + Math.sin(a) * 6 * s, Math.cos(a) * sp, rand(50, 160) * s, Math.sin(a) * sp,
        rand(10, 17) * s * (big ? 1 : 0.7), rand(0.45, 0.65), RAMP.fire, { drag: 3.2, rise: 60 });
    }
    // Smoke: solid grey puffs rolling up behind the fire.
    const nSmoke = Math.round((big ? 8 : 3) * m);
    for (let i = 0; i < nSmoke; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, 120) * s;
      this.smoke.emit(x + Math.cos(a) * 10 * s, y + rand(10, 26) * s, z + Math.sin(a) * 10 * s, Math.cos(a) * sp, rand(50, 110) * s, Math.sin(a) * sp,
        rand(8, 14) * s * (big ? 1 : 0.6), rand(0.6, 0.95), soot ? RAMP.soot : RAMP.smoke, { delay: rand(0.05, 0.14), drag: 2.4, rise: 40 });
    }
    // Debris: low-poly cubes on arcs (orange and grey, or the wreck's colour).
    const deb = this.r.items?.debris;
    if (deb) {
      const n = Math.round((big ? 16 : 6) * m);
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU);
        const sp = rand(120, 300) * Math.min(1.4, s);
        const c = color && i % 2 ? color : this.col.debris[i % 4];
        deb.emit(x, y + rand(8, 20), z, Math.cos(a) * sp, rand(200, 430) * Math.min(1.3, s), Math.sin(a) * sp, rand(2.5, 5.5) * Math.min(1.3, s), c, rand(0.8, 1.1));
      }
    }
  }

  // A puff of landing dust, tyre smoke or the like: solid low-poly puffs in `stops` colours.
  puff(x, y, z, vx, vy, vz, size, life, stops = RAMP.steam, opts) {
    this.smoke.emit(x, y, z, vx, vy, vz, size, life, stops, opts);
  }

  // A burning wreck: black smoke billowing up out of the engine, flames licking at it.
  // (vx, vz: drift, e.g. left behind by a moving kart.)
  burn(x, y, z, vx = 0, vz = 0) {
    this.smoke.emit(x + rand(-2, 2), y, z + rand(-2, 2), vx + rand(-8, 8), rand(80, 120), vz + rand(-8, 8), rand(3.5, 6), rand(0.7, 1), RAMP.soot, { drag: 1.2, rise: 30 });
    if (Math.random() < 0.7) this.fire.emit(x + rand(-2.5, 2.5), y - 1, z + rand(-2.5, 2.5), vx * 0.5, rand(40, 80), vz * 0.5, rand(3, 5.5), rand(0.22, 0.36), RAMP.fire, { drag: 2 });
  }

  // ---------- camera shake ----------
  // amount: 0..1 of trauma at the epicentre, less with distance from the camera's kart.
  addTrauma(amount, x, z, focus) {
    const d = focus ? Math.hypot(focus.x - x, focus.y - z) : 0;
    const k = Math.max(0, 1 - d / 900);
    this.trauma = Math.min(1, this.trauma + amount * k);
  }

  // A smooth rotational wobble (sums of sines: a cheap 1D noise), scaled by trauma squared.
  applyShake(camera, dt) {
    if (this.trauma <= 0) return;
    this.shakeT += dt;
    const s = this.trauma * this.trauma;
    const n = (f, p) => Math.sin(this.shakeT * f + p) * 0.6 + Math.sin(this.shakeT * f * 2.37 + p * 1.7) * 0.4;
    camera.rotateY(0.055 * s * n(31, 0.3));
    camera.rotateX(0.045 * s * n(37, 1.9));
    camera.rotateZ(0.07 * s * n(27, 4.2));
    camera.translateX(4 * s * n(23, 2.6));
    camera.translateY(3 * s * n(29, 5.1));
    this.trauma = Math.max(0, this.trauma - dt * 2);
  }

  // ---------- muzzle flash ----------
  // A starburst at (x, y, z), gone in 50 ms.
  muzzle(x, y, z, size = 26) {
    const mat = new THREE.SpriteMaterial({ map: starburstTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z);
    sp.scale.setScalar(size);
    sp.material.rotation = rand(0, TAU);
    sp.renderOrder = 6;
    this.r.scene.add(sp);
    this.flashes.push({ sp, t: 0 });
  }

  // ---------- damage numbers ----------
  // "-25" floating up off (x, y, z) and fading over 1.2 s. style: deal | big | hurt.
  number(x, y, z, text, style = 'deal') {
    const mat = new THREE.SpriteMaterial({ map: numberTexture(text, style), transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = 11;
    sp.center.set(0.5, 0);
    this.r.scene.add(sp);
    // Side by side hits spread a little, so a burst of bullets doesn't stack into one number.
    this.numbers.push({ sp, x: x + rand(-8, 8), y, z: z + rand(-8, 8), t: 0, px: style === 'big' ? 74 : style === 'hurt' ? 52 : 60 });
    if (this.numbers.length > 24) this.dropNumber(0);
  }

  dropNumber(i) {
    const n = this.numbers[i];
    this.r.scene.remove(n.sp);
    n.sp.material.dispose();
    this.numbers.splice(i, 1);
  }

  // ---------- per frame ----------
  // unit: CSS pixels per sprite scale unit (from the camera), for the screen-sized numbers.
  update(dt, unit) {
    const cam = this.r.camera.position;
    this.smoke.update(dt, cam);
    this.fire.update(dt, cam);
    this.cores.update(dt, false, this.cap);
    this.rings.update(dt, true, null);
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const p = f.t / 0.05;
      f.sp.material.opacity = 1 - ease.outCubic(Math.min(1, p));
      if (p >= 1) {
        this.r.scene.remove(f.sp);
        f.sp.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.t += dt;
      const p = n.t / 1.2;
      if (p >= 1) { this.dropNumber(i); continue; }
      n.sp.position.set(n.x, n.y + 34 * ease.outCubic(p), n.z);
      const pop = n.t < 0.18 ? 1.5 - 0.5 * ease.outBack(n.t / 0.18) : 1;
      const h = (n.px * pop) / unit;
      n.sp.scale.set(h * (256 / 96), h, 1);
      n.sp.material.opacity = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
    }
  }

  dispose() {
    this.smoke.dispose();
    this.fire.dispose();
    this.cores.dispose();
    this.rings.dispose();
    for (const f of this.flashes) f.sp.material.dispose();
    for (const n of this.numbers) n.sp.material.dispose();
  }
}

export { RAMP };
