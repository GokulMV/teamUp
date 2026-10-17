// The bright look for layered arenas (an arena whose def says look: 'bright'): big, clean,
// saturated colour blocks with rounded edges, shaded softly from their tops down to their feet;
// patterns painted on in world space (concrete slab joints, planks, steel grating, hazard stripes,
// container ribs, chevrons up every ramp), so they stay crisp at any distance; and a striped rim
// painted along every edge a kart can drive off, found from the map itself, so none is ever missed.
// The arena's palette (in its def) says what colour each kind of solid is; the minimap paints the
// same colours. Water is drawn here too (cartoon caustics, foam where it laps at the piers).
//
// Physics (x, y, z) is three (x, z, y), as everywhere in kart3d.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonGradient } from './toon.js';

const K = window.KartCore;
const L = K.Layers;
const TAU = Math.PI * 2;

// Pattern ids (the shader's switch).
export const PAT = { none: 0, checker: 1, slabs: 2, planks: 3, grate: 4, hazard: 5, ribs: 6, chevrons: 7, bands: 8, tiles: 9, boards: 10 };

// ---------- the material ----------
// Toon shading (kart3d/toon.js's light ramp) with vertex colours, and a pattern painted in world
// space from three attributes per vertex: aPat (pattern id, cell size, angle, shade) and aCol2 (the
// pattern's second colour). Shade darkens a solid's sides towards its foot (soft contact shadow).
let brightMat = null;
export function brightMaterial() {
  if (brightMat) return brightMat;
  brightMat = makeMaterial();
  return brightMat;
}
// A material of its own (roofs fade one at a time).
export function makeMaterial() {
  const m = new THREE.MeshToonMaterial({ gradientMap: toonGradient(), vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aPat;
        attribute vec3 aCol2;
        attribute vec2 aLoc;
        varying vec4 vPat;
        varying vec3 vCol2;
        varying vec2 vLoc;
        varying vec3 vWPos;
        varying vec3 vWNor;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPat = aPat;
        vCol2 = aCol2;
        vLoc = aLoc;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWNor = normalize(mat3(modelMatrix) * normal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vPat;
        varying vec3 vCol2;
        varying vec2 vLoc;
        varying vec3 vWPos;
        varying vec3 vWNor;
        // A line of half-width hw (in cells) on every whole number of x, antialiased.
        float lineAt(float x, float hw) {
          float d = abs(fract(x + 0.5) - 0.5);
          float w = fwidth(x) * 0.9;
          return 1.0 - smoothstep(hw - w, hw + w, d);
        }
        // A stripe filling the first half of every cell, antialiased.
        float stripe(float x, float duty) {
          float f = fract(x);
          float w = fwidth(x) * 0.9;
          return smoothstep(-w, w, f) * (1.0 - smoothstep(duty - w, duty + w, f)) + smoothstep(1.0 - w, 1.0 + w, f);
        }
        float patternMask(vec4 pat) {
          int id = int(pat.x + 0.5);
          if (id == 0) return 0.0;
          float cell = max(pat.y, 1.0);
          vec3 an = abs(vWNor);
          vec2 uv = an.y > 0.6 ? vWPos.xz : (an.x > an.z ? vWPos.zy : vWPos.xy);
          if (id == 1) {
            vec2 c = floor(uv / cell);
            return mod(c.x + c.y, 2.0);
          }
          if (id == 2) {
            vec2 g = uv / cell;
            return max(lineAt(g.x, 1.4 / cell), lineAt(g.y, 1.4 / cell));
          }
          if (id == 3) {
            // Planks across the u axis (or v, by angle): a seam between boards, and staggered butt joints.
            vec2 g = pat.z > 0.5 ? uv.yx : uv;
            float row = floor(g.y / cell);
            float seam = lineAt(g.y / cell, 0.9 / cell);
            float butt = lineAt((g.x + row * cell * 2.7) / (cell * 6.0), 0.8 / (cell * 6.0));
            return max(seam, butt * 0.8);
          }
          if (id == 4) {
            vec2 g = uv / cell;
            return 0.85 * max(lineAt(g.x, 0.18), lineAt(g.y, 0.18));
          }
          if (id == 5) return stripe((uv.x + uv.y) / cell, 0.5);
          if (id == 6) {
            // Container ribs: vertical grooves along a side.
            float u = an.y > 0.6 ? 0.0 : (an.x > an.z ? vWPos.z : vWPos.x);
            return 0.55 * lineAt(u / cell, 0.2);
          }
          if (id == 7) {
            // Chevrons pointing up a ramp (vLoc: along it uphill, across it from its middle).
            return stripe((vLoc.x + abs(vLoc.y) * 0.85) / cell, 0.42);
          }
          if (id == 8) return stripe(vWPos.y / cell, 0.5);
          if (id == 9) {
            vec2 g = uv / cell;
            float joint = max(lineAt(g.x, 0.05), lineAt(g.y, 0.05));
            vec2 c = floor(g);
            float alt = mod(c.x + c.y, 2.0) * 0.35;
            return max(joint, alt);
          }
          if (id == 10) {
            // Boards laid across a bridge or walk (vLoc: along it, across it): a seam between each
            // and the next, every other one a shade darker.
            float b = vLoc.x / cell;
            return max(lineAt(b, 0.9 / cell), mod(floor(b), 2.0) * 0.22);
          }
          return 0.0;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vCol2, patternMask(vPat)) * vPat.w;`);
  };
  m.customProgramCacheKey = () => 'bright-v3';
  return m;
}

// ---------- colours ----------
const _c = new THREE.Color();
function rgbOf(hex) {
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}
const shadeOf = (rgb, k) => rgb.map((v) => v * k);
// A kind's style from the palette: { top, side, pattern, cell, sidePattern, sideCell, top2, side2, round }.
export function styleOf(map, kind) {
  const pal = map.palette || {};
  if (pal[kind]) return pal[kind];
  // Containers: 'ctr-<colour>' shares one style, recoloured.
  if (kind && kind.startsWith('ctr-') && pal.ctr) {
    const c = pal.ctrColours?.[kind.slice(4)] || '#e5484d';
    return { ...pal.ctr, top: c, side: c };
  }
  return pal.default || { top: '#cfc8bd', side: '#a39b8e' };
}

// Paint a non-indexed geometry: base colour, second colour and pattern for its tops, sides and
// undersides; sides shaded darker towards their foot (between z0 and z1, three y).
function paintGeo(geo, st, z0, z1, opts = {}) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const col2 = new Float32Array(n * 3);
  const pat = new Float32Array(n * 4);
  const top = rgbOf(st.top);
  const side = rgbOf(st.side || st.top);
  const top2 = st.top2 ? rgbOf(st.top2) : shadeOf(top, 0.78);
  const side2 = st.side2 ? rgbOf(st.side2) : shadeOf(side, 0.7);
  const foot = st.foot ?? 0.7;
  const span = Math.max(1, z1 - z0);
  for (let i = 0; i < n; i++) {
    const ny = nor.getY(i);
    const y = pos.getY(i);
    const up = ny > 0.55;
    const down = ny < -0.55;
    const c = up ? top : side;
    const c2 = up ? top2 : side2;
    col.set(c, i * 3);
    col2.set(c2, i * 3);
    const id = up ? PAT[st.pattern] || 0 : down ? 0 : PAT[st.sidePattern] || 0;
    const cell = up ? st.cell || 40 : st.sideCell || st.cell || 40;
    const shade = up ? 1 : down ? 0.55 : foot + (1 - foot) * Math.min(1, Math.max(0, (y - z0) / span));
    pat.set([id, cell, up ? opts.angle ?? st.angle ?? 0 : 0, shade], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aCol2', new THREE.BufferAttribute(col2, 3));
  geo.setAttribute('aPat', new THREE.BufferAttribute(pat, 4));
  // Pattern coordinates of its own (a ramp's chevrons start from its middle): along, across.
  const loc = new Float32Array(n * 2);
  const L0 = opts.local;
  if (L0) {
    for (let i = 0; i < n; i++) {
      const dx = pos.getX(i) - L0.cx;
      const dy = pos.getZ(i) - L0.cy;
      loc[i * 2] = dx * L0.ux + dy * L0.uy;
      loc[i * 2 + 1] = -dx * L0.uy + dy * L0.ux;
    }
  }
  geo.setAttribute('aLoc', new THREE.BufferAttribute(loc, 2));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}

// Flat colour pieces (rims, paint, props): one colour, no pattern, optional shade.
export function flatGeo(geo, hex, shade = 1, pattern = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const c = rgbOf(hex);
  const col = new Float32Array(n * 3);
  const col2 = new Float32Array(n * 3);
  const pat = new Float32Array(n * 4);
  const p = pattern ? rgbOf(pattern.color) : c;
  for (let i = 0; i < n; i++) {
    col.set(c, i * 3);
    col2.set(p, i * 3);
    pat.set([pattern ? PAT[pattern.id] : 0, pattern ? pattern.cell : 1, pattern ? pattern.angle || 0 : 0, shade], i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aCol2', new THREE.BufferAttribute(col2, 3));
  g.setAttribute('aPat', new THREE.BufferAttribute(pat, 4));
  g.setAttribute('aLoc', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

// ---------- geometry helpers for an arena's own pieces (physics space: x, y on the ground, z up) ----------
export function box(ax, ay, az, bx, by, bz, colour, r = 0, pattern = null) {
  const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)];
  const [y0, y1] = [Math.min(ay, by), Math.max(ay, by)];
  const [z0, z1] = [Math.min(az, bz), Math.max(az, bz)];
  const w = x1 - x0;
  const d = y1 - y0;
  const h = z1 - z0;
  const rr = Math.min(r, w / 2 - 0.1, d / 2 - 0.1, h / 2 - 0.1);
  const g = rr > 0.5 ? new RoundedBoxGeometry(w, h, d, 1, rr) : new THREE.BoxGeometry(w, h, d);
  g.translate((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2);
  return flatGeo(g, colour, 1, pattern);
}
export function post(x, y, z0, z1, r, colour, n = 10, r1 = r) {
  return flatGeo(new THREE.CylinderGeometry(r1, r, z1 - z0, n).translate(x, (z0 + z1) / 2, y), colour);
}
export function ball(x, y, z, r, colour, n = 10) {
  return flatGeo(new THREE.SphereGeometry(r, n, Math.max(6, n - 2)).translate(x, z, y), colour);
}
const _up = new THREE.Vector3(0, 1, 0);
export function strut(a, b, r, colour) {
  const A = new THREE.Vector3(a[0], a[2], a[1]);
  const B = new THREE.Vector3(b[0], b[2], b[1]);
  const d = B.clone().sub(A);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 6);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.clone().normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return flatGeo(g, colour);
}
export function merged(parts, cast = true) {
  const m = new THREE.Mesh(mergeGeometries(parts), brightMaterial());
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
export const darker = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
// Something that glows (lamps, beacons): unlit, so it reads at dusk; `on` dims it.
export function glow(geo, hex) {
  const mat = new THREE.MeshBasicMaterial({ color: hex, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.base = new THREE.Color(hex);
  return mesh;
}

// ---------- solids ----------
function boxGeometry(s, st, waterZ) {
  const w = s.x1 - s.x0;
  const d = s.y1 - s.y0;
  const h = s.z1 - s.z0;
  const r = Math.min(st.round ?? 6, w / 2 - 0.5, d / 2 - 0.5, h / 2 - 0.5);
  const geo = r >= 1.5 ? new RoundedBoxGeometry(w, h, d, r >= 5 ? 2 : 1, r) : new THREE.BoxGeometry(w, h, d).toNonIndexed();
  geo.translate((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2, (s.y0 + s.y1) / 2);
  return paintGeo(geo, st, Math.max(s.z0, waterZ ?? -Infinity), s.z1);
}

// A ramp: its sloped top, two sides, the tall end and the low end, down to its base.
function rampGeometry(s) {
  const { x0, x1, y0, y1, axis, sign } = s;
  const base = s.z0;
  // Heights at the four top corners.
  const hAt = (x, y) => {
    const p = axis ? y : x;
    const lo = axis ? y0 : x0;
    const hi = axis ? y1 : x1;
    let u = (p - lo) / (hi - lo || 1);
    if (sign < 0) u = 1 - u;
    return s.zl + (s.zh - s.zl) * u;
  };
  const P = (x, y, z) => [x, z, y];
  const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const tops = c.map(([x, y]) => P(x, y, hAt(x, y)));
  const bots = c.map(([x, y]) => P(x, y, base));
  const pos = [];
  const quad = (a, b, cc, d) => pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
  quad(tops[0], tops[3], tops[2], tops[1]); // top (wound to face up)
  quad(bots[0], bots[1], tops[1], tops[0]); // y0 side
  quad(bots[2], bots[3], tops[3], tops[2]); // y1 side
  quad(bots[3], bots[0], tops[0], tops[3]); // x0 end
  quad(bots[1], bots[2], tops[2], tops[1]); // x1 end
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return outward(geo);
}

// Wind every triangle of a convex shape to face away from its middle, then light it flat.
export function outward(geo) {
  const p = geo.attributes.position.array;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const n = p.length / 3;
  for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  for (let k = 0; k < p.length; k += 9) {
    const ax = p[k + 3] - p[k]; const ay = p[k + 4] - p[k + 1]; const az = p[k + 5] - p[k + 2];
    const bx = p[k + 6] - p[k]; const by = p[k + 7] - p[k + 1]; const bz = p[k + 8] - p[k + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const mx = (p[k] + p[k + 3] + p[k + 6]) / 3 - cx;
    const my = (p[k + 1] + p[k + 4] + p[k + 7]) / 3 - cy;
    const mz = (p[k + 2] + p[k + 5] + p[k + 8]) / 3 - cz;
    if (nx * mx + ny * my + nz * mz < 0) {
      for (let j = 0; j < 3; j++) { const t = p[k + 3 + j]; p[k + 3 + j] = p[k + 6 + j]; p[k + 6 + j] = t; }
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function cylinderGeometry(s, st) {
  const h = s.z1 - s.z0;
  const geo = new THREE.CylinderGeometry(s.r, s.r * (st.flare ?? 1), h, s.r > 30 ? 28 : 18).toNonIndexed();
  geo.translate(s.x, (s.z0 + s.z1) / 2, s.y);
  return geo;
}

// The uphill direction of a ramp in three's x-z plane (for its chevrons).
const uphill = (s) => (s.axis ? (s.sign > 0 ? Math.PI / 2 : -Math.PI / 2) : s.sign > 0 ? 0 : Math.PI);

// ---------- rims: where you can drive off ----------
// Walks every edge of every floor top and asks the map what lies just beyond it: more floor at the
// same height (nothing to paint), something taller (a wall: nothing to paint), or a drop (paint a
// rim). Returns runs: { pts: [[x, y, z], ...], outs: [[nx, ny], ...], drop } in physics space (a
// straight edge's run has two points, a round one's follows the curve).
export function dropEdges(map, opts = {}) {
  const STEP = 20;
  const runs = [];
  const minDrop = opts.minDrop ?? 14;
  const probe = (s, px, py, nx, ny, top) => {
    const qx = px + nx * 12;
    const qy = py + ny * 12;
    if (map.inside(qx, qy, top + 6)) return 'wall';
    const f = map.floorAt(qx, qy, top + 6, null);
    if (f >= top - minDrop) return 'flush';
    return Number.isFinite(f) ? top - f : 9999;
  };
  for (const s of map.solids) {
    if (s.type === 2 || s.type === 3 || s.thin) continue;
    if (s.kind === 'bumper' || s.kind === 'hub') continue;
    const w = s.x1 - s.x0;
    const d = s.y1 - s.y0;
    if (Math.min(w, d) < 40) continue;
    const ramp = s.type === 1;
    const topAt = (x, y) => {
      if (!ramp) return s.z1;
      const p = s.axis ? y : x;
      const lo = s.axis ? s.y0 : s.x0;
      const hi = s.axis ? s.y1 : s.x1;
      let u = (p - lo) / (hi - lo || 1);
      if (s.sign < 0) u = 1 - u;
      return s.zl + (s.zh - s.zl) * Math.min(1, Math.max(0, u));
    };
    // Only tops something can drive on: a top no higher than the highest anything is reached at.
    const edges = [
      [s.x0, s.y0, s.x1, s.y0, 0, -1], [s.x1, s.y1, s.x0, s.y1, 0, 1],
      [s.x0, s.y1, s.x0, s.y0, -1, 0], [s.x1, s.y0, s.x1, s.y1, 1, 0],
    ];
    for (const [ax, ay, bx, by, nx, ny] of edges) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / STEP));
      let start = null;
      let deepest = 0;
      const flush = (i) => {
        if (start === null) return;
        const t0 = start / n;
        const t1 = i / n;
        const pa = [ax + (bx - ax) * t0, ay + (by - ay) * t0];
        const pb = [ax + (bx - ax) * t1, ay + (by - ay) * t1];
        if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) >= 30) {
          runs.push({ pts: [[pa[0], pa[1], topAt(pa[0], pa[1])], [pb[0], pb[1], topAt(pb[0], pb[1])]], outs: [[nx, ny], [nx, ny]], drop: deepest, kind: s.kind, ramp });
        }
        start = null;
        deepest = 0;
      };
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const px = ax + (bx - ax) * t;
        const py = ay + (by - ay) * t;
        const r = probe(s, px, py, nx, ny, topAt(px, py));
        if (typeof r === 'number') {
          if (start === null) start = i;
          deepest = Math.max(deepest, r);
        } else flush(i);
      }
      flush(n);
    }
  }
  // Round tops big enough to drive about on (an island, a dais): round the edge the same way.
  for (const s of map.solids) {
    if (s.type !== 2 || s.r < 100 || s.kind === 'bumper' || s.kind === 'hub') continue;
    const n = Math.max(16, Math.round((TAU * s.r) / STEP));
    const dir = (i) => [Math.cos((i / n) * TAU), Math.sin((i / n) * TAU)];
    const drops = [];
    for (let i = 0; i < n; i++) {
      const [ux, uy] = dir(i + 0.5);
      drops.push(probe(s, s.x + ux * s.r, s.y + uy * s.r, ux, uy, s.z1));
    }
    const isDrop = (i) => typeof drops[(i + n) % n] === 'number';
    const point = (i) => { const [ux, uy] = dir(i); return [s.x + ux * s.r, s.y + uy * s.r, s.z1]; };
    // Start just after something that isn't a drop, so no run is cut in two at the seam (or, with
    // nothing but drops all round, one run the whole way).
    let first = 0;
    for (let i = 0; i < n; i++) if (!isDrop(i)) { first = i + 1; break; }
    let run = null;
    for (let k = 0; k <= n; k++) {
      const i = first + k;
      if (k < n && isDrop(i)) {
        if (!run) run = { pts: [point(i)], outs: [dir(i)], drop: 0, kind: s.kind };
        run.pts.push(point(i + 1));
        run.outs.push(dir(i + 1));
        run.drop = Math.max(run.drop, drops[(i + n) % n]);
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
  }
  return runs;
}

// A striped band along each run, on the top just inside the edge (W wide), dashes alternating
// between the two colours (a drop deeper than 200 gets the hazard pair).
function rimGeometry(runs, colours) {
  const parts = [];
  const W = 11; // band width
  const DASH = 34;
  for (const r of runs) {
    const pts = r.pts;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const len = cum[cum.length - 1];
    if (len < 1) continue;
    // Where along the run a distance d falls: position and outward normal, in between the points.
    let seg = 0;
    const along = (d) => {
      while (seg < pts.length - 2 && cum[seg + 1] < d) seg++;
      const u = Math.min(1, Math.max(0, (d - cum[seg]) / (cum[seg + 1] - cum[seg] || 1)));
      const a = pts[seg];
      const b = pts[seg + 1];
      const na = r.outs[seg];
      const nb = r.outs[seg + 1];
      let nx = na[0] + (nb[0] - na[0]) * u;
      let ny = na[1] + (nb[1] - na[1]) * u;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, nx, ny];
    };
    const n = Math.max(1, Math.round(len / DASH));
    const [ca, cb] = r.drop > 200 ? colours.hazard : colours.edge;
    for (let i = 0; i < n; i++) {
      const p0 = along((i / n) * len);
      const p1 = along(((i + 1) / n) * len);
      const za = p0[2] + 0.7;
      const zb = p1[2] + 0.7;
      // Outer and inner corners of this dash (inside the edge by up to W).
      const o0 = [p0[0] - p0[3], p0[1] - p0[4]];
      const o1 = [p1[0] - p1[3], p1[1] - p1[4]];
      const i0 = [o0[0] - p0[3] * W, o0[1] - p0[4] * W];
      const i1 = [o1[0] - p1[3] * W, o1[1] - p1[4] * W];
      const pos = [
        o0[0], za, o0[1], i0[0], za, i0[1], i1[0], zb, i1[1],
        o0[0], za, o0[1], i1[0], zb, i1[1], o1[0], zb, o1[1],
      ];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      // Face up whichever way the corners wound.
      if (g.attributes.normal.getY(0) < 0) {
        const p = g.attributes.position.array;
        for (let k = 0; k < p.length; k += 9) for (let j = 0; j < 3; j++) { const tmp = p[k + 3 + j]; p[k + 3 + j] = p[k + 6 + j]; p[k + 6 + j] = tmp; }
        g.computeVertexNormals();
      }
      parts.push(flatGeo(g, i % 2 ? cb : ca, 1));
    }
  }
  return parts.length ? mergeGeometries(parts) : null;
}

// ---------- roads: bridges, boardwalks, plank walks ----------
// A road's deck (its pattern laid out along and across it, so boards run across a walk), its sides
// down to its underside, striped rails along its kerbs, and a rim along any side with no rail where
// there's a drop beyond it. One geometry per road, in the arena's palette (road.kind, 'kerb').
function roadGeometry(map, road) {
  const S = road.samples;
  const st = styleOf(map, road.kind);
  const ks = styleOf(map, 'kerb');
  const pal = map.palette || {};
  const [rimA, rimB] = pal.rim || ['#ffffff', '#ef4444'];
  const hw = road.w / 2;
  const curb = road.curb;
  const cw = curb ? curb.w : 0;
  const ch = curb ? curb.h : 0;
  const railed = (side) => !!curb && (!curb.side || curb.side === side);
  const pos = [];
  const col = [];
  const col2 = [];
  const pat = [];
  const loc = [];
  // A point across the road at sample i: v across (left +), dz up from the deck there; three's x, y, z.
  const P = (i, v, dz) => {
    const o = S[i];
    return [o.x - o.uy * v, o.z + o.bank * v + dz, o.y + o.ux * v];
  };
  const top = rgbOf(st.top);
  const top2 = st.top2 ? rgbOf(st.top2) : shadeOf(top, 0.8);
  const side = rgbOf(st.side || st.top);
  const side2 = st.side2 ? rgbOf(st.side2) : side;
  // One quad (a, b, c, d round its edge), facing `up` (three's y) or outwards from the road's middle.
  const quad = (a, b, c, d, rgb, rgb2, id, cell, shade, uv, face) => {
    for (const [p, q, r] of [[a, b, c], [a, c, d]]) {
      // Wind it to face the way it should: up for tops, away from the road's centre line for sides.
      const ux = q[0] - p[0]; const uy = q[1] - p[1]; const uz = q[2] - p[2];
      const vx = r[0] - p[0]; const vy = r[1] - p[1]; const vz = r[2] - p[2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const flip = n[0] * face[0] + n[1] * face[1] + n[2] * face[2] < 0;
      const tri = flip ? [p, r, q] : [p, q, r];
      for (const v of tri) {
        pos.push(...v);
        col.push(...rgb);
        col2.push(...rgb2);
        pat.push(id, cell, 0, shade);
        loc.push(...(uv ? uv(v) : [0, 0]));
      }
    }
  };
  const UP = [0, 1, 0];
  const DOWN = [0, -1, 0];
  const outwards = (i, v) => { const o = S[i]; return [-o.uy * Math.sign(v), 0, o.ux * Math.sign(v)]; };
  const deckId = PAT[st.pattern] || 0;
  // Deck pattern coordinates: distance along the road and across it, from the samples.
  const along = (i) => S[i].s;
  for (let i = 0; i < S.length - 1; i++) {
    const j = i + 1;
    const inner0 = railed(1) ? hw - cw : hw;
    const inner1 = railed(-1) ? -(hw - cw) : -hw;
    const local = (i0, v0) => () => [along(i0), v0];
    // The deck, between the rails (or edge to edge), a hair above anything it overlaps.
    const a = P(i, inner1, 0.4); const b = P(j, inner1, 0.4); const c = P(j, inner0, 0.4); const d = P(i, inner0, 0.4);
    const uvs = new Map([[a, [along(i), inner1]], [b, [along(j), inner1]], [c, [along(j), inner0]], [d, [along(i), inner0]]]);
    quad(a, b, c, d, top, top2, deckId, st.cell || 30, 1, (v) => uvs.get(v) || [0, 0], UP);
    for (const sd of [1, -1]) {
      const edge = sd * hw;
      const face = outwards(i, sd);
      if (railed(sd)) {
        // A rail along the kerb: top, inner face and outer face, white and coral in turn.
        const stripe = Math.floor(S[i].s / 40) % 2 ? rgbOf(ks.top2 || '#ff7d8c') : rgbOf(ks.top || '#ffffff');
        const vIn = sd * (hw - cw);
        quad(P(i, vIn, ch), P(j, vIn, ch), P(j, edge, ch), P(i, edge, ch), stripe, stripe, 0, 1, 1, null, UP);
        quad(P(i, vIn, 0), P(j, vIn, 0), P(j, vIn, ch), P(i, vIn, ch), stripe, stripe, 0, 1, 0.9, null, [-face[0], 0, -face[2]]);
        quad(P(i, edge, ch), P(j, edge, ch), P(j, edge, -4), P(i, edge, -4), stripe, stripe, 0, 1, 0.92, null, face);
      } else {
        // The deck's own edge: a lip of its accent colour.
        quad(P(i, edge, 0.4), P(j, edge, 0.4), P(j, edge, -4), P(i, edge, -4), side2, side2, 0, 1, 1, null, face);
      }
      // The side, down to the underside, shaded towards the bottom.
      const th = road.thick;
      quad(P(i, edge, -4), P(j, edge, -4), P(j, edge, -th), P(i, edge, -th), side, side, 0, 1, 0.82, null, face);
    }
    quad(P(i, -hw, -road.thick), P(j, -hw, -road.thick), P(j, hw, -road.thick), P(i, hw, -road.thick), side, side, 0, 1, 0.55, null, DOWN);
  }
  // The two ends.
  for (const [i, sgn] of [[0, -1], [S.length - 1, 1]]) {
    const o = S[i];
    quad(P(i, -hw, 0.4), P(i, hw, 0.4), P(i, hw, -road.thick), P(i, -hw, -road.thick), side, side, 0, 1, 0.8, null, [o.ux * sgn, 0, o.uy * sgn]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aCol2', new THREE.Float32BufferAttribute(col2, 3));
  geo.setAttribute('aPat', new THREE.Float32BufferAttribute(pat, 4));
  geo.setAttribute('aLoc', new THREE.Float32BufferAttribute(loc, 2));
  geo.computeVertexNormals();
  // Rims along unrailed sides, wherever the deck's edge is over a drop.
  const runs = [];
  for (const sd of [1, -1]) {
    if (railed(sd)) continue;
    let run = null;
    const flush = () => { if (run && run.pts.length > 1) runs.push(run); run = null; };
    for (let i = 0; i < S.length; i++) {
      const o = S[i];
      const v = sd * hw;
      const ex = o.x - o.uy * v;
      const ey = o.y + o.ux * v;
      const z = o.z + o.bank * v;
      const nx = -o.uy * sd;
      const ny = o.ux * sd;
      const f = map.floorAt(ex + nx * 12, ey + ny * 12, z + 6, null);
      if (f < z - 14) {
        if (!run) run = { pts: [], outs: [], drop: 9999 };
        run.pts.push([ex, ey, z]);
        run.outs.push([nx, ny]);
      } else flush();
    }
    flush();
  }
  const rims = rimGeometry(runs, { edge: [rimA, rimB], hazard: pal.hazardRim || [rimA, rimB] });
  return rims ? mergeGeometries([geo, rims]) : geo;
}

// ---------- lane paint ----------
// def.paint: [{ type: 'line', from: [x, y], to: [x, y], z, w, color, dash, gap },
//             { type: 'zebra', x0, y0, x1, y1, z, color, along: 'x' | 'y' },
//             { type: 'box', x0, y0, x1, y1, z, w, color }, { type: 'circle', x, y, r, z, w, color }]
function paintGeometry(list) {
  const parts = [];
  const quad = (pts, z, color) => {
    const pos = [];
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) for (const p of [pts[i], pts[j], pts[k]]) pos.push(p[0], z, p[1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    if (g.attributes.normal.getY(0) < 0) {
      const p = g.attributes.position.array;
      for (let k = 0; k < p.length; k += 9) for (let j = 0; j < 3; j++) { const tmp = p[k + 3 + j]; p[k + 3 + j] = p[k + 6 + j]; p[k + 6 + j] = tmp; }
      g.computeVertexNormals();
    }
    parts.push(flatGeo(g, color, 1));
  };
  const strip = (ax, ay, bx, by, w, z, color) => {
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / len) * (w / 2);
    const ny = ((bx - ax) / len) * (w / 2);
    quad([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], z, color);
  };
  for (const p of list || []) {
    const z = (p.z || 0) + 0.45;
    const color = p.color || '#ffffff';
    if (p.type === 'line') {
      const [ax, ay] = p.from;
      const [bx, by] = p.to;
      const len = Math.hypot(bx - ax, by - ay);
      if (!p.dash) { strip(ax, ay, bx, by, p.w || 8, z, color); continue; }
      for (let t = 0; t < len; t += p.dash + (p.gap ?? p.dash)) {
        const t1 = Math.min(len, t + p.dash);
        strip(ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len, ax + ((bx - ax) * t1) / len, ay + ((by - ay) * t1) / len, p.w || 8, z, color);
      }
    } else if (p.type === 'zebra') {
      const alongX = p.along === 'x';
      const [a0, a1] = alongX ? [p.x0, p.x1] : [p.y0, p.y1];
      for (let t = a0; t < a1; t += 36) {
        if (alongX) quad([[t, p.y0], [t + 18, p.y0], [t + 18, p.y1], [t, p.y1]], z, color);
        else quad([[p.x0, t], [p.x1, t], [p.x1, t + 18], [p.x0, t + 18]], z, color);
      }
    } else if (p.type === 'box') {
      const w = p.w || 6;
      strip(p.x0, p.y0, p.x1, p.y0, w, z, color);
      strip(p.x1, p.y0, p.x1, p.y1, w, z, color);
      strip(p.x1, p.y1, p.x0, p.y1, w, z, color);
      strip(p.x0, p.y1, p.x0, p.y0, w, z, color);
    } else if (p.type === 'circle') {
      const n = Math.max(16, Math.round((p.r * TAU) / 30));
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU;
        const a1 = ((i + 1) / n) * TAU;
        strip(p.x + Math.cos(a0) * p.r, p.y + Math.sin(a0) * p.r, p.x + Math.cos(a1) * p.r, p.y + Math.sin(a1) * p.r, p.w || 8, z, color);
      }
    }
  }
  return parts.length ? mergeGeometries(parts) : null;
}

// ---------- water ----------
// A sea to the horizon: shallow turquoise near the arena deepening further out, a web of cartoon
// caustics drifting over it, and the sky's fog at the far edge.
export function buildWater(scene, map, look, ctx) {
  const S = map.size;
  const w = look.water || {};
  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(w.shallow || '#25c6d8') },
      uDeep: { value: new THREE.Color(w.deep || '#0b6e98') },
      uLine: { value: new THREE.Color(w.line || '#bff7ff') },
      uCentre: { value: new THREE.Vector2(S / 2, S / 2) },
      uReach: { value: S * 0.75 },
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
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uLine;
      uniform vec2 uCentre;
      uniform float uReach;
      varying vec3 vW;
      vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }
      // Distance to the nearest cell border of a drifting Voronoi pattern.
      float cells(vec2 p, float t) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float d1 = 8.0;
        float d2 = 8.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y));
          vec2 o = hash2(i + g);
          o = 0.5 + 0.42 * sin(t + 6.2831 * o);
          float d = length(g + o - f);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        return d2 - d1;
      }
      void main() {
        float far = clamp((length(vW.xz - uCentre) - uReach) / (uReach * 1.6), 0.0, 1.0);
        vec3 col = mix(uShallow, uDeep, 0.2 + 0.8 * far);
        // Slow swells of lighter and darker water so it isn't one flat colour.
        float swell = sin(vW.x * 0.0021 + uTime * 0.35) * sin(vW.z * 0.0017 - uTime * 0.27);
        col *= 0.95 + 0.07 * swell;
        vec2 p = vW.xz / 170.0;
        float e = cells(p, uTime * 0.55);
        float e2 = cells(p * 2.1 + 7.3, uTime * 0.75 + 2.0);
        float web = (1.0 - smoothstep(0.0, 0.045, e)) * 0.6 + (1.0 - smoothstep(0.0, 0.03, e2)) * 0.28;
        // The web fades out with distance (no net drawn across the whole sea).
        float camD = length(vW - cameraPosition);
        web *= 1.0 - smoothstep(1200.0, 3600.0, camD);
        col = mix(col, uLine, web * (1.0 - far) * 0.5);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), mat);
  sea.position.set(S / 2, map.liquid.z, S / 2);
  scene.add(sea);
  mat.uniforms.uTime = ctx.uniforms.uTime; // the clock kart3d advances every frame
  return sea;
}

// Foam where the water laps at anything standing in it: a soft white band round its waterline.
export function buildFoam(scene, map, ctx) {
  const z = map.liquid.z;
  const parts = [];
  for (const s of map.solids) {
    if (s.type === 3 || !(s.z0 < z - 2 && s.z1 > z + 2)) continue;
    if (s.type === 2) {
      parts.push(foamRing(s.x, s.y, s.r, z));
      continue;
    }
    // Each side that faces open water (sampled: anything there at the waterline?).
    const sides = [[s.x0, s.y0, s.x1, s.y0, 0, -1], [s.x1, s.y1, s.x0, s.y1, 0, 1], [s.x0, s.y1, s.x0, s.y0, -1, 0], [s.x1, s.y0, s.x1, s.y1, 1, 0]];
    for (const [ax, ay, bx, by, nx, ny] of sides) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / 40));
      let start = null;
      const open = (t) => !map.inside(ax + (bx - ax) * t + nx * 10, ay + (by - ay) * t + ny * 10, z + 1);
      for (let i = 0; i <= n; i++) {
        const ok = i < n && open((i + 0.5) / n);
        if (ok && start === null) start = i;
        if (!ok && start !== null) {
          const t0 = start / n;
          const t1 = i / n;
          parts.push(foamStrip(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, nx, ny, z));
          start = null;
        }
      }
    }
  }
  if (!parts.length) return null;
  const geo = mergeGeometries(parts);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      attribute float aU;
      attribute float aV;
      varying float vU;
      varying float vV;
      void main() {
        vU = aU; vV = aV;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      varying float vU;
      varying float vV;
      void main() {
        float wave = 0.5 + 0.5 * sin(vU * 0.07 + uTime * 2.1) * sin(vU * 0.023 - uTime * 1.3);
        float reach = 0.35 + 0.65 * wave;
        float a = (1.0 - smoothstep(reach - 0.25, reach, vV)) * (0.55 + 0.45 * wave);
        float breakup = step(0.35, fract(sin(floor(vU / 9.0) * 12.9898) * 43758.5453));
        a *= mix(0.6, 1.0, breakup) * smoothstep(0.0, 0.08, vV + 0.02);
        gl_FragColor = vec4(1.0, 1.0, 1.0, a * 0.85);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  scene.add(mesh);
  mat.uniforms.uTime = ctx.uniforms.uTime; // the clock kart3d advances every frame
  return mesh;
}
function foamStrip(ax, ay, bx, by, nx, ny, z) {
  const W = 26;
  const len = Math.hypot(bx - ax, by - ay);
  const pos = [ax, z + 0.6, ay, bx, z + 0.6, by, bx + nx * W, z + 0.6, by + ny * W, ax, z + 0.6, ay, bx + nx * W, z + 0.6, by + ny * W, ax + nx * W, z + 0.6, ay + ny * W];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // u: distance along the shore (world, so neighbouring strips line up); v: 0 at the wall, 1 out.
  const u0 = ax * Math.abs(ny) + ay * Math.abs(nx);
  const u1 = u0 + len * Math.sign((bx - ax) * Math.abs(ny) + (by - ay) * Math.abs(nx) || 1);
  g.setAttribute('aU', new THREE.Float32BufferAttribute([u0, u1, u1, u0, u1, u0], 1));
  g.setAttribute('aV', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1], 1));
  return g;
}
function foamRing(x, y, r, z) {
  const parts = [];
  const n = Math.max(10, Math.round(r / 4));
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 1) / n) * TAU;
    const p0 = [x + Math.cos(a0) * r, y + Math.sin(a0) * r];
    const p1 = [x + Math.cos(a1) * r, y + Math.sin(a1) * r];
    const g = foamStrip(p1[0], p1[1], p0[0], p0[1], Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), z);
    g.setAttribute('aU', new THREE.Float32BufferAttribute([a1 * r, a0 * r, a0 * r, a1 * r, a0 * r, a1 * r], 1));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

// ---------- the whole arena ----------
// Draws every static solid, the rims and the paint, the water and its foam. Solids big enough to
// drive under come back as roofs (each its own mesh and material, so it can fade like arena3d's).
// skip: kinds drawn by the arena's own dressing instead.
export function buildBrightSolids(scene, map, ctx, skip = new Set()) {
  const waterZ = map.liquid ? map.liquid.z : null;
  const parts = [];
  const roofs = [];
  for (const s of map.solids) {
    if (s.kind === 'bumper' || s.kind === 'hub' || s.type === 3 || skip.has(s.kind)) continue;
    const st = styleOf(map, s.kind);
    let geo;
    if (s.type === 2) geo = paintGeo(cylinderGeometry(s, st), st, Math.max(s.z0, waterZ ?? -Infinity), s.z1);
    else if (s.type === 1) {
      const a = uphill(s);
      geo = paintGeo(rampGeometry(s), st, s.z0, s.z1, { angle: a, local: { cx: s.axis ? (s.x0 + s.x1) / 2 : s.sign > 0 ? s.x0 : s.x1, cy: s.axis ? (s.sign > 0 ? s.y0 : s.y1) : (s.y0 + s.y1) / 2, ux: Math.cos(a), uy: Math.sin(a) } });
    }
    else geo = boxGeometry(s, st, waterZ);
    const footprint = s.type === 2 ? Math.PI * s.r * s.r : (s.x1 - s.x0) * (s.y1 - s.y0);
    if (s.z0 > 20 && footprint > 5000 && st.roof !== false && s.type === 0 && s.z0 > (st.onTop ?? -Infinity)) {
      const mat = makeMaterial();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const group = new THREE.Group();
      group.add(mesh);
      scene.add(group);
      roofs.push({ s, group, mats: [mat], fade: 1 });
      continue;
    }
    parts.push(geo);
  }
  // Roads (bridges, boardwalks, walks): one geometry each, merged with the rest.
  for (const road of map.roads || []) parts.push(roadGeometry(map, road));
  const mesh = new THREE.Mesh(mergeGeometries(parts), brightMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  // Rims along every drop, and the arena's own paint.
  const pal = map.palette || {};
  const rims = rimGeometry(dropEdges(map), { edge: pal.rim || ['#ffffff', '#ef4444'], hazard: pal.hazardRim || pal.rim || ['#ffd23f', '#2b2d33'] });
  const painted = paintGeometry(map.paint);
  for (const g of [rims, painted]) {
    if (!g) continue;
    const m = new THREE.Mesh(g, brightMaterial());
    m.receiveShadow = true;
    scene.add(m);
  }
  if (map.liquid && map.liquid.kind === 'water') {
    buildWater(scene, map, map.palette || {}, ctx);
    buildFoam(scene, map, ctx);
  }
  return { roofs };
}
