// Layered arenas in 3D (maps from shared/kart-layers.js). Every floor, wall, ramp and tower is built
// from the map data with the theme's kit of materials; textures tile in world space, so pieces of
// any size line up. On top of that: the moat, jump pads with their flight arcs, bumpers, boost
// chevrons, lava pools, the moving obstacles and some scenery. Roofs (anything you can drive under)
// fade out when they would hide your kart from the camera.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tex, canvasTexture, rng, MOBILE, boostPad, decorate, addHills } from './world.js';

const K = window.KartCore;
const L = K.Layers;
const TAU = Math.PI * 2;

// ---------- textures (tileable, cached) ----------
const cache = {};
const once = (key, fn) => cache[key] || (cache[key] = fn());

function speckle(c, w, h, n, colors, size, seed) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[Math.floor(r() * colors.length)];
    c.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()));
  }
}
// Draw `fn` at every wrap-around offset so shapes crossing an edge tile seamlessly.
function wrapped(c, w, h, x, y, size, fn) {
  for (const ox of [0, -w, w]) {
    for (const oy of [0, -h, h]) {
      if (x + ox + size < 0 || x + ox - size > w || y + oy + size < 0 || y + oy - size > h) continue;
      fn(x + ox, y + oy);
    }
  }
}
const shade = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;

const TEX = {
  grass: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#5c9a43'; c.fillRect(0, 0, w, h);
    const r = rng(3);
    for (let i = 0; i < 46; i++) {
      const x = r() * w; const y = r() * h; const rr = 18 + r() * 34;
      wrapped(c, w, h, x, y, rr, (px, py) => {
        const g = c.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, r() < 0.5 ? 'rgba(130,190,80,0.35)' : 'rgba(40,80,30,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      });
    }
    speckle(c, w, h, 5000, ['#4f8c3a', '#6aab4e', '#548f3c', '#78b858', '#4a8236'], 2, 4);
    c.lineWidth = 1;
    for (let i = 0; i < 900; i++) {
      const x = r() * w; const y = r() * h;
      c.strokeStyle = r() < 0.5 ? 'rgba(30,70,25,0.45)' : 'rgba(150,205,100,0.4)';
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 4); c.stroke();
    }
  }),
  dirt: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#6e5038'; c.fillRect(0, 0, w, h);
    const r = rng(8);
    for (let y = 0; y < h; y += 6 + Math.floor(r() * 10)) { c.fillStyle = `rgba(${40 + r() * 40},${28 + r() * 20},${18 + r() * 10},0.35)`; c.fillRect(0, y, w, 4 + r() * 8); }
    speckle(c, w, h, 2400, ['#5c4230', '#85644a', '#4b3526', '#94765a'], 3, 9);
    for (let i = 0; i < 70; i++) {
      const x = r() * w; const y = r() * h; const s = 3 + r() * 6;
      c.fillStyle = shade('#8c8278', 0.7 + r() * 0.5);
      c.beginPath(); c.ellipse(x, y, s, s * 0.7, r() * 3, 0, TAU); c.fill();
    }
  }),
  // Cobbles: rounded stones on a jittered grid, lit from the top left, mortar between.
  cobble: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#5f5a52'; c.fillRect(0, 0, w, h);
    const r = rng(11);
    const n = 9;
    const cell = w / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5 + (j % 2) * 0.5) * cell + (r() - 0.5) * cell * 0.25;
        const y = (j + 0.5) * cell + (r() - 0.5) * cell * 0.25;
        const rx = cell * (0.4 + r() * 0.08);
        const ry = cell * (0.36 + r() * 0.08);
        const base = new THREE.Color().setHSL(0.08 + r() * 0.04, 0.08 + r() * 0.06, 0.48 + r() * 0.14);
        const rot = (r() - 0.5) * 0.6;
        wrapped(c, w, h, x, y, rx, (px, py) => {
          const g = c.createRadialGradient(px - rx * 0.35, py - ry * 0.4, rx * 0.1, px, py, rx * 1.05);
          g.addColorStop(0, `#${base.clone().multiplyScalar(1.25).getHexString()}`);
          g.addColorStop(0.7, `#${base.getHexString()}`);
          g.addColorStop(1, `#${base.clone().multiplyScalar(0.62).getHexString()}`);
          c.fillStyle = g;
          c.beginPath(); c.ellipse(px, py, rx, ry, rot, 0, TAU); c.fill();
        });
      }
    }
    speckle(c, w, h, 1500, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.08)'], 2, 12);
  }),
  // Ashlar: courses of squared stone blocks, staggered joints, each block a slightly different tone.
  ashlar: (base = '#a99d8a', mortar = '#6d6457', course = 32) => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = mortar; c.fillRect(0, 0, w, h);
    const r = rng(base.length * 13 + course);
    for (let y = 0, row = 0; y < h; y += course, row++) {
      const len = 64;
      for (let x = row % 2 ? -len / 2 : 0; x < w; x += len) {
        const tone = 0.86 + r() * 0.26;
        c.fillStyle = shade(base, tone);
        c.fillRect(x + 2, y + 2, len - 4, course - 4);
        c.fillStyle = `rgba(255,255,255,${0.06 + r() * 0.06})`; c.fillRect(x + 2, y + 2, len - 4, 3);
        c.fillStyle = `rgba(0,0,0,${0.12 + r() * 0.08})`; c.fillRect(x + 2, y + course - 5, len - 4, 3);
        if (x < 0) { c.fillStyle = shade(base, tone); c.fillRect(x + w + 2, y + 2, len - 4, course - 4); }
      }
    }
    speckle(c, w, h, 2600, ['rgba(0,0,0,0.13)', 'rgba(255,255,255,0.08)', shade(base, 0.8)], 2, 14);
  }),
  // Flagstones: big irregular slabs (a square split again and again), dark seams.
  flag: (base = '#9d9789') => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#4e4a43'; c.fillRect(0, 0, w, h);
    const r = rng(21 + base.length);
    const slabs = [[0, 0, w, h]];
    for (let k = 0; k < 40; k++) {
      slabs.sort((a, b) => b[2] * b[3] - a[2] * a[3]);
      const [x, y, sw, sh] = slabs.shift();
      if (sw * sh < 1400) { slabs.push([x, y, sw, sh]); break; }
      const f = 0.35 + r() * 0.3;
      if (sw > sh) slabs.push([x, y, sw * f, sh], [x + sw * f, y, sw * (1 - f), sh]);
      else slabs.push([x, y, sw, sh * f], [x, y + sh * f, sw, sh * (1 - f)]);
    }
    for (const [x, y, sw, sh] of slabs) {
      c.fillStyle = shade(base, 0.85 + r() * 0.25);
      c.fillRect(x + 1.5, y + 1.5, sw - 3, sh - 3);
      c.fillStyle = 'rgba(255,255,255,0.07)'; c.fillRect(x + 1.5, y + 1.5, sw - 3, 2);
    }
    speckle(c, w, h, 3000, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.07)'], 2, 22);
  }),
  // Planks running along v, with gaps and nail heads.
  planks: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#2c1d12'; c.fillRect(0, 0, w, h);
    const r = rng(31);
    const pw = 32;
    for (let x = 0; x < w; x += pw) {
      const base = new THREE.Color().setHSL(0.07 + r() * 0.02, 0.45, 0.32 + r() * 0.08);
      c.fillStyle = `#${base.getHexString()}`;
      c.fillRect(x + 1.5, 0, pw - 3, h);
      c.strokeStyle = `#${base.clone().multiplyScalar(0.75).getHexString()}`;
      c.lineWidth = 1;
      for (let k = 0; k < 7; k++) {
        const gx = x + 4 + r() * (pw - 8);
        c.beginPath(); c.moveTo(gx, 0);
        for (let y = 0; y <= h; y += 16) c.lineTo(gx + Math.sin(y * 0.05 + k) * 1.5, y);
        c.stroke();
      }
      const cut = r() * h;
      c.fillStyle = '#2c1d12'; c.fillRect(x, cut, pw, 2);
      c.fillStyle = '#1b130c';
      for (const yy of [cut + 8, cut - 8]) { c.beginPath(); c.arc(x + 8, (yy + h) % h, 1.8, 0, TAU); c.arc(x + pw - 8, (yy + h) % h, 1.8, 0, TAU); c.fill(); }
    }
  }),
  timber: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#3a2718'; c.fillRect(0, 0, w, h);
    const r = rng(41);
    for (let y = 0; y < h; y += 32) {
      c.fillStyle = shade('#5a3b22', 0.85 + r() * 0.3);
      c.fillRect(0, y + 2, w, 28);
      c.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let k = 0; k < 4; k++) { const yy = y + 6 + r() * 20; c.beginPath(); c.moveTo(0, yy); c.lineTo(w, yy + (r() - 0.5) * 4); c.stroke(); }
    }
  }),
  tent: () => canvasTexture(128, 128, (c, w, h) => {
    for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#f1e6c8' : '#b8322f'; c.fillRect((i * w) / 8, 0, w / 8 + 1, h); }
    speckle(c, w, h, 600, ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.1)'], 2, 51);
  }),
  // Stone steps rising along v: a lit tread and a dark riser shadow per step.
  steps: () => canvasTexture(128, 128, (c, w, h) => {
    const r = rng(61);
    for (let y = 0; y < h; y += 32) {
      c.fillStyle = shade('#a39883', 0.9 + r() * 0.15); c.fillRect(0, y, w, 32);
      c.fillStyle = 'rgba(255,255,255,0.16)'; c.fillRect(0, y + 26, w, 4);
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, y, w, 4);
    }
    speckle(c, w, h, 900, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.08)'], 2, 62);
  }),
  crate: () => tex.crate(),
  // A jump pad: glowing rings and an arrow (pointing along +u).
  pad: () => canvasTexture(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(120,230,255,0.9)'); g.addColorStop(0.55, 'rgba(60,160,255,0.55)'); g.addColorStop(1, 'rgba(40,90,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(230,250,255,0.95)'; c.lineWidth = 6;
    for (const rr of [118, 84]) { c.beginPath(); c.arc(w / 2, h / 2, rr, 0, TAU); c.stroke(); }
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(w / 2 + 70, h / 2); c.lineTo(w / 2 - 20, h / 2 - 55); c.lineTo(w / 2 - 20, h / 2 - 22); c.lineTo(w / 2 - 66, h / 2 - 22);
    c.lineTo(w / 2 - 66, h / 2 + 22); c.lineTo(w / 2 - 20, h / 2 + 22); c.lineTo(w / 2 - 20, h / 2 + 55); c.closePath(); c.fill();
  }, false),
  bumper: () => canvasTexture(128, 64, (c, w, h) => {
    for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#fdf2f8' : '#e11d48'; c.fillRect((i * w) / 8, 0, w / 8 + 1, h); }
  }),
};
const texture = (name, ...args) => once(`${name}${args.join(',')}`, () => TEX[name](...args));

// ---------- kits: what each kind of solid looks like, per theme ----------
// [texture, args, world units per tile]; tile 0 = one texture per face (crates).
const KITS = {
  keep: {
    grass: { top: ['grass', [], 300], side: ['dirt', [], 200] },
    courtyard: { top: ['cobble', [], 170], side: ['ashlar', ['#8f8676', '#575047'], 150] },
    wall: { top: ['flag', ['#a39d8e'], 200], side: ['ashlar', [], 150] },
    gate: { top: ['flag', ['#a39d8e'], 200], side: ['ashlar', [], 150], bottom: ['ashlar', ['#b8ad99', '#7a7163'], 150] },
    merlon: { top: ['ashlar', [], 150], side: ['ashlar', [], 150] },
    bridge: { top: ['planks', [], 110, 'across'], side: ['timber', [], 110], bottom: ['planks', [], 110] },
    keep: { top: ['ashlar', ['#c2b8a3', '#7b7262'], 150], side: ['ashlar', ['#c2b8a3', '#7b7262'], 150] },
    roof: { top: ['flag', ['#7d8088'], 200], side: ['ashlar', ['#c2b8a3', '#7b7262'], 150], bottom: ['planks', [], 110] },
    tent: { top: ['tent', [], 90], side: ['tent', [], 90] },
    crate: { top: ['crate', [], 0], side: ['crate', [], 0] },
    stair: { top: ['steps', [], 22, 'steps'], side: ['ashlar', [], 150] },
    tower: { top: ['flag', ['#a39d8e'], 200], side: ['ashlar', ['#a59a86', '#685f52', 26], 150] },
    pillar: { top: ['ashlar', ['#c2b8a3', '#7b7262'], 150], side: ['ashlar', ['#c2b8a3', '#7b7262'], 150] },
    stone: { top: ['flag', [], 200], side: ['ashlar', [], 150] },
    ground: { top: ['grass', [], 300], side: ['dirt', [], 200] },
  },
};
const ROUGH = { planks: 0.85, timber: 0.9, tent: 0.95, grass: 1, dirt: 1 };

// Shared materials, one per texture setup (roofs get their own copies so each can fade alone).
const matCache = {};
function material([name, args]) {
  const key = `${name}${args.join(',')}`;
  return matCache[key] || (matCache[key] = new THREE.MeshStandardMaterial({ map: texture(name, ...args), roughness: ROUGH[name] ?? 0.92 }));
}

// ---------- geometry with world-space UVs ----------
// Faces go into per-material buckets; every bucket becomes one merged mesh.
class Buckets {
  constructor() { this.map = new Map(); }
  get(spec) {
    const key = `${spec[0]}${spec[1].join(',')}`;
    let b = this.map.get(key);
    if (!b) { b = { spec, pos: [], nor: [], uv: [] }; this.map.set(key, b); }
    return b;
  }
  // A quad (three-space corners, any winding) facing `n`, with uvs.
  quad(spec, p, n, uv) {
    const b = this.get(spec);
    const ax = p[1][0] - p[0][0]; const ay = p[1][1] - p[0][1]; const az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0]; const by = p[2][1] - p[0][1]; const bz = p[2][2] - p[0][2];
    const flip = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2] < 0;
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const i of order) { b.pos.push(...p[i]); b.nor.push(...n); b.uv.push(...uv[i]); }
  }
  meshes(opts = {}) {
    const out = [];
    for (const b of this.map.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      const mat = opts.own ? material(b.spec).clone() : material(b.spec);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = opts.cast !== false;
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    return out;
  }
}

// Texture coordinates for a point on a face: world position / tile size.
function uvOf(spec, kind, a, b) {
  const T = spec[2];
  return T ? [a / T, b / T] : [a, b];
}

// A box solid (physics x0..x1, y0..y1, z0..z1) into the buckets. Physics (x, y, z) is three (x, z, y).
function addBox(B, s, kit, opts = {}) {
  const k = kit[s.kind] || kit.stone;
  const { x0, x1, y0, y1, z0, z1 } = s;
  const top = k.top;
  const side = k.side;
  const bottom = k.bottom || side;
  const local = !top[2]; // one texture per face
  const across = top[3] === 'across' && y1 - y0 > x1 - x0;
  const tuv = (x, y) => (local ? [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)] : across ? uvOf(top, 0, y, x) : uvOf(top, 0, x, y));
  B.quad(top, [[x0, z1, y0], [x1, z1, y0], [x1, z1, y1], [x0, z1, y1]], [0, 1, 0], [tuv(x0, y0), tuv(x1, y0), tuv(x1, y1), tuv(x0, y1)]);
  if (opts.bottom || z0 > 1) {
    const buv = (x, y) => (local ? [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)] : uvOf(bottom, 0, x, y));
    B.quad(bottom, [[x0, z0, y0], [x1, z0, y0], [x1, z0, y1], [x0, z0, y1]], [0, -1, 0], [buv(x0, y0), buv(x1, y0), buv(x1, y1), buv(x0, y1)]);
  }
  const suv = (u, z, u0, u1) => (local ? [(u - u0) / (u1 - u0), (z - z0) / (z1 - z0)] : uvOf(side, 0, u, z));
  // -y, +y faces (three -z, +z)
  for (const [y, n] of [[y0, -1], [y1, 1]]) {
    B.quad(side, [[x0, z0, y], [x1, z0, y], [x1, z1, y], [x0, z1, y]], [0, 0, n], [suv(x0, z0, x0, x1), suv(x1, z0, x0, x1), suv(x1, z1, x0, x1), suv(x0, z1, x0, x1)]);
  }
  for (const [x, n] of [[x0, -1], [x1, 1]]) {
    B.quad(side, [[x, z0, y0], [x, z0, y1], [x, z1, y1], [x, z1, y0]], [n, 0, 0], [suv(y0, z0, y0, y1), suv(y1, z0, y0, y1), suv(y1, z1, y0, y1), suv(y0, z1, y0, y1)]);
  }
}

// A ramp: a sloped top from zl (low edge) to zh (high edge), solid down to its base.
function addRamp(B, s, kit) {
  const k = kit[s.kind] || kit.stone;
  const { x0, x1, y0, y1, z0, axis, sign } = s;
  const top = (x, y) => {
    const p = axis ? y : x;
    const lo = axis ? y0 : x0;
    const hi = axis ? y1 : x1;
    let u = (p - lo) / (hi - lo);
    if (sign < 0) u = 1 - u;
    return s.zl + (s.zh - s.zl) * u;
  };
  const len = axis ? y1 - y0 : x1 - x0;
  const rise = s.zh - s.zl;
  const slopeLen = Math.hypot(len, rise);
  // Top: u across, v up the slope (so step textures run across it).
  const along = (x, y) => {
    const p = axis ? y : x;
    const d = sign > 0 ? p - (axis ? y0 : x0) : (axis ? y1 : x1) - p;
    return (d / len) * slopeLen;
  };
  const acrossOf = (x, y) => (axis ? x : y);
  const T = k.top[2];
  const tuv = (x, y) => [acrossOf(x, y) / 64, along(x, y) / T];
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // Normal of the slope.
  const g = rise / len;
  const nx = axis ? 0 : -sign * g;
  const nz = axis ? -sign * g : 0;
  const nl = Math.hypot(nx, 1, nz);
  B.quad(k.top, corners.map(([x, y]) => [x, top(x, y), y]), [nx / nl, 1 / nl, nz / nl], corners.map(([x, y]) => tuv(x, y)));
  const side = k.side;
  const suv = (u, z) => uvOf(side, 0, u, z);
  // Four sides: each from the base up to the top line along it.
  const edges = [
    [[x0, y0], [x1, y0], [0, 0, -1], (x) => x], [[x1, y1], [x0, y1], [0, 0, 1], (x) => x],
    [[x0, y1], [x0, y0], [-1, 0, 0], (_, y) => y], [[x1, y0], [x1, y1], [1, 0, 0], (_, y) => y],
  ];
  for (const [a, b, n, u] of edges) {
    const ta = top(a[0], a[1]);
    const tb = top(b[0], b[1]);
    if (Math.max(ta, tb) - z0 < 0.5) continue;
    const ua = u(a[0], a[1]);
    const ub = u(b[0], b[1]);
    B.quad(side, [[a[0], z0, a[1]], [b[0], z0, b[1]], [b[0], tb, b[1]], [a[0], ta, a[1]]], n, [suv(ua, z0), suv(ub, z0), suv(ub, tb), suv(ua, ta)]);
  }
}

// A cylinder: open sides plus a top disc (and a bottom one when it floats).
function cylinderGeometries(s, kit) {
  const k = kit[s.kind] || kit.stone;
  const h = s.z1 - s.z0;
  const seg = Math.max(16, Math.min(48, Math.round(s.r / 5)));
  const sideGeo = new THREE.CylinderGeometry(s.r, s.r, h, seg, 1, true);
  const uv = sideGeo.attributes.uv;
  const ts = k.side[2] || 100;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * TAU * s.r) / ts, (uv.getY(i) * h + s.z0) / ts);
  sideGeo.translate(s.x, (s.z0 + s.z1) / 2, s.y);
  const topGeo = new THREE.CircleGeometry(s.r, seg).rotateX(-Math.PI / 2);
  const tu = topGeo.attributes.uv;
  const tt = k.top[2] || 100;
  for (let i = 0; i < tu.count; i++) tu.setXY(i, ((tu.getX(i) - 0.5) * 2 * s.r + s.x) / tt, ((tu.getY(i) - 0.5) * 2 * s.r - s.y) / tt);
  topGeo.translate(s.x, s.z1, s.y);
  return [[k.side, sideGeo], [k.top, topGeo]];
}

// ---------- the builder ----------
export function buildLayered(scene, map, theme, ctx) {
  const kit = KITS[map.theme] || KITS.keep;
  const S = map.size;
  const groundZ = map.ground ? map.ground.z || 0 : 0;
  const statics = new Buckets();
  const cylGeos = new Map(); // material key -> [spec, geometries]
  const roofs = [];
  for (const s of map.solids) {
    if (s.kind === 'bumper' || s.kind === 'hub') continue; // drawn with their bumper / sweeper
    const footprint = s.type === 2 ? Math.PI * s.r * s.r : (s.x1 - s.x0) * (s.y1 - s.y0);
    // Anything big enough to drive under fades when it would hide your kart.
    const roof = s.z0 > 20 && footprint > 5000;
    if (s.type === 2) {
      for (const [spec, geo] of cylinderGeometries(s, kit)) {
        const key = `${spec[0]}${spec[1].join(',')}`;
        if (!cylGeos.has(key)) cylGeos.set(key, [spec, []]);
        cylGeos.get(key)[1].push(geo);
      }
    } else if (roof) {
      const B = new Buckets();
      addBox(B, s, kit, { bottom: true });
      const group = new THREE.Group();
      const meshes = B.meshes({ own: true });
      group.add(...meshes);
      scene.add(group);
      roofs.push({ s, group, mats: meshes.map((m) => m.material), fade: 1 });
    } else if (s.type === 1) {
      addRamp(statics, s, kit);
    } else {
      addBox(statics, s, kit);
    }
  }
  for (const m of statics.meshes()) scene.add(m);
  for (const [, [spec, geos]] of cylGeos) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), material(spec));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // The world outside the arena: the same ground, with a square hole where the arena is.
  const outerKit = kit.grass || kit.ground;
  {
    const far = 9000;
    // Drawn in (x, -y) and laid flat facing up: the shape's y becomes the world's z.
    const P = (x, y) => new THREE.Vector2(x, -y);
    const shape = new THREE.Shape([P(-far, -far), P(S + far, -far), P(S + far, S + far), P(-far, S + far)]);
    shape.holes.push(new THREE.Path([P(0, 0), P(0, S), P(S, S), P(S, 0)]));
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv;
    const T = outerKit.top[2];
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / T, uv.getY(i) / T);
    const outside = new THREE.Mesh(geo, material(outerKit.top));
    outside.position.y = groundZ - 0.3;
    outside.receiveShadow = true;
    scene.add(outside);
  }

  // Edge walls: a palisade of sharpened logs where the physics wall stands.
  if (map.edge === 'wall') addPalisade(scene, S);

  // Moat / lava lake: one sheet at the liquid's level (only seen through the holes in the floor).
  if (map.liquid) {
    if (map.liquid.kind === 'lava') {
      const lt = tex.lava().clone();
      lt.needsUpdate = true;
      lt.repeat.set(S / 240, S / 240);
      const lava = new THREE.Mesh(new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 1.3, roughness: 0.4 }));
      lava.position.set(S / 2, map.liquid.z, S / 2);
      scene.add(lava);
      ctx.lava.push(lt);
    } else {
      const normal = tex.waterNormal().clone();
      normal.needsUpdate = true;
      normal.repeat.set(S / 200, S / 200);
      const water = new THREE.Mesh(new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
        color: theme.water || 0x2f6f73, roughness: 0.08, metalness: 0.2, normalMap: normal, normalScale: new THREE.Vector2(0.5, 0.5),
      }));
      water.position.set(S / 2, map.liquid.z, S / 2);
      water.receiveShadow = true;
      scene.add(water);
      ctx.water.push(normal);
    }
  }

  // Lava (or water) pools on a floor.
  for (const h of map.hazards) {
    const lt = tex.lava().clone();
    lt.needsUpdate = true;
    const round = h.r !== undefined;
    const w = round ? h.r * 2 : h.x1 - h.x0;
    const d = round ? h.r * 2 : h.y1 - h.y0;
    lt.repeat.set(w / 240, d / 240);
    const geo = round ? new THREE.CircleGeometry(h.r, 40) : new THREE.PlaneGeometry(w, d);
    const pool = new THREE.Mesh(geo.rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 1.3, roughness: 0.4 }));
    pool.position.set(round ? h.x : (h.x0 + h.x1) / 2, h.z + 0.6, round ? h.y : (h.y0 + h.y1) / 2);
    scene.add(pool);
    ctx.lava.push(lt);
  }

  for (const p of map.boostPads) ctx.pads.push(boostPad(scene, p));
  const pads = map.pads.map((p) => buildPad(scene, p));
  const bumpers = map.bumpers.map((b) => buildBumper(scene, b));
  const movers = map.movers.map((m) => buildMover(scene, map, m, kit));
  addScenery(scene, map, theme, ctx, kit);

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  return {
    roofs,
    // t: the game clock (where the movers are); focus: {x, y, z} of the kart the camera follows.
    update(t, dt, focus, camera) {
      for (const m of movers) m.update(t);
      for (const p of pads) p.update(t, dt);
      for (const b of bumpers) b.update(dt);
      // Roofs over the kart, or between it and the camera, fade to a ghost.
      if (focus) {
        v0.copy(camera.position);
        v1.set(focus.x, focus.z + 16, focus.y);
      }
      for (const r of roofs) {
        const s = r.s;
        let hide = false;
        if (focus) {
          const under = focus.x > s.x0 - 40 && focus.x < s.x1 + 40 && focus.y > s.y0 - 40 && focus.y < s.y1 + 40 && focus.z + L.KART_H <= s.z0 + 6;
          hide = under || segmentHitsBox(v0, v1, s);
        }
        const want = hide ? 0.18 : 1;
        if (Math.abs(r.fade - want) < 0.005) continue;
        r.fade += (want - r.fade) * Math.min(1, dt * 9);
        if (Math.abs(r.fade - want) < 0.01) r.fade = want;
        for (const m of r.mats) {
          m.opacity = r.fade;
          const see = r.fade < 0.999;
          // Opaque materials compile with alpha forced to 1: flipping `transparent` needs a recompile.
          if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true; }
          m.depthWrite = !see;
        }
        r.group.traverse((o) => { if (o.isMesh) o.castShadow = r.fade >= 0.999; });
      }
    },
    padFx(i) { pads[i]?.flash(); },
    bumperHit(i) { bumpers[i]?.hit(); },
    // Seconds until drawbridge i next rises, and whether it is up (for the HUD and sounds).
    bridges(t) { return movers.filter((m) => m.bridge).map((m) => m.state(t)); },
  };
}

// Does the segment a-b (three-space) pass through the solid's box?
function segmentHitsBox(a, b, s) {
  let t0 = 0;
  let t1 = 1;
  const lo = [s.x0, s.z0, s.y0];
  const hi = [s.x1, s.z1, s.y1];
  const p = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
      continue;
    }
    let ta = (lo[i] - p[i]) / d[i];
    let tb = (hi[i] - p[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// ---------- pads, bumpers ----------
function buildPad(scene, p) {
  const g = new THREE.Group();
  const discMat = new THREE.MeshBasicMaterial({ map: texture('pad'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r * 1.15, 40).rotateX(-Math.PI / 2), discMat);
  disc.rotation.y = -Math.atan2(p.ty - p.y, p.tx - p.x);
  disc.renderOrder = 2;
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, emissive: 0x38bdf8, emissiveIntensity: 1.2, roughness: 0.4, metalness: 0.5 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r * 1.15, 4, 8, 40).rotateX(Math.PI / 2), rimMat);
  rim.position.y = 1.5;
  g.add(disc, rim);
  g.position.set(p.x, p.z + 1.2, p.y);
  scene.add(g);
  // The flight arc: dots marching from the pad to where it lands.
  const N = 22;
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(3.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }), N);
  dots.frustumCulled = false;
  scene.add(dots);
  const G = K.PHYS.gravity;
  const vz = (p.tz - p.z) / p.t + 0.5 * G * p.t;
  const m4 = new THREE.Matrix4();
  let flash = 0;
  return {
    flash() { flash = 1; },
    update(t, dt) {
      flash = Math.max(0, flash - dt * 2.5);
      rimMat.emissiveIntensity = 1 + 0.4 * Math.sin(t * 5) + flash * 3;
      disc.material.opacity = 0.75 + 0.25 * Math.sin(t * 5) + flash;
      g.scale.setScalar(1 + flash * 0.25);
      for (let i = 0; i < N; i++) {
        const u = (i + ((t * 0.8) % 1)) / N;
        const tt = u * p.t;
        m4.makeTranslation(p.x + (p.tx - p.x) * u, p.z + 16 + vz * tt - 0.5 * G * tt * tt, p.y + (p.ty - p.y) * u);
        dots.setMatrixAt(i, m4);
      }
      dots.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildBumper(scene, b) {
  const g = new THREE.Group();
  const bandTex = texture('bumper').clone();
  bandTex.needsUpdate = true;
  bandTex.repeat.set(Math.round((TAU * b.r) / 40), 1);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r * 1.12, b.h, 32), new THREE.MeshStandardMaterial({ map: bandTex, roughness: 0.4, metalness: 0.1 }));
  body.position.y = b.h / 2;
  const capMat = new THREE.MeshStandardMaterial({ color: 0xfde68a, emissive: 0xfbbf24, emissiveIntensity: 0.8, roughness: 0.3 });
  const cap = new THREE.Mesh(new THREE.SphereGeometry(b.r * 0.92, 24, 12, 0, TAU, 0, Math.PI / 2), capMat);
  cap.position.y = b.h;
  cap.scale.y = 0.45;
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff4fa3, emissiveIntensity: 1.2 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(b.r + 2, 3.2, 8, 36).rotateX(Math.PI / 2), ringMat);
  ring.position.y = b.h * 0.72;
  for (const m of [body, cap, ring]) { m.castShadow = true; g.add(m); }
  g.position.set(b.x, b.z, b.y);
  scene.add(g);
  let flash = 0;
  return {
    hit() { flash = 1; },
    update(dt) {
      flash = Math.max(0, flash - dt * 3);
      const s = 1 + Math.sin(flash * Math.PI) * 0.18;
      g.scale.set(s, 1 + flash * 0.1, s);
      capMat.emissiveIntensity = 0.8 + flash * 3;
      ringMat.emissiveIntensity = 1.2 + flash * 4;
    },
  };
}

// ---------- moving obstacles ----------
function buildMover(scene, map, m, kit) {
  if (m.type === 'drawbridge') return buildDrawbridge(scene, map, m, kit);
  if (m.type === 'sweeper') return buildSweeper(scene, m);
  if (m.type === 'slider') {
    const B = new Buckets();
    addBox(B, { ...m, kind: m.kind || 'stone' }, kit, { bottom: true });
    const g = new THREE.Group();
    g.add(...B.meshes());
    scene.add(g);
    return { update(t) { const { u } = map.sliderAt(m, t); g.position.set(m.dx * u, 0, m.dy * u); } };
  }
  if (m.type === 'pendulum') {
    const g = new THREE.Group();
    const iron = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.5, metalness: 0.8 });
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(m.r, 1), iron);
    for (let i = 0; i < 12; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(m.r * 0.18, m.r * 0.5, 6), iron);
      const a = (i / 12) * TAU;
      const e = ((i % 3) - 1) * 0.8;
      const dir = new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
      spike.position.copy(dir).multiplyScalar(m.r * 1.05);
      spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      ball.add(spike);
    }
    ball.castShadow = true;
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 1, 6), iron);
    g.add(ball, chain);
    scene.add(g);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    return {
      update(t) {
        const b = map.pendulumAt(m, t);
        ball.position.set(b.x, b.z, b.y);
        ball.rotation.y = t * 2;
        dir.set(m.x - b.x, m.z - b.z, m.y - b.y);
        const len = dir.length();
        chain.position.set((m.x + b.x) / 2, (m.z + b.z) / 2, (m.y + b.y) / 2);
        chain.scale.set(1, len, 1);
        chain.quaternion.setFromUnitVectors(up, dir.normalize());
      },
    };
  }
  return { update() {} };
}

// A quintain: a post with arms turning on top, a shield on one arm and a sandbag on the other.
function buildSweeper(scene, m) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ map: texture('timber'), roughness: 0.9 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(m.hub * 0.8, m.hub, m.hi + 34, 16), wood);
  post.position.y = (m.hi + 34) / 2;
  post.castShadow = true;
  const spin = new THREE.Group();
  const h = m.hi - m.lo;
  for (let i = 0; i < m.arms; i++) {
    const arm = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.BoxGeometry(m.len - m.hub + 6, h * 0.6, m.w * 1.4), wood);
    beam.position.set((m.len + m.hub) / 2, 0, 0);
    beam.castShadow = true;
    arm.add(beam);
    if (i % 2 === 0) {
      // A painted shield at the tip.
      const shield = new THREE.Mesh(new THREE.CylinderGeometry(h * 1.15, h * 1.15, 5, 20), new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.6, metalness: 0.2 }));
      shield.rotation.x = Math.PI / 2;
      shield.position.set(m.len - 8, 0, 0);
      const boss = new THREE.Mesh(new THREE.SphereGeometry(h * 0.35, 12, 8), new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.35, metalness: 0.7 }));
      boss.position.set(m.len - 8, 0, 4);
      shield.castShadow = true;
      arm.add(shield, boss);
    } else {
      const bag = new THREE.Mesh(new THREE.SphereGeometry(m.w * 1.9, 12, 10), new THREE.MeshStandardMaterial({ color: 0xc2a36b, roughness: 1 }));
      bag.scale.set(1, 1.3, 1);
      bag.position.set(m.len - 10, -4, 0);
      bag.castShadow = true;
      arm.add(bag);
    }
    arm.rotation.y = -(i * TAU) / m.arms;
    spin.add(arm);
  }
  spin.position.y = (m.lo + m.hi) / 2;
  g.add(post, spin);
  g.position.set(m.x, m.z, m.y);
  scene.add(g);
  return { update(t) { spin.rotation.y = -(m.phase + m.speed * t); } };
}

// A drawbridge: planked deck on a pivot at its hinge, chains up to the gatehouse, and warning lamps
// that flash for the last few seconds before it rises and while it is up.
function buildDrawbridge(scene, map, m, kit) {
  const [axis, sign, h, len] = map.bridgeFrame(m);
  const w = axis ? m.x1 - m.x0 : m.y1 - m.y0;
  const outer = new THREE.Group();
  // Local frame: the deck reaches out along -z from the hinge (at the origin); +x across it.
  const hingeX = axis ? (m.x0 + m.x1) / 2 : h;
  const hingeY = axis ? h : (m.y0 + m.y1) / 2;
  outer.position.set(hingeX, m.z, hingeY);
  // Which way the deck reaches out from the hinge (sign: away from the hinge along the axis).
  outer.rotation.y = axis ? (sign > 0 ? Math.PI : 0) : (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
  const pivot = new THREE.Group();
  outer.add(pivot);
  const B = new Buckets();
  addBox(B, { x0: -w / 2, x1: w / 2, y0: -len, y1: 0, z0: -m.thick, z1: 0, kind: 'bridge', type: 0 }, kit, { bottom: true });
  for (const mesh of B.meshes()) pivot.add(mesh);
  // Iron bands across the deck.
  const iron = new THREE.MeshStandardMaterial({ color: 0x2f3237, roughness: 0.5, metalness: 0.8 });
  for (const f of [0.15, 0.5, 0.85]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, 8), iron);
    band.position.set(0, 0.7, -len * f);
    pivot.add(band);
  }
  scene.add(outer);
  const chains = [-1, 1].map(() => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 1, 6), iron);
    scene.add(c);
    return c;
  });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x3b0a0a, emissive: 0xff2a1a, emissiveIntensity: 0 });
  const lamps = [-1, 1].map((sd) => {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), lampMat);
    lamp.position.set(sd * (w / 2 + 14), 120 - m.z, 10);
    outer.add(lamp);
    return lamp;
  });
  const up = new THREE.Vector3(0, 1, 0);
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const state = (t) => { const st = map.bridgeAt(m, t); return { rise: st.rise, up: !st.down, a: st.a }; };
  return {
    bridge: true,
    state,
    update(t) {
      const st = map.bridgeAt(m, t);
      pivot.rotation.x = st.a;
      const warn = st.a > 0 || st.rise < 3;
      lampMat.emissiveIntensity = warn ? (Math.floor(t * 4) % 2 ? 2.5 : 0.3) : 0;
      chains.forEach((c, i) => {
        const sd = i ? 1 : -1;
        // From the far end of the deck to the top of the gate, in world space.
        a3.set(sd * w * 0.4, 0, -len);
        pivot.localToWorld(a3);
        b3.set(sd * w * 0.4, 110 - m.z, 4);
        outer.localToWorld(b3);
        const d = b3.clone().sub(a3);
        const l = d.length();
        c.position.copy(a3).addScaledVector(d, 0.5);
        c.scale.set(1, l, 1);
        c.quaternion.setFromUnitVectors(up, d.normalize());
      });
      void lamps;
    },
  };
}

// ---------- scenery ----------
function addPalisade(scene, S) {
  const step = 14;
  const per = Math.ceil(S / step);
  const count = per * 4;
  const geo = mergeGeometries([
    new THREE.CylinderGeometry(7, 8, 72, 7).translate(0, 36, 0),
    new THREE.ConeGeometry(7, 16, 7).translate(0, 80, 0),
  ]);
  const logs = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 0.95 }), count);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const r = rng(91);
  let n = 0;
  for (let i = 0; i < per; i++) {
    const a = i * step + step / 2;
    for (const [x, z] of [[a, 20], [a, S - 20], [20, a], [S - 20, a]]) {
      const hgt = 0.85 + r() * 0.3;
      q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.06, r() * TAU, (r() - 0.5) * 0.06));
      m4.compose(new THREE.Vector3(x, 0, z), q, sc.set(1, hgt, 1));
      logs.setMatrixAt(n++, m4);
    }
  }
  logs.count = n;
  logs.castShadow = true;
  logs.receiveShadow = true;
  scene.add(logs);
}

function addScenery(scene, map, theme, ctx, kit) {
  const S = map.size;
  const r = rng(7);
  for (const d of map.deco || []) {
    if (d.kind === 'crown') {
      const gold = new THREE.MeshStandardMaterial({ color: 0xfacc15, emissive: 0x7a4b00, emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.9 });
      const crown = new THREE.Group();
      const band = new THREE.Mesh(new THREE.CylinderGeometry(26, 24, 16, 24, 1, true), gold);
      band.material.side = THREE.DoubleSide;
      crown.add(band);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(5, 16, 6), gold);
        spike.position.set(Math.cos(a) * 25, 15, Math.sin(a) * 25);
        const gem = new THREE.Mesh(new THREE.SphereGeometry(3.4, 10, 8), new THREE.MeshStandardMaterial({ color: [0xef4444, 0x3b82f6, 0x22c55e][i % 3], emissive: [0xef4444, 0x3b82f6, 0x22c55e][i % 3], emissiveIntensity: 0.8 }));
        gem.position.set(Math.cos(a) * 25, 24, Math.sin(a) * 25);
        crown.add(spike, gem);
      }
      crown.position.set(d.x, d.z + 70, d.y);
      scene.add(crown);
      ctx.spinners.push(crown);
    }
  }
  // Flags on the towers (on their outer rim, flying over the moat) and banners over the gates.
  const flagCols = ['#b91c1c', '#1d4ed8', '#15803d', '#a16207'];
  map.solids.filter((s) => s.kind === 'tower').forEach((s, i) => {
    const out = Math.atan2(s.y - S / 2, s.x - S / 2);
    const px = s.x + Math.cos(out) * (s.r - 14);
    const pz = s.y + Math.sin(out) * (s.r - 14);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 120, 8), new THREE.MeshStandardMaterial({ color: 0x4b3b2a, roughness: 0.8 }));
    pole.position.set(px, s.z1 + 60, pz);
    pole.castShadow = true;
    scene.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(64, 40).translate(32, 0, 0), new THREE.MeshStandardMaterial({ map: tex.banner(flagCols[i % 4]), side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(px, s.z1 + 98, pz);
    flag.castShadow = true;
    scene.add(flag);
    ctx.flags.push(flag);
  });
  map.solids.filter((s) => s.kind === 'gate').forEach((s, i) => {
    // The gate faces the moat on its outer side: hang a banner either side of the arch, both faces.
    const cx = (s.x0 + s.x1) / 2;
    const cy = (s.y0 + s.y1) / 2;
    const alongX = s.x1 - s.x0 > s.y1 - s.y0;
    for (const sd of [-1, 1]) {
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(34, 74), new THREE.MeshStandardMaterial({ map: tex.banner(flagCols[i % 4]), side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.8 }));
      if (alongX) {
        const outY = cy < S / 2 ? s.y0 - 1 : s.y1 + 1;
        banner.position.set(cx + sd * 120, s.z0 + 2, outY);
      } else {
        const outX = cx < S / 2 ? s.x0 - 1 : s.x1 + 1;
        banner.position.set(outX, s.z0 + 2, cy + sd * 120);
        banner.rotation.y = Math.PI / 2;
      }
      scene.add(banner);
    }
  });
  // Trees, hills and clouds outside the walls.
  const b = { minX: -1600, maxX: S + 1600, minY: -1600, maxY: S + 1600 };
  const outside = (min, max = Infinity) => (x, z) => {
    const dx = Math.max(-x, 0, x - S);
    const dz = Math.max(-z, 0, z - S);
    const d = Math.max(dx, dz);
    return d > min && d < max;
  };
  decorate(scene, map, theme, ctx, b, outside, 0);
  if (theme.hills) addHills(scene, S / 2, S / 2, S * 1.15, theme.hills);
  void r;
  void MOBILE;
}
