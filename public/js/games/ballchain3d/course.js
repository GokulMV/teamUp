// Ball & Chain scenery: candy-coloured floating course islands, padded obstacles, arches and sky.
// Everything here is built once per course in lane-local coordinates (x across, y along the course,
// rendered as world x and -z) and then placed once per team lane.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTexture, rng, tex as kartTex, MOBILE } from '../kart3d/world.js';

const BC = window.BallChainCore;

export const THEMES = {
  candy: {
    sky: [0x2f9dff, 0x8fd0ff, 0xc4e6ff], fog: 0xbfe2ff, sun: 0xfff2e0, sea: 0xe9f5ff,
    floor: ['#ffb3d4', '#ff97c4'], side: '#ff6fa8', layer: ['#ff86b9', '#9f86ff'], trim: '#ffffff',
    accent: '#8b6cff', alt: '#ffe27a', pillar: ['#b9a2ff', '#7ee0c3', '#ffb48a'], islands: ['#ff9ec7', '#9fe6ff', '#ffe27a'],
  },
  mint: {
    sky: [0x6b7dff, 0xc3c8ff, 0xe4dcff], fog: 0xd9d4ff, sun: 0xfff6e6, sea: 0xf1eeff,
    floor: ['#a8f2d6', '#7fe6bf'], side: '#2fc79a', layer: ['#3fcf9f', '#ff8fbf'], trim: '#ffffff',
    accent: '#ff6fae', alt: '#ffe27a', pillar: ['#ff9fc6', '#9ab8ff', '#ffd36e'], islands: ['#8de8c8', '#ffb3d3', '#b9a2ff'],
  },
  sunset: {
    sky: [0x7a63ff, 0xff9fc0, 0xffcfc0], fog: 0xffc8c4, sun: 0xffe2c0, sea: 0xfff0ea,
    floor: ['#ffdb92', '#ffc66a'], side: '#ff8a3d', layer: ['#ff9f55', '#ff6f9c'], trim: '#fffaf2',
    accent: '#7a6bff', alt: '#7fd6ff', pillar: ['#ff8fb1', '#9b8cff', '#7fd6ff'], islands: ['#ffb07a', '#ff8fb1', '#ffe27a'],
  },
};

const cache = {};
const once = (key, fn) => cache[key] || (cache[key] = fn());

// ---------- textures ----------
export const tex = {
  pad: (a, b) => once(`pad${a}${b}`, () => {
    const t = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = b; c.fillRect(0, 0, w, h);
      // Soft padded foam tiles with a highlight and a seam.
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const x = i * 128 + 5;
          const y = j * 128 + 5;
          const g = c.createLinearGradient(x, y, x + 118, y + 118);
          g.addColorStop(0, (i + j) % 2 ? a : '#ffffff');
          g.addColorStop(0.08, a);
          g.addColorStop(1, (i + j) % 2 ? a : b);
          c.fillStyle = g;
          c.beginPath(); c.roundRect(x, y, 118, 118, 22); c.fill();
          c.fillStyle = 'rgba(255,255,255,0.22)';
          c.beginPath(); c.ellipse(x + 40, y + 34, 26, 12, -0.5, 0, Math.PI * 2); c.fill();
        }
      }
    });
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }),
  stripes: (a, b, n = 8, vertical = true) => once(`st${a}${b}${n}${vertical}`, () => canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = a; c.fillRect(0, 0, w, h);
    c.fillStyle = b;
    for (let i = 0; i < n; i += 2) {
      if (vertical) c.fillRect((i * w) / n, 0, w / n, h);
      else c.fillRect(0, (i * h) / n, w, h / n);
    }
  })),
  danger: () => once('danger', () => canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#ff3d71';
    for (let x = -h; x < w + h; x += 48) {
      c.beginPath(); c.moveTo(x, h); c.lineTo(x + 24, h); c.lineTo(x + 24 + h, 0); c.lineTo(x + h, 0); c.fill();
    }
  })),
  chevrons: (fg, bg) => once(`chev${fg}${bg}`, () => canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    for (let y = 0; y < h; y += 16) c.fillRect(0, y, w, 2);
    c.fillStyle = fg;
    for (let k = 0; k < 2; k++) {
      const y = 12 + k * 64;
      c.beginPath(); c.moveTo(14, y + 40); c.lineTo(w / 2, y); c.lineTo(w - 14, y + 40); c.lineTo(w - 34, y + 40); c.lineTo(w / 2, y + 18); c.lineTo(34, y + 40); c.fill();
    }
  })),
  arrows: (fg) => once(`arrows${fg}`, () => canvasTexture(128, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = fg;
    c.globalAlpha = 0.5;
    c.beginPath(); c.moveTo(16, 150); c.lineTo(w / 2, 60); c.lineTo(w - 16, 150); c.lineTo(w - 40, 150); c.lineTo(w / 2, 96); c.lineTo(40, 150); c.fill();
  }, false)),
  checker: () => once('checker', () => canvasTexture(128, 128, (c) => {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      c.fillStyle = (i + j) % 2 ? '#2b2440' : '#ffffff';
      c.fillRect(i * 32, j * 32, 32, 32);
    }
  })),
  ice: () => once('ice', () => canvasTexture(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#d9f3ff'); g.addColorStop(0.5, '#bfe9ff'); g.addColorStop(1, '#e8f8ff');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const r = rng(9);
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 26; i++) {
      c.lineWidth = 1 + r() * 3;
      const x = r() * w; const y = r() * h; const l = 20 + r() * 60;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + l, y - l * 0.5); c.stroke();
    }
  })),
  mud: () => once('mud', () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#8a5a3b'; c.fillRect(0, 0, w, h);
    const r = rng(4);
    for (let i = 0; i < 70; i++) {
      const x = r() * w; const y = r() * h; const rad = 6 + r() * 22;
      const g = c.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 1, x, y, rad);
      g.addColorStop(0, r() < 0.5 ? '#b07a52' : '#a06b47'); g.addColorStop(1, 'rgba(110,70,45,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
    }
  })),
  plate: () => once('plate', () => canvasTexture(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    g.addColorStop(0, '#e9feff'); g.addColorStop(0.55, '#5ff4ff'); g.addColorStop(0.8, '#11c5e8'); g.addColorStop(1, '#0ba5d0');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#ffffff'; c.lineWidth = 6;
    c.beginPath(); c.arc(w / 2, h / 2, w * 0.3, 0, Math.PI * 2); c.stroke();
  }, false)),
  banner: (text, bg, fg = '#ffffff') => once(`banner${text}${bg}`, () => canvasTexture(512, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, bg); g.addColorStop(1, new THREE.Color(bg).multiplyScalar(0.82).getStyle());
    c.fillStyle = g; c.beginPath(); c.roundRect(4, 4, w - 8, h - 8, 40); c.fill();
    c.font = '900 76px "Bricolage Grotesque", "Trebuchet MS", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 12; c.strokeStyle = 'rgba(40,20,70,0.35)'; c.strokeText(text, w / 2, h / 2 + 4);
    c.fillStyle = fg; c.fillText(text, w / 2, h / 2 + 2);
  }, false)),
  cloudSea: () => once('cloudSea', () => {
    const t = canvasTexture(512, 512, (c, w, h) => {
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
      const r = rng(31);
      for (let i = 0; i < 140; i++) {
        const x = r() * w; const y = r() * h; const rad = 20 + r() * 70;
        const g = c.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(225,232,255,0.55)'); g.addColorStop(1, 'rgba(225,232,255,0)');
        c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    });
    t.repeat.set(10, 10);
    return t;
  }),
};

// ---------- materials ----------
const matCache = {};
export function mat(key, make) {
  if (!matCache[key]) matCache[key] = make();
  return matCache[key];
}
const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, ...o });
const glossy = (o) => std({ roughness: 0.22, envMapIntensity: 1.3, ...o });

// ---------- heights: slides drop the course, tilts lean it, ramps rise ----------
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
export function makeHeight(C) {
  const drops = [];
  const tilts = [];
  for (const z of C.zones) {
    if (z.type !== 'slope') continue;
    if (z.gy) drops.push({ y0: z.y0, y1: z.y1, d: 120 });
    if (z.gx) tilts.push({ x0: z.x0, x1: z.x1, y0: z.y0, y1: z.y1, k: -Math.sign(z.gx) * (60 / 280) });
  }
  const ramps = C.ramps;
  return (x, y) => {
    let h = 0;
    for (const d of drops) h -= d.d * smooth(d.y0, d.y1, y);
    for (const t of tilts) {
      if (y < t.y0 - 1 || y > t.y1 + 1) continue;
      h += t.k * x * smooth(t.y0, t.y0 + 70, y) * (1 - smooth(t.y1 - 70, t.y1, y));
    }
    for (const r of ramps) {
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      h += 34 * ((y - r.y0) / (r.y1 - r.y0)) * smooth(r.x0, r.x0 + 14, x) * (1 - smooth(r.x1 - 14, r.x1, x));
    }
    return h;
  };
}

// Lane-local (x, y, height) -> world vector for a lane offset.
const V = (x, y, h) => new THREE.Vector3(x, h, -y);

// A floor top as a grid that follows the height function.
function gridTop(x0, x1, y0, y1, H, step, lift = 0) {
  const nx = Math.max(1, Math.ceil((x1 - x0) / step));
  const ny = Math.max(1, Math.ceil((y1 - y0) / step));
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const y = y0 + ((y1 - y0) * j) / ny;
      pos.push(x, H(x, y) + lift, -y);
      uv.push(x / 160, y / 160);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

// Edge runs of a floor that face the void (shared edges between floors get no rim or skirt).
function voidRuns(C, f, pts, normals) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = normals[i];
    const inside = C.floors.some((g) => g !== f && !g.sway && pointIn(g, x + nx * 4, y + ny * 4));
    if (!inside) {
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(i);
    } else {
      cur = null;
    }
  }
  return runs;
}
function pointIn(f, x, y) {
  if (f.circle) return (x - f.cx) ** 2 + (y - f.cy) ** 2 <= f.r * f.r;
  return x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1;
}

// Perimeter samples (with outward normals) of a floor, every `step` units.
function perimeter(f, step = 16) {
  const pts = [];
  const nrm = [];
  if (f.circle) {
    const n = Math.max(24, Math.round((Math.PI * 2 * f.r) / step));
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([f.cx + Math.cos(a) * f.r, f.cy + Math.sin(a) * f.r]);
      nrm.push([Math.cos(a), Math.sin(a)]);
    }
    return { pts, nrm, closed: true };
  }
  const corners = [[f.x0, f.y0, 0, -1], [f.x1, f.y0, 1, 0], [f.x1, f.y1, 0, 1], [f.x0, f.y1, -1, 0]];
  for (let k = 0; k < 4; k++) {
    const [ax, ay, nx, ny] = corners[k];
    const [bx, by] = corners[(k + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      pts.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
      nrm.push([nx, ny]);
    }
  }
  pts.push(pts[0]);
  nrm.push(nrm[0]);
  return { pts, nrm, closed: true };
}

// Skirt (candy-striped side wall) under a run of edge points.
function skirt(points, H, depth) {
  const pos = [];
  const uv = [];
  let u = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const ha = H(ax, ay);
    const hb = H(bx, by);
    const l = Math.hypot(bx - ax, by - ay) / 60;
    pos.push(ax, ha, -ay, bx, hb, -by, ax, ha - depth, -ay, bx, hb, -by, bx, hb - depth, -by, ax, ha - depth, -ay);
    uv.push(u, 1, u + l, 1, u, 0, u + l, 1, u + l, 0, u, 0);
    u += l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// Soft foam rim along a run of edge points.
function rim(points, H, radius, lift) {
  if (points.length < 2) return null;
  const v = points.map(([x, y]) => V(x, y, H(x, y) + lift));
  const curve = new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0.1);
  const tube = new THREE.TubeGeometry(curve, Math.max(2, v.length * 2), radius, MOBILE ? 6 : 8, false);
  const caps = [v[0], v[v.length - 1]].map((p) => new THREE.SphereGeometry(radius, 8, 6).translate(p.x, p.y, p.z));
  return mergeGeometries([tube.toNonIndexed(), ...caps.map((c) => c.toNonIndexed())]);
}

// Merge geometries per material key.
class Bucket {
  constructor() { this.parts = new Map(); }
  add(key, geo) {
    if (!geo) return;
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
  }
  meshes(materials) {
    const out = [];
    for (const [key, list] of this.parts) {
      const geo = mergeGeometries(list);
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, materials[key]);
      m.castShadow = !key.startsWith('top') && !key.startsWith('zone');
      m.receiveShadow = true;
      out.push(m);
    }
    return out;
  }
}

const place = (geo, x, y, h, ry = 0) => {
  geo.rotateY(ry);
  geo.translate(x, h, -y);
  return geo;
};

// Arch materials flap the vertices marked with a `wave` weight (pennants and flags).
const flapTime = { value: 0 };
function flapShader(sh) {
  sh.uniforms.uFlap = flapTime;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float wave;\nuniform float uFlap;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      float ph = uFlap * 5.0 + position.x * 0.06 + position.y * 0.04;
      transformed.z += sin(ph) * 9.0 * wave;
      transformed.y += cos(ph * 1.3) * 3.0 * wave;`);
}

// ---------- building a course ----------
// Returns { lanes: [Group], dyn: per-lane dynamic objects, height, update(t, laneStates) }.
export function buildCourse(scene, C, themeName, laneXs) {
  const T = THEMES[themeName] || THEMES.candy;
  const H = makeHeight(C);
  const M = {
    top: std({ map: tex.pad(T.floor[0], T.floor[1]), roughness: 0.62 }),
    topBridge: std({ map: tex.stripes(T.alt, '#fff6d8', 6, false), roughness: 0.6 }),
    topGoal: std({ map: tex.checker(), roughness: 0.5 }),
    topPlank: std({ color: 0xfffaf0, roughness: 0.55 }),
    topDisc: std({ map: tex.pad(T.alt, new THREE.Color(T.alt).multiplyScalar(0.9).getStyle()), roughness: 0.55 }),
    side: std({ map: tex.stripes(T.side, '#ffffff', 8, true), roughness: 0.5 }),
    layer1: std({ color: T.layer[0], roughness: 0.7 }),
    layer2: std({ color: T.layer[1], roughness: 0.6 }),
    trim: std({ color: T.trim, roughness: 0.4 }),
    rail: glossy({ map: tex.stripes('#ffffff', T.accent, 10, true) }),
    wall: std({ color: new THREE.Color(T.accent).lerp(new THREE.Color('#ffffff'), 0.25), roughness: 0.45 }),
    wallTop: std({ color: 0xffffff, roughness: 0.4 }),
    pillar: glossy({ map: tex.stripes('#ffffff', '#ffffff', 2, false), color: 0xffffff }),
    danger: std({ map: tex.danger(), roughness: 0.45 }),
    zoneIce: std({ map: tex.ice(), roughness: 0.08, envMapIntensity: 1.6, transparent: true, opacity: 0.92 }),
    zoneMud: std({ map: tex.mud(), roughness: 0.95 }),
    zoneArrow: new THREE.MeshBasicMaterial({ map: tex.arrows('#ffffff'), transparent: true, depthWrite: false }),
    ramp: std({ map: tex.chevrons('#ff5d8f', '#ffd84d'), roughness: 0.45 }),
    metal: std({ color: 0xe8ecf6, roughness: 0.3, metalness: 0.4 }),
    dark: std({ color: 0x3a3456, roughness: 0.6 }),
  };
  for (const key of ['top', 'topBridge', 'topDisc', 'side']) M[key].map.wrapS = M[key].map.wrapT = THREE.RepeatWrapping;
  const belt = tex.chevrons('#ffe14d', '#3b3561').clone();
  belt.needsUpdate = true;
  belt.wrapS = belt.wrapT = THREE.RepeatWrapping;
  M.belt = std({ map: belt, roughness: 0.5 });

  const bucket = new Bucket();
  const swayFloors = [];
  const SKIRT = 46;

  // Floors: padded top, candy-striped skirt, foam rim, and cake layers underneath.
  for (const f of C.floors) {
    const topKey = { bridge: 'topBridge', goal: 'topGoal', plank: 'topPlank', disc: 'topDisc' }[f.kind] || 'top';
    const target = f.sway ? new Bucket() : bucket;
    const sloped = C.zones.some((z) => z.type === 'slope' && z.x0 < f.x1 && z.x1 > f.x0 && z.y0 < f.y1 && z.y1 > f.y0) || C.ramps.some((r) => r.y0 < f.y1 && r.y1 > f.y0 && r.x0 < f.x1 && r.x1 > f.x0);
    if (f.circle) {
      const top = new THREE.CircleGeometry(f.r, 48).rotateX(-Math.PI / 2);
      const uv = top.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - 0.5) * (f.r / 80), (uv.getY(i) - 0.5) * (f.r / 80));
      target.add(topKey, place(top, f.cx, f.cy, H(f.cx, f.cy)));
    } else {
      target.add(topKey, gridTop(f.x0, f.x1, f.y0, f.y1, H, sloped ? 40 : 1e9));
    }
    const per = perimeter(f);
    const runs = f.sway ? [per.pts.map((_, i) => i)] : voidRuns(C, f, per.pts, per.nrm);
    for (const run of runs) {
      const pts = run.map((i) => per.pts[i]);
      if (pts.length < 2) continue;
      target.add('side', skirt(pts, H, SKIRT));
      target.add('trim', rim(pts, H, f.kind === 'plank' ? 4 : 7, 1));
    }
    // Cake layers underneath (hidden where floors meet).
    let minH = H(f.cx ?? f.x0, f.cy ?? f.y0);
    if (!f.circle) {
      minH = Infinity;
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) minH = Math.min(minH, H(f.x0 + ((f.x1 - f.x0) * i) / 6, f.y0 + ((f.y1 - f.y0) * j) / 6));
    }
    if (f.circle) {
      target.add('layer1', place(new THREE.CylinderGeometry(f.r - 14, f.r - 22, 60, 40), f.cx, f.cy, minH - SKIRT - 30));
      target.add('layer2', place(new THREE.CylinderGeometry(f.r - 26, f.r * 0.45, 90, 40), f.cx, f.cy, minH - SKIRT - 105));
    } else if (f.kind !== 'plank') {
      const w = f.x1 - f.x0;
      const d = f.y1 - f.y0;
      const cx = (f.x0 + f.x1) / 2;
      const cy = (f.y0 + f.y1) / 2;
      target.add('layer1', place(new RoundedBoxGeometry(Math.max(10, w - 24), 60, Math.max(10, d - 24), 2, 14), cx, cy, minH - SKIRT - 26));
      if (w > 120 && d > 120) target.add('layer2', place(new RoundedBoxGeometry(w - 70, 70, d - 70, 2, 24), cx, cy, minH - SKIRT - 86));
    }
    if (f.sway) swayFloors.push({ f, bucket: target });
  }

  // Effect zones painted on the floor.
  for (const z of C.zones) {
    if (z.type === 'ice') bucket.add('zoneIce', gridTop(z.x0 + 4, z.x1 - 4, z.y0, z.y1, H, 80, 0.8));
    else if (z.type === 'mud') bucket.add('zoneMud', gridTop(z.x0, z.x1, z.y0, z.y1, H, 80, 0.8));
    else if (z.type === 'slope') {
      // Painted arrows pointing downhill.
      const ang = Math.atan2(z.gy, z.gx); // direction in lane space
      for (let y = z.y0 + 90; y < z.y1 - 40; y += 170) {
        for (let x = z.x0 + 90; x < z.x1 - 40; x += 180) {
          const g = new THREE.PlaneGeometry(70, 140).rotateX(-Math.PI / 2).rotateY(ang - Math.PI / 2);
          bucket.add('zoneArrow', place(g, x, y, H(x, y) + 1.2));
        }
      }
    }
  }
  const belts = C.zones.filter((z) => z.type === 'belt');
  for (const z of belts) {
    const g = gridTop(z.x0, z.x1, z.y0, z.y1, H, 1e9, 1.4);
    // Arrows run along the belt direction.
    const uv = g.attributes.uv;
    const pos = g.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const x = pos.getX(i);
      const y = -pos.getZ(i);
      if (z.vx) uv.setXY(i, (y / 128) * Math.sign(z.vx), (x / 128) * Math.sign(z.vx));
      else uv.setXY(i, (x / 128) * Math.sign(z.vy || 1), (y / 128) * Math.sign(z.vy || 1));
    }
    bucket.add('belt', g);
    // Rollers at both ends.
    for (const y of [z.y0, z.y1]) {
      const roll = new THREE.CylinderGeometry(9, 9, z.x1 - z.x0, 12).rotateZ(Math.PI / 2);
      bucket.add('metal', place(roll, (z.x0 + z.x1) / 2, y, H(0, y) + 2));
    }
  }
  M.belt.userData.speed = belts.length ? Math.abs(belts[0].vx || belts[0].vy) / 128 : 0;

  // Rails and walls.
  for (const w of C.walls) {
    const len = Math.max(w.x1 - w.x0, w.y1 - w.y0);
    const alongY = w.y1 - w.y0 > w.x1 - w.x0;
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    if (w.kind === 'rail') {
      const n = Math.max(2, Math.round(len / 40));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = alongY ? cx : w.x0 + (w.x1 - w.x0) * t;
        const y = alongY ? w.y0 + (w.y1 - w.y0) * t : cy;
        pts.push([x, y]);
      }
      bucket.add('rail', rim(pts, H, 12, 18));
      for (let i = 0; i <= n; i += 3) {
        const [x, y] = pts[i];
        bucket.add('wallTop', place(new THREE.CylinderGeometry(4, 5, 18, 8), x, y, H(x, y) + 9));
      }
    } else {
      const g = new RoundedBoxGeometry(w.x1 - w.x0, 80, w.y1 - w.y0, 3, 10);
      bucket.add('wall', place(g, cx, cy, H(cx, cy) + 40));
      bucket.add('danger', place(new RoundedBoxGeometry(w.x1 - w.x0 + 2, 14, w.y1 - w.y0 + 2, 2, 6), cx, cy, H(cx, cy) + 76));
    }
  }

  // Ramps: a striped wedge.
  for (const r of C.ramps) {
    bucket.add('ramp', gridTop(r.x0, r.x1, r.y0, r.y1, H, 20, 0.6));
    const lip = [[r.x0, r.y1], [r.x1, r.y1]];
    bucket.add('danger', skirt(lip, (x, y) => H(x, y - 0.01) + 1, 36));
  }

  // Sweeper pivots and fan housings are static.
  for (const s of C.sweepers) {
    bucket.add('danger', place(new THREE.CylinderGeometry(40, 46, 70, 28), s.x, s.y, H(s.x, s.y) + 35));
    bucket.add('wallTop', place(new THREE.SphereGeometry(40, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5, 1), s.x, s.y, H(s.x, s.y) + 70));
  }
  for (const fan of C.fans) {
    const dir = fan.dir;
    const z = C.zones[fan.zone];
    const fh = H(0, fan.y);
    const ring = new THREE.TorusGeometry(80, 14, 12, 36).rotateY(Math.PI / 2);
    bucket.add('wall', place(ring, fan.x, fan.y, fh + 100));
    bucket.add('dark', place(new THREE.CylinderGeometry(76, 76, 18, 36).rotateZ(Math.PI / 2), fan.x - dir * 10, fan.y, fh + 100));
    bucket.add('metal', place(new THREE.BoxGeometry(26, 300, 26), fan.x, fan.y, fh - 110));
    void z;
  }
  for (const h of C.hammers) {
    const width = h.amp + 120;
    const hh = H(h.x, h.y);
    const top = 300;
    for (const side of [-1, 1]) {
      bucket.add('rail', place(new THREE.CylinderGeometry(12, 14, top + 220, 16), h.x + side * width, h.y, hh + (top - 220) / 2));
    }
    bucket.add('rail', place(new THREE.CylinderGeometry(13, 13, width * 2, 16).rotateZ(Math.PI / 2), h.x, h.y, hh + top));
  }

  // Inflatable arches at the start, every checkpoint and the goal.
  const arches = [];
  // The first checkpoint is where the start pad ends, so its arch is the START arch.
  C.checkpoints.forEach((cp, i) => {
    if (i === 0) return;
    arches.push({ y: cp.y, kind: i === 1 ? 'start' : 'cp', idx: i });
  });
  if (C.goal) arches.push({ y: C.goal.y, kind: 'goal' });
  // Each arch is one vertex-coloured mesh so it can fade out when it would hide your ball.
  const colorize = (geo, hex) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const c = new THREE.Color(hex);
    const arr = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    if (!g.attributes.wave) g.setAttribute('wave', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    return g;
  };
  // Cloth (pennants, flags): triangles given as [x, y, z, wave] corners; `wave` is how far it flaps.
  const cloth = (tris, hex) => {
    const pos = [];
    const wave = [];
    for (const t of tris) for (const [x, y, z, w] of t) { pos.push(x, y, z); wave.push(w); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    g.setAttribute('wave', new THREE.Float32BufferAttribute(wave, 1));
    g.computeVertexNormals();
    return colorize(g, hex);
  };
  const PENNANTS = ['#ff5d8f', '#ffd84d', '#5ee38c', '#4cc3ff', '#9b7bff', '#ffffff'];
  // Bunting strung across the arch, and a flag on a pole either side of it.
  const flags = (parts, span, y, h0, colors) => {
    const c = h0 - 20 + span * 0.5;
    const half = span * 0.86;
    const n = 13;
    const str = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const x = -half + u * half * 2;
      str.push(V(x, y, c - 34 * (1 - (2 * u - 1) ** 2)));
    }
    parts.push(colorize(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(str), 24, 1.6, 4, false), '#ffffff'));
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const x = -half + u * half * 2;
      const top = c - 34 * (1 - (2 * u - 1) ** 2);
      parts.push(cloth([[[x - 13, top, -y, 0], [x + 13, top, -y, 0], [x, top - 34, -y, 1]]], PENNANTS[k % PENNANTS.length]));
    }
    for (const side of [-1, 1]) {
      const px = side * (span + 46);
      const ph = h0 + 210;
      parts.push(colorize(place(new THREE.CylinderGeometry(3.5, 4.5, 210, 10), px, y, h0 + 105), '#ffffff'));
      parts.push(colorize(place(new THREE.SphereGeometry(7, 12, 8), px, y, ph + 4), colors[0]));
      // A swallow-tail flag streaming outward from the pole.
      const fx = px + side * 4;
      const w = side * 74;
      const quad = [[fx, ph, 0], [fx + w, ph - 4, 1], [fx + w * 0.82, ph - 24, 1], [fx + w, ph - 44, 1], [fx, ph - 48, 0]];
      const tri = (a, b, cc) => [a, b, cc].map(([qx, qy, wv]) => [qx, qy, -y, wv]);
      parts.push(cloth([tri(quad[0], quad[1], quad[2]), tri(quad[0], quad[2], quad[4]), tri(quad[2], quad[3], quad[4])], colors[1 % colors.length]));
    }
  };
  for (const a of arches) {
    const span = a.kind === 'goal' ? 330 : 300;
    const h0 = H(0, a.y);
    const colors = a.kind === 'goal' ? ['#ff5d8f', '#ffb547', '#ffe14d', '#5ee38c', '#4cc3ff', '#9b7bff'] : [T.accent, '#ffffff'];
    const rings = a.kind === 'goal' ? 6 : 2;
    const parts = [];
    for (let k = 0; k < rings; k++) {
      const radius = span - k * 18;
      parts.push(colorize(place(new THREE.TorusGeometry(radius, 12, 10, 48, Math.PI), 0, a.y, h0 - 20), colors[k % colors.length]));
    }
    for (const side of [-1, 1]) parts.push(colorize(place(new THREE.CylinderGeometry(22, 26, 40, 16), side * span, a.y, h0), '#ffffff'));
    flags(parts, span, a.y, h0, a.kind === 'goal' ? ['#ffd84d', '#ff4f8b'] : a.kind === 'start' ? ['#ffd84d', '#5b6bff'] : ['#ffffff', T.accent]);
    a.geo = mergeGeometries(parts);
    const text = a.kind === 'goal' ? 'FINISH' : a.kind === 'start' ? 'START' : 'CHECKPOINT';
    const bannerColor = a.kind === 'goal' ? '#ff4f8b' : a.kind === 'start' ? '#5b6bff' : T.side;
    const bannerMat = mat(`banner${text}${bannerColor}`, () => std({ map: tex.banner(text, bannerColor), roughness: 0.5, side: THREE.DoubleSide }));
    a.banner = { geo: place(new THREE.PlaneGeometry(260, 65), 0, a.y, h0 + span - 70), mat: bannerMat };
  }

  // Instanced, lane-wide pillars and bumpers.
  const lanesN = laneXs.length;
  const pillars = C.posts.filter((p) => p.kind === 'pillar');
  const bumpers = C.posts.filter((p) => p.kind === 'bumper');
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const col = new THREE.Color();
  let pillarMesh = null;
  if (pillars.length) {
    const g = mergeGeometries([
      new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0),
      new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 1, 0),
    ].map((x) => x.toNonIndexed()));
    const m = glossy({ map: tex.stripes('#ffffff', '#b8b8c4', 7, false) });
    pillarMesh = new THREE.InstancedMesh(g, m, pillars.length * lanesN);
    let k = 0;
    for (const lx of laneXs) {
      pillars.forEach((p, i) => {
        tmpM.compose(tmpP.set(lx + p.x, H(p.x, p.y), -p.y), tmpQ.identity(), tmpS.set(p.r, 110, p.r));
        pillarMesh.setMatrixAt(k, tmpM);
        pillarMesh.setColorAt(k, col.set(T.pillar[i % T.pillar.length]));
        k++;
      });
    }
    pillarMesh.castShadow = true;
    pillarMesh.receiveShadow = true;
    scene.add(pillarMesh);
  }
  let bumperBase = null;
  let bumperTop = null;
  if (bumpers.length) {
    bumperBase = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.08, 1, 28).translate(0, 0.5, 0), std({ map: tex.stripes('#ff4f8b', '#ffffff', 12, true), roughness: 0.45 }), bumpers.length * lanesN);
    bumperTop = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), glossy({ color: 0xff3d7f }), bumpers.length * lanesN);
    bumperBase.castShadow = bumperTop.castShadow = true;
    scene.add(bumperBase, bumperTop);
  }

  // Per-lane groups (static merged meshes) and dynamic parts.
  const staticMeshes = bucket.meshes(M);
  const lanes = laneXs.map((lx, li) => {
    const group = new THREE.Group();
    group.position.x = lx;
    for (const m of staticMeshes) group.add(li === 0 ? m : m.clone());
    scene.add(group);
    const dyn = { group, sway: [], gates: [], plates: [], sweepers: [], hammers: [], fans: [], arches: [] };
    for (const a of arches) {
      const am = glossy({ vertexColors: true, transparent: true, side: THREE.DoubleSide });
      am.onBeforeCompile = flapShader;
      const mesh = new THREE.Mesh(a.geo, am);
      mesh.castShadow = true;
      const bm = a.banner.mat.clone();
      bm.transparent = true;
      const banner = new THREE.Mesh(a.banner.geo, bm);
      group.add(mesh, banner);
      dyn.arches.push({ z: -a.y, mats: [am, bm], fade: 1 });
    }
    for (const s of swayFloors) {
      const sg = new THREE.Group();
      for (const m of s.bucket.meshes(M)) sg.add(m);
      group.add(sg);
      dyn.sway.push({ f: s.f, mesh: sg });
    }
    for (const g of C.gates) {
      const w = g.x1 - g.x0;
      const d = g.y1 - g.y0;
      const m = new THREE.Mesh(new RoundedBoxGeometry(w - 4, 76, d - 6, 3, 10), M.danger);
      const cx = (g.x0 + g.x1) / 2;
      const cy = (g.y0 + g.y1) / 2;
      m.position.set(cx, H(cx, cy) + 38, -cy);
      m.castShadow = true;
      m.userData.base = m.position.y;
      m.userData.open = 0;
      group.add(m);
      dyn.gates.push(m);
    }
    for (const p of C.plates) {
      const pm = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r + 4, 8, 36), std({ map: tex.plate(), emissive: 0x22d3ee, emissiveIntensity: 0.35, roughness: 0.3 }));
      pm.position.set(p.x, H(p.x, p.y) + 3, -p.y);
      pm.receiveShadow = true;
      group.add(pm);
      const ring = new THREE.Mesh(new THREE.RingGeometry(p.r + 8, p.r + 16, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.5, depthWrite: false }));
      ring.position.set(p.x, H(p.x, p.y) + 1.5, -p.y);
      group.add(ring);
      dyn.plates.push({ mesh: pm, ring, on: 0 });
    }
    for (const s of C.sweepers) {
      const arm = new THREE.Group();
      arm.position.set(s.x, H(s.x, s.y) + 30, -s.y);
      const armMat = mat('sweepArm', () => std({ map: tex.danger(), roughness: 0.45 }));
      for (let k = 0; k < s.arms; k++) {
        const a = (k * Math.PI * 2) / s.arms;
        const g = new THREE.CapsuleGeometry(s.w, s.len - 40, 6, 14).rotateZ(Math.PI / 2).translate((s.len + 30) / 2, 0, 0).rotateY(-a);
        const m = new THREE.Mesh(g, armMat);
        m.castShadow = true;
        arm.add(m);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(s.w + 6, 16, 12), mat('sweepTip', () => glossy({ color: 0xff3d7f })));
        tip.position.set(Math.cos(a) * s.len, 0, -Math.sin(a) * s.len);
        tip.castShadow = true;
        arm.add(tip);
      }
      group.add(arm);
      dyn.sweepers.push({ s, arm });
    }
    for (const h of C.hammers) {
      const pivot = new THREE.Group();
      pivot.position.set(h.x, H(h.x, h.y) + 300, -h.y);
      const len = 230;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, len, 10).translate(0, -len / 2, 0), M.metal);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(h.r, h.r, 84, 28).rotateX(Math.PI / 2).translate(0, -len, 0), mat('hammerHead', () => std({ map: tex.stripes('#ff4f8b', '#ffffff', 10, false), roughness: 0.45 })));
      const caps = new THREE.Mesh(mergeGeometries([42, -42].map((z) => new THREE.SphereGeometry(h.r, 20, 10).scale(1, 1, 0.3).translate(0, -len, z))), mat('hammerCap', () => glossy({ color: 0xffd84d })));
      pole.castShadow = head.castShadow = caps.castShadow = true;
      pivot.add(pole, head, caps);
      group.add(pivot);
      dyn.hammers.push({ h, pivot, len });
    }
    for (const fan of C.fans) {
      const blades = new THREE.Group();
      blades.position.set(fan.x + fan.dir * 6, H(0, fan.y) + 100, -fan.y);
      const bladeMat = mat('fanBlade', () => std({ color: 0xffffff, roughness: 0.35 }));
      for (let k = 0; k < 3; k++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(6, 62, 22).translate(0, 32, 0), bladeMat);
        b.rotation.x = (k * Math.PI * 2) / 3;
        blades.add(b);
      }
      const hub = new THREE.Mesh(new THREE.SphereGeometry(14, 12, 10), mat('fanHub', () => glossy({ color: 0xff4f8b })));
      blades.add(hub);
      group.add(blades);
      dyn.fans.push({ fan, blades, zone: C.zones[fan.zone], spin: 0 });
    }
    return dyn;
  });

  // Bumper instances per lane.
  const bumperState = laneXs.map(() => bumpers.map(() => 0));
  function updateBumpers(dt) {
    if (!bumperBase) return;
    let k = 0;
    laneXs.forEach((lx, li) => {
      bumpers.forEach((b, i) => {
        const st = bumperState[li];
        st[i] = Math.max(0, st[i] - dt * 4);
        const s = 1 + Math.sin(st[i] * Math.PI * 3) * st[i] * 0.18;
        const h = H(b.x, b.y);
        tmpM.compose(tmpP.set(lx + b.x, h, -b.y), tmpQ.identity(), tmpS.set(b.r * s, 34 / s, b.r * s));
        bumperBase.setMatrixAt(k, tmpM);
        tmpM.compose(tmpP.set(lx + b.x, h + 34 / s, -b.y), tmpQ.identity(), tmpS.set(b.r * 0.96 * s, b.r * 0.55 / s, b.r * 0.96 * s));
        bumperTop.setMatrixAt(k, tmpM);
        k++;
      });
    });
    bumperBase.instanceMatrix.needsUpdate = true;
    bumperTop.instanceMatrix.needsUpdate = true;
  }
  updateBumpers(0);

  // Per-frame animation of every lane's moving parts.
  function update(t, dt, laneStates, cam) {
    flapTime.value = t;
    if (M.belt.userData.speed) M.belt.map.offset.y = (-t * M.belt.userData.speed) % 1;
    lanes.forEach((dyn, li) => {
      const st = laneStates[li] || {};
      for (const s of dyn.sway) s.mesh.position.x = BC.floorOffset(s.f, t);
      dyn.gates.forEach((g, i) => {
        const open = st.gates & (1 << i) ? 1 : 0;
        g.userData.open += (open - g.userData.open) * Math.min(1, dt * 10);
        g.position.y = g.userData.base - g.userData.open * 82;
        g.visible = g.userData.open < 0.98;
      });
      dyn.plates.forEach((p, i) => {
        const on = st.plates & (1 << i) ? 1 : 0;
        p.on += (on - p.on) * Math.min(1, dt * 12);
        p.mesh.position.y = H(C.plates[i].x, C.plates[i].y) + 3 - p.on * 3;
        p.mesh.material.emissiveIntensity = 0.35 + p.on * 1.1 + Math.sin(t * 4) * 0.08;
        p.ring.material.opacity = 0.35 + p.on * 0.5 + Math.sin(t * 3 + i) * 0.1;
        p.ring.scale.setScalar(1 + p.on * 0.12);
      });
      for (const s of dyn.sweepers) s.arm.rotation.y = BC.armAngle(s.s, t, 0);
      // Arches between the camera and the ball fade so they never hide the action.
      for (const a of dyn.arches) {
        const target = cam && a.z < cam.z - 60 && a.z > cam.focusZ - 60 ? 0 : 1;
        a.fade += (target - a.fade) * Math.min(1, dt * 6);
        a.mats[0].opacity = 0.12 + a.fade * 0.88;
        a.mats[1].opacity = a.fade;
        a.mats[1].visible = a.fade > 0.02;
        for (const m of a.mats) m.depthWrite = a.fade > 0.95;
      }
      for (const h of dyn.hammers) {
        const p = BC.hammerPos(h.h, t);
        h.pivot.rotation.z = -Math.asin(Math.max(-0.95, Math.min(0.95, (p.x - h.h.x) / h.len)));
      }
      for (const f of dyn.fans) {
        const on = BC.windOn(f.zone, t);
        const warm = BC.windIn(f.zone, t);
        const target = on ? 28 : warm > 0 && warm < 0.9 ? 12 : 1.2;
        f.spin += (target - f.spin) * Math.min(1, dt * 3);
        f.blades.rotation.x += f.spin * dt * (f.fan.dir || 1);
      }
    });
    updateBumpers(dt);
  }

  function bump(li, x, y) {
    const i = bumpers.findIndex((b) => Math.hypot(b.x - x, b.y - y) < b.r + 10);
    if (i >= 0 && bumperState[li]) bumperState[li][i] = 1;
  }

  function dispose() {
    for (const dyn of lanes) {
      scene.remove(dyn.group);
      for (const a of dyn.arches) a.mats.forEach((m) => m.dispose());
    }
    if (pillarMesh) scene.remove(pillarMesh);
    if (bumperBase) scene.remove(bumperBase, bumperTop);
    const geos = new Set();
    for (const dyn of lanes) dyn.group.traverse((o) => { if (o.geometry) geos.add(o.geometry); });
    [pillarMesh, bumperBase, bumperTop].forEach((m) => m && geos.add(m.geometry));
    geos.forEach((g) => g.dispose());
  }

  return { lanes, H, update, bump, dispose, theme: T };
}

// ---------- sky, clouds and distant islands ----------
export function buildSky(scene, themeName) {
  const T = THEMES[themeName] || THEMES.candy;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(T.sky[0]) }, mid: { value: new THREE.Color(T.sky[1]) }, low: { value: new THREE.Color(T.sky[2]) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vP;
      void main(){ float h = normalize(vP - cameraPosition).y;
        vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.55, h)) : mix(mid, low, smoothstep(0.0, -0.4, h));
        gl_FragColor = vec4(c, 1.0); }`,
  }));
  scene.add(sky);
  return sky;
}

// A sea of clouds below the course plus puffs drifting around it.
export function buildClouds(scene, length, width, themeName) {
  const T = THEMES[themeName] || THEMES.candy;
  const group = new THREE.Group();
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshBasicMaterial({ map: tex.cloudSea(), color: T.sea, fog: true }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, -1100, -length / 2);
  group.add(sea);
  const r = rng(7);
  const sprites = [];
  const n = MOBILE ? 46 : 90;
  for (let i = 0; i < n; i++) {
    const below = i < n * 0.6;
    const mat = new THREE.SpriteMaterial({ map: kartTex.cloud(i % 6), transparent: true, opacity: below ? 0.95 : 0.8, depthWrite: false, fog: true });
    const s = new THREE.Sprite(mat);
    const w = below ? 900 + r() * 1400 : 500 + r() * 700;
    s.scale.set(w, w * 0.5, 1);
    const x = (r() - 0.5) * (width + 5000);
    const y = below ? -300 - r() * 700 : -120 + r() * 600;
    // Keep the drifting puffs off the lanes themselves.
    const xx = !below && Math.abs(x) < width / 2 + 500 ? Math.sign(x || 1) * (width / 2 + 500 + r() * 1200) : x;
    s.position.set(xx, y, -(r() * (length + 3000) - 1500));
    s.userData.speed = 6 + r() * 14;
    group.add(s);
    sprites.push(s);
  }
  // Distant candy islands with lollipop trees and balloons for depth.
  const islandMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  const topMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const isl = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 0.35, 1, 18).translate(0, -0.5, 0), islandMat, 18);
  const tops = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.04, 1, 0.12, 18), topMat, 18);
  const lolli = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial({ roughness: 0.35 }), 36);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let li = 0;
  for (let i = 0; i < 18; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (width / 2 + 1400 + r() * 3000);
    const z = -(r() * (length + 4000) - 2000);
    const y = -200 + r() * 500;
    const rad = 180 + r() * 360;
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(rad, rad * (1.1 + r()), rad));
    isl.setMatrixAt(i, m);
    isl.setColorAt(i, c.set(T.islands[i % T.islands.length]));
    m.compose(new THREE.Vector3(x, y + 6, z), q, new THREE.Vector3(rad, rad, rad));
    tops.setMatrixAt(i, m);
    tops.setColorAt(i, c.set(i % 3 ? '#9fe8a8' : '#fff4fa'));
    for (let k = 0; k < 2; k++) {
      const a = r() * Math.PI * 2;
      const lr = 40 + r() * 50;
      m.compose(new THREE.Vector3(x + Math.cos(a) * rad * 0.5, y + 70 + lr, z + Math.sin(a) * rad * 0.5), q, new THREE.Vector3(lr, lr, lr));
      lolli.setMatrixAt(li, m);
      lolli.setColorAt(li, c.set(['#ff7eb6', '#ffd84d', '#8b6cff', '#4cc3ff'][li % 4]));
      li++;
    }
  }
  group.add(isl, tops, lolli);
  scene.add(group);
  return {
    group,
    update(dt) {
      for (const s of sprites) {
        s.position.x += s.userData.speed * dt;
        if (s.position.x > width / 2 + 3000) s.position.x -= width + 6000;
      }
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    },
  };
}
