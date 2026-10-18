// Sky Gardens' own pieces (kart-layers.js's theSkyGardens), in the bright look (kart3d/bright3d.js):
// craggy rock under every island, waterfalls spilling off their sides into a sea of cloud far
// below, the fountain on the dais and the sprinkler whose arms sweep it, the bell tower's belfry
// and dome, the clock tower's clocks, a windmill turning its sails, an observatory turning its
// dome, flower beds, lamps along the bridges, and the sky's own traffic: hot-air balloons, an
// airship, far-off islands and birds.
//
// Physics (x, y, z) is three (x, z, y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { brightMaterial, flatGeo, outward, box, post, ball, strut, merged, darker, glow, nearFade } from './bright3d.js';
import { tex, rng } from './world.js';

const TAU = Math.PI * 2;
const WHITE = '#fbf8f2';
const CREAM = '#f3e8d2';
const CORAL = '#ff7d8c';
const TEAL = '#2fb8b0';
const GOLD = '#f6c544';
const BRASS = '#d9a441';
const SLATE = '#3d4a63';
// Rock under the islands, in bands: sandstone under the lawn, darker further down.
const STRATA = ['#f0b878', '#d9925a', '#e8a86c', '#bd7a4c', '#cd8858', '#946042', '#74493a'];

// ---------- helpers ----------
const _col = new THREE.Color();
// A faceted mesh from triangles: [[a, b, c, hex], ...] with corners in physics space.
function facets(tris) {
  const pos = [];
  const col = [];
  for (const [a, b, c, hex] of tris) {
    _col.set(hex);
    for (const p of [a, b, c]) { pos.push(p[0], p[2], p[1]); col.push(_col.r, _col.g, _col.b); }
  }
  const n = pos.length / 3;
  const pat = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) pat[i * 4 + 3] = 1;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aCol2', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aPat', new THREE.BufferAttribute(pat, 4));
  g.setAttribute('aLoc', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
// A solid of revolution round a vertical axis at (x, y), from a profile of [radius, height] pairs.
function lathe(x, y, z, profile, colour, n = 20) {
  const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(Math.max(0.01, r), h)), n);
  return flatGeo(g.translate(x, z, y), colour);
}
// A group's geometry, built in its own frame (physics space round the origin), as one mesh.
function piece(parts) {
  return merged(parts);
}

// ---------- the rock under an island ----------
// Rings narrowing to a point, jittered so it reads as rock, in strata; a few roots hanging off the
// rim and a couple of loose rocks floating beside it.
function underside(s, seed, parts, floaters) {
  const r = rng(seed);
  const R = s.r * 0.99;
  const depth = s.r * 1.0 + 80;
  const K = 7;
  const N = Math.max(12, Math.round(s.r / 16));
  const rings = [];
  for (let k = 0; k < K; k++) {
    const u = k / K;
    const rad = R * Math.pow(1 - u, 0.72);
    const z = s.z0 + 1 - depth * u;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + (k ? (r() - 0.5) * (TAU / N) * 0.6 : 0);
      const jr = k === 0 ? R : rad * (0.82 + r() * 0.32);
      pts.push([s.x + Math.cos(a) * jr, s.y + Math.sin(a) * jr, z + (k ? (r() - 0.5) * 24 : 0)]);
    }
    rings.push(pts);
  }
  const tip = [s.x + (r() - 0.5) * s.r * 0.25, s.y + (r() - 0.5) * s.r * 0.25, s.z0 - depth];
  const tris = [];
  for (let k = 0; k < K - 1; k++) {
    for (let i = 0; i < N; i++) {
      const a = rings[k][i];
      const b = rings[k][(i + 1) % N];
      const c = rings[k + 1][(i + 1) % N];
      const d = rings[k + 1][i];
      const band = STRATA[(k + (i % 5 === 0 ? 1 : 0)) % STRATA.length];
      tris.push([a, b, c, band], [a, c, d, band]);
    }
  }
  for (let i = 0; i < N; i++) tris.push([rings[K - 1][i], rings[K - 1][(i + 1) % N], tip, STRATA[STRATA.length - 1]]);
  parts.push(outward(facets(tris)));
  // Roots and vines dangling from just under the lawn.
  const roots = Math.round(s.r / 26);
  for (let i = 0; i < roots; i++) {
    const a = r() * TAU;
    const rr = s.r * (0.9 + r() * 0.08);
    const x = s.x + Math.cos(a) * rr;
    const y = s.y + Math.sin(a) * rr;
    const len = 30 + r() * 80;
    const lean = 6 + r() * 14;
    parts.push(strut([x, y, s.z0 + 6], [x + Math.cos(a) * lean, y + Math.sin(a) * lean, s.z0 - len], 2 + r() * 1.8, r() < 0.5 ? '#5f8d3e' : '#7a5a3a'));
  }
  // Loose rocks drifting beside it (they bob in update()).
  for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
    const a = r() * TAU;
    const d = s.r * (1.05 + r() * 0.35);
    const size = 10 + r() * (s.r > 200 ? 26 : 12);
    const geo = new THREE.IcosahedronGeometry(size, 0);
    const mesh = new THREE.Mesh(outward(facets(triangles(geo, STRATA[1 + (i % 3)]))), brightMaterial());
    mesh.position.set(s.x + Math.cos(a) * d, s.z0 - 60 - r() * 160, s.y + Math.sin(a) * d);
    mesh.rotation.set(r() * 3, r() * 3, r() * 3);
    mesh.castShadow = true;
    mesh.userData.bob = { y: mesh.position.y, ph: r() * TAU, sp: 0.4 + r() * 0.4 };
    floaters.push(mesh);
  }
}
// A geometry's triangles, one colour, for facets().
function triangles(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  const out = [];
  for (let i = 0; i < p.length; i += 9) out.push([[p[i], p[i + 2], p[i + 1]], [p[i + 3], p[i + 5], p[i + 4]], [p[i + 6], p[i + 8], p[i + 7]], hex]);
  return out;
}

// ---------- the sea of cloud ----------
// A sheet far below with soft cloud tops drifting over it (shadowed blue-lilac in the dips), and
// big puffs between it and the islands for depth.
function cloudSea(scene, map, ctx) {
  const S = map.size;
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uTop: { value: new THREE.Color('#ffffff') },
      uMid: { value: new THREE.Color('#cbdaf3') },
      uLow: { value: new THREE.Color('#4f8fe0') },
    }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uLow;
      varying vec3 vW;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
        return v;
      }
      void main() {
        // A cartoon carpet of cloud with holes in it (the sky's blue far below showing through):
        // crisp-edged puffs, lilac where they curl under, white on top.
        vec2 p = vW.xz / 1300.0 + vec2(uTime * 0.010, uTime * 0.004);
        float n = fbm(p) * 0.8 + fbm(p * 2.7 - vec2(uTime * 0.02, 0.0)) * 0.3;
        float cloud = smoothstep(0.47, 0.52, n);
        float lit = smoothstep(0.52, 0.75, n);
        vec3 col = mix(uLow, mix(uMid, uTop, lit), cloud);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  mat.uniforms.uTime = ctx.uniforms.uTime;
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), mat);
  sea.position.set(S / 2, -780, S / 2);
  scene.add(sea);
  // Puffs: under and round the islands, and out at the horizon at their own height.
  const r = rng(91);
  const puffs = [];
  const add = (x, y, z, w, opacity) => {
    const m = new THREE.SpriteMaterial({ map: tex.cloud(puffs.length % 6), transparent: true, opacity, depthWrite: false, fog: true });
    const sp = new THREE.Sprite(m);
    sp.scale.set(w, w * 0.42, 1);
    sp.position.set(x, z, y);
    sp.userData.drift = 6 + r() * 10;
    scene.add(sp);
    puffs.push(sp);
  };
  for (let i = 0; i < 10; i++) {
    const a = r() * TAU;
    const d = 900 + r() * 3200;
    add(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, -480 - r() * 260, 700 + r() * 900, 0.9);
  }
  for (let i = 0; i < 14; i++) {
    const a = r() * TAU;
    const d = 4200 + r() * 3000;
    add(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, -150 + r() * 450, 1600 + r() * 1600, 0.9);
  }
  return (dt) => {
    for (const p of puffs) {
      p.position.x += p.userData.drift * dt;
      if (p.position.x > S / 2 + 7500) p.position.x -= 15000;
    }
  };
}

// ---------- waterfalls ----------
// A sheet of water from an island's side curving out and down into the cloud, streaked and fading
// out as it falls (spring water out of the rock).
function waterfall(scene, d, ctx) {
  const L = 820;
  const segs = 28;
  const ux = Math.cos(d.angle);
  const uy = Math.sin(d.angle);
  const pos = [];
  const uv = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const out = 10 + 80 * Math.sqrt(u);
    const z = d.z - L * Math.pow(u, 1.3);
    const w = d.w * (1 + 0.9 * u);
    for (const sgn of [-1, 1]) {
      pos.push(d.x + ux * out - uy * sgn * (w / 2), z, d.y + uy * out + ux * sgn * (w / 2));
      uv.push((sgn + 1) / 2, u);
    }
  }
  const index = [];
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      varying vec2 vUv;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        // Streaks: columns of brighter water racing down at slightly different speeds.
        float col = floor(vUv.x * 14.0);
        float sp = 1.6 + hash(col) * 1.2;
        float streak = smoothstep(0.55, 1.0, fract(vUv.y * 5.0 - uTime * sp + hash(col + 7.0)));
        vec3 base = mix(vec3(0.42, 0.86, 1.0), vec3(0.85, 0.97, 1.0), streak * 0.8 + vUv.y * 0.35);
        float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        float a = edge * (1.0 - smoothstep(0.55, 1.0, vUv.y)) * (0.75 + 0.25 * streak);
        gl_FragColor = vec4(base, a * 0.92);
        #include <fog_fragment>
      }`,
  });
  mat.uniforms.uTime = ctx.uniforms.uTime;
  const mesh = new THREE.Mesh(g, mat);
  mesh.renderOrder = 2;
  scene.add(mesh);
  // A white lip where it leaves the rock.
  return [post(d.x + ux * 8, d.y + uy * 8, d.z - 6, d.z + 2, d.w * 0.32, '#e9fbff', 10)];
}

// ---------- the fountain and its sprinkler ----------
// A round basin of water on the dais round a column with two bowls (water spilling from both and a
// jet at the top); the sprinkler's two arms are brass pipes turning round it, nozzles spraying.
function sprinkler(scene, map, m, ctx) {
  const z = m.z;
  const parts = [];
  parts.push(lathe(m.x, m.y, z, [[0, 0], [50, 0], [52, 4], [52, 18], [46, 20], [44, 6], [0, 6]], WHITE, 32));
  parts.push(post(m.x, m.y, z + 2, z + 70, 12, CREAM, 14, 10));
  parts.push(lathe(m.x, m.y, z + 46, [[0, 0], [10, 0], [30, 8], [32, 12], [28, 13], [0, 9]], WHITE, 24));
  parts.push(lathe(m.x, m.y, z + 72, [[0, 0], [8, 0], [19, 6], [20, 9], [17, 10], [0, 7]], WHITE, 20));
  parts.push(ball(m.x, m.y, z + 84, 6, GOLD));
  scene.add(piece(parts));
  // Water: the basin's surface, sheets falling off both bowls, the jet (all scroll in the shader).
  const water = nearFade(new THREE.MeshBasicMaterial({ color: '#7fe0ff', transparent: true, opacity: 0.72, depthWrite: false }));
  const surface = new THREE.Mesh(new THREE.CircleGeometry(45, 32).rotateX(-Math.PI / 2), water);
  surface.position.set(m.x, z + 15, m.y);
  const falls = [];
  for (const [r0, z0, r1, z1] of [[31, z + 56, 40, z + 15], [19, z + 80, 26, z + 58]]) {
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, z0 - z1, 24, 1, true), water);
    cone.position.set(m.x, (z0 + z1) / 2, m.y);
    falls.push(cone);
  }
  const jet = new THREE.Mesh(new THREE.ConeGeometry(4, 34, 10, 1, true), water);
  jet.position.set(m.x, z + 104, m.y);
  jet.rotation.x = Math.PI;
  scene.add(surface, jet, ...falls);
  // The arms, built along +x round the hub, then turned.
  const spin = new THREE.Group();
  spin.position.set(m.x, z, m.y);
  const arm = [];
  const h = (m.lo + m.hi) / 2;
  for (let i = 0; i < m.arms; i++) {
    const a = (i / m.arms) * TAU;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const at = (d, dz) => [c * d, sn * d, dz];
    arm.push(strut(at(m.hub - 4, h), at(m.len - 10, h), 6.5, BRASS));
    arm.push(ball(...at(m.len - 6, h), 9, BRASS, 12));
    // A little wheel under the tip, and nozzles along the top.
    arm.push(flatGeo(new THREE.CylinderGeometry(9, 9, 6, 14).rotateZ(Math.PI / 2).rotateY(-a).translate(c * (m.len - 14), 9, sn * (m.len - 14)), SLATE));
    for (let k = 1; k <= 4; k++) arm.push(post(...at(m.hub + ((m.len - m.hub) * k) / 5, 0).slice(0, 2), h + 4, h + 12, 3, darker(BRASS, 0.8), 6));
  }
  spin.add(merged(arm));
  // Spray: an arc of droplets off each nozzle, thrown up and trailing behind the arm as it turns.
  const drops = [];
  const back = -Math.sign(m.speed || 1);
  for (let i = 0; i < m.arms; i++) {
    const a = (i / m.arms) * TAU;
    for (let k = 1; k <= 4; k++) {
      const d = m.hub + ((m.len - m.hub) * k) / 5;
      for (let j = 1; j <= 6; j++) {
        const u = j / 6;
        const ta = a + back * u * 0.32;
        drops.push(new THREE.SphereGeometry(2.6 - u * 1.2, 6, 4).translate(Math.cos(ta) * d, h + 12 + 36 * u - 40 * u * u, Math.sin(ta) * d));
      }
    }
  }
  spin.add(new THREE.Mesh(mergeGeometries(drops), nearFade(new THREE.MeshBasicMaterial({ color: '#d9f6ff', transparent: true, opacity: 0.75, depthWrite: false }))));
  scene.add(spin);
  return {
    update(t) {
      spin.rotation.y = -(m.phase + m.speed * t);
      jet.scale.y = 1 + 0.12 * Math.sin(t * 9);
      for (const f of falls) f.rotation.y = t * 0.6;
    },
  };
}

// ---------- the towers on the low islands ----------
// Shared trim: pilasters up the corners, a coral string course over the arch with frames round
// both of its mouths and a keystone, tall windows with sills, a second band higher up, a cornice.
const SAND = '#ecd0a2';
const GLASS = '#3b5478';
function towerTrim(d, parts, windowsAt) {
  const h = d.w / 2;
  const { x, y } = d;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) parts.push(box(x + sx * (h + 3), y + sy * (h + 3), -6, x + sx * (h - 12), y + sy * (h - 12), d.top - 18, SAND, 2));
  }
  parts.push(box(x - h - 3, y - h - 3, 72, x + h + 3, y + h + 3, 84, CORAL, 2));
  parts.push(box(x - h - 2, y - h - 2, d.top - 92, x + h + 2, y + h + 2, d.top - 84, SAND, 2));
  // The arch's mouths (east and west faces): jambs and a keystone.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) parts.push(box(x + sx * (h + 3), y + sy * 60, 0, x + sx * (h - 2), y + sy * 70, 72, CORAL, 2));
    parts.push(box(x + sx * (h + 4), y - 12, 84, x + sx * (h - 2), y + 12, 112, SAND, 3));
  }
  // Windows: a pair on every face (frame, glass, sill).
  for (const [z0, z1] of windowsAt) {
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * TAU;
      const nx = Math.round(Math.cos(a));
      const ny = Math.round(Math.sin(a));
      for (const off of [-28, 28]) {
        const cx = x + nx * h - ny * off;
        const cy = y + ny * h + nx * off;
        const along = (w, depth, za, zb, colour) => {
          const ax = cx - ny * w + nx * 0; const ay = cy + nx * w;
          const bx = cx + ny * w + nx * depth; const by = cy - nx * w + ny * depth;
          parts.push(box(ax, ay, za, bx, by, zb, colour, 2));
        };
        along(13, 2.5, z0 - 4, z1 + 4, SAND);
        along(9, 3.5, z0, z1, GLASS);
        along(15, 6, z0 - 8, z0 - 3, CORAL);
      }
    }
  }
  parts.push(box(x - h - 6, y - h - 6, d.top - 18, x + h + 6, y + h + 6, d.top - 6, CORAL, 2));
  parts.push(box(x - h - 10, y - h - 10, d.top - 6, x + h + 10, y + h + 10, d.top + 6, WHITE, 3));
}
// The bell tower: an open belfry on four piers, a bronze bell swinging inside, a teal onion dome
// and a gold finial.
function belltower(scene, d) {
  const parts = [];
  towerTrim(d, parts, [[124, 176], [218, 262]]);
  const { x, y } = d;
  const h = d.w / 2 - 6;
  const z = d.top + 6;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(box(x + sx * h, y + sy * h, z, x + sx * (h - 26), y + sy * (h - 26), z + 110, CREAM, 3));
  for (const sx of [-1, 1]) {
    parts.push(box(x + sx * h, y - h, z + 96, x + sx * (h - 18), y + h, z + 116, CREAM, 3));
    parts.push(box(x - h, y + sx * h, z + 96, x + h, y + sx * (h - 18), z + 116, CREAM, 3));
  }
  parts.push(box(x - h - 6, y - h - 6, z + 116, x + h + 6, y + h + 6, z + 128, CORAL, 2));
  parts.push(lathe(x, y, z + 128, [[0, 0], [62, 0], [70, 30], [64, 62], [40, 100], [14, 128], [4, 146], [0, 150]], TEAL, 24));
  parts.push(post(x, y, z + 276, z + 300, 3, GOLD, 8), ball(x, y, z + 306, 8, GOLD));
  scene.add(piece(parts));
  // The bell, hung from the belfry's ceiling.
  const bell = new THREE.Group();
  bell.position.set(x, z + 96, y);
  bell.add(merged([lathe(0, 0, -64, [[0, 0], [30, 0], [28, 6], [22, 22], [19, 44], [14, 58], [0, 64]], '#c98a3a', 20), ball(0, 0, -62, 6, '#8a5a2a')]));
  scene.add(bell);
  return (t) => { bell.rotation.x = Math.sin(t * 1.3) * 0.18; };
}
// The clock tower: four clock faces near the top (their hands keep the game's time, briskly), a
// steep coral roof and a gold ball.
function clocktower(scene, d) {
  const parts = [];
  towerTrim(d, parts, [[124, 168]]);
  const { x, y } = d;
  const h = d.w / 2;
  const z = d.top + 6;
  parts.push(box(x - h + 8, y - h + 8, z, x + h - 8, y + h - 8, z + 50, CREAM, 3));
  const roof = new THREE.ConeGeometry(h * 1.32, 170, 4, 1).rotateY(Math.PI / 4).translate(x, z + 50 + 85, y);
  parts.push(flatGeo(roof, '#e8505f'));
  parts.push(ball(x, y, z + 226, 10, GOLD));
  const hands = [];
  const faceZ = d.top - 70;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    const fx = x + nx * (h + 2);
    const fy = y + ny * (h + 2);
    const disc = new THREE.CylinderGeometry(46, 46, 4, 32).rotateZ(Math.PI / 2).rotateY(-a).translate(fx, faceZ, fy);
    parts.push(flatGeo(disc, WHITE));
    const rim = new THREE.TorusGeometry(46, 4, 6, 32).rotateY(Math.PI / 2 - a).translate(fx, faceZ, fy);
    parts.push(flatGeo(rim, CORAL));
    for (let k = 0; k < 12; k++) {
      const b = (k / 12) * TAU;
      const tick = new THREE.BoxGeometry(2, k % 3 ? 5 : 10, 3).translate(0, 36, 0).rotateZ(-b).rotateY(Math.PI / 2 - a).translate(fx + nx * 2.5, faceZ, fy + ny * 2.5);
      parts.push(flatGeo(tick, SLATE));
    }
    for (const [len, w, kind] of [[34, 3.5, 'min'], [22, 5, 'hour']]) {
      const hand = new THREE.Mesh(new THREE.BoxGeometry(w, len, 2).translate(0, len / 2 - 4, 0), new THREE.MeshBasicMaterial({ color: SLATE }));
      const holder = new THREE.Group();
      holder.position.set(fx + nx * 4, faceZ, fy + ny * 4);
      holder.rotation.y = Math.PI / 2 - a;
      holder.add(hand);
      scene.add(holder);
      hands.push({ hand, kind });
    }
  }
  scene.add(piece(parts));
  return (t) => {
    for (const { hand, kind } of hands) hand.rotation.z = -(kind === 'min' ? (t / 60) * TAU : (t / 720) * TAU) * 6;
  };
}

// ---------- the high islands' landmarks ----------
// A windmill: a tapering white tower with coral bands, a dark door facing the bridge, a red cap and
// four lattice sails turning slowly out over the edge.
function windmill(scene, d) {
  const parts = [];
  const { x, y, z, out } = d;
  parts.push(post(x, y, z - 4, z + 210, 64, WHITE, 20, 44));
  for (const zz of [z + 60, z + 150]) parts.push(post(x, y, zz, zz + 10, 60 - (zz - z) * 0.095, CORAL, 20, 58 - (zz - z + 10) * 0.095));
  parts.push(lathe(x, y, z + 206, [[0, 0], [52, 0], [50, 22], [36, 44], [16, 56], [0, 60]], '#e8505f', 20));
  parts.push(box(x - out * 66, y - 18, z, x - out * 58, y + 18, z + 52, SLATE, 3));
  for (const zz of [z + 100, z + 170]) parts.push(box(x - out * (62 - (zz - z) * 0.1), y - 9, zz, x - out * (54 - (zz - z) * 0.1), y + 9, zz + 22, '#7ec8ff', 2));
  scene.add(piece(parts));
  // The sails: built in the yz plane round a hub, turned about the axis pointing out.
  const hub = new THREE.Group();
  hub.position.set(x + out * 54, z + 190, y);
  const sail = [];
  for (let i = 0; i < 4; i++) {
    const g = [];
    g.push(new THREE.BoxGeometry(6, 152, 6).translate(0, 82, 0));
    g.push(new THREE.BoxGeometry(3, 120, 38).translate(-2, 98, 21));
    for (let k = 0; k < 6; k++) g.push(new THREE.BoxGeometry(5, 4, 42).translate(0, 44 + k * 21, 21));
    const geo = mergeGeometries(g.map((q) => q.toNonIndexed())).rotateX((i / 4) * TAU);
    sail.push(flatGeo(geo, i % 2 ? WHITE : '#fff1d6'));
  }
  sail.push(flatGeo(new THREE.CylinderGeometry(12, 12, 16, 12).rotateZ(Math.PI / 2), SLATE));
  hub.add(merged(sail));
  hub.rotation.y = out > 0 ? 0 : Math.PI;
  scene.add(hub);
  return (t) => { hub.children[0].rotation.x = t * 0.7; };
}
// An observatory: a white drum, a silver dome with a slit and a brass telescope poking out of it,
// the dome slowly turning to follow something across the sky.
function observatory(scene, d) {
  const parts = [];
  const { x, y, z, out } = d;
  parts.push(post(x, y, z - 4, z + 112, 80, WHITE, 28));
  parts.push(post(x, y, z + 40, z + 52, 81, CORAL, 28));
  parts.push(box(x - out * 82, y - 20, z, x - out * 74, y + 20, z + 58, SLATE, 3));
  for (const a of [0.8, 2.3, 3.9, 5.4]) parts.push(box(x + Math.cos(a) * 80 - 8, y + Math.sin(a) * 80 - 8, z + 70, x + Math.cos(a) * 80 + 8, y + Math.sin(a) * 80 + 8, z + 96, '#7ec8ff', 3));
  scene.add(piece(parts));
  const dome = new THREE.Group();
  dome.position.set(x, z + 112, y);
  const dp = [];
  dp.push(flatGeo(new THREE.SphereGeometry(84, 28, 14, 0, TAU, 0, Math.PI / 2), '#d6e6f4'));
  dp.push(flatGeo(new THREE.BoxGeometry(30, 70, 150).translate(0, 50, 30).rotateX(-0.45), SLATE));
  const scope = new THREE.CylinderGeometry(11, 15, 130, 14).rotateX(Math.PI / 2 - 0.6).translate(0, 74, 62);
  dp.push(flatGeo(scope, BRASS));
  dp.push(flatGeo(new THREE.TorusGeometry(15, 3, 6, 14).rotateX(-0.6).translate(0, 74 + 62 * Math.sin(0.6) * 0.95, 62 + 62 * Math.cos(0.6) * 0.95), darker(BRASS, 0.75)));
  dome.add(merged(dp));
  scene.add(dome);
  return (t) => { dome.rotation.y = Math.sin(t * 0.05) * 1.2 + (out > 0 ? 0 : Math.PI); };
}

// ---------- flower beds and lamps ----------
const FLOWERS = ['#ff6f91', '#ffd23f', '#b07cff', '#ffffff', '#ff9a3c'];
// Flower beds just inside each island's rim, clear of everything a kart wants (bridges, pads,
// spawns, boxes): soil and a scatter of flowers. Nothing to bump into: they're painted on, nearly.
function flowerBeds(map, parts) {
  const r = rng(57);
  const busy = [];
  for (const road of map.roads) for (const o of road.samples) busy.push([o.x, o.y, road.w / 2 + 50]);
  for (const p of map.pads) busy.push([p.x, p.y, p.r + 60], [p.tx, p.ty, 90]);
  for (const p of map.spawns) busy.push([p.x, p.y, 80]);
  for (const b of map.itemBoxes) busy.push([b.x, b.y, 60]);
  for (const s of map.solids) if (s.type === 0 && s.kind !== 'lawn') busy.push([(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2 + 40]);
  for (const s of map.solids) if (s.type === 2 && s.kind !== 'lawn') busy.push([s.x, s.y, s.r + 50]);
  for (const s of map.solids) if (s.type === 1) busy.push([(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2 + 30]);
  const free = (x, y, rad) => busy.every(([bx, by, br]) => Math.hypot(bx - x, by - y) > br + rad);
  for (const s of map.solids) {
    if (s.type !== 2 || s.kind !== 'lawn' || s.r < 200) continue;
    let made = 0;
    for (let i = 0; i < 60 && made < Math.round(s.r / 70); i++) {
      const a = r() * TAU;
      const rad = 34 + r() * 22;
      const d = s.r - rad - 22 - r() * 30;
      const x = s.x + Math.cos(a) * d;
      const y = s.y + Math.sin(a) * d;
      if (!free(x, y, rad)) continue;
      busy.push([x, y, rad + 30]);
      made++;
      const soil = new THREE.CylinderGeometry(rad, rad + 3, 3, 18).translate(x, s.z1 + 1.2, y);
      parts.push(flatGeo(soil, '#8a5a3c'));
      const ring = new THREE.TorusGeometry(rad + 2, 2.4, 4, 24).rotateX(Math.PI / 2).translate(x, s.z1 + 2.2, y);
      parts.push(flatGeo(ring, WHITE));
      const hue = FLOWERS[Math.floor(r() * FLOWERS.length)];
      const hue2 = FLOWERS[Math.floor(r() * FLOWERS.length)];
      for (let k = 0; k < rad / 3.2; k++) {
        const fa = r() * TAU;
        const fd = Math.sqrt(r()) * (rad - 5);
        const fx = x + Math.cos(fa) * fd;
        const fy = y + Math.sin(fa) * fd;
        parts.push(post(fx, fy, s.z1 + 2, s.z1 + 7, 0.8, '#3f8f3a', 4));
        parts.push(ball(fx, fy, s.z1 + 8.5, 3 + r() * 1.5, k % 3 ? hue : hue2, 5));
      }
    }
  }
}
// Lamp posts on the rails, warm lanterns on top: a pair at each end of a bridge (like gateposts,
// out of the camera's way across it), and spaced out along the boardwalks' outer rails.
function lamps(map, parts, lights) {
  for (const road of map.roads) {
    if (!road.curb) continue;
    const sides = road.curb.side ? [road.curb.side] : [1, -1];
    const total = road.samples[road.samples.length - 1].s;
    const inset = road.curb.inset || 0;
    const spots = [];
    if (road.kind === 'bridge') spots.push(inset + 8, total - inset - 8);
    else for (let s = inset + 140; s < total - inset - 100; s += 300) spots.push(s);
    for (const sd of sides) {
      for (const s of spots) {
        const o = road.samples.reduce((best, q) => (Math.abs(q.s - s) < Math.abs(best.s - s) ? q : best), road.samples[0]);
        const v = sd * (road.w / 2 - road.curb.w / 2);
        const x = o.x - o.uy * v;
        const y = o.y + o.ux * v;
        const z = o.z + o.bank * v + road.curb.h;
        parts.push(post(x, y, z, z + 62, 2.6, SLATE, 6));
        parts.push(post(x, y, z + 62, z + 66, 7, SLATE, 8));
        lights.push(new THREE.SphereGeometry(6.5, 10, 8).translate(x, z + 72, y));
        parts.push(flatGeo(new THREE.ConeGeometry(9, 8, 8).translate(x, z + 81, y), SLATE));
      }
    }
  }
}

// ---------- the sky ----------
// Hot-air balloons drifting round in wide slow circles, bobbing.
const BALLOONS = [[CORAL, WHITE], [TEAL, '#ffd23f'], ['#8f6bff', WHITE], ['#ff9a3c', '#3b8cf0']];
function balloons(scene, map) {
  const C = map.size / 2;
  const list = [];
  BALLOONS.forEach(([a, b], i) => {
    const g = new THREE.Group();
    const profile = [[0, 0], [24, 6], [58, 40], [86, 100], [92, 150], [80, 200], [50, 236], [0, 252]];
    const envelope = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 16).toNonIndexed();
    // Gores in two colours (vertical stripes).
    const pos = envelope.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const ca = new THREE.Color(a);
    const cb = new THREE.Color(b);
    for (let v = 0; v < pos.count; v += 3) {
      const mx = (pos.getX(v) + pos.getX(v + 1) + pos.getX(v + 2)) / 3;
      const mz = (pos.getZ(v) + pos.getZ(v + 1) + pos.getZ(v + 2)) / 3;
      const k = Math.floor(((Math.atan2(mz, mx) + Math.PI) / TAU) * 16) % 2;
      for (let j = 0; j < 3; j++) col.set(k ? [ca.r, ca.g, ca.b] : [cb.r, cb.g, cb.b], (v + j) * 3);
    }
    const eg = flatGeo(envelope, a);
    eg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    eg.setAttribute('aCol2', new THREE.BufferAttribute(col.slice(), 3));
    eg.translate(0, 70, 0);
    const parts = [eg];
    parts.push(flatGeo(new THREE.BoxGeometry(34, 26, 34).translate(0, 13, 0), '#a8703e'));
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      parts.push(strut([sx * 16, sz * 16, 26], [sx * 24, sz * 24, 76], 0.8, '#5b4a3a'));
    }
    g.add(merged(parts, false));
    const r = rng(300 + i);
    const ring = 2200 + i * 520 + r() * 300;
    const y0 = 160 + r() * 650;
    g.userData = { ring, y0, a0: r() * TAU, sp: (0.012 + r() * 0.01) * (i % 2 ? -1 : 1), bob: r() * TAU };
    scene.add(g);
    list.push(g);
  });
  return (t) => {
    for (const g of list) {
      const u = g.userData;
      const a = u.a0 + t * u.sp;
      g.position.set(C + Math.cos(a) * u.ring, u.y0 + Math.sin(t * 0.4 + u.bob) * 18, C + Math.sin(a) * u.ring);
      g.rotation.y = -a;
    }
  };
}
// An airship circling far out: a white envelope with a coral stripe, fins, a gondola, a turning prop.
function airship(scene, map) {
  const C = map.size / 2;
  const g = new THREE.Group();
  const parts = [];
  parts.push(flatGeo(new THREE.SphereGeometry(100, 24, 14).scale(3.4, 1, 1), WHITE));
  parts.push(flatGeo(new THREE.SphereGeometry(101.5, 24, 4, 0, TAU, Math.PI / 2 - 0.12, 0.24).scale(3.4, 1, 1), CORAL));
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.BoxGeometry(90, 6, 70).translate(-300, 0, 60).rotateX((i / 4) * TAU + Math.PI / 4);
    parts.push(flatGeo(fin, i % 2 ? CORAL : WHITE));
  }
  parts.push(flatGeo(new THREE.BoxGeometry(110, 34, 40).translate(20, -118, 0), CREAM));
  for (let k = -2; k <= 2; k++) parts.push(flatGeo(new THREE.BoxGeometry(12, 12, 2).translate(20 + k * 20, -112, 21), '#7ec8ff'));
  g.add(merged(parts, false));
  const prop = new THREE.Mesh(new THREE.BoxGeometry(4, 80, 10), new THREE.MeshBasicMaterial({ color: SLATE }));
  prop.position.set(-350, 0, 0);
  g.add(prop);
  scene.add(g);
  return (t) => {
    const a = t * 0.02 + 1.2;
    g.position.set(C + Math.cos(a) * 5200, 1100 + Math.sin(t * 0.3) * 30, C + Math.sin(a) * 5200);
    g.rotation.y = -a - Math.PI / 2;
    prop.rotation.x = t * 12;
  };
}
// Far-off islands: big, simple, hazy with distance, a few trees on top.
function farIslands(scene, map) {
  const C = map.size / 2;
  const r = rng(808);
  const parts = [];
  const floaters = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + r() * 0.5;
    const d = 5200 + r() * 3000;
    const s = { x: C + Math.cos(a) * d, y: C + Math.sin(a) * d, r: 380 + r() * 520, z0: -120 + r() * 500 };
    s.z1 = s.z0 + 60;
    parts.push(post(s.x, s.y, s.z0, s.z1, s.r, '#7fd06a', 20));
    parts.push(post(s.x, s.y, s.z0 - 40, s.z0 + 1, s.r * 0.99, STRATA[0], 20));
    underside({ ...s, z0: s.z0 - 40 }, 900 + i, parts, floaters);
    for (let k = 0; k < 5; k++) {
      const ta = r() * TAU;
      const td = r() * s.r * 0.7;
      const tx = s.x + Math.cos(ta) * td;
      const ty = s.y + Math.sin(ta) * td;
      const th = 90 + r() * 90;
      parts.push(post(tx, ty, s.z1, s.z1 + th * 0.4, 12, '#7a5a3a', 6));
      parts.push(flatGeo(new THREE.ConeGeometry(th * 0.42, th, 7).translate(tx, s.z1 + th * 0.4 + th / 2, ty), '#3f9e4d'));
    }
  }
  const m = merged(parts, false);
  m.receiveShadow = false;
  scene.add(m);
  for (const f of floaters) scene.add(f);
}
// A flock of small birds wheeling round, wings flapping.
function birds(scene, map) {
  const C = map.size / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-10, 3, 0, 0, 0, 3, 0, 0, -3, 10, 3, 0, 0, 0, -3, 0, 0, 3], 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color: '#4a5468', side: THREE.DoubleSide });
  const list = [];
  const r = rng(4242);
  for (let i = 0; i < 14; i++) {
    const b = new THREE.Mesh(geo, mat);
    b.userData = { ring: 1500 + r() * 2200, y: 260 + r() * 520, a0: r() * TAU, sp: 0.05 + r() * 0.04, ph: r() * TAU };
    scene.add(b);
    list.push(b);
  }
  return (t) => {
    for (const b of list) {
      const u = b.userData;
      const a = u.a0 + t * u.sp;
      b.position.set(C + Math.cos(a) * u.ring, u.y + Math.sin(t + u.ph) * 20, C + Math.sin(a) * u.ring);
      b.rotation.y = -a;
      b.scale.set(1, 1 + Math.sin(t * 9 + u.ph) * 0.8, 1);
    }
  };
}

// ---------- the whole dressing ----------
export function buildSkyGardens(scene, map, ctx) {
  const statics = [];
  const floaters = [];
  const tickers = [];
  const lights = [];
  let seed = 1;
  for (const s of map.solids) if (s.type === 2 && s.kind === 'lawn') underside(s, seed++, statics, floaters);
  for (const d of map.deco || []) {
    if (d.kind === 'waterfall') statics.push(...waterfall(scene, d, ctx));
    else if (d.kind === 'belltower') tickers.push(belltower(scene, d));
    else if (d.kind === 'clocktower') tickers.push(clocktower(scene, d));
    else if (d.kind === 'windmill') tickers.push(windmill(scene, d));
    else if (d.kind === 'observatory') tickers.push(observatory(scene, d));
  }
  // A clipped bush in every pot.
  for (const s of map.solids) {
    if (s.type !== 2 || s.kind !== 'planter') continue;
    statics.push(ball(s.x, s.y, s.z1 + 22, s.r * 0.86, '#4aa64a', 14));
    statics.push(post(s.x, s.y, s.z1 - 4, s.z1 + 1, s.r + 3, '#c4653a', 24));
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + s.x;
      statics.push(ball(s.x + Math.cos(a) * s.r * 0.6, s.y + Math.sin(a) * s.r * 0.6, s.z1 + 22 + s.r * 0.55, 4, FLOWERS[k % FLOWERS.length], 6));
    }
  }
  flowerBeds(map, statics);
  lamps(map, statics, lights);
  scene.add(merged(statics));
  for (const f of floaters) scene.add(f);
  if (lights.length) scene.add(glow(mergeGeometries(lights), '#fff3c4'));
  const drift = cloudSea(scene, map, ctx);
  tickers.push(balloons(scene, map), airship(scene, map), birds(scene, map));
  farIslands(scene, map);
  let last = null;
  return {
    // Drawn here instead of by the bright kit.
    skip: new Set(['windmill', 'observatory']),
    mover(m) {
      if (m.type === 'sweeper' && m.kind === 'sprinkler') return sprinkler(scene, map, m, ctx);
      return null;
    },
    update(t) {
      const dt = last === null ? 0 : Math.min(0.1, Math.max(0, t - last));
      last = t;
      for (const f of tickers) f(t);
      drift(dt);
      for (const f of floaters) f.position.y = f.userData.bob.y + Math.sin(t * f.userData.bob.sp + f.userData.bob.ph) * 10;
    },
  };
}
