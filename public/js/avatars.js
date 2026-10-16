// Avatars: 24 little characters drawn as inline SVG (crisp at any size, no image files).
(function () {
  const BG = ['#ffe3ec', '#e0f2fe', '#ecfccb', '#fef3c7', '#ede9fe', '#ffedd5', '#ccfbf1', '#fce7f3'];
  // [body color, eyes, mouth, accessory, accessory color]
  const PRESETS = [
    ['#ff6b8b', 'round', 'smile', 'cap', '#3b82f6'],
    ['#4f9dff', 'happy', 'open', 'none', ''],
    ['#36c98e', 'round', 'tongue', 'leaf', '#16a34a'],
    ['#ffb02e', 'wink', 'smile', 'crown', '#facc15'],
    ['#a78bfa', 'sleepy', 'small', 'beanie', '#f43f5e'],
    ['#ff7a45', 'round', 'teeth', 'horns', '#7c2d12'],
    ['#22c5d8', 'shades', 'smile', 'none', ''],
    ['#f472b6', 'happy', 'smile', 'bow', '#be185d'],
    ['#84cc16', 'round', 'open', 'antenna', '#facc15'],
    ['#fb7185', 'star', 'open', 'headphones', '#1f2937'],
    ['#60a5fa', 'round', 'small', 'tophat', '#111827'],
    ['#fbbf24', 'happy', 'tongue', 'flower', '#ec4899'],
    ['#34d399', 'wink', 'teeth', 'cap', '#ef4444'],
    ['#c084fc', 'round', 'smile', 'halo', '#fde047'],
    ['#f97316', 'shades', 'open', 'beanie', '#0ea5e9'],
    ['#2dd4bf', 'sleepy', 'smile', 'leaf', '#65a30d'],
    ['#e879f9', 'star', 'smile', 'crown', '#fbbf24'],
    ['#94a3b8', 'round', 'teeth', 'antenna', '#22d3ee'],
    ['#f43f5e', 'happy', 'small', 'horns', '#fde68a'],
    ['#38bdf8', 'round', 'tongue', 'headphones', '#f97316'],
    ['#a3e635', 'shades', 'smile', 'tophat', '#7c3aed'],
    ['#fda4af', 'wink', 'open', 'bow', '#2563eb'],
    ['#818cf8', 'happy', 'teeth', 'halo', '#fef08a'],
    ['#facc15', 'round', 'smile', 'none', ''],
  ];
  const COUNT = PRESETS.length;

  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0');
    return `#${c(n >> 16)}${c((n >> 8) & 255)}${c(n & 255)}`;
  }

  function eyes(style) {
    const L = 38; const R = 62; const Y = 52;
    switch (style) {
      case 'happy':
        return `<path d="M${L - 6} ${Y + 2} q6 -8 12 0 M${R - 6} ${Y + 2} q6 -8 12 0" stroke="#1f2937" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
      case 'wink':
        return `<circle cx="${L}" cy="${Y}" r="6" fill="#fff"/><circle cx="${L + 1}" cy="${Y + 1}" r="3.5" fill="#1f2937"/>
          <path d="M${R - 6} ${Y + 1} q6 -6 12 0" stroke="#1f2937" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
      case 'sleepy':
        return `<path d="M${L - 6} ${Y} q6 6 12 0 M${R - 6} ${Y} q6 6 12 0" stroke="#1f2937" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
      case 'shades':
        return `<rect x="${L - 10}" y="${Y - 7}" width="20" height="13" rx="5" fill="#111827"/><rect x="${R - 10}" y="${Y - 7}" width="20" height="13" rx="5" fill="#111827"/>
          <rect x="${L + 9}" y="${Y - 4}" width="6" height="3" fill="#111827"/><rect x="${L - 6}" y="${Y - 4}" width="6" height="2.5" rx="1" fill="#fff" opacity="0.6"/>`;
      case 'star':
        return [L, R].map((x) => `<path d="M${x} ${Y - 7} l2.2 4.6 5 .7 -3.6 3.5 .9 5 -4.5 -2.4 -4.5 2.4 .9 -5 -3.6 -3.5 5 -.7z" fill="#fde047" stroke="#1f2937" stroke-width="1.5"/>`).join('');
      default:
        return `<circle cx="${L}" cy="${Y}" r="7" fill="#fff"/><circle cx="${R}" cy="${Y}" r="7" fill="#fff"/>
          <circle cx="${L + 1.5}" cy="${Y + 1}" r="4" fill="#1f2937"/><circle cx="${R + 1.5}" cy="${Y + 1}" r="4" fill="#1f2937"/>
          <circle cx="${L + 3}" cy="${Y - 1}" r="1.4" fill="#fff"/><circle cx="${R + 3}" cy="${Y - 1}" r="1.4" fill="#fff"/>`;
    }
  }

  function mouth(style) {
    switch (style) {
      case 'open': return '<path d="M42 66 q8 12 16 0 z" fill="#7f1d1d"/><path d="M45 70 q5 4 10 0" fill="#fb7185"/>';
      case 'tongue': return '<path d="M41 65 q9 9 18 0" stroke="#1f2937" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M50 68 q0 8 6 7 q4 -1 1 -8z" fill="#fb7185"/>';
      case 'teeth': return '<rect x="40" y="63" width="20" height="9" rx="4.5" fill="#fff" stroke="#1f2937" stroke-width="2.5"/><path d="M50 63 v9" stroke="#1f2937" stroke-width="1.5"/>';
      case 'small': return '<path d="M46 67 q4 4 8 0" stroke="#1f2937" stroke-width="3" fill="none" stroke-linecap="round"/>';
      default: return '<path d="M40 64 q10 11 20 0" stroke="#1f2937" stroke-width="3.5" fill="none" stroke-linecap="round"/>';
    }
  }

  function accessory(kind, c) {
    switch (kind) {
      case 'cap': return `<path d="M24 34 q26 -26 52 0 z" fill="${c}"/><rect x="48" y="30" width="34" height="6" rx="3" fill="${shade(c, 0.75)}"/><circle cx="50" cy="13" r="3" fill="${shade(c, 0.75)}"/>`;
      case 'beanie': return `<path d="M22 38 q28 -40 56 0 z" fill="${c}"/><rect x="21" y="33" width="58" height="9" rx="4.5" fill="${shade(c, 0.8)}"/><circle cx="50" cy="8" r="6" fill="#fff"/>`;
      case 'crown': return `<path d="M30 30 l4 -16 9 9 7 -13 7 13 9 -9 4 16 z" fill="${c}" stroke="${shade(c, 0.7)}" stroke-width="2"/><circle cx="50" cy="22" r="2.5" fill="#ef4444"/>`;
      case 'horns': return `<path d="M28 30 q-10 -14 -2 -22 q2 12 10 16z M72 30 q10 -14 2 -22 q-2 12 -10 16z" fill="${c}"/>`;
      case 'bow': return `<path d="M50 24 l-16 -9 v18 z M50 24 l16 -9 v18 z" fill="${c}"/><circle cx="50" cy="24" r="4.5" fill="${shade(c, 0.8)}"/>`;
      case 'antenna': return `<path d="M42 26 q-6 -10 -10 -16 M58 26 q6 -10 10 -16" stroke="#1f2937" stroke-width="2.5" fill="none"/><circle cx="32" cy="10" r="4.5" fill="${c}"/><circle cx="68" cy="10" r="4.5" fill="${c}"/>`;
      case 'headphones': return `<path d="M20 52 q0 -38 30 -38 q30 0 30 38" stroke="${c}" stroke-width="6" fill="none"/><rect x="13" y="44" width="11" height="20" rx="5" fill="${c}"/><rect x="76" y="44" width="11" height="20" rx="5" fill="${c}"/>`;
      case 'tophat': return `<rect x="34" y="6" width="32" height="24" rx="3" fill="${c}"/><rect x="26" y="27" width="48" height="6" rx="3" fill="${c}"/><rect x="34" y="21" width="32" height="5" fill="#ef4444"/>`;
      case 'flower': return `<g transform="translate(68 24)">${[0, 72, 144, 216, 288].map((a) => `<ellipse rx="4" ry="7" transform="rotate(${a}) translate(0 -6)" fill="${c}"/>`).join('')}<circle r="4" fill="#fde047"/></g>`;
      case 'leaf': return `<path d="M50 22 q-2 -8 4 -14 q8 2 6 10 q-4 6 -10 4z" fill="${c}"/><path d="M50 22 q1 -6 6 -10" stroke="${shade(c, 0.7)}" stroke-width="1.5" fill="none"/>`;
      case 'halo': return `<ellipse cx="50" cy="14" rx="18" ry="5" fill="none" stroke="${c}" stroke-width="4"/>`;
      default: return '';
    }
  }

  function svg(id) {
    const i = ((Number(id) % COUNT) + COUNT) % COUNT;
    const [body, eye, mo, acc, accColor] = PRESETS[i];
    const bg = BG[i % BG.length];
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="avatar-svg" aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill="${bg}"/>
      <ellipse cx="50" cy="94" rx="30" ry="9" fill="${shade(bg, 0.9)}"/>
      <path d="M18 60 q0 -38 32 -38 q32 0 32 38 q0 30 -32 30 q-32 0 -32 -30z" fill="${body}"/>
      <path d="M26 46 q6 -18 22 -20" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.35"/>
      <ellipse cx="30" cy="64" rx="5" ry="3.2" fill="#ff8fab" opacity="0.6"/><ellipse cx="70" cy="64" rx="5" ry="3.2" fill="#ff8fab" opacity="0.6"/>
      ${eyes(eye)}${mouth(mo)}${accessory(acc, accColor)}
    </svg>`;
  }

  window.Avatars = {
    COUNT,
    svg,
    color: (id) => PRESETS[((Number(id) % COUNT) + COUNT) % COUNT][0],
    random: () => Math.floor(Math.random() * COUNT),
  };
})();
