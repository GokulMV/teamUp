// Scenery for Kart Battle: per-map themes, track/arena geometry, trees, grass, clouds and props.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const MOBILE = matchMedia('(pointer: coarse)').matches;
export const UNITS_PER_METRE = 20; // a kart is ~1.8 m long and 36 units

// ---------- helpers ----------
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 8;
  return t;
}

function noise(ctx, w, h, count, colors, size = 2, seed = 1) {
  const r = rng(w * 31 + h + count + seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    ctx.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()));
  }
}

// Position/rotation helper for building merged geometry.
export function part(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

const cache = {};
const once = (key, fn) => cache[key] || (cache[key] = fn());

// ---------- textures ----------
export const tex = {
  ground: (base, specks, seed) => once(`ground${base}`, () => {
    const t = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = base; c.fillRect(0, 0, w, h);
      noise(c, w, h, 2600, specks, 3, seed);
    });
    t.repeat.set(70, 70);
    return t;
  }),
  asphalt: (base, line = '#f2f2f2', dash = 'rgba(255,255,255,0.85)') => once(`asphalt${base}${line}`, () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = base; c.fillRect(0, 0, w, h);
    const col = new THREE.Color(base);
    const shade = (k) => `#${col.clone().multiplyScalar(k).getHexString()}`;
    noise(c, w, h, 5000, [shade(0.92), shade(1.08), shade(0.85), shade(1.15)], 2);
    c.fillStyle = line;
    c.fillRect(6, 0, 6, h); c.fillRect(w - 12, 0, 6, h);
    c.fillStyle = dash;
    c.fillRect(w / 2 - 4, 0, 8, h / 2);
  })),
  curb: (a, b) => once(`curb${a}${b}`, () => canvasTexture(32, 64, (c, w, h) => {
    c.fillStyle = a; c.fillRect(0, 0, w, h / 2);
    c.fillStyle = b; c.fillRect(0, h / 2, w, h / 2);
  })),
  checker: () => once('checker', () => canvasTexture(64, 64, (c) => {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      c.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      c.fillRect(i * 8, j * 8, 8, 8);
    }
  })),
  hazard: () => once('hazard', () => canvasTexture(128, 32, (c, w, h) => {
    c.fillStyle = '#facc15'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f2937';
    for (let x = -h; x < w; x += 32) {
      c.beginPath(); c.moveTo(x, h); c.lineTo(x + 16, h); c.lineTo(x + 16 + h, 0); c.lineTo(x + h, 0); c.fill();
    }
  })),
  crate: () => once('crate', () => canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#b7813f'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#a06c2e';
    for (let y = 0; y < h; y += 21) c.fillRect(0, y, w, 3);
    c.strokeStyle = '#7c4f1d'; c.lineWidth = 12;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.beginPath(); c.moveTo(10, 10); c.lineTo(w - 10, h - 10); c.stroke();
  }, false)),
  stone: (rx, ry, base = '#8b93a7', line = '#6b7385') => {
    const t = once(`stone${base}`, () => canvasTexture(256, 128, (c, w, h) => {
      c.fillStyle = base; c.fillRect(0, 0, w, h);
      c.strokeStyle = line; c.lineWidth = 3;
      for (let y = 0; y < h; y += 32) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
        for (let x = (y / 32) % 2 ? 0 : 32; x < w; x += 64) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 32); c.stroke(); }
      }
      noise(c, w, h, 800, [line, base], 3);
    })).clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    return t;
  },
  strata: () => once('strata', () => canvasTexture(64, 256, (c, w, h) => {
    const r = rng(5);
    for (let y = 0; y < h; y += 4 + Math.floor(r() * 10)) {
      const l = 38 + r() * 16;
      c.fillStyle = `hsl(${14 + r() * 14}, ${45 + r() * 20}%, ${l}%)`;
      c.fillRect(0, y, w, 14);
    }
    noise(c, w, h, 400, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.08)'], 2);
  })),
  // Colosseum sand: raked rings, painted centre and outer rings, team-colour corner pads.
  arenaFloor: () => once('arenaFloor', () => canvasTexture(1024, 1024, (c, w, h) => {
    c.fillStyle = '#d8b47c'; c.fillRect(0, 0, w, h);
    const r = rng(17);
    for (let i = 0; i < 40; i++) {
      const x = r() * w; const y = r() * h; const rad = 40 + r() * 120;
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, r() > 0.5 ? 'rgba(150,105,55,0.08)' : 'rgba(255,236,200,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    noise(c, w, h, 8000, ['#cfa96f', '#e0bf8a', '#c89d63'], 2);
    const cx = w / 2;
    c.strokeStyle = 'rgba(120,80,40,0.16)'; c.lineWidth = 2;
    for (let rad = 64; rad < w * 0.72; rad += 64) { c.beginPath(); c.arc(cx, cx, rad, 0, Math.PI * 2); c.stroke(); }
    const corner = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];
    [[0, 0], [w, 0], [0, h], [w, h]].forEach(([x, y], i) => {
      c.fillStyle = `${corner[i]}4d`;
      c.beginPath(); c.arc(x, y, 190, 0, Math.PI * 2); c.fill();
    });
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 6;
    c.beginPath(); c.arc(cx, cx, 360, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(255,79,139,0.55)'; c.lineWidth = 14;
    c.beginPath(); c.arc(cx, cx, 210, 0, Math.PI * 2); c.stroke();
  }, false)),
  basalt: () => once('basalt', () => {
    const t = canvasTexture(1024, 1024, (c, w, h) => {
      c.fillStyle = '#3a312d'; c.fillRect(0, 0, w, h);
      noise(c, w, h, 14000, ['#332b28', '#433934', '#2c2522', '#4a3f39'], 3, 9);
      cracks(c, w, h, 'rgba(255,110,30,0.8)');
    });
    t.repeat.set(2.5, 2.5);
    return t;
  }),
  basaltGlow: () => once('basaltGlow', () => {
    // Emissive map: only the cracks glow.
    const t = canvasTexture(1024, 1024, (c, w, h) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      cracks(c, w, h, '#ff6a1a');
    });
    t.repeat.set(2.5, 2.5);
    return t;
  }),
  // Cloth banner with a swallowtail cut and a white diamond.
  banner: (color) => once(`banner${color}`, () => canvasTexture(64, 144, (c, w, h) => {
    c.fillStyle = color;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(w, 0); c.lineTo(w, h); c.lineTo(w / 2, h - 22); c.lineTo(0, h); c.closePath(); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, 0, w, 12);
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath(); c.moveTo(w / 2, 40); c.lineTo(w / 2 + 14, 62); c.lineTo(w / 2, 84); c.lineTo(w / 2 - 14, 62); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(6, 22); c.lineTo(w - 6, 22); c.stroke();
  }, false)),
  lava: () => once('lava', () => canvasTexture(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#ff3d00'); g.addColorStop(0.5, '#ff9100'); g.addColorStop(1, '#ff3d00');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const r = rng(77);
    for (let i = 0; i < 90; i++) {
      const x = r() * w; const y = r() * h; const rad = 6 + r() * 26;
      const rg = c.createRadialGradient(x, y, 0, x, y, rad);
      const hot = r() > 0.5;
      rg.addColorStop(0, hot ? 'rgba(255,240,150,0.9)' : 'rgba(90,15,0,0.85)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = rg; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  })),
  box: () => once('box', () => canvasTexture(128, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#facc15'); g.addColorStop(0.5, '#ec4899'); g.addColorStop(1, '#3b82f6');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 10; c.strokeRect(5, 5, w - 10, h - 10);
    c.fillStyle = '#fff'; c.font = 'bold 90px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = 8;
    c.fillText('?', w / 2, h / 2 + 6);
  }, false)),
  spark: () => once('spark', () => canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, false)),
  chevron: () => once('chevron', () => canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(0,229,255,0.25)'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#7df9ff';
    for (let i = 0; i < 2; i++) {
      const y = 20 + i * 52;
      c.beginPath(); c.moveTo(18, y + 34); c.lineTo(w / 2, y); c.lineTo(w - 18, y + 34); c.lineTo(w - 36, y + 34); c.lineTo(w / 2, y + 16); c.lineTo(36, y + 34); c.fill();
    }
  }, false)),
  facade: (hue) => once(`facade${hue}`, () => canvasTexture(128, 256, (c, w, h) => {
    c.fillStyle = '#0d0b1a'; c.fillRect(0, 0, w, h);
    const r = rng(hue * 13 + 7);
    for (let y = 8; y < h - 8; y += 16) {
      for (let x = 8; x < w - 8; x += 14) {
        if (r() < 0.45) continue;
        const warm = r() < 0.6;
        c.fillStyle = warm ? `hsl(${40 + r() * 20}, 90%, ${55 + r() * 25}%)` : `hsl(${hue}, 100%, ${55 + r() * 20}%)`;
        c.fillRect(x, y, 8, 9);
      }
    }
  })),
  cloud: (seed) => once(`cloud${seed}`, () => canvasTexture(256, 128, (c, w, h) => {
    const r = rng(seed * 97 + 3);
    for (let i = 0; i < 22; i++) {
      const x = w * (0.18 + r() * 0.64);
      const y = h * (0.45 + (r() - 0.5) * 0.35);
      const rad = 22 + r() * 34;
      const g = c.createRadialGradient(x, y - rad * 0.2, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.6, 'rgba(245,248,255,0.7)');
      g.addColorStop(1, 'rgba(230,236,250,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
    // Shade the underside a little.
    const s = c.createLinearGradient(0, 0, 0, h);
    s.addColorStop(0.55, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(70,90,120,0.25)');
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = s; c.fillRect(0, 0, w, h);
  }, false)),
  blades: () => once('blades', () => canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const r = rng(31);
    for (let i = 0; i < 26; i++) {
      const x = 8 + r() * (w - 16);
      const top = h * (0.05 + r() * 0.45);
      const lean = (r() - 0.5) * 30;
      const g = c.createLinearGradient(0, h, 0, top);
      const hue = 95 + r() * 20;
      g.addColorStop(0, `hsl(${hue}, 45%, 22%)`);
      g.addColorStop(1, `hsl(${hue - 10}, 55%, ${45 + r() * 12}%)`);
      c.fillStyle = g;
      c.beginPath(); c.moveTo(x - 3, h); c.quadraticCurveTo(x + lean * 0.3, (h + top) / 2, x + lean, top); c.quadraticCurveTo(x + lean * 0.3 + 1, (h + top) / 2, x + 3, h); c.fill();
    }
  }, false)),
};

// Glowing basalt cracks: wandering, tapering lines with a few side branches (same seed for the
// colour and emissive maps so they line up). Drawn 3x3 times shifted so the texture tiles seamlessly.
function cracks(c, w, h, color) {
  for (const ox of [-w, 0, w]) {
    for (const oy of [-h, 0, h]) {
      c.save();
      c.translate(ox, oy);
      crackPass(c, w, h, color);
      c.restore();
    }
  }
}
function crackPass(c, w, h, color) {
  const r = rng(41);
  c.strokeStyle = color;
  c.shadowColor = '#ff6a1a';
  c.shadowBlur = 6;
  c.lineCap = 'round';
  const crack = (x, y, a, steps, width) => {
    for (let k = 0; k < steps; k++) {
      a += (r() - 0.5) * 0.9;
      const len = 8 + r() * 18;
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      c.lineWidth = Math.max(0.6, width * (1 - k / steps));
      c.beginPath(); c.moveTo(x, y); c.lineTo(nx, ny); c.stroke();
      if (r() < 0.12 && steps > 6) crack(nx, ny, a + (r() < 0.5 ? 1 : -1) * (0.6 + r() * 0.6), Math.floor(steps / 2), width * 0.6);
      x = nx; y = ny;
    }
  };
  for (let i = 0; i < 60; i++) crack(r() * w, r() * h, r() * Math.PI * 2, 8 + Math.floor(r() * 10), 0.8 + r() * 1.4);
  c.shadowBlur = 0;
}

// ---------- themes ----------
export const THEMES = {
  meadow: {
    sky: [0x3d8ee8, 0xcfe9ff], fog: [0xcfe9ff, 1400, 5200], hemi: [0xdcefff, 0x55703a, 1.25], sun: [0xfff1d6, 2.6],
    ground: () => tex.ground('#5aa047', ['#4f9440', '#63ad4f', '#56993f', '#6bb556']),
    asphalt: () => tex.asphalt('#4b4f58'), curb: ['#e11d2e', '#f8fafc'], runoff: 0xd9c08a,
    barrier: 'tires', barrierColors: [0xe11d2e, 0xf1f5f9],
    trees: ['almond', 'casuarina', 'hibiscus'], bushes: ['grape', 'scrub'], grass: true, clouds: 26, hills: 0x5d9b62,
  },
  desert: {
    sky: [0x3f8fde, 0xf8e3bf], fog: [0xf3dcb4, 1700, 6000], hemi: [0xffe9c8, 0xa06a3a, 1.2], sun: [0xffe2b0, 2.9],
    ground: () => tex.ground('#d9a86a', ['#cf9c5c', '#e2b57a', '#c8925a', '#e8c088']),
    asphalt: () => tex.asphalt('#55504a', '#fde68a', 'rgba(253,230,138,0.85)'), curb: ['#f97316', '#fff7ed'], runoff: 0xe8c48a,
    barrier: 'rocks', mesas: true, cacti: true, clouds: 8, hills: 0xc8794a,
  },
  snow: {
    sky: [0x6f9fdc, 0xe3edf8], fog: [0xdfe9f4, 1500, 5600], hemi: [0xeaf3ff, 0x8ea6c0, 1.1], sun: [0xfff8ee, 2.5],
    ground: () => tex.ground('#e3ebf3', ['#d5e0eb', '#f1f6fb', '#cbd8e5', '#eef4fa']),
    asphalt: () => tex.asphalt('#7d8aa0', '#e0f2fe', 'rgba(224,242,254,0.9)'), curb: ['#2563eb', '#f8fafc'], runoff: 0xdfe8f1,
    barrier: 'tires', barrierColors: [0x2563eb, 0xf1f5f9],
    trees: ['casuarina'], frost: true, pines: true, snowfall: true, clouds: 30, cloudTint: 0xdde5ee, hills: 0xf2f6fb,
  },
  neon: {
    night: true, sky: [0x07031a, 0x3a1a6e], fog: [0x22124a, 1500, 6000], hemi: [0x9d8cff, 0x241a44, 1.05], sun: [0xc4b8ff, 1.3],
    ground: () => tex.ground('#221d3d', ['#29234a', '#1c1833', '#2f2852', '#191530']),
    asphalt: () => tex.asphalt('#26233a', '#7df9ff', 'rgba(255,79,216,0.9)'), curb: ['#ff4fd8', '#1b1530'], runoff: 0x1f1b33,
    barrier: 'neon', buildings: true, stars: true, neonEdges: true,
  },
  arena: {
    sky: [0x3d8ee8, 0xcfe9ff], fog: [0xcfe9ff, 1600, 5600], hemi: [0xdcefff, 0x55703a, 1.25], sun: [0xfff1d6, 2.6],
    ground: () => tex.ground('#5aa047', ['#4f9440', '#63ad4f', '#56993f', '#6bb556']),
    trees: ['almond', 'casuarina', 'hibiscus'], bushes: ['grape'], grass: true, clouds: 22, hills: 0x5d9b62,
  },
  volcano: {
    sky: [0x40161a, 0xff8a52], fog: [0x7a3626, 1900, 6200], hemi: [0xffc29a, 0x5a2a1c, 1.3], sun: [0xffc28a, 2.4],
    ground: () => tex.ground('#2f2826', ['#29221f', '#382f2b', '#221c1a', '#433834']),
    deadTrees: ['almond', 'casuarina'], embers: true, volcanoCone: true, hills: 0x3a2722,
  },
};

// ---------- moonlit-cove trees ----------
let moonlitPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
// trees.js is a classic script that expects a global THREE.
export function loadMoonlit() {
  if (!moonlitPromise) {
    window.THREE = window.THREE || THREE;
    moonlitPromise = loadScript('/vendor/moonlit/moonlit-shim.js')
      .then(() => loadScript('/vendor/moonlit/trees.js'))
      .then(() => loadScript('/vendor/moonlit/export.js'))
      .then(() => window.Trees || null)
      .catch((err) => { console.warn('Moonlit trees unavailable, using simple trees', err); return null; });
  }
  return moonlitPromise;
}

// Leaf cards: the painted card texture, cut out, darker deep inside the crown (aLeaf.x from trees.js).
const leafMatCache = {};
function leafMaterial(Trees, leafKind, k, tint) {
  const key = `${leafKind}${k}${tint || ''}`;
  if (leafMatCache[key]) return leafMatCache[key];
  const card = Trees.card(leafKind, k);
  const mat = new THREE.MeshStandardMaterial({
    map: card.map, normalMap: card.nmap, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.78,
    color: tint ? new THREE.Color(tint) : 0xffffff,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aLeaf;\nvarying float vLeafAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLeafAO = aLeaf.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLeafAO;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(0.4, 1.08, vLeafAO);');
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: card.map, alphaTest: 0.42 });
  return (leafMatCache[key] = { mat, depth });
}

const grownCache = {};
// Instances `positions` ([x, z, scale]) of the given species, a few grown variants of each, instanced.
export async function addMoonlitTrees(scene, positions, kinds, opts = {}) {
  const Trees = await loadMoonlit();
  if (!Trees || !positions.length) return false;
  const lite = MOBILE || opts.lite;
  const variants = opts.variants || (MOBILE ? 2 : 3);
  const groups = [];
  kinds.forEach((kind, ki) => {
    for (let v = 0; v < variants; v++) {
      const key = `${kind}:${v}:${lite}`;
      const g = grownCache[key] || (grownCache[key] = Trees.grow(kind, 11 + v * 101 + ki * 17, lite));
      groups.push({ kind, g, list: [] });
    }
  });
  const r = rng(opts.seed || 5);
  positions.forEach((p) => groups[Math.floor(r() * groups.length)].list.push(p));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const { kind, g, list } of groups) {
    if (!list.length) continue;
    const S = Trees.SPECIES[kind];
    const parts = [];
    if (!g.bark.empty) parts.push({ geo: g.bark, mat: Trees.materials(kind).bark, depth: null });
    if (!opts.barkOnly) {
      [g.c0, g.c1, g.c2].forEach((geo, k) => {
        if (!geo.index.count) return;
        const lm = leafMaterial(Trees, S.leaf, k, opts.tint);
        parts.push({ geo, mat: lm.mat, depth: lm.depth });
      });
    }
    for (const { geo, mat, depth } of parts) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(([x, z, s], i) => {
        const scale = UNITS_PER_METRE * (s || 1);
        q.setFromAxisAngle(up, r() * Math.PI * 2);
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(scale, scale, scale));
        im.setMatrixAt(i, m);
      });
      if (opts.barkTint && mat === Trees.materials(kind).bark) {
        im.material = mat.clone();
        im.material.color = new THREE.Color(opts.barkTint);
      }
      im.castShadow = true;
      im.receiveShadow = true;
      if (depth) im.customDepthMaterial = depth;
      im.computeBoundingSphere();
      scene.add(im);
    }
  }
  return true;
}

// Simple low-poly trees: used for snowy pines, and as a fallback if trees.js can't load.
export function addSimpleTrees(scene, positions, { snowy = false, seed = 3 } = {}) {
  const r = rng(seed);
  const trunkGeo = new THREE.CylinderGeometry(4, 6, 30, 7).translate(0, 15, 0);
  const pineGeo = new THREE.ConeGeometry(1, 2.2, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
  const crowns = new THREE.InstancedMesh(pineGeo, leafMat, positions.length * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const greens = snowy ? ['#e8f0f7', '#d7e3ee', '#2f5d46', '#e3ecf4'] : ['#2f7a3a', '#3f8f3a', '#2c6e45'];
  let n = 0;
  positions.forEach(([x, z, s0], i) => {
    const s = (s0 || 1) * (0.9 + r() * 0.5);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    for (let t = 0; t < 2; t++) {
      const w = (34 - t * 10) * s;
      m.compose(new THREE.Vector3(x, (40 + t * 34) * s, z), q, new THREE.Vector3(w, (34 - t * 6) * s, w));
      crowns.setMatrixAt(n, m);
      crowns.setColorAt(n, new THREE.Color(greens[(i + t) % greens.length]));
      n++;
    }
  });
  crowns.count = n;
  for (const im of [trunks, crowns]) { im.castShadow = true; im.receiveShadow = true; scene.add(im); }
}

// ---------- grass, clouds, hills ----------
export function addGrass(scene, positions, uniforms) {
  if (!positions.length) return;
  const blade = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const geo = mergeGeometries([part(blade, 0, 0, 0), part(blade, 0, 0, 0, 0, Math.PI / 2, 0), part(blade, 0, 0, 0, 0, Math.PI / 4, 0)]);
  const mat = new THREE.MeshStandardMaterial({ map: tex.blades(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float sway = position.y * position.y;
        vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float ph = wp.x * 0.004 + wp.z * 0.003 + uTime * 1.6;
        transformed.x += sin(ph) * 0.12 * sway;
        transformed.z += cos(ph * 0.8) * 0.08 * sway;`);
  };
  const im = new THREE.InstancedMesh(geo, mat, positions.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const r = rng(17);
  const col = new THREE.Color();
  positions.forEach(([x, z], i) => {
    const s = 16 + r() * 16;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s * 1.4, s, s * 1.4));
    im.setMatrixAt(i, m);
    im.setColorAt(i, col.setHSL(0.26 + r() * 0.05, 0.4 + r() * 0.2, 0.55 + r() * 0.25));
  });
  im.receiveShadow = true;
  scene.add(im);
}

export function addClouds(scene, count, center, spread, tint) {
  const clouds = [];
  const r = rng(23);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({ map: tex.cloud(i % 6), transparent: true, opacity: 0.92, depthWrite: false, fog: false, color: tint || 0xffffff });
    const s = new THREE.Sprite(mat);
    const w = 700 + r() * 1100;
    s.scale.set(w, w * 0.5, 1);
    s.position.set(center[0] + (r() - 0.5) * spread, 1200 + r() * 900, center[1] + (r() - 0.5) * spread);
    s.userData.speed = 8 + r() * 14;
    scene.add(s);
    clouds.push(s);
  }
  return {
    update(dt) {
      for (const c of clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > center[0] + spread / 2) c.position.x -= spread;
      }
    },
  };
}

export function addHills(scene, cx, cz, radius, color, { mesas = false } = {}) {
  const r = rng(77);
  const mat = mesas
    ? new THREE.MeshStandardMaterial({ map: tex.strata(), roughness: 1, flatShading: true })
    : new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
  const geo = mesas ? new THREE.CylinderGeometry(0.75, 1, 1, 9).translate(0, 0.5, 0) : new THREE.IcosahedronGeometry(1, 1);
  const count = 36;
  const hills = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.2;
    const rad = radius + r() * 900;
    const s = 500 + r() * 700;
    const h = mesas ? s * (0.5 + r() * 0.5) : s * (0.5 + r() * 0.5);
    m.compose(new THREE.Vector3(cx + Math.cos(a) * rad, mesas ? 0 : -s * 0.35, cz + Math.sin(a) * rad), new THREE.Quaternion(),
      new THREE.Vector3(s * (mesas ? 0.8 : 1.4), h, s * (mesas ? 0.8 : 1.4)));
    hills.setMatrixAt(i, m);
  }
  scene.add(hills);
}

// ---------- props ----------
function addMesas(scene, positions) {
  const geo = new THREE.CylinderGeometry(0.8, 1, 1, 8).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ map: tex.strata(), roughness: 1, flatShading: true });
  const im = new THREE.InstancedMesh(geo, mat, positions.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const r = rng(61);
  positions.forEach(([x, z], i) => {
    const w = 90 + r() * 160;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(w, 120 + r() * 300, w * (0.7 + r() * 0.5)));
    im.setMatrixAt(i, m);
  });
  im.castShadow = true;
  im.receiveShadow = true;
  scene.add(im);
}

function addCacti(scene, positions) {
  const g = [];
  g.push(part(new THREE.CylinderGeometry(5, 6, 60, 8), 0, 30, 0));
  g.push(part(new THREE.SphereGeometry(5, 8, 6), 0, 60, 0));
  g.push(part(new THREE.CylinderGeometry(3.5, 3.5, 18, 7), 11, 30, 0, 0, 0, Math.PI / 2));
  g.push(part(new THREE.CylinderGeometry(3.5, 3.5, 20, 7), 19, 40, 0));
  g.push(part(new THREE.SphereGeometry(3.5, 7, 5), 19, 50, 0));
  g.push(part(new THREE.CylinderGeometry(3, 3, 14, 7), -9, 22, 0, 0, 0, Math.PI / 2));
  g.push(part(new THREE.CylinderGeometry(3, 3, 16, 7), -15, 30, 0));
  g.push(part(new THREE.SphereGeometry(3, 7, 5), -15, 38, 0));
  const geo = mergeGeometries(g);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3f8a3a, roughness: 0.75, flatShading: true });
  const im = new THREE.InstancedMesh(geo, mat, positions.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const r = rng(71);
  positions.forEach(([x, z], i) => {
    const s = 0.7 + r() * 0.8;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
    im.setMatrixAt(i, m);
  });
  im.castShadow = true;
  scene.add(im);
}

function addBuildings(scene, positions) {
  const hues = [190, 300, 265];
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  hues.forEach((hue, hi) => {
    const list = positions.filter((_, i) => i % hues.length === hi);
    const t = tex.facade(hue);
    const mat = new THREE.MeshStandardMaterial({ color: 0x15122a, map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.9, roughness: 0.6 });
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4();
    const r = rng(hue);
    list.forEach(([x, z], i) => {
      const w = 140 + r() * 160;
      const h = 220 + r() * 700;
      m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(w, h, w * (0.7 + r() * 0.6)));
      im.setMatrixAt(i, m);
    });
    im.castShadow = true;
    scene.add(im);
    // Glowing roof edges.
    const roofMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue / 360, 1, 0.6) });
    const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), roofMat, list.length);
    for (let i = 0; i < list.length; i++) {
      im.getMatrixAt(i, m);
      const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
      m.decompose(p, q, s);
      m.compose(new THREE.Vector3(p.x, s.y + 3, p.z), q, new THREE.Vector3(s.x + 6, 6, s.z + 6));
      roofs.setMatrixAt(i, m);
    }
    scene.add(roofs);
  });
}

function addStars(scene) {
  const n = 1500;
  const pos = new Float32Array(n * 3);
  const r = rng(3);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const e = Math.asin(0.15 + r() * 0.85);
    pos.set([Math.cos(a) * Math.cos(e) * 8000, Math.sin(e) * 8000, Math.sin(a) * Math.cos(e) * 8000], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false }));
  stars.userData.followCamera = true;
  scene.add(stars);
  return stars;
}

function addVolcanoCone(scene, x, z) {
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(260, 1500, 1500, 24, 4, true),
    new THREE.MeshStandardMaterial({ color: 0x2b201d, roughness: 1, flatShading: true }));
  cone.position.set(x, 700, z);
  scene.add(cone);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(250, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff5a1a }));
  glow.position.set(x, 1440, z);
  scene.add(glow);
  return glow;
}

function boostPad(scene, p) {
  const mat = new THREE.MeshBasicMaterial({ map: tex.chevron().clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.map.needsUpdate = true;
  mat.map.wrapT = THREE.RepeatWrapping;
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), mat);
  pad.position.set(p.x, 1.6, p.y);
  pad.rotation.y = -p.angle - Math.PI / 2;
  scene.add(pad);
  return pad;
}

// ---------- track (race) ----------
function ribbon(points, normals, offA, offB, y, vScale) {
  const n = points.length;
  const pos = [];
  const uv = [];
  const idx = [];
  let dist = 0;
  for (let i = 0; i <= n; i++) {
    const p = points[i % n];
    const nm = normals[i % n];
    if (i > 0) {
      const q = points[i - 1];
      dist += Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
    pos.push(p[0] + nm[0] * offA, y, p[1] + nm[1] * offA, p[0] + nm[0] * offB, y, p[1] + nm[1] * offB);
    uv.push(0, dist / vScale, 1, dist / vScale);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Random points off the track/arena floor, between `min` and `max` units from it.
function scatter(count, map, bounds, test, seed, tries = 20) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; out.length < count && i < count * tries; i++) {
    const x = bounds.minX + r() * (bounds.maxX - bounds.minX);
    const z = bounds.minY + r() * (bounds.maxY - bounds.minY);
    if (test(x, z)) out.push([x, z, 0.85 + r() * 0.35]);
  }
  return out;
}

export function buildRace(scene, map, theme, ctx) {
  const pts = map.centerline;
  const n = pts.length;
  const normals = pts.map((_, i) => {
    const a = map.tangents[(i - 1 + n) % n];
    const b = map.tangents[i];
    const tx = a[0] + b[0];
    const ty = a[1] + b[1];
    const l = Math.hypot(tx, ty) || 1;
    return [-ty / l, tx / l];
  });
  const half = map.width / 2;

  const asphalt = theme.asphalt();
  const road = new THREE.Mesh(ribbon(pts, normals, -half, half, 0.6, 256),
    new THREE.MeshStandardMaterial({
      map: asphalt, roughness: theme.night ? 0.4 : 0.85, metalness: theme.night ? 0.3 : 0, side: THREE.DoubleSide,
      emissive: theme.night ? 0xffffff : 0x000000, emissiveMap: theme.night ? asphalt : null, emissiveIntensity: 0.35,
    }));
  road.receiveShadow = true;
  scene.add(road);
  const curbTex = tex.curb(theme.curb[0], theme.curb[1]);
  for (const [a, b] of [[half, half + 18], [-half - 18, -half]]) {
    const curb = new THREE.Mesh(ribbon(pts, normals, a, b, 1.2, 64),
      new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.6, side: THREE.DoubleSide }));
    curb.receiveShadow = true;
    scene.add(curb);
  }
  const runMat = new THREE.MeshStandardMaterial({ color: theme.runoff, roughness: 1, side: THREE.DoubleSide });
  for (const [a, b] of [[half + 18, half + 60], [-half - 60, -half - 18]]) {
    const run = new THREE.Mesh(ribbon(pts, normals, a, b, 0.3, 64), runMat);
    run.receiveShadow = true;
    scene.add(run);
  }
  if (theme.neonEdges) {
    // Glowing light strips along both edges (bloom makes them shine).
    [[half + 18, half + 24, 0x22e5ff], [-half - 24, -half - 18, 0xff3fd2]].forEach(([a, b, c]) => {
      const strip = new THREE.Mesh(ribbon(pts, normals, a, b, 1.6, 64), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      scene.add(strip);
    });
  }

  // Start/finish: checkered strip + gantry.
  const c0 = pts[0];
  const t0 = map.tangents[0];
  const ang = Math.atan2(t0[1], t0[0]);
  const checker = tex.checker().clone();
  checker.needsUpdate = true;
  checker.repeat.set(1, 10);
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(26, map.width), new THREE.MeshStandardMaterial({ map: checker }));
  strip.rotation.x = -Math.PI / 2;
  strip.rotation.z = -ang;
  strip.position.set(c0[0], 1.4, c0[1]);
  scene.add(strip);
  const gantry = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: theme.night ? 0x2a2540 : 0xe5e7eb, metalness: 0.6, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(10, 120, 10), postMat);
    post.position.set(0, 60, s * (half + 30));
    post.castShadow = true;
    gantry.add(post);
  }
  const bannerTex = canvasTexture(512, 64, (c, w, h) => {
    c.fillStyle = theme.night ? '#ff2fd0' : '#ff4f8b'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff'; c.font = 'bold 42px "Trebuchet MS", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(`🏁  ${map.name.toUpperCase()}  🏁`, w / 2, h / 2 + 2);
  }, false);
  const bannerMat = new THREE.MeshStandardMaterial({ map: bannerTex, emissive: theme.night ? 0xffffff : 0x000000, emissiveMap: theme.night ? bannerTex : null, emissiveIntensity: 0.8 });
  // The gantry's local x runs along the track, so the banner goes on the ±x faces:
  // readable when driving through in either direction (reverse races too).
  const banner = new THREE.Mesh(new THREE.BoxGeometry(8, 30, map.width + 70), [bannerMat, bannerMat, postMat, postMat, postMat, postMat]);
  banner.position.y = 115;
  banner.castShadow = true;
  gantry.add(banner);
  gantry.position.set(c0[0], 0, c0[1]);
  gantry.rotation.y = -ang;
  scene.add(gantry);

  // Barriers just outside the physical wall, skipped where they'd intrude on another stretch.
  const wall = half + 175;
  const spots = [];
  for (let i = 0; i < n; i++) {
    for (const side of [1, -1]) {
      const x = pts[i][0] + normals[i][0] * wall * side;
      const z = pts[i][1] + normals[i][1] * wall * side;
      if (map.nearestIndex(x, z).dist < wall - 6) continue;
      spots.push([x, z]);
    }
  }
  const m = new THREE.Matrix4();
  if (theme.barrier === 'rocks') {
    const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xa65a35, roughness: 1, flatShading: true }), spots.length);
    const r = rng(9);
    spots.forEach(([x, z], i) => {
      const s = 14 + r() * 12;
      m.compose(new THREE.Vector3(x, s * 0.4, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, 0)), new THREE.Vector3(s, s * 0.8, s));
      rocks.setMatrixAt(i, m);
    });
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    scene.add(rocks);
  } else if (theme.barrier === 'neon') {
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 26, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), spots.length);
    spots.forEach(([x, z], i) => {
      m.makeTranslation(x, 13, z);
      posts.setMatrixAt(i, m);
      posts.setColorAt(i, new THREE.Color(i % 2 ? 0x22e5ff : 0xff3fd2));
    });
    scene.add(posts);
  } else {
    const tires = new THREE.InstancedMesh(new THREE.CylinderGeometry(13, 13, 22, 12), new THREE.MeshStandardMaterial({ roughness: 0.8 }), spots.length);
    spots.forEach(([x, z], i) => {
      m.makeTranslation(x, 11, z);
      tires.setMatrixAt(i, m);
      tires.setColorAt(i, new THREE.Color(theme.barrierColors[i % 4 < 2 ? 0 : 1]));
    });
    tires.castShadow = true;
    tires.receiveShadow = true;
    scene.add(tires);
  }

  for (const p of map.boostPads) ctx.pads.push(boostPad(scene, p));

  // Scenery off the track.
  const b = { minX: map.bounds.minX - 700, maxX: map.bounds.maxX + 700, minY: map.bounds.minY - 700, maxY: map.bounds.maxY + 700 };
  const offBy = (min, max = Infinity) => (x, z) => { const d = map.nearestIndex(x, z).dist; return d > min && d < max; };
  decorate(scene, map, theme, ctx, b, offBy, half);
  if (theme.hills) addHills(scene, map.center[0], map.center[1], 3600, theme.hills, { mesas: !!theme.mesas });
}

// ---------- arena ----------
export function buildArena(scene, map, theme, ctx) {
  const S = map.size;
  const volcano = map.theme === 'volcano';
  const floorMat = volcano
    ? new THREE.MeshStandardMaterial({ map: tex.basalt(), emissive: 0xffffff, emissiveMap: tex.basaltGlow(), emissiveIntensity: 0.6, roughness: 0.9 })
    : new THREE.MeshStandardMaterial({ map: tex.arenaFloor(), roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(S / 2, 0.5, S / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // Perimeter walls (physics wall is 40 units in from each edge): stone, with a padded pink
  // rail along the top of the Colosseum's.
  const wallTex = volcano ? tex.stone(S / 128, 1, '#3a302c', '#241e1b') : tex.stone(S / 128, 1, '#a8a29a', '#857e75');
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8 });
  const wallSide = new THREE.MeshStandardMaterial({ color: volcano ? 0x241e1b : 0x8a8379, roughness: 0.85 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xff4fa3, roughness: 0.55 });
  for (const [x, z, w, d] of [[S / 2, 20, S, 40], [S / 2, S - 20, S, 40], [20, S / 2, 40, S], [S - 20, S / 2, 40, S]]) {
    const geo = w < d ? new THREE.BoxGeometry(d, 40, w) : new THREE.BoxGeometry(w, 40, d);
    const wall = new THREE.Mesh(geo, [wallSide, wallSide, wallSide, wallSide, wallMat, wallMat]);
    if (w < d) wall.rotation.y = Math.PI / 2;
    wall.position.set(x, 20, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    if (!volcano) {
      const rail = new THREE.Mesh(new RoundedBoxGeometry(Math.max(w, d) + 4, 6, 44, 2, 2.5), railMat);
      rail.rotation.y = wall.rotation.y;
      rail.position.set(x, 43, z);
      rail.castShadow = true;
      scene.add(rail);
    }
  }

  const towerMat = new THREE.MeshStandardMaterial({ map: tex.stone(10, 1.4), roughness: 0.85 });
  const towerTopMat = new THREE.MeshStandardMaterial({ map: tex.stone(6, 1), roughness: 0.85 });
  const pillarMat = new THREE.MeshStandardMaterial({ map: tex.stone(4, 1.8), roughness: 0.85 });
  const crateMat = new THREE.MeshStandardMaterial({ map: tex.crate(), roughness: 0.8 });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3b3230, emissive: 0x2a0d05, roughness: 1, flatShading: true });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0xff4f8b, emissive: 0xff4f8b, emissiveIntensity: 1.4 });
  const r = rng(13);
  for (const o of map.obstacles) {
    let mesh;
    if (o.kind === 'tower') {
      mesh = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r + 10, 90, 32), towerMat);
      base.position.y = 45;
      const cornice = new THREE.Mesh(new THREE.TorusGeometry(o.r - 2, 8, 8, 40), towerTopMat);
      cornice.rotation.x = Math.PI / 2;
      cornice.position.y = 92;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 0.55, o.r * 0.75, 70, 24), towerTopMat);
      top.position.y = 125;
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(20, 1), glowMat);
      orb.position.y = 190;
      ctx.spinners.push(orb);
      [base, cornice, top, orb].forEach((p) => { p.castShadow = true; p.receiveShadow = true; mesh.add(p); });
      // Four cloth banners hanging from the top tier, leaning with its slope.
      const slope = Math.atan2(o.r * 0.2, 70);
      ['#ff4fa3', '#7c5cff', '#ffb547', '#22d3ee'].forEach((col, i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const banner = new THREE.Mesh(new THREE.PlaneGeometry(36, 80),
          new THREE.MeshStandardMaterial({ map: tex.banner(col), side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.8 }));
        const rad = o.r * 0.65 + 4;
        banner.position.set(Math.cos(a) * rad, 120, Math.sin(a) * rad);
        banner.rotation.set(-slope, Math.PI / 2 - a, 0, 'YXZ');
        banner.castShadow = true;
        mesh.add(banner);
      });
    } else if (o.kind === 'pillar') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, 110, 24), pillarMat);
      mesh.position.y = 55;
    } else if (o.kind === 'rock') {
      // Lumpy low-poly boulder: shared corners move together so the faces stay closed.
      const geo = new THREE.IcosahedronGeometry(o.r * 1.12, 2);
      const pos = geo.attributes.position;
      const seed = r() * 1000;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
        const h = Math.sin(Math.round(x) * 12.99 + Math.round(y) * 78.23 + Math.round(z) * 37.72 + seed) * 43758.55;
        const k = 1 + ((h - Math.floor(h)) - 0.5) * 0.22;
        pos.setXYZ(i, x * k, y * k, z * k);
      }
      geo.computeVertexNormals();
      mesh = new THREE.Mesh(geo, rockMat);
      mesh.scale.set(1, 0.75 + r() * 0.4, 1);
      mesh.rotation.y = r() * 6;
      mesh.position.y = o.r * 0.3;
    } else {
      const s = o.r * 1.45;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), crateMat);
      mesh.position.y = s * 0.4;
      mesh.rotation.y = Math.PI / 4;
    }
    mesh.position.x = o.x;
    mesh.position.z = o.y;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Lava pools: bright, slowly churning, with a dark crust rim.
  for (const h of map.hazards) {
    const lt = tex.lava().clone();
    lt.needsUpdate = true;
    lt.repeat.set(h.r / 120, h.r / 120);
    const lava = new THREE.Mesh(new THREE.CircleGeometry(h.r, 40).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 1.3, roughness: 0.4 }));
    lava.position.set(h.x, 1.2, h.y);
    scene.add(lava);
    ctx.lava.push(lt);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(h.r, 10, 6, 40).rotateX(Math.PI / 2), rockMat);
    rim.position.set(h.x, 2, h.y);
    rim.receiveShadow = true;
    scene.add(rim);
    const light = new THREE.PointLight(0xff6a1a, 2.5, h.r * 4, 1.2);
    light.position.set(h.x, 60, h.y);
    scene.add(light);
  }

  for (const p of map.boostPads) ctx.pads.push(boostPad(scene, p));

  if (!volcano) {
    // Floodlight towers in the corners.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.7, roughness: 0.35 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfffbe6, emissive: 0xfff3c4, emissiveIntensity: 1.2 });
    for (const [x, z] of [[-80, -80], [S + 80, -80], [-80, S + 80], [S + 80, S + 80]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(8, 12, 320, 10), poleMat);
      pole.position.set(x, 160, z);
      pole.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(70, 40, 20), lampMat);
      lamp.position.set(x, 330, z);
      lamp.lookAt(S / 2, 0, S / 2);
      scene.add(pole, lamp);
    }
    // Stands of spectators along two sides.
    const standMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.9 });
    const crowdColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xeab308, 0xec4899, 0xffffff, 0xa855f7];
    const crowd = new THREE.InstancedMesh(new THREE.SphereGeometry(7, 6, 5), new THREE.MeshStandardMaterial({ roughness: 0.8 }), 900);
    let ci = 0;
    const mm = new THREE.Matrix4();
    for (const side of [0, 1]) {
      for (let row = 0; row < 4; row++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(S - 400, 18, 40), standMat);
        const z = side ? S + 90 + row * 40 : -90 - row * 40;
        step.position.set(S / 2, 9 + row * 18, z);
        step.receiveShadow = true;
        scene.add(step);
        for (let x = 260; x < S - 260 && ci < 900; x += 18 + r() * 14) {
          mm.makeTranslation(x, 25 + row * 18, z + (r() - 0.5) * 16);
          crowd.setMatrixAt(ci, mm);
          crowd.setColorAt(ci, new THREE.Color(crowdColors[Math.floor(r() * crowdColors.length)]));
          ci++;
        }
      }
    }
    crowd.count = ci;
    scene.add(crowd);
    ctx.crowd = crowd;
  }

  const b = { minX: -1300, maxX: S + 1300, minY: -1300, maxY: S + 1300 };
  const outside = (min, max = Infinity) => (x, z) => {
    const dx = Math.max(-x, 0, x - S);
    const dz = Math.max(-z, 0, z - S);
    const d = Math.max(dx, dz);
    return d > min && d < max;
  };
  decorate(scene, map, theme, ctx, b, outside, 0);
  if (theme.volcanoCone) ctx.volcanoGlow = addVolcanoCone(scene, S / 2 - 2600, S / 2 - 3200);
  if (theme.hills) addHills(scene, S / 2, S / 2, 3000, theme.hills);
}

// Trees, bushes, grass, cacti, buildings... around a map. `test(min, max)` gives a filter for
// "this far from the playable area".
function decorate(scene, map, theme, ctx, bounds, test, half) {
  const treeCount = MOBILE ? 140 : 300;
  if (theme.trees) {
    const spots = scatter(treeCount, map, bounds, test(half + 300), 1234);
    const fallback = () => addSimpleTrees(scene, spots, { snowy: theme.frost });
    if (theme.pines) {
      const pines = spots.filter((_, i) => i % 2 === 0);
      addSimpleTrees(scene, pines, { snowy: true });
      addMoonlitTrees(scene, spots.filter((_, i) => i % 2 === 1), theme.trees, { tint: theme.frost ? 0xe9f1f8 : null, seed: 2 }).then((ok) => ok || fallback());
    } else {
      addMoonlitTrees(scene, spots, theme.trees, { seed: 1 }).then((ok) => ok || fallback());
    }
  }
  if (theme.bushes) {
    const spots = scatter(MOBILE ? 80 : 200, map, bounds, test(half + 90, half + 900), 4321);
    addMoonlitTrees(scene, spots, theme.bushes, { seed: 3, variants: 2 });
  }
  if (theme.deadTrees) {
    const spots = scatter(MOBILE ? 50 : 110, map, bounds, test(half + 250), 777);
    addMoonlitTrees(scene, spots, theme.deadTrees, { barkOnly: true, barkTint: 0x4a3f3a, seed: 4, variants: 2 });
  }
  if (theme.grass && !MOBILE) {
    addGrass(scene, scatter(7000, map, bounds, test(half + 70, half + 900), 99, 6), ctx.uniforms);
  } else if (theme.grass) {
    addGrass(scene, scatter(2200, map, bounds, test(half + 70, half + 600), 99, 6), ctx.uniforms);
  }
  if (theme.cacti) addCacti(scene, scatter(160, map, bounds, test(half + 230), 55));
  if (theme.mesas) addMesas(scene, scatter(28, map, bounds, test(half + 420), 66, 60));
  if (theme.buildings) addBuildings(scene, scatter(140, map, bounds, test(half + 260), 88, 60));
  if (theme.stars) addStars(scene);
  if (theme.clouds) ctx.clouds = addClouds(scene, MOBILE ? Math.ceil(theme.clouds / 2) : theme.clouds, map.center, 9000, theme.cloudTint);
}
