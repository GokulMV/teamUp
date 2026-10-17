// Kart Battle minimap: a north-up course map that floats over the 3D view (no panel, no frame).
// Race tracks are a white road with an ink outline and the world's curb colour; arenas are a
// floor plan in their own palette. Rivals are badges in their kart colour that point where they
// are heading; you are the chevron inside the site's accent-gradient ring.
//   const mm = KartMinimap.create(canvas, map, { theme, cssSize, dpr, curb, night });
//   mm.draw({ karts: [{ x, y, angle, color, me, dead, place }], boxes, deaths: [{ x, y, color, age }], comets: [{ x, y }], time });
// The static art is drawn once into an offscreen layer; draw() is one blit plus the markers.
(function () {
  const TAU = Math.PI * 2;
  const INK = '#120e24';
  const ACCENT = ['#7c5cff', '#ff4fa3', '#ffb547'];

  // Curb colour per race theme. Unknown themes use opts.curb (the 3D world's curb) or a neutral.
  const RACE = {
    meadow: { curb: '#ef4444' },
    desert: { curb: '#f97316' },
    snow: { curb: '#3b82f6' },
    neon: { curb: '#ff4fd8', glow: 'rgba(255,79,216,0.55)' },
    coast: { curb: '#0ea5e9' }, // Coral Coast
    lava: { curb: '#ef4444', glow: 'rgba(255,90,26,0.6)' }, // Lava Peak
  };
  const RACE_NEUTRAL = { curb: '#a69fcc' };
  // Arena floors stay dark so the player badges pop; the wall is a thin line in the floor's hue.
  const ARENA = {
    arena: { floor: ['#4d4236', '#3a3129'], line: 'rgba(255,232,205,0.32)', corners: true }, // the Colosseum's sand, darkened
    volcano: { floor: ['#33271f', '#221a16'], line: 'rgba(255,200,170,0.22)', cracks: true },
  };
  const ARENA_NEUTRAL = { floor: ['#343852', '#25283c'], line: 'rgba(220,220,255,0.26)' };
  // Layered arenas: each kind of solid in its own muted colour, lighter the higher it stands.
  const LAYER_KINDS = {
    grass: '#3d6a33', ground: '#3d6a33', courtyard: '#5b564e', wall: '#8b8576', merlon: '#a29c8c', gate: '#8b8576',
    bridge: '#7a5432', keep: '#958c7b', roof: '#70737b', tent: '#a83430', crate: '#946030', stair: '#857c6c',
    tower: '#a39885', pillar: '#958c7b', stone: '#7d7a72',
    crypt: '#4c4959', gallery: '#5f5b6c', slate: '#3b4053', tomb: '#8d8d93', fence: '#1d1d24', deadtree: '#3d3530',
    deck: '#7a5432', terrace: '#4a7a3e', column: '#958c7b',
  };
  // The weekly arena's looks paint the same kinds their own colours.
  const THEME_KINDS = {
    graveyard: { ground: '#2c3a2c', terrace: '#3a4a38', stone: '#56536a', tower: '#5f5b6c', wall: '#4c4959', merlon: '#5f5b6c', column: '#6b6876', pillar: '#6b6876' },
    ruins: { ground: '#c8a06a', terrace: '#d9b27c', stone: '#a87a48', tower: '#b4844f', wall: '#9a6e40', merlon: '#bd8d58', stair: '#b98a57', column: '#bd8d58', pillar: '#bd8d58' },
    glacier: { ground: '#d5e0eb', terrace: '#e8f0f7', stone: '#8eacc4', tower: '#9fbbd2', wall: '#7f9db6', merlon: '#9fbbd2', stair: '#94b1c8', column: '#9fbbd2', pillar: '#9fbbd2' },
    basalt: { ground: '#2f2826', terrace: '#3d3532', stone: '#6c5c59', tower: '#76696a', wall: '#5c4e4c', merlon: '#7d6d6b', stair: '#7d6d6b', column: '#6c5c59', pillar: '#6c5c59' },
  };
  // Rolling ground, low to high (layered arenas with hills).
  const LAND = { grass: ['#1d2a1f', '#3c5236'] };
  const LAYER_LIQUID = { water: '#25596a', lava: '#a2381a' };

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // ctx.roundRect is missing on older Safari.
  function roundRectPath(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // Colours arrive as '#fff', 'red', 'hsl(...)' or team colours: normalise through a canvas.
  const rgbCache = new Map();
  let probe = null;
  function rgb(color) {
    let v = rgbCache.get(color);
    if (v) return v;
    probe = probe || document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#ffffff';
    probe.fillStyle = String(color || '#ffffff');
    const f = probe.fillStyle;
    v = f[0] === '#' ? [1, 3, 5].map((i) => parseInt(f.slice(i, i + 2), 16)) : (f.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
    rgbCache.set(color, v);
    return v;
  }
  const rgba = (color, a) => { const [r, g, b] = rgb(color); return `rgba(${r},${g},${b},${a})`; };
  const lighten = (color, amt) => { const [r, g, b] = rgb(color); const f = (v) => Math.round(v + (255 - v) * amt); return `rgb(${f(r)},${f(g)},${f(b)})`; };

  function create(canvas, map, opts = {}) {
    const css = Math.max(40, Math.round(opts.cssSize || canvas.clientWidth || 168));
    const dpr = Math.max(1, Math.min(3, opts.dpr || window.devicePixelRatio || 1));
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    const ctx = canvas.getContext('2d');
    const k = Math.max(0.68, Math.min(1.25, css / 168)); // UI scale for the phone-size map
    const race = map.type === 'race';
    const theme = opts.theme || map.theme;

    // ----- fit: the drivable road or the arena floor, never the padded physics bounds -----
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    if (race) {
      const h = map.width / 2;
      for (const [x, y] of map.centerline) {
        minX = Math.min(minX, x - h); maxX = Math.max(maxX, x + h);
        minY = Math.min(minY, y - h); maxY = Math.max(maxY, y + h);
      }
    } else if (map.layered) {
      minX = 0; minY = 0; maxX = map.size; maxY = map.size;
    } else {
      minX = 40; minY = 40; maxX = map.size - 40; maxY = map.size - 40;
    }
    // Arenas are a square floor plan: kept a little smaller so they never dominate the corner.
    const margin = race ? 9 * k : css * 0.075;
    const s = (css - margin * 2) / Math.max(maxX - minX, maxY - minY, 1);
    const ox = (css - (maxX - minX) * s) / 2 - minX * s;
    const oy = (css - (maxY - minY) * s) / 2 - minY * s;
    const X = (x) => ox + x * s;
    const Y = (y) => oy + y * s;

    // ----- static layer -----
    const layer = document.createElement('canvas');
    layer.width = canvas.width;
    layer.height = canvas.height;
    const g = layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    let roadW = 0;
    if (race) roadW = drawRace(g);
    else if (map.layered) drawLayered(g);
    else drawArena(g);

    function drawRace(c) {
      const th = RACE[theme] || { curb: opts.curb || RACE_NEUTRAL.curb, glow: opts.night ? rgba(opts.curb || RACE_NEUTRAL.curb, 0.55) : null };
      const w = Math.max(5 * Math.min(1, k + 0.15), Math.min(11, map.width * s * 0.62));
      const ow = 1.5 * k; // ink outline each side
      const cw = 1.1 * k; // curb each side
      const road = new Path2D();
      map.centerline.forEach(([x, y], i) => (i ? road.lineTo(X(x), Y(y)) : road.moveTo(X(x), Y(y))));
      road.closePath();
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)';
      c.shadowBlur = 8 * dpr * k;
      c.shadowOffsetY = 2 * dpr * k;
      c.strokeStyle = INK; c.lineWidth = w + (ow + cw) * 2; c.stroke(road);
      c.restore();
      const layers = (path) => {
        c.strokeStyle = INK; c.lineWidth = w + (ow + cw) * 2; c.stroke(path);
        if (th.glow) { c.save(); c.shadowColor = th.glow; c.shadowBlur = 6 * dpr * k; }
        c.strokeStyle = th.curb; c.lineWidth = w + cw * 2; c.stroke(path);
        if (th.glow) c.restore();
        c.strokeStyle = '#f6f5fc'; c.lineWidth = w; c.stroke(path);
      };
      layers(road);
      c.save();
      c.setLineDash([2.2 * k, 2.8 * k]);
      c.strokeStyle = 'rgba(18,14,36,0.14)'; c.lineWidth = 0.8 * k; c.stroke(road);
      c.restore();
      // Overpasses: a stretch of road above another one is redrawn on top of it.
      for (const run of bridges()) {
        const p = new Path2D();
        run.forEach((i, j) => { const [x, y] = map.centerline[i]; if (j) p.lineTo(X(x), Y(y)); else p.moveTo(X(x), Y(y)); });
        c.save();
        c.lineCap = 'butt';
        c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 4 * dpr * k;
        layers(p);
        c.restore();
      }
      // Checkered start line across the road at centerline[0].
      const [px, py] = map.centerline[0];
      const [tx, ty] = map.tangents[0];
      const across = w + cw * 2;
      const cell = across / 4;
      c.save();
      c.translate(X(px), Y(py));
      c.rotate(Math.atan2(ty, tx));
      c.fillStyle = INK;
      c.fillRect(-cell - 0.6 * k, -across / 2 - 0.6 * k, cell * 2 + 1.2 * k, across + 1.2 * k);
      for (let r = 0; r < 2; r++) {
        for (let i = 0; i < 4; i++) {
          c.fillStyle = (r + i) % 2 ? '#111' : '#fff';
          c.fillRect(-cell + r * cell, -across / 2 + i * cell, cell, cell);
        }
      }
      c.restore();
      for (const p of map.boostPads || []) padChevron(c, X(p.x), Y(p.y), p.angle, 2.4 * k);
      return w;
    }

    // Runs of centerline samples that pass over another part of the track (needs map.heightAt).
    function bridges() {
      if (typeof map.heightAt !== 'function') return [];
      const n = map.centerline.length;
      let h;
      try { h = map.centerline.map(([x, y], i) => map.heightAt(x, y, i) || 0); } catch { return []; }
      const near = (map.width * 0.9) ** 2;
      const upper = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        const [xi, yi] = map.centerline[i];
        for (let j = 0; j < n; j++) {
          const gap = Math.min(Math.abs(i - j), n - Math.abs(i - j));
          if (gap < 12 || h[i] - h[j] < 30) continue;
          const [xj, yj] = map.centerline[j];
          if ((xi - xj) ** 2 + (yi - yj) ** 2 < near) { upper[i] = true; break; }
        }
      }
      const runs = [];
      for (let i = 0; i < n; i++) {
        if (!upper[i] || upper[(i - 1 + n) % n]) continue;
        const run = [];
        for (let o = -4; o < n; o++) {
          const j = (i + o + n) % n;
          if (o > 0 && !upper[j] && !upper[(j - 4 + n) % n]) break;
          run.push(j);
        }
        runs.push(run);
      }
      return runs;
    }

    function drawArena(c) {
      const th = ARENA[theme] || ARENA_NEUTRAL;
      const S = map.size;
      const fx = X(40); const fy = Y(40); const fw = (S - 80) * s;
      const rad = 7 * k;
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)';
      c.shadowBlur = 10 * dpr * k; c.shadowOffsetY = 3 * dpr * k;
      const fg = c.createLinearGradient(0, fy, 0, fy + fw);
      fg.addColorStop(0, rgba(th.floor[0], 0.9)); fg.addColorStop(1, rgba(th.floor[1], 0.9));
      c.fillStyle = fg;
      roundRectPath(c, fx, fy, fw, fw, rad); c.fill();
      c.restore();
      c.save();
      roundRectPath(c, fx, fy, fw, fw, rad); c.clip();
      const pool = c.createRadialGradient(X(S / 2), Y(S / 2), fw * 0.1, X(S / 2), Y(S / 2), fw * 0.75);
      pool.addColorStop(0, 'rgba(255,255,255,0.06)'); pool.addColorStop(1, 'rgba(0,0,0,0.18)');
      c.fillStyle = pool; c.fillRect(fx, fy, fw, fw);
      if (th.corners) {
        // Team corner pads and the painted rings of the real floor, kept quiet.
        ['#ef4444', '#3b82f6', '#22c55e', '#eab308'].forEach((col, i) => {
          c.fillStyle = rgba(col, 0.1);
          c.beginPath(); c.arc(X(i % 2 ? S : 0), Y(i > 1 ? S : 0), (190 / 1024) * S * s, 0, TAU); c.fill();
        });
        c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 0.9 * k;
        c.beginPath(); c.arc(X(S / 2), Y(S / 2), (360 / 1024) * S * s, 0, TAU); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 1.1 * k;
        c.beginPath(); c.arc(X(S / 2), Y(S / 2), (210 / 1024) * S * s, 0, TAU); c.stroke();
      }
      if (th.cracks) {
        const r = rng(42);
        c.strokeStyle = 'rgba(255,110,40,0.16)'; c.lineWidth = 0.7 * k;
        for (let i = 0; i < 22; i++) {
          let x = r() * S; let y = r() * S; let a = r() * TAU;
          c.beginPath(); c.moveTo(X(x), Y(y));
          for (let j = 0; j < 4; j++) { a += (r() - 0.5) * 1.6; const l = 60 + r() * 90; x += Math.cos(a) * l; y += Math.sin(a) * l; c.lineTo(X(x), Y(y)); }
          c.stroke();
        }
      }
      map.hazards.forEach((h, i) => lava(c, X(h.x), Y(h.y), h.r * s, 31 + i * 7));
      map.obstacles.forEach((o, i) => obstacle(c, o, X(o.x), Y(o.y), i));
      c.restore();
      c.strokeStyle = th.line; c.lineWidth = 1.2 * k;
      roundRectPath(c, fx + 0.6 * k, fy + 0.6 * k, fw - 1.2 * k, fw - 1.2 * k, rad - 0.6 * k); c.stroke();
    }

    // A layered arena: the moat (or the void), then every solid by height, lowest first, each with
    // a soft drop shadow so decks, walls and towers read as standing above what's below them.
    function drawLayered(c) {
      const S = map.size;
      const tops = map.solids.map((sd) => sd.z1);
      const lo = Math.min(0, ...tops);
      const hi = Math.max(...tops);
      const fx = X(0); const fy = Y(0); const fw = S * s;
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 10 * dpr * k; c.shadowOffsetY = 3 * dpr * k;
      c.fillStyle = map.liquid ? LAYER_LIQUID[map.liquid.kind] || LAYER_LIQUID.water : '#0d0b1a';
      roundRectPath(c, fx, fy, fw, fw, 7 * k); c.fill();
      c.restore();
      c.save();
      roundRectPath(c, fx, fy, fw, fw, 7 * k); c.clip();
      if (map.land) {
        // The hills, shaded by height from a small image of the height grid.
        const L = map.land;
        const img = document.createElement('canvas');
        img.width = L.n; img.height = L.n;
        const ic = img.getContext('2d');
        const data = ic.createImageData(L.n, L.n);
        let hlo = Infinity; let hhi = -Infinity;
        for (const h of L.h) { hlo = Math.min(hlo, h); hhi = Math.max(hhi, h); }
        const [a, b] = (LAND[L.kind] || LAND.grass).map(rgb);
        for (let i = 0; i < L.h.length; i++) {
          const u = (L.h[i] - hlo) / (hhi - hlo || 1);
          data.data.set([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, 255], i * 4);
        }
        ic.putImageData(data, 0, 0);
        c.imageSmoothingEnabled = true;
        c.drawImage(img, fx, fy, (L.n - 1) * L.cell * s, (L.n - 1) * L.cell * s);
      }
      const palette = THEME_KINDS[map.theme] || {};
      const colour = (kind, z) => {
        const u = (z - lo) / (hi - lo || 1);
        const [r, gg, b] = rgb(palette[kind] || LAYER_KINDS[kind] || LAYER_KINDS.stone);
        const f = 0.82 + 0.42 * u;
        return `rgb(${Math.min(255, r * f) | 0},${Math.min(255, gg * f) | 0},${Math.min(255, b * f) | 0})`;
      };
      const shape = (sd) => {
        c.beginPath();
        if (sd.type === 2) c.arc(X(sd.x), Y(sd.y), Math.max(1, sd.r * s), 0, TAU);
        else c.rect(X(sd.x0), Y(sd.y0), (sd.x1 - sd.x0) * s, (sd.y1 - sd.y0) * s);
      };
      const solids = map.solids.filter((sd) => sd.kind !== 'bumper' && sd.kind !== 'hub').sort((a, b) => a.z1 - b.z1);
      for (const sd of solids) {
        if (sd.z1 > lo + 20) {
          c.save();
          c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 2.5 * dpr * k; c.shadowOffsetX = 0.8 * dpr * k; c.shadowOffsetY = 1.2 * dpr * k;
          c.fillStyle = colour(sd.kind, sd.z1); shape(sd); c.fill();
          c.restore();
        }
        if (sd.type === 1) {
          // A ramp: shaded from its foot to its top.
          const lowX = sd.axis ? 0 : sd.sign > 0 ? sd.x0 : sd.x1;
          const lowY = sd.axis ? (sd.sign > 0 ? sd.y0 : sd.y1) : 0;
          const gr = sd.axis ? c.createLinearGradient(0, Y(lowY), 0, Y(sd.sign > 0 ? sd.y1 : sd.y0)) : c.createLinearGradient(X(lowX), 0, X(sd.sign > 0 ? sd.x1 : sd.x0), 0);
          gr.addColorStop(0, colour(sd.kind, sd.zl)); gr.addColorStop(1, colour(sd.kind, sd.zh));
          c.fillStyle = gr;
        } else {
          c.fillStyle = colour(sd.kind, sd.z1);
        }
        shape(sd); c.fill();
      }
      // Drawbridges (drawn down), jump pads with a dash towards where they land, bumpers.
      for (const m of map.movers) {
        if (m.type !== 'drawbridge') continue;
        c.fillStyle = colour('bridge', m.z);
        c.fillRect(X(m.x0), Y(m.y0), (m.x1 - m.x0) * s, (m.y1 - m.y0) * s);
      }
      c.lineCap = 'round';
      for (const p of map.pads) {
        const x = X(p.x); const y = Y(p.y);
        const a = Math.atan2(p.ty - p.y, p.tx - p.x);
        c.strokeStyle = 'rgba(125,211,252,0.55)'; c.lineWidth = 1 * k; c.setLineDash([1.5 * k, 2 * k]);
        c.beginPath(); c.moveTo(x, y); c.lineTo(X(p.tx), Y(p.ty)); c.stroke();
        c.setLineDash([]);
        c.fillStyle = '#7dd3fc';
        c.beginPath(); c.arc(x, y, Math.max(2 * k, p.r * s), 0, TAU); c.fill();
        c.fillStyle = '#0c4a6e';
        c.save(); c.translate(x, y); c.rotate(a);
        c.beginPath(); c.moveTo(2.2 * k, 0); c.lineTo(-1.4 * k, 1.6 * k); c.lineTo(-1.4 * k, -1.6 * k); c.closePath(); c.fill();
        c.restore();
      }
      for (const h of map.hazards) {
        c.fillStyle = h.kind === 'acid' ? '#84cc16' : '#ff6a1a';
        c.beginPath();
        if (h.r !== undefined) c.arc(X(h.x), Y(h.y), Math.max(1.5 * k, h.r * s), 0, TAU);
        else c.rect(X(h.x0), Y(h.y0), Math.max(1.2 * k, (h.x1 - h.x0) * s), Math.max(1.2 * k, (h.y1 - h.y0) * s));
        c.fill();
      }
      for (const b of map.bumpers) {
        c.fillStyle = map.theme === 'graveyard' ? '#f97316' : '#ff4fa3';
        c.beginPath(); c.arc(X(b.x), Y(b.y), Math.max(1.6 * k, b.r * s), 0, TAU); c.fill();
      }
      for (const p of map.boostPads) padChevron(c, X(p.x), Y(p.y), p.angle, 2.2 * k);
      c.restore();
      c.strokeStyle = 'rgba(255,240,220,0.28)'; c.lineWidth = 1.2 * k;
      roundRectPath(c, fx + 0.6 * k, fy + 0.6 * k, fw - 1.2 * k, fw - 1.2 * k, 6.4 * k); c.stroke();
    }

    function lava(c, x, y, r, seed) {
      const glow = c.createRadialGradient(x, y, r * 0.8, x, y, r * 2);
      glow.addColorStop(0, 'rgba(255,106,26,0.32)'); glow.addColorStop(1, 'rgba(255,80,20,0)');
      c.fillStyle = glow;
      c.beginPath(); c.arc(x, y, r * 2, 0, TAU); c.fill();
      blob(c, x, y, r * 1.12, seed, 0.1, 9);
      c.fillStyle = '#2a1712'; c.fill();
      blob(c, x, y, r * 0.94, seed, 0.12, 9);
      const core = c.createRadialGradient(x - r * 0.2, y - r * 0.25, 0, x, y, r);
      core.addColorStop(0, '#ffe7a0'); core.addColorStop(0.35, '#ffb43c'); core.addColorStop(0.8, '#ff6a1a'); core.addColorStop(1, '#d83a0c');
      c.fillStyle = core; c.fill();
    }

    // A smooth irregular closed shape (lava pools).
    function blob(c, cx, cy, rr, seed, wobble, n) {
      const r = rng(seed);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + r() * 0.3;
        const d = rr * (1 + (r() - 0.5) * 2 * wobble);
        pts.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d]);
      }
      const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const m0 = mid(pts[n - 1], pts[0]);
      c.beginPath(); c.moveTo(m0[0], m0[1]);
      for (let i = 0; i < n; i++) { const m = mid(pts[i], pts[(i + 1) % n]); c.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]); }
      c.closePath();
    }

    // Terrain gets a soft lift shadow instead of an ink outline: crisp outlines mean players.
    function obstacle(c, o, x, y, i) {
      const r = Math.max(3.5 * k, o.r * s);
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 3 * k * dpr; c.shadowOffsetY = 1.2 * k * dpr;
      if (o.kind === 'rock') {
        // Faceted boulder lit from the top-left, like the low-poly rocks in 3D.
        const rand = rng(101 + i * 13);
        const pts = [];
        for (let j = 0; j < 7; j++) { const a = (j / 7) * TAU + rand() * 0.5; const d = r * (0.88 + rand() * 0.22); pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d]); }
        c.beginPath(); pts.forEach((p, j) => (j ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath();
        c.fillStyle = '#4a3c36'; c.fill();
        c.shadowColor = 'transparent';
        const ax = x - r * 0.18; const ay = y - r * 0.22;
        for (let j = 0; j < 7; j++) {
          const p = pts[j]; const q = pts[(j + 1) % 7];
          const mx = (p[0] + q[0]) / 2 - x; const my = (p[1] + q[1]) / 2 - y; const ml = Math.hypot(mx, my) || 1;
          const lit = (-mx / ml) * 0.6 + (-my / ml) * 0.8;
          c.fillStyle = `hsl(16, 14%, ${34 + lit * 13}%)`;
          c.beginPath(); c.moveTo(ax, ay); c.lineTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.closePath(); c.fill();
        }
      } else if (o.kind === 'crate') {
        const h = r * 0.95;
        c.translate(x, y); c.rotate(Math.PI / 4);
        c.fillStyle = '#9a6430';
        roundRectPath(c, -h, -h, h * 2, h * 2, 0.6 * k); c.fill();
        c.shadowColor = 'transparent';
        c.fillStyle = '#c48a4a';
        roundRectPath(c, -h * 0.62, -h * 0.62, h * 1.24, h * 1.24, 0.4 * k); c.fill();
      } else {
        // Stone tower / pillar seen from above.
        const gr = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
        gr.addColorStop(0, '#a3abbd'); gr.addColorStop(1, '#5f677b');
        c.fillStyle = gr;
        c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
        c.shadowColor = 'transparent';
        if (o.kind === 'tower') {
          c.strokeStyle = 'rgba(20,22,40,0.35)'; c.lineWidth = 0.8 * k;
          c.beginPath(); c.arc(x, y, r * 0.62, 0, TAU); c.stroke();
          c.fillStyle = '#e8e4f4';
          c.beginPath(); c.arc(x, y, Math.max(1.2 * k, r * 0.16), 0, TAU); c.fill();
        }
      }
      c.restore();
    }

    function padChevron(c, x, y, angle, sz) {
      c.save();
      c.translate(x, y); c.rotate(angle);
      c.strokeStyle = '#06b6d4'; c.lineWidth = sz * 0.55;
      for (const off of [-sz * 0.55, sz * 0.45]) {
        c.beginPath(); c.moveTo(off - sz * 0.5, -sz * 0.75); c.lineTo(off + sz * 0.3, 0); c.lineTo(off - sz * 0.5, sz * 0.75); c.stroke();
      }
      c.restore();
    }

    // ----- markers (drawn around the origin; callers translate) -----
    const badgeR = 4 * k;
    const gradCache = new Map();
    function fillFor(color, r) {
      const key = `${color}|${r}`;
      let gr = gradCache.get(key);
      if (!gr) {
        gr = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
        gr.addColorStop(0, lighten(color, 0.3)); gr.addColorStop(1, color);
        gradCache.set(key, gr);
      }
      return gr;
    }
    // Race rival: a round badge with a pointed tip in its heading.
    function teardrop(r, a) {
      const tip = r * 1.85;
      const t = Math.acos(r / tip);
      ctx.beginPath();
      if (typeof a === 'number' && Number.isFinite(a)) {
        ctx.arc(0, 0, r, a + t, a - t + TAU);
        ctx.lineTo(Math.cos(a) * tip, Math.sin(a) * tip);
        ctx.closePath();
      } else {
        ctx.arc(0, 0, r, 0, TAU);
      }
    }
    function raceBadge(kt) {
      const a = kt.angle;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.save(); ctx.translate(0, 1 * k); teardrop(badgeR + 1.3 * k, a); ctx.fill(); ctx.restore();
      ctx.fillStyle = INK; teardrop(badgeR + 0.9 * k, a); ctx.fill();
      ctx.fillStyle = '#fff'; teardrop(badgeR, a); ctx.fill();
      ctx.fillStyle = fillFor(kt.color, badgeR - 1.2 * k); teardrop(badgeR - 1.2 * k, a); ctx.fill();
    }
    // Arena rival: a notched chevron, because heading is threat direction there.
    function chevron(size, a, fill, stroke, sw) {
      ctx.save();
      ctx.rotate(Number.isFinite(a) ? a : 0);
      ctx.beginPath();
      ctx.moveTo(size * 0.62, 0);
      ctx.lineTo(-size * 0.48, size * 0.46);
      ctx.lineTo(-size * 0.22, 0);
      ctx.lineTo(-size * 0.48, -size * 0.46);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = sw; ctx.strokeStyle = stroke; ctx.stroke();
      ctx.fillStyle = fill; ctx.fill();
      ctx.restore();
    }
    function crown() {
      const w = 3.4 * k; const h = 2.6 * k;
      ctx.beginPath();
      ctx.moveTo(-w, h * 0.5); ctx.lineTo(-w, -h * 0.6); ctx.lineTo(-w * 0.45, -h * 0.05); ctx.lineTo(0, -h);
      ctx.lineTo(w * 0.45, -h * 0.05); ctx.lineTo(w, -h * 0.6); ctx.lineTo(w, h * 0.5); ctx.closePath();
      ctx.lineJoin = 'round'; ctx.lineWidth = 1.6 * k; ctx.strokeStyle = INK; ctx.stroke();
      ctx.fillStyle = '#ffd23f'; ctx.fill();
    }
    let ringGrad = null;
    const meR = 7.2 * k;
    function meMarker(kt) {
      if (!ringGrad) {
        ringGrad = ctx.createLinearGradient(-meR, -meR, meR, meR);
        ringGrad.addColorStop(0, ACCENT[0]); ringGrad.addColorStop(0.5, ACCENT[1]); ringGrad.addColorStop(1, ACCENT[2]);
      }
      const alive = !kt.dead && Number.isFinite(kt.angle);
      ctx.globalAlpha = kt.dead ? 0.45 : 1;
      ctx.save();
      ctx.shadowColor = 'rgba(255,79,163,0.8)'; ctx.shadowBlur = 6 * k * dpr;
      ctx.strokeStyle = ringGrad; ctx.lineWidth = 2.2 * k;
      ctx.beginPath(); ctx.arc(0, 0, meR, 0, TAU); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(12,9,30,0.8)';
      ctx.beginPath(); ctx.arc(0, 0, meR - 1.1 * k, 0, TAU); ctx.fill();
      if (alive) {
        ctx.save();
        ctx.translate(Math.cos(kt.angle) * 0.6 * k, Math.sin(kt.angle) * 0.6 * k);
        chevron(10.5 * k, kt.angle, kt.color, '#fff', 1.4 * k);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    function viewCone(a) {
      const len = 30 * k;
      ctx.save();
      ctx.rotate(a);
      const cone = ctx.createRadialGradient(0, 0, 4 * k, 0, 0, len);
      cone.addColorStop(0, 'rgba(255,255,255,0.38)'); cone.addColorStop(0.5, 'rgba(255,170,215,0.14)'); cone.addColorStop(1, 'rgba(255,79,163,0)');
      ctx.fillStyle = cone;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, len, -0.45, 0.45); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Push overlapping markers a few px apart (start grid, pile-ups) so each one stays readable.
    function spread(pts, minD, maxShift) {
      for (let it = 0; it < 3; it++) {
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const a = pts[i]; const b = pts[j];
            let dx = b.sx - a.sx; let dy = b.sy - a.sy;
            const d = Math.hypot(dx, dy);
            if (d >= minD) continue;
            if (d < 0.01) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
            const push = (minD - Math.max(d, 0.01)) / 2;
            a.sx -= dx * push; a.sy -= dy * push; b.sx += dx * push; b.sy += dy * push;
          }
        }
      }
      for (const p of pts) {
        const ox2 = p.sx - p.x0; const oy2 = p.sy - p.y0; const d = Math.hypot(ox2, oy2);
        if (d > maxShift) { p.sx = p.x0 + (ox2 / d) * maxShift; p.sy = p.y0 + (oy2 / d) * maxShift; }
      }
    }

    function draw(state = {}) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(layer, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t = state.time || 0;
      if (!race && map.hazards.length) {
        // Lava breathes (state.time is in seconds).
        const a = 0.14 + 0.09 * Math.sin(t * 2.4);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const h of map.hazards) {
          if (h.r === undefined) continue;
          const x = X(h.x); const y = Y(h.y); const r = h.r * s;
          const gl = ctx.createRadialGradient(x, y, r * 0.2, x, y, r + 5 * k);
          gl.addColorStop(0, `rgba(255,200,90,${a})`); gl.addColorStop(0.7, `rgba(255,110,30,${a * 0.8})`); gl.addColorStop(1, 'rgba(255,80,20,0)');
          ctx.fillStyle = gl;
          ctx.beginPath(); ctx.arc(x, y, r + 5 * k, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
      if (!race && state.boxes) {
        // Item boxes: small pale-gold squares, a colour no kart uses.
        ctx.fillStyle = 'rgba(255,236,170,0.7)';
        const b = 1.5 * k;
        map.itemBoxes.forEach((box, i) => { if (state.boxes[i]) ctx.fillRect(X(box.x) - b, Y(box.y) - b, b * 2, b * 2); });
      }
      if (!race && state.deaths) {
        // Where someone just got smashed: a fading X in their colour.
        ctx.lineCap = 'round';
        for (const d of state.deaths) {
          const al = Math.max(0, 1 - d.age / 2);
          if (al <= 0) continue;
          const x = X(d.x); const y = Y(d.y); const r = 2.6 * k;
          ctx.lineWidth = 2.8 * k; ctx.strokeStyle = `rgba(18,14,36,${0.7 * al})`;
          ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
          ctx.lineWidth = 1.5 * k; ctx.strokeStyle = rgba(d.color, al);
          ctx.stroke();
        }
      }
      if (state.comets && state.comets.length) {
        // Comets in flight: a glowing blue-white dot that pulses.
        ctx.save();
        ctx.shadowColor = 'rgba(129,140,248,0.95)'; ctx.shadowBlur = 6 * k * dpr;
        for (const c of state.comets) {
          if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
          ctx.fillStyle = '#e0e7ff';
          ctx.beginPath(); ctx.arc(X(c.x), Y(c.y), (2.6 + Math.sin(t * 14) * 0.6) * k, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
      const karts = state.karts || [];
      let me = null;
      const rivals = [];
      for (const kt of karts) {
        if (kt.me) { me = kt; continue; }
        if (kt.dead || !Number.isFinite(kt.x) || !Number.isFinite(kt.y)) continue;
        const x0 = X(kt.x); const y0 = Y(kt.y);
        rivals.push({ kt, x0, y0, sx: x0, sy: y0 });
      }
      spread(rivals, (race ? badgeR * 2 : 6.5 * k) + 0.8 * k, 3 * k);
      // Arena markers stay on the floor plan, even for a kart pressed against the outer wall.
      const lo = race ? -Infinity : X(40);
      const hi = race ? Infinity : X(map.size - 40);
      const keep = (v, r) => Math.max(lo + r, Math.min(hi - r, v));
      for (const p of rivals) { p.sx = keep(p.sx, 5 * k); p.sy = keep(p.sy, 5 * k); }
      // Back of the field first so the leaders sit on top.
      rivals.sort((a, b) => (b.kt.place || 99) - (a.kt.place || 99));
      const meX = me ? keep(X(me.x), meR + 1.1 * k) : 0;
      const meY = me ? keep(Y(me.y), meR + 1.1 * k) : 0;
      if (me && !me.dead && !race && Number.isFinite(me.x)) {
        ctx.save(); ctx.translate(meX, meY); viewCone(me.angle); ctx.restore();
      }
      for (const p of rivals) {
        ctx.save();
        ctx.translate(p.sx, p.sy);
        // Layered arenas: a rival on another floor (above or below you) is drawn faint.
        if (me && Number.isFinite(me.z) && Number.isFinite(p.kt.z) && Math.abs(p.kt.z - me.z) > 45) ctx.globalAlpha = 0.5;
        if (race) raceBadge(p.kt);
        else chevron(9 * k, p.kt.angle, p.kt.color, 'rgba(10,8,25,0.92)', 1.6 * k);
        ctx.restore();
      }
      const leader = race && rivals.find((p) => p.kt.place === 1);
      if (leader) { ctx.save(); ctx.translate(leader.sx, leader.sy - badgeR - 3.6 * k); crown(); ctx.restore(); }
      if (me && Number.isFinite(me.x) && Number.isFinite(me.y)) {
        ctx.save(); ctx.translate(meX, meY); meMarker(me); ctx.restore();
        if (race && me.place === 1 && !me.dead) { ctx.save(); ctx.translate(meX, meY - meR - 3.4 * k); crown(); ctx.restore(); }
      }
    }

    return { draw, cssSize: css, dpr, roadWidth: roadW };
  }

  window.KartMinimap = { create };
})();
