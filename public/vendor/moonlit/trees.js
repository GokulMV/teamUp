/* Vendored unchanged from GokulMV/moonlit-cove (src3d/trees.js, commit 2989974), used with the author's permission.
   TeamUp uses Trees.grow / Trees.card / Trees.materials(kind).bark; see moonlit-shim.js for the globals it expects. */
/* ─────────────────────────────────────────────────────────────
   trees.js — the coast's trees and bushes, grown: a trunk that
   forks into limbs, limbs into branches, branches into twigs, and
   leafy twig cards at their ends, so a crown is a cloud of small
   leaf clusters with gaps the sky shows through.
   Each card is painted leaf by leaf: a blade shaded from stalk to
   tip, folded along its midrib, veined, a few turned red or yellow
   or showing their paler undersides, the ones at the back of the
   cluster darker. A normal map painted with it turns each leaf its
   own way, so in the sun some catch the light, some shine, some
   glow with the light coming through them, and the rest fall into
   the shade of the crown. Each card also knows how deep in its
   crown it sits (dark inside, lit at the edge). Far away the
   leaves keep their coverage (their mip levels are made so), so a
   wispy casuarina doesn't thin away to sticks.
   The species of a tropical shore: the tropical almond (tiers of
   level branches, big leaves in rosettes, a few gone red), the
   casuarina (tall, wispy, drooping needles), the beach hibiscus
   (a rounded, spreading crown of heart-shaped leaves, yellow
   flowers) and the sea grape (sprawling mounds of big round
   leaves); and low leafy scrub.
   ───────────────────────────────────────────────────────────── */
const Trees = (() => {
  const T = THREE, TAU = Math.PI * 2, rng = Textures.rng, V3 = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
  const RF = { willReadFrequently: true }, S = 256;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const hsla = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${(clamp01(s) * 100).toFixed(1)}%,${(clamp01(l) * 100).toFixed(1)}%,${a})`;

  /* ── the leaves of each species: their greens (hue, saturation, lightness, and how far each wanders), the share that
     have turned and to what, the paler undersides, the veins, how glossy ── */
  const LEAF = {
    almond: { g: [104, 0.44, 0.22], gj: [9, 0.08, 0.05], turn: 0.1, turned: [[6, 0.62, 0.33], [18, 0.7, 0.4], [40, 0.66, 0.44], [28, 0.5, 0.3]], under: [86, 0.2, 0.4], underK: 0.12, vein: [72, 0.4, 0.5], twig: '#6e5d4c' },
    grape: { g: [82, 0.36, 0.29], gj: [8, 0.07, 0.05], turn: 0.08, turned: [[4, 0.48, 0.32], [16, 0.5, 0.36]], under: [78, 0.2, 0.44], underK: 0.1, vein: [354, 0.38, 0.46], twig: '#6b4b3b' },
    hibiscus: { g: [100, 0.4, 0.27], gj: [9, 0.08, 0.05], turn: 0.02, turned: [[48, 0.72, 0.47]], under: [86, 0.15, 0.52], underK: 0.22, vein: [80, 0.32, 0.5], twig: '#6a6250' },
    casuarina: { g: [88, 0.2, 0.3], gj: [8, 0.06, 0.06], turn: 0.06, turned: [[34, 0.34, 0.38]], twig: '#5e4a38' },
    scrub: { g: [102, 0.38, 0.28], gj: [11, 0.08, 0.06], turn: 0.05, turned: [[42, 0.52, 0.42]], under: [88, 0.18, 0.46], underK: 0.14, vein: [82, 0.3, 0.5], twig: '#5a4a38' } };

  /* a leaf's outline, stalk at the origin, tip at (L, 0) */
  function leafPath(a, shape, L, W) {
    a.beginPath();
    if (shape === 'obovate') {            /* broadest two thirds out, rounding to a short point */
      a.moveTo(0, 0);
      a.bezierCurveTo(L * 0.22, -W * 0.14, L * 0.48, -W * 0.5, L * 0.76, -W * 0.49);
      a.bezierCurveTo(L * 0.95, -W * 0.45, L * 1.03, -W * 0.18, L, 0);
      a.bezierCurveTo(L * 1.03, W * 0.18, L * 0.95, W * 0.45, L * 0.76, W * 0.49);
      a.bezierCurveTo(L * 0.48, W * 0.5, L * 0.22, W * 0.14, 0, 0);
    } else if (shape === 'round') {       /* nearly a circle, notched where the stalk comes in */
      a.moveTo(L * 0.07, 0);
      a.bezierCurveTo(-L * 0.03, -W * 0.32, L * 0.2, -W * 0.53, L * 0.5, -W * 0.5);
      a.bezierCurveTo(L * 0.84, -W * 0.48, L * 1.03, -W * 0.22, L, 0);
      a.bezierCurveTo(L * 1.03, W * 0.22, L * 0.84, W * 0.48, L * 0.5, W * 0.5);
      a.bezierCurveTo(L * 0.2, W * 0.53, -L * 0.03, W * 0.32, L * 0.07, 0);
    } else if (shape === 'heart') {       /* two lobes back past the stalk, a drawn-out tip */
      a.moveTo(0, 0);
      a.bezierCurveTo(-L * 0.17, -W * 0.3, -L * 0.03, -W * 0.57, L * 0.3, -W * 0.5);
      a.bezierCurveTo(L * 0.6, -W * 0.44, L * 0.84, -W * 0.2, L, 0);
      a.bezierCurveTo(L * 0.84, W * 0.2, L * 0.6, W * 0.44, L * 0.3, W * 0.5);
      a.bezierCurveTo(-L * 0.03, W * 0.57, -L * 0.17, W * 0.3, 0, 0);
    } else {                               /* lance */
      a.moveTo(0, 0);
      a.bezierCurveTo(L * 0.25, -W * 0.5, L * 0.62, -W * 0.44, L, 0);
      a.bezierCurveTo(L * 0.62, W * 0.44, L * 0.25, W * 0.5, 0, 0);
    }
    a.closePath();
  }
  /* the veins: fanned from the stalk on round and heart-shaped leaves, paired up the midrib on the rest */
  function veins(a, lf, r, col, w) {
    const { L, W, shape } = lf;
    a.strokeStyle = col; a.lineCap = 'round';
    if (shape === 'heart' || shape === 'round') {
      const n = shape === 'heart' ? 3 : 2;
      for (const s of [-1, 1]) for (let i = 1; i <= n; i++) {
        const an = s * i / (n + 0.7) * (shape === 'heart' ? 1.5 : 1.25);
        a.lineWidth = w * (1.1 - i * 0.15); a.beginPath(); a.moveTo(L * 0.04, 0);
        a.quadraticCurveTo(Math.cos(an * 0.55) * L * 0.42, Math.sin(an * 0.55) * L * 0.42, Math.cos(an) * L * 0.8 + L * 0.08, Math.sin(an) * W * 0.6); a.stroke();
      }
    }
    const n = shape === 'lance' ? 4 : shape === 'heart' ? 3 : 6, t0 = shape === 'heart' ? 0.4 : shape === 'round' ? 0.35 : 0.12;
    for (let i = 0; i < n; i++) {
      const t = t0 + (0.86 - t0) * (i + 0.3 + r() * 0.4) / n, x0 = L * t;
      for (const s of [-1, 1]) {
        a.lineWidth = w * 0.8; a.beginPath(); a.moveTo(x0, 0);
        a.quadraticCurveTo(x0 + L * 0.08, s * W * 0.2, x0 + L * 0.2 * (1.1 - t), s * W * 0.56); a.stroke();
      }
    }
  }
  /* a leaf in colour: shaded from stalk to tip, one half of the fold lighter than the other, veins, mottling, a scorched
     edge on a few, a darker rim, the midrib */
  function paintLeaf(a, lf, r, P) {
    const { L, W, shape } = lf, [h, s, l] = lf.hsl;
    a.save(); a.translate(lf.x, lf.y); a.rotate(lf.ang);
    leafPath(a, shape, L, W);
    const g = a.createLinearGradient(0, 0, L, 0);
    g.addColorStop(0, hsla(h + 5, s * 0.92, l * 0.8)); g.addColorStop(0.55, hsla(h, s, l)); g.addColorStop(1, hsla(h - 3, s * 0.97, l * 1.07));
    a.fillStyle = g; a.fill();
    a.save(); a.clip();
    const f = a.createLinearGradient(0, -W * 0.55, 0, W * 0.55), k = lf.under ? 0.5 : 1;
    f.addColorStop(0, `rgba(255,255,226,${0.12 * k})`); f.addColorStop(0.48, 'rgba(255,255,226,0)'); f.addColorStop(0.52, 'rgba(0,12,0,0)'); f.addColorStop(1, `rgba(0,12,0,${0.2 * k})`);
    a.fillStyle = f; a.fillRect(-W, -W, L + 2 * W, 2 * W);
    if (P.vein) {
      const [vh, vs, vl] = lf.redVein ? [P.vein[0], P.vein[1], P.vein[2]] : [h - 14, s * 0.8, Math.min(0.62, l * 1.55 + 0.06)];
      veins(a, lf, r, hsla(vh, vs, vl, lf.under ? 0.5 : lf.redVein ? 0.42 : 0.24), Math.max(0.7, W * 0.022));
    }
    for (let i = 0, n = Math.round(L * W / 90); i < n; i++) {
      a.fillStyle = r() < 0.5 ? 'rgba(0,8,0,0.07)' : 'rgba(255,250,200,0.05)';
      a.beginPath(); a.arc(r() * L, (r() - 0.5) * W, 0.6 + r() * 2.2, 0, TAU); a.fill();
    }
    if (lf.scorch) {     /* a dry, brown edge or tip */
      const sx = L * (0.6 + 0.4 * r()), sy = (r() - 0.5) * W * 0.9, rg = a.createRadialGradient(sx, sy, 0, sx, sy, W * (0.25 + 0.3 * r()));
      rg.addColorStop(0, 'rgba(120,84,40,0.85)'); rg.addColorStop(0.6, 'rgba(140,110,50,0.4)'); rg.addColorStop(1, 'rgba(140,110,50,0)');
      a.fillStyle = rg; a.fillRect(-W, -W, L + 2 * W, 2 * W);
    }
    a.restore();
    a.strokeStyle = hsla(h, s, l * 0.55, 0.6); a.lineWidth = 0.9; leafPath(a, shape, L, W); a.stroke();
    /* the midrib, thick at the stalk and fading toward the tip */
    const mr = lf.redVein ? hsla(P.vein[0], P.vein[1], P.vein[2], 0.75) : hsla(h - 18, s * 0.7, Math.min(0.7, l * 1.7 + 0.08), lf.under ? 0.8 : 0.5);
    a.strokeStyle = mr; a.lineCap = 'round';
    for (const [x0, x1, lw] of [[0, L * 0.45, 1.6], [L * 0.4, L * 0.9, 0.9]]) { a.lineWidth = Math.max(0.6, lw * W / 34); a.beginPath(); a.moveTo(x0, 0); a.lineTo(x1, 0); a.stroke(); }
    a.restore();
  }
  /* the same leaf in the normal map: turned its own way, its halves tilted in toward the midrib (the fold), arching from
     stalk to tip. Tangent space: x along the card's width, y up the card, z out of its face */
  const enc = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return `rgb(${Math.round((x / l * 0.5 + 0.5) * 255)},${Math.round((y / l * 0.5 + 0.5) * 255)},${Math.round((z / l * 0.5 + 0.5) * 255)})`; };
  function normLeaf(b, lf) {
    const { L, W, shape } = lf, c = Math.cos(lf.ang), s = Math.sin(lf.ang);
    const A = [c, -s], Pp = [-s, -c];                      /* the leaf's axis and its side, in tangent space */
    const nAt = (t, side) => { const ta = lf.ta + lf.arch * (2 * t - 1), tp = lf.tp - side * lf.fold; return enc(ta * A[0] + tp * Pp[0], ta * A[1] + tp * Pp[1], 1); };
    b.save(); b.translate(lf.x, lf.y); b.rotate(lf.ang);
    leafPath(b, shape, L, W); b.save(); b.clip();
    for (const side of [-1, 1]) {
      const g = b.createLinearGradient(-L * 0.2, 0, L * 1.05, 0);
      g.addColorStop(0, nAt(0, side)); g.addColorStop(0.5, nAt(0.5, side)); g.addColorStop(1, nAt(1, side));
      b.fillStyle = g; b.fillRect(-L * 0.3, side < 0 ? -W : 0, L * 1.6, W);
    }
    b.restore(); b.restore();
  }

  /* the twig the leaves grow on: a gentle curve up the card */
  function twigOf(r, top) {
    const P0 = [128 + (r() - 0.5) * 6, 252], P3 = [128 + (r() - 0.5) * 22, top], P1 = [P0[0] + (r() - 0.5) * 20, 200], P2 = [P3[0] + (r() - 0.5) * 20, top + 50];
    const at = t => { const u = 1 - t; return { x: u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0], y: u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1] }; };
    return { at, P: [P0, P1, P2, P3] };
  }
  /* each species' card: where its leaves go on the twig */
  function leafOf(P, r, kind, x, y, ang, L, W, shape, depth) {
    let [h, s, l] = P.g, under = false;
    h += (r() - 0.5) * 2 * P.gj[0]; s += (r() - 0.5) * 2 * P.gj[1]; l += (r() - 0.5) * 2 * P.gj[2];
    if (r() < P.turn) { const t = P.turned[Math.floor(r() * P.turned.length)]; h = t[0] + (r() - 0.5) * 10; s = t[1] * (0.85 + 0.3 * r()); l = t[2] * (0.88 + 0.24 * r()); }
    else if (P.underK && r() < P.underK) { under = true; h = P.under[0] + (r() - 0.5) * 8; s = P.under[1] * (0.8 + 0.4 * r()); l = P.under[2] * (0.9 + 0.2 * r()); }
    l *= 0.72 + 0.28 * depth;                       /* the back of the cluster in its own shade */
    return { x, y, ang, L, W, shape, depth, hsl: [h, s, l], under, redVein: kind === 'grape' && r() < 0.45, scorch: r() < (kind === 'almond' || kind === 'grape' ? 0.12 : 0.06),
      ta: (r() - 0.5) * 1.1, tp: (r() - 0.5) * 1.1, fold: 0.18 + r() * 0.3, arch: 0.12 + r() * 0.28 };
  }
  function layout(kind, r, P) {
    const leaves = [], strands = [], flowers = [], stalks = [];
    const add = (base, ang, pet, L, W, shape, depth) => {
      const x = base.x + Math.cos(ang) * pet, y = base.y + Math.sin(ang) * pet;
      if (pet > 0.5) stalks.push([base.x, base.y, x, y]);
      leaves.push(leafOf(P, r, kind, x, y, ang + (r() - 0.5) * 0.12, L, W, shape, depth));
    };
    let tw;
    if (kind === 'almond') {
      /* a rosette of big leaves at the twig's end, last year's smaller one below it, a stray or two */
      tw = twigOf(r, 104);
      const tip = tw.at(1), n = 7 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) { const ang = -Math.PI / 2 + (k / (n - 1) - 0.5) * 3.0 + (r() - 0.5) * 0.3, L = 58 + r() * 26; add(tip, ang, 5 + r() * 6, L, L * (0.5 + r() * 0.08), 'obovate', r()); }
      const mid = tw.at(0.45), n2 = 4 + Math.floor(r() * 3);
      for (let k = 0; k < n2; k++) { const ang = -Math.PI / 2 + (k % 2 ? 1 : -1) * (0.9 + r() * 0.8), L = 40 + r() * 20; add(mid, ang, 4 + r() * 4, L, L * 0.52, 'obovate', r() * 0.8); }
      if (r() < 0.7) { const p = tw.at(0.15 + r() * 0.1), L = 32 + r() * 14; add(p, -Math.PI / 2 + (r() < 0.5 ? -1 : 1) * (1.0 + r() * 0.5), 3, L, L * 0.5, 'obovate', r() * 0.6); }
    } else if (kind === 'grape') {
      /* big round leaves alternating up a zigzag twig, a young one at its end */
      tw = twigOf(r, 62);
      const n = 6 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) { const t = 0.14 + 0.82 * (k + 0.3 * r()) / n, side = k % 2 ? 1 : -1, L = (44 + r() * 18) * (1 - 0.18 * t); add(tw.at(t), -Math.PI / 2 + side * (0.6 + r() * 0.6), 4 + r() * 4, L, L * (1.05 + r() * 0.1), 'round', r()); }
      const L = 36 + r() * 10; add(tw.at(1), -Math.PI / 2 + (r() - 0.5) * 0.4, 3, L, L * 1.05, 'round', 0.7 + r() * 0.3);
    } else if (kind === 'hibiscus') {
      /* heart-shaped leaves hanging out on long stalks, now and then a yellow flower */
      tw = twigOf(r, 46);
      const n = 10 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) { const t = 0.1 + 0.88 * (k + 0.3 * r()) / n, side = k % 2 ? 1 : -1, L = (31 + r() * 13) * (1 - 0.2 * t); add(tw.at(t), -Math.PI / 2 + side * (0.85 + r() * 0.85), 9 + r() * 12, L, L * (0.92 + r() * 0.1), 'heart', r()); }
      { const L = 30 + r() * 8; add(tw.at(1), -Math.PI / 2 + (r() - 0.5) * 0.5, 6, L, L * 0.95, 'heart', 0.8); }
      for (let i = 0, nf = r() < 0.55 ? 1 + Math.floor(r() * 2) : 0; i < nf; i++) { const p = tw.at(0.45 + r() * 0.45); flowers.push({ x: p.x + (r() - 0.5) * 34, y: p.y + (r() - 0.5) * 20, rad: 10 + r() * 4, rot: r() * TAU, open: r() }); }
    } else if (kind === 'scrub') {
      /* a stem with a few side shoots, all thick with narrow leaves */
      tw = twigOf(r, 30);
      const shoots = [{ at: t => tw.at(t), n: 20 }];
      for (let k = 0, nb = 2 + Math.floor(r() * 2); k < nb; k++) {
        const b0 = tw.at(0.25 + 0.5 * (k + r() * 0.5) / nb), an = -Math.PI / 2 + (k % 2 ? 1 : -1) * (0.5 + r() * 0.4), bl = 50 + r() * 40;
        const b1 = { x: b0.x + Math.cos(an) * bl, y: b0.y + Math.sin(an) * bl }; stalks.push([b0.x, b0.y, b1.x, b1.y]);
        shoots.push({ at: t => ({ x: b0.x + (b1.x - b0.x) * t, y: b0.y + (b1.y - b0.y) * t }), n: 9, an });
      }
      for (const sh of shoots) for (let k = 0; k < sh.n; k++) {
        const t = 0.1 + 0.9 * (k + 0.3 * r()) / sh.n, side = k % 2 ? 1 : -1, L = (18 + r() * 12) * (1 - 0.25 * t), base = sh.an ?? -Math.PI / 2;
        add(sh.at(t), base + side * (0.45 + r() * 0.55), 2, L, L * 0.32, 'lance', r());
      }
      { const L = 18 + r() * 6; add(tw.at(1), -Math.PI / 2, 1, L, L * 0.32, 'lance', 1); }
    } else {
      /* casuarina: a twig with short side shoots, and from them long strands of needles hanging down */
      tw = twigOf(r, 26);
      const nb = 7 + Math.floor(r() * 3);
      for (let k = 0; k < nb; k++) {
        const t = 0.08 + 0.9 * (k + 0.4 * r()) / nb, b0 = tw.at(t), side = k % 2 ? 1 : -1, an = -Math.PI / 2 + side * (0.75 + r() * 0.6), bl = 22 + r() * 30;
        const b1 = { x: b0.x + Math.cos(an) * bl, y: b0.y + Math.sin(an) * bl }; stalks.push([b0.x, b0.y, b1.x, b1.y]);
        const ns = 16 + Math.floor(r() * 8);
        for (let i = 0; i < ns; i++) {
          const u = 0.1 + 0.9 * i / ns, sx = b0.x + (b1.x - b0.x) * u, sy = b0.y + (b1.y - b0.y) * u, len = Math.min(248 - sy, (30 + r() * 56) * (1 - 0.3 * u)), out = side * (2 + r() * 14) + (r() - 0.5) * 8;
          strands.push({ x0: sx, y0: sy, cx: sx + out * 1.4, cy: sy + len * 0.18, x1: sx + out + (r() - 0.5) * 12, y1: sy + len, w: 0.8 + r() * 0.7, depth: r(), ...leafOf(P, r, kind, 0, 0, 0, 0, 0, 'needle', r()) });
        }
      }
    }
    return { tw, leaves, strands, flowers, stalks };
  }
  /* a five-petalled yellow cup with a dark red eye */
  function flower(a, b, f) {
    a.save(); a.translate(f.x, f.y); a.rotate(f.rot);
    for (let i = 0; i < 5; i++) {
      a.save(); a.rotate(i / 5 * TAU); const g = a.createLinearGradient(0, 0, f.rad, 0);
      g.addColorStop(0, '#d9a62a'); g.addColorStop(0.5, '#f2cd3e'); g.addColorStop(1, '#f6dd6a');
      a.fillStyle = g; a.beginPath(); a.ellipse(f.rad * 0.55, 0, f.rad * 0.55, f.rad * (0.38 + 0.12 * f.open), 0, 0, TAU); a.fill(); a.restore();
    }
    a.fillStyle = '#6e1f1c'; a.beginPath(); a.arc(0, 0, f.rad * 0.3, 0, TAU); a.fill();
    a.fillStyle = 'rgba(255,240,170,0.8)'; a.beginPath(); a.arc(f.rad * 0.08, -f.rad * 0.05, f.rad * 0.09, 0, TAU); a.fill();
    a.restore();
    b.fillStyle = enc((Math.random() - 0.5) * 0.4, 0.2, 1); b.beginPath(); b.arc(f.x, f.y, f.rad, 0, TAU); b.fill();
  }
  /* one card, painted: its colour and its normal map, as pixels (top row first) */
  function paint(kind, seed) {
    const c = document.createElement('canvas'), n = document.createElement('canvas'); c.width = c.height = n.width = n.height = S;
    const a = c.getContext('2d', RF), b = n.getContext('2d', RF), r = rng(seed), P = LEAF[kind];
    b.fillStyle = 'rgb(128,128,255)'; b.fillRect(0, 0, S, S);
    const { tw, leaves, strands, flowers, stalks } = layout(kind, r, P);
    /* the twig, thinning toward its end, and the stalks off it */
    a.lineCap = 'round';
    for (let i = 0; i < 12; i++) { const p = tw.at(i / 12), q = tw.at((i + 1) / 12); a.strokeStyle = P.twig; a.lineWidth = 3.4 - 2.2 * i / 12; a.beginPath(); a.moveTo(p.x, p.y); a.lineTo(q.x, q.y); a.stroke(); }
    a.strokeStyle = kind === 'casuarina' ? '#5d5a40' : 'rgba(92,96,52,0.95)'; a.lineWidth = kind === 'casuarina' ? 1.6 : 1.2;
    for (const [x0, y0, x1, y1] of stalks) { a.beginPath(); a.moveTo(x0, y0); a.lineTo(x1, y1); a.stroke(); }
    /* casuarina strands: back ones first, darker */
    strands.sort((p, q) => p.depth - q.depth);
    for (const s of strands) {
      const [h, sa, l] = s.hsl;
      a.strokeStyle = hsla(h, sa, l, 0.95); a.lineWidth = s.w; a.beginPath(); a.moveTo(s.x0, s.y0); a.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1); a.stroke();
      /* the joints along a strand, a little paler */
      a.strokeStyle = hsla(h - 10, sa * 0.8, Math.min(0.6, l * 1.35), 0.45); a.lineWidth = s.w * 0.5; a.setLineDash([2, 5]); a.stroke(); a.setLineDash([]);
      b.strokeStyle = enc(s.ta, s.tp, 1); b.lineWidth = s.w + 0.6; b.beginPath(); b.moveTo(s.x0, s.y0); b.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1); b.stroke();
    }
    leaves.sort((p, q) => p.depth - q.depth);
    for (const lf of leaves) { paintLeaf(a, lf, r, P); normLeaf(b, lf); }
    for (const f of flowers) flower(a, b, f);
    return { col: a.getImageData(0, 0, S, S).data, nor: b.getImageData(0, 0, S, S).data };
  }

  /* ── pixels to textures: rows turned bottom-up; under the transparent parts the leaves' colours are grown out, so
     their edges don't darken as the texture is filtered; mip levels whose alpha is scaled to keep the share of the card
     that is leaf (Castaño's coverage-preserving mipmaps), so thin leaves stay as thick far off as up close ── */
  function flip(px, w, h) { const out = new Uint8Array(px.length), rb = w * 4; for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * rb, (h - y) * rb), y * rb); return out; }
  function dilate(px, w, h) {
    /* (the texels not yet coloured, those that are, and the ones each pass colours, as flat typed lists: no arrays made per
       texel, which is where the time went) */
    const N = w * h, on = new Uint8Array(N), add = new Int32Array(N); let mr = 0, mg = 0, mb = 0, mn = 0;
    for (let i = 0; i < N; i++) if (px[i * 4 + 3] > 10) { on[i] = 1; mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; mn++; }
    for (let pass = 0; pass < 10; pass++) {
      let na = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (on[i]) continue;
        let r = 0, g = 0, b = 0, n = 0, j;
        if (x > 0 && on[j = i - 1]) { r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; n++; }
        if (x < w - 1 && on[j = i + 1]) { r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; n++; }
        if (y > 0 && on[j = i - w]) { r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; n++; }
        if (y < h - 1 && on[j = i + w]) { r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; n++; }
        if (n) { px[i * 4] = r / n; px[i * 4 + 1] = g / n; px[i * 4 + 2] = b / n; add[na++] = i; }
      }
      if (!na) break;
      for (let k = 0; k < na; k++) on[add[k]] = 1;
    }
    if (mn) for (let i = 0; i < N; i++) if (!on[i]) { px[i * 4] = mr / mn; px[i * 4 + 1] = mg / mn; px[i * 4 + 2] = mb / mn; }
  }
  /* (how much of a picture is covered at or over cut once its cover is scaled by k: from a count of its texels at each
     cover, so each try costs 256 sums, not a pass over the picture) */
  const hist = d => { const H = new Float64Array(256); for (let i = 3; i < d.length; i += 4) H[d[i]]++; return H; };
  const covH = (H, n, cut, k) => { let c = 0; for (let v = 255; v >= 0 && v * k >= cut; v--) c += H[v]; return c / n; };
  const coverage = (d, cut, k) => covH(hist(d), d.length / 4, cut, k);
  function mipChain(px, w, h, cut) {
    const levels = [{ data: px, width: w, height: h }], c0 = cut ? coverage(px, cut, 1) : 0;
    let raw = px, cw = w, ch = h;
    while (cw > 1 || ch > 1) {
      const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1), d = new Uint8Array(nw * nh * 4);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let k = 0; k < 4; k++) {
        const x0 = Math.min(cw - 1, x * 2), x1 = Math.min(cw - 1, x * 2 + 1), y0 = Math.min(ch - 1, y * 2), y1 = Math.min(ch - 1, y * 2 + 1);
        d[(y * nw + x) * 4 + k] = (raw[(y0 * cw + x0) * 4 + k] + raw[(y0 * cw + x1) * 4 + k] + raw[(y1 * cw + x0) * 4 + k] + raw[(y1 * cw + x1) * 4 + k] + 2) >> 2;
      }
      let out = d;
      if (cut && c0 > 0) {
        const Hd = hist(d), nd = d.length / 4;
        let lo = 1, hi = 16; for (let it = 0; it < 12; it++) { const m = (lo + hi) / 2; if (covH(Hd, nd, cut, m) < c0) lo = m; else hi = m; }
        out = new Uint8Array(d); for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, Math.round(d[i] * hi));
      }
      levels.push({ data: out, width: nw, height: nh }); raw = d; cw = nw; ch = nh;
    }
    return levels;
  }
  function dataTex(levels, srgb) {
    const t = new T.DataTexture(levels[0].data, levels[0].width, levels[0].height, T.RGBAFormat, T.UnsignedByteType);
    t.mipmaps = levels; t.generateMipmaps = false; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
    t.wrapS = t.wrapT = T.ClampToEdgeWrapping; t.anisotropy = 1; if (srgb) t.colorSpace = T.SRGBColorSpace; t.needsUpdate = true;
    return t;
  }
  const CUT = 0.42;
  const cardCache = {};
  function card(kind, k) {
    const key = kind + k; if (cardCache[key]) return cardCache[key];
    const { col, nor } = paint(kind, 101 + k * 37 + kind.length * 11);
    const c = flip(col, S, S), n = flip(nor, S, S); dilate(c, S, S);
    return (cardCache[key] = { map: dataTex(mipChain(c, S, S, CUT * 255), true), nmap: dataTex(mipChain(n, S, S, 0), false) });
  }

  /* ── bark: furrows running up the trunk between corky ridges, lichen on some; a normal map from the same heights. The
     noise wraps, so the bark tiles round the trunk and up it ── */
  function barkTex(seed, base, kind) {
    const w = 128, h = 512, r = rng(seed), G = 32, lat = Float32Array.from({ length: G * G }, () => r());
    const pn = (x, y, px, py) => {   /* value noise with a period of (px, py) lattice cells */
      const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      const L = (i, j) => lat[(((iy + j) % py + py) % py) * G + (((ix + i) % px + px) % px)];
      return (L(0, 0) * (1 - u) + L(1, 0) * u) * (1 - v) + (L(0, 1) * (1 - u) + L(1, 1) * u) * v;
    };
    const py = Math.round(32 * (kind === 'casuarina' ? 1.6 : kind === 'almond' ? 0.7 : 1.0));
    const H = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const warp = pn(u * 4, v * 6, 4, 6) * 1.2;
      const fur = 1 - Math.abs(Math.sin((u * 9 + warp) * Math.PI));                 /* the furrows */
      const crack = pn(u * 8, v * py, 8, py);                                           /* breaks across the ridges */
      const fine = pn(u * 32, v * 64, 32, 64);
      H[y * w + x] = Math.pow(1 - fur, 0.6) * (0.65 + 0.35 * crack) * 0.8 + fine * 0.2 - (crack < 0.28 ? 0.25 : 0);
    }
    const col = new Uint8ClampedArray(w * h * 4), nor = new Uint8ClampedArray(w * h * 4), bc = new T.Color(base);
    const lichen = kind === 'almond' || kind === 'hibiscus' ? 1 : 0.3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, hh = H[i], hx = H[y * w + (x + 1) % w] - H[y * w + (x + w - 1) % w], hy = H[((y + 1) % h) * w + x] - H[((y + h - 1) % h) * w + x];
      const lc = Math.max(0, pn(x / w * 6 + 3, y / h * 12, 6, 12) - 0.62) * 2.4 * lichen * (0.5 + hh);
      const k = 0.45 + 0.75 * hh;
      col[i * 4] = (bc.r * k * (1 - lc) + 0.62 * lc) * 255; col[i * 4 + 1] = (bc.g * k * (1 - lc) + 0.64 * lc) * 255; col[i * 4 + 2] = (bc.b * k * (1 - lc) + 0.52 * lc) * 255; col[i * 4 + 3] = 255;
      const nx = -hx * 3.2, ny = -hy * 1.6, l = Math.hypot(nx, ny, 1);
      nor[i * 4] = (nx / l * 0.5 + 0.5) * 255; nor[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255; nor[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; nor[i * 4 + 3] = 255;
    }
    const mk = (d, srgb) => { const t = new T.DataTexture(d, w, h, T.RGBAFormat, T.UnsignedByteType); t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; if (srgb) t.colorSpace = T.SRGBColorSpace; t.needsUpdate = true; return t; };
    return { map: mk(col, true), normalMap: mk(nor, false) };
  }

  /* a coconut palm's bark: the scars of fallen fronds as raised rings round the trunk, each a little wavy, a groove
     under each; between them grey-brown fibrous bark, split here and there by fine cracks running up it; patches of
     pale lichen. A normal map from the same heights. It tiles round the trunk and every half metre up it (seven rings) */
  let palmBarkC = null;
  function palmBark() {
    if (palmBarkC) return palmBarkC;
    const w = 256, h = 512, r = rng(4711), G = 64, lat = Float32Array.from({ length: G * G }, () => r());
    const pn = (x, y, px, py) => {
      const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      const L = (i, j) => lat[(((iy + j) % py + py) % py) * G + (((ix + i) % px + px) % px)];
      return (L(0, 0) * (1 - u) + L(1, 0) * u) * (1 - v) + (L(0, 1) * (1 - u) + L(1, 1) * u) * v;
    };
    const nR = 7, ringV = Array.from({ length: nR }, (_, k) => (k + 0.5 + 0.3 * (r() - 0.5)) / nR), ph = ringV.map(() => r() * TAU), amp = ringV.map(() => 0.003 + 0.005 * r()), fr = ringV.map(() => 1 + Math.floor(r() * 3));
    const H = new Float32Array(w * h), K = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h; let dmin = 1;
      for (let k = 0; k < nR; k++) { let d = v - ringV[k] - amp[k] * Math.sin(u * TAU * fr[k] + ph[k]) - 0.004 * (pn(u * 16, v * 8, 16, 8) - 0.5); d -= Math.round(d); if (Math.abs(d) < Math.abs(dmin)) dmin = d; }
      const dv = dmin * nR;                                                   /* (in ring spacings: 0 on a ring) */
      const ridge = Math.exp(-(((dv + 0.02) / 0.075) ** 2)), groove = Math.exp(-(((dv - 0.1) / 0.045) ** 2));
      const fib = pn(u * 64, v * 6, 64, 6), crackLine = Math.abs(((u * 9 + 0.35 * pn(u * 4, v * 24, 4, 24)) % 1) - 0.5), crack = Math.max(0, 1 - crackLine / 0.025) * (pn(u * 9, v * 14, 9, 14) > 0.55 ? 1 : 0);
      H[y * w + x] = 0.45 + 0.4 * ridge - 0.35 * groove + 0.12 * fib - 0.3 * crack;
      K[y * w + x] = (1 + 0.14 * ridge - 0.38 * groove - 0.35 * crack) * (0.93 + 0.14 * pn(u * 7, v * 9, 7, 9)) * (0.92 + 0.16 * fib);
    }
    const col = new Uint8ClampedArray(w * h * 4), nor = new Uint8ClampedArray(w * h * 4), base = [0.47, 0.42, 0.36];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, u = x / w, v = y / h, k = K[i];
      const lc = Math.max(0, pn(u * 6 + 3, v * 4, 6, 4) - 0.64) * 3 * (0.6 + 0.4 * pn(u * 40, v * 40, 40, 40));
      for (let c = 0; c < 3; c++) col[i * 4 + c] = ((base[c] * k) * (1 - lc) + [0.62, 0.63, 0.55][c] * lc) * 255;
      col[i * 4 + 3] = 255;
      const hx = H[y * w + (x + 1) % w] - H[y * w + (x + w - 1) % w], hy = H[((y + 1) % h) * w + x] - H[((y + h - 1) % h) * w + x], nx = -hx * 2.4, ny = -hy * 4.0, l = Math.hypot(nx, ny, 1);
      nor[i * 4] = (nx / l * 0.5 + 0.5) * 255; nor[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255; nor[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; nor[i * 4 + 3] = 255;
    }
    const mk = (d, srgb) => { const t = new T.DataTexture(d, w, h, T.RGBAFormat, T.UnsignedByteType); t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 4; if (srgb) t.colorSpace = T.SRGBColorSpace; t.needsUpdate = true; return t; };
    return (palmBarkC = { map: mk(col, true), normalMap: mk(nor, false) });
  }
  /* the palms' bark material (its trunks carry vertex colours: weathered grey at the foot, browner up high, the roots
     reddish) */
  let palmBarkM = null;
  const palmBarkMat = () => palmBarkM || (palmBarkM = Mats.lit({ map: palmBark().map, normalMap: palmBark().normalMap, normalScale: new T.Vector2(1.6, 1.6), vertexColors: true, roughness: 0.93 }));

  /* ── growing one: species, how its trunk and branches go, where its leaves are ── */
  const SPECIES = {
    /* tiers of level limbs off a straight trunk, branchlets turned up at their ends, big leaves in flat rosettes */
    almond: { h: [7, 10], r: 0.22, lean: 0.06, tiers: true, levels: 2, kids: [12, 4], from: [0.38, 0.35], ang: [1.32, 0.7], angJ: 0.25, lenR: [0.42, 0.42], up: [0.0, 0.5, 0.6], wob: 0.12, radR: 0.45,
      leaf: 'almond', cards: 9, card: 1.15, flat: 0.7, droop: 0, sets: 3, gloss: [0.32, 42], thru: 0.9 },
    /* tall, a thin trunk to the top, many short branches angled up, drooping twigs of needles */
    casuarina: { h: [10, 14], r: 0.18, lean: 0.05, levels: 2, kids: [22, 3], from: [0.3, 0.3], ang: [0.95, 0.75], angJ: 0.3, lenR: [0.24, 0.5], up: [0.0, 0.35, -0.4], wob: 0.1, radR: 0.42, taperTop: true,
      leaf: 'casuarina', cards: 8, card: 1.25, flat: 0, droop: 0.85, sets: 3, gloss: [0.06, 16], thru: 0.5 },
    /* a short trunk forking into a few spreading limbs, a rounded crown of heart-shaped leaves */
    hibiscus: { h: [2.4, 3.4], r: 0.2, lean: 0.12, fork: true, levels: 3, kids: [4, 4, 3], from: [0.85, 0.35, 0.3], ang: [0.75, 0.75, 0.8], angJ: 0.35, lenR: [1.25, 0.6, 0.55], up: [0.0, 0.25, 0.15, 0.1], wob: 0.22, radR: 0.55,
      leaf: 'hibiscus', cards: 6, card: 1.0, flat: 0.25, droop: 0.15, sets: 3, gloss: [0.2, 30], thru: 1.0 },
    /* a sprawling mound: stems leaning out from the ground, leafy almost to their feet */
    grape: { h: [1.6, 2.3], r: 0.075, lean: 0.85, bush: 7, levels: 2, kids: [3, 3], from: [0.25, 0.25], ang: [0.75, 0.7], angJ: 0.45, lenR: [0.55, 0.55], up: [0.18, 0.3, 0.15], wob: 0.25, radR: 0.6, leafFrom: 0.05,
      leaf: 'grape', cards: 6, card: 0.95, flat: 0.25, droop: 0.05, sets: 3, gloss: [0.36, 48], thru: 0.75 },
    /* low leafy scrub on the forest floor */
    scrub: { h: [0.6, 0.9], r: 0.025, lean: 0.5, bush: 4, levels: 1, kids: [3], from: [0.4], ang: [0.7], angJ: 0.4, lenR: [0.55], up: [0.1, 0.2], wob: 0.3, radR: 0.6,
      leaf: 'scrub', cards: 4, card: 0.55, flat: 0.2, droop: 0.1, sets: 3, gloss: [0.15, 28], thru: 1.0 } };

  /* a direction at `el` from the axis `t`, turned `az` round it */
  const _q = new T.Quaternion();
  function aside(t, az, el) {
    const ref = Math.abs(t.y) < 0.95 ? V3(0, 1, 0) : V3(1, 0, 0), u = V3().crossVectors(t, ref).normalize(), w = V3().crossVectors(t, u);
    return t.clone().multiplyScalar(Math.cos(el)).addScaledVector(u, Math.sin(el) * Math.cos(az)).addScaledVector(w, Math.sin(el) * Math.sin(az)).normalize();
  }
  function grow(kind, seed, lite) {
    const S_ = SPECIES[kind], r = rng(seed), bark = [], cards = [];
    const H = S_.h[0] + r() * (S_.h[1] - S_.h[0]);
    function branch(p0, dir, len, rad, lvl) {
      const segs = lvl === 0 ? (S_.bush ? 3 : 6) : lvl === 1 ? 3 : 2, pts = [p0.clone()], d = dir.clone();
      let p = p0.clone();
      for (let i = 1; i <= segs; i++) {
        d.add(V3((r() - 0.5) * S_.wob, (S_.up[lvl] || 0) * 0.3, (r() - 0.5) * S_.wob)).normalize();
        p = p.clone().addScaledVector(d, len / segs); pts.push(p);
      }
      const curve = new T.CatmullRomCurve3(pts), radial = lvl === 0 ? (S_.bush ? 4 : 6) : lvl === 1 ? 4 : 3;
      const end = S_.taperTop && lvl === 0 ? 0.08 : 0.35;
      /* (bark for what shows: not for the twigs among the leaves, whose cards have their twigs painted on, nor for a
         bush's branches inside its mound of leaves, nor, far off, for anything but the trunk) */
      const hidden = (lvl === S_.levels && (lvl >= 2 || S_.bush)) || (S_.bush && (lvl >= 1 || S_.levels === 1)) || (lite && lvl >= 1);
      if (!hidden && rad > 0.008) bark.push(Nature.taperTube(curve, segs * (lvl ? 1 : 2), lite ? Math.max(3, radial - 2) : radial, t => rad * (1 - t * (1 - end)), 1.2));
      if (lvl < S_.levels) {
        const n = Math.round(S_.kids[lvl] * (lite && lvl ? 0.7 : 1));
        for (let i = 0; i < n; i++) {
          let t = S_.from[lvl] + (1 - S_.from[lvl]) * (i + 0.2 + r() * 0.6) / n;
          if (S_.tiers && lvl === 0) t = S_.from[0] + (1 - S_.from[0]) * 0.85 * (Math.floor(i / 4) + 0.15 * r()) / Math.ceil(n / 4);   /* (in whorls of four) */
          const P = curve.getPointAt(Math.min(0.98, t)), Tg = curve.getTangentAt(Math.min(0.98, t)), az = i * 2.39996 + r() * 0.5;
          const el = S_.ang[lvl] + (r() - 0.5) * S_.angJ, cd = aside(Tg, az, el);
          const L = len * S_.lenR[lvl] * (0.75 + 0.5 * r()) * (S_.fork && lvl === 0 ? 1 : (1 - 0.45 * (t - S_.from[lvl]) / (1 - S_.from[lvl] + 1e-6) * (S_.taperTop ? 1 : 0.6)));
          branch(P, cd, L, rad * S_.radR * (1 - 0.4 * t), lvl + 1);
        }
      }
      /* leafy twig cards along the outer part of the last branches (a sea grape's all along them) */
      if (lvl === S_.levels) {
        const n = Math.max(2, Math.round(S_.cards * (lite ? 0.5 : 1))), t0 = S_.leafFrom ?? 0.3;
        for (let i = 0; i < n; i++) {
          const t = t0 + (1 - t0) * (i + r()) / n, P = curve.getPointAt(Math.min(1, t)), Tg = curve.getTangentAt(Math.min(1, t));
          /* the card's length runs out from the twig, turned round it; flat species lie their cards level, drooping ones
             hang them */
          let ax = aside(Tg, r() * TAU, 0.5 + r() * 0.7);
          if (S_.flat) ax.lerp(V3(ax.x, 0, ax.z).normalize(), S_.flat).normalize();
          if (S_.droop) ax.lerp(V3(ax.x * 0.3, -1, ax.z * 0.3).normalize(), S_.droop * (0.6 + 0.4 * r())).normalize();
          const s = S_.card * (0.8 + 0.4 * r()) * (lite ? 1.5 : 1);
          let side = V3().crossVectors(ax, V3(0, 1, 0)); if (side.lengthSq() < 1e-4) side = V3(1, 0, 0); side.normalize();
          side.applyQuaternion(_q.setFromAxisAngle(ax, (r() - 0.5) * 1.2));
          cards.push({ p: P.clone(), ax, side, s, set: Math.floor(r() * (S_.sets || 3)) });
        }
      }
    }
    if (S_.bush) {
      for (let i = 0; i < S_.bush; i++) {
        const az = i / S_.bush * TAU + r() * 0.8, d = aside(V3(0, 1, 0), az, S_.lean * (0.6 + 0.8 * r()));
        branch(V3(Math.cos(az) * 0.1, -0.05, Math.sin(az) * 0.1), d, H * (0.6 + 0.4 * r()), S_.r, 0);
      }
    } else {
      branch(V3(0, -0.3, 0), aside(V3(0, 1, 0), r() * TAU, S_.lean * r()), H, S_.r, 0);
    }
    /* the crown: its middle and its reach, from where its leaves are */
    const C = V3(); for (const c of cards) C.add(c.p); C.multiplyScalar(1 / Math.max(1, cards.length));
    const ext = V3(); for (const c of cards) { ext.x = Math.max(ext.x, Math.abs(c.p.x - C.x)); ext.y = Math.max(ext.y, Math.abs(c.p.y - C.y)); ext.z = Math.max(ext.z, Math.abs(c.p.z - C.z)); }
    ext.addScalar(0.6);
    /* the cards: two triangles each. The normal is the crown's roundness there (it shades the crown as one shape); the
       card's own frame (its width, its length, which way its face looks) goes with it for the leaves' normal map; and
       how deep in the crown it sits */
    const sets = [[], [], []];
    for (const c of cards) sets[c.set].push(c);
    const geo = sets.map(L => {
      const P = new Float32Array(L.length * 12), N = new Float32Array(L.length * 12), TA = new Float32Array(L.length * 12), BI = new Float32Array(L.length * 12), UV = new Float32Array(L.length * 8), A = new Float32Array(L.length * 16), I = new Uint32Array(L.length * 6);
      L.forEach((c, k) => {
        const w = c.s * 0.5, base = c.p, tip = c.p.clone().addScaledVector(c.ax, c.s);
        const corners = [base.clone().addScaledVector(c.side, -w), base.clone().addScaledVector(c.side, w), tip.clone().addScaledVector(c.side, w), tip.clone().addScaledVector(c.side, -w)];
        const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const n0 = V3().crossVectors(c.side, c.ax).normalize(), mid = base.clone().addScaledVector(c.ax, c.s * 0.5);
        const sgn = n0.dot(V3().subVectors(mid, C)) < 0 ? -1 : 1; n0.multiplyScalar(sgn);
        corners.forEach((v, j) => {
          const q = V3((v.x - C.x) / ext.x, (v.y - C.y) / ext.y, (v.z - C.z) / ext.z), dd = q.length(), cn = q.clone().normalize();
          const n = n0.clone().multiplyScalar(0.15).addScaledVector(cn, 0.85).normalize(), o3 = (k * 4 + j) * 3;
          P.set([v.x, v.y, v.z], o3); N.set([n.x, n.y, n.z], o3); TA.set([c.side.x, c.side.y, c.side.z], o3); BI.set([c.ax.x, c.ax.y, c.ax.z], o3); UV.set(uvs[j], (k * 4 + j) * 2);
          const ao = Math.min(1, Math.max(0, (dd - 0.25) / 0.75)) * (0.75 + 0.25 * Math.min(1, Math.max(0, q.y * 0.5 + 0.5)));
          A.set([ao, j >= 2 ? 1 : 0.3, ((k * 0.618) % 1), sgn], (k * 4 + j) * 4);
        });
        I.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
      });
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setAttribute('normal', new T.BufferAttribute(N, 3)); g.setAttribute('uv', new T.BufferAttribute(UV, 2));
      g.setAttribute('aTan', new T.BufferAttribute(TA, 3)); g.setAttribute('aBit', new T.BufferAttribute(BI, 3));
      g.setAttribute('aLeaf', new T.BufferAttribute(A, 4)); g.setIndex(new T.BufferAttribute(I, 1)); g.computeBoundingSphere(); return g;
    });
    const barkG = mergeTubes(bark);
    return { bark: barkG, c0: geo[0], c1: geo[1], c2: geo[2], crown: { c: C, ext } };
  }
  function mergeTubes(gs) {
    if (!gs.length) { const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(0), 3)); g.setAttribute('normal', new T.BufferAttribute(new Float32Array(0), 3)); g.setAttribute('uv', new T.BufferAttribute(new Float32Array(0), 2)); g.setIndex(new T.BufferAttribute(new Uint32Array(0), 1)); g.boundingSphere = new T.Sphere(); g.empty = true; return g; }
    let nv = 0, ni = 0; for (const g of gs) { nv += g.attributes.position.count; ni += g.index.count; }
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), I = new Uint32Array(ni);
    let o = 0, oi = 0;
    for (const g of gs) { P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); UV.set(g.attributes.uv.array, o * 2); const ix = g.index.array; for (let i = 0; i < ix.length; i++) I[oi + i] = ix[i] + o; o += g.attributes.position.count; oi += ix.length; g.dispose(); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(P, 3)); g.setAttribute('normal', new T.BufferAttribute(N, 3)); g.setAttribute('uv', new T.BufferAttribute(UV, 2)); g.setIndex(new T.BufferAttribute(I, 1)); g.computeBoundingSphere(); return g;
  }

  /* ── the leaves' shader. Each leaf is lit as itself (its normal from the map, on whichever face is toward the eye), but
     how much of the key light reaches it is the crown's business: full on the crown's sunward side and at its edge, little
     deep inside or round the far side, nothing where something casts a shadow on it. Light coming through a leaf from
     behind it is yellower; waxy leaves shine. The crown leans on the breeze and each twig flutters ── */
  const LEAF_VS = `
uniform float uTime; uniform vec2 uWindK;
attribute vec4 aLeaf;   /* how far out in the crown (0 deep inside, 1 at its edge), how free to flutter, a die, which way the card faces */
attribute vec3 aTan, aBit;
varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB; varying vec3 vWPos; varying vec4 vL; varying vec3 vTint;
void main(){
  vUv = uv; vec4 p = vec4(position, 1.0); vec3 n = normal, tg = aTan, bt = aBit, o = vec3(0.0);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #else
    vTint = vec3(1.0);
  #endif
  float hy = max(position.y, 0.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix*p; mat3 im = mat3(instanceMatrix); n = im*n; tg = im*tg; bt = im*bt; o = instanceMatrix[3].xyz;
  #else
    o = vec3(floor(p.x/9.0)*9.0, 0.0, floor(p.z/9.0)*9.0);
  #endif
  vec4 wp = modelMatrix*p; o = (modelMatrix*vec4(o, 1.0)).xyz;
  mat3 mm = mat3(modelMatrix);
  vN = normalize(mm*n); vT = normalize(mm*tg); vB = normalize(mm*bt);
  float ph = o.x*0.21 + o.z*0.17;
  wp.xz += vec2(0.55, -0.83)*((sin(uTime*0.62 + ph) + 0.4*sin(uTime*1.37 + ph*1.7))*uWindK.x + uWindK.y)*0.0011*hy*hy;
  /* (each twig flutters; in a gale faster and harder, a second, quicker shiver over the first) */
  float fq = dot(wp.xyz, vec3(1.3, 0.9, 1.7)) + aLeaf.z*6.0;
  wp.xyz += normalize(vN + vec3(0.0, 0.3, 0.0))*(sin(uTime*2.7 + fq)*(0.4 + 0.6*uWindK.x) + 0.6*sin(uTime*7.9 + fq*1.7)*max(uWindK.x - 1.0, 0.0))*0.035*aLeaf.y;
  vWPos = wp.xyz; vL = aLeaf;
  gl_Position = projectionMatrix*viewMatrix*wp;
}`;
  const LEAF_FS = `
#include <packing>
${GLSL.COMMON}
${GLSL.ART}
uniform sampler2D map, nmap; uniform vec3 uAmbF, uKeyDirT, uKeyColT, uTint; uniform float uCut; uniform vec4 uFog;
uniform vec3 uLeafK;                  /* gloss, its sharpness, light through the leaves */
uniform sampler2D uLeafShM; uniform mat4 uLeafShX; uniform vec4 uLeafShA; uniform vec2 uLeafShS;   /* the key light's shadow map: (x, z) it is centred on, its reach, on */
varying vec2 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB; varying vec3 vWPos; varying vec4 vL; varying vec3 vTint;
${GLSL.LEAF_PCF}
float leafShadow(vec3 wp){
  if (uLeafShA.w < 0.5 || length(wp.xz - uLeafShA.xy) > uLeafShA.z) return 1.0;
  vec4 sc = uLeafShX*vec4(wp, 1.0); sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float z = sc.z - 0.0025;
  return lsPCF(sc.xy, z);
}
void main(){
  vec4 tx = texture2D(map, vUv);
  float cov = cutCov(tx.a, uCut); if (cov < CUT_MIN) discard;
  vec3 V = normalize(cameraPosition - vWPos), Tg = normalize(vT), Bt = normalize(vB), Nc = normalize(cross(Tg, Bt))*vL.w;
  float face = dot(Nc, V) >= 0.0 ? 1.0 : -1.0;
  vec3 tn = texture2D(nmap, vUv).xyz*2.0 - 1.0;
  vec3 nl = normalize(Tg*tn.x + Bt*tn.y + Nc*max(tn.z, 0.05))*face;
  vec3 nb = normalize(vN);
  float ao = vL.x, ndl = dot(nl, uKeyDirT), cr = dot(nb, uKeyDirT);
  /* (sh: the shadow map's, and the shade of the land and the forest toward the light) */
  float tsh = isleShAt(vWPos), sh = leafShadow(vWPos)*tsh;
  /* how much of the key light gets this far into the crown */
  float vis = mix(0.1, 1.0, smoothstep(-0.35, 0.6, cr))*mix(0.4, 1.0, ao)*sh;
  vec3 alb = tx.rgb*uTint*vTint*(0.88 + 0.24*vL.z);
  /* (snow on the crown's top, out in the open; less of it deep in the crown) */
  if (uSnow.x > 0.002) alb = mix(alb, vec3(0.84, 0.87, 0.91), snowLeaf(nb, vWPos, smoothstep(0.25, 0.9, isleSky3(vWPos).g))*(0.3 + 0.7*ao));
  vec3 ambS = uAmbF*isleSky3(vWPos), c = alb*ambS*(0.5 + 0.5*nb.y)*(0.28 + 0.72*ao)*(0.8 + 0.2*nl.y);
  c += alb*uKeyColT*max(ndl, 0.0)*vis;
  /* through the leaf, the light behind it: strongest at the crown's edge, where one leaf is all there is in the way */
  float thru = max(-ndl, 0.0)*mix(0.12, 1.0, ao*ao)*smoothstep(-0.9, 0.15, cr)*sh;
  c += alb*vec3(0.92, 1.06, 0.42)*uKeyColT*thru*uLeafK.z;
  /* a waxy leaf's shine, and the sky's sheen on the upturned ones */
  c += uKeyColT*uLeafK.x*pow(max(dot(nl, normalize(uKeyDirT + V)), 0.0), uLeafK.y)*vis*step(0.0, ndl);
  c += ambS*uLeafK.x*0.25*pow(1.0 - max(dot(nl, V), 0.0), 4.0)*max(nl.y, 0.0)*(0.25 + 0.75*ao);
  /* and the light the crown scatters about inside itself, green from leaf to leaf */
  c += alb*uKeyColT*vec3(0.8, 1.0, 0.6)*0.05*(0.4 + 0.6*ao)*(0.3 + 0.7*sh)*tsh;
  if (length(vWPos.xz - vec2(${Layout.camp.x.toFixed(2)}, ${Layout.camp.z.toFixed(2)})) < 19.0 || length(vWPos.xz - uVanPos.xz) < 12.0 || (uHead.w > 0.001 && length(vWPos.xz - uHead.xz) < 34.0) || torchNear(vWPos)) c += alb*artLight(vWPos, nl)*(0.5 + 0.5*ao);
  float d = distance(vWPos, cameraPosition);
  c = mix(c, uFog.rgb, 1.0 - exp(-max(d - 40.0, 0.0)/(1400.0/max(uFog.w, 0.05))));
  c = mix(c, uFog.rgb*0.9, (1.0 - exp(-d/180.0))*0.12*uFog.w);
  gl_FragColor = vec4(c, uA2C > 0.5 ? cov : 1.0);
}`;
  /* a species' three leaf materials (three cards, painted apart) and its bark */
  const matCache = {};
  function materials(kind) {
    if (matCache[kind]) return matCache[kind];
    const S_ = SPECIES[kind], cards = [0, 1, 2].map(k => card(S_.leaf, k));
    const leaves = cards.map(cd => new T.ShaderMaterial({ uniforms: Object.assign({}, Mats.U, { map: { value: cd.map }, nmap: { value: cd.nmap }, uCut: { value: CUT }, uTint: { value: new T.Vector3(1, 1, 1) }, uLeafK: { value: new T.Vector3(S_.gloss[0], S_.gloss[1], S_.thru) } }), vertexShader: LEAF_VS, fragmentShader: LEAF_FS, side: T.DoubleSide, alphaToCoverage: true }));
    const depth = cards.map(cd => Mats.cutoutDepth(cd.map, CUT));
    const barkCol = { almond: '#7a6f62', casuarina: '#5e4d40', hibiscus: '#6f6556', grape: '#6c5a49', scrub: '#5a4b3a' }[kind];
    const bt = barkTex(kind.length * 7 + 3, barkCol, kind);
    const bark = Mats.lit({ map: bt.map, normalMap: bt.normalMap, normalScale: new T.Vector2(1.2, 1.2), roughness: 0.95 });
    return (matCache[kind] = { leaves, depth, bark });
  }
  /* ── the forest seen from afar: the canopy's trees as pictures that turn to face the eye. Each picture is a crown
     heaped up of leafy clumps, worked out pixel by pixel as balls seen from the front: the nearest clump's surface wins
     and keeps its normal (so the sun lights the crown from wherever it is), with how much light gets in there (less
     between the clumps, under the crown, deep in it) and the crown's leafy outline. Eight crowns: rounded ones, taller
     ones, an umbrella. The mip levels keep each outline as full far off as near ── */
  const h2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const vn2 = (x, y) => { const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    return (h2(ix, iy) * (1 - u) + h2(ix + 1, iy) * u) * (1 - w) + (h2(ix, iy + 1) * (1 - u) + h2(ix + 1, iy + 1) * u) * w; };
  const CM = 1.1;   /* (a picture spans ±1.1 crown units: a margin round each crown, so the mip levels don't bleed) */
  function crownTile(px, W, x0, y0, N, v) {
    const r = rng(907 + v * 41);
    const { A, B, yc } = v < 4 ? { A: 0.84 + 0.08 * r(), B: 0.64 + 0.08 * r(), yc: -0.08 } : v < 6 ? { A: 0.6 + 0.06 * r(), B: 0.86, yc: -0.04 } : v === 6 ? { A: 0.93, B: 0.42, yc: 0.18 } : { A: 0.78, B: 0.74, yc: -0.06 };
    const zb = new Float32Array(N * N).fill(-9), NX = new Float32Array(N * N), NY = new Float32Array(N * N), SH = new Float32Array(N * N);
    const toPix = c => (c / CM + 1) / 2 * N, toU = i => ((i + 0.5) / N * 2 - 1) * CM;
    const ball = (cx, cy, cz, rad, shade, rough) => {
      const s1 = r() * 6, s2 = r() * 6, s3 = r() * 6, e = rad * (1 + rough);
      const i0 = Math.max(0, Math.floor(toPix(cx - e))), i1 = Math.min(N - 1, Math.ceil(toPix(cx + e))), j0 = Math.max(0, Math.floor(toPix(cy - e))), j1 = Math.min(N - 1, Math.ceil(toPix(cy + e)));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const du = toU(i) - cx, dv = toU(j) - cy, d2 = du * du + dv * dv;
        if (d2 >= e * e) continue;
        const an = Math.atan2(dv, du), rr = rad * (1 + rough * (0.5 * Math.sin(5 * an + s1) + 0.3 * Math.sin(9 * an + s2) + 0.2 * Math.sin(17 * an + s3)));
        if (d2 >= rr * rr) continue;
        const k = j * N + i, dz = Math.sqrt(rr * rr - d2), z = cz + dz;
        if (z <= zb[k]) continue;
        zb[k] = z; NX[k] = du / rr; NY[k] = dv / rr; SH[k] = shade * (0.68 + 0.32 * dz / rr);
      }
    };
    /* a point on the crown's surface (not much of its underside), drawn in by k */
    const surf = k => { let x, y, z, l; do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; l = Math.hypot(x, y, z); } while (l > 1 || l < 0.2 || y / l < -0.45); return [x / l * A * k, yc + y / l * B * k, z / l * A * k]; };
    /* the crown's mass, clumps over its surface, small leafy tufts over those */
    /* (a real crown is no ball of balls: its leaves hang in many small sprays, thick in some places and thin in others,
       so its edge is ragged and the sky shows through it here and there) */
    const thick = (x, y, z) => vn2(x * 2.2 + v * 5.1 + z * 1.3, y * 2.2 - z * 0.7);
    ball(0, yc - B * 0.1, 0, Math.min(A, B) * 0.74, 0.5, 0.08);
    for (let i = 0, n = 62 + Math.floor(r() * 14); i < n; i++) { const [x, y, z] = surf(0.8); if (thick(x, y, z) < 0.3) continue; ball(x, y, z, (0.1 + 0.1 * r()) * A, 0.8 + 0.32 * r(), 0.22); }
    for (let i = 0; i < 320; i++) { const [x, y, z] = surf(0.97); if (thick(x, y, z) < 0.38) continue; ball(x, y, z, (0.026 + 0.03 * r()) * A, 0.72 + 0.38 * r(), 0.32); }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, o = ((y0 + j) * W + x0 + i) * 4;
      if (zb[k] < -8) { px[o] = 128; px[o + 1] = 128; px[o + 2] = 100; px[o + 3] = 0; continue; }
      const u = toU(i), w = toU(j), q = 24, e = 0.05, n1 = vn2(u * q + v * 9, w * q);
      /* a bump of leaves over every clump */
      let nx = NX[k] - (vn2(u * q + v * 9 + e, w * q) - n1) / e * 0.22, ny = NY[k] - (vn2(u * q + v * 9, w * q + e) - n1) / e * 0.22;
      const l = Math.hypot(nx, ny); if (l > 0.97) { nx *= 0.97 / l; ny *= 0.97 / l; }
      /* how much light gets in: less deep in the crown, toward its underside, between the clumps; leafy grain */
      const ao = (0.45 + 0.55 * Math.min(1, Math.max(0, (zb[k] + 0.3) / 1.1))) * (0.5 + 0.5 * Math.min(1, Math.max(0, (w - (yc - B)) / (B * 1.2)))) * SH[k] * (0.8 + 0.4 * vn2(u * 70, w * 70 + v * 3));
      px[o] = (nx * 0.5 + 0.5) * 255; px[o + 1] = (ny * 0.5 + 0.5) * 255; px[o + 2] = Math.min(255, ao * 225); px[o + 3] = 255;
    }
  }
  let atlas = null;
  function crownAtlas() {
    if (atlas) return atlas;
    const N = 256, W = N * 4, H = N * 2, px = new Uint8Array(W * H * 4);
    for (let v = 0; v < 8; v++) crownTile(px, W, (v % 4) * N, Math.floor(v / 4) * N, N, v);
    return (atlas = dataTex(mipChain(px, W, H, 127), false));
  }
  const CROWN_VS = `
uniform float uTime; uniform vec2 uWindK;
attribute vec4 aP;      /* the middle of the crown's picture (x, y, z), and how wide the picture is */
attribute vec4 aQ;      /* how tall, which picture, a die, how far it sways */
attribute vec3 aC;      /* its leaves' colour */
varying vec2 vUv; varying vec3 vR; varying vec3 vU; varying vec3 vF; varying vec3 vW; varying vec3 vC;
void main(){
  vec3 c = aP.xyz, f = normalize(cameraPosition - c);
  vec3 r = abs(f.y) > 0.995 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), f)), u = cross(f, r);
  vec3 wp = c + r*position.x*aP.w + u*position.y*aQ.x;
  wp.xz += vec2(0.55, -0.83)*(sin(uTime*0.45 + aQ.z*31.0)*uWindK.x + uWindK.y)*aQ.w*(position.y + 0.5);
  vUv = (vec2(mod(aQ.y, 4.0), floor(aQ.y/4.0)) + uv)*vec2(0.25, 0.5);
  vR = r; vU = u; vF = f; vW = wp; vC = aC;
  gl_Position = projectionMatrix*viewMatrix*vec4(wp, 1.0);
}`;
  const CROWN_FS = `
${GLSL.CLOUDSHADOW}
${GLSL.ISLE_SH}
uniform sampler2D uCrownT; uniform vec3 uAmbF, uKeyDirT, uKeyCol; uniform vec4 uFog;
varying vec2 vUv; varying vec3 vR; varying vec3 vU; varying vec3 vF; varying vec3 vW; varying vec3 vC;
void main(){
  vec2 cu = fract(vUv*vec2(4.0, 2.0)), g = vUv*vec2(1024.0, 512.0);
  float lod = clamp(0.5*log2(max(dot(dFdx(g), dFdx(g)), dot(dFdy(g), dFdy(g)))), 0.0, 4.0);
  vec4 t = textureLod(uCrownT, vUv, lod);
  if (t.a < 0.5 || cu.x < 0.02 || cu.x > 0.98 || cu.y < 0.02 || cu.y > 0.98) discard;
  vec2 q = t.rg*2.0 - 1.0; vec3 nb = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
  vec3 n = normalize(vR*nb.x + vU*nb.y + vF*nb.z);
  float ao = t.b*(255.0/225.0), ndl = dot(n, uKeyDirT), cs = cloudShadow(vW.xz)*isleShAt(vW);
  vec3 c = vC*uAmbF*(0.42 + 0.58*max(n.y, 0.0))*ao;
  c += vC*uKeyCol*max(ndl, 0.0)*cs*mix(0.2, 1.0, ao);
  c += vC*vec3(0.92, 1.06, 0.42)*uKeyCol*max(-ndl, 0.0)*0.45*ao*ao*cs*(1.0 - nb.z);
  float d = distance(vW, cameraPosition);
  c = mix(c, uFog.rgb, 1.0 - exp(-max(d - 40.0, 0.0)/(1900.0/max(uFog.w, 0.05))));
  c = mix(c, uFog.rgb*0.9, (1.0 - exp(-d/180.0))*0.12*uFog.w);
  gl_FragColor = vec4(c, 1.0);
}`;
  /* the crowns' material: the scene's light and fog, the clouds' shadows (the ground's own uniforms, U) */
  function crownMaterial(U) {
    const u = { uCrownT: { value: crownAtlas() }, uTime: Mats.U.uTime, uWindK: Mats.U.uWindK, uAmbF: Mats.U.uAmbF, uKeyDirT: Mats.U.uKeyDirT, uFog: Mats.U.uFog, uKeyCol: U.uKeyCol };
    for (const k of ['uWeather', 'uDriftW', 'uWind', 'uAltoD', 'uLdM', 'uCumulus', 'uStratus', 'uStorm', 'uAlto']) u[k] = U[k];
    return new T.ShaderMaterial({ uniforms: Object.assign(u, Mats.shadeU()), vertexShader: CROWN_VS, fragmentShader: CROWN_FS });
  }
  /* painted card pixels (colour and normal, top row first) as textures: rows turned bottom-up, colours grown out under
     the transparent parts, coverage-kept mip levels (for the forest's own leaf cards, models/flora/) */
  function texOf(col, nor, W, H, cut = CUT) { const c = flip(col, W, H), n = flip(nor, W, H); dilate(c, W, H); return { map: dataTex(mipChain(c, W, H, cut * 255), true), nmap: dataTex(mipChain(n, W, H, 0), false) }; }
  return { grow, materials, card, paint, crownAtlas, crownMaterial, palmBark, palmBarkMat, SPECIES, texOf, mipChain, dilate, flip, dataTex };
})();
