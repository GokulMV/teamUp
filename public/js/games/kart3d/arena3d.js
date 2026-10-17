// Layered arenas in 3D (maps from shared/kart-layers.js). Every floor, wall, ramp and tower is built
// from the map data with the theme's kit of materials; textures tile in world space, so pieces of
// any size line up. On top of that: the moat, jump pads with their flight arcs, bumpers, boost
// chevrons, lava pools, the moving obstacles and some scenery. Roofs (anything you can drive under)
// fade out when they would hide your kart from the camera.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tex, canvasTexture, rng, MOBILE, boostPad, decorate, addHills, addMoonlitTrees } from './world.js';
import { buildSculpted, buildTyres, SCULPTED_KINDS } from './sculpt3d.js';
import { buildBrightSolids } from './bright3d.js';
import { buildHarbour } from './harbour3d.js';
import { buildSkyGardens } from './skygarden3d.js';

// Bright arenas' own set dressing (and models for their moving obstacles), by theme.
const DRESSINGS = { harbour: buildHarbour, skygarden: buildSkyGardens };

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
  steps: (base = '#a39883') => canvasTexture(128, 128, (c, w, h) => {
    const r = rng(61);
    for (let y = 0; y < h; y += 32) {
      c.fillStyle = shade(base, 0.9 + r() * 0.15); c.fillRect(0, y, w, 32);
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
  // Night grass: dark and blue-green, with bare patches of earth.
  nightGrass: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#394a37'; c.fillRect(0, 0, w, h);
    const r = rng(71);
    for (let i = 0; i < 40; i++) {
      const x = r() * w; const y = r() * h; const rr = 16 + r() * 36;
      wrapped(c, w, h, x, y, rr, (px, py) => {
        const g = c.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, r() < 0.35 ? 'rgba(74,58,44,0.55)' : r() < 0.5 ? 'rgba(80,110,80,0.3)' : 'rgba(10,16,14,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      });
    }
    speckle(c, w, h, 5000, ['#2e3e2e', '#435842', '#344636', '#506a50', '#283628'], 2, 72);
    c.lineWidth = 1;
    for (let i = 0; i < 800; i++) {
      const x = r() * w; const y = r() * h;
      c.strokeStyle = r() < 0.5 ? 'rgba(10,20,14,0.5)' : 'rgba(110,140,110,0.35)';
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 4); c.stroke();
    }
  }),
  // Sand: warm, with wind ripples and grit.
  sand: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#d6ae76'; c.fillRect(0, 0, w, h);
    const r = rng(111);
    for (let i = 0; i < 30; i++) {
      const x = r() * w; const y = r() * h; const rr = 20 + r() * 40;
      wrapped(c, w, h, x, y, rr, (px, py) => {
        const g = c.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, r() < 0.5 ? 'rgba(240,206,150,0.4)' : 'rgba(170,120,70,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      });
    }
    c.lineWidth = 1.5;
    for (let y = 4; y < h; y += 11 + Math.floor(r() * 6)) {
      c.strokeStyle = r() < 0.5 ? 'rgba(150,104,58,0.28)' : 'rgba(255,230,180,0.3)';
      c.beginPath(); c.moveTo(0, y);
      for (let x = 0; x <= w; x += 16) c.lineTo(x, y + Math.sin((x / w) * TAU * 2 + y) * 3);
      c.stroke();
    }
    speckle(c, w, h, 2600, ['#c49a62', '#e6c08a', '#b88c58', '#efd3a2'], 2, 112);
  }),
  // Snow: soft blue-white drifts with a sparkle.
  snow: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#e4edf5'; c.fillRect(0, 0, w, h);
    const r = rng(121);
    for (let i = 0; i < 36; i++) {
      const x = r() * w; const y = r() * h; const rr = 18 + r() * 44;
      wrapped(c, w, h, x, y, rr, (px, py) => {
        const g = c.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, r() < 0.5 ? 'rgba(255,255,255,0.6)' : 'rgba(150,178,210,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      });
    }
    speckle(c, w, h, 1800, ['#d3e0ec', '#f6faff', '#c4d4e4', '#ffffff'], 2, 122);
  }),
  // Volcanic ash and basalt grit, with a few hot cracks.
  ash: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#332c29'; c.fillRect(0, 0, w, h);
    const r = rng(131);
    for (let i = 0; i < 34; i++) {
      const x = r() * w; const y = r() * h; const rr = 16 + r() * 40;
      wrapped(c, w, h, x, y, rr, (px, py) => {
        const g = c.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, r() < 0.5 ? 'rgba(80,70,64,0.4)' : 'rgba(10,8,8,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      });
    }
    speckle(c, w, h, 3000, ['#2a2422', '#3e3532', '#231e1c', '#4a403b'], 2, 132);
    c.lineWidth = 1.6;
    for (let i = 0; i < 9; i++) {
      let x = r() * w; let y = r() * h;
      c.strokeStyle = 'rgba(255,96,32,0.5)';
      c.beginPath(); c.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; c.lineTo(x, y); }
      c.stroke();
    }
  }),
  // Slate roof tiles: rows of overlapping, slightly uneven tiles.
  slate: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#1d2029'; c.fillRect(0, 0, w, h);
    const r = rng(81);
    for (let y = 0, row = 0; y < h; y += 26, row++) {
      for (let x = (row % 2) * -16; x < w; x += 32) {
        c.fillStyle = shade('#454b5c', 0.75 + r() * 0.35);
        c.beginPath(); c.moveTo(x + 1, y); c.lineTo(x + 31, y); c.lineTo(x + 31, y + 22); c.quadraticCurveTo(x + 16, y + 27, x + 1, y + 22); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(x + 2, y + 1, 28, 2);
      }
    }
    speckle(c, w, h, 1500, ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.05)'], 2, 82);
  }),
  // A headstone's face: weathered stone, a carved cross and lines of worn-away lettering.
  grave: () => canvasTexture(128, 160, (c, w, h) => {
    c.fillStyle = '#8a8a8f'; c.fillRect(0, 0, w, h);
    speckle(c, w, h, 2200, ['#7a7a80', '#9a9aa0', '#6e6e75', '#a8a8ad', '#5d6b55'], 2, 91);
    const r = rng(92);
    for (let i = 0; i < 14; i++) { const x = r() * w; const y = r() * h * 0.4 + h * 0.6; c.fillStyle = `rgba(70,100,60,${0.15 + r() * 0.2})`; c.beginPath(); c.arc(x, y, 3 + r() * 8, 0, TAU); c.fill(); }
    c.fillStyle = 'rgba(30,30,36,0.55)';
    c.fillRect(w / 2 - 4, 20, 8, 46); c.fillRect(w / 2 - 18, 32, 36, 8);
    for (let y = 80; y < 128; y += 12) c.fillRect(24 + r() * 8, y, w - 48 - r() * 16, 4);
  }, false),
  // Bubbling acid: lurid green with brighter blobs (scrolled slowly, like the lava).
  acid: () => canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#3f6212'; c.fillRect(0, 0, w, h);
    const r = rng(101);
    for (let i = 0; i < 70; i++) {
      const x = r() * w; const y = r() * h; const rr = 8 + r() * 30;
      wrapped(c, w, h, x, y, rr, (px, py) => {
        const g = c.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, r() < 0.6 ? 'rgba(190,242,100,0.9)' : 'rgba(236,252,203,0.8)'); g.addColorStop(1, 'rgba(101,163,13,0)');
        c.fillStyle = g; c.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      });
    }
  }),
  // A jack-o'-lantern's face, glowing (transparent round it).
  pumpkinFace: () => canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#ffd34d';
    c.beginPath(); c.moveTo(30, 52); c.lineTo(52, 52); c.lineTo(41, 30); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(76, 52); c.lineTo(98, 52); c.lineTo(87, 30); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(24, 70);
    for (let i = 0; i <= 8; i++) c.lineTo(24 + i * 10, 70 + (i % 2 ? 12 : 0));
    c.lineTo(104, 70); c.quadraticCurveTo(64, 118, 24, 70); c.fill();
  }, false),
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
KITS.graveyard = {
  grass: { top: ['nightGrass', [], 260], side: ['dirt', [], 200] },
  crypt: { top: ['flag', ['#4d4a57'], 200], side: ['ashlar', ['#5d5a68', '#2b2933'], 150], bottom: ['ashlar', ['#5d5a68', '#2b2933'], 150] },
  gallery: { top: ['flag', ['#625e6c'], 170], side: ['ashlar', ['#5d5a68', '#2b2933'], 150], bottom: ['timber', [], 110] },
  slate: { top: ['slate', [], 160], side: ['ashlar', ['#5d5a68', '#2b2933'], 150], bottom: ['timber', [], 110] },
  stair: { top: ['steps', [], 22, 'steps'], side: ['ashlar', ['#5d5a68', '#2b2933'], 150] },
  pillar: { top: ['ashlar', ['#6b6876', '#34313d'], 150], side: ['ashlar', ['#6b6876', '#34313d'], 150] },
  stone: { top: ['flag', ['#4d4a57'], 200], side: ['ashlar', ['#5d5a68', '#2b2933'], 150] },
  ground: { top: ['nightGrass', [], 260], side: ['dirt', [], 200] },
};
Object.assign(KITS.keep, {
  deck: { top: ['planks', [], 110, 'across'], side: ['timber', [], 110], bottom: ['planks', [], 110] },
  terrace: { top: ['grass', [], 300], side: ['ashlar', [], 150] },
  column: { top: ['ashlar', ['#c2b8a3', '#7b7262'], 150], side: ['ashlar', ['#c2b8a3', '#7b7262'], 150] },
});
Object.assign(KITS.graveyard, {
  deck: { top: ['planks', [], 110, 'across'], side: ['timber', [], 110], bottom: ['timber', [], 110] },
  terrace: { top: ['nightGrass', [], 260], side: ['ashlar', ['#5d5a68', '#2b2933'], 150] },
  tower: { top: ['flag', ['#4d4a57'], 200], side: ['ashlar', ['#5d5a68', '#2b2933', 26], 150] },
  wall: { top: ['flag', ['#4d4a57'], 200], side: ['ashlar', ['#5d5a68', '#2b2933'], 150] },
  merlon: { top: ['ashlar', ['#5d5a68', '#2b2933'], 150], side: ['ashlar', ['#5d5a68', '#2b2933'], 150] },
  bridge: { top: ['planks', [], 110, 'across'], side: ['timber', [], 110], bottom: ['timber', [], 110] },
  crate: { top: ['crate', [], 0], side: ['crate', [], 0] },
  column: { top: ['ashlar', ['#6b6876', '#34313d'], 150], side: ['ashlar', ['#6b6876', '#34313d'], 150] },
});
// The weekly arena's other looks (shared/kart-weekly.js): the same kinds of solid in each.
const lookKit = (ground, stone, mortar, flag, steps) => ({
  ground: { top: [ground, [], 260], side: ['ashlar', [stone, mortar], 150] },
  terrace: { top: [ground, [], 260], side: ['ashlar', [stone, mortar], 150] },
  stone: { top: ['flag', [flag], 200], side: ['ashlar', [stone, mortar], 150] },
  tower: { top: ['flag', [flag], 200], side: ['ashlar', [stone, mortar, 26], 150] },
  wall: { top: ['flag', [flag], 200], side: ['ashlar', [stone, mortar], 150] },
  merlon: { top: ['ashlar', [stone, mortar], 150], side: ['ashlar', [stone, mortar], 150] },
  deck: { top: ['planks', [], 110, 'across'], side: ['timber', [], 110], bottom: ['planks', [], 110] },
  bridge: { top: ['planks', [], 110, 'across'], side: ['timber', [], 110], bottom: ['planks', [], 110] },
  stair: { top: ['steps', [steps], 22, 'steps'], side: ['ashlar', [stone, mortar], 150] },
  crate: { top: ['crate', [], 0], side: ['crate', [], 0] },
  pillar: { top: ['ashlar', [stone, mortar], 150], side: ['ashlar', [stone, mortar], 150] },
  column: { top: ['ashlar', [stone, mortar], 150], side: ['ashlar', [stone, mortar], 150] },
});
// Stone a few shades off the ground, so the shapes read from up high.
KITS.ruins = lookKit('sand', '#bd8d58', '#76522f', '#c89e68', '#b98a57');
KITS.glacier = lookKit('snow', '#9fbbd2', '#5d7b94', '#c4d7e7', '#94b1c8');
KITS.basalt = lookKit('ash', '#6c5c59', '#2a2123', '#76696a', '#7d6d6b');
// The Cinder Bowl: its ground, viaduct, pillars and props are drawn by sculpt3d.js; this covers the rest.
KITS.cinder = lookKit('grass', '#8c6239', '#5a3d22', '#a0896e', '#9a7d5f');
// Kinds drawn by their own builders instead of as plain blocks.
const SPECIAL = new Set(['tomb', 'fence', 'deadtree']);
const ROUGH = { planks: 0.85, timber: 0.9, tent: 0.95, grass: 1, dirt: 1, nightGrass: 1, slate: 0.7, sand: 1, snow: 0.8, ash: 1 };

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
  const special = { tomb: [], fence: [], deadtree: [] };
  const glows = []; // acid pools that fizz
  // Sculpted arenas (a low-poly ground, a viaduct): their own builder draws those and their props.
  const sculpted = !!(map.terrain && map.terrain.style === 'lowpoly');
  // Bright arenas (clean colour blocks, painted rims): kart3d/bright3d.js draws their solids and water.
  const bright = map.look === 'bright';
  const dress = bright && DRESSINGS[map.theme] ? DRESSINGS[map.theme](scene, map, ctx) : null;
  if (bright) roofs.push(...buildBrightSolids(scene, map, ctx, dress?.skip).roofs);
  for (const s of bright ? [] : map.solids) {
    if (s.kind === 'bumper' || s.kind === 'hub') continue; // drawn with their bumper / sweeper
    if (s.type === 3) continue; // road pieces: drawn as whole roads (sculpt3d.js)
    if (sculpted && SCULPTED_KINDS.has(s.kind)) continue;
    if (SPECIAL.has(s.kind)) { special[s.kind].push(s); continue; }
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
  if (sculpted) buildSculpted(scene, map, ctx);
  else if (map.land) buildLand(scene, map, kit);
  if (special.tomb.length) buildTombs(scene, map, special.tomb);
  if (special.fence.length) buildFences(scene, map, special.fence);
  if (special.deadtree.length) {
    addMoonlitTrees(scene, special.deadtree.map((d) => [d.x, d.y, 0.9 + ((d.x * 7 + d.y * 3) % 5) / 10, map.land ? map.land.at(d.x, d.y) : 0]), ['almond', 'casuarina'],
      { barkOnly: true, barkTint: 0x3a3330, seed: 6, variants: 2 });
  }

  // The world outside the arena: the same ground, with a square hole where the arena is.
  const outerKit = kit.grass || kit.ground;
  if (!bright) {
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

  // Edge walls: a palisade of sharpened logs (or wrought iron railings) where the physics wall stands.
  if (map.edge === 'wall' && !sculpted && !bright) addPalisade(scene, S, theme.railings); // (cliffs ring a sculpted bowl)

  // Moat / lava lake: one sheet at the liquid's level (only seen through the holes in the floor).
  // (A sculpted arena's lava fills its craters: sculpt3d.js.)
  if (map.liquid && !sculpted && !bright) {
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

  // Lava or acid pools on a floor (an open grave full of acid sits a little down in a dug-out pit).
  for (const h of map.hazards) {
    const acid = h.kind === 'acid';
    const lt = (acid ? texture('acid') : tex.lava()).clone();
    lt.needsUpdate = true;
    const round = h.r !== undefined;
    const w = round ? h.r * 2 : h.x1 - h.x0;
    const d = round ? h.r * 2 : h.y1 - h.y0;
    lt.repeat.set(w / 240, d / 240);
    const geo = round ? new THREE.CircleGeometry(h.r, 40) : new THREE.PlaneGeometry(w, d);
    const pool = new THREE.Mesh(geo.rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: acid ? 0.9 : 1.3, roughness: 0.3 }));
    const cx = round ? h.x : (h.x0 + h.x1) / 2;
    const cz = round ? h.y : (h.y0 + h.y1) / 2;
    pool.position.set(cx, h.z + 0.6, cz);
    scene.add(pool);
    ctx.lava.push(lt);
    if (acid) {
      // A dark rim of turned earth round the grave.
      const rim = new THREE.Mesh(new THREE.PlaneGeometry(w + 18, d + 18).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 }));
      rim.position.set(cx, h.z + 0.3, cz);
      rim.receiveShadow = true;
      scene.add(rim);
      glows.push({ x: cx, y: h.z + 4, z: cz, w, d });
    }
  }

  for (const p of map.boostPads) ctx.pads.push(boostPad(scene, p));
  const pads = map.pads.map((p) => buildPad(scene, p));
  const bumpers = map.bumpers.map((b) => (theme.pumpkins ? buildPumpkin(scene, b, S) : b.style === 'tyres' ? buildTyres(scene, b) : buildBumper(scene, b)));
  const movers = map.movers.map((m) => (dress && dress.mover(m)) || buildMover(scene, map, m, kit));
  const flames = []; // braziers: flames come off them in ambient()
  if (bright) {
    const out = (min, max = Infinity) => (x, z) => {
      const d = Math.max(Math.max(-x, 0, x - S), Math.max(-z, 0, z - S));
      return d > min && d < max;
    };
    decorate(scene, map, theme, ctx, { minX: -1600, maxX: S + 1600, minY: -1600, maxY: S + 1600 }, out, 0);
  } else addScenery(scene, map, theme, ctx, kit, flames);

  const moon = theme.moon ? addMoon(scene) : null;
  // Craters with lava in them (the pool's radius: where the ground dips under the lava).
  const craters = map.liquid && map.liquid.kind === 'lava' && map.terrain ? (map.terrain.craters || []).map((c) => {
    let pool = 0;
    for (let r = 0; r < c.r; r += 8) if (map.land.at(c.x + r, c.y) < map.liquid.z) pool = r;
    return { x: c.x, y: c.y, z: map.liquid.z, pool };
  }) : [];
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  let wispT = 0;
  return {
    roofs,
    // Particles the scenery gives off near the camera: acid fizzing, wisps drifting over the graves.
    ambient(dt, cam, fire, smoke) {
      if (moon) moon.position.set(cam.x - 5200, cam.y + 4200, cam.z - 6400);
      // A lava crater spits embers up off its surface.
      for (const c of craters) {
        if (Math.hypot(c.x - cam.x, c.y - cam.z) > 2200 || Math.random() > dt * 24) continue;
        const a = Math.random() * TAU;
        const r = Math.random() * c.pool;
        fire.emit(c.x + Math.cos(a) * r, c.z + 2, c.y + Math.sin(a) * r, (Math.random() - 0.5) * 30, 60 + Math.random() * 90, (Math.random() - 0.5) * 30,
          FLAME_COLS[Math.floor(Math.random() * 3)], 4 + Math.random() * 4, 1.1, { drag: 0.6, rise: 20 });
      }
      for (const f of flames) {
        if (Math.abs(f.x - cam.x) > 1400 || Math.abs(f.z - cam.z) > 1400) continue;
        f.acc = (f.acc || 0) + dt * 40;
        for (; f.acc >= 1; f.acc--) {
          fire.emit(f.x + (Math.random() - 0.5) * 14, f.y, f.z + (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 10, 40 + Math.random() * 35, (Math.random() - 0.5) * 10,
            FLAME_COLS[Math.floor(Math.random() * 3)], 5 + Math.random() * 5, 0.4, { grow: -0.6, drag: 1 });
        }
        if (Math.random() < dt * 3) smoke.emit(f.x, f.y + 30, f.z, 0, 40, 0, SMOKE_COL, 12, 1.6, { alpha: 0.22, grow: 1.6, rise: 10 });
      }
      for (const g of glows) {
        if (Math.abs(g.x - cam.x) > 1600 || Math.abs(g.z - cam.z) > 1600 || Math.random() > dt * 10) continue;
        fire.emit(g.x + (Math.random() - 0.5) * g.w * 0.8, g.y, g.z + (Math.random() - 0.5) * g.d * 0.8, 0, 20 + Math.random() * 30, 0,
          ACID_COLS[Math.floor(Math.random() * 3)], 3 + Math.random() * 3, 0.7, { drag: 1, rise: 30 });
      }
      if (theme.wisps) {
        wispT -= dt;
        if (wispT <= 0) {
          wispT = MOBILE ? 0.5 : 0.22;
          const a = Math.random() * TAU;
          const r = 200 + Math.random() * 900;
          const x = cam.x + Math.cos(a) * r;
          const z = cam.z + Math.sin(a) * r;
          const y = (map.land ? map.land.at(x, z) : 0) + 20 + Math.random() * 60;
          fire.emit(x, y, z, (Math.random() - 0.5) * 30, 6 + Math.random() * 10, (Math.random() - 0.5) * 30, WISP_COLS[Math.floor(Math.random() * 2)], 9 + Math.random() * 6, 4, { drag: 0.2, rise: 4 });
        }
      }
    },
    // t: the game clock (where the movers are); focus: {x, y, z} of the kart the camera follows.
    update(t, dt, focus, camera) {
      for (const m of movers) m.update(t);
      dress?.update(t, dt);
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
  if (m.type === 'sweeper') return map.theme === 'graveyard' ? buildScythe(scene, m) : buildSweeper(scene, m);
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
    const bell = map.theme === 'graveyard';
    const ball = bell ? bellMesh(m.r) : new THREE.Mesh(new THREE.IcosahedronGeometry(m.r, 1), iron);
    for (let i = 0; i < (bell ? 0 : 12); i++) {
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
        if (bell) {
          // Hang along the chain, swinging with it.
          if (m.axis === 'y') ball.rotation.set(-b.th, 0, 0); else ball.rotation.set(0, 0, b.th);
        } else ball.rotation.y = t * 2;
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

// A church bell (bronze, a clapper inside), sized to swing like a pendulum ball of radius r.
function bellMesh(r) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12; // top to lip
    const rad = r * (0.38 + 0.5 * u * u + 0.32 * Math.max(0, u - 0.82) / 0.18);
    pts.push(new THREE.Vector2(rad, r * (0.9 - 1.9 * u)));
  }
  const bronze = new THREE.MeshStandardMaterial({ color: 0xc9a066, emissive: 0x3a2508, emissiveIntensity: 0.4, roughness: 0.35, metalness: 0.4, side: THREE.DoubleSide });
  const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), bronze);
  const crown = new THREE.Mesh(new THREE.TorusGeometry(r * 0.22, r * 0.07, 6, 12), bronze);
  crown.position.y = r * 0.98;
  const clapper = new THREE.Mesh(new THREE.SphereGeometry(r * 0.2, 10, 8), new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.8, roughness: 0.4 }));
  clapper.position.y = -r * 0.85;
  bell.add(crown, clapper);
  bell.castShadow = true;
  return bell;
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
      const boss = new THREE.Mesh(new THREE.SphereGeometry(h * 0.35, 12, 8), new THREE.MeshStandardMaterial({ color: 0xfacc15, emissive: 0x6a4500, emissiveIntensity: 0.4, roughness: 0.35, metalness: 0.3 }));
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

// The reaper's scythe: an iron post with two long arms, a curved blade on the end of each.
function buildScythe(scene, m) {
  const g = new THREE.Group();
  const iron = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.4, metalness: 0.8 });
  const blade = new THREE.MeshStandardMaterial({ color: 0xc9d2e3, roughness: 0.2, metalness: 0.95, emissive: 0x334466, emissiveIntensity: 0.35 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(m.hub * 0.55, m.hub * 0.8, m.hi + 40, 10), iron);
  post.position.y = (m.hi + 40) / 2;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(m.hub * 0.6, 14, 10), new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.6 }));
  skull.position.y = m.hi + 44;
  skull.scale.set(1, 0.9, 1.1);
  post.castShadow = true;
  const spin = new THREE.Group();
  for (let i = 0; i < m.arms; i++) {
    const arm = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, m.len - m.hub + 10, 8).rotateZ(Math.PI / 2), iron);
    pole.position.x = (m.len + m.hub) / 2;
    pole.castShadow = true;
    // The blade: a flat crescent sweeping forward (the way it turns) from the end of the pole.
    const crescent = new THREE.Mesh(new THREE.TorusGeometry(46, 4.5, 4, 20, Math.PI * 0.62), blade);
    crescent.scale.set(1, 1, 0.35);
    crescent.rotation.set(Math.PI / 2, 0, Math.PI * 1.02);
    crescent.position.set(m.len - 2, 0, -46 * Math.sign(m.speed || 1));
    crescent.castShadow = true;
    arm.add(pole, crescent);
    arm.rotation.y = -(i * TAU) / m.arms;
    spin.add(arm);
  }
  spin.position.y = (m.lo + m.hi) / 2;
  g.add(post, skull, spin);
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

// ---------- the graveyard's own pieces ----------
const ACID_COLS = [new THREE.Color(0xa3e635), new THREE.Color(0xd9f99d), new THREE.Color(0x65a30d)];
const WISP_COLS = [new THREE.Color(0x7dd3fc), new THREE.Color(0xa7f3d0)];
const FLAME_COLS = [new THREE.Color(0xffd166), new THREE.Color(0xff8c1a), new THREE.Color(0xff4d00)];
const SMOKE_COL = new THREE.Color(0x3a3440);

// The rolling ground: one mesh straight off the physics grid (so the wheels sit where they should),
// a little darker in the hollows.
function buildLand(scene, map, kit) {
  const land = map.land;
  const n = land.n;
  const c = land.cell;
  const T = (kit.grass || kit.ground).top[2];
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const col = new Float32Array(n * n * 3);
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of land.h) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = land.h[k];
      pos.set([i * c, h, j * c], k * 3);
      uv.set([(i * c) / T, (j * c) / T], k * 2);
      const f = 0.72 + 0.4 * ((h - lo) / (hi - lo || 1));
      col.set([f, f, f], k * 3);
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = material((kit.grass || kit.ground).top).clone();
  mat.vertexColors = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  // A paved plaza over the first levelled spot (where the big building stands).
  const flat = map.terrain && map.terrain.flats && map.terrain.flats[0];
  if (flat && map.theme === 'graveyard') {
    const r = flat.r * 0.74;
    const ft = texture('flag', '#4a4752').clone();
    ft.needsUpdate = true;
    ft.repeat.set((r * 2) / 170, (r * 2) / 170);
    const alpha = canvasTexture(128, 128, (cc, w, h) => {
      const g = cc.createRadialGradient(w / 2, h / 2, w * 0.36, w / 2, h / 2, w / 2);
      g.addColorStop(0, '#fff'); g.addColorStop(1, '#000');
      cc.fillStyle = g; cc.fillRect(0, 0, w, h);
    }, false);
    const paving = new THREE.Mesh(new THREE.CircleGeometry(r, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: ft, alphaMap: alpha, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 }));
    paving.position.set(flat.x, flat.z + 0.4, flat.y);
    paving.receiveShadow = true;
    paving.renderOrder = 1;
    scene.add(paving);
  }
}

// Headstones: a slab with a rounded top, a little askew, the broad face across its block's long side.
function buildTombs(scene, map, list) {
  const geos = [];
  const r = rng(17);
  for (const s of list) {
    const alongX = s.x1 - s.x0 >= s.y1 - s.y0;
    const w = alongX ? s.x1 - s.x0 : s.y1 - s.y0;
    const d = alongX ? s.y1 - s.y0 : s.x1 - s.x0;
    const cx = (s.x0 + s.x1) / 2;
    const cy = (s.y0 + s.y1) / 2;
    const g0 = map.land ? map.land.at(cx, cy) : s.z0;
    const body = s.z1 - g0 - w / 2;
    const slab = new THREE.BoxGeometry(w, body + 8, d);
    slab.translate(0, (body + 8) / 2 - 8, 0);
    const top = new THREE.CylinderGeometry(w / 2, w / 2, d, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
    top.translate(0, body, 0);
    // Both pieces take the grave texture across their face.
    for (const g of [slab, top]) {
      const p = g.attributes.position;
      const uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, (p.getY(i) + 8) / (body + w / 2 + 8));
    }
    const g = mergeGeometries([slab.toNonIndexed(), top.toNonIndexed()]);
    g.rotateZ((r() - 0.5) * 0.12);
    g.rotateY((alongX ? 0 : Math.PI / 2) + (r() - 0.5) * 0.18);
    g.translate(cx, g0, cy);
    geos.push(g);
  }
  const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ map: texture('grave'), roughness: 0.95 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Wrought iron railings: spear-topped bars that follow the ground, two rails, a post at each end.
function buildFences(scene, map, list) {
  const bars = [];
  const iron = new THREE.MeshStandardMaterial({ color: 0x23232b, roughness: 0.45, metalness: 0.7 });
  const H = 40;
  const ground = (x, y) => (map.land ? map.land.at(x, y) : 0);
  for (const s of list) {
    const alongX = s.x1 - s.x0 >= s.y1 - s.y0;
    const len = alongX ? s.x1 - s.x0 : s.y1 - s.y0;
    const cx = (s.x0 + s.x1) / 2;
    const cy = (s.y0 + s.y1) / 2;
    const n = Math.max(2, Math.round(len / 9));
    for (let i = 0; i <= n; i++) {
      const u = -len / 2 + (len * i) / n;
      const x = alongX ? cx + u : cx;
      const y = alongX ? cy : cy + u;
      const g = ground(x, y);
      const post = i === 0 || i === n;
      bars.push(new THREE.BoxGeometry(post ? 6 : 2.2, H + (post ? 6 : 0), post ? 6 : 2.2).translate(x, g + (H + (post ? 6 : 0)) / 2 - 4, y));
      bars.push(new THREE.ConeGeometry(post ? 5 : 2.6, post ? 8 : 7, 4).translate(x, g + H + (post ? 10 : 2), y));
    }
    for (const hgt of [8, 32]) {
      const a = alongX ? [s.x0, cy] : [cx, s.y0];
      const b = alongX ? [s.x1, cy] : [cx, s.y1];
      const ga = ground(a[0], a[1]) + hgt;
      const gb = ground(b[0], b[1]) + hgt;
      const rail = new THREE.BoxGeometry(len, 2.4, 2.4);
      rail.rotateZ(Math.atan2(gb - ga, len));
      if (!alongX) rail.rotateY(Math.PI / 2);
      rail.translate(cx, (ga + gb) / 2, cy);
      bars.push(rail);
    }
  }
  const mesh = new THREE.Mesh(mergeGeometries(bars.map((g) => (g.index ? g.toNonIndexed() : g))), iron);
  mesh.castShadow = true;
  scene.add(mesh);
}

// A pumpkin bumper: ribbed and orange, a stalk on top, a grinning face lit from inside (towards the
// middle of the arena). It glows hot when someone bounces off it.
function buildPumpkin(scene, b, S) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 28, 16);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i); const y = p.getY(i); const z = p.getZ(i);
    const k = 1 - 0.07 * Math.abs(Math.cos(Math.atan2(z, x) * 5));
    p.setXYZ(i, x * k, y * (0.78 - 0.08 * Math.abs(Math.cos(Math.atan2(z, x) * 5))), z * k);
  }
  geo.computeVertexNormals();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.55, emissive: 0x7c2d12, emissiveIntensity: 0.25 });
  const body = new THREE.Mesh(geo, skinMat);
  body.scale.set(b.r * 1.05, b.r * 1.05, b.r * 1.05);
  body.position.y = b.r * 0.78;
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(3, 4.5, 12, 6), new THREE.MeshStandardMaterial({ color: 0x3f6212, roughness: 0.8 }));
  stalk.position.y = b.r * 1.6;
  stalk.rotation.z = 0.25;
  const faceMat = new THREE.MeshBasicMaterial({ map: texture('pumpkinFace'), transparent: true, depthWrite: false, color: 0xffb020 });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(b.r * 1.3, b.r * 1.3), faceMat);
  const a = Math.atan2(S / 2 - b.y, S / 2 - b.x);
  face.position.set(Math.cos(a) * b.r * 1.02, b.r * 0.82, Math.sin(a) * b.r * 1.02);
  face.rotation.y = Math.PI / 2 - a;
  for (const m of [body, stalk]) { m.castShadow = true; g.add(m); }
  g.add(face);
  g.position.set(b.x, b.z, b.y);
  scene.add(g);
  let flash = 0;
  return {
    hit() { flash = 1; },
    update(dt) {
      flash = Math.max(0, flash - dt * 3);
      const sq = 1 + Math.sin(flash * Math.PI) * 0.16;
      g.scale.set(sq, 2 - sq, sq);
      skinMat.emissiveIntensity = 0.25 + flash * 1.5;
      faceMat.color.setRGB(1, 0.69 + flash * 0.3, 0.13 + flash * 0.6);
    },
  };
}

// The moon: a big pale disc with a soft halo, kept far off in the same direction from the camera.
function addMoon(scene) {
  const t = canvasTexture(256, 256, (c, w, h) => {
    const halo = c.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w / 2);
    halo.addColorStop(0, 'rgba(220,230,255,0.55)'); halo.addColorStop(1, 'rgba(160,170,255,0)');
    c.fillStyle = halo; c.fillRect(0, 0, w, h);
    const disc = c.createRadialGradient(w * 0.45, h * 0.42, 4, w / 2, h / 2, w * 0.2);
    disc.addColorStop(0, '#fffdf2'); disc.addColorStop(1, '#d9dcf0');
    c.fillStyle = disc; c.beginPath(); c.arc(w / 2, h / 2, w * 0.2, 0, TAU); c.fill();
    c.fillStyle = 'rgba(150,155,185,0.35)';
    for (const [x, y, r] of [[0.46, 0.44, 0.04], [0.55, 0.53, 0.03], [0.5, 0.58, 0.02], [0.42, 0.54, 0.025]]) { c.beginPath(); c.arc(w * x, h * y, w * r, 0, TAU); c.fill(); }
  }, false);
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, fog: false, depthWrite: false, transparent: true }));
  moon.scale.set(2600, 2600, 1);
  moon.renderOrder = -1;
  scene.add(moon);
  return moon;
}

// A lantern: on a post, or (mounted high) on a wall; a warm glow round it.
function addLantern(scene, x, y, z, ground, light) {
  const g = new THREE.Group();
  const iron = new THREE.MeshStandardMaterial({ color: 0x1f1f25, roughness: 0.5, metalness: 0.7 });
  const onPost = z - ground < 20;
  if (onPost) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, 64, 6), iron);
    post.position.y = 32;
    g.add(post);
  }
  const top = onPost ? 64 : 0;
  const cage = new THREE.Mesh(new THREE.CylinderGeometry(5, 6.5, 14, 6), new THREE.MeshStandardMaterial({ color: 0xffcf6b, emissive: 0xffa630, emissiveIntensity: 2.2, roughness: 0.3 }));
  cage.position.y = top + 9;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(8, 7, 6), iron);
  cap.position.y = top + 19;
  g.add(cage, cap);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.spark(), color: 0xffb347, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
  glow.scale.set(60, 60, 1);
  glow.position.y = top + 9;
  g.add(glow);
  if (light) {
    const l = new THREE.PointLight(0xffb15a, 2.2, 420, 1.6);
    l.position.y = top + 9;
    g.add(l);
  }
  g.position.set(x, onPost ? ground : z, y);
  scene.add(g);
}

// ---------- scenery ----------
function addPalisade(scene, S, railings) {
  if (railings) {
    // Wrought iron: spear-topped bars all round, with a stone pier every so often.
    const step = 12;
    const per = Math.ceil(S / step);
    const barGeo = mergeGeometries([new THREE.BoxGeometry(2.4, 62, 2.4).translate(0, 31, 0), new THREE.ConeGeometry(3, 9, 4).translate(0, 66, 0)]);
    const bars = new THREE.InstancedMesh(barGeo, new THREE.MeshStandardMaterial({ color: 0x23232b, roughness: 0.45, metalness: 0.7 }), per * 4);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < per; i++) {
      const a = i * step + step / 2;
      for (const [x, z] of [[a, 22], [a, S - 22], [22, a], [S - 22, a]]) { m4.makeTranslation(x, 0, z); bars.setMatrixAt(n++, m4); }
    }
    bars.count = n;
    bars.castShadow = true;
    scene.add(bars);
    const piers = new THREE.InstancedMesh(new THREE.BoxGeometry(26, 80, 26).translate(0, 40, 0), new THREE.MeshStandardMaterial({ map: texture('ashlar', '#5d5a68', '#2b2933'), roughness: 0.9 }), 64);
    let p = 0;
    for (let a = 0; a <= S; a += 400) {
      for (const [x, z] of [[a, 22], [a, S - 22], [22, a], [S - 22, a]]) { if (p < 64) { m4.makeTranslation(x, 0, z); piers.setMatrixAt(p++, m4); } }
    }
    piers.count = p;
    piers.castShadow = true;
    scene.add(piers);
    return;
  }
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

function addScenery(scene, map, theme, ctx, kit, flames) {
  const S = map.size;
  const r = rng(7);
  let lights = 0;
  for (const d of map.deco || []) {
    if (d.kind === 'brazier') {
      const g = new THREE.Group();
      const stone = new THREE.MeshStandardMaterial({ map: texture('ashlar', '#6b6876', '#34313d'), roughness: 0.9 });
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(12, 16, 34, 10), stone);
      foot.position.y = 17;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(20, 11, 12, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.4, metalness: 0.8, side: THREE.DoubleSide }));
      bowl.position.y = 40;
      const coals = new THREE.Mesh(new THREE.CircleGeometry(18, 12).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2b0d05, emissive: 0xff5a1a, emissiveIntensity: 1.6 }));
      coals.position.y = 43;
      const light = new THREE.PointLight(0xff8a3d, 2.6, 520, 1.5);
      light.position.y = 70;
      for (const m of [foot, bowl]) m.castShadow = true;
      g.add(foot, bowl, coals, light);
      g.position.set(d.x, d.z, d.y);
      scene.add(g);
      flames.push({ x: d.x, y: d.z + 46, z: d.y });
      continue;
    }
    if (d.kind === 'arch') {
      // A stone frame round a doorway: two jambs and a round arch over the opening.
      const stone = material(kit.pillar ? kit.pillar.side : kit.stone.side);
      const g = new THREE.Group();
      for (const sd of [-1, 1]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(18, d.h, 14), stone);
        jamb.position.set(sd * (d.w / 2 + 9), d.h / 2, 0);
        jamb.castShadow = true;
        g.add(jamb);
      }
      const arch = new THREE.Mesh(new THREE.TorusGeometry(d.w / 2 + 9, 9, 6, 20, Math.PI), stone);
      arch.position.y = d.h;
      arch.castShadow = true;
      g.add(arch);
      g.position.set(d.x, d.z || 0, d.y);
      g.rotation.y = d.angle || 0;
      scene.add(g);
      continue;
    }
    if (d.kind === 'lantern') {
      const ground = map.land ? map.land.at(d.x, d.y) : 0;
      // A few of them really light things up (the ones on the big building); the rest just glow.
      addLantern(scene, d.x, d.y, d.z, ground, d.z - ground > 20 && lights++ < 4);
      continue;
    }
    if (d.kind === 'crown') {
      // There's no environment map to reflect, so a mostly metal gold would come out brown.
      const gold = new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0x9a6a00, emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.35 });
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
