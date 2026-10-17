// Race tracks in 3D: the terrain, the road with its climbs and drops, bridges, guard rails, ramps,
// water and lava, landmarks and scenery. Everything is built from the shared map data (KartCore),
// so what you see is exactly what the physics drives on.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  MOBILE, tex, part, rng, canvasTexture, addMoonlitTrees, addSimpleTrees, addGrass, addClouds, addCacti, addBuildings, addStars,
} from './world.js';

const K = window.KartCore;
const { smoothstep, fbm } = K.noise;
const UP = new THREE.Vector3(0, 1, 0);

// Per-sample frames of the road: position, height, left/right normal and distance along the lap.
function frames(map) {
  const n = map.n;
  const pts = map.centerline;
  const N = pts.map((_, i) => {
    const a = map.tangents[(i - 1 + n) % n];
    const b = map.tangents[i];
    const tx = a[0] + b[0];
    const ty = a[1] + b[1];
    const l = Math.hypot(tx, ty) || 1;
    return [-ty / l, tx / l];
  });
  const dist = [0];
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n];
    const q = pts[i - 1];
    dist.push(dist[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return { n, pts, N, H: map.heights, dist, half: map.width / 2, map };
}

// Sweep a cross-section along the road. `profile` is [[offset, dy], ...]: offset across the road
// (+ = the side the normal points to), dy above the road surface. Trace it clockwise (offset right,
// y up) so faces point outwards. Quads go from sample i to i+1 wherever include(i) is true.
function sweep(R, profile, include, opts = {}) {
  const { n, pts, N, H, dist } = R;
  const pos = [];
  const uv = [];
  const idx = [];
  const vScale = opts.vScale || 256;
  for (let e = 0; e < profile.length - 1; e++) {
    const [oa, ya] = profile[e];
    const [ob, yb] = profile[e + 1];
    const base = pos.length / 3;
    const ua = opts.uFixed ? 0 : e / (profile.length - 1);
    const ub = opts.uFixed ? 1 : (e + 1) / (profile.length - 1);
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const p = pts[k];
      const nm = N[k];
      const h = H[k];
      pos.push(p[0] + nm[0] * oa, h + ya, p[1] + nm[1] * oa, p[0] + nm[0] * ob, h + yb, p[1] + nm[1] * ob);
      const v = dist[i] / vScale;
      uv.push(ua, v, ub, v);
    }
    for (let i = 0; i < n; i++) {
      if (!include(i)) continue;
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function addMesh(scene, geo, mat, { cast = false, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  scene.add(m);
  return m;
}

// ---------- terrain ----------
// A grid that is fine around the track and coarse towards the horizon.
function axis(min, max, innerMin, innerMax, fine, coarse) {
  const out = [];
  let x = min;
  while (x < max) {
    out.push(x);
    const d = Math.max(innerMin - x, x - innerMax, 0);
    x += fine + (coarse - fine) * Math.min(1, d / 2600);
  }
  out.push(max);
  return out;
}

function terrainMaterial(theme, ctx) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.detail(theme.detail || 'grass'), roughness: 0.96, metalness: 0 });
  const glow = new THREE.Color(theme.terrain.glow || '#000000');
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.uniforms.uTime;
    shader.uniforms.uRockTex = { value: tex.rockFace() };
    shader.uniforms.uStrataTex = { value: tex.strata() };
    shader.uniforms.uStrata = { value: theme.strata ? 1 : 0 };
    shader.uniforms.uGlow = { value: glow };
    shader.uniforms.uCracks = { value: theme.terrain.glow ? tex.basaltGlow() : null };
    shader.uniforms.uCrackOn = { value: theme.terrain.glow ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRock;\nattribute float aGlow;\nvarying float vRock;\nvarying float vGlow;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRock = aRock;\nvGlow = aGlow;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform sampler2D uRockTex;\nuniform sampler2D uStrataTex;\nuniform sampler2D uCracks;\nuniform float uCrackOn;\nuniform float uStrata;\nuniform vec3 uGlow;\nvarying float vRock;\nvarying float vGlow;\nvarying vec3 vWPos;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // Cliffs and steep slopes: rock textured from the side; strata bands in the desert.
          float rl = texture2D(uRockTex, vec2((vWPos.x + vWPos.z) * 0.0032, vWPos.y * 0.0045)).r;
          vec3 rock = vColor.rgb * (0.45 + 0.85 * rl);
          if (uStrata > 0.5) rock = texture2D(uStrataTex, vec2(0.5, vWPos.y / 520.0 + (vWPos.x + vWPos.z) * 0.00004)).rgb * (0.55 + 0.7 * rl);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock, clamp(vRock, 0.0, 1.0));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uGlow * vGlow * (0.75 + 0.25 * sin(uTime * 2.1 + vWPos.x * 0.013 + vWPos.z * 0.011));
        if (uCrackOn > 0.5) totalEmissiveRadiance += texture2D(uCracks, vWPos.xz / 900.0).rgb * (0.35 + 1.2 * vGlow) * (1.0 - vRock * 0.5);`);
  };
  return mat;
}

function buildTerrain(scene, map, theme, ctx, R) {
  const b = map.bounds;
  const fine = MOBILE ? 64 : 42;
  const xs = axis(b.minX - 7500, b.maxX + 7500, b.minX - 600, b.maxX + 600, fine, 520);
  const zs = axis(b.minY - 7500, b.maxY + 7500, b.minY - 600, b.maxY + 600, fine, 520);
  const W = xs.length;
  const D = zs.length;
  const pos = new Float32Array(W * D * 3);
  const uv = new Float32Array(W * D * 2);
  const dist = new Float32Array(W * D);
  const half = R.half;
  const e0 = half + K.RUNOFF;
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const x = xs[i];
      const z = zs[j];
      const q = map.nearRoad(x, z) ? map.nearestIndex(x, z) : null;
      let h = map.terrainAt(x, z, q || undefined);
      if (q && q.dist < e0 + 30) {
        // Tuck the ground just under the asphalt so it never pokes through.
        h -= 6 * map.anchor[q.index] * (1 - smoothstep(half + K.CURB, e0 + 30, q.dist));
      }
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 420; uv[k * 2 + 1] = z / 420;
      dist[k] = q ? q.dist : 1e9;
    }
  }
  const idx = new Uint32Array((W - 1) * (D - 1) * 6);
  let t = 0;
  for (let j = 0; j < D - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const c = a + W;
      idx[t++] = a; idx[t++] = c; idx[t++] = a + 1;
      idx[t++] = a + 1; idx[t++] = c; idx[t++] = c + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  // Colour by height, slope and water; rock on steep ground; glow near lava.
  const P = theme.terrain;
  const low = new THREE.Color(P.low);
  const high = new THREE.Color(P.high);
  const rockC = new THREE.Color(P.rock);
  const sand = P.sand ? new THREE.Color(P.sand) : null;
  const bed = new THREE.Color(P.bed || P.low);
  const nrm = geo.attributes.normal.array;
  const col = new Float32Array(W * D * 3);
  const aRock = new Float32Array(W * D);
  const aGlow = new Float32Array(W * D);
  let hMin = Infinity;
  let hMax = -Infinity;
  for (const h of map.heights) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
  const water = map.water;
  const lavas = map.liquids.filter((l) => l.kind === 'lava');
  const c = new THREE.Color();
  for (let k = 0; k < W * D; k++) {
    const x = pos[k * 3];
    const h = pos[k * 3 + 1];
    const z = pos[k * 3 + 2];
    const slope = 1 - nrm[k * 3 + 1];
    c.copy(low).lerp(high, smoothstep(hMin - 60, hMax + 500, h));
    c.multiplyScalar(0.9 + 0.14 * fbm(x / 420, z / 420, 5, 3) + 0.06 * fbm(x / 90, z / 90, 9, 2));
    let rock = smoothstep(theme.snowfall ? 0.42 : 0.3, theme.snowfall ? 0.62 : 0.52, slope);
    if (theme.snowfall) rock *= 1 - smoothstep(900, 1300, h) * 0.6; // snowy summits
    if (water !== null && water !== undefined) {
      if (h < water + 2) {
        c.copy(bed).multiplyScalar(1 - smoothstep(water, water - 160, h) * 0.45);
        rock *= 0.3;
      } else if (sand) {
        c.lerp(sand, 1 - smoothstep(water + 10, water + 55, h));
      }
    }
    if (dist[k] < half + K.RUNOFF + 6 && map.anchor[map.nearestIndex(x, z).index] > 0.5) rock = 0; // under the road
    let glow = 0;
    if (lavas.length && P.glow) {
      for (const l of lavas) {
        const d = K.noise.polyDist(x, z, l.pts).d;
        if (d < l.w * 1.1) glow = Math.max(glow, 1 - smoothstep(l.w * 0.35, l.w * 1.1, d));
      }
      glow *= 0.4;
      if (map.crater) {
        const dc = Math.hypot(x - map.crater.x, z - map.crater.y);
        glow = Math.max(glow, (1 - smoothstep(map.crater.r * 0.5, map.crater.r * 1.25, dc)) * 0.8);
      }
    }
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    aRock[k] = rock;
    aGlow[k] = glow;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(aRock, 1));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(aGlow, 1));
  const mesh = addMesh(scene, geo, terrainMaterial(theme, ctx));
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- road ----------
function buildRoad(scene, map, theme, ctx, R) {
  const { half } = R;
  const gap = map.gap;
  const n = R.n;
  const open = (i) => !gap[i] && !gap[(i + 1) % n];
  const anchored = (i) => !map.bridge[i] && !map.bridge[(i + 1) % n] && open(i);
  const asphalt = theme.asphalt();
  addMesh(scene, sweep(R, [[-half, 0.6], [half, 0.6]], open, { vScale: 256, uFixed: true }), new THREE.MeshStandardMaterial({
    map: asphalt, roughness: theme.night ? 0.4 : 0.85, metalness: theme.night ? 0.3 : 0,
    emissive: theme.night ? 0xffffff : 0x000000, emissiveMap: theme.night ? asphalt : null, emissiveIntensity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  const curbMat = new THREE.MeshStandardMaterial({ map: tex.curb(theme.curb[0], theme.curb[1]), roughness: 0.6 });
  addMesh(scene, sweep(R, [[half, 1.6], [half + K.CURB, 1.6], [half + K.CURB + 2, 0.4]], open, { vScale: 64, uFixed: true }), curbMat);
  addMesh(scene, sweep(R, [[-half - K.CURB - 2, 0.4], [-half - K.CURB, 1.6], [-half, 1.6]], open, { vScale: 64, uFixed: true }), curbMat);
  const runMat = new THREE.MeshStandardMaterial({ color: theme.runoff, map: tex.detail('sand'), roughness: 1 });
  addMesh(scene, sweep(R, [[half + K.CURB + 1, 0.5], [half + K.RUNOFF, 0.1]], anchored, { vScale: 128 }), runMat);
  addMesh(scene, sweep(R, [[-half - K.RUNOFF, 0.1], [-half - K.CURB - 1, 0.5]], anchored, { vScale: 128 }), runMat);
  if (theme.neonEdges) {
    // Glowing light strips along both edges (bloom makes them shine).
    for (const [a, b, c] of [[half + K.CURB, half + K.CURB + 6, 0x22e5ff], [-half - K.CURB - 6, -half - K.CURB, 0xff3fd2]]) {
      addMesh(scene, sweep(R, [[a, 1.9], [b, 1.9]], open), new THREE.MeshBasicMaterial({ color: c }), { receive: false });
    }
  }
  // Ends of the road at gaps: a thin deck edge with a hazard stripe, held up by struts that reach
  // down into the pit, so the jump reads as a built structure rather than a block.
  const capMat = new THREE.MeshStandardMaterial({ map: tex.concrete(theme.night ? '#3a3355' : '#8c8f96'), roughness: 0.9 });
  const hazard = new THREE.MeshBasicMaterial({ map: tex.hazard(), color: theme.night ? 0xffffff : 0xdddddd });
  const strutMat = new THREE.MeshStandardMaterial({ color: theme.night ? 0x3b3566 : 0x9aa3ad, metalness: 0.6, roughness: 0.35 });
  const strutGeo = new THREE.CylinderGeometry(5, 7, 1, 10);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (!!gap[i] === !!gap[j]) continue;
    const at = gap[j] ? i : j; // last/first road sample
    const back = gap[j] ? -1 : 1; // towards the road, away from the gap
    const p = R.pts[at];
    const t = map.tangents[at];
    const ang = Math.atan2(t[1], t[0]);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 10, map.width + 2 * K.CURB), capMat);
    deck.position.set(p[0], R.H[at] - 4.5, p[1]);
    deck.rotation.y = -ang;
    deck.castShadow = true;
    scene.add(deck);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(10, 3, map.width + 2 * K.CURB), hazard);
    stripe.position.set(p[0], R.H[at] + 2.2, p[1]);
    stripe.rotation.y = -ang;
    scene.add(stripe);
    for (const o of [-0.7, 0, 0.7]) {
      const x = p[0] + R.N[at][0] * o * half + t[0] * back * 14;
      const z = p[1] + R.N[at][1] * o * half + t[1] * back * 14;
      const top = R.H[at] - 8;
      const bottom = Math.min(top - 20, map.terrainAt(x, z) - 10);
      const strut = new THREE.Mesh(strutGeo, strutMat);
      strut.scale.y = top - bottom;
      strut.position.set(x, (top + bottom) / 2, z);
      strut.castShadow = true;
      scene.add(strut);
    }
  }
}

// ---------- bridges and guard rails ----------
const BRIDGE_STYLES = {
  stone: { deck: '#a49a8a', rail: '#b3aa98', pier: '#9b9182', top: '#cfc6b4' },
  steel: { deck: '#7a3b26', rail: '#6b4a2e', pier: '#8a4a2f', top: '#c58b4a' },
  ice: { deck: '#a9d4f0', rail: '#cfeaff', pier: '#b9def5', top: '#ffffff', glass: true },
  neon: { deck: '#221c3c', rail: '#2a2350', pier: '#1c1832', top: '#7df9ff', glow: true },
  concrete: { deck: '#d7d8dc', rail: '#eceef1', pier: '#c9cbd0', top: '#38bdf8' },
  basalt: { deck: '#2b2321', rail: '#3a302c', pier: '#2b2321', top: '#ff7a2a', glow: true },
};

function buildBridges(scene, map, theme, ctx, R) {
  const style = BRIDGE_STYLES[theme.bridge] || BRIDGE_STYLES.concrete;
  const { half, n } = R;
  const near = (arr, i, k) => { for (let o = -k; o <= k; o++) if (arr[(i + o + n) % n]) return true; return false; };
  const deckAt = (i) => near(map.bridge, i, 1) && !map.gap[i] && !map.gap[(i + 1) % n];
  const railAt = (i) => map.railed[i] && map.railed[(i + 1) % n] && !map.gap[i] && !map.gap[(i + 1) % n];
  // The physics wall holds a kart's centre at half + RAIL; karts are ~18 units wide, so the
  // parapet's inner face sits just outside that (karts rub it rather than sink into it) and runs
  // out to the deck edge the physics uses.
  const inner = half + K.RAIL + 16;
  const edge = half + K.DECK;
  const deckMat = new THREE.MeshStandardMaterial({ map: tex.concrete(style.deck), roughness: 0.85 });
  const underMat = new THREE.MeshStandardMaterial({ map: tex.concrete(style.deck), color: 0x6b6b6b, roughness: 0.95 });
  // Deck: walkway either side of the curbs, then the slab's sides and a darker underside.
  addMesh(scene, sweep(R, [[half + K.CURB, 1.1], [edge, 1.1]], deckAt, { vScale: 64 }), deckMat);
  addMesh(scene, sweep(R, [[-edge, 1.1], [-half - K.CURB, 1.1]], deckAt, { vScale: 64 }), deckMat);
  addMesh(scene, sweep(R, [[edge, 1.1], [edge, -30], [-edge, -30], [-edge, 1.1]], deckAt, { vScale: 128 }), underMat, { cast: true });

  // Parapets along every railed stretch (bridges included).
  const railH = 30;
  const railMat = style.glass
    ? new THREE.MeshStandardMaterial({ color: style.rail, transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0.2, emissive: 0x6fb8e8, emissiveIntensity: 0.25, side: THREE.DoubleSide })
    : style.glow
      ? new THREE.MeshStandardMaterial({ color: style.rail, transparent: theme.bridge === 'neon', opacity: 0.7, roughness: 0.3, metalness: 0.5, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ map: tex.concrete(style.rail), roughness: 0.8 });
  const steel = theme.bridge === 'steel';
  const r1 = [[inner, 0], [inner, railH], [edge, railH], [edge, -2]];
  const r2 = [[-edge, -2], [-edge, railH], [-inner, railH], [-inner, 0]];
  // Steel bridges get an open truss (posts and diagonals) on the bridge itself instead of a wall.
  const solidAt = steel ? (i) => railAt(i) && !deckAt(i) : railAt;
  for (const prof of [r1, r2]) addMesh(scene, sweep(R, prof, solidAt, { vScale: 96 }), railMat, { cast: !style.glass });
  // A bright cap along the top of each parapet.
  const capMat = style.glow ? new THREE.MeshBasicMaterial({ color: style.top }) : new THREE.MeshStandardMaterial({ color: style.top, roughness: 0.5 });
  for (const [a, b] of [[inner - 1, edge + 1], [-edge - 1, -inner + 1]]) addMesh(scene, sweep(R, [[a, railH + 2], [b, railH + 2]], railAt), capMat);

  // Bridge furniture along both parapets: truss members on steel, lamp posts on the others.
  const along = [];
  for (let i = 0; i < n; i++) if (map.bridge[i] && deckAt(i)) along.push(i);
  if (steel && along.length) {
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x9a4a2a, metalness: 0.55, roughness: 0.45 });
    const posts = [];
    const diags = [];
    for (const i of along) {
      if (i % 2) continue;
      for (const sgn of [1, -1]) posts.push([i, sgn]);
      if (i % 4 === 0) for (const sgn of [1, -1]) diags.push([i, sgn]);
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const mid = (inner + edge) / 2;
    const postIm = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 1, 6), beamMat, posts.length);
    posts.forEach(([i, sgn], k) => {
      const p = R.pts[i];
      const t = map.tangents[i];
      q.setFromAxisAngle(UP, -Math.atan2(t[1], t[0]));
      m4.compose(new THREE.Vector3(p[0] + R.N[i][0] * mid * sgn, R.H[i] + railH * 1.6 / 2, p[1] + R.N[i][1] * mid * sgn), q, new THREE.Vector3(1, railH * 1.6, 1));
      postIm.setMatrixAt(k, m4);
    });
    postIm.castShadow = true;
    scene.add(postIm);
    const span = map.spacing * 4;
    const diagIm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 4, 4), beamMat, diags.length);
    diags.forEach(([i, sgn], k) => {
      const j = (i + 2) % n;
      const p = R.pts[j];
      const t = map.tangents[j];
      e.set(0, -Math.atan2(t[1], t[0]), Math.atan2(railH * 1.6, span / 2) * sgn, 'YXZ');
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(p[0] + R.N[j][0] * mid * sgn, R.H[j] + railH * 0.8, p[1] + R.N[j][1] * mid * sgn), q, new THREE.Vector3(Math.hypot(span / 2, railH * 1.6), 1, 1));
      diagIm.setMatrixAt(k, m4);
    });
    diagIm.castShadow = true;
    scene.add(diagIm);
    // Top chord along the posts.
    addMesh(scene, sweep(R, [[mid - 3, railH * 1.6], [mid + 3, railH * 1.6]], (i) => deckAt(i) && map.bridge[i]), beamMat);
    addMesh(scene, sweep(R, [[-mid - 3, railH * 1.6], [-mid + 3, railH * 1.6]], (i) => deckAt(i) && map.bridge[i]), beamMat);
  } else if (along.length) {
    const lampSpots = along.filter((i) => i % 12 === 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: theme.night ? 0x2a2540 : 0x4b5563, metalness: 0.6, roughness: 0.4 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff7d6, emissive: 0xffe6a3, emissiveIntensity: theme.night ? 2.2 : 0.6 });
    const poleIm = new THREE.InstancedMesh(new THREE.CylinderGeometry(2.2, 2.8, 1, 8), poleMat, lampSpots.length * 2);
    const lampIm = new THREE.InstancedMesh(new THREE.BoxGeometry(18, 5, 9), lampMat, lampSpots.length * 2);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let k = 0;
    for (const i of lampSpots) {
      const p = R.pts[i];
      const t = map.tangents[i];
      q.setFromAxisAngle(UP, -Math.atan2(t[1], t[0]));
      for (const sgn of [1, -1]) {
        const o = (inner + edge) / 2;
        m4.compose(new THREE.Vector3(p[0] + R.N[i][0] * o * sgn, R.H[i] + railH + 40, p[1] + R.N[i][1] * o * sgn), q, new THREE.Vector3(1, 80, 1));
        poleIm.setMatrixAt(k, m4);
        m4.compose(new THREE.Vector3(p[0] + R.N[i][0] * (o - 7) * sgn, R.H[i] + railH + 80, p[1] + R.N[i][1] * (o - 7) * sgn), q, new THREE.Vector3(1, 1, 1));
        lampIm.setMatrixAt(k, m4);
        k++;
      }
    }
    poleIm.castShadow = true;
    scene.add(poleIm, lampIm);
  }

  // Piers down to the ground below (the natural terrain under a bridge): twin columns under a cap
  // beam, spaced out on long bridges, so you see water and sky between them, not a dam.
  const piers = [];
  const every = along.length > 120 ? 10 : 6;
  for (let i = 0; i < n; i++) {
    if (!map.bridge[i] || !map.bridge[(i + 3) % n] || !map.bridge[(i - 3 + n) % n] || i % every) continue;
    const p = R.pts[i];
    const ground = map.natural(p[0], p[1]);
    const top = R.H[i] - 28;
    if (top - ground < 25) continue;
    const t = map.tangents[i];
    piers.push({ x: p[0], z: p[1], y0: ground - 40, y1: top, ang: Math.atan2(t[1], t[0]) });
  }
  if (piers.length) {
    const pierMat = new THREE.MeshStandardMaterial({ map: tex.concrete(style.pier), roughness: 0.85 });
    const geo = theme.bridge === 'neon' || theme.bridge === 'ice'
      ? mergeGeometries([part(new THREE.CylinderGeometry(0.5, 0.5, 1, 14), 0, 0.5, -0.32), part(new THREE.CylinderGeometry(0.5, 0.5, 1, 14), 0, 0.5, 0.32)])
      : mergeGeometries([
        part(new THREE.BoxGeometry(1, 1, 0.16), 0, 0.5, -0.3), part(new THREE.BoxGeometry(1, 1, 0.16), 0, 0.5, 0.3),
        part(new THREE.BoxGeometry(1.4, 0.06, 0.92), 0, 0.97, 0),
      ]);
    const im = new THREE.InstancedMesh(geo, pierMat, piers.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    piers.forEach((p, i) => {
      q.setFromAxisAngle(UP, -p.ang);
      const thick = theme.bridge === 'neon' || theme.bridge === 'ice' ? 26 : 34;
      m.compose(new THREE.Vector3(p.x, p.y0, p.z), q, new THREE.Vector3(thick, p.y1 - p.y0, theme.bridge === 'neon' || theme.bridge === 'ice' ? half * 1.6 : half * 1.5));
      im.setMatrixAt(i, m);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    scene.add(im);
  }
  // Neon: glowing strip under the deck edges.
  if (style.glow) {
    const glowMat = new THREE.MeshBasicMaterial({ color: style.top, side: THREE.DoubleSide });
    for (const o of [edge + 0.5, -edge - 0.5]) addMesh(scene, sweep(R, [[o, -6], [o, -12]], deckAt), glowMat, { receive: false });
  }
}

// ---------- ramps ----------
const RAMP_COLORS = {
  meadow: ['#facc15', '#1d4ed8'], desert: ['#f97316', '#fff7ed'], snow: ['#38bdf8', '#ffffff'],
  neon: ['#ff2fd0', '#7df9ff'], coast: ['#fde047', '#0ea5e9'], lava: ['#ff7a1a', '#ffe08a'],
};
function buildRamps(scene, map, theme, ctx, R) {
  const { half } = R;
  const [ca, cb] = RAMP_COLORS[map.theme] || RAMP_COLORS.meadow;
  const rampMat = (texture) => new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, metalness: 0.1, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: theme.night ? 0.6 : 0.12 });
  const mat = rampMat(tex.ramp(ca, cb));
  const landMat = rampMat(tex.rampLanding(ca, cb));
  const sideMat = new THREE.MeshStandardMaterial({ map: tex.concrete(theme.night ? '#2a2350' : '#5b5f66'), roughness: 0.8 });
  const lipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cb).lerp(new THREE.Color(0xffffff), 0.35) });
  const n = R.n;
  const sp = map.spacing;
  for (const r of map.ramps) {
    const pos = [];
    const uv = [];
    const idx = [];
    const side = [];
    const sideIdx = [];
    const steps = Math.ceil((r.up + r.down) / 6);
    for (let s = 0; s <= steps; s++) {
      const a = -r.up + (s / steps) * (r.up + r.down); // along the launch direction, 0 = lip
      const u = r.i + (a / sp) * r.dir;
      const i0 = Math.floor(u);
      const f = u - i0;
      const p0 = R.pts[((i0 % n) + n) % n];
      const p1 = R.pts[(((i0 + 1) % n) + n) % n];
      const n0 = R.N[((i0 % n) + n) % n];
      const x = p0[0] + (p1[0] - p0[0]) * f;
      const z = p0[1] + (p1[1] - p0[1]) * f;
      const road = R.H[((i0 % n) + n) % n] * (1 - f) + R.H[(((i0 + 1) % n) + n) % n] * f;
      const bump = a <= 0 ? r.h * ((a + r.up) / r.up) ** 1.6 : r.h * (1 - smoothstep(0, r.down, a));
      const y = road + bump + 0.9;
      for (const o of [-half, half]) {
        pos.push(x + n0[0] * o, y, z + n0[1] * o);
        uv.push(o < 0 ? 0 : 1, (a + r.up) / 128);
        side.push(x + n0[0] * o, y, z + n0[1] * o, x + n0[0] * o, road, z + n0[1] * o);
      }
      if (s < steps) {
        const b = s * 2;
        // Faces up whichever way the ramp points.
        if (r.dir > 0) idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        else idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
        const c = s * 4;
        sideIdx.push(c, c + 1, c + 4, c + 1, c + 5, c + 4, c + 2, c + 6, c + 3, c + 3, c + 6, c + 7);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Only ramps that launch in this race's direction show arrows; the far side of a gap is a landing pad.
    addMesh(scene, g, r.dir > 0 ? mat : landMat, { cast: true });
    if (r.dir > 0) {
      // A glowing strip along the lip, so you can line up the jump from far away.
      const li = ((r.i % n) + n) % n;
      const t = map.tangents[li];
      const lip = new THREE.Mesh(new THREE.BoxGeometry(5, 3, map.width), lipMat);
      lip.position.set(R.pts[li][0], R.H[li] + r.h + 1.6, R.pts[li][1]);
      lip.rotation.y = -Math.atan2(t[1], t[0]);
      scene.add(lip);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(side, 3));
    sg.setIndex(sideIdx);
    sg.computeVertexNormals();
    const sides = addMesh(scene, sg, sideMat);
    sides.material.side = THREE.DoubleSide;
  }
}

// ---------- start / finish ----------
function buildStart(scene, map, theme, ctx, R) {
  const { half } = R;
  const c0 = R.pts[0];
  const h0 = R.H[0];
  const t0 = map.tangents[0];
  const ang = Math.atan2(t0[1], t0[0]);
  const checker = tex.checker().clone();
  checker.needsUpdate = true;
  checker.repeat.set(1, 10);
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(26, map.width), new THREE.MeshStandardMaterial({ map: checker, polygonOffset: true, polygonOffsetFactor: -2 }));
  strip.rotation.x = -Math.PI / 2;
  strip.rotation.z = -ang;
  strip.position.set(c0[0], h0 + 1.6, c0[1]);
  strip.receiveShadow = true;
  scene.add(strip);
  const gantry = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: theme.night ? 0x2a2540 : 0xe5e7eb, metalness: 0.6, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(12, 150, 12), postMat);
    post.position.set(0, 75, s * (half + 34));
    post.castShadow = true;
    gantry.add(post);
  }
  const bannerTex = canvasTexture(512, 64, (c, w, h) => {
    c.fillStyle = theme.night ? '#ff2fd0' : '#ff4f8b'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff'; c.font = 'bold 42px "Trebuchet MS", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(`🏁  ${map.name.toUpperCase()}  🏁`, w / 2, h / 2 + 2);
  }, false);
  const bannerMat = new THREE.MeshStandardMaterial({ map: bannerTex, emissive: 0xffffff, emissiveMap: bannerTex, emissiveIntensity: theme.night ? 0.8 : 0.25 });
  // The gantry's local x runs along the track, so the banner goes on the ±x faces:
  // readable when driving through in either direction (reverse races too).
  const banner = new THREE.Mesh(new THREE.BoxGeometry(8, 34, map.width + 80), [bannerMat, bannerMat, postMat, postMat, postMat, postMat]);
  banner.position.y = 140;
  banner.castShadow = true;
  gantry.add(banner);
  // Start lights.
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2222, emissiveIntensity: 1.2 });
  for (let k = -2; k <= 2; k++) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 8), lightMat);
    l.position.set(5, 114, k * 16);
    gantry.add(l);
  }
  gantry.position.set(c0[0], h0, c0[1]);
  gantry.rotation.y = -ang;
  scene.add(gantry);
}

// ---------- barriers at the wall ----------
function buildBarriers(scene, map, theme, ctx, R) {
  const spots = [];
  const n = R.n;
  for (let i = 0; i < n; i++) {
    if (map.railed[i] || map.gap[i] || map.bridge[i]) continue;
    for (const side of [1, -1]) {
      const off = map.wallD[i] + 16;
      const x = R.pts[i][0] + R.N[i][0] * off * side;
      const z = R.pts[i][1] + R.N[i][1] * off * side;
      const q = map.nearestIndex(x, z);
      if (q.dist < off - 8) continue; // would sit on another stretch
      const y = map.terrainAt(x, z, q);
      if (map.water !== null && y < map.water + 2) continue;
      if (y > R.H[i] + 35) continue; // a hillside is wall enough
      spots.push([x, z, y, i]);
    }
  }
  const m = new THREE.Matrix4();
  if (theme.barrier === 'rocks') {
    const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: theme.rockColor || 0xa65a35, roughness: 1, flatShading: true }), spots.length);
    const r = rng(9);
    spots.forEach(([x, z, y], i) => {
      const s = 14 + r() * 12;
      m.compose(new THREE.Vector3(x, y + s * 0.3, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, 0)), new THREE.Vector3(s, s * 0.8, s));
      rocks.setMatrixAt(i, m);
    });
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    scene.add(rocks);
  } else if (theme.barrier === 'neon') {
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 26, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), spots.length);
    spots.forEach(([x, z, y], i) => {
      m.makeTranslation(x, y + 13, z);
      posts.setMatrixAt(i, m);
      posts.setColorAt(i, new THREE.Color(i % 2 ? 0x22e5ff : 0xff3fd2));
    });
    scene.add(posts);
  } else {
    const tires = new THREE.InstancedMesh(new THREE.CylinderGeometry(13, 13, 22, 12), new THREE.MeshStandardMaterial({ roughness: 0.8 }), spots.length);
    spots.forEach(([x, z, y, i0], i) => {
      m.makeTranslation(x, y + 10, z);
      tires.setMatrixAt(i, m);
      tires.setColorAt(i, new THREE.Color(theme.barrierColors[Math.floor(i0 / 2) % 2]));
    });
    tires.castShadow = true;
    tires.receiveShadow = true;
    scene.add(tires);
  }
}

// ---------- boost pads (lying on the slope) ----------
function buildPads(scene, map, theme, ctx) {
  for (const p of map.boostPads) {
    const mat = new THREE.MeshBasicMaterial({ map: tex.chevron().clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3 });
    mat.map.needsUpdate = true;
    mat.map.wrapT = THREE.RepeatWrapping;
    const ca = Math.cos(p.angle);
    const sa = Math.sin(p.angle);
    const pos = [];
    for (const [f, l] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const x = p.x + ca * 34 * f - sa * 34 * l;
      const z = p.y + sa * 34 * f + ca * 34 * l;
      pos.push(x, map.heightAt(x, z) + 2.2, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const pad = new THREE.Mesh(g, mat);
    pad.renderOrder = 1;
    scene.add(pad);
    ctx.pads.push(pad);
  }
}

// ---------- water, ice and lava ----------
// GLSL value noise + fbm, shared by the lava and water shaders.
const NOISE_GLSL = `
  float lqHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lqNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(lqHash(i), lqHash(i + vec2(1.0, 0.0)), f.x), mix(lqHash(i + vec2(0.0, 1.0)), lqHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float lqFbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * lqNoise(p); p *= 2.03; a *= 0.5; } return v; }
`;

// Flowing lava: dark cooled crust plates with glowing cracks between them, drifting along the
// ribbon's v (flow) direction, darker towards the banks (u = 0 / 1). Unlit, fogged, bright enough
// in the cracks to bloom. `radial`: for round pools (crater lake), banks are at the rim instead.
function lavaMaterial(ctx, { scale = [3, 6], radial = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        vec2 p = vec2(vUv.x * ${scale[0].toFixed(1)}, vUv.y * ${scale[1].toFixed(1)});
        float flow = uTime * 0.16;
        float plates = lqFbm(p * 1.3 + vec2(0.0, -flow));
        float r = 1.0 - abs(2.0 * lqNoise(p * 3.1 + vec2(1.7, -flow * 1.4)) - 1.0); // ridged: thin bright lines
        float cracks = smoothstep(0.78, 0.97, r);
        float hotZone = smoothstep(0.52, 0.72, plates);
        float heat = clamp(max(cracks, hotZone * 0.85), 0.0, 1.0);
        ${radial ? 'float bank = smoothstep(0.5, 0.36, length(vUv - 0.5));' : 'float bank = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);'}
        heat *= mix(0.25, 1.0, bank);
        vec3 crust = mix(vec3(0.06, 0.025, 0.02), vec3(0.16, 0.06, 0.03), plates);
        vec3 hot = mix(vec3(0.85, 0.16, 0.03), vec3(1.0, 0.5, 0.1), smoothstep(0.65, 1.0, heat));
        float pulse = 0.85 + 0.15 * sin(uTime * 1.6 + vUv.y * 23.0 + plates * 6.0);
        vec3 col = mix(crust, hot * (1.05 + 0.35 * pulse), heat);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    fog: true,
  });
}

function buildLiquids(scene, map, theme, ctx, R) {
  const b = map.bounds;
  if (map.water !== null && map.water !== undefined) {
    const normal = tex.waterNormal().clone();
    normal.needsUpdate = true;
    normal.repeat.set(60, 60);
    const mat = new THREE.MeshStandardMaterial({
      color: theme.water || 0x2e86c1, roughness: 0.06, metalness: 0.15, transparent: true, opacity: 0.84,
      normalMap: normal, normalScale: new THREE.Vector2(0.55, 0.55), depthWrite: false,
    });
    mat.opacity = 0.95;
    // Each vertex knows how deep the water is there, so the shore fades softly instead of following
    // the terrain triangles in steps, shallow water is turquoise and deep water blue, with foam.
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) + 3000;
    const cells = Math.min(220, Math.ceil(span / 50));
    const geo = new THREE.PlaneGeometry(span, span, cells, cells).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const depth = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k) + map.center[0];
      const z = pos.getZ(k) + map.center[1];
      depth[k] = map.water - map.terrainAt(x, z);
    }
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    const uTime = ctx.uniforms.uTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec2 vWXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDepth = aDepth;\nvWXZ = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying float vDepth;\nvarying vec2 vWXZ;\n${NOISE_GLSL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float wd = vDepth;
          diffuseColor.rgb = mix(vec3(0.33, 0.86, 0.80), diffuseColor.rgb, smoothstep(3.0, 80.0, wd));
          float foamN = lqNoise(vWXZ * 0.035 + vec2(uTime * 0.25, uTime * 0.18));
          float foam = (1.0 - smoothstep(0.0, 9.0 + foamN * 6.0, wd)) * (0.55 + 0.45 * sin(uTime * 1.8 + wd * 0.9 + foamN * 6.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.97, 0.99, 1.0), clamp(foam, 0.0, 0.85));
          diffuseColor.a *= smoothstep(-0.5, 3.0, wd);`);
    };
    const water = new THREE.Mesh(geo, mat);
    water.position.set(map.center[0], map.water, map.center[1]);
    water.receiveShadow = true;
    water.renderOrder = 1;
    scene.add(water);
    // Open sea beyond the detailed patch: always deep.
    const outer = new THREE.Mesh(new THREE.RingGeometry(span * 0.7, span * 6, 48, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
      color: theme.water || 0x2e86c1, roughness: 0.08, metalness: 0.15, normalMap: normal, normalScale: new THREE.Vector2(0.55, 0.55),
    }));
    outer.position.set(map.center[0], map.water - 0.5, map.center[1]);
    scene.add(outer);
    ctx.water.push(normal);
  }
  // Frozen rivers (ice) in the snow theme: flat beds of trenches with a level.
  if (theme.ice) {
    const iceMat = new THREE.MeshStandardMaterial({ color: 0xcdeafc, roughness: 0.15, metalness: 0.1, emissive: 0x2a5d80, emissiveIntensity: 0.15 });
    for (const f of (map.terrain && map.terrain.features) || []) {
      if (f.type !== 'trench' || f.level === undefined) continue;
      const shape = ribbonAlong(f.pts, f.w * 0.62, () => f.level + 6, 60);
      addMesh(scene, shape, iceMat);
    }
  }
  // Lava rivers: glowing, slowly flowing ribbons down their channels.
  const lavas = map.liquids.filter((l) => l.kind === 'lava');
  if (lavas.length) {
    for (const l of lavas) {
      const surf = (x, z) => map.natural(x, z) + l.depth * 0.38;
      const geo = ribbonAlong(l.pts, l.w * 0.78, surf, 40, 220);
      const mat = lavaMaterial(ctx);
      mat.uniforms.uTime = ctx.uniforms.uTime;
      const lava = addMesh(scene, geo, mat);
      lava.receiveShadow = false;
    }
    // A couple of warm lights where lava passes the road.
    for (const l of lavas.slice(0, 3)) {
      const mid = l.pts[Math.floor(l.pts.length / 2)];
      const light = new THREE.PointLight(0xff6a1a, 3, 1400, 1.2);
      light.position.set(mid[0], map.natural(mid[0], mid[1]) + 160, mid[1]);
      scene.add(light);
    }
  }
}

// A flat-across ribbon following a polyline, with heights from `yAt(x, z)`.
function ribbonAlong(pts, halfW, yAt, step = 40, vScale = 400) {
  const path = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const k = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < k; s++) path.push([ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k]);
  }
  path.push(pts[pts.length - 1]);
  const pos = [];
  const uv = [];
  const idx = [];
  let d = 0;
  path.forEach(([x, z], i) => {
    const a = path[Math.max(0, i - 1)];
    const c = path[Math.min(path.length - 1, i + 1)];
    const tx = c[0] - a[0];
    const tz = c[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l;
    const nz = tx / l;
    if (i) d += Math.hypot(x - path[i - 1][0], z - path[i - 1][1]);
    const y = yAt(x, z);
    pos.push(x + nx * halfW, y, z + nz * halfW, x - nx * halfW, y, z - nz * halfW);
    uv.push(0, d / vScale, 1, d / vScale);
    if (i < path.length - 1) {
      const b = i * 2;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Make sure it faces up.
  const nr = g.attributes.normal;
  if (nr.count && nr.getY(0) < 0) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
    g.computeVertexNormals();
  }
  return g;
}

// ---------- scenery ----------
// Points beside the road between minD and maxD from its centre line, on the terrain.
function besideRoad(map, R, count, minD, maxD, seed, ok = () => true) {
  const r = rng(seed);
  const out = [];
  for (let t = 0; t < count * 6 && out.length < count; t++) {
    const i = Math.floor(r() * R.n);
    const side = r() < 0.5 ? -1 : 1;
    const d = minD + r() * (maxD - minD);
    const x = R.pts[i][0] + R.N[i][0] * d * side + (r() - 0.5) * 60;
    const z = R.pts[i][1] + R.N[i][1] * d * side + (r() - 0.5) * 60;
    const q = map.nearestIndex(x, z);
    if (q.dist < minD) continue;
    const y = map.terrainAt(x, z, q);
    if (!ok(x, z, y, q)) continue;
    out.push([x, z, 0.85 + r() * 0.35, y]);
  }
  return out;
}
// Anywhere in a box, at least minD from the road.
function farFromRoad(map, box, count, minD, seed, ok = () => true) {
  const r = rng(seed);
  const out = [];
  for (let t = 0; t < count * 8 && out.length < count; t++) {
    const x = box.minX + r() * (box.maxX - box.minX);
    const z = box.minY + r() * (box.maxY - box.minY);
    let q = null;
    if (map.nearRoad(x, z)) {
      q = map.nearestIndex(x, z);
      if (q.dist < minD) continue;
    }
    const y = map.terrainAt(x, z, q || undefined);
    if (!ok(x, z, y, q)) continue;
    out.push([x, z, 0.85 + r() * 0.35, y]);
  }
  return out;
}
function steep(map, x, z, lim) {
  const e = 24;
  const dx = map.terrainAt(x + e, z) - map.terrainAt(x - e, z);
  const dz = map.terrainAt(x, z + e) - map.terrainAt(x, z - e);
  return Math.hypot(dx, dz) / (2 * e) > lim;
}

function buildScenery(scene, map, theme, ctx, R) {
  const { half } = R;
  const b = map.bounds;
  const box = { minX: b.minX - 2400, maxX: b.maxX + 2400, minY: b.minY - 2400, maxY: b.maxY + 2400 };
  const dry = (x, z, y) => (map.water === null || y > map.water + 14) && !map.liquids.some((l) => K.noise.polyDist(x, z, l.pts).d < l.w * 1.2);
  const plantable = (lim) => (x, z, y) => dry(x, z, y) && !steep(map, x, z, lim);
  const wall = half + K.WALL_PAD;
  if (theme.trees) {
    const spots = [
      ...besideRoad(map, R, MOBILE ? 90 : 220, wall + 60, wall + 900, 1234, plantable(0.6)),
      ...farFromRoad(map, box, MOBILE ? 110 : 300, wall + 300, 4321, plantable(0.55)),
    ];
    const fallback = () => addSimpleTrees(scene, spots, { snowy: theme.frost });
    if (theme.pines) {
      addSimpleTrees(scene, spots.filter((_, i) => i % 3 !== 0), { snowy: true });
      addMoonlitTrees(scene, spots.filter((_, i) => i % 3 === 0), theme.trees, { tint: theme.frost ? 0xe9f1f8 : null, seed: 2 }).then((ok) => ok || fallback());
    } else {
      addMoonlitTrees(scene, spots, theme.trees, { seed: 1 }).then((ok) => ok || fallback());
    }
  }
  if (theme.bushes) addMoonlitTrees(scene, besideRoad(map, R, MOBILE ? 80 : 220, half + 90, half + 1000, 777, plantable(0.6)), theme.bushes, { seed: 3, variants: 2 });
  if (theme.deadTrees) {
    const spots = [...besideRoad(map, R, MOBILE ? 50 : 120, wall + 40, wall + 900, 4242, plantable(0.7)), ...farFromRoad(map, box, MOBILE ? 40 : 90, wall + 300, 99, plantable(0.7))];
    addMoonlitTrees(scene, spots, theme.deadTrees, { barkOnly: true, barkTint: 0x2e2522, seed: 4, variants: 2 });
  }
  if (theme.grass) addGrass(scene, besideRoad(map, R, MOBILE ? 3000 : 11000, half + 70, half + 800, 99, plantable(0.7)), ctx.uniforms);
  if (theme.cacti) addCacti(scene, besideRoad(map, R, MOBILE ? 90 : 200, wall + 30, wall + 1200, 55, plantable(0.4)));
  if (theme.hoodoos) addHoodoos(scene, besideRoad(map, R, MOBILE ? 30 : 60, wall + 80, wall + 1100, 66, plantable(0.35)));
  if (theme.palms) addPalms(scene, besideRoad(map, R, MOBILE ? 90 : 190, wall + 10, wall + 700, 31, (x, z, y) => dry(x, z, y) && !steep(map, x, z, 0.5)));
  if (theme.buildings) {
    // Towers lining the streets, taller further from the road; facing the road.
    const yaw = (x, z) => { const q = map.nearestIndex(x, z); const t = map.tangents[q.index]; return -Math.atan2(t[1], t[0]); };
    const near = besideRoad(map, R, MOBILE ? 90 : 170, wall + 140, wall + 600, 88).map((p) => [p[0], p[1], 0.7 + Math.random() * 0.3, p[3]]);
    const far = farFromRoad(map, box, MOBILE ? 60 : 140, wall + 600, 77).map((p) => [p[0], p[1], 1.2 + Math.random() * 0.8, p[3]]);
    addBuildings(scene, near, { yaw });
    addBuildings(scene, far, { yaw, wide: 1.3 });
  }
  if (theme.stars) addStars(scene);
  if (theme.clouds) {
    let top = 0;
    for (const h of map.heights) top = Math.max(top, h);
    ctx.clouds = addClouds(scene, MOBILE ? Math.ceil(theme.clouds / 2) : theme.clouds, map.center, 16000, theme.cloudTint, top + 1300);
  }
  if (theme.barrier === 'rocks' || theme.snowfall || theme.lighthouse) {
    // Boulders scattered in the landscape.
    addRocks(scene, besideRoad(map, R, MOBILE ? 40 : 110, wall + 60, wall + 1500, 515, dry), theme);
  }
}

function addRocks(scene, spots, theme) {
  if (!spots.length) return;
  const col = theme.snowfall ? 0x6b7684 : theme.lighthouse ? 0x8d8172 : theme.rockColor || 0xa65a35;
  const im = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: col, roughness: 1, flatShading: true }), spots.length);
  const m = new THREE.Matrix4();
  const r = rng(17);
  spots.forEach(([x, z, , y], i) => {
    const s = 20 + r() * 60;
    m.compose(new THREE.Vector3(x, y + s * 0.15, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r())), new THREE.Vector3(s * (1 + r() * 0.6), s * (0.5 + r() * 0.5), s));
    im.setMatrixAt(i, m);
  });
  im.castShadow = true;
  im.receiveShadow = true;
  scene.add(im);
}

// Desert rock pillars (hoodoos): stacked, slightly offset blocks with a cap.
function addHoodoos(scene, spots) {
  if (!spots.length) return;
  const geo = mergeGeometries([
    part(new THREE.CylinderGeometry(0.42, 0.5, 0.45, 7), 0, 0.22, 0),
    part(new THREE.CylinderGeometry(0.34, 0.4, 0.35, 7), 0.04, 0.62, 0),
    part(new THREE.CylinderGeometry(0.26, 0.33, 0.25, 7), -0.03, 0.9, 0.02),
    part(new THREE.CylinderGeometry(0.42, 0.3, 0.12, 7), 0, 1.07, 0),
  ]);
  const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: tex.strata(), roughness: 1, flatShading: true }), spots.length);
  const m = new THREE.Matrix4();
  const r = rng(23);
  spots.forEach(([x, z, , y], i) => {
    const w = 70 + r() * 80;
    m.compose(new THREE.Vector3(x, y - 10, z), new THREE.Quaternion().setFromAxisAngle(UP, r() * 6), new THREE.Vector3(w, 160 + r() * 260, w));
    im.setMatrixAt(i, m);
  });
  im.castShadow = true;
  im.receiveShadow = true;
  scene.add(im);
}

// Palm trees: a curved, ringed trunk, a crown of drooping fronds and coconuts. Instanced.
function addPalms(scene, spots) {
  if (!spots.length) return;
  const trunkParts = [];
  const segs = 8;
  for (let s = 0; s < segs; s++) {
    const t = s / segs;
    const bend = (tt) => [tt * tt * 0.9, tt];
    const [x0] = bend(t);
    const r0 = 0.11 - t * 0.04;
    trunkParts.push(part(new THREE.CylinderGeometry(r0 * 0.9, r0, 1 / segs + 0.01, 8), x0, t + 0.5 / segs, 0, 0, 0, -t * 0.8));
  }
  const trunk = mergeGeometries(trunkParts).scale(1, 3.4, 1);
  const top = [0.9, 3.4];
  const fronds = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    // A drooping leaf: a strip bent downwards along its length.
    const len = 1.9;
    const g = new THREE.PlaneGeometry(0.55, len, 1, 6);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const along = (p.getY(v) + len / 2) / len;
      p.setY(v, along * len);
      p.setZ(v, -along * along * 1.1);
    }
    g.rotateX(-Math.PI / 2 + 0.35);
    g.rotateY(a);
    g.translate(top[0], top[1], 0);
    fronds.push(g);
  }
  const crown = mergeGeometries(fronds);
  const nuts = mergeGeometries([0, 1, 2].map((k) => part(new THREE.SphereGeometry(0.1, 8, 6), top[0] + Math.cos(k * 2.1) * 0.12, top[1] - 0.12, Math.sin(k * 2.1) * 0.12)));
  const trunkMat = new THREE.MeshStandardMaterial({ map: tex.stripes('#8a6a48', '#6e5238', 18), roughness: 0.9 });
  const leafMat = new THREE.MeshStandardMaterial({ map: tex.palmLeaf(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.75 });
  const nutMat = new THREE.MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.7 });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const r = rng(41);
  const mats = spots.map(([x, z, s, y]) => {
    q.setFromAxisAngle(UP, r() * Math.PI * 2);
    const sc = 60 * s * (0.85 + r() * 0.4);
    return m.clone().compose(new THREE.Vector3(x, y - 4, z), q, new THREE.Vector3(sc, sc, sc));
  });
  for (const [geo, mat] of [[trunk, trunkMat], [crown, leafMat], [nuts, nutMat]]) {
    const im = new THREE.InstancedMesh(geo, mat, spots.length);
    mats.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.castShadow = true;
    im.receiveShadow = true;
    scene.add(im);
  }
}

// ---------- landmarks ----------
function buildLandmarks(scene, map, theme, ctx, R) {
  for (const l of map.landmarks || []) {
    const y = map.terrainAt(l.x, l.y);
    if (l.kind === 'lighthouse') addLighthouse(scene, l.x, y, l.y, ctx);
    else if (l.kind === 'grandstand') addGrandstand(scene, map, R, l, ctx);
    else if (l.kind === 'towers') addTowers(scene, map, R, l);
  }
  if (map.crater) {
    const c = map.crater;
    const floor = map.natural(c.x, c.y);
    const lakeMat = lavaMaterial(ctx, { scale: [5, 5], radial: true });
    lakeMat.uniforms.uTime = ctx.uniforms.uTime;
    const lake = new THREE.Mesh(new THREE.CircleGeometry(c.r * 0.75, 48).rotateX(-Math.PI / 2), lakeMat);
    lake.position.set(c.x, floor + 40, c.y);
    scene.add(lake);
    // The crater's rim hides the lake from the road, so a soft column of glow and heat rises out of
    // it: brightest at the bottom and in the middle, fading upwards and at its edges (no hard tube).
    const plume = new THREE.Mesh(new THREE.CylinderGeometry(c.r * 0.55, c.r * 0.35, 1700, 32, 1, true), new THREE.ShaderMaterial({
      uniforms: { uTime: ctx.uniforms.uTime },
      vertexShader: `
        varying vec2 vUv; varying float vFacing;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uTime; varying vec2 vUv; varying float vFacing;
        void main() {
          float a = pow(1.0 - vUv.y, 2.2) * pow(vFacing, 1.6) * (0.85 + 0.15 * sin(uTime * 1.3));
          gl_FragColor = vec4(vec3(1.0, 0.45, 0.14) * a * 0.9, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    plume.position.set(c.x, floor + 850, c.y);
    scene.add(plume);
    const light = new THREE.PointLight(0xff5a1a, 6, 3000, 1);
    light.position.set(c.x, floor + 300, c.y);
    scene.add(light);
    ctx.vents = [{ x: c.x, y: floor + 60, z: c.y, r: c.r * 0.5 }];
  }
}

function addLighthouse(scene, x, y, z, ctx) {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(26, 40, 300, 24), new THREE.MeshStandardMaterial({ map: tex.stripes('#f8fafc', '#dc2626', 6), roughness: 0.6 }));
  tower.position.y = 150;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 8, 24), new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.5 }));
  gallery.position.y = 304;
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 34, 16), new THREE.MeshStandardMaterial({ color: 0xfff7cc, emissive: 0xfff1a8, emissiveIntensity: 2, transparent: true, opacity: 0.85 }));
  lamp.position.y = 325;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(28, 34, 16), new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 }));
  roof.position.y = 359;
  const house = new THREE.Mesh(new THREE.BoxGeometry(110, 60, 70), new THREE.MeshStandardMaterial({ map: tex.concrete('#f1efe8'), roughness: 0.8 }));
  house.position.set(70, 30, 0);
  const houseRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 50, 30, 4, 1), new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.7 }));
  houseRoof.rotation.y = Math.PI / 4;
  houseRoof.scale.set(1.5, 1, 1);
  houseRoof.position.set(70, 75, 0);
  for (const m of [tower, gallery, roof, house, houseRoof]) { m.castShadow = true; m.receiveShadow = true; }
  g.add(tower, gallery, lamp, roof, house, houseRoof);
  // A sweeping beam only reads as light at night; in daylight it was a solid white tube in the sky,
  // so by day the glowing lamp house is enough.
  if (ctx.night) {
    const beam = new THREE.Mesh(new THREE.ConeGeometry(70, 900, 24, 1, true).rotateZ(Math.PI / 2).translate(450, 0, 0),
      new THREE.MeshBasicMaterial({ color: 0xfff4c2, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 325;
    g.add(beam);
    ctx.beams.push(beam);
  }
  g.position.set(x, y - 6, z);
  scene.add(g);
}

function addGrandstand(scene, map, R, l, ctx) {
  // A covered stand along the road at fraction l.at, on side l.side, l.len units long.
  const n = R.n;
  const i0 = Math.floor((map.reverse ? 1 - l.at : l.at) * n) % n;
  const side = (map.reverse ? -1 : 1) * (l.side || 1);
  const len = l.len || 900;
  const p = R.pts[i0];
  const t = map.tangents[i0];
  const off = map.wallD[i0] + 30;
  const cx = p[0] + R.N[i0][0] * off * side;
  const cz = p[1] + R.N[i0][1] * off * side;
  const y = map.terrainAt(cx, cz);
  const g = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ map: tex.concrete('#c7cbd3'), roughness: 0.9 });
  const steps = 6;
  for (let s = 0; s < steps; s++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(len, 16 + s * 16, 34), standMat);
    step.position.set(0, (16 + s * 16) / 2, s * 34);
    step.castShadow = true;
    step.receiveShadow = true;
    g.add(step);
  }
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe11d2e, roughness: 0.6, side: THREE.DoubleSide });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 40, 6, 260), roofMat);
  roof.position.set(0, 200, 90);
  roof.rotation.x = -0.12;
  roof.castShadow = true;
  g.add(roof);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.5, roughness: 0.4 });
  for (let k = -2; k <= 2; k++) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 200, 8), poleMat);
    pole.position.set((k / 2) * (len / 2 - 20), 100, 200);
    g.add(pole);
  }
  // The crowd.
  const crowdColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xeab308, 0xec4899, 0xffffff, 0xa855f7, 0xf97316];
  const max = MOBILE ? 400 : 1100;
  const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(5, 8, 2, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), max);
  const m = new THREE.Matrix4();
  const r = rng(5);
  let ci = 0;
  for (let s = 0; s < steps && ci < max; s++) {
    for (let x = -len / 2 + 20; x < len / 2 - 20 && ci < max; x += 12 + r() * 10) {
      m.makeTranslation(x, 16 + s * 16 + 9, s * 34 + (r() - 0.5) * 10);
      crowd.setMatrixAt(ci, m);
      crowd.setColorAt(ci, new THREE.Color(crowdColors[Math.floor(r() * crowdColors.length)]));
      ci++;
    }
  }
  crowd.count = ci;
  g.add(crowd);
  g.position.set(cx, y, cz);
  // Turned so local +z points away from the road: the low front rows face the racers and
  // the tall back, roof poles and flags sit behind the crowd.
  g.rotation.y = -Math.atan2(t[1], t[0]) + (side > 0 ? 0 : Math.PI);
  scene.add(g);
  ctx.crowd = crowd;
  // Flags along the top.
  const flagCols = ['#ef4444', '#facc15', '#3b82f6', '#22c55e'];
  for (let k = 0; k < 8; k++) {
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), new THREE.MeshStandardMaterial({ color: flagCols[k % 4], side: THREE.DoubleSide, roughness: 0.7 }));
    flag.position.set(-len / 2 + 40 + (k * (len - 80)) / 7, 236, 200);
    g.add(flag);
    ctx.flags.push(flag);
  }
}

// Neon: very tall glowing towers either side of a jump.
function addTowers(scene, map, R, l) {
  const i0 = Math.floor((map.reverse ? 1 - l.at : l.at) * R.n) % R.n;
  const p = R.pts[i0];
  const spots = [];
  for (const side of [1, -1]) {
    for (const along of [-1, 1]) {
      const t = map.tangents[i0];
      const off = R.half + 330;
      spots.push([p[0] + R.N[i0][0] * off * side + t[0] * along * 260, p[1] + R.N[i0][1] * off * side + t[1] * along * 260, 2.2, 0]);
    }
  }
  addBuildings(scene, spots, { wide: 1.2 });
}

// ---------- entry point ----------
export function buildRace(scene, map, theme, ctx) {
  const R = frames(map);
  ctx.water = ctx.water || [];
  ctx.beams = ctx.beams || [];
  ctx.flags = ctx.flags || [];
  buildTerrain(scene, map, theme, ctx, R);
  buildRoad(scene, map, theme, ctx, R);
  buildBridges(scene, map, theme, ctx, R);
  buildRamps(scene, map, theme, ctx, R);
  buildStart(scene, map, theme, ctx, R);
  buildBarriers(scene, map, theme, ctx, R);
  buildPads(scene, map, theme, ctx);
  buildLiquids(scene, map, theme, ctx, R);
  buildLandmarks(scene, map, theme, ctx, R);
  buildScenery(scene, map, theme, ctx, R);
}
