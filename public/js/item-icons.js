// Power-up icons drawn as inline SVG (consistent on every device, unlike emoji).
(function () {
  const defs = (id, stops) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs>`;
  const rocket = (x, y, s, gid) => `<g transform="translate(${x} ${y}) scale(${s}) rotate(45)">
      <path d="M0 -26 C9 -18 11 -6 9 10 L-9 10 C-11 -6 -9 -18 0 -26Z" fill="url(#${gid})"/>
      <path d="M0 -26 C5 -21 7 -16 7.5 -12 L-7.5 -12 C-7 -16 -5 -21 0 -26Z" fill="#fff"/>
      <circle cx="0" cy="-3" r="4" fill="#bae6fd" stroke="#fff" stroke-width="1.6"/>
      <path d="M-9 2 L-16 14 L-9 12Z M9 2 L16 14 L9 12Z" fill="#b91c1c"/>
      <path d="M-5 10 Q0 26 5 10Z" fill="#fbbf24"/><path d="M-2.5 10 Q0 19 2.5 10Z" fill="#fff7cc"/>
    </g>`;
  const ICONS = {
    boost: () => `${defs('ib', [[0, '#fff3b0'], [0.5, '#ffb547'], [1, '#ff4f1f']])}
      <path d="M14 14 L34 32 L14 50 L22 50 L42 32 L22 14Z" fill="url(#ib)"/>
      <path d="M30 14 L50 32 L30 50 L38 50 L58 32 L38 14Z" fill="url(#ib)" opacity="0.85"/>`,
    rocket: () => `${defs('ir', [[0, '#ff6b6b'], [1, '#dc2626']])}${rocket(32, 32, 1, 'ir')}`,
    triple: () => `${defs('it', [[0, '#ff6b6b'], [1, '#dc2626']])}${rocket(18, 40, 0.62, 'it')}${rocket(46, 40, 0.62, 'it')}${rocket(32, 22, 0.62, 'it')}`,
    banana: () => `${defs('ia', [[0, '#fff27a'], [1, '#f5b700']])}
      <path d="M14 18 C10 36 22 54 46 52 C52 51 54 47 50 45 C32 46 22 34 22 18 Z" fill="url(#ia)" stroke="#a16207" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M14 18 L17 10 L22 18" fill="#7c4a12"/><path d="M21 26 C23 36 30 42 40 44" stroke="#fde68a" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    shield: () => `${defs('is', [[0, '#7dd3fc'], [1, '#2563eb']])}
      <path d="M32 8 L52 15 V31 C52 44 43 52 32 56 C21 52 12 44 12 31 V15Z" fill="url(#is)" stroke="#e0f2fe" stroke-width="3" stroke-linejoin="round"/>
      <path d="M32 16 V48 C40 44 45 38 45 30 V20Z" fill="#fff" opacity="0.25"/>`,
    mine: () => `${defs('im', [[0, '#6b7280'], [1, '#1f2937']])}
      ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<rect x="30" y="8" width="4" height="10" rx="2" fill="#4b5563" transform="rotate(${i * 45} 32 34)"/>`).join('')}
      <circle cx="32" cy="34" r="16" fill="url(#im)" stroke="#9ca3af" stroke-width="2"/>
      <circle cx="32" cy="34" r="5.5" fill="#ef4444"/><circle cx="30" cy="32" r="2" fill="#fecaca"/>`,
    minigun: () => `${defs('ig', [[0, '#e5e7eb'], [1, '#6b7280']])}
      <rect x="8" y="22" width="18" height="20" rx="5" fill="#374151"/>
      <rect x="22" y="20" width="32" height="6" rx="3" fill="url(#ig)"/><rect x="22" y="29" width="34" height="6" rx="3" fill="url(#ig)"/><rect x="22" y="38" width="32" height="6" rx="3" fill="url(#ig)"/>
      <rect x="20" y="18" width="5" height="28" rx="2" fill="#4b5563"/><path d="M56 26 L62 32 L56 38" fill="#fbbf24"/>`,
    bomb: () => `${defs('ix', [[0, '#4b5563'], [1, '#111827']])}
      <circle cx="28" cy="38" r="18" fill="url(#ix)"/><circle cx="22" cy="31" r="5" fill="#fff" opacity="0.25"/>
      <rect x="35" y="15" width="10" height="9" rx="2" fill="#6b7280" transform="rotate(35 40 20)"/>
      <path d="M43 16 Q48 8 54 10" stroke="#a16207" stroke-width="2.5" fill="none"/>
      <path d="M55 4 L57 9 L62 8 L58 12 L61 16 L56 14 L53 18 L53 12 L48 11 L53 9Z" fill="#fbbf24"/>`,
    shock: () => `${defs('iq', [[0, '#e0f2fe'], [1, '#38bdf8']])}
      <circle cx="32" cy="32" r="22" fill="none" stroke="#38bdf8" stroke-width="3" stroke-dasharray="6 5" opacity="0.8"/>
      <path d="M36 8 L18 36 H30 L26 56 L46 26 H34Z" fill="url(#iq)" stroke="#0369a1" stroke-width="2" stroke-linejoin="round"/>`,
    ghost: () => `${defs('ih', [[0, '#ffffff'], [1, '#c7d2fe']])}
      <path d="M14 54 V28 C14 16 22 8 32 8 C42 8 50 16 50 28 V54 L44 48 L38 54 L32 48 L26 54 L20 48Z" fill="url(#ih)" stroke="#818cf8" stroke-width="2.5" stroke-linejoin="round"/>
      <ellipse cx="25" cy="28" rx="3.5" ry="5" fill="#312e81"/><ellipse cx="39" cy="28" rx="3.5" ry="5" fill="#312e81"/>
      <ellipse cx="32" cy="38" rx="4" ry="3" fill="#312e81"/>`,
  };
  const NAMES = {
    boost: 'Boost', rocket: 'Homing rocket', triple: 'Triple rockets', banana: 'Banana', shield: 'Shield',
    mine: 'Mine', minigun: 'Minigun', bomb: 'Bomb', shock: 'Shock wave', ghost: 'Ghost',
  };
  const DESCRIPTIONS = {
    boost: 'Instant burst of speed', rocket: 'Locks on to the rival ahead', triple: 'Three homing rockets', banana: 'Drop behind to spin out chasers',
    shield: 'Blocks the next hit', mine: 'Hidden trap, big blast', minigun: 'Two seconds of rapid fire', bomb: 'Lob it over karts, area blast',
    shock: 'Zaps everyone around you', ghost: 'Untouchable for 4 seconds',
  };
  let uid = 0;
  window.ItemIcons = {
    ids: Object.keys(ICONS),
    name: (id) => NAMES[id] || id,
    description: (id) => DESCRIPTIONS[id] || '',
    // Gradient ids are made unique per icon so many icons can share a page.
    svg(id, cls = 'item-icon') {
      const body = ICONS[id] ? ICONS[id]() : '';
      const n = ++uid;
      return `<svg viewBox="0 0 64 64" class="${cls}" aria-hidden="true">${body.replace(/id="(i\w)"/g, `id="$1${n}"`).replace(/url\(#(i\w)\)/g, `url(#$1${n})`)}</svg>`;
    },
  };
})();
