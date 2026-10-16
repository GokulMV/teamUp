/* The globals moonlit-cove's trees.js expects, cut down to what growing trees needs.
   rng and taperTube are copied from moonlit-cove (src3d/textures.js and src3d/nature.js).
   Mats/GLSL/Layout are stand-ins: trees.js builds its own night-lighting shaders at load,
   which TeamUp never renders (it lights the trees with standard three.js materials). */
(function () {
  const T = window.THREE;
  const TAU = Math.PI * 2;

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function taperTube(curve, segs, radial, rFn, vRepeat) {
    const pos = [], nrm = [], uv = [], idx = [];
    const frames = curve.computeFrenetFrames(segs, false), len = curve.getLength();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, P = curve.getPointAt(t), N = frames.normals[i], B = frames.binormals[i], r = rFn(t);
      for (let j = 0; j <= radial; j++) {
        const a = j / radial * TAU, c = Math.cos(a), s = Math.sin(a);
        const nx = N.x * c + B.x * s, ny = N.y * c + B.y * s, nz = N.z * c + B.z * s;
        pos.push(P.x + nx * r, P.y + ny * r, P.z + nz * r); nrm.push(nx, ny, nz); uv.push(j / radial, t * len / vRepeat);
      }
    }
    for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1; idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    return g;
  }

  window.Textures = window.Textures || { rng };
  window.Nature = window.Nature || { taperTube };
  window.Layout = window.Layout || { camp: { x: 0, z: 0 } };
  window.GLSL = window.GLSL || new Proxy({}, { get: () => '' });
  window.Mats = window.Mats || {
    U: {},
    shadeU: () => ({}),
    lit: (opts) => new T.MeshStandardMaterial(opts),
    cutoutDepth: (map, cut) => new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map, alphaTest: cut }),
  };
})();
