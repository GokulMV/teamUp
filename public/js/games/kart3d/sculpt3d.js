// Sculpted arenas (The Cinder Bowl): the low-poly look. The ground is drawn face by face, each
// triangle one flat colour picked by its height and steepness (charred rock in the crater, bright
// grass on the hills, earthy cliffs, snow on the peaks); the viaduct is one smooth mesh along the
// road's own samples (so the wheels run on what you see), with red-and-white kerbs, a dashed centre
// line and concrete pillars; neon arches stand over both ends. Pines, boulders and cliff rocks are
// merged, faceted meshes; tyre stacks bounce when hit.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTexture } from './world.js';

const TAU = Math.PI * 2;
// A fixed little hash: the same "random" look on every machine and every load.
const hash = (a, b, c = 0) => {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const col = (hex) => new THREE.Color(hex);
const lerpCol = (a, b, t) => a.clone().lerp(b, Math.max(0, Math.min(1, t)));

// Flat-coloured geometry: every vertex of `geo` gets colour `c` (geometry made non-indexed).
function paint(geo, c) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
const faceted = (geos) => {
  const g = mergeGeometries(geos);
  g.computeVertexNormals(); // non-indexed: one normal per face, crisp facets
  return g;
};
const lowpolyMat = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

// ---------- the ground ----------
const BANDS = {
  rock: col('#2b2d2f'), ember: col('#6a3326'), ash: col('#5a4a40'), basalt: col('#5c4d49'), basaltDark: col('#4a3d3a'), lip: col('#8d847d'),
  grass: col('#5ec962'), grassDark: col('#48b052'), grassLight: col('#7fd86f'),
  dirt: col('#a87b4f'), cliff: col('#8c6239'), cliffDark: col('#6f4a2b'), stone: col('#8f8274'), snow: col('#e6f2ff'),
};
// The colour of one face: by height, steepness (up: the y of its normal) and how near the crater
// (its distance from the middle over the crater's radius). The crater is black basalt down to the
// lava, a ring of grey rock round its lip, then straight onto grass: crisp edges, no smudges.
function groundColour(h, up, crater, n, inBowl) {
  const b = BANDS;
  const edge = 1.04 + (n - 0.5) * 0.06; // a ragged line between rock and grass
  if (crater < edge - 0.1) return (n > 0.5 ? b.basalt : b.basaltDark).clone().lerp(b.ember, h < -30 ? 0.5 : 0);
  if (crater < edge) return b.lip.clone().offsetHSL(0, 0, (n - 0.5) * 0.06);
  if (inBowl) {
    // Inside the bowl it's all grass: steeper faces just a shade darker.
    const g = lerpCol(b.grassDark, b.grassLight, 0.35 + h / 140 - (1 - up) * 1.5);
    return g.offsetHSL(0, 0, (n - 0.5) * 0.05);
  }
  if (up < 0.72) {
    // Cliffs: earth low down, grey stone higher up, snow on the tops.
    if (h > 520) return lerpCol(b.stone, b.snow, (h - 520) / 140);
    return lerpCol(up < 0.55 ? b.cliffDark : b.cliff, b.stone, (h - 120) / 400);
  }
  if (h > 560) return b.snow;
  if (h > 150) return lerpCol(b.dirt, b.stone, (h - 150) / 300);
  if (up < 0.8) return lerpCol(b.dirt, b.grassDark, (up - 0.72) / 0.08);
  const g = lerpCol(b.grassDark, b.grassLight, 0.35 + h / 140);
  return g.offsetHSL(0, 0, (n - 0.5) * 0.05);
}

export function buildLowPolyLand(scene, map) {
  const land = map.land;
  const { n, cell: c, h } = land;
  const crater = (map.terrain.craters || [])[0];
  const bowl = map.terrain.bowl;
  const quads = (n - 1) * (n - 1);
  const pos = new Float32Array(quads * 18);
  const colour = new Float32Array(quads * 18);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  let o = 0;
  const tri = (a, b, d, i, j, t) => {
    v[0].set(a[0], a[1], a[2]); v[1].set(b[0], b[1], b[2]); v[2].set(d[0], d[1], d[2]);
    e1.subVectors(v[1], v[0]);
    e2.subVectors(v[2], v[0]);
    const nrm = e1.cross(e2).normalize();
    const up = Math.abs(nrm.y);
    const mh = (a[1] + b[1] + d[1]) / 3;
    const cx = (a[0] + b[0] + d[0]) / 3;
    const cz = (a[2] + b[2] + d[2]) / 3;
    const cr = crater ? Math.hypot(cx - crater.x, cz - crater.y) / crater.r : 9;
    const inBowl = !!bowl && Math.hypot(cx - bowl.x, cz - bowl.y) < bowl.r + 40;
    const cc = groundColour(mh, up, cr, hash(i, j, t), inBowl);
    for (const p of v) {
      pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
      colour[o] = cc.r; colour[o + 1] = cc.g; colour[o + 2] = cc.b;
      o += 3;
    }
  };
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const p00 = [i * c, h[a], j * c];
      const p10 = [(i + 1) * c, h[a + 1], j * c];
      const p01 = [i * c, h[a + n], (j + 1) * c];
      const p11 = [(i + 1) * c, h[a + n + 1], (j + 1) * c];
      // The same split as the physics (kart-layers makeTerrain): the diagonal from p10 to p01.
      tri(p00, p01, p10, i, j, 0);
      tri(p10, p01, p11, i, j, 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, lowpolyMat());
  mesh.receiveShadow = true;
  scene.add(mesh);
  // A skirt of rock down from the ground's outer edge, so it's never open underneath.
  const sk = [];
  const rockCol = BANDS.cliffDark;
  const edgeLine = (pts) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const ay = land.at(ax, az);
      const by = land.at(bx, bz);
      sk.push(ax, ay, az, bx, by, bz, bx, -400, bz, ax, ay, az, bx, -400, bz, ax, -400, az);
    }
  };
  const S = (n - 1) * c;
  const line = (f) => Array.from({ length: n }, (_, k) => f(k * c));
  edgeLine(line((t) => [t, 0]));
  edgeLine(line((t) => [S, t]));
  edgeLine(line((t) => [S - t, S]));
  edgeLine(line((t) => [0, S - t]));
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.Float32BufferAttribute(sk, 3));
  skirt.computeVertexNormals();
  scene.add(new THREE.Mesh(skirt, new THREE.MeshLambertMaterial({ color: rockCol, side: THREE.DoubleSide })));
  return mesh;
}

// ---------- the lava pool ----------
// Glowing, slowly churning lava (value noise in the shader): a dark crust breaking up over bright
// orange and yellow, hotter where it meets the shore.
export function buildLavaPool(scene, map, ctx) {
  const lz = map.liquid.z;
  for (const c of map.terrain.craters || []) {
    // The shoreline: at each angle, how far out the ground stays under the lava.
    const N = 96;
    const shoreR = [];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * TAU;
      let r = 0;
      while (r < c.r * 1.2 && map.land.at(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r) < lz) r += 4;
      shoreR.push(r);
    }
    const pool = Math.max(...shoreR);
    if (!pool) continue;
    // Cracked magma: plates of black crust (Voronoi cells, slowly drifting) split by glowing seams,
    // with open pools of molten rock between; the seams pulse.
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: ctx.uniforms.uTime },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime; varying vec2 vP;
        vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
        float h1(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h1(i), h1(i + vec2(1.0, 0.0)), f.x), mix(h1(i + vec2(0.0, 1.0)), h1(i + vec2(1.0, 1.0)), f.x), f.y); }
        // Distance to the nearest cell centre, and how far from a seam (second nearest minus nearest).
        vec2 cells(vec2 x, float t){
          vec2 n = floor(x); vec2 f = fract(x);
          float f1 = 9.0; float f2 = 9.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = h2(n + g);
            o = 0.5 + 0.4 * sin(t + 6.2831 * o);
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
          }
          return vec2(sqrt(f1), sqrt(f2) - sqrt(f1));
        }
        void main() {
          vec2 p = vP / 46.0;
          float t = uTime * 0.25;
          vec2 c = cells(p + vec2(t * 0.15, -t * 0.1), t);
          float seam = 1.0 - smoothstep(0.0, 0.16, c.y);
          float pool = smoothstep(0.55, 0.75, vn(p * 0.45 + vec2(-t * 0.2, t * 0.13)));
          float pulse = 0.8 + 0.2 * sin(uTime * 2.3 + vn(p * 2.0) * 6.0);
          vec3 crust = mix(vec3(0.05, 0.022, 0.02), vec3(0.13, 0.04, 0.025), vn(p * 3.0)) * (0.75 + 0.5 * c.x);
          vec3 molten = mix(vec3(0.85, 0.12, 0.01), vec3(1.6, 0.55, 0.05), vn(p * 1.3 + t));
          vec3 col = mix(crust, molten, max(pool, 0.0));
          vec3 glow = mix(vec3(0.9, 0.16, 0.01), vec3(2.1, 0.95, 0.15), seam * seam);
          col = mix(col, glow * pulse, seam * (1.0 - pool * 0.6));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    // One disc over the whole crater (the walls hide what's above the shore); vP from its middle.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(pool + 40, 96).rotateX(-Math.PI / 2), mat);
    disc.position.set(c.x, lz, c.y);
    scene.add(disc);
    // Its glow on everything round it.
    const light = new THREE.PointLight(0xff7a2a, 3, pool * 4, 1.4);
    light.position.set(c.x, lz + 60, c.y);
    scene.add(light);
    // Dark rocks all along the shore, half sunk in the lava.
    const rocks = [];
    for (let k = 0; k < N; k++) {
      if (k % 2 && hash(k, 6, 9) < 0.5) continue;
      const a = (k / N) * TAU + (hash(k, 3, 9) - 0.5) * 0.05;
      const rr = shoreR[k] + (hash(k, 4, 9) - 0.5) * 14;
      const x = c.x + Math.cos(a) * rr;
      const y = c.y + Math.sin(a) * rr;
      rocks.push(rock({ x, y, z: lz - 8, s: 20 + hash(k, 5, 9) * 22, seed: 500 + k }, col('#4a3e3b')));
    }
    const shore = new THREE.Mesh(faceted(rocks), lowpolyMat());
    shore.castShadow = true;
    shore.receiveShadow = true;
    scene.add(shore);
  }
}

// ---------- the viaduct ----------
// One mesh for the whole road from its samples: the deck (asphalt, a dashed white centre line), the
// kerbs (red and white blocks), the deck's sides (a painted fascia over concrete) and its underside.
export function buildRoad(scene, map, road) {
  const S = road.samples;
  const hw = road.w / 2;
  const cw = road.curb ? road.curb.w : 0;
  const ch = road.curb ? road.curb.h : 0;
  const th = road.thick;
  const C = {
    asphalt: col('#3a3e4a'), asphaltB: col('#353845'), line: col('#f4f1e8'), red: col('#e5383b'), white: col('#f7f5ef'),
    fascia: col('#ff8a1f'), concrete: col('#ece2d2'), under: col('#a39b8f'),
  };
  const pos = [];
  const cols = [];
  // A point across the road at sample i: v across (left +), dz up from the deck surface there.
  const P = (i, v, dz) => {
    const o = S[i];
    const x = o.x - o.uy * v;
    const y = o.y + o.ux * v;
    return [x, o.z + o.bank * v + dz, y];
  };
  const quad = (a, b, cc, d, colour) => {
    for (const p of [a, b, cc, a, cc, d]) { pos.push(...p); cols.push(colour.r, colour.g, colour.b); }
  };
  for (let i = 0; i < S.length - 1; i++) {
    const j = i + 1;
    const stripe = i % 2 === 0;
    const asph = stripe ? C.asphalt : C.asphaltB;
    // Deck top between the kerbs, with the centre line dashed every other piece.
    const inner = hw - cw;
    quad(P(i, -inner, 0), P(j, -inner, 0), P(j, -3, 0), P(i, -3, 0), asph);
    quad(P(i, 3, 0), P(j, 3, 0), P(j, inner, 0), P(i, inner, 0), asph);
    quad(P(i, -3, 0.1), P(j, -3, 0.1), P(j, 3, 0.1), P(i, 3, 0.1), stripe ? C.line : asph);
    // Kerbs: a block along each edge, red and white in turn.
    if (cw) {
      const kc = stripe ? C.red : C.white;
      for (const side of [-1, 1]) {
        const a = side * inner;
        const b = side * hw;
        quad(P(i, a, ch), P(j, a, ch), P(j, b, ch), P(i, b, ch), kc); // top
        quad(P(i, a, 0), P(j, a, 0), P(j, a, ch), P(i, a, ch), kc); // inner face
      }
    }
    // The deck's sides: the kerb's outer face carries on down as a painted fascia, then concrete
    // (down to the ground where the deck is an embankment: see kart-layers.js roadSolids).
    const thi = Math.max(th, S[i].fill || 0);
    const thj = Math.max(th, S[j].fill || 0);
    for (const side of [-1, 1]) {
      const v = side * hw;
      quad(P(i, v, ch), P(j, v, ch), P(j, v, -5), P(i, v, -5), C.fascia);
      quad(P(i, v, -5), P(j, v, -5), P(j, v, -thj), P(i, v, -thi), C.concrete);
    }
    quad(P(i, -hw, -thi), P(j, -hw, -thj), P(j, hw, -thj), P(i, hw, -thi), C.under);
  }
  // The two ends of the deck (where they show above the ground).
  for (const i of [0, S.length - 1]) {
    const d = Math.max(th, S[i].fill || 0);
    quad(P(i, -hw, ch), P(i, hw, ch), P(i, hw, -d), P(i, -hw, -d), C.concrete);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  // Pillars: tapered concrete columns with a cap under the deck and an orange band.
  const parts = [];
  for (const s of map.solids) {
    if (s.type !== 2 || s.kind !== 'pillar') continue;
    const hgt = s.z1 - s.z0;
    parts.push(paint(new THREE.CylinderGeometry(s.r, s.r * 1.18, hgt, 10).translate(s.x, s.z0 + hgt / 2, s.y), C.concrete));
    parts.push(paint(new THREE.CylinderGeometry(s.r * 1.5, s.r * 1.05, 14, 10).translate(s.x, s.z1 - 7, s.y), C.concrete));
    parts.push(paint(new THREE.CylinderGeometry(s.r * 1.02, s.r * 1.02, 10, 10).translate(s.x, s.z1 - 30, s.y), C.fascia));
  }
  if (parts.length) {
    const pillars = new THREE.Mesh(faceted(parts), lowpolyMat());
    pillars.castShadow = true;
    pillars.receiveShadow = true;
    scene.add(pillars);
  }
  return mesh;
}

// ---------- arches over the viaduct's ends ----------
function neonTexture(text) {
  return canvasTexture(512, 128, (c, w, h) => {
    c.fillStyle = '#16123a';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#ff4fd8';
    c.lineWidth = 8;
    c.strokeRect(8, 8, w - 16, h - 16);
    c.font = '900 64px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = '#7df9ff';
    c.shadowBlur = 18;
    c.fillStyle = '#e8fdff';
    c.fillText(text, w / 2, h / 2 + 4, w - 60);
  });
}
function buildGates(scene, map) {
  const posts = [];
  const C = { post: col('#f0ebe2'), band: col('#e5383b'), beam: col('#2f2a4a') };
  for (const s of map.solids) {
    if (s.type !== 2 || s.kind !== 'archpost') continue;
    const hgt = s.z1 - s.z0;
    posts.push(paint(new THREE.CylinderGeometry(s.r * 0.9, s.r * 1.15, hgt, 8).translate(s.x, s.z0 + hgt / 2, s.y), C.post));
    for (let k = 0; k < 3; k++) posts.push(paint(new THREE.CylinderGeometry(s.r * 1.02, s.r * 1.02, 12, 8).translate(s.x, s.z1 - 60 - k * 46, s.y), C.band));
  }
  if (posts.length) {
    const m = new THREE.Mesh(faceted(posts), lowpolyMat());
    m.castShadow = true;
    scene.add(m);
  }
  const tex = neonTexture(map.name.replace(/^The /, '').toUpperCase());
  for (const d of map.deco) {
    if (d.kind !== 'gate') continue;
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.BoxGeometry(d.w + 40, 26, 22), new THREE.MeshLambertMaterial({ color: C.beam }));
    beam.position.y = d.h - 20;
    beam.castShadow = true;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(d.w * 0.7, d.w * 0.175), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.6, 1.6, 1.6), side: THREE.DoubleSide }));
    sign.position.set(0, d.h - 20, 0);
    sign.rotation.y = 0;
    const back = sign.clone();
    sign.position.z = 11.5;
    back.position.z = -11.5;
    back.rotation.y = Math.PI;
    g.add(beam, sign, back);
    g.position.set(d.x, d.z, d.y);
    // The beam runs across the road: the road's heading turned a quarter.
    g.rotation.y = -d.angle + Math.PI / 2;
    scene.add(g);
  }
}

// ---------- pines, boulders, cliff rocks ----------
function pine(d) {
  const s = d.s;
  const r = (k) => hash(d.seed, k, 31);
  const parts = [];
  const trunkH = 34 * s;
  parts.push(paint(new THREE.CylinderGeometry(3.2 * s, 5.4 * s, trunkH, 6).translate(0, trunkH / 2, 0), col('#7a4a2a')));
  const greens = [col('#2f7d4a'), col('#3f9a55'), col('#58b36a')];
  let y = trunkH * 0.55;
  for (let k = 0; k < 3; k++) {
    const rad = (30 - k * 7) * s;
    const hgt = (44 - k * 6) * s;
    const cone = new THREE.ConeGeometry(rad, hgt, 7).rotateY(r(k) * TAU).translate(0, y + hgt / 2, 0);
    parts.push(paint(cone, greens[k]));
    y += hgt * 0.52;
  }
  const g = mergeGeometries(parts);
  g.rotateY(r(9) * TAU);
  g.rotateZ((r(10) - 0.5) * 0.08);
  return g.translate(d.x, d.z - 2, d.y);
}
function rock(d, tint) {
  const g = new THREE.DodecahedronGeometry(1, 0);
  const p = g.attributes.position;
  // Squash and jitter the corners: no two rocks alike.
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 31 + p.getY(i) * 57 + p.getZ(i) * 91);
    const j = 0.78 + hash(d.seed, k, 5) * 0.44;
    p.setXYZ(i, p.getX(i) * j, p.getY(i) * j, p.getZ(i) * j);
  }
  const sx = 0.8 + hash(d.seed, 1, 7) * 0.5;
  const sz = 0.8 + hash(d.seed, 2, 7) * 0.5;
  const out = paint(g.scale(d.s * sx, d.s * 0.72, d.s * sz).rotateY(hash(d.seed, 3, 7) * TAU), tint.clone().offsetHSL(0, 0, (hash(d.seed, 4, 7) - 0.5) * 0.08));
  return out.translate(d.x, d.z + d.s * 0.3, d.y);
}
function buildProps(scene, map) {
  const pines = [];
  const rocks = [];
  for (const d of map.deco) {
    if (d.kind === 'pine') pines.push(pine(d));
    else if (d.kind === 'boulder') rocks.push(rock(d, col('#8b8a8f')));
    else if (d.kind === 'rock') rocks.push(rock(d, col('#7c6551')));
  }
  for (const list of [pines, rocks]) {
    if (!list.length) continue;
    const m = new THREE.Mesh(faceted(list), lowpolyMat());
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

// ---------- tyre stacks (bumpers) ----------
export function buildTyres(scene, b) {
  const g = new THREE.Group();
  const parts = [];
  const n = 3;
  const tr = b.r * 0.3;
  for (let k = 0; k < n; k++) {
    const y = tr + k * tr * 1.9;
    parts.push(paint(new THREE.TorusGeometry(b.r - tr, tr, 8, 18).rotateX(Math.PI / 2).translate(0, y, 0), k % 2 ? col('#f7f5ef') : col('#e5383b')));
  }
  parts.push(paint(new THREE.CylinderGeometry(b.r - tr * 1.6, b.r - tr * 1.6, n * tr * 1.9, 14).translate(0, (n * tr * 1.9) / 2, 0), col('#26272c')));
  const mesh = new THREE.Mesh(faceted(parts), lowpolyMat());
  mesh.castShadow = true;
  g.add(mesh);
  g.position.set(b.x, b.z, b.y);
  scene.add(g);
  let flash = 0;
  return {
    hit() { flash = 1; },
    update(dt) {
      flash = Math.max(0, flash - dt * 3);
      const s = 1 + Math.sin(flash * Math.PI) * 0.16;
      g.scale.set(s, 1 - Math.sin(flash * Math.PI) * 0.08, s);
    },
  };
}

// Everything a sculpted arena draws on top of the usual layered pieces.
export function buildSculpted(scene, map, ctx) {
  buildLowPolyLand(scene, map);
  if (map.liquid && map.liquid.kind === 'lava') buildLavaPool(scene, map, ctx);
  for (const r of map.roads || []) buildRoad(scene, map, r);
  buildGates(scene, map);
  buildProps(scene, map);
}

// Kinds of solid the sculpted look draws itself (or that are only there to collide).
export const SCULPTED_KINDS = new Set(['pillar', 'archpost', 'trunk', 'boulder']);
